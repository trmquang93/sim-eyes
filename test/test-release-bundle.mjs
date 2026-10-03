import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { posix } from "node:path";
import { isSafeBundlePath } from "../app/bundle-format.mjs";
import { verifyBundle, verifyManifest } from "../app/updater.mjs";
import { buildBundle, collectFiles, packageInfo, signManifest } from "../scripts/release-bundle.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" });
const priv = privateKey.export({ type: "pkcs8", format: "pem" });

const { version, depsHash } = await packageInfo();
const bundle = await buildBundle({ version });
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
for (const f of files.filter((f) => f.path.endsWith(".mjs"))) {
  for (const [, spec] of f.data.toString().matchAll(importRe)) {
    const target = posix.normalize(posix.join(posix.dirname(f.path), spec));
    assert.ok(paths.has(target), `${f.path} imports ${spec}, which the bundle does not hold`);
  }
}

// The files come from the same places build-app.sh copies, and not from anywhere else.
const collected = await collectFiles();
assert.ok(collected.includes("act.mjs") && collected.includes("ocr.swift") && collected.includes("studio/public/app.js"));
// The PDF helper ships with Studio, but under studio/: an installed app rejects any other new top-level file in a bundle.
assert.ok(collected.includes("studio/pdf-facts.swift"));

console.log("test-release-bundle: ok");
