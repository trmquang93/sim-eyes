import assert from "node:assert/strict";
import { actOptions, actState, ACT_CONFIRM_MIN, BOX_MODEL, CONFIRM_QUESTION, confirmGoal, decideStep, effectRecord, effectText, SHOT_OPTION, screenshotsOn, screenSignature, stepRecord, trustedAction } from "../act.mjs";
import { screenContext } from "../targets.mjs";

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

// A goal that ran out of steps is judged from the screen's description. A pager still on page 2 of 3 must come back
// "not achieved" (the onboarding run that passed without reaching home), and a verdict TypeSafe is unsure of must not
// decide anything: it stays "cannot tell" so the step is reported as unconfirmed, as before.
{
  const asks = [];
  const clientSaying = (choiceLabel, confidence) => ({
    async systemOne(req) {
      asks.push(req);
      return { answers: { verdict: { type: "choice", choice: choiceLabel, confidence, probabilities: {} } } };
    },
  });
  const context = { title: null, page: "Page 2 of 3", texts: ["Understand Any Document Instantly"] };
  const history = [{ action: "tap", control: "Next", onPage: "Page 1 of 3" }];
  const base = { instruction: "go through next pages until reach home", targets, history, context };
  const missed = await confirmGoal({ ...base, client: clientSaying("not achieved", 0.9) });
  assert.deepEqual(missed, { verdict: "not achieved", confidence: 0.9 });
  assert.equal(asks.length, 1, "one request");
  assert.deepEqual(Object.keys(asks[0].questions), ["verdict"]);
  assert.equal(asks[0].state.currentScreen.page, "Page 2 of 3", "TypeSafe is given the screen description");
  assert.equal(asks[0].state.instruction, base.instruction);
  assert.equal((await confirmGoal({ ...base, client: clientSaying("achieved", 0.95) })).verdict, "achieved");
  assert.equal((await confirmGoal({ ...base, client: clientSaying("achieved", ACT_CONFIRM_MIN - 0.01) })).verdict, "cannot tell", "an unsure verdict decides nothing");
  assert.equal((await confirmGoal({ ...base, client: clientSaying("not achieved", ACT_CONFIRM_MIN - 0.01) })).verdict, "cannot tell");
  assert.equal((await confirmGoal({ ...base, client: clientSaying("something else", 0.99) })).verdict, "cannot tell", "an unknown label is never believed");
  assert.match(CONFIRM_QUESTION.rules.join(" "), /earlier page/);
}

// The screenshot replaces OCR text as the way to reach a control the tree does not list (a close X, a picker row).
// Without the option, the goal could only stop there; the point must come from the Box, never from a guess.
{
  const shot = Buffer.from("png");
  const screen = { width: 400, height: 800 };
  assert.equal(actOptions(targets).actions[SHOT_OPTION], undefined, "no screenshot, no screenshot option");
  assert.ok(actOptions(targets, { screenshot: true }).criteria[SHOT_OPTION]);
  assert.equal(actState({ instruction: "x", targets, history: [], screen }).screenshot, undefined);
  assert.ok(actState({ instruction: "x", targets, history: [], screen, shot }).screenshot, "the state carries the image only when there is one");

  const clientFor = ({ choiceKey, present, boxAnswer }) => {
    const requests = [];
    return {
      requests,
      async systemOne(req) {
        requests.push(req);
        if (req.model === BOX_MODEL) return { answers: { present: { noul: present }, where: boxAnswer } };
        return {
          answers: {
            done: { noul: 0.05 },
            next: { choice: choiceKey, confidence: 0.9, probabilities: { [choiceKey]: 0.9, none: 0.1 } },
          },
        };
      },
    };
  };
  const centered = { type: "box", box: { top: 0.1, bottom: 0.2, left: 0.8, right: 0.9 }, confidence: 0.9 };

  const found = clientFor({ choiceKey: SHOT_OPTION, present: 0.95, boxAnswer: centered });
  const step = await decideStep({ instruction: "close the sheet", targets, history: [], client: found, screen, shot });
  assert.equal(step.action.kind, "tap");
  assert.deepEqual([step.action.target.x, step.action.target.y], [340, 120], "the tap lands on the centre of the box, in screen points");
  assert.equal(trustedAction(step, []), true);
  assert.equal(stepRecord(step.action, null).readFromScreenshot, true);
  assert.equal(found.requests.length, 2, "one request to decide, one to locate");
  assert.equal(found.requests[1].model, BOX_MODEL, "Box answers only on 1.14");

  const absent = clientFor({ choiceKey: SHOT_OPTION, present: 0.1, boxAnswer: centered });
  const none = await decideStep({ instruction: "close the sheet", targets, history: [], client: absent, screen, shot });
  assert.equal(none.action, null, "a Box always returns four edges, so a target that is not there must not be tapped");
  assert.equal(trustedAction(none, []), false);

  const listed = clientFor({ choiceKey: "tap 1", present: 0.95, boxAnswer: centered });
  await decideStep({ instruction: "open settings", targets, history: [], client: listed, screen, shot });
  assert.equal(listed.requests.length, 1, "a listed control needs no locate request");

  assert.equal(screenshotsOn({}), true);
  assert.equal(screenshotsOn({ TYPESAFE_BASE_URL: "https://hub.example" }), false, "the hub relay forwards JSON only, so images stay off through it");
}

console.log("test-act: ok");
