/**
 * The fixed phrases a tester can write, in English and Vietnamese. Code maps these to a batch step with no model call;
 * every other line goes to map-line.mjs. Quotes are "..." or “...”, and 'x' or ‘x’ when the quote opens a word (so an
 * apostrophe inside a label is not a quote). Vietnamese verbs match with or without their diacritics ("cham" = "chạm").
 */
const Q = String.raw`["“]([^"”]+)["”]`;
const SINGLE_QUOTED = /(^|[\s(\[])['‘]([^'’\n]+?)['’](?=$|[\s.,;:!?)\]])/gu;
const unifyQuotes = (text) => text.replace(SINGLE_QUOTED, '$1"$2"');
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");
/** A regex source for a Vietnamese phrase in which every accented letter also matches its plain form and spaces match any run. */
const vi = (phrase) =>
  [...phrase.normalize("NFC")]
    .map((ch) => (ch === " " ? String.raw`\s+` : fold(ch) === ch ? ch : `[${ch}${fold(ch)}]`))
    .join("");
const viAny = (...phrases) => `(?:${phrases.map(vi).join("|")})`;
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const DIRECTION = "down|up|left|right";
const VI_DIRECTIONS = { xuống: "down", lên: "up", trái: "left", phải: "right" };
const VI_DIRECTION = `(${Object.keys(VI_DIRECTIONS).map(vi).join("|")})`;
const viDirection = (word) => VI_DIRECTIONS[word.normalize("NFC").toLowerCase()] ?? VI_DIRECTIONS[Object.keys(VI_DIRECTIONS).find((k) => fold(k) === fold(word.toLowerCase()))];
const OPPOSITE = { down: "up", up: "down", left: "right", right: "left" };
const MAX_TIMES = 10;
const MAX_WAIT_SECONDS = 10;

const ordinal = (word) => ORDINALS[word.toLowerCase()] ?? Number.parseInt(word, 10);
const trimEnd = (line) => line.trim().replace(/[.!\s]+$/, "");

/** Zoom in by `factor` (default 2), or out by 1/factor. A factor the step cannot do goes to the model. */
function pinchPhrase(zoomIn, factor) {
  const n = factor == null ? 2 : Number(String(factor).replace(",", "."));
  if (!(n > 1 && n <= 5)) return null;
  return { step: { tool: "pinch", scale: zoomIn ? n : Math.round((1 / n) * 100) / 100 } };
}

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
  // Zoom (a two-finger pinch). "N times" is the factor; none = 2.
  { re: /^(?:zoom|pinch) (in|out|open|close)(?: (\d+(?:\.\d+)?) times?)?$/i, make: (m) => pinchPhrase(/^(in|open)$/i.test(m[1]), m[2]) },
  { re: new RegExp(String.raw`^${viAny("phóng to", "phóng lớn", "zoom in")}(?: (\d+(?:[.,]\d+)?) ${vi("lần")})?$`, "iu"), make: (m) => pinchPhrase(true, m[1]) },
  { re: new RegExp(String.raw`^${viAny("thu nhỏ", "zoom out")}(?: (\d+(?:[.,]\d+)?) ${vi("lần")})?$`, "iu"), make: (m) => pinchPhrase(false, m[1]) },
  { re: /^open the app fresh$/i, make: () => ({ step: { tool: "open", reset: true } }) },
  // Vietnamese
  { re: new RegExp(String.raw`^${viAny("chạm", "nhấn", "bấm", "nhấp")}(?: ${vi("tại")}| ${vi("vào")} ${vi("tọa độ")}) (-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$`, "iu"), make: (m) => ({ step: { tool: "tap_at", x: Number(m[1]), y: Number(m[2]) } }) },
  {
    re: new RegExp(String.raw`^${viAny("chạm", "nhấn", "bấm", "nhấp", "chọn")}(?:\s+${vi("vào")})?(?:\s+${viAny("ô", "mục", "nút", "phần tử")})?(?:\s+${vi("thứ")}\s+(\d+))?\s+${Q}$`, "iu"),
    make: (m) => ({ step: { tool: "tap", label: m[2], ...(m[1] ? { nth: Number(m[1]) } : {}) } }),
  },
  {
    re: new RegExp(String.raw`^${viAny("nhập", "gõ")} ${Q}(?: ${vi("vào")} ${Q})?( ${vi("và")} ${viAny("nhấn", "bấm")} (?:return|enter))?$`, "iu"),
    make: (m) => ({ step: { tool: "type", text: m[1], ...(m[2] ? { into: m[2] } : {}), ...(m[3] ? { submit: true } : {}) } }),
  },
  {
    re: new RegExp(String.raw`^${vi("cuộn")} ${VI_DIRECTION}(?: (\d+) ${vi("lần")})?$`, "iu"),
    make: (m) => {
      const times = m[2] == null ? null : Number(m[2]);
      if (times != null && (times < 1 || times > MAX_TIMES)) return null;
      return { step: { tool: "scroll", direction: viDirection(m[1]), ...(times ? { times } : {}) } };
    },
  },
  // A swipe names where the finger goes; the content moves the other way (swipe left shows what is to the right).
  {
    re: new RegExp(String.raw`^${vi("vuốt")}(?: ${vi("sang")})? ${VI_DIRECTION}(?: (\d+) ${vi("lần")})?$`, "iu"),
    make: (m) => {
      const times = m[2] == null ? null : Number(m[2]);
      if (times != null && (times < 1 || times > MAX_TIMES)) return null;
      return { step: { tool: "scroll", direction: OPPOSITE[viDirection(m[1])], ...(times ? { times } : {}) } };
    },
  },
  { re: new RegExp(String.raw`^${vi("quay lại")}$`, "iu"), make: () => ({ step: { tool: "back" } }) },
  {
    re: new RegExp(String.raw`^${viAny("chờ", "đợi")} (\d+(?:[.,]\d+)?) ${vi("giây")}$`, "iu"),
    make: (m) => {
      const seconds = Number(m[1].replace(",", "."));
      return seconds > 0 && seconds <= MAX_WAIT_SECONDS ? { step: { tool: "wait", ms: Math.round(seconds * 1000) } } : null;
    },
  },
  { re: new RegExp(String.raw`^${viAny("nhấn", "bấm")} (?:return|enter)$`, "iu"), make: () => ({ step: { tool: "key", key: "return" } }) },
  { re: new RegExp(String.raw`^${viAny("ẩn", "đóng")} ${vi("bàn phím")}$`, "iu"), make: () => ({ step: { tool: "key", key: "dismiss" } }) },
  { re: new RegExp(String.raw`^${viAny("nhấn giữ", "bấm giữ", "giữ")} ${Q}$`, "iu"), make: (m) => ({ step: { tool: "long_press", label: m[1] } }) },
  { re: new RegExp(String.raw`^${vi("kéo")} ${Q} ${viAny("tới", "đến", "sang")} ${Q}$`, "iu"), make: (m) => ({ step: { tool: "drag", from: m[1], to: m[2] } }) },
  { re: new RegExp(String.raw`^${vi("mở")} ${vi("ứng dụng")}$`, "iu"), make: () => ({ step: { tool: "open" } }) },
  { re: new RegExp(String.raw`^(?:${vi("mở lại")}|${vi("khởi động lại")}) ${vi("ứng dụng")}$`, "iu"), make: () => ({ step: { tool: "open", relaunch: true } }) },
  { re: new RegExp(String.raw`^${vi("mở")} ${vi("ứng dụng")} ${vi("mới")}$`, "iu"), make: () => ({ step: { tool: "open", reset: true } }) },
];

const CHECK = /^(?:check|verify|expect|make sure)(?: that)?\s+(\S.*)$/i;
const VI_CHECK = new RegExp(String.raw`^(${viAny("kiểm tra", "xác nhận", "xác minh", "mong đợi", "đảm bảo")})(?:\s+${viAny("rằng", "là")})?\s+(\S.*)$`, "iu");
const ONLY_A_NAME = new RegExp(`^${Q}$`);

// A check about a file on the simulator (an exported or saved PDF). Code computes the answer, so the verdict is certain.
//   Check the file "X.pdf" exists | has 3 pages | is A4 [portrait|landscape] | is grayscale | is in color | is locked | is smaller than "Y.pdf"
//   Check the file "X.pdf": <what the pages should show>   (the pages are drawn and a person or the judge looks at them)
const FILE_VERB = String.raw`(?:check|verify|expect|make sure|${viAny("kiểm tra", "xác nhận", "xác minh", "mong đợi", "đảm bảo")})`;
const FILE_HEAD = String.raw`^${FILE_VERB}(?:\s+(?:that|${viAny("rằng", "là")}))?\s+(?:the\s+)?(?:file|${vi("tệp")}|${vi("tập tin")})\s+${Q}`;
const FILE_OPS = [
  { re: new RegExp(String.raw`^\s+(?:exists?|${vi("tồn tại")}|${vi("có mặt")})$`, "iu"), make: () => ({ op: "exists" }) },
  { re: new RegExp(String.raw`^\s+(?:has|have|${vi("có")})\s+(\d+)\s+(?:pages?|${vi("trang")})$`, "iu"), make: (m) => ({ op: "pages", n: Number(m[1]) }) },
  {
    re: new RegExp(String.raw`^\s+(?:is|${vi("là")})\s+A4(?:\s+(portrait|landscape|${vi("dọc")}|${vi("ngang")}))?$`, "iu"),
    make: (m) => ({ op: "a4", ...(m[1] ? { orientation: /^(landscape|ngang)$/i.test(fold(m[1])) ? "landscape" : "portrait" } : {}) }),
  },
  { re: new RegExp(String.raw`^\s+(?:is\s+(?:gr[ae]y(?:scale)?|black and white)|${vi("có màu xám")}|${vi("là ảnh xám")}|${vi("là thang xám")}|${vi("là trắng đen")})$`, "iu"), make: () => ({ op: "gray" }) },
  { re: new RegExp(String.raw`^\s+(?:is\s+in\s+colou?r|has\s+colou?r|${vi("có màu")}(?!\s+${vi("xám")}))$`, "iu"), make: () => ({ op: "color" }) },
  { re: new RegExp(String.raw`^\s+(?:is\s+(?:locked|password[- ]protected)|${vi("bị khóa")}|${vi("có mật khẩu")})$`, "iu"), make: () => ({ op: "locked" }) },
  { re: new RegExp(String.raw`^\s+(?:is\s+smaller\s+than|${vi("nhỏ hơn")})\s+${Q}$`, "iu"), make: (m) => ({ op: "smaller", other: m[1] }) },
  { re: /^\s*:\s*(\S.*)$/u, make: (m) => ({ op: "visual", about: m[1] }) },
];
const FILE_CHECK = new RegExp(`${FILE_HEAD}(.*)$`, "iu");

/** `{ step: look, expected, file }` for a file check line, else null. The sentence after the verb is the expected result. */
function parseFileCheck(original) {
  const m = FILE_CHECK.exec(unifyQuotes(original));
  if (!m) return null;
  const rest = m[2];
  for (const { re, make } of FILE_OPS) {
    const op = re.exec(rest);
    if (op) {
      const expected = original.replace(new RegExp(`^${FILE_VERB}(?:\\s+(?:that|${viAny("rằng", "là")}))?\\s+`, "iu"), "");
      return { step: { tool: "look" }, expected, file: { name: m[1], ...make(op) } };
    }
  }
  return null;
}

/** A blank line or one starting with `#` is a note for the tester, not a step. */
export const isComment = (line) => !line.trim() || line.trim().startsWith("#");

/** `{ step, expected? }` for a line that is a fixed phrase, `null` for anything else. */
export function parsePhrase(line) {
  const original = trimEnd(line.normalize("NFC"));
  const fileCheck = parseFileCheck(original);
  if (fileCheck) return fileCheck;
  const check = CHECK.exec(original);
  if (check) return { step: { tool: "look" }, expected: check[1] };
  // "Xác nhận 'Delete'" confirms a dialog (a tap), it does not check anything: only a sentence after the verb is a check.
  const viCheck = VI_CHECK.exec(original);
  if (viCheck && !(fold(viCheck[1]).toLowerCase() === "xac nhan" && ONLY_A_NAME.test(unifyQuotes(viCheck[2])))) return { step: { tool: "look" }, expected: viCheck[2] };
  const text = unifyQuotes(original);
  for (const { re, make } of PHRASES) {
    const m = re.exec(text);
    if (m) return make(m);
  }
  return null;
}
