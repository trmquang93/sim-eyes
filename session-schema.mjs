/** session_id on every MCP tool (same shape for acquire, release, status, batch). */
export const SESSION_ID_PROPERTY = {
  session_id: {
    type: "string",
    description:
      "QA session handle. Omit only on the first acquire or batch in a chat; the response starts with session_id=. Required on every later acquire, batch, status, and release.",
  },
};
