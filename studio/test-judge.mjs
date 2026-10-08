import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { FAIL_MIN, PASS_MIN, TEXT_MIN, downscale, judgeCheckpoint, suggestVerdict, textVerdictOf, verdictOf } from "./judge.mjs";

// The bars decide when a person is asked to look closer: a bar that drifts down turns guesses into suggested passes.
assert.equal(PASS_MIN, 0.8);
assert.equal(FAIL_MIN, 0.8);
assert.equal(verdictOf(0.97), "pass");
assert.equal(verdictOf(0.8), "pass");
assert.equal(verdictOf(0.79), "unsure", "low probability is unsure");
assert.equal(verdictOf(0.5), "unsure");
assert.equal(verdictOf(0.21), "unsure");
assert.equal(verdictOf(0.2), "fail");
assert.equal(verdictOf(0.003), "fail");
assert.equal(verdictOf(undefined), "unsure");
assert.equal(verdictOf(Number.NaN), "unsure");

const cp = (suggested) => ({ suggested });
assert.equal(suggestVerdict([cp("pass"), cp("fail"), cp("pass")]), "fail", "any failing checkpoint makes the case fail");
assert.equal(suggestVerdict([cp("pass"), cp("pass")]), "pass");
assert.equal(suggestVerdict([cp("pass"), cp("unsure")]), "unsure", "one unsure keeps the case unsure");
assert.equal(suggestVerdict([cp("unsure"), cp("fail")]), "fail", "a clear failure is not hidden by an unsure one");
assert.equal(suggestVerdict([]), "unsure", "a case with nothing to judge has no suggestion to trust");
assert.equal(suggestVerdict(undefined), "unsure");

const seen = [];
const clientReturning = (noulValue) => ({ async systemOne(req) { seen.push(req); return { answers: { matches: { type: "noul", noul: noulValue } } }; } });
const prepareImage = async (path) => `jpeg-of:${path}`;

{
  const out = await judgeCheckpoint({ expected: "Trang 2 bị xóa; còn 2 trang", screen: 'title "Detail"', imagePath: "/r/03.png" }, { client: clientReturning(0.941234), prepareImage });
  assert.deepEqual(out, { suggested: "pass", p: 0.941, via: "screenshot" });
  assert.deepEqual(seen[0].images, ["jpeg-of:/r/03.png"], "the screenshot goes with the question, as base64");
  assert.deepEqual(seen[0].state, { expected: "Trang 2 bị xóa; còn 2 trang", screen: 'title "Detail"' });
  assert.deepEqual(Object.keys(seen[0].questions), ["matches"], "one yes/no question: the judge selects, it never writes");
  assert.equal((await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: clientReturning(0.04), prepareImage })).suggested, "fail");
  assert.equal((await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: clientReturning(0.55), prepareImage })).suggested, "unsure");
}

// The pages of a file are judged as pages: without the Files screen's text around them, which once pulled a right answer down to 22%.
{
  const before = seen.length;
  const out = await judgeCheckpoint({ expected: "trang 1 đỏ, trang 2 xanh lá", screen: 'texts: On My iPhone / sample3 / 31 KB', imagePaths: ["/r/p1.jpg", "/r/p2.jpg"] }, { client: clientReturning(0.97), prepareImage });
  assert.equal(out.suggested, "pass");
  const req = seen[before];
  assert.deepEqual(req.images, ["jpeg-of:/r/p1.jpg", "jpeg-of:/r/p2.jpg"], "all the pages, in order");
  assert.equal(req.state.screen, undefined, "the screen text is not evidence about a file's pages");
  assert.match(req.state.pages, /pages 1 to 2 of a file, in order/);
  assert.equal(req.state.expected, "trang 1 đỏ, trang 2 xanh lá");
  const single = await judgeCheckpoint({ expected: "x", screen: "s", imagePaths: ["/r/p1.jpg"] }, { client: clientReturning(0.9), prepareImage });
  assert.equal(single.suggested, "pass");
  assert.equal(seen.at(-1).state.screen, "s", "one picture is a screenshot: its screen text stays");
}

