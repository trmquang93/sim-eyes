/**
 * A batch step only needs its own snapshot + screenshot when someone will read them: the last step
 * (the batch response), a step that saves its screenshot, or a step followed by an index-based action
 * (index refers to the control list of the step before). Every other step skips them.
 */
export function isFastStep(actions, i) {
  if (i >= actions.length - 1) return false;
  const action = actions[i];
  if (action.tool === "look" || action.save) return false;
  if (actions[i + 1]?.index != null) return false;
  return true;
}
