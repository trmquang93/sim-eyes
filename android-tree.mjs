/**
 * Android snapshots in the vocabulary the rest of sim-eyes reads. agent-device describes an Android screen with class
 * names (`android.widget.TextView`) and no labels on rows: a row is a hittable LinearLayout whose title and summary are
 * child TextViews. iOS describes a row as one Cell with a label. This turns the first into the second, so targets,
 * screen summaries and act steps work on both without knowing the platform. Rects are converted from pixels to points
 * (pixels / scale, scale = dpi / 160) so everything downstream keeps working in the iOS unit.
 */

const shortClass = (node) => String(node.type ?? "").split(".").pop();

function iosType(node) {
  const cls = shortClass(node);
  if (/Switch|CheckBox|ToggleButton/.test(cls)) return "Switch";
  if (node.kind === "text" && node.hittable === true) return "Link"; // tappable text (a help link), not a row's title
  if (node.kind === "text-field" || node.editable || /EditText/.test(cls)) return "TextField";
  if (node.kind === "button" || /Button$/.test(cls)) return "Button";
  if (node.kind === "text" || cls === "TextView") return "StaticText";
  return node.type;
}

/** A copy of the snapshot with iOS-style types, and a label on every row that has text. Rows scrolled out of view are dropped. */
export function normalizeAndroidNodes(raw, { scale = 1 } = {}) {
  const inPoints = (r) => (scale === 1 || !r ? r : { x: Math.round(r.x / scale), y: Math.round(r.y / scale), width: Math.round(r.width / scale), height: Math.round(r.height / scale) });
  const nodes = raw.filter((n) => n.visibleToUser !== false).map((n) => ({ ...n, rect: inPoints(n.rect), rawType: n.type, type: iosType(n) }));
  const children = new Map();
  for (const n of nodes) {
    if (n.parentIndex == null) continue;
    if (!children.has(n.parentIndex)) children.set(n.parentIndex, []);
    children.get(n.parentIndex).push(n);
  }
  const below = (n) => (children.get(n.index) ?? []).flatMap((c) => [c, ...below(c)]);
  const hittableGroup = (n) => n.kind === "group" && n.hittable === true;

  for (const n of nodes) {
    if (!hittableGroup(n) || n.label) continue;
    const inside = below(n);
    // A container of rows is not a row, and a group around a text box is not tapped as a row.
    if (inside.some(hittableGroup) || inside.some((c) => c.type === "TextField")) continue;
    let texts = inside.filter((c) => c.type === "StaticText" && c.label);
    // An icon-only control (a Compose `+` button) has no TextView: its contentDescription is a labelled child View.
    if (texts.length === 0) texts = inside.filter((c) => c.label && !hittableGroup(c)).slice(0, 1);
    if (texts.length === 0) continue;
    const title = texts.find((t) => /\/title$/.test(t.identifier ?? "")) ?? texts[0];
    n.type = "Cell";
    n.label = title.label;
    const rest = texts.filter((t) => t !== title).map((t) => t.label);
    if (rest.length) n.value = rest.join(" · ");
  }
  // An AlertDialog's button bar (android.R.id.button1-3) marks a dialog: iOS names an open alert, so name this one too.
  const buttons = nodes.filter((n) => n.type === "Button" && /\/button[123]$/.test(n.identifier ?? "") && n.label);
  const bar = buttons.length ? nodes.find((n) => n.index === buttons[0].parentIndex) : null;
  if (bar) {
    bar.type = "Alert";
    bar.label = `dialog with ${buttons.map((b) => b.label).join(" / ")}`;
  }
  return nodes;
}
