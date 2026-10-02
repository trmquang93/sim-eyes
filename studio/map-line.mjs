/**
 * Lines that are not a fixed phrase (phrases.mjs) go to TypeSafe, which only SELECTS: the kind of step from a fixed list,
 * and for labels and text a span of the tester's own line that code cut out. Nothing is generated. Below MAP_MIN the line
 * becomes a goal whose end state is the line itself.
 */
import { choice } from "@typesafe-ai/sdk";
import { ACT_CONFIDENCE_MIN, typesafeClient } from "../act.mjs";
import { isComment, parsePhrase } from "./phrases.mjs";

/** Same bar as the `goal` step's own judgments. */
export const MAP_MIN = ACT_CONFIDENCE_MIN;
export const GOAL_MAX_STEPS = 12;
const MAX_SPANS = 60;
const MAX_WORDS = 5;
const MAX_TIMES = 10;
const DIRECTIONS = ["down", "up", "left", "right"];

// A span does not start with one of these (so "on Wi-Fi" is not offered next to "Wi-Fi")...
const LEADING = new Set(["a", "an", "the", "to", "on", "in", "into", "of", "for", "my", "and", "then", "at", "with", "from"]);
// ...or end with an article or a word for a kind of control: the tester's "Wi-Fi row" is the control "Wi-Fi".
const TRAILING = new Set(["a", "an", "the", "button", "tab", "icon", "row", "field", "box", "link", "switch", "toggle", "cell"]);
const edgePunctuation = /^[\s"“”'‘’.,;:!?()[\]]+|[\s"“”'‘’.,;:!?()[\]]+$/g;
const clean = (s) => s.replace(edgePunctuation, "");

/** The parts of a line a label or text can be: quoted parts first, then word n-grams (shortest first), each exactly as written. */
export function lineSpans(line) {
  const spans = [];
  const add = (s) => {
    const span = clean(s);
    if (span && !spans.includes(span)) spans.push(span);
  };
  // What the tester quoted is the name they mean, whatever words it holds.
  for (const m of line.matchAll(/["“]([^"”]+)["”]/g)) add(m[1]);
  const words = line.split(/\s+/).map(clean).filter(Boolean);
  for (let n = 1; n <= MAX_WORDS; n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const first = words[i].toLowerCase();
      const last = words[i + n - 1].toLowerCase();
      if (LEADING.has(first) || TRAILING.has(last)) continue;
      add(words.slice(i, i + n).join(" "));
    }
  }
  return spans.slice(0, MAX_SPANS);
}

const KINDS = {
  tap: "Tap one control, tab, row or piece of text that the line names",
  type: "Type some text into a field",
  back: "Go back to the previous screen",
  scroll: "Scroll the screen in one direction",
  checkpoint: "Only look at the screen to check that something is true; nothing is done",
  goal: "Anything else: an outcome to reach, or several actions in one line (open a page, create, delete, search, sign in, choose an item)",
};

const EVIDENCE = [
  "`line` is one sentence a tester wrote as a step of a test case for an iOS app.",
  "`spans` are the parts of the line that can be a label or a text, exactly as the tester wrote them.",
];

const KIND_QUESTION = {
  task: "Decide which kind of step the `line` asks for.",
  evidence: EVIDENCE,
  rules: [
    "A line that asks for exactly one tap on a named control is tap. Press, hit, touch, select, choose and pick followed by one name are all tap.",
    "A line that asks to enter given text in a field, without anything else, is type. Enter, fill, input and write with a text are all type.",
    "A line that asks to confirm, see, check or find that something is on the screen is checkpoint.",
    "A line with several actions, or one that names an outcome rather than a control (open a page, create a folder, delete a file, search for something), is goal.",
  ],
};

const SPAN_QUESTION = (task) => ({
  task,
  evidence: EVIDENCE,
  rules: [
    "Pick the span that is exactly the name, as written, and leave out words such as button, tab, icon, link, field, screen and page.",
    "Pick none when the line has no such name.",
  ],
});

const TEXT_QUESTION = {
  task: "Pick the span of the `line` that is the text to type into a field.",
  evidence: EVIDENCE,
  rules: [
    "Text to type is what the line asks to enter, write, fill in, search for, call or rename to.",
    "Pick none when the line does not ask to type anything: the name of a control to tap, a page to open or an item to delete is not text to type.",
  ],
};

const DIRECTION_QUESTION = {
  task: "Pick the direction the `line` asks to scroll in. down shows what is below; up shows what is above.",
  evidence: EVIDENCE,
  rules: ["Pick none when the line does not say a direction."],
};

const spanCriteria = (spans, what) => ({
  ...Object.fromEntries(spans.map((s) => [s, `The ${what} is "${s}"`])),
  none: `The line has no ${what}`,
});

const timesIn = (line) => {
  const n = Number(/\b(\d+)\b/.exec(line)?.[1]);
  return n >= 1 && n <= MAX_TIMES ? n : null;
};

const goalStep = (line, text) => ({ tool: "goal", goal: line, ...(text ? { text } : {}), max_steps: GOAL_MAX_STEPS });

/** One line to `{ step, how, confidence?, expected? }`. `client` is a TypeSafe client (`systemOne`). */
export async function mapLine(line, { client }) {
  const spans = lineSpans(line);
  const response = await client.systemOne({
    state: { line, spans },
    questions: {
      kind: choice(KIND_QUESTION, KINDS),
      target: choice(SPAN_QUESTION("Pick the span that is the label of the control to tap, or of the field to type into."), spanCriteria(spans, "label")),
      text: choice(TEXT_QUESTION, spanCriteria(spans, "text")),
      direction: choice(DIRECTION_QUESTION, { ...Object.fromEntries(DIRECTIONS.map((d) => [d, `Scroll ${d}`])), none: "No direction is given" }),
    },
  });
  const { kind, target, text, direction } = response.answers;
  // A span counts only when it is confident and really is a part of the line: a label is never generated.
  const span = (answer) => (answer.confidence >= MAP_MIN && answer.choice !== "none" && spans.includes(answer.choice) ? answer.choice : null);
  const textSpan = span(text);
  const fallback = () => ({ step: goalStep(line, textSpan), how: "goal-fallback", confidence: kind.confidence });
  const typesafe = (step, confidence = kind.confidence, extra = {}) => ({ step, how: "typesafe", confidence: Math.min(kind.confidence, confidence), ...extra });

  if (kind.confidence < MAP_MIN) return fallback();
  switch (kind.choice) {
    case "tap": {
      const label = span(target);
      return label ? typesafe({ tool: "tap", label }, target.confidence) : fallback();
    }
    case "type": {
      if (!textSpan) return fallback();
      const into = span(target);
      return typesafe({ tool: "type", text: textSpan, ...(into && into !== textSpan ? { into } : {}) }, text.confidence);
    }
    case "back":
      return typesafe({ tool: "back" });
    case "scroll": {
      const way = direction.confidence >= MAP_MIN && DIRECTIONS.includes(direction.choice) ? direction.choice : null;
      return way ? typesafe({ tool: "scroll", direction: way, ...(timesIn(line) ? { times: timesIn(line) } : {}) }, direction.confidence) : fallback();
    }
    case "checkpoint":
      return typesafe({ tool: "look" }, kind.confidence, { expected: line });
    default:
      return typesafe(goalStep(line, textSpan));
  }
}

/**
 * The lines of a test from what the tester wrote. A line whose text is unchanged since the last save keeps its stored
 * mapping, so a save never calls TypeSafe for it and a run replays what the tester saw. A line that could not be mapped
 * before (no key, TypeSafe down) is tried again. `client` is null without TYPESAFE_API_KEY: free lines become goals.
 */
export async function mapLines(texts, previous = [], { client }) {
  const kept = new Map(previous.filter((l) => !l.warning).map((l) => [l.text, l]));
  return Promise.all(
    texts.map(async (text) => {
      if (isComment(text)) return { text, step: null, how: "comment" };
      const stored = kept.get(text);
      if (stored) return stored;
      const phrase = parsePhrase(text);
      if (phrase) return { text, ...phrase, how: "phrase" };
      if (!client) return { text, step: goalStep(text), how: "goal-fallback", warning: "needs TYPESAFE_API_KEY to read this line; it will run as a goal" };
      try {
        return { text, ...(await mapLine(text, { client })) };
      } catch (err) {
        return { text, step: goalStep(text), how: "goal-fallback", warning: `TypeSafe failed (${err.message}); it will run as a goal` };
      }
    })
  );
}

/** The client Studio uses: TypeSafe with the key from the environment, or null without one. */
export const studioClient = () => (process.env.TYPESAFE_API_KEY ? typesafeClient() : null);
