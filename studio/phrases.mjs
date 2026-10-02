/**
 * The fixed phrases a tester can write. Code maps these to a batch step with no model call; every other line goes to
 * map-line.mjs. Quotes are "..." or “...”.
 */
const Q = String.raw`["“]([^"”]+)["”]`;
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const DIRECTION = "down|up|left|right";
const MAX_TIMES = 10;
const MAX_WAIT_SECONDS = 10;

const ordinal = (word) => ORDINALS[word.toLowerCase()] ?? Number.parseInt(word, 10);
const trimEnd = (line) => line.trim().replace(/[.!\s]+$/, "");

// A pattern's `make` gets the match and returns { step, expected? }, or null when the numbers are out of range.
const PHRASES = [
  { re: /^(?:tap|click)(?: on)? at (-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/i, make: (m) => ({ step: { tool: "tap_at", x: Number(m[1]), y: Number(m[2]) } }) },
  {
    re: new RegExp(String.raw`^(?:tap|click|press)(?: on)?(?: the (\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth))? ${Q}$`, "i"),
    make: (m) => ({ step: { tool: "tap", label: m[2], ...(m[1] ? { nth: ordinal(m[1]) } : {}) } }),
  },
  {
    re: new RegExp(String.raw`^(?:type|enter) ${Q}(?: (?:into|in) ${Q})?( and (?:press|hit) (?:return|enter))?$`, "i"),
    make: (m) => ({ step: { tool: "type", text: m[1], ...(m[2] ? { into: m[2] } : {}), ...(m[3] ? { submit: true } : {}) } }),
  },
  {
    re: new RegExp(String.raw`^scroll (${DIRECTION})(?: (\d+) times?)?$`, "i"),
    make: (m) => {
      const times = m[2] == null ? null : Number(m[2]);
      if (times != null && (times < 1 || times > MAX_TIMES)) return null;
      return { step: { tool: "scroll", direction: m[1].toLowerCase(), ...(times ? { times } : {}) } };
    },
  },
  { re: /^go back$/i, make: () => ({ step: { tool: "back" } }) },
  {
    re: /^wait (?:for )?(\d+(?:\.\d+)?) seconds?$/i,
    make: (m) => {
      const seconds = Number(m[1]);
      return seconds > 0 && seconds <= MAX_WAIT_SECONDS ? { step: { tool: "wait", ms: Math.round(seconds * 1000) } } : null;
    },
  },
  { re: /^(?:press|hit) (?:return|enter)$/i, make: () => ({ step: { tool: "key", key: "return" } }) },
  { re: /^(?:hide|dismiss|close) the keyboard$/i, make: () => ({ step: { tool: "key", key: "dismiss" } }) },
  { re: new RegExp(String.raw`^long[ -]?press ${Q}$`, "i"), make: (m) => ({ step: { tool: "long_press", label: m[1] } }) },
  { re: new RegExp(String.raw`^drag ${Q} to ${Q}$`, "i"), make: (m) => ({ step: { tool: "drag", from: m[1], to: m[2] } }) },
  { re: /^open the app$/i, make: () => ({ step: { tool: "open" } }) },
  { re: /^(?:restart|relaunch) the app$/i, make: () => ({ step: { tool: "open", relaunch: true } }) },
  { re: /^open the app fresh$/i, make: () => ({ step: { tool: "open", reset: true } }) },
];

const CHECK = /^(?:check|verify|expect|make sure)(?: that)?\s+(\S.*)$/i;

/** A blank line or one starting with `#` is a note for the tester, not a step. */
export const isComment = (line) => !line.trim() || line.trim().startsWith("#");

/** `{ step, expected? }` for a line that is a fixed phrase, `null` for anything else. */
export function parsePhrase(line) {
  const text = trimEnd(line);
  const check = CHECK.exec(text);
  if (check) return { step: { tool: "look" }, expected: check[1] };
  for (const { re, make } of PHRASES) {
    const m = re.exec(text);
    if (m) return make(m);
  }
  return null;
}
