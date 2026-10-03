import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { FAIL_MIN, PASS_MIN, downscale, judgeCheckpoint, suggestVerdict, verdictOf } from "./judge.mjs";

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
  assert.deepEqual(out, { suggested: "pass", p: 0.941 });
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
console.log("test-judge: ok");
