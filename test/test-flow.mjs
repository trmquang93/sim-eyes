import assert from "node:assert/strict";
import { fieldText, holdsText, focusPackage, namedOptions, needsChoice, valuesPending, wantsForward, choiceGroup, flowInstruction, flowTracker, isBackLike, isForward, MAX_BAD_DECISIONS, nextFill, optionsLeft, screenReport, typicalChoice, untilReached } from "../flow.mjs";

const screen = { width: 400, height: 900 };
const field = (label, y, value = "") => ({ n: 1, label, y, x: 200, editable: true, value });
const btn = (label, x, y) => ({ label, x, y });

// Why: the model must never pick or invent form text; code fills the fields from the caller's values, in screen order, once each.
{
  const fields = [field("display-name", 400), field("full-name", 300), field("birth-year", 500)];
  const list = ["Tran Quang", "Quang", "1987"];
  const first = nextFill(fields, list);
  assert.equal(first.field.label, "full-name", "topmost field first");
  assert.equal(first.text, "Tran Quang");
  // Android shows a field's text as its label: a field that holds an entry is done, and the next entry goes to the next field.
  const after = nextFill([field("Tran Quang", 300), field("display-name", 400), field("birth-year", 500)], list, { used: new Set(["Tran Quang"]) });
  assert.deepEqual([after.field.label, after.text], ["display-name", "Quang"]);
  assert.equal(nextFill([field("Tran Quang", 300), field("Quang", 400), field("1987", 500)], list), null, "everything filled");
  assert.equal(nextFill(fields, undefined), null, "no values, nothing typed");
  assert.deepEqual(nextFill([field("Email", 100)], { email: "a@b.vn" }).text, "a@b.vn", "an object matches by label, case aside");
  assert.equal(nextFill(fields, list, { skip: () => true }), null, "a field already tried is not tried again");
}

// Why: one pick settles a choice. Tapping Male and Female both was the first failure of the autonomous run.
{
  const row = [btn("Male", 80, 500), btn("Female", 200, 500), btn("Other", 320, 500)];
  const list = [btn("Social", 200, 240), btn("Club", 200, 304), btn("Tournament", 200, 368), btn("Doubles", 200, 480), btn("Singles", 200, 544)];
  assert.deepEqual(choiceGroup(row, row[1]).map((t) => t.label), ["Male", "Female", "Other"]);
  assert.deepEqual(choiceGroup(list, list[0]).map((t) => t.label), ["Social", "Club", "Tournament"], "a gap larger than the row spacing starts a new group");
  assert.deepEqual(choiceGroup(list, list[4]).map((t) => t.label), ["Doubles", "Singles"]);
  const tracker = flowTracker();
  for (const t of choiceGroup(row, row[0])) tracker.use(`s#${t.label}@${t.x},${t.y}`);
  assert.deepEqual(optionsLeft(row, "s", tracker), [], "the alternatives of a made choice are gone");
}

// Why: a forward button must be told from an option, and a Back control from the app's own.
assert.equal(isForward(btn("Continue", 200, 848), screen), true);
assert.equal(isForward(btn("Option", 200, 300), screen), false);
assert.equal(isBackLike({ label: "Quay lại", x: 38, y: 54 }), true);
assert.equal(isBackLike({ label: "Continue", x: 200, y: 848 }), false);

// Why: when the model cannot tell options apart (a 1-5 scale) the run must still move: the middle option, else forward.
{
  const scale = [1, 2, 3, 4, 5].map((n) => btn(String(n), 40 + n * 60, 426));
  assert.equal(typicalChoice(scale, screen).label, "3");
  assert.equal(typicalChoice([btn("Next", 260, 848)], screen).label, "Next");
  assert.equal(typicalChoice([], screen), null);
}

// Why: a run that loops or cannot decide must stop with 'stuck', not spend minutes: bad decisions and visits are capped.
{
  const t = flowTracker();
  for (let i = 1; i < MAX_BAD_DECISIONS; i++) assert.equal(t.badDecision(), false);
  assert.equal(t.badDecision(), true);
  t.goodDecision();
  assert.equal(t.badDecision(), false, "a good decision resets the count");
  const v = flowTracker();
  v.visit("a"); v.visit("a"); v.visit("a");
  assert.equal(v.looping("a"), true);
  // A quiz page that looks like the last one frees its controls again.
  v.use("a#1@1,1");
  v.resetScreen("a");
  assert.equal(v.used("a#1@1,1"), false);
  assert.equal(v.looping("a"), false);
}

