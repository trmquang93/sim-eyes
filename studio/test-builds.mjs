import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES, Refusal, addBuild, cleanUploads, installBuild, isMachO, isSimulatorBuild, listBuilds, readAppInfo, realExec, removeBuild, uploadPath } from "./builds.mjs";

const tmp = await mkdtemp(join(tmpdir(), "studio-builds-"));
const buildsDir = join(tmp, "builds");
await mkdir(buildsDir);
let n = 0;
const fresh = async () => {
  const dir = join(tmp, `w${(n += 1)}`);
  await mkdir(dir);
  return dir;
};

// zip, unzip, ditto and plutil are the real macOS tools; codesign and simctl are faked, because a hand-made .app has no signature
// and there is no simulator here.
const calls = [];
let codesignFails = false;
let simctlFails = null;
const exec = async (file, args, opts) => {
  if (file === "codesign" || file === "xcrun") {
    calls.push({ file, args, opts });
    if (file === "codesign" && codesignFails) throw Object.assign(new Error("invalid signature"), { stderr: "invalid signature" });
    if (file === "xcrun" && simctlFails === args[1]) throw Object.assign(new Error("failed"), { stderr: "Unable to install: bad arch" });
    return { stdout: "" };
  }
  return realExec(file, args, opts);
};
const deps = { exec, now: () => new Date(2026, 9, 2, 8, 15, 0) };

