import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseFields, createProject, deleteRun, listProjects, listRuns, listSuites, listTests, newRunDir, newSuiteDir, readFixtureSets, readRun, readSuite, readTest, resolveInProject, setVerdict, slug, updateProject, setGroup, writeFixtureSets, writeRun, writeSuite, writeTest } from "./store.mjs";

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

  // A case from the QA sheet keeps its ID, group, priority, notes, fixtures and skip tag, and the list shows them.
  {
    const fields = caseFields({ id: " TC-IMG-032 ", group: "Image to PDF / Xóa trang", priority: "p0", notes: "3 pages", fixtures: ["photos-3", "photos-3", ""], skip: { reason: "camera", note: "needs the camera" } });
    assert.deepEqual(fields, { id: "TC-IMG-032", group: "Image to PDF / Xóa trang", priority: "P0", notes: "3 pages", fixtures: ["photos-3"], skip: { reason: "camera", note: "needs the camera" } });
    await writeTest(root, "pdf-tools", "delete-a-page", { name: "Delete a page", start: "fresh", lines: [], ...fields });
    const listed = (await listTests(root, "pdf-tools")).find((x) => x.slug === "delete-a-page");
    assert.equal(listed.id, "TC-IMG-032");
    assert.equal(listed.priority, "P0");
    assert.deepEqual(listed.skip, fields.skip);
    assert.deepEqual(caseFields({}), { id: "", group: "", priority: "", notes: "", fixtures: [], skip: null }, "a test with no case fields is valid");
    assert.equal(caseFields({ group: " Image to PDF/Xóa trang " }).group, "Image to PDF / Xóa trang", "one group however it was typed");
    assert.throws(() => caseFields({ priority: "P9" }), /priority must be one of/);
    assert.throws(() => caseFields({ skip: { reason: "cmaera" } }), /skip reason must be one of/);
    // A report is made against the ID, so two tests may not share one, even in another letter case; saving a test again keeps its own ID.
    await assert.rejects(writeTest(root, "pdf-tools", "other", { name: "Other", start: "fresh", lines: [], id: "tc-img-032" }), /already used by "Delete a page"/);
    await writeTest(root, "pdf-tools", "delete-a-page", { name: "Delete a page", start: "fresh", lines: [], ...fields, notes: "edited" });

    // Moving tests into a group changes only their group; a missing test stops the move before it changes any.
    assert.equal(await setGroup(root, "pdf-tools", ["delete-a-page", "create-a-folder"], " Files/ Move "), "Files / Move");
    assert.deepEqual((await listTests(root, "pdf-tools")).map((x) => [x.slug, x.group, x.id]).sort(), [["create-a-folder", "Files / Move", undefined], ["delete-a-page", "Files / Move", "TC-IMG-032"]]);
    await assert.rejects(setGroup(root, "pdf-tools", ["create-a-folder", "nope"], "Other"), /No such test: nope/);
    assert.equal((await readTest(root, "pdf-tools", "create-a-folder")).group, "Files / Move", "nothing moved when one test was missing");
    assert.equal(await setGroup(root, "pdf-tools", ["create-a-folder"], ""), "", "an empty group takes a test out of its group");
    await setGroup(root, "pdf-tools", ["delete-a-page"], fields.group);
  }

  // The reviewer's verdict overrides the suggestion, and the run keeps both.
  {
    const d = await newRunDir(root, "pdf-tools", "delete-a-page", new Date(2026, 9, 3, 9, 0, 0));
    await writeRun(root, "pdf-tools", "delete-a-page", d.stamp, { test, status: "completed", steps: [], suggestedVerdict: "pass", checkpoints: [{ n: 2, suggested: "pass", p: 0.95 }] });
    const after = await setVerdict(root, "pdf-tools", "delete-a-page", d.stamp, { result: "fail", note: "page 2 still there" });
    assert.equal(after.verdict.result, "fail");
    assert.equal(after.suggestedVerdict, "pass", "the suggestion stays beside the verdict");
    assert.equal(after.checkpoints[0].p, 0.95);
  }

  // Fixture sets and suites live in the project folder.
  {
    assert.deepEqual(await readFixtureSets(root, "pdf-tools"), {}, "no fixtures file = no sets");
    await writeFixtureSets(root, "pdf-tools", { "photos-3": { photos: ["photos/a.jpg"] } });
    assert.deepEqual((await readFixtureSets(root, "pdf-tools"))["photos-3"], { photos: ["photos/a.jpg"] });
    const s = await newSuiteDir(root, "pdf-tools", new Date(2026, 9, 3, 10, 0, 0));
    const s2 = await newSuiteDir(root, "pdf-tools", new Date(2026, 9, 3, 10, 0, 0));
    assert.equal(s2.stamp, `${s.stamp}-2`);
    await writeSuite(root, "pdf-tools", s.stamp, { status: "completed", items: [] });
    assert.equal((await readSuite(root, "pdf-tools", s.stamp)).status, "completed");
    assert.deepEqual((await listSuites(root, "pdf-tools")).map((x) => x.stamp), [s.stamp]);
    await assert.rejects(readSuite(root, "pdf-tools", "../x"), /Not a suite/);
  }

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
