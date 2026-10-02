/** goal steps a failed tap may spend: enough to scroll to the control and tap it. */
export const TAP_FALLBACK_STEPS = 4;

/** A step that did not do its job: the batch stops there (or pauses for help, see `tapWithFallback`). */
export const stepFailed = (result) => result.outcome === "stopped" || (result.outcome === "acted" && !result.landed);

/** The goal a failed tap falls back to. It reads as "tap <label>", so a tap that visibly changes the screen confirms it. */
export const tapFallbackGoal = (label) => `tap ${JSON.stringify(String(label).trim())}`;

/**
 * What a tap by code reports (`words` is what the screen did, from effectText). A tap that changed nothing is
 * "acted but not confirmed", unless the control was already selected (the current tab, the active filter): then
 * nothing was meant to change, so it is done and needs no fallback.
 */
export function tapResult(what, target, effect, words) {
  const name = JSON.stringify(target.label);
  if (effect.screenChanged) return { outcome: "done", landed: true, summary: `${what}: done, tapped ${name}, ${words}.` };
  if (target.selected) return { outcome: "done", landed: true, summary: `${what}: done, ${name} is already selected, so the tap left the screen as it was.` };
  return { outcome: "acted", landed: false, summary: `${what}: acted but not confirmed, tapped ${name}, ${words}.` };
}

const firstLine = (text) => String(text).split("\n")[0];

/**
 * The `tap` step with its two fallbacks: the exact tap by code (`direct`), then the same tap as a model-driven
 * goal (`goal`). If both fail the result has `needsHelp`, and the batch asks the agent to do the tap itself.
 * `fatal(err)` names errors that are no tap's fault (a busy pool) and so are rethrown.
 */
export async function tapWithFallback(args, { direct, goal, fatal = () => false }) {
  const label = String(args.label ?? "").trim();
  // A tap without a label is a mistake in the batch, not a tap to rescue.
  if (!label) return direct(args);
  let why;
  try {
    const result = await direct(args);
    if (!stepFailed(result)) return result;
    why = firstLine(result.summary);
  } catch (err) {
    if (fatal(err)) throw err;
    why = err.message;
  }
  const lead = `tap ${JSON.stringify(label)}: the exact tap failed (${why}).`;
  let fallback;
  try {
    fallback = await goal(tapFallbackGoal(label));
  } catch (err) {
    if (fatal(err)) throw err;
    return { outcome: "stopped", landed: false, needsHelp: true, summary: `${lead} The goal fallback could not run: ${err.message}` };
  }
  const summary = `${lead} Fell back to a goal:\n${fallback.summary}`;
  if (stepFailed(fallback)) return { ...fallback, summary: `${summary}\nThe goal fallback failed too.`, needsHelp: true };
  return { ...fallback, summary };
}

/** A step in a few words, for the list of what still has to run. */
export function describeStep(action) {
  if (action.label == null && action.x != null && action.y != null) return `${action.tool} (${action.x}, ${action.y})`;
  const subject = action.label ?? action.goal ?? action.direction ?? action.text ?? action.name ?? action.action ?? action.key;
  return subject == null ? action.tool : `${action.tool} ${JSON.stringify(String(subject))}`;
}

/** The steps a failed batch did not run, so the agent can send them again without rebuilding the flow. */
export const notRunText = (rest) => `${rest.length} remaining step(s) not run: ${rest.map(describeStep).join("; ")}.`;

/** What the agent is told when a step needs its help (`n` is the step's number in the whole flow). */
export function helpRequest(n, rest) {
  const doIt = `Step ${n} needs your help: the exact tap and the goal fallback both failed, so do that tap yourself`;
  if (rest.length === 0) return `${doIt}, with a batch (for example tap_at with a point read from the screenshot). It was the last step, so nothing remains.`;
  return [
    `${doIt}, with a batch (for example tap_at with a point read from the screenshot), then call continue with this session_id.`,
    `The batch is paused; ${rest.length} step(s) wait: ${rest.map(describeStep).join("; ")}.`,
    "continue runs them from the screen you leave. A batch of yours does not discard them, even if it fails; continue with discard:true (or release) does.",
  ].join("\n");
}

/** The line a batch adds while steps wait, so the agent calling its own batch to help is reminded how to resume. */
export const pausedReminder = (paused) =>
  `note: a batch is paused after step ${paused.start} with ${paused.rest.length} step(s) waiting. Call continue (with this session_id) to run them, or continue with discard:true to drop them; another batch does neither.`;
