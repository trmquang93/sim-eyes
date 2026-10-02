import assert from "node:assert/strict";
import { GOAL_MAX_STEPS, lineSpans, mapLine, mapLines } from "./map-line.mjs";

// A fake TypeSafe client: answers[question] = [choice, confidence]. Counts calls.
const fake = (answers) => {
  const client = {
    calls: 0,
    async systemOne(req) {
      client.calls += 1;
      client.last = req;
      const out = {};
      for (const key of Object.keys(req.questions)) {
        const [pick, confidence] = answers[key] ?? ["none", 0.99];
        out[key] = { type: "choice", choice: pick, confidence, probabilities: {} };
      }
      return { answers: out };
    },
  };
  return client;
};

// Spans are the line's own words: quoted parts first, no span starts with a stop word.
{
  const spans = lineSpans('Press the "Done" button, then Wi-Fi.');
  assert.equal(spans[0], "Done");
  assert.ok(spans.includes("Wi-Fi"));
  assert.ok(!spans.some((s) => /^(the|then|on)\b/i.test(s)));
  assert.ok(!spans.some((s) => /\bthe$/i.test(s)));
  assert.ok(lineSpans("word ".repeat(80)).length <= 60);
  assert.ok(lineSpans("a long line of text that has many words in it for testing").every((s) => s.split(" ").length <= 5));
}

// The model's pick is used only when it is a span of the line: a label is never generated.
{
  const line = "press the Done button";
  const client = fake({ kind: ["tap", 0.95], target: ["Done", 0.9] });
  assert.deepEqual((await mapLine(line, { client })).step, { tool: "tap", label: "Done" });
  const invented = fake({ kind: ["tap", 0.95], target: ["Finish", 0.99] });
  const result = await mapLine(line, { client: invented });
  assert.equal(result.how, "goal-fallback", "a label that is not in the line is refused");
  assert.equal(result.step.tool, "goal");
  const typed = await mapLine("enter QA-T1 in the name field", { client: fake({ kind: ["type", 0.9], text: ["QA-T1", 0.9], target: ["name", 0.8] }) });
  assert.deepEqual(typed.step, { tool: "type", text: "QA-T1", into: "name" });
  const invention = await mapLine("enter a name", { client: fake({ kind: ["type", 0.9], text: ["Bob", 0.99] }) });
  assert.equal(invention.step.tool, "goal", "text that is not in the line is never typed");
}

// An unsure guess must not run as an exact step; the goal's end state is the line itself.
{
  const line = "do the thing with QA-T1";
  const result = await mapLine(line, { client: fake({ kind: ["tap", 0.55], target: ["QA-T1", 0.99], text: ["QA-T1", 0.9] }) });
  assert.equal(result.how, "goal-fallback");
  assert.deepEqual(result.step, { tool: "goal", goal: line, text: "QA-T1", max_steps: GOAL_MAX_STEPS });
  const lowTarget = await mapLine("tap the files tab", { client: fake({ kind: ["tap", 0.95], target: ["files", 0.5] }) });
  assert.equal(lowTarget.step.tool, "goal", "a tap without a confident label becomes a goal");
  assert.equal(lowTarget.step.text, undefined, "no confident text, none is passed");
}

// The other kinds.
{
  assert.deepEqual((await mapLine("return to the previous screen", { client: fake({ kind: ["back", 0.9] }) })).step, { tool: "back" });
  assert.deepEqual((await mapLine("move down the list 3 times", { client: fake({ kind: ["scroll", 0.9], direction: ["down", 0.9] }) })).step, { tool: "scroll", direction: "down", times: 3 });
  assert.deepEqual((await mapLine("move up", { client: fake({ kind: ["scroll", 0.9], direction: ["up", 0.9] }) })).step, { tool: "scroll", direction: "up" });
  assert.equal((await mapLine("move along", { client: fake({ kind: ["scroll", 0.9], direction: ["none", 0.9] }) })).step.tool, "goal");
  const check = await mapLine("see that the list is empty", { client: fake({ kind: ["checkpoint", 0.9] }) });
  assert.deepEqual(check.step, { tool: "look" });
  assert.equal(check.expected, "see that the list is empty");
  const goal = await mapLine("make a new folder called QA-T1", { client: fake({ kind: ["goal", 0.9], text: ["QA-T1", 0.9] }) });
  assert.deepEqual(goal.step, { tool: "goal", goal: "make a new folder called QA-T1", text: "QA-T1", max_steps: GOAL_MAX_STEPS });
  assert.equal(goal.how, "typesafe");
  assert.equal(goal.confidence, 0.9);
}

// mapLines
{
  const client = fake({ kind: ["goal", 0.9] });
  const first = await mapLines(["# set up", 'Tap "Files"', "open the About page", ""], [], { client });
  assert.deepEqual(first.map((l) => l.how), ["comment", "phrase", "typesafe", "comment"]);
  assert.equal(client.calls, 1, "phrases and comments never reach the model");
  assert.equal(first[0].step, null);

  // Saving again must not re-map a line the tester did not change: it costs money, and the run would drift from what they saw.
  const again = await mapLines(["# set up", 'Tap "Files"', "open the About page", "delete that folder", ""], first, { client });
  assert.equal(client.calls, 2, "only the new line was sent");
  assert.deepEqual(again[2], first[2]);
  const edited = await mapLines(["open the About page now"], first, { client });
  assert.equal(client.calls, 3, "an edited line is mapped again");
  assert.equal(edited[0].step.goal, "open the About page now");
}

// Without a key Studio still works: phrases map, free lines are goals with a visible warning.
{
  const lines = await mapLines(['Tap "Files"', "open the About page"], [], { client: null });
  assert.equal(lines[0].how, "phrase");
  assert.equal(lines[1].how, "goal-fallback");
  assert.equal(lines[1].step.goal, "open the About page");
  assert.match(lines[1].warning, /TYPESAFE_API_KEY/);
  // A key added later maps the line; the warning line is not kept as if it were a mapping.
  const client = fake({ kind: ["back", 0.9] });
  const later = await mapLines(["open the About page"], lines.slice(1), { client });
  assert.equal(client.calls, 1);
  assert.equal(later[0].how, "typesafe");
}

// TypeSafe down: the save still works and says so.
{
  const client = { async systemOne() { throw new Error("network"); } };
  const [line] = await mapLines(["open the About page"], [], { client });
  assert.equal(line.step.tool, "goal");
  assert.match(line.warning, /network/);
}
console.log("test-map-line: ok");
