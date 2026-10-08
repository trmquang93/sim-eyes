import { exactLabelMatches, visibleNodes } from "./targets.mjs";

const TAP_VERB = /^(?:please\s+)?(?:tap|press|click|select|choose|open|go to)(?:\s+on)?\s+(.+)$/i;
/** "go back": the Back button of a pushed screen. */
export const BACK_GOAL = /^(?:please\s+)?(?:go|navigate)\s+back$|^back$/i;
/** The Back controls on screen: the nav bar's BackButton, or any control labelled "Back". */
export const backTargets = (targets) => targets.filter((t) => t.back || t.label.trim().toLowerCase() === "back");
const QUOTES = /^["'“”‘’]+|["'“”‘’.]+$/g;

/** What a "tap <label>" instruction names: the text as written, then without a leading article or trailing control word. */
function labelCandidates(instruction) {
  const m = TAP_VERB.exec(instruction.trim());
  if (!m) return [];
  const written = m[1].replace(QUOTES, "").trim();
  const withoutArticle = written.replace(/^(?:the|a|an)\s+/i, "");
  const withoutKind = withoutArticle.replace(/\s+(?:button|tab|row|cell|link|option|icon|chevron|arrow)$/i, "");
  return [...new Set([written, withoutArticle, withoutKind].filter(Boolean))];
}

/**
 * Whether a "tap <label>" goal names the control that was just tapped ("tap the Back chevron" names
 * "Back"). The screen after such a tap cannot show that it happened, so a visible change confirms it.
 */
export function tapGoalNames(instruction, label) {
  const name = String(label ?? "").trim().toLowerCase();
  return name !== "" && labelCandidates(instruction).some((c) => c.toLowerCase() === name);
}

/** The text fields whose placeholder or current value is exactly this text. */
function fieldsNamed(targets, name) {
  const needle = name.toLowerCase();
  return targets.filter((t) => t.editable && [t.placeholder, t.value].some((v) => v && String(v).trim().toLowerCase() === needle));
}

/** Every visible text with this exact label, as points to tap: a list row's title is text, not a control. */
function textTargets(nodes, label) {
  const needle = label.trim().toLowerCase();
  return visibleNodes(nodes)
    .filter(
      (n) =>
        n.type === "StaticText" &&
        n.rect && n.rect.width > 0 && n.rect.height > 0 &&
        n.interactionBlocked !== "covered" &&
        String(n.label ?? "").trim().toLowerCase() === needle
    )
    .map((n) => ({
      n: 0,
      label: n.label,
      x: Math.round(n.rect.x + n.rect.width / 2),
      y: Math.round(n.rect.y + n.rect.height / 2),
      text: true,
    }));
}

const reading = (t) => `${JSON.stringify(t.label)} at (${t.x}, ${t.y})`;

/**
 * The control a `tap` step names. Code answers, no model call. The label must match a visible control exactly
 * (case aside); when no control has it, a visible text with that exact label (a file row) is tapped. Several
 * matches are an error that lists them, unless `nth` (1-based, top to bottom, then left to right) picks one.
 * A near match is never taken.
 */
export function tapTarget({ label, nth } = {}, targets, nodes = []) {
  const wanted = String(label ?? "").replace(QUOTES, "").trim();
  if (!wanted) throw new Error('tap needs a label: the exact label of a visible control, e.g. {"tool":"tap","label":"Next"}.');
  let found = exactLabelMatches(targets, wanted);
  // A text field is named by its placeholder ("Search files and contents"), not by its label.
  if (found.length === 0) found = fieldsNamed(targets, wanted);
  if (found.length === 0) found = textTargets(nodes, wanted);
  if (found.length === 0) {
    const seen = [...new Set(targets.map((t) => t.label).filter(Boolean))].slice(0, 25).map((l) => JSON.stringify(l));
    throw new Error(
      `No visible control or text labelled ${JSON.stringify(wanted)}. Visible labels: ${seen.join(", ") || "none"}. ` +
        `Use goal for something you cannot name exactly, or tap_at for a control with no label.`
    );
  }
  found = [...found].sort((a, b) => a.y - b.y || a.x - b.x);
  if (nth != null) {
    const i = Math.round(Number(nth));
    if (!(i >= 1 && i <= found.length)) throw new Error(`nth ${nth} is out of range: ${found.length} match(es) for ${JSON.stringify(wanted)}: ${found.map(reading).join("; ")}.`);
    return found[i - 1];
  }
  if (found.length > 1) {
    throw new Error(`${found.length} controls are labelled ${JSON.stringify(wanted)}: ${found.map((t, i) => `${i + 1}. ${reading(t)}`).join("; ")}. Pass nth (1-based, in this order) or use tap_at.`);
  }
  return found[0];
}

/** How many taps a `tap_at` / `double_tap` step makes: 1 or 2 (`double_tap` is always 2). Any other `count` is refused, never ignored. */
export function tapCount(args, tool) {
  const wanted = tool === "double_tap" ? 2 : 1;
  if (args.count == null) return wanted;
  const count = Number(args.count);
  if (count === wanted || (tool === "tap_at" && count === 2)) return count;
  throw new Error(
    tool === "double_tap"
      ? `double_tap is always two taps; count ${JSON.stringify(args.count)} is not accepted. Leave count out (or 2).`
      : `tap_at count must be 1 or 2 (2 = double tap), not ${JSON.stringify(args.count)}. For a grid of cells use tap_grid.`
  );
}

const area = (n) => n.rect.width * n.rect.height;
/** A point inside one of these names the container, not an item in it: a drag from there grabs nothing. */
const CONTAINER_TYPES = new Set(["ScrollView", "CollectionView", "Table", "Other", "NavigationBar", "WebView"]);

function describe(node) {
  const c = { x: Math.round(node.rect.x + node.rect.width / 2), y: Math.round(node.rect.y + node.rect.height / 2) };
  return `${node.type} ${JSON.stringify(node.label ?? "")} at (${c.x}, ${c.y})`;
}

/**
 * The accessibility node a drag or long press names: a visible label (a page number, a row title)
 * or a point. A label shared by several nodes is an error that lists them, never a guess.
 * Returns the node with a `ref` agent-device can address.
 */
export function gestureNode(allNodes, spec) {
  const nodes = visibleNodes(allNodes).filter(
    (n) => n.ref && n.rect && n.rect.width > 0 && n.rect.height > 0 && n.parentIndex != null
  );
  if (typeof spec === "string" || (spec && typeof spec === "object" && spec.label != null)) {
    const label = String(typeof spec === "string" ? spec : spec.label).trim();
    const needle = label.toLowerCase();
    const hits = nodes.filter((n) => [n.label, n.identifier].some((v) => v && String(v).trim().toLowerCase() === needle));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      const seen = [...new Set(nodes.map((n) => n.label).filter(Boolean))].slice(0, 20).map((l) => JSON.stringify(l));
      throw new Error(`No visible element labelled ${JSON.stringify(label)}. Visible labels: ${seen.join(", ") || "none"}. Use {"x":…,"y":…} for an element without a label.`);
    }
    throw new Error(`${hits.length} elements are labelled ${JSON.stringify(label)}: ${hits.map(describe).join("; ")}. Pass {"x":…,"y":…} for the one you mean.`);
  }
  if (spec && Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))) {
    const { x, y } = { x: Number(spec.x), y: Number(spec.y) };
    const inside = nodes.filter(
      (n) =>
        n.type !== "Toolbar" &&
        x >= n.rect.x && x <= n.rect.x + n.rect.width && y >= n.rect.y && y <= n.rect.y + n.rect.height
    );
    if (inside.length === 0) throw new Error(`No element at (${x}, ${y}).`);
    const smallest = inside.reduce((best, n) => (area(n) < area(best) ? n : best));
    if (CONTAINER_TYPES.has(smallest.type)) {
      const near = nodes
        .filter((n) => n.label && !CONTAINER_TYPES.has(n.type))
        .map((n) => ({ n, d: Math.hypot(n.rect.x + n.rect.width / 2 - x, n.rect.y + n.rect.height / 2 - y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 6)
        .map(({ n }) => describe(n));
      throw new Error(
        `Only a ${smallest.type} is at (${x}, ${y}); it has no element there to hold. ${near.length ? `Nearest labelled elements: ${near.join("; ")}. ` : ""}Pass the label of the element you mean.`
      );
    }
    return smallest;
  }
  throw new Error('A drag or long press target is a label string or {"x":…,"y":…}.');
}

/** Both ends of a drag. A drag that starts and ends on the same element moves nothing, so it is an error, not a success. */
export function dragEnds(nodes, from, to) {
  const source = gestureNode(nodes, from);
  const destination = gestureNode(nodes, to);
  if (source.ref === destination.ref) {
    throw new Error(`drag from and to are the same element (${describe(source)}). Name a different destination.`);
  }
  return { source, destination };
}

export const PINCH_MIN = 0.2;
export const PINCH_MAX = 5;

/** The `pinch` step's arguments: `{ scale, centre, what }`. Scale 1 moves nothing, so it is an error, not a success. */
export function pinchPlan(args) {
  const scale = Number(args.scale);
  if (args.scale == null || !Number.isFinite(scale) || scale < PINCH_MIN || scale > PINCH_MAX || scale === 1) {
    throw new Error(`pinch needs scale between ${PINCH_MIN} and ${PINCH_MAX}, not 1: above 1 zooms in (e.g. 2), below 1 zooms out (e.g. 0.5). Optional x, y is the centre.`);
  }
  const hasCentre = args.x != null || args.y != null;
  const centre = hasCentre ? [Math.round(Number(args.x)), Math.round(Number(args.y))] : [];
  if (hasCentre && (args.x == null || args.y == null || centre.some((v) => !Number.isFinite(v)))) throw new Error("pinch: pass both x and y as numbers (points), or neither.");
  return { scale, centre, what: `pinched ${scale > 1 ? "open (zoom in)" : "closed (zoom out)"} by ${scale}${centre.length ? ` around (${centre[0]}, ${centre[1]})` : ""}` };
}

/** Most points one `tap_grid` step taps: a Photos picker caps a selection near this, and a runaway grid is a mistake. */
export const GRID_MAX = 100;

/**
 * The `tap_grid` step's arguments: `{ points, what }`, row by row from the first cell (x, y) with `dx` across and `dy` down.
 * `count` stops early, for a last row that is not full (50 photos in a grid of 5 columns).
 */
export function gridPlan(args, screen) {
  const num = (v) => (v == null || v === "" ? NaN : Number(v));
  const x = num(args.x);
  const y = num(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('tap_grid needs x and y: the centre of the first cell, e.g. {"tool":"tap_grid","x":44,"y":168,"dx":88,"dy":88,"cols":5,"rows":8}.');
  const whole = (v, name, fallback) => {
    const n = v == null ? fallback : num(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`tap_grid: ${name} must be a whole number of at least 1.`);
    return n;
  };
  const cols = whole(args.cols, "cols", 1);
  const rows = whole(args.rows, "rows", 1);
  const count = whole(args.count, "count", cols * rows);
  if (count > cols * rows) throw new Error(`tap_grid: count ${count} is more than cols x rows (${cols * rows}).`);
  if (count > GRID_MAX) throw new Error(`tap_grid: ${count} taps is more than the ${GRID_MAX} one step may tap. Split it into several tap_grid steps.`);
  const dx = args.dx == null ? 0 : num(args.dx);
  const dy = args.dy == null ? 0 : num(args.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("tap_grid: dx and dy must be numbers (points between cell centres).");
  if ((cols > 1 && dx === 0) || (rows > 1 && dy === 0)) throw new Error("tap_grid: several cols need dx, several rows need dy (the distance between cell centres, in points). Otherwise every tap lands on the same cell and toggles it.");
  const points = [];
  for (let r = 0; r < rows && points.length < count; r++) {
    for (let c = 0; c < cols && points.length < count; c++) points.push({ x: Math.round(x + c * dx), y: Math.round(y + r * dy) });
  }
  const out = points.find((p) => p.x < 0 || p.y < 0 || p.x > screen.width || p.y > screen.height);
  if (out) throw new Error(`tap_grid: (${out.x}, ${out.y}) is outside the ${screen.width}x${screen.height} screen.`);
  return { points, what: `tapped ${points.length} points (${cols} across, ${rows} down) from (${points[0].x}, ${points[0].y}) to (${points[points.length - 1].x}, ${points[points.length - 1].y})` };
}