// The judge never fails a run and never invents a pass: every problem becomes "unsure" with the reason.
{
  const none = await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: null, prepareImage });
  assert.deepEqual([none.suggested, none.p], ["unsure", null], "no judge means unsure");
  assert.match(none.error, /No judge/);
  const before = seen.length;
  const noImage = await judgeCheckpoint({ expected: "x", imagePath: null }, { client: clientReturning(0.99), prepareImage });
  assert.equal(noImage.suggested, "unsure");
  assert.equal(seen.length, before, "no screenshot, no call");
  const down = await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: { systemOne: async () => { throw new Error("The judge is unreachable through OpenRouter"); } }, prepareImage });
  assert.deepEqual([down.suggested, down.p, down.error], ["unsure", null, "The judge is unreachable through OpenRouter"]);
  const odd = await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: { systemOne: async () => ({ answers: {} }) }, prepareImage });
  assert.equal(odd.suggested, "unsure");
  const broken = await judgeCheckpoint({ expected: "x", imagePath: "/r/1.png" }, { client: clientReturning(0.99), prepareImage: async () => { throw new Error("sips failed"); } });
  assert.deepEqual([broken.suggested, broken.error], ["unsure", "sips failed"]);
}

// A full-size iPhone screenshot is far above the hub's body limit; the picture sent is a JPEG with a bounded long side.
{
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    await writeFile(args[args.indexOf("--out") + 1], "JPEGBYTES");
  };
  assert.equal(await downscale("/r/01.png", { exec }), Buffer.from("JPEGBYTES").toString("base64"));
  const [cmd, args] = calls[0];
  assert.equal(cmd, "sips");
  assert.deepEqual(args.slice(0, 7), ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions"]);
  assert.ok(args.includes("/r/01.png"));
}

// Screen text first: the verdict of a text answer needs a clear `shows` or `contradicts`; anything else is not a verdict.
{
  assert.equal(TEXT_MIN, 0.85);
  const dist = (choice, probabilities) => ({ choice, probabilities: { shows: 0, contradicts: 0, "cannot tell": 0, ...probabilities } });
  assert.deepEqual(textVerdictOf(dist("shows", { shows: 0.93, "cannot tell": 0.07 })), { suggested: "pass", p: 0.93 });
  assert.deepEqual(textVerdictOf(dist("contradicts", { shows: 0.04, contradicts: 0.96 })), { suggested: "fail", p: 0.04 });
  assert.equal(textVerdictOf(dist("shows", { shows: 0.84, contradicts: 0.16 })).suggested, "unsure", "a 84% shows is below the bar: the screenshot decides");
  assert.equal(textVerdictOf(dist("contradicts", { contradicts: 0.7, "cannot tell": 0.3 })).suggested, "unsure");
  const blind = textVerdictOf(dist("cannot tell", { "cannot tell": 0.99 }));
  assert.equal(blind.suggested, "unsure", "a text that does not carry the answer never decides, however sure it is of that");
  assert.match(blind.why, /does not carry/);
  assert.equal(textVerdictOf(undefined).suggested, "unsure");
  assert.equal(textVerdictOf({ choice: "shows" }).suggested, "unsure");
}

const SCREEN = 'screen: "Files" · alert "Delete page 2?" | texts: Delete page 2? / This cannot be undone / Cancel / Delete';
const textClientReturning = (choice, probabilities) => ({
  calls: [],
  async systemOne(req) {
    this.calls.push(req);
    return { answers: { screen: { type: "choice", choice, confidence: 0.9, probabilities: { shows: 0, contradicts: 0, "cannot tell": 0, ...probabilities } } } };
  },
});
const visionSeen = () => seen.length;

// A clear text answer settles the checkpoint without a picture: nothing is downscaled and the vision judge is never called.
{
  const text = textClientReturning("shows", { shows: 0.96, "cannot tell": 0.04 });
  const before = visionSeen();
  let prepared = 0;
  const out = await judgeCheckpoint({ expected: "A confirmation asks to delete page 2", screen: SCREEN, controls: "controls (2): Cancel · Delete", imagePath: "/r/9.png" }, { client: clientReturning(0.1), textClient: text, prepareImage: async () => (prepared += 1, "x") });
  assert.deepEqual(out, { suggested: "pass", p: 0.96, via: "screen" });
  assert.equal(visionSeen(), before, "the screenshot judge is not asked when the text is clear");
  assert.equal(prepared, 0, "no screenshot is read either");
  assert.deepEqual(text.calls[0].state, { expected: "A confirmation asks to delete page 2", screen: SCREEN, controls: "controls (2): Cancel · Delete" });
  assert.equal(text.calls[0].images, undefined, "the text judge is given no picture");
  assert.deepEqual(Object.keys(text.calls[0].questions), ["screen"]);
  const fail = await judgeCheckpoint({ expected: "No confirmation is shown", screen: SCREEN, imagePath: "/r/9.png" }, { client: clientReturning(0.9), textClient: textClientReturning("contradicts", { shows: 0.03, contradicts: 0.97 }), prepareImage });
  assert.deepEqual([fail.suggested, fail.via], ["fail", "screen"]);
}

