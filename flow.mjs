/**
 * The pieces of the autonomous `run` step that code decides (no model): which field to fill next, when to hide the
 * keyboard, which controls a screen already used, and when the run is stuck. TypeSafe only picks among the options
 * that are left (see server.mjs `runFlow`).
 */
import { fieldValue } from "./act.mjs";

/** A decision that fails this many times in a row, or a screen seen this many times, ends the run as stuck. */
export const MAX_BAD_DECISIONS = 3;
export const MAX_VISITS = 3;

/** What the model is told on top of the user's task: a screen-by-screen policy, so a compound task never needs splitting by hand. */
export const FLOW_POLICY =
  "Work one screen at a time. Fields are filled by code; do not pick them. When the screen lists options and none is marked selected, choose one that fits the task (when the task does not say which, any typical choice will do); then tap the screen's primary forward button (Continue, Next, Start, Save...). Pick none when the screen has nothing left to do for the task.";

export const flowInstruction = (task) => `${String(task).trim()}\n\n${FLOW_POLICY}`;

/**
 * A field and the text for it: the first editable field (top to bottom) that needs text and has an entry. `values` is
 * an object (by label or placeholder) or a list (entries in field order, each used once). `skip(field)` is true for a
 * field the run already tried. Null when nothing is left to fill.
 */
export function nextFill(targets, values, { used = new Set(), skip = () => false } = {}) {
  if (!values) return null;
  const fields = targets.filter((t) => t.editable).sort((a, b) => a.y - b.y);
  // A field's text is its value, or its label when the platform shows the text there (Android).
  const textOf = (f) => String(f.value || f.label || "");
  const same = (a, b) => {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
  };
  if (Array.isArray(values)) {
    const listed = values.map(String);
    const pending = listed.filter((v) => !used.has(v) && !fields.some((f) => same(textOf(f), v)));
    if (pending.length === 0) return null;
    // The topmost field that holds none of the entries takes the next one.
    const field = fields.find((f) => !skip(f) && !listed.some((v) => same(textOf(f), v)));
    return field ? { field, text: pending[0] } : null;
  }
  for (const field of fields) {
    if (skip(field)) continue;
    const text = fieldValue(field, values);
    if (text != null && !same(textOf(field), text)) return { field, text };
  }
  return null;
}

/** The keyboard covers the screen and no field is waiting for text: hide it before reading the controls under it. */
export const shouldDismissKeyboard = ({ keyboard, pendingFill }) => keyboard && !pendingFill;

/** A control's identity on one screen, so it is not tapped twice there (a default-selected option, a button that did nothing). */
export const controlKey = (screenSig, target) => `${screenSig}#${target.label}@${target.x},${target.y}`;

/** Tracks what the run did on each screen and says when it is stuck. */
export function flowTracker() {
  const visits = new Map();
  const used = new Set();
  let bad = 0;
  return {
    /** A screen was read again; returns how many times it has been seen. */
    visit(sig) {
      visits.set(sig, (visits.get(sig) ?? 0) + 1);
      return visits.get(sig);
    },
    use: (key) => used.add(key),
    unuse: (key) => used.delete(key),
    /** The screen looks the same but is a new page (the next question of a quiz): its controls are free again. */
    resetScreen(sig) {
      for (const k of [...used]) if (k.startsWith(`${sig}#`)) used.delete(k);
      visits.set(sig, 0);
    },
    used: (key) => used.has(key),
    /** A decision that gave no usable action; true once the run should stop. */
    badDecision() {
      bad += 1;
      return bad >= MAX_BAD_DECISIONS;
    },
    goodDecision() {
      bad = 0;
    },
    looping: (sig) => (visits.get(sig) ?? 0) >= MAX_VISITS,
  };
}

/** A target list without the controls this screen already used and without fields (code fills those). */
export const optionsLeft = (targets, screenSig, tracker) => targets.filter((t) => !t.editable && !tracker.used(controlKey(screenSig, t)));

/** One line for a screen: its title or first texts, then what was done there. */
export function screenReport(index, context, actions) {
  const name = context?.title || (context?.texts ?? []).slice(0, 2).join(" / ") || "screen";
  return `${index}. ${name.length > 70 ? `${name.slice(0, 69)}…` : name}: ${actions.length ? actions.join(", ") : "nothing to do"}`;
}

