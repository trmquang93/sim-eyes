// Groups for the test list. A test's `group` is a path ("Image to PDF / Delete page"); this turns a list of tests into the
// tree the page draws. Plain module with no DOM, so node can test it.

export const GROUP_SEP = " / ";

/** The same path however it was typed: "A/B", "A /B" and " A / B " are one group. Empty parts are dropped. */
export const normalizeGroup = (group) => String(group ?? "").split("/").map((p) => p.trim()).filter(Boolean).join(GROUP_SEP);

const byName = (a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

/**
 * `{ tests, groups: [{ name, path, tests, groups }] }`: a node holds the tests that sit directly in it and its subgroups,
 * both in the order given for tests and by name for groups. `all(node)` below gives every test under a node.
 */
export function buildTree(tests) {
  const root = { name: "", path: "", tests: [], groups: [] };
  for (const test of tests) {
    let node = root;
    for (const name of normalizeGroup(test.group).split(GROUP_SEP).filter(Boolean)) {
      let child = node.groups.find((g) => g.name === name);
      if (!child) {
        child = { name, path: node.path ? `${node.path}${GROUP_SEP}${name}` : name, tests: [], groups: [] };
        node.groups.push(child);
      }
      node = child;
    }
    node.tests.push(test);
  }
  const sort = (node) => (node.groups.sort(byName), node.groups.forEach(sort));
  sort(root);
  return root;
}

/** Every test under a node, subgroups included. */
export const all = (node) => [...node.tests, ...node.groups.flatMap(all)];

/** Every group path that exists, subgroups too ("A" and "A / B"), for a list to pick from. */
export const groupPaths = (tests) => [...new Set(tests.flatMap((t) => { const parts = normalizeGroup(t.group).split(GROUP_SEP).filter(Boolean); return parts.map((_, i) => parts.slice(0, i + 1).join(GROUP_SEP)); }))].sort((a, b) => a.localeCompare(b));
