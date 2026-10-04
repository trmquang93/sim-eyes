// The test list groups tests by their `group` path. A tester who writes "A/B" in one test and "A / B" in another means one
// group, and "Run group" on A must take B's tests too; if the tree split them, a screen's tests would be run in pieces.
import assert from "node:assert/strict";
import { all, buildTree, groupPaths, normalizeGroup } from "./public/groups.js";

assert.equal(normalizeGroup(" Image to PDF/ Delete  page "), "Image to PDF / Delete  page");
assert.equal(normalizeGroup("A / / B /"), "A / B", "empty parts are dropped");
assert.equal(normalizeGroup(undefined), "");

const t = (slug, group) => ({ slug, group });
const tree = buildTree([t("a1", "Camera"), t("p1", "Image to PDF / Delete page"), t("p2", "Image to PDF/Delete page"), t("p3", "Image to PDF"), t("loose", ""), t("c2", "camera")]);

assert.deepEqual(tree.groups.map((g) => g.path), ["Camera", "camera", "Image to PDF"], "names sort; case is kept (the filter and the run compare paths as typed)");
assert.deepEqual(tree.tests.map((x) => x.slug), ["loose"], "a test with no group sits at the top");
const pdf = tree.groups.find((g) => g.path === "Image to PDF");
assert.deepEqual(pdf.tests.map((x) => x.slug), ["p3"]);
assert.deepEqual(pdf.groups.map((g) => [g.name, g.path, g.tests.map((x) => x.slug)]), [["Delete page", "Image to PDF / Delete page", ["p1", "p2"]]], "A/B and A / B are one subgroup");
assert.deepEqual(all(pdf).map((x) => x.slug).sort(), ["p1", "p2", "p3"], "running a group takes its subgroups");
assert.deepEqual(groupPaths([t("x", "A / B / C"), t("y", "A")]), ["A", "A / B", "A / B / C"], "every level can be picked");
assert.deepEqual(buildTree([]).groups, []);
console.log("test-groups: ok");
