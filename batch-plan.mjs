/**
 * A batch step only needs a screenshot when someone will see it: the last step (the batch response)
 * or a step that saves it. Every step still reads the screen's accessibility tree for its summary.
 */
export function needsShot(actions, i) {
  return i >= actions.length - 1 || !!actions[i].save;
}
