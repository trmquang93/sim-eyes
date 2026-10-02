/**
 * One reply of the sim-eyes server, as the tester's run needs it. The replies are written for agents: this keeps what
 * a person reviews (what the step did, the screen it left, the saved screenshot) and drops the session prefix, the
 * "short batches" reminder and the request for an agent's help. Whether a step worked is `isError`, never the wording.
 */

const textOf = (result) => result.content?.find((c) => c.type === "text")?.text ?? "";

/** The simulator a session is bound to, from the `udid:` line of an `acquire` reply. Throws rather than guess. */
export function leasedUdid(text) {
  const udid = /^udid: (\S+)$/m.exec(text)?.[1];
  if (!udid) throw new Error("The sim-eyes reply did not say which simulator was leased (no \"udid:\" line), so the build cannot be installed.");
  return udid;
}

export function stepReport(result) {
  const raw = textOf(result);
  const prefix = /^session_id=(\S+)[^\n]*\n/.exec(raw);
  const body = prefix ? raw.slice(prefix[0].length) : raw;
  const [log = "", ...after] = body.split("\n\n");
  const all = log.split("\n");
  // From "Step N needs your help" on, the text is an instruction to an agent.
  const help = all.findIndex((l) => /^Step \d+ needs your help/.test(l));
  const lines = (help === -1 ? all : all.slice(0, help)).filter((l) => !/^\d+ remaining step\(s\) not run/.test(l));
  if (lines.length) lines[0] = lines[0].replace(/^\d+\. /, "");

  const take = (re) => {
    const i = lines.findLastIndex((l) => re.test(l));
    return i === -1 ? null : lines.splice(i, 1)[0];
  };
  const saved = take(/^ {3}saved /)?.trim().slice("saved ".length) ?? null;
  const screen = take(/^ {3}\S/)?.trim() ?? null;
  const image = result.content?.find((c) => c.type === "image")?.data ?? null;
  return {
    ok: result.isError !== true,
    text: body,
    summary: lines.join("\n").trim(),
    screen,
    saved,
    controls: after.filter((b) => !b.startsWith("note: ")).join("\n\n").trim() || null,
    image,
    poolBusy: /^SIM_POOL_BUSY:/m.test(body),
    sessionId: prefix?.[1] ?? null,
  };
}
