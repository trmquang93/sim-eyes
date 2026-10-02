/**
 * A batch step only needs a screenshot when someone will see it: the last step (the batch response)
 * or a step that saves it. Every step still reads the screen's accessibility tree for its summary.
 */
export function needsShot(actions, i) {
  return i >= actions.length - 1 || !!actions[i].save;
}

const drives = (a) => !["look", "open", "record", "wait"].includes(a.tool);

/**
 * The reminder for a flow sent a few steps at a time: each batch call costs an agent turn. One short batch is
 * normal (opening the app, learning a screen), so the reminder comes on the second short driving batch in a row and
 * every one after it. `streak` is how many short driving batches came right before this one; looks, opens and
 * recordings neither count nor reset it. Returns the new streak and the note ("" when none is due).
 */
export function shortBatchReminder(streak, actions) {
  if (!actions.some(drives)) return { streak, note: "" };
  if (actions.length > 2) return { streak: 0, note: "" };
  const next = streak + 1;
  if (next < 2) return { streak: next, note: "" };
  return {
    streak: next,
    note: `note: ${next} short batches in a row (this one had ${actions.length} step${actions.length === 1 ? "" : "s"}). Each batch call costs an agent turn. Set the end state of the whole flow and send ALL of it as ONE batch of 5–20 steps: exact steps (tap, scroll, type) where you know the label, and one goal step with max_steps 8–25 ("choose QAFolder as the destination") for any stretch whose labels you do not know. A look between taps is the slow path.`,
  };
}
