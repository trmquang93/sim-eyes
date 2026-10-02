import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, deleteRun, listProjects, listRuns, listTests, newRunDir, readRun, readTest, resolveInProject, setVerdict, slug, updateProject, writeRun, writeTest } from "./store.mjs";

const root = await mkdtemp(join(tmpdir(), "studio-store-"));
try {
  assert.equal(slug("Create a Folder!"), "create-a-folder");
  assert.equal(slug("Ünïcode  Test"), "unicode-test");
  assert.throws(() => slug("!!!"), /at least one letter/);

  const project = await createProject(root, { name: "PDF Tools", app: "com.example.pdftools" });
  assert.equal(project.slug, "pdf-tools");
  await assert.rejects(createProject(root, { name: "pdf tools" }), /already exists/);
  assert.deepEqual((await listProjects(root)).map((p) => p.slug), ["pdf-tools"]);
  assert.equal((await updateProject(root, "pdf-tools", { build: "b1" })).build, "b1");
  assert.equal((await updateProject(root, "pdf-tools", { build: null })).build, undefined, "a null removes the field");

  const test = { name: "Create a folder", start: "fresh", lines: [{ text: 'Tap "Files"', step: { tool: "tap", label: "Files" }, how: "phrase" }], savedAt: "x" };
  await writeTest(root, "pdf-tools", "create-a-folder", test);
  assert.deepEqual(await readTest(root, "pdf-tools", "create-a-folder"), { slug: "create-a-folder", ...test });
  assert.equal((await listTests(root, "pdf-tools"))[0].lineCount, 1);

  // Slugs are the only thing a URL carries into a path.
  await assert.rejects(readTest(root, "pdf-tools", "../project"), /Not a valid test/);
  await assert.rejects(readTest(root, "../etc", "x"), /Not a valid project/);

  const a = await newRunDir(root, "pdf-tools", "create-a-folder", new Date(2026, 9, 2, 8, 0, 0));
  const b = await newRunDir(root, "pdf-tools", "create-a-folder", new Date(2026, 9, 2, 8, 0, 0));
  assert.equal(a.stamp, "20261002-080000");
  assert.equal(b.stamp, "20261002-080000-2", "two runs in one second keep separate folders");
  await writeRun(root, "pdf-tools", "create-a-folder", a.stamp, { test, status: "completed", steps: [{ n: 1 }] });
  await writeRun(root, "pdf-tools", "create-a-folder", b.stamp, { test, status: "failed", steps: [] });

  // The reviewer's judgment must survive a reload: it lives in run.json, and the history lists it.
  await setVerdict(root, "pdf-tools", "create-a-folder", a.stamp, { result: "pass", note: " looks right " }, new Date("2026-10-02T09:00:00Z"));
  const run = await readRun(root, "pdf-tools", "create-a-folder", a.stamp);
  assert.deepEqual(run.verdict, { result: "pass", note: "looks right", at: "2026-10-02T09:00:00.000Z" });
  assert.equal(run.status, "completed", "a verdict does not replace the run status");
  const history = await listRuns(root, "pdf-tools", "create-a-folder");
  assert.deepEqual(history.map((r) => r.stamp), ["20261002-080000-2", "20261002-080000"]);
  assert.equal(history[1].verdict.result, "pass");
  assert.equal(history[1].steps, undefined);
  await assert.rejects(setVerdict(root, "pdf-tools", "create-a-folder", a.stamp, { result: "maybe" }), /pass" or "fail/);

  // Clearing history removes exactly one run's folder, and only a real run folder can be named.
  await writeFile(join(root, "pdf-tools", "runs", "create-a-folder", b.stamp, "video.mp4"), "v");
  await deleteRun(root, "pdf-tools", "create-a-folder", b.stamp);
  assert.deepEqual((await listRuns(root, "pdf-tools", "create-a-folder")).map((r) => r.stamp), ["20261002-080000"], "the other run is kept");
  await assert.rejects(deleteRun(root, "pdf-tools", "create-a-folder", ".."), /Not a run/);
  await assert.rejects(deleteRun(root, "pdf-tools", "create-a-folder", "../../project"), /Not a run/);
  await readTest(root, "pdf-tools", "create-a-folder");

  // File serving reads only inside the project folder.
  await writeFile(join(root, "pdf-tools", "runs", "create-a-folder", a.stamp, "01.png"), "png");
  assert.ok((await resolveInProject(root, `pdf-tools/runs/create-a-folder/${a.stamp}/01.png`)).endsWith("01.png"));
  await assert.rejects(resolveInProject(root, "../etc/passwd"), /outside the project folder/);
  await assert.rejects(resolveInProject(root, "pdf-tools/../../etc/passwd"), /outside the project folder/);
  const outside = await mkdtemp(join(tmpdir(), "studio-outside-"));
  await writeFile(join(outside, "secret.txt"), "s");
  await symlink(outside, join(root, "link"));
  await assert.rejects(resolveInProject(root, "link/secret.txt"), /outside the project folder/, "a symlink out of the folder is refused");
  await rm(outside, { recursive: true });
  await mkdir(join(root, "x"), { recursive: true });
  console.log("test-store: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