// The result is one line per screen, and `until` ends the run on text anywhere on the screen (alternatives with |).
assert.equal(screenReport(2, { title: null, texts: ["Return Serve", "Question 1/6", "x"] }, ['tap "3"', 'tap "Next"']), '2. Return Serve / Question 1/6: tap "3", tap "Next"');
assert.equal(untilReached("go to home|vào home", { texts: ["Your level"] }, [{ label: "Go to Home" }]), true);
assert.equal(untilReached("Done", { texts: ["Name"] }, []), false);
assert.equal(untilReached(null, { texts: [] }, []), false);
assert.match(flowInstruction("walk the onboarding"), /walk the onboarding[\s\S]*one screen at a time[\s\S]*any typical choice/);

// Why: when the task names an option it is tapped directly; a typical pick is only for tasks that name nothing (a09 tapped "Never played" and "Over 2 years" unasked).
{
  const opts = [btn("Never played", 200, 240), btn("1 – 3 months", 200, 450), btn("Over 2 years", 200, 690), btn("3", 100, 300)];
  assert.deepEqual(namedOptions("pick '1 – 3 months' and continue", opts).map((t) => t.label), ["1 – 3 months"]);
  assert.deepEqual(namedOptions("choose 1 - 3 MONTHS", opts).map((t) => t.label), ["1 – 3 months"], "case, dash kind and spacing do not matter");
  assert.deepEqual(namedOptions("answer with a middle confidence", opts), [], "nothing named, so nothing tapped directly");
  assert.deepEqual(namedOptions("rate 3 stars", opts), [], "labels under three characters are never matched by accident");
}

// Why: a forward button waits for a required choice, and the run is never done while a value is untyped (a08: Birth year under the keyboard, Continue disabled).
{
  const choices = [btn("Male", 80, 500)];
  assert.equal(needsChoice(choices, false), true);
  assert.equal(needsChoice(choices, true), false, "after a pick the forward button is free");
  assert.equal(needsChoice([], false), false, "no choices on the screen: nothing to wait for");
  const fields = [field("full-name", 300), field("birth-year", 500)];
  assert.equal(valuesPending(["Tran Quang", "1995"], new Set(), fields), 2);
  assert.equal(valuesPending(["Tran Quang", "1995"], new Set(["Tran Quang"]), fields), 1, "an entry typed already is not pending");
  assert.equal(valuesPending(["Tran Quang", "1995"], new Set(), [field("Tran Quang", 300), field("1995", 500)]), 0, "entries held by fields are done");
  assert.equal(valuesPending(undefined, new Set(), fields), 0);
  assert.equal(isForward(btn("Option", 200, 690), { width: 390, height: 844 }), false, "the last list row is not a forward button");
  assert.equal(isForward(btn("Continue", 200, 700), { width: 390, height: 844 }), true, "a Continue label low on the screen is");
  assert.equal(wantsForward("pick '1 – 3 months' and continue"), true);
  assert.equal(wantsForward("choose Social"), false);
}

// Why: on Android a stray tap or BACK leaves the app (Google's phone-hint sheet); the run reads the focused package to notice.
assert.equal(focusPackage("  mCurrentFocus=Window{4f2 u0 com.ilamaster.pivoplay/vn.pivo.play.MainActivity}"), "com.ilamaster.pivoplay");
assert.equal(focusPackage("  mCurrentFocus=Window{1a u0 com.google.android.gms/com.google.android.gms.auth.api.credentials.assistedsignin.ui.PhoneNumberHintActivity}"), "com.google.android.gms");
assert.equal(focusPackage("mCurrentFocus=null"), null);

// Why (a08 iOS): an empty field reports its placeholder as its value; "1992" as a placeholder must not count as the entry "1992".
{
  const empty = { label: "TextField", placeholder: "1992", value: "1992", editable: true, y: 615, x: 195 };
  assert.equal(fieldText(empty), "", "a value equal to the placeholder is not content");
  assert.equal(holdsText([empty], "1992"), false);
  assert.equal(holdsText([{ ...empty, value: "1992" , placeholder: "1990" }], "1992"), true, "a real 1992 is content");
  assert.equal(valuesPending(["1992"], new Set(), [empty]), 1, "the empty birth-year field still needs its entry");
  assert.deepEqual(nextFill([empty], ["1992"]).text, "1992", "and it is typed");
}

// Why (a09-a11): values for a form must not block a screen that only has options.
{
  const optionsOnly = [btn("Never played", 200, 240), btn("Continue", 200, 800)];
  assert.equal(valuesPending(["Tran Quang", "1995"], new Set(), optionsOnly), 0, "no field on screen: nothing to type here");
  assert.equal(valuesPending(["Tran Quang"], new Set(), optionsOnly, { keyboard: true }), 1, "a keyboard may hide the field");
  assert.equal(valuesPending(["Tran Quang"], new Set(), [field("full-name", 300)]), 1, "a field on screen with its entry untyped is pending");
}
console.log("test-flow: ok");