// Every way the text can fail to settle it falls back to the screenshot, and the verdict says why, so a person can see which judge decided.
{
  const cases = [
    ["cannot tell", textClientReturning("cannot tell", { "cannot tell": 0.9 }), SCREEN, /does not carry/],
    ["low probability", textClientReturning("shows", { shows: 0.6, contradicts: 0.4 }), SCREEN, /not clear enough/],
    ["the text judge throws", { systemOne: async () => { throw new Error("503"); } }, SCREEN, /text judge failed: 503/],
    ["the answer is unreadable", { systemOne: async () => ({ answers: {} }) }, SCREEN, /unreadable/],
    ["no screen description", textClientReturning("shows", { shows: 0.99 }), null, /no usable screen description/],
    ["an empty description", textClientReturning("shows", { shows: 0.99 }), "screen: (no title)", /no usable screen description/],
  ];
  for (const [name, textClient, screen, why] of cases) {
    const before = visionSeen();
    const out = await judgeCheckpoint({ expected: "x", screen, imagePath: "/r/9.png" }, { client: clientReturning(0.95), textClient, prepareImage });
    assert.equal(out.suggested, "pass", `${name}: the screenshot judge answers`);
    assert.equal(out.via, "screenshot", name);
    assert.match(out.fallback, why, name);
    assert.equal(visionSeen(), before + 1, `${name}: exactly one screenshot call`);
  }
  const ocr = textClientReturning("contradicts", { shows: 0.02, contradicts: 0.98 });
  const covered = await judgeCheckpoint({ expected: "không có kết quả", screen: "screen: covered by a view outside the app's accessibility tree (a system picker or permission sheet) | texts (read from the screenshot): ReadJny / Cancel / ReadJny_Docurnent.docK", imagePath: "/r/9.png" }, { client: clientReturning(0.95), textClient: ocr, prepareImage });
  assert.equal(ocr.calls.length, 0, "OCR of a covered screen is not evidence the text judge may fail a checkpoint on");
  assert.deepEqual([covered.suggested, covered.via], ["pass", "screenshot"]);
  const empty = textClientReturning("shows", { shows: 0.99 });
  await judgeCheckpoint({ expected: "x", screen: "screen: (no title)", imagePath: "/r/9.png" }, { client: clientReturning(0.95), textClient: empty, prepareImage });
  assert.equal(empty.calls.length, 0, "an empty description is not sent to the model");
}

// The pages of a file are pictures: the text stage is skipped and the pages go to the screenshot judge as before.
{
  const text = textClientReturning("shows", { shows: 0.99 });
  const out = await judgeCheckpoint({ expected: "page 1 red", screen: SCREEN, imagePaths: ["/r/p1.jpg", "/r/p2.jpg"] }, { client: clientReturning(0.97), textClient: text, prepareImage });
  assert.equal(text.calls.length, 0);
  assert.deepEqual([out.suggested, out.via, out.fallback], ["pass", "screenshot", undefined]);
}

// Text alone, with no screenshot judge: a clear text answer still counts, an unclear one is "unsure" with both reasons, never a guess.
{
  const clear = await judgeCheckpoint({ expected: "x", screen: SCREEN, imagePath: "/r/9.png" }, { client: null, textClient: textClientReturning("shows", { shows: 0.95 }), prepareImage });
  assert.deepEqual([clear.suggested, clear.via], ["pass", "screen"]);
  const unclear = await judgeCheckpoint({ expected: "x", screen: SCREEN, imagePath: "/r/9.png" }, { client: null, textClient: textClientReturning("cannot tell", { "cannot tell": 0.9 }), prepareImage });
  assert.deepEqual([unclear.suggested, unclear.p], ["unsure", null]);
  assert.match(unclear.fallback, /does not carry/);
  assert.match(unclear.error, /No judge/);
  const noShot = await judgeCheckpoint({ expected: "x", screen: SCREEN, imagePath: null }, { client: clientReturning(0.95), textClient: textClientReturning("cannot tell", { "cannot tell": 0.9 }), prepareImage });
  assert.equal(noShot.suggested, "unsure");
  assert.equal(noShot.via, undefined, "no picture, so the screenshot judge did not decide");
}
console.log("test-judge: ok");
