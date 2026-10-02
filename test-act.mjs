import assert from "node:assert/strict";
import { actOptions, actState, decideStep, effectRecord, effectText, screenSignature, stepRecord, trustedAction } from "./act.mjs";
import { screenContext } from "./targets.mjs";

const targets = [
  { n: 1, label: "Settings", x: 42, y: 84, editable: false },
  { n: 2, label: "Search", x: 220, y: 904, editable: true, placeholder: "", value: "" },
];

// act must never invent text: without text there is no way to fill a field.
{
  const { criteria, actions } = actOptions(targets);
  assert.ok(criteria.none);
  assert.ok(actions["tap 1"] && actions["tap 2"]);
  assert.equal(actions["type 2"], undefined);
  assert.deepEqual(actions["swipe up"], { kind: "swipe", direction: "up" });
  assert.deepEqual(actions["press dismiss"], { kind: "press", key: "dismiss" });
  assert.equal(actions.none, undefined);
}

// With text, only editable fields get a fill option, and it carries exactly the caller's text.
{
  const { actions } = actOptions(targets, { text: "Wi-Fi" });
  assert.equal(actions["type 1"], undefined);
  assert.deepEqual(actions["type 2"], { kind: "type", target: targets[1], text: "Wi-Fi" });
}

// A moved control changes the signature, so repeating an action there is not "stuck".
assert.notEqual(
  screenSignature(targets),
  screenSignature([{ ...targets[0], y: 90 }, targets[1]])
);

// decideStep maps TypeSafe's label back to an executable action and sends both questions in one request.
{
  let request;
  const client = {
    async systemOne(req) {
      request = req;
      return {
        answers: {
          done: { type: "noul", noul: 0.1 },
          next: { type: "choice", choice: "tap 2", confidence: 0.9, probabilities: {} },
        },
      };
    },
  };
  const step = await decideStep({ instruction: "search", targets, history: [], client });
  assert.deepEqual(Object.keys(request.questions).sort(), ["done", "next"]);
  assert.equal(request.state.instruction, "search");
  assert.equal(step.doneProbability, 0.1);
  assert.equal(step.action.kind, "tap");
  assert.equal(step.action.target.n, 2);
}

// "none" means no executable action.
{
  const client = {
    async systemOne() {
      return {
        answers: {
          done: { type: "noul", noul: 0.2 },
          next: { type: "choice", choice: "none", confidence: 0.8, probabilities: {} },
        },
      };
    },
  };
  const step = await decideStep({ instruction: "x", targets, history: [], client });
  assert.equal(step.action, null);
}

// Controls at one point are one option, so the vote is not split between a cell and its button.
{
  const dup = [
    { n: 1, label: "Apple Account", x: 201, y: 216, editable: false },
    { n: 2, label: "Apple Account, Sign in", x: 201, y: 216, editable: false },
    { n: 3, label: "Settings", x: 38, y: 84, editable: false, back: true },
  ];
  const { criteria, actions } = actOptions(dup);
  assert.ok(actions["tap 1"]);
  assert.equal(actions["tap 2"], undefined);
  assert.match(criteria["tap 1"], /Apple Account, Sign in/);
  assert.match(criteria["tap 3"], /Go back to the "Settings" screen/);
}

// A fill is recorded as not submitted, so "search and submit" is not judged done before return is pressed.
assert.deepEqual(stepRecord({ kind: "type", target: targets[1], text: "Wi-Fi" }, "Settings"), {
  action: "fill field",
  control: "Search",
  text: "Wi-Fi",
  submitted: false,
  onScreen: "Settings",
});

// The navigation title and Back destination come from the interactive snapshot.
assert.deepEqual(
  screenContext([
    { type: "NavigationBar", identifier: "General" },
    { type: "Button", label: "Settings", identifier: "BackButton" },
    { type: "StaticText", label: "General" },
  ]),
  { title: "General", backTo: "Settings", alert: null, texts: ["General"] }
);

// A pager's position reaches TypeSafe, so "go to the next page" can be judged done after one Next:
// on the intro, page 2 has the same Next button as page 1 and no navigation title.
{
  const pager = (n) => [
    { type: "Application", label: "Demo App", index: 0 },
    { type: "Other", label: `Page ${n} of 3`, index: 1, parentIndex: 0 },
    { type: "Button", label: "Next", index: 2, parentIndex: 0 },
  ];
  assert.equal(screenContext(pager(1)).page, "Page 1 of 3");
  assert.equal(screenContext(pager(2)).page, "Page 2 of 3");
  assert.equal(screenContext([{ type: "StaticText", label: "General" }]).page, undefined);
  const record = stepRecord({ kind: "tap", target: { label: "Next" } }, null, "Page 1 of 3");
  assert.deepEqual(record, { action: "tap", control: "Next", onPage: "Page 1 of 3" });
  const state = actState({ instruction: "go to the next intro page", targets: [], history: [record], context: screenContext(pager(2)) });
  assert.equal(state.currentScreen.page, "Page 2 of 3");
  assert.equal(state.stepsTaken[0].onPage, "Page 1 of 3");
}

