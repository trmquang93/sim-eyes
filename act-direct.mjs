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
  const withoutKind = withoutArticle.replace(/\s+(?:button|tab|row|cell|link|option|icon)$/i, "");
  return [...new Set([written, withoutArticle, withoutKind].filter(Boolean))];
}

/** The one visible text with this exact label, as a point to tap: a list row's title is text, not a control. */
function uniqueText(nodes, label) {
  const needle = label.trim().toLowerCase();
  const hits = visibleNodes(nodes).filter(
    (n) =>
      n.type === "StaticText" &&
      n.rect && n.rect.width > 0 && n.rect.height > 0 &&
      n.interactionBlocked !== "covered" &&
      String(n.label ?? "").trim().toLowerCase() === needle
  );
  if (hits.length !== 1) return null;
  const { rect } = hits[0];
  return { n: 0, label: hits[0].label, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), text: true };
}

/**
 * The one control a plain "tap <label>" instruction names, or null. Code answers here, so the
 * step needs no model call: it applies only when exactly one control has that exact label, or,
 * when no control has it, exactly one visible text does (a file row). Near matches are never taken.
 */
export function directTapTarget(instruction, targets, nodes = []) {
  if (BACK_GOAL.test(instruction.trim())) {
    const backs = backTargets(targets);
    return backs.length === 1 ? backs[0] : null;
  }
  const labels = labelCandidates(instruction);
  for (const label of labels) {
    const matches = exactLabelMatches(targets, label);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  for (const label of labels) {
    const text = uniqueText(nodes, label);
    if (text) return text;
  }
  return null;
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
