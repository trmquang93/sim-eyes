import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/** Below this, the chosen next action is not trusted and act stops. */
export const ACT_CONFIDENCE_MIN = 0.7;
/** At or above this, the instruction counts as fulfilled. */
export const ACT_DONE_MIN = 0.7;
export const ACT_DEFAULT_STEPS = 5;
export const ACT_MAX_STEPS = 10;

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
export function actOptions(targets, { text } = {}) {
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

/** What a step did, as TypeSafe sees it in `stepsTaken`. */
export function stepRecord(action, screenTitle) {
  const on = screenTitle ? { onScreen: screenTitle } : {};
  if (action.kind === "tap" && action.target.back) {
    return { action: "go back", to: action.target.label, ...on };
  }
  if (action.kind === "tap") return { action: "tap", control: action.target.label, ...on };
  if (action.kind === "type") {
    return { action: "fill field", control: action.target.label, text: action.text, submitted: false, ...on };
  }
  if (action.kind === "swipe") return { action: `swipe ${action.direction}`, ...on };
  return { action: action.key === "return" ? "press return (submits the field)" : "hide keyboard", ...on };
}

/** Stable text of what the screen offers, to spot an action repeated on an unchanged screen. */
export function screenSignature(targets) {
  return targets.map((t) => `${t.label}@${t.x},${t.y}`).join("|");
}

const EVIDENCE = [
  "`currentScreen.title` is the navigation title of the screen shown now, `currentScreen.backTo` is where its Back button leads, `currentScreen.alert` is an open alert (null when none), and `currentScreen.texts` are visible texts.",
  "`controls` lists every visible tappable control, top to bottom, with points inside `screen`. A destination missing from `controls` is off screen or on another screen.",
  "`stepsTaken` lists the actions already done, in order.",
];

export const DONE_QUESTION = {
  task: "An agent is driving an iOS app to carry out `instruction`. Decide whether `instruction` is already fulfilled on the screen shown now.",
  evidence: EVIDENCE,
  rules: [
    "An instruction to open or go to a page is fulfilled when `currentScreen.title` names that page, or the visible texts are that page's content.",
    "An instruction to search or submit text is fulfilled only after a \"fill field\" step is followed by a \"press return\" step in `stepsTaken`. A filled field that was not submitted is not fulfilled.",
    "A conditional instruction (for example, tap Allow if an alert appears) is fulfilled when its condition does not hold; for an alert, when `currentScreen.alert` is null.",
    "Otherwise it is not fulfilled.",
  ],
};

export const NEXT_QUESTION = {
  task: "An agent is driving an iOS app to carry out `instruction`, which is not fulfilled yet. Pick the single next action that moves the app toward it.",
  evidence: EVIDENCE,
  rules: [
    "If a visible control's label names the destination, or the screen on the way to it, tap that control.",
    "When no control in `controls` names the destination or a screen on the way to it, swipe up: a screen opens scrolled to its top, so rows that are not listed yet are below. Do not tap an unrelated control to look for it. Swipe down only after an earlier swipe up in `stepsTaken` on this screen went past it.",
    "If `textToType` is set and the instruction needs text in a field, fill that field. Focusing a field without filling it does not help.",
    "When the last step in `stepsTaken` is \"fill field\" and the instruction asks to search or submit, press return.",
    "Go back only when the destination cannot be reached from the current screen.",
    "Never repeat an action from `stepsTaken` that left the screen unchanged.",
    "Pick none when nothing visible or reachable by scrolling helps.",
  ],
};

/** The exact state TypeSafe sees; also used by eval-act.mjs. */
export function actState({ instruction, text, targets, history, screen, context }) {
  return {
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
      point: { x: t.x, y: t.y },
    })),
  };
}

/**
 * One judgment round: is the instruction already fulfilled, and if not, which single action is next.
 * Both questions go in one request; code uses `next` only when `done` is below ACT_DONE_MIN.
 */
export async function decideStep({ instruction, text, targets, history, client, screen, context }) {
  const { criteria, actions } = actOptions(targets, { text });
  const response = await client.systemOne({
    state: actState({ instruction, text, targets, history, screen, context }),
    questions: {
      done: noul(DONE_QUESTION, {
        true: "The instruction is fulfilled, or its condition does not apply to this screen.",
        false: "At least one more action is needed on this screen or a later one.",
      }),
      next: choice(NEXT_QUESTION, criteria),
    },
  });
  const next = response.answers.next;
  const [runnerUp] = Object.entries(next.probabilities)
    .filter(([label]) => label !== next.choice)
    .sort((a, b) => b[1] - a[1]);
  return {
    runnerUp: runnerUp ? { key: runnerUp[0], probability: runnerUp[1] } : null,
    doneProbability: response.answers.done.noul,
    key: next.choice,
    confidence: next.confidence,
    action: actions[next.choice] ?? null,
  };
}

export function typesafeClient() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "act needs TYPESAFE_API_KEY in the sim-eyes MCP env. Use tap, type, swipe or press with explicit targets instead."
    );
  }
  return new TypeSafeClient({ apiKey });
}
