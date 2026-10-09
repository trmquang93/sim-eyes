import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { posix } from "node:path";
import { isSafeBundlePath } from "../app/bundle-format.mjs";
import { verifyBundle, verifyManifest } from "../app/updater.mjs";
import { buildBundle, collectFiles, packageInfo, signManifest } from "../scripts/release-bundle.mjs";
import { findMarkers, loadMarkers } from "../scripts/protect.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" });
const priv = privateKey.export({ type: "pkcs8", format: "pem" });

const { version, depsHash } = await packageInfo();
const bundle = await buildBundle({ version });
const plainBundle = await buildBundle({ version, protect: false });
const plainFiles = verifyBundle(plainBundle, signManifest({ bundle: plainBundle, version, depsHash, privateKeyPem: priv }));
const manifest = signManifest({ bundle, version, depsHash, privateKeyPem: priv });

// The two halves must agree on the signed bytes: a release the script builds is one the app's updater accepts.
verifyManifest(manifest, pub);
const files = verifyBundle(bundle, manifest);
const paths = new Set(files.map((f) => f.path));

assert.ok(paths.has("server.mjs") && paths.has("studio/studio.mjs") && paths.has("studio/public/index.html") && paths.has("VERSION"));
assert.equal(files.find((f) => f.path === "VERSION").data.toString().trim(), version, "Studio reports the version from VERSION");
assert.ok([...paths].every(isSafeBundlePath), "every shipped path is one the updater will write");
assert.ok(![...paths].some((p) => /(^|\/)(test|eval)-/.test(p)), "tests and evals are not shipped");
assert.ok(!paths.has("node_modules") && ![...paths].some((p) => p.startsWith("node_modules/")), "dependencies stay in the app");

// A bundle that leaves out a file the code imports would crash every tester's Studio at start.
const importRe = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
for (const f of plainFiles.filter((f) => f.path.endsWith(".mjs"))) {
  for (const [, spec] of f.data.toString().matchAll(importRe)) {
    const target = posix.normalize(posix.join(posix.dirname(f.path), spec));
    assert.ok(paths.has(target), `${f.path} imports ${spec}, which the bundle does not hold`);
  }
}

// The files come from the same places build-app.sh copies, and not from anywhere else.
const collected = await collectFiles();
assert.ok(collected.includes("act.mjs") && collected.includes("studio/public/app.js"));
// The app ships ocr and pdf-facts compiled; a bundle with their .swift would show our source (and the Swift source is not needed).
assert.ok(!collected.some((p) => p.endsWith(".swift")) && ![...paths].some((p) => p.endsWith(".swift")), "no .swift in a bundle");

// The signed bytes are the protected ones: no distinctive text from the source survives in what a tester receives.
const markers = await loadMarkers();
assert.ok(markers.length >= 30, "the marker list is what makes a zero meaningful");
for (const f of files.filter((f) => /\.(mjs|js|css|html)$/.test(f.path))) assert.deepEqual(findMarkers(f.data.toString(), markers), [], `${f.path} leaks source text`);
const plainText = plainFiles.map((f) => f.data.toString()).join("\n");
// (Run from a protected copy of the repo, the "plain" source is already protected, so this check only makes sense in the real repo.)
if (!plainText.includes("_0x")) assert.ok(findMarkers(plainText, markers).length >= 25, "markers must hit the plain source, or a zero in the protected one proves nothing");

console.log("test-release-bundle: ok");
