const TAP_TYPES = new Set([
  "Button",
  "Cell",
  "Switch",
  "Tab",
  "Link",
  "MenuItem",
  "SearchField",
  "TextField",
  "SecureTextField",
]);

function isFieldNode(node) {
  return !!(node.type?.includes("TextField") || node.type === "SearchField" || node.editable);
}

function isTapNode(node) {
  return TAP_TYPES.has(node.type) || node.type?.includes("Button") || node.type === "Cell" || isFieldNode(node);
}

function center(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

function clip(text, max = 40) {
  const oneLine = String(text).split("\n")[0];
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function isWebDialog(node) {
  return /web dialog/i.test(node.label || "");
}

/** The branch under the Application node that holds `node` (the node itself when it is one). */
function topBranch(node, byIndex) {
  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(cur.index)) {
    seen.add(cur.index);
    const parent = byIndex.get(cur.parentIndex);
    if (!parent || parent.parentIndex == null) return cur;
    cur = parent;
  }
  return cur;
}

function fillsScreen(node, root) {
  return !!(
    node.rect && root?.rect &&
    node.rect.width >= root.rect.width * 0.9 &&
    node.rect.height >= root.rect.height * 0.9
  );
}

/**
 * Indexes of branches that hold a dismissed web dialog. A consent form (UMP) can stay in the
 * tree after it closes, still full screen and hittable. While it is shown, iOS exposes only the
 * dialog; once it is gone, the app's own views show up beside it. So a full-screen web dialog
 * with a labelled native (non-web) view in another branch is a leftover.
 */
export function staleDialogBranches(nodes) {
  const byIndex = new Map(nodes.filter((n) => n.index != null).map((n) => [n.index, n]));
  const root = nodes.find((n) => n.parentIndex == null);
  const stale = new Set();
  for (const dialog of nodes) {
    if (!isWebDialog(dialog) || !fillsScreen(dialog, root)) continue;
    const branch = topBranch(dialog, byIndex);
    const appScreen = nodes.some((n) => {
      if (n === root || !n.label) return false;
      const other = topBranch(n, byIndex);
      return other !== branch && other.type !== "WebView";
    });
    if (appScreen) stale.add(branch.index);
  }
  return stale;
}

const CONTENT_TYPES = new Set(["NavigationBar", "ScrollView", "CollectionView", "Table", "WebView"]);

/**
 * Indexes of nodes that belong to the screen under a presented sheet. iOS keeps the presenting
 * screen in the accessibility tree: the sheet's branches come first, then a full-screen Toolbar
 * node, then the screen below it. Branches split at those Toolbars into layers; when two layers
 * hold screen content (a keyboard layer does not count), only the first one is on top.
 * The exception is content after the last Toolbar: that Toolbar closes a tab root, and a screen
 * pushed over it (a document viewer that hides the tab bar) is listed after it, so it is on top.
 * A pushed screen with nothing after its Toolbar is left alone.
 */
export function behindModal(nodes) {
  const root = nodes.find((n) => n.parentIndex == null);
  if (!root) return new Set();
  const byIndex = new Map(nodes.filter((n) => n.index != null).map((n) => [n.index, n]));
  let layer = 0;
  const layerOfBranch = new Map();
  for (const node of nodes) {
    if (node.parentIndex !== root.index) continue;
    if (node.type === "Toolbar" && fillsScreen(node, root)) layer += 1;
    else layerOfBranch.set(node.index, layer);
  }
  const layerOf = (node) => layerOfBranch.get(topBranch(node, byIndex)?.index);
  const members = Array.from({ length: layer + 1 }, () => []);
  for (const node of nodes) {
    const l = layerOf(node);
    if (l != null) members[l].push(node);
  }
  const hasContent = members.map(
    (inLayer) =>
      inLayer.some((n) => n.rect && n.rect.width >= 8 && n.rect.height >= 8) &&
      inLayer.some((n) => CONTENT_TYPES.has(n.type)) &&
      !inLayer.some((n) => /^Key(board)?$/.test(n.type))
  );
  const first = hasContent.indexOf(true);
  if (first < 0 || hasContent.lastIndexOf(true) === first) return new Set();
  const top = hasContent[layer] ? layer : first;
  return new Set(
    members.flatMap((inLayer, l) => (l !== top && hasContent[l] ? inLayer.map((n) => n.index) : []))
  );
}

/** The snapshot without leftover dialog branches and without the screen under a sheet: what is actually on screen. */
export function visibleNodes(nodes) {
  const stale = staleDialogBranches(nodes);
  const behind = behindModal(nodes);
  if (stale.size === 0 && behind.size === 0) return nodes;
  const byIndex = new Map(nodes.filter((n) => n.index != null).map((n) => [n.index, n]));
  return nodes.filter((n) => !stale.has(topBranch(n, byIndex)?.index) && !behind.has(n.index));
}

/** System alert/sheet, or a consent web dialog covering the app. Leftover dialogs do not count. */
export function coveringDialog(nodes) {
  return (
    visibleNodes(nodes).find(
      (n) => n.type === "Alert" || n.type === "Sheet" || isWebDialog(n)
    ) ?? null
  );
}

/**
 * Indexes of nodes drawn under a popup web view: a top-level WebView smaller than the screen
 * (the AdMob native ad validator) comes later in the tree, so it is drawn over earlier views.
 * agent-device does not mark those as covered, and a tap at their center hits the popup.
 * Maps each covered node's index to the popup's name.
 */
export function overlayCovered(nodes) {
  const byIndex = new Map(nodes.filter((n) => n.index != null).map((n) => [n.index, n]));
  const root = nodes.find((n) => n.parentIndex == null);
  const popups = nodes.filter(
    (n) => n.type === "WebView" && n.rect && n !== root && topBranch(n, byIndex) === n && !fillsScreen(n, root)
  );
  const covered = new Map();
  for (const popup of popups) {
    const r = popup.rect;
    const name = popup.label || nodes.find((n) => n.label && topBranch(n, byIndex) === popup)?.label || "a popup";
    for (const node of nodes) {
      if (node === root || !isTapNode(node) || !node.rect || node.index == null || node.index >= popup.index) continue;
      if (topBranch(node, byIndex) === popup) continue;
      const c = center(node.rect);
      if (c.x >= r.x && c.x <= r.x + r.width && c.y >= r.y && c.y <= r.y + r.height) covered.set(node.index, name);
    }
  }
  return covered;
}

function insideNode(nodes, node, ancestor) {
  if (node.index == null || ancestor.index == null) return false;
  const byIndex = new Map();
  for (const n of nodes) {
    if (n.index != null) byIndex.set(n.index, n);
  }
  let cur = node;
  const seen = new Set();
  while (cur && cur.index != null && !seen.has(cur.index)) {
    if (cur.index === ancestor.index) return true;
    seen.add(cur.index);
    const parent = cur.parentIndex;
    if (parent == null) return false;
    cur = byIndex.get(parent);
  }
  return false;
}

/**
 * Numbered controls from an agent-device snapshot. The number is the target
 * `tap` and `type` accept as `index`.
 */
export function listTargets(allNodes) {
  const nodes = visibleNodes(allNodes);
  const dialog = coveringDialog(nodes);
  const underPopup = overlayCovered(nodes);
  // A sheet's full-height Toolbar can make agent-device mark every control under it covered. A screen
  // whose controls are all blocked is not a screen anyone can use, so the marks are a false alarm.
  const tappable = nodes.filter((n) => n.enabled && isTapNode(n) && n.rect && n.rect.width >= 8 && n.rect.height >= 8);
  const allCovered = tappable.length > 0 && tappable.every((n) => n.interactionBlocked === "covered");
  const items = [];
  let n = 0;
  for (const node of nodes) {
    if (!node.enabled) continue;
    // agent-device marks a control drawn under another view (e.g. a row under the tab bar).
    if ((node.interactionBlocked === "covered" && !allCovered) || underPopup.has(node.index)) continue;
    // A consent web dialog (UMP) sits over the app. Its buttons are in the tree,
    // and so are the rows behind it. Only the dialog's controls are tappable.
    if (
      dialog &&
      isWebDialog(dialog) &&
      node.index != null &&
      !insideNode(nodes, node, dialog)
    ) {
      continue;
    }
    if (!node.rect || node.rect.width < 8 || node.rect.height < 8) continue;
    const isField = isFieldNode(node);
    if (!isTapNode(node)) continue;
    const label = clip(node.label || node.identifier || node.type || "item", 60);
    const c = center(node.rect);
    const placeholder = node.placeholder ? clip(node.placeholder) : "";
    const value = node.value ? clip(node.value) : "";
    n += 1;
    items.push({
      n,
      nodeIndex: node.index,
      label,
      x: c.x,
      y: c.y,
      editable: !!isField,
      back: node.identifier === "BackButton",
      labeled: !!node.label,
      placeholder: placeholder && placeholder !== label ? placeholder : "",
      value: value && value !== label ? value : "",
    });
  }
  return items;
}

/** A pager's position as "Page n of m" (UIPageControl, SwiftUI page TabView), or null. */
function pageIndicator(nodes) {
  for (const n of nodes) {
    const m = /\bpage (\d+) of (\d+)\b/i.exec(n.label || n.value || "");
    if (m) return `Page ${m[1]} of ${m[2]}`;
  }
  return null;
}

/**
 * What the screen is, beyond its controls: navigation title, where Back goes,
 * an open alert, the page of a pager, and a few visible texts. act uses it to judge "already there".
 */
export function screenContext(allNodes, { maxTexts = 12 } = {}) {
  const nodes = visibleNodes(allNodes);
  const nav = nodes.find((n) => n.type === "NavigationBar");
  const back = nodes.find((n) => n.identifier === "BackButton");
  const alert = coveringDialog(nodes);
  const page = pageIndicator(nodes);
  const texts = [];
  for (const n of nodes) {
    if (n.type !== "StaticText" || !n.label) continue;
    const t = clip(n.label, 80);
    if (!texts.includes(t)) texts.push(t);
    if (texts.length >= maxTexts) break;
  }
  return {
    title: nav?.identifier || nav?.label || null,
    backTo: back ? back.label || "previous screen" : null,
    alert: alert ? alert.label || alert.identifier || "untitled alert" : null,
    ...(page ? { page } : {}),
    texts,
  };
}

export function formatTargetLine(t) {
  const extra = [];
  if (t.placeholder) extra.push(`placeholder=${JSON.stringify(t.placeholder)}`);
  if (t.value) extra.push(`value=${JSON.stringify(t.value)}`);
  const detail = extra.length ? ` ${extra.join(" ")}` : "";
  return `${t.n}. ${t.label}${detail} (${t.x}, ${t.y})`;
}

export function formatTargets(targets) {
  if (targets.length === 0) return "No tappable controls found.";
  return targets.map(formatTargetLine).join("\n");
}

export function exactLabelMatches(targets, label) {
  const needle = String(label).trim().toLowerCase();
  return targets.filter((t) => t.label.trim().toLowerCase() === needle);
}




/**
 * The accessibility tree as indented lines: type, label, frame (x, y, width x height).
 * A tappable node is tagged with its control number, or says why the control list left it out:
 * "covered by another view", "not listed" (disabled, tiny, or behind a dialog). A dismissed
 * dialog still in the tree is tagged "leftover dialog, not on screen".
 */
export function formatTree(nodes, targets, { maxLines = 200, tag = (n) => ` -> #${n}` } = {}) {
  const numbers = new Map(targets.filter((t) => t.nodeIndex != null).map((t) => [t.nodeIndex, t.n]));
  const stale = staleDialogBranches(nodes);
  const underPopup = overlayCovered(visibleNodes(nodes));
  const behind = behindModal(nodes);
  const depth = new Map();
  const lines = [];
  for (const node of nodes) {
    const level = node.parentIndex != null && depth.has(node.parentIndex) ? depth.get(node.parentIndex) + 1 : 0;
    if (node.index != null) depth.set(node.index, level);
    if (lines.length >= maxLines) continue;
    const label = node.label || node.identifier;
    const frame = node.rect
      ? ` (${[node.rect.x, node.rect.y].map(Math.round).join(", ")}, ${Math.round(node.rect.width)}x${Math.round(node.rect.height)})`
      : "";
    const mark = numbers.has(node.index)
      ? tag(numbers.get(node.index))
      : stale.has(node.index)
        ? " [leftover dialog, not on screen]"
        : behind.has(node.index) && isTapNode(node) ? " [behind the sheet]"
        : underPopup.has(node.index) ? ` [covered by popup ${JSON.stringify(clip(underPopup.get(node.index), 40))}]`
        : node.interactionBlocked === "covered" ? " [covered by another view]"
        : isTapNode(node) ? " [not listed]" : "";
    lines.push(`${"  ".repeat(level)}${node.type}${label ? ` ${JSON.stringify(clip(label, 50))}` : ""}${frame}${mark}`);
  }
  if (nodes.length > lines.length) lines.push(`... ${nodes.length - lines.length} more node(s)`);
  return lines.join("\n");
}
