const MAX_TEXTS = 8;
const MAX_LABELS = 14;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line on what the screen is: title, pager position, alert, Back target and a few visible texts. */
export function screenLine(context) {
  if (!context) return "screen: unknown";
  const head = [
    context.title ? JSON.stringify(context.title) : null,
    context.page,
    context.alert ? `alert ${JSON.stringify(context.alert)}` : null,
    context.backTo ? `back to ${JSON.stringify(context.backTo)}` : null,
  ].filter(Boolean);
  const texts = (context.texts ?? []).slice(0, MAX_TEXTS).map((t) => clip(t, 40));
  return `screen: ${head.length ? head.join(" · ") : "(no title)"}${texts.length ? ` | texts: ${texts.join(" / ")}` : ""}`;
}

/** The control labels on screen, without numbers or coordinates: enough to word the next instruction. */
export function controlsLine(targets) {
  const labels = [...new Set(targets.map((t) => clip(t.label, 30)))];
  if (labels.length === 0) return "controls: none";
  const shown = labels.slice(0, MAX_LABELS).join(" · ");
  return `controls (${targets.length}): ${shown}${labels.length > MAX_LABELS ? ` · +${labels.length - MAX_LABELS} more` : ""}`;
}

/** The screen line when a view outside the accessibility tree covers the app: the text on screen, not the tree's. */
export function coveredScreenLine(cover) {
  const texts = cover.texts.slice(0, MAX_TEXTS).map((t) => clip(t, 40));
  return `screen: covered by a view outside the app's accessibility tree (a system picker or permission sheet) | texts (read from the screenshot): ${texts.join(" / ")}`;
}

export function coveredControlsLine() {
  return 'controls: none usable, the tree describes the screen under the cover. Tap by the text on screen (act "tap <text>").';
}