const plist = ({ bundleId = "com.example.app", platform = "iphonesimulator", version = "2.3.0", build = "145", display = "PDF Tools" } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleDisplayName</key><string>${display}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>DTPlatformName</key><string>${platform}</string>
<key>CFBundleSupportedPlatforms</key><array><string>${platform === "iphoneos" ? "iPhoneOS" : "iPhoneSimulator"}</string></array>
</dict></plist>
`;

async function makeApp(parent, name, info = {}) {
  const app = join(parent, name);
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "Info.plist"), plist(info));
  await writeFile(join(app, "data.txt"), "data");
  await writeFile(join(app, "Exec"), Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("rest")]), { mode: 0o644 });
  return app;
}
async function zipOf(dir, app, out) {
  await realExec("ditto", ["-c", "-k", "--keepParent", app, out]);
  return out;
}
async function ipaOf(info, out) {
  const root = await fresh();
  await makeApp(join(root, "Payload"), "PDF Tools.app", info);
  await realExec("ditto", ["-c", "-k", "--keepParent", join(root, "Payload"), out]);
  return out;
}
const refusal = async (promise, text) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof Refusal, `expected a refusal, got ${err?.stack ?? "success"}`);
  assert.match(err.message, text);
};

try {
  // Mach-O detection.
  assert.ok(isMachO(Buffer.from("cffaedfe", "hex")) && isMachO(Buffer.from("cafebabe", "hex")) && isMachO(Buffer.from("feedfacf", "hex")));
  assert.ok(!isMachO(Buffer.from("<?xm")) && !isMachO(Buffer.from("ab")));

  // The tester can tell which build ran only if the list shows the real version and build number.
  {
    const w = await fresh();
    const zip = await zipOf(w, await makeApp(w, "PDF Tools.app"), join(w, "PDFTools-sim.zip"));
    const build = await addBuild({ buildsDir, expectedApp: "", zip, name: "PDFTools-sim.zip" }, deps);
    assert.deepEqual(build, { id: "2-3-0-145-20261002-081500", name: "PDF Tools", bundleId: "com.example.app", version: "2.3.0", build: "145", app: "PDF Tools.app", source: "PDFTools-sim.zip", addedAt: new Date(2026, 9, 2, 8, 15, 0).toISOString() });
    assert.ok(existsSync(join(buildsDir, build.id, "PDF Tools.app", "Info.plist")));
    assert.deepEqual((await listBuilds(buildsDir)).map((b) => b.id), [build.id]);
    assert.ok(!(await readdir(buildsDir)).some((f) => f.startsWith(".work-")), "the temp folder is gone");
    const info = await readAppInfo(join(buildsDir, build.id, "PDF Tools.app"), { exec });
    assert.equal(info.platform, "iphonesimulator");
    assert.ok(isSimulatorBuild(info));
    // The project's app may be a display name.
    const w2 = await fresh();
    const zip2 = await zipOf(w2, await makeApp(w2, "PDF Tools.app", { build: "146" }), join(w2, "b.zip"));
    assert.equal((await addBuild({ buildsDir, expectedApp: "pdf tools", zip: zip2, name: "b.zip" }, deps)).build, "146");
    assert.equal((await listBuilds(buildsDir)).length, 2);
    await removeBuild(buildsDir, build.id);
    assert.equal((await listBuilds(buildsDir)).length, 1);
    await assert.rejects(removeBuild(buildsDir, "../x"), /Not a valid build/);
  }

  // A device build that reaches simctl install makes every run fail with a cryptic error: it is refused at upload.
  {
    const w = await fresh();
    const zip = await zipOf(w, await makeApp(w, "PDF Tools.app", { platform: "iphoneos" }), join(w, "device.zip"));
    await refusal(addBuild({ buildsDir, expectedApp: "", zip, name: "device.zip" }, deps), /^This is an iPhone \(device\) build\. Ask the developer for a \*\*simulator\*\* build/);
  }

  // The run would install one app and drive another.
  {
    const w = await fresh();
    const zip = await zipOf(w, await makeApp(w, "Other.app", { bundleId: "com.other.app", display: "Other" }), join(w, "o.zip"));
    await refusal(addBuild({ buildsDir, expectedApp: "com.example.app", zip, name: "o.zip" }, deps), /This build is `com\.other\.app`, but the project tests `com\.example\.app`\./);
  }

  // Wrong bundle picked, or files written outside builds/.
  {
    const w = await fresh();
    const none = join(w, "none");
    await mkdir(none);
    await writeFile(join(none, "readme.txt"), "x");
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: await zipOf(w, none, join(w, "none.zip")), name: "none.zip" }, deps), /exactly one \.app/);
    const two = join(w, "two");
    await makeApp(two, "A.app");
    await makeApp(two, "B.app");
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: await zipOf(w, two, join(w, "two.zip")), name: "two.zip" }, deps), /exactly one \.app/);
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: join(w, "two.zip"), name: "two.dmg" }, deps), /Drop a simulator \.app/);

    const evil = join(w, "evil.zip");
    await realExec("python3", ["-c", `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("../escaped.txt","x"); z.writestr("X.app/Info.plist","x"); z.close()`, evil]);
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: evil, name: "evil.zip" }, deps), /outside its own folder/);
    assert.ok(!existsSync(join(tmp, "escaped.txt")) && !existsSync(join(buildsDir, "..", "escaped.txt")) && !existsSync(join(buildsDir, "escaped.txt")));
  }

  // Browsers drop the executable bit: a rebuilt app installs but its binary cannot launch.
  {
    const upload = await fresh();
    await makeApp(upload, "PDF Tools.app", { build: "200" });
    calls.length = 0;
    // The server passes no file name for a dropped folder.
    const build = await addBuild({ buildsDir, expectedApp: "com.example.app", upload, name: "" }, deps);
    assert.equal(build.source, "PDF Tools.app", "the list says where a build came from, also for a dropped folder");
    const dest = join(buildsDir, build.id, "PDF Tools.app");
    assert.ok(((await stat(join(dest, "Exec"))).mode & 0o111) === 0o111, "the Mach-O file is executable again");
    assert.equal((await stat(join(dest, "data.txt"))).mode & 0o111, 0, "other files are untouched");
    assert.equal(calls.filter((c) => c.file === "codesign").length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ["--verify", "--deep", "--strict"]);
    assert.ok(!existsSync(upload), "the upload folder is removed");
  }

  // A damaged bundle accepted here fails every run at launch.
  {
    const upload = await fresh();
    await makeApp(upload, "PDF Tools.app");
    codesignFails = true;
    await refusal(addBuild({ buildsDir, expectedApp: "", upload, name: "PDF Tools.app" }, deps), /Right-click it in Finder → Compress, and drop the \.zip instead\./);
    codesignFails = false;
    const notApp = await fresh();
    await mkdir(join(notApp, "Folder"));
    await refusal(addBuild({ buildsDir, expectedApp: "", upload: notApp, name: "Folder" }, deps), /Drop a simulator \.app/);
  }

  // .ipa: the tester's decision was that a simulator app packed as .ipa is fine and a device .ipa is not.
  {
    const w = await fresh();
    const ok = await addBuild({ buildsDir, expectedApp: "", zip: await ipaOf({ build: "300" }, join(w, "sim.ipa")), name: "sim.ipa" }, deps);
    assert.equal(ok.build, "300");
    assert.equal(ok.source, "sim.ipa");
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: await ipaOf({ platform: "iphoneos" }, join(w, "device.ipa")), name: "device.ipa" }, deps), /^This \.ipa is an iPhone \(device\) build and cannot run on a simulator\. Ask the developer for a \*\*simulator\*\* build/);
    const empty = join(w, "empty");
    await mkdir(join(empty, "Payload"), { recursive: true });
    await writeFile(join(empty, "Payload", "x.txt"), "x");
    await realExec("ditto", ["-c", "-k", "--keepParent", join(empty, "Payload"), join(w, "empty.ipa")]);
    await refusal(addBuild({ buildsDir, expectedApp: "", zip: join(w, "empty.ipa"), name: "empty.ipa" }, deps), /exactly one app in its Payload folder/);
  }

  // A drop must not write anywhere on the Mac.
  {
    const up = join(tmp, "up");
    await mkdir(up);
    assert.equal(uploadPath(up, "X.app/Info.plist"), join(up, "X.app", "Info.plist"));
    assert.equal(uploadPath(up, "X.app/My%20File.txt"), join(up, "X.app", "My File.txt"));
    for (const bad of ["../x", "X.app/../../x", "/etc/passwd", "%2e%2e/x", "%2E%2E%2Fx", "X.app/%2e%2e/%2e%2e/x", "", "a\0b", "%zz"]) {
      assert.throws(() => uploadPath(up, bad), /Not a valid upload path/, JSON.stringify(bad));
    }
  }

  // Install: a shut-down simulator fails to install unless booted first; a path with spaces or quotes must stay one argument.
  {
    calls.length = 0;
    const udid = "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6";
    const appPath = `/builds/My "App"; rm -rf ~/ $(x).app`;
    await installBuild({ udid, appPath }, { exec });
    assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [["xcrun", "simctl", "bootstatus", udid, "-b"], ["xcrun", "simctl", "install", udid, appPath]]);
    assert.equal(calls[1].opts.timeout, 180000);
    await assert.rejects(installBuild({ udid: "x; rm -rf /", appPath }, { exec }), /Not a simulator id/);
    simctlFails = "install";
    await assert.rejects(installBuild({ udid, appPath }, { exec }), /^Error: simctl install failed: Unable to install: bad arch$/);
    simctlFails = "bootstatus";
    calls.length = 0;
    await assert.rejects(installBuild({ udid, appPath }, { exec }), /simctl bootstatus failed/);
    assert.equal(calls.length, 1, "no install on a simulator that did not boot");
    simctlFails = null;
  }

  // Abandoned folder uploads are removed, fresh ones kept.
  {
    const old = join(buildsDir, ".uploads", "old");
    const current = join(buildsDir, ".uploads", "current");
    await mkdir(old, { recursive: true });
    await mkdir(current, { recursive: true });
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await cleanUploads(buildsDir);
    assert.ok(!existsSync(old) && existsSync(current));
    assert.ok(!(await listBuilds(buildsDir)).some((b) => b.id === ".uploads"), ".uploads is not a build");
  }
  console.log("test-builds: ok");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