/** Whether `until` (text that proves the run is done) is on this screen. Case aside, in a text, a label or the title. */
export function untilReached(until, context, targets) {
  if (!until) return false;
  const wants = String(until).split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const pool = [context?.title, ...(context?.texts ?? []), ...targets.map((t) => t.label)].filter(Boolean).map((s) => String(s).toLowerCase());
  return wants.some((want) => pool.some((s) => s.includes(want)));
}

/**
 * The controls that are alternatives of one choice (gender buttons in a row, the rows of a list): same row, or
 * stacked with the smallest gap between them. Picking one settles the whole group.
 */
export function choiceGroup(options, picked) {
  const sorted = [...options].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const t of sorted) {
    const last = rows.at(-1);
    if (last && Math.abs(last[0].y - t.y) <= 6) last.push(t);
    else rows.push([t]);
  }
  const gaps = rows.slice(1).map((r, i) => r[0].y - rows[i][0].y).filter((g) => g > 0);
  const step = gaps.length ? Math.min(...gaps) : 0;
  const groups = [];
  for (const [i, row] of rows.entries()) {
    const prev = groups.at(-1);
    const gap = i > 0 ? row[0].y - rows[i - 1][0].y : Infinity;
    if (prev && gap <= step * 1.3) prev.push(...row);
    else groups.push([...row]);
  }
  return groups.find((g) => g.includes(picked)) ?? [picked];
}

/** A forward button sits in the bottom fifth of the screen (Continue, Next, Start): tapping it settles no group. */
export const FORWARD_LABEL = /^(continue|next|start|done|save|go to home|see result|submit|finish|tiếp|bắt đầu|xem kết quả|vào home|xong|lưu)/i;
export const isForward = (target, screen) => !!screen && (target.y > screen.height * 0.88 || (target.y > screen.height * 0.8 && FORWARD_LABEL.test(String(target.label).trim())));

/** Words in the task that ask to move on after the choices (continue, next, walk the flow...). */
export const wantsForward = (task) => /\b(continue|next|proceed|submit|finish|walk|through|onboarding|complete|flow|go on|start|begin|save)\b|tiếp|bắt đầu|xong/i.test(String(task));

/**
 * What to tap when the model cannot tell options apart (rows of a quiz scale, a list where the task names nothing): the
 * middle option of the first group of alternatives, else the forward button. Null when there is nothing to tap.
 */
export function typicalChoice(options, screen) {
  const choices = options.filter((t) => !isForward(t, screen));
  if (choices.length) {
    const group = choiceGroup(choices, choices.sort((a, b) => a.y - b.y || a.x - b.x)[0]);
    return group[Math.floor((group.length - 1) / 2)];
  }
  return options.find((t) => isForward(t, screen)) ?? null;
}

/** A Back control without BackButton's identifier (Android): a top-left control labelled like Back, or the arrow in the corner. */
export const isBackLike = (t) => /^(back|quay lại|←|‹|<)$/i.test(String(t.label).trim()) || (t.y < 110 && t.x < 90);

const norm = (s) => String(s).toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();

/** The options the task names (a label of three or more characters that appears in the task text), in screen order. Code taps these directly. */
export function namedOptions(task, options) {
  const text = norm(task);
  return options
    .filter((t) => {
      const label = norm(t.label);
      return label.length >= 3 && text.includes(label);
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * How many of the caller's `values` are still to be typed: entries not typed yet and not held by any field on screen.
 * The run is not done while this is above zero (a field slid under the keyboard, Continue stayed disabled).
 */
export function valuesPending(values, usedTexts, targets) {
  if (!values) return 0;
  const held = targets.filter((t) => t.editable).map((t) => norm(t.value || t.label));
  const entries = Array.isArray(values) ? values.map(String) : Object.values(values).map(String);
  return entries.filter((v) => !usedTexts.has(v) && !held.some((h) => h && (h === norm(v) || h.startsWith(norm(v))))).length;
}

/** Whether the screen has choices to make (unused options that are not forward or back buttons) and none was made on this page yet. */
export const needsChoice = (choices, choiceMade) => choices.length > 0 && !choiceMade;

/** The package of an Android focus line such as "mCurrentFocus=Window{... u0 com.x/com.x.MainActivity}"; null when none. */
export function focusPackage(line) {
  return /\s([A-Za-z][\w.]*)\/[\w.$]+\}?/.exec(String(line))?.[1] ?? null;
}
