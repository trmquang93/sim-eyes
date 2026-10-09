// Why: a protect step that silently ships plain source, or breaks a module, is worse than none. These tests feed it a
// module with a unique comment, identifier and string and check what survives, that the module still works, and that
// the output is reproducible (so a user's file can be rebuilt from the release tag).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findMarkers, protectFile, protectTree, seedFor } from "../scripts/protect.mjs";

const SOURCE = `// ZEBRA_COMMENT_MARKER explains the secret rule
import { basename } from "node:path";
export const quokkaConfigName = "QUOKKA_STRING_MARKER";
export function narwhalSecretRule(input) {
  const wombatLocalVariable = basename(input);
  return wombatLocalVariable + ":" + quokkaConfigName;
}
export default function () { return import("node:os").then((m) => typeof m.homedir); }
`;
const version = "1.2.3";
const root = await mkdtemp(join(tmpdir(), "protect-test-"));
const load = async (name, bytes) => { const p = join(root, name); await writeFile(p, bytes); return import(pathToFileURL(p).href); };
let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok  ${name}`); };

const out = (await protectFile("x/mod.mjs", Buffer.from(SOURCE), { version })).toString("utf8");

await test("protected output keeps no comment, local name or string from the source", () => {
  for (const marker of ["ZEBRA_COMMENT_MARKER", "wombatLocalVariable", "QUOKKA_STRING_MARKER"]) assert.equal(out.includes(marker), false, `${marker} must be gone`);
});

await test("protected module still exports the same names and behaves the same", async () => {
  const plain = await load("plain.mjs", SOURCE);
  const prot = await load("prot.mjs", out);
  assert.deepEqual(Object.keys(prot).sort(), Object.keys(plain).sort(), "renamed exports would break every importer");
  assert.equal(prot.narwhalSecretRule("/a/b.txt"), plain.narwhalSecretRule("/a/b.txt"));
  assert.equal(await prot.default(), "function", "a dynamic import still resolves");
});

await test("protected module keeps its import specifiers (neighbours resolve)", () => {
  assert.match(out, /from\s*["']node:path["']/);
});

await test("same input and version give identical bytes; another version differs", async () => {
  const again = (await protectFile("x/mod.mjs", Buffer.from(SOURCE), { version })).toString("utf8");
  assert.equal(again, out, "a build must be reproducible to rebuild the file a user sends a trace of");
  assert.notEqual(seedFor("1.2.3"), seedFor("1.2.4"));
  const other = (await protectFile("x/mod.mjs", Buffer.from(SOURCE), { version: "1.2.4" })).toString("utf8");
  assert.notEqual(other, out);
});

await test("a classic browser script is protected without module syntax and still runs", async () => {
  const code = `// HIPPO_COMMENT\nvar giraffeCounter = 0;\nfunction rhinoStep(){ giraffeCounter += 2; return "ELAND_STRING"; }\nglobalThis.result = rhinoStep() + giraffeCounter;`;
  const prot = (await protectFile("studio/public/app.js", Buffer.from(code), { version })).toString("utf8");
  assert.equal(prot.includes("HIPPO_COMMENT") || prot.includes("ELAND_STRING"), false);
  const sandbox = {};
  new Function("globalThis", prot)(sandbox);
  assert.equal(sandbox.result, "ELAND_STRING2");
});

await test("tests, JSON and unknown files pass through unchanged; html loses comments, css is minified", async () => {
  const bytes = Buffer.from("// kept\nexport const a = 1;\n");
  assert.equal((await protectFile("test-x.mjs", bytes, { version })).equals(bytes), true, "tests are plain: they check the protected code");
  const json = Buffer.from('{"a": 1}');
  assert.equal((await protectFile("package.json", json, { version })).equals(json), true);
  assert.equal((await protectFile("index.html", Buffer.from("<!-- SECRET_NOTE --><p>hi</p>"), { version })).toString(), "<p>hi</p>");
  assert.equal((await protectFile("style.css", Buffer.from("/* SECRET */ a { color : red ; }"), { version })).toString().includes("SECRET"), false);
});

await test("protectFile refuses to run without a version", async () => {
  await assert.rejects(protectFile("a.mjs", Buffer.from("1"), {}), /version/);
});

await test("protectTree keeps paths and modes, skips node_modules, and leaves tests as they are", async () => {
  const src = join(root, "src");
  await mkdir(join(src, "studio", "public"), { recursive: true });
  await mkdir(join(src, "node_modules", "dep"), { recursive: true });
  await writeFile(join(src, "a.mjs"), SOURCE, { mode: 0o755 });
  await writeFile(join(src, "test-a.mjs"), "// ZEBRA_COMMENT_MARKER in a test\n");
  await writeFile(join(src, "studio", "public", "app.js"), "var hippoOnly = 1;\n");
  await writeFile(join(src, "node_modules", "dep", "index.js"), "// dep\n");
  const dest = join(root, "dest");
  const files = await protectTree({ src, out: dest, version, markers: ["ZEBRA_COMMENT_MARKER"] });
  assert.deepEqual(files, ["a.mjs", "studio/public/app.js", "test-a.mjs"]);
  assert.equal((await stat(join(dest, "a.mjs"))).mode & 0o777, 0o755);
  assert.equal((await readFile(join(dest, "a.mjs"), "utf8")).includes("ZEBRA_COMMENT_MARKER"), false);
  await assert.rejects(stat(join(dest, "node_modules")), /ENOENT/);
});

await test("protectTree refuses to finish when a marker survives (the guard fails closed)", async () => {
  const src = join(root, "src2");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "a.mjs"), `import "node:fs";\nexport const t = 1;\n`);
  await assert.rejects(protectTree({ src, out: join(root, "dest2"), version, markers: ["node:fs"] }), /still contains/);
  assert.deepEqual(findMarkers("abc def", ["def", "zzz"]), ["def"]);
});

console.log(`${n} passed`);
