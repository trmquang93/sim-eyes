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

/**
 * Numbered controls from an agent-device snapshot. The number is the target
 * `tap` and `type` accept as `index`.
 */
export function listTargets(nodes) {
  const items = [];
  let n = 0;
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (!node.rect || node.rect.width < 8 || node.rect.height < 8) continue;
    const isField =
      node.type?.includes("TextField") ||
      node.type === "SearchField" ||
      node.editable;
    const isTap =
      TAP_TYPES.has(node.type) ||
      node.type?.includes("Button") ||
      node.type === "Cell" ||
      isField;
    if (!isTap) continue;
    const label = clip(node.label || node.identifier || node.type || "item", 60);
    const c = center(node.rect);
    const placeholder = node.placeholder ? clip(node.placeholder) : "";
    const value = node.value ? clip(node.value) : "";
    n += 1;
    items.push({
      n,
      label,
      x: c.x,
      y: c.y,
      editable: !!isField,
      back: node.identifier === "BackButton",
      placeholder: placeholder && placeholder !== label ? placeholder : "",
      value: value && value !== label ? value : "",
    });
  }
  return items;
}

/**
 * What the screen is, beyond its controls: navigation title, where Back goes,
 * an open alert, and a few visible texts. act uses it to judge "already there".
 */
export function screenContext(nodes, { maxTexts = 12 } = {}) {
  const nav = nodes.find((n) => n.type === "NavigationBar");
  const back = nodes.find((n) => n.identifier === "BackButton");
  const alert = nodes.find((n) => n.type === "Alert" || n.type === "Sheet");
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

export function targetByIndex(targets, index) {
  const n = Number(index);
  return targets.find((t) => t.n === n) ?? null;
}

/** Delete key on the keyboard, not an app button named Delete. */
export function keyboardDeleteTarget(targets, screenHeight) {
  const minY = screenHeight * 0.62;
  return (
    targets.find(
      (t) => t.y >= minY && /^(delete|backspace)$/i.test(t.label)
    ) ?? null
  );
}

export function ambiguousLabelNote(label, matches) {
  return [
    `${matches.length} controls are labeled "${label}". Pass index from this list:`,
    formatTargets(matches),
  ].join("\n");
}
