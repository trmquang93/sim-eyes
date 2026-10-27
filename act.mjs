import { box, choice, image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { formatTree } from "./targets.mjs";

/** Below this, the chosen next action is not trusted and act stops. */
export const ACT_CONFIDENCE_MIN = 0.7;
/** After a tap that changed nothing (a disabled row), a tap on a different control needs only this much: the goal keeps trying. */
export const ACT_RETRY_MIN = 0.2;
/** A tap on a row read from the screenshot needs only this much when it clearly leads (see ACT_LEAD_RATIO): rows that look alike spread the confidence. */
export const ACT_LEAD_MIN = 0.5;
/** "Clearly leads": the runner-up has at most this share of the chosen action's confidence. */
export const ACT_LEAD_RATIO = 1 / 3;
/** At or above this, the instruction counts as fulfilled. */
export const ACT_DONE_MIN = 0.7;
/** At or above this, the final confirmation's "achieved" or "not achieved" is believed; below it the goal stays unconfirmed. */
export const ACT_CONFIRM_MIN = 0.7;
/** Box answers only on 1.14 (`jev-latest` is 1.13 until it moves); images are on 1.13 and up. */
export const BOX_MODEL = "jev-1.14.0";
/** The option that taps a control seen only in the screenshot: its point comes from a Box question, not from a listed control. */
export const SHOT_OPTION = "tap screenshot";
export const ACT_DEFAULT_STEPS = 5;
/** A goal that spans a whole stretch of a flow needs room: the loop stops early once the screen confirms it. */
export const ACT_MAX_STEPS = 25;

const SWIPES = ["up", "down", "left", "right"];
const SWIPE_MEANING = {
  up: "Swipe up: scroll down to reveal rows below the last listed control. The way to find a destination that is not among the listed controls",
  down: "Swipe down: scroll the list up to reveal controls above the first listed one",
  left: "Swipe left: page forward or reveal row actions",
  right: "Swipe right: page back",
};

function quoted(labels) {
  return labels.map((l) => `"${l}"`).join(" / ");
}

/** Controls at the same point are one tap, e.g. a cell and its own button. */
function tapGroups(targets) {
  const groups = new Map();
  for (const t of targets) {
    const key = `${t.x},${t.y}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()];
}

/**
 * Every action act may take on this screen, keyed by the label TypeSafe picks.
 * Text is never invented: a type option exists only when the caller passed text.
 */
export function actOptions(targets, { text, screenshot = false } = {}) {
  const criteria = {
    none: "Nothing on this screen or reachable by scrolling moves toward the instruction.",
  };
  const actions = {};
  for (const group of tapGroups(targets)) {
    const t = group[0];
    const labels = group.map((g) => g.label);
    const field = group.find((g) => g.editable);
    const back = group.find((g) => g.back);
    let meaning;
    if (back) meaning = `Go back to the "${back.label}" screen (Back button #${t.n})`;
    else if (field) meaning = `Focus field #${field.n} ${quoted([field.label])} without typing anything`;
    else meaning = `Tap #${t.n} ${quoted(labels)} at (${t.x}, ${t.y})`;
    criteria[`tap ${t.n}`] = meaning;
    actions[`tap ${t.n}`] = { kind: "tap", target: t };
    if (field && text) {
      criteria[`type ${field.n}`] = `Fill field #${field.n} ${quoted([field.label])} with \`textToType\``;
      actions[`type ${field.n}`] = { kind: "type", target: field, text };
    }
  }
  if (screenshot) {
    criteria[SHOT_OPTION] =
      "Tap a control that is visible in `screenshot` but missing from `controls` (an icon-only button such as a close X, a picker row, a view outside the app). Its position is read from the screenshot";
    actions[SHOT_OPTION] = { kind: "locate" };
  }
  for (const d of SWIPES) {
    criteria[`swipe ${d}`] = SWIPE_MEANING[d];
    actions[`swipe ${d}`] = { kind: "swipe", direction: d };
  }
  criteria["press return"] =
    "Press the keyboard return/search key to submit text that is already in a field";
  actions["press return"] = { kind: "press", key: "return" };
  criteria["press dismiss"] = "Hide the on-screen keyboard";
  actions["press dismiss"] = { kind: "press", key: "dismiss" };
  return { criteria, actions };
}

/**
 * Whether the chosen next action is trusted enough to run. A tap that left the screen unchanged is
 * not the end of a goal that has other candidates (the greyed-out rows of a file picker ignore taps).
 * Rows read from the screenshot (a picker outside the app's tree) show no disabled state and look alike,
 * which spreads the confidence: a tap on one that clearly leads needs only ACT_LEAD_MIN, and after an idle
 * tap on such a row a tap on another needs ACT_RETRY_MIN (the same control again is never trusted).
 * Accessibility controls keep the full bar: a disabled Continue that ignored a tap is a real stop.
 */
export function trustedAction(step, history = []) {
  if (!step.action) return false;
  const last = history[history.length - 1];
  const ocrTap = step.action.kind === "tap" && step.action.target.ocr;
  if (!ocrTap) return step.confidence >= ACT_CONFIDENCE_MIN;
  if (last?.action === "tap" && last.readFromScreenshot && last.effect?.screenChanged === false) {
    return step.action.target.label !== last.control && step.confidence >= ACT_RETRY_MIN;
  }
  const leads = !step.runnerUp || step.runnerUp.probability <= step.confidence * ACT_LEAD_RATIO;
  return step.confidence >= (leads ? ACT_LEAD_MIN : ACT_CONFIDENCE_MIN);
}

/** What a step did, as TypeSafe sees it in `stepsTaken`. `page` is the pager position it was taken on. */
export function stepRecord(action, screenTitle, page) {
  const on = { ...(screenTitle ? { onScreen: screenTitle } : {}), ...(page ? { onPage: page } : {}) };
  if (action.kind === "tap" && action.target.back) {
    return { action: "go back", to: action.target.label, ...on };
  }
  if (action.kind === "tap") return { action: "tap", control: action.target.label, ...(action.target.ocr || action.target.shot ? { readFromScreenshot: true } : {}), ...on };
  if (action.kind === "type") {
    return { action: "fill field", control: action.target.label, text: action.text, submitted: false, ...on };
  }
  if (action.kind === "swipe") return { action: `swipe ${action.direction}`, ...on };
  return { action: action.key === "return" ? "press return (submits the field)" : "hide keyboard", ...on };
}

/** Rows around a tapped control that count as "at the control" when comparing screenshots. */
export const EFFECT_BAND = 45;

/** What a tap did to the screen, from `screenDiff`. `near` is a change in the tapped control's rows. */
export function effectRecord(diff) {
  return { screenChanged: diff.changed !== 0, changedAtControl: diff.bandChanged !== 0 };
}

/** The last step's effect in words for the act result; empty when it was not measured. */
export function effectText(effect) {
  if (!effect) return "";
  if (!effect.screenChanged) return "left the screen unchanged, so it probably had no effect";
  const where = effect.changedAtControl
    ? "changed the screen at the tapped control"
    : "changed the screen elsewhere than the tapped control (navigation, a pager, a sheet)";
  return effect.nudged ? `${where} (the tap on its exact center did nothing; it took effect a few points off center)` : where;
}

/** Stable text of what the screen offers, to spot an action repeated on an unchanged screen. */
export function screenSignature(targets) {
  return targets.map((t) => `${t.label}@${t.x},${t.y}`).join("|");
}

const EVIDENCE = [
  "`currentScreen.title` is the navigation title of the screen shown now, `currentScreen.backTo` is where its Back button leads, `currentScreen.alert` is an open alert (null when none), `currentScreen.page` (when present) is the position of a pager such as \"Page 2 of 3\", and `currentScreen.texts` are visible texts.",
  "`controls` lists every visible tappable control, top to bottom, with points inside `screen`. A destination missing from `controls` is off screen or on another screen.",
  "`hierarchy` (when present) is the accessibility tree of the screen, one element per line, indented under its parent, with its frame (x, y, width x height). A control from `controls` is tagged <tap n>; one hidden under another view is tagged [covered by another view] or [covered by popup \"name\"] and cannot be tapped. It shows which screen, dialog or list each control belongs to.",
  "`stepsTaken` lists the actions already done, in order, each with the `onPage` it was taken on when the screen is a pager. A tap's `effect` compares the screen before and after it: `screenChanged` is whether any pixels changed, `changedAtControl` whether they changed in the rows of the tapped control.",
];

export const DONE_QUESTION = {
  task: "An agent is driving an iOS app to carry out `instruction`. Decide whether `instruction` is already fulfilled on the screen shown now.",
  evidence: EVIDENCE,
  rules: [
    "An instruction to open or go to a page is fulfilled when `currentScreen.title` names that page, or the visible texts are that page's content.",
    "An instruction to go to the next page or step of a pager (intro, onboarding, tutorial) is fulfilled as soon as `currentScreen.page` is later than the `onPage` of the first step in `stepsTaken`, however many steps that took. It is not fulfilled while no step was taken.",
    "An instruction to close or dismiss an ad, popup or dialog is fulfilled when the last step in `stepsTaken` tapped its Close, Dismiss or X control and its `effect.screenChanged` is true: the screen after the tap is a different screen, so another ad, popup or Close/Dismiss control on it belongs to that screen and is not the one that was closed. It is not fulfilled when no such step was taken, or when it changed nothing.",
    "An instruction to search or submit text is fulfilled only after a \"fill field\" step is followed by a \"press return\" step in `stepsTaken`. A filled field that was not submitted is not fulfilled.",
    "A conditional instruction (for example, tap Allow if an alert appears) is fulfilled when its condition does not hold; for an alert or consent web dialog, when `currentScreen.alert` is null. A non-null `currentScreen.alert` means a dialog is covering the app.",
    "An instruction to select, choose, check or toggle an item is fulfilled when the last step in `stepsTaken` tapped that item and its `effect` shows `changedAtControl` true: a checkmark, highlight or switch that cannot be read from the controls shows up as a change at the control. It is not fulfilled when `effect.screenChanged` is false.",
    "Otherwise it is not fulfilled.",
  ],
};

export const CONFIRM_QUESTION = {
  task: "An agent drove an iOS app to carry out `instruction` and stopped acting. Read the screen as described in `currentScreen`, `controls` and `hierarchy`, and judge whether `instruction` was achieved.",
  evidence: EVIDENCE,
  rules: [
    "Judge the end state `instruction` names, not whether steps were taken: taking steps in `stepsTaken` does not by itself achieve it.",
    "\"achieved\": the screen shows the end state the instruction names (its title, texts or controls), or a last step in `stepsTaken` that tapped the item the instruction names has an `effect` that shows the change (a checkmark or switch that cannot be read from the controls shows up as `changedAtControl` true).",
    "\"not achieved\": the screen shows something other than the end state. For example the instruction names a destination, the last page of a pager or a finished flow, and the screen is an earlier page (`currentScreen.page` is before the last one), still shows the first screen of the flow, or a dialog (`currentScreen.alert`) is covering the app.",
    "\"cannot tell\": the end state is the kind of change the controls and texts never show (a checkmark, a switch) and no step in `stepsTaken` has an `effect` that settles it.",
    "Prefer \"not achieved\" over \"cannot tell\" whenever the screen visibly differs from the end state.",
  ],
};

export const NEXT_QUESTION = {
  task: "An agent is driving an iOS app to carry out `instruction`, which is not fulfilled yet. Pick the single next action that moves the app toward it.",
  evidence: EVIDENCE,
  rules: [
    "If a visible control's label names the destination, or the screen on the way to it, tap that control.",
    "If the control the instruction needs is itself tagged [covered by popup \"name\"] in `hierarchy`, first tap that popup's Dismiss or Close control. A control tagged [not listed] is disabled or unavailable, and dismissing a popup does not help it.",
    "A goal with several parts (\"enter Select mode and select the file\") is done in order: pick the action for the first part that is not done yet. A mode or action the list does not show (Select, Sort, View as, Filter) usually lives in an options or overflow control (a label such as \"View and filter options\", \"More\", \"Options\", \"Menu\", \"Actions\", \"Filter\"): tap that control first (this is for an action or mode, not for a screen to open: a screen that is not listed is further down, so swipe up). A control whose label names the destination still wins over a menu.",
    "To select a file in a file picker (the Files app browser: a grid or list of items with a date and a size under each name), tap the name of a file row. A file shows a size (KB, MB) and a date under its name, so a control whose text includes a size such as \"104KB\" is a file; a folder shows \"N items\". A file type named in the instruction (pdf) does not have to appear in a name. When the names do not show which file has the type, tap the first file row: a row the picker greys out because the app does not accept its type ignores the tap. A file row in `stepsTaken` whose tap left the screen unchanged is such a disabled row, not a dead end: tap the next file row after it (left to right, top to bottom), and keep going until a tap changes the screen. Tap a file before opening a folder, and never Search, Cancel, the close X or the Recents / Shared / Browse tabs. Only when no file is listed, open a folder or swipe up.",
    "When no control in `controls` names the destination or a screen on the way to it, swipe up: a screen opens scrolled to its top, so rows that are not listed yet are below. Do not tap an unrelated control to look for it. Swipe down only after an earlier swipe up in `stepsTaken` on this screen went past it.",
    "If `textToType` is set and the instruction needs text in a field, fill that field. Focusing a field without filling it does not help.",
    "When the last step in `stepsTaken` is \"fill field\" and the instruction asks to search or submit, press return.",
    "Go back only when the destination cannot be reached from the current screen.",
    "Never repeat an action from `stepsTaken` that left the screen unchanged, including a tap whose `effect.screenChanged` is false. Tapping a different control is not repeating it.",
    "Pick none when nothing visible or reachable by scrolling helps.",
  ],
};

/** Evidence added when the request carries the screen as an image. */
const SHOT_EVIDENCE =
  "`screenshot` is the screen shown now as an image, the same screen `controls` and `hierarchy` describe. Take exact labels and `tap` numbers from `controls`. A control that is visible in `screenshot` but missing from `controls` can be tapped with the screenshot option.";
const withShot = (question, shot) => (shot ? { ...question, evidence: [...question.evidence, SHOT_EVIDENCE] } : question);

/** The exact state TypeSafe sees; also used by eval-act.mjs. `shot` is the screenshot's PNG bytes, sent as an image. */
export function actState({ instruction, text, targets, history, screen, context, nodes, shot }) {
  return {
    ...(shot ? { screenshot: image(shot) } : {}),
    ...(nodes?.length ? { hierarchy: formatTree(nodes, targets, { tag: (n) => ` <tap ${n}>` }).split("\n") } : {}),
    instruction,
    textToType: text ?? null,
    stepsTaken: history,
    currentScreen: context ?? null,
    screen: screen ?? null,
    controls: targets.map((t) => ({
      n: t.n,
      label: t.label,
      ...(t.placeholder ? { placeholder: t.placeholder } : {}),
      ...(t.value ? { value: t.value } : {}),
      ...(t.editable ? { editable: true } : {}),
      ...(t.back ? { back: true } : {}),
      ...(t.ocr ? { textReadFromScreenshot: true } : {}),
      point: { x: t.x, y: t.y },
    })),
  };
}

/**
 * One judgment round: is the instruction already fulfilled, and if not, which single action is next.
 * Both questions go in one request; code uses `next` only when `done` is below ACT_DONE_MIN.
 */
export async function decideStep({ instruction, text, targets, history, client, screen, context, nodes, shot }) {
  const { criteria, actions } = actOptions(targets, { text, screenshot: Boolean(shot) });
  const response = await client.systemOne({
    state: actState({ instruction, text, targets, history, screen, context, nodes, shot }),
    questions: {
      done: noul(withShot(DONE_QUESTION, shot), {
        true: "The instruction is fulfilled, or its condition does not apply to this screen.",
        false: "At least one more action is needed on this screen or a later one.",
      }),
      next: choice(withShot(NEXT_QUESTION, shot), criteria),
    },
  });
  const next = response.answers.next;
  const [runnerUp] = Object.entries(next.probabilities)
    .filter(([label]) => label !== next.choice)
    .sort((a, b) => b[1] - a[1]);
  const step = {
    runnerUp: runnerUp ? { key: runnerUp[0], probability: runnerUp[1] } : null,
    doneProbability: response.answers.done.noul,
    key: next.choice,
    confidence: next.confidence,
    action: actions[next.choice] ?? null,
  };
  // The control is not listed: a second request finds it in the screenshot. A point it is not sure of is no action.
  if (step.action?.kind === "locate" && step.doneProbability < ACT_DONE_MIN) {
    const found = await locateOnScreenshot({ instruction, history, shot, screen, client });
    step.action = found.target ? { kind: "tap", target: found.target } : null;
    step.confidence = Math.min(step.confidence, found.confidence);
  }
  return step;
}

/**
 * Where on the screenshot to tap next for `instruction`: a Box question (1.14 only) plus a presence question,
 * because a Box always returns four edges even when nothing matches. The point is the box's centre in screen points
 * (screenshots are 1x). `target` is null when the control is not there at ACT_CONFIDENCE_MIN.
 */
export async function locateOnScreenshot({ instruction, history, shot, screen, client }) {
  const response = await client.systemOne({
    model: BOX_MODEL,
    state: { instruction, stepsTaken: history, screenshot: image(shot) },
    questions: {
      present: noul("Is there a control visible in `screenshot` that the agent should tap next to carry out `instruction`?"),
      where: box("The control in `screenshot` that the agent should tap next to carry out `instruction`"),
    },
  });
  const { present, where } = response.answers;
  const confidence = Math.min(present.noul, where.confidence ?? present.noul);
  if (confidence < ACT_CONFIDENCE_MIN) return { target: null, confidence };
  const { top, bottom, left, right } = where.box;
  const x = Math.round(((left + right) / 2) * screen.width);
  const y = Math.round(((top + bottom) / 2) * screen.height);
  return { target: { n: 0, label: `point (${x}, ${y})`, x, y, exact: true, shot: true }, confidence };
}

/** Screenshots go to TypeSafe only on a direct key: the hub relay forwards JSON only, and images are multipart. */
export const screenshotsOn = (env = process.env) => !env.TYPESAFE_BASE_URL;

export function typesafeClient() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "goal needs TYPESAFE_API_KEY in the sim-eyes MCP env. Every other step (tap, tap_at, back, scroll, swipe, type, key, drag, long_press, wait, look) runs without it."
    );
  }
  // Images are opt-in on the API: every request that carries one needs this header.
  return new TypeSafeClient({ apiKey, defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" } });
}

export const CONFIRM_CRITERIA = {
  achieved: "The screen shows the end state the instruction names.",
  "not achieved": "The screen shows something other than the end state the instruction names.",
  "cannot tell": "The end state is a change the controls and texts of this screen never show.",
};

/**
 * The last word on a goal that ran out of steps or of confidence: the screen is described to TypeSafe (the same state
 * `decideStep` sees) and it says whether the instruction was achieved. A verdict below ACT_CONFIRM_MIN is "cannot tell".
 */
export async function confirmGoal({ instruction, text, targets, history, client, screen, context, nodes, shot }) {
  const response = await client.systemOne({
    state: actState({ instruction, text, targets, history, screen, context, nodes, shot }),
    questions: { verdict: choice(withShot(CONFIRM_QUESTION, shot), CONFIRM_CRITERIA) },
  });
  const { choice: verdict, confidence } = response.answers.verdict;
  const believed = confidence >= ACT_CONFIRM_MIN && verdict in CONFIRM_CRITERIA;
  return { verdict: believed ? verdict : "cannot tell", confidence };
}