// A tap's effect separates "changed where I tapped" (a checkmark appeared) from "nothing happened".
{
  assert.deepEqual(effectRecord({ changed: 756, bandChanged: 378 }), { screenChanged: true, changedAtControl: true });
  assert.deepEqual(effectRecord({ changed: 6910, bandChanged: 0 }), { screenChanged: true, changedAtControl: false });
  assert.deepEqual(effectRecord({ changed: 0, bandChanged: 0 }), { screenChanged: false, changedAtControl: false });
  // Different screenshot sizes count as a change of the whole screen.
  assert.equal(effectRecord({ changed: -1, bandChanged: -1 }).screenChanged, true);
  assert.match(effectText({ screenChanged: false, changedAtControl: false }), /no effect/);
  assert.match(effectText({ screenChanged: true, changedAtControl: true }), /at the tapped control/);
  assert.match(effectText({ screenChanged: true, changedAtControl: false }), /elsewhere than the tapped control/);
  assert.match(effectText({ screenChanged: true, changedAtControl: true, nudged: true }), /exact center did nothing/);
  assert.doesNotMatch(effectText({ screenChanged: true, changedAtControl: true }), /exact center/);
  assert.equal(effectText(undefined), "");
  // TypeSafe sees the effect through the step record it already receives.
  const record = { ...stepRecord({ kind: "tap", target: targets[0] }, "Language"), effect: effectRecord({ changed: 5, bandChanged: 5 }) };
  const state = actState({ instruction: "select English", targets, history: [record] });
  assert.deepEqual(state.stepsTaken[0].effect, { screenChanged: true, changedAtControl: true });
}

// A greyed-out row of a file picker ignores the tap. The goal must go on to the next row at modest
// confidence instead of stopping (the user's "select pdf file" run stopped after one tap), but never
// retap the same control, and a first tap still needs the full bar.
{
  const tapOf = (label, confidence, ocr = true) => ({ confidence, action: { kind: "tap", target: { label, ...(ocr ? { ocr: true } : {}) } } });
  const idle = [{ action: "tap", control: "Café Été", readFromScreenshot: true, effect: { screenChanged: false, changedAtControl: false } }];
  const worked = [{ action: "tap", control: "Café Été", effect: { screenChanged: true, changedAtControl: true } }];
  assert.equal(trustedAction(tapOf("clip", 0.55), idle), true, "another row after a tap that changed nothing is tried at 0.55");
  assert.equal(trustedAction(tapOf("Café Été", 0.95), idle), false, "the same control again is never trusted");
  assert.equal(trustedAction(tapOf("clip", 0.15), idle), false, "below the retry bar stops");
  assert.equal(trustedAction({ ...tapOf("clip", 0.55), runnerUp: { key: "tap 9", probability: 0.4 } }, worked), false, "after a tap that worked the full bar applies without a clear lead");
  assert.equal(trustedAction(tapOf("clip", 0.55), []), true, "a first tap on a screenshot row that clearly leads needs only 0.5");
  assert.equal(trustedAction({ ...tapOf("clip", 0.55), runnerUp: { key: "tap 9", probability: 0.4 } }, []), false, "without a clear lead the full bar applies");
  assert.equal(trustedAction({ ...tapOf("clip", 0.45), runnerUp: { key: "tap 9", probability: 0.05 } }, []), false, "below the lead bar stops");
  assert.equal(trustedAction(tapOf("clip", 0.75), []), true);
  assert.equal(trustedAction(tapOf("Continue", 0.55, false), idle), false, "an accessibility control is not retried at the lower bar");
  const idleAx = [{ action: "tap", control: "English", effect: { screenChanged: false, changedAtControl: false } }];
  assert.equal(trustedAction(tapOf("Continue", 0.55, false), idleAx), false, "after an idle accessibility control the full bar applies");
  assert.equal(stepRecord({ kind: "tap", target: { label: "clip", ocr: true } }, null).readFromScreenshot, true);
  assert.equal("readFromScreenshot" in stepRecord({ kind: "tap", target: { label: "Next" } }, null), false);
  assert.equal(trustedAction({ confidence: 0.55, action: { kind: "swipe", direction: "up" } }, idle), false, "a swipe is not retried at the lower bar");
  assert.equal(trustedAction({ confidence: 0.9, action: null }, idle), false);
}

console.log("test-act: ok");
