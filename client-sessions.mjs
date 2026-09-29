import { randomBytes } from "node:crypto";

/** @typedef {{
 *   id: string,
 *   binding: { leaseId: string, udid: string, name: string, expiresAt: string, session: string } | null,
 *   lastTargets: import("./targets.mjs").Target[],
 *   lastScreen: object | null,
 *   appReady: boolean,
 *   app?: string,
 *   recordingPath: string | null,
 *   screenSize: { width: number, height: number },
 *   releasing: boolean,
 * }} ClientSession */

export function newSessionId() {
  return `se-${randomBytes(12).toString("hex")}`;
}

/** @returns {ClientSession} */
export function createClientSession(id) {
  return {
    id,
    binding: null,
    lastTargets: [],
    lastScreen: null,
    appReady: false,
    recordingPath: null,
    screenSize: { width: 402, height: 874 },
    releasing: false,
  };
}

export class SessionRegistry {
  constructor() {
    /** @type {Map<string, ClientSession>} */
    this.sessions = new Map();
  }

  /**
   * @param {string | undefined} sessionId
   * @param {{ allowCreate: boolean, toolName: string }} opts
   * @returns {{ ctx: ClientSession, created: boolean }}
   */
  resolve(sessionId, { allowCreate, toolName }) {
    const id = sessionId?.trim();
    if (id) {
      const ctx = this.sessions.get(id);
      if (!ctx) {
        throw new Error(
          `Unknown session_id "${id}". Use the session_id= value from this chat's first acquire/batch, or omit session_id once to start a new QA session.`
        );
      }
      return { ctx, created: false };
    }
    if (!allowCreate) {
      throw new Error(
        `${toolName} requires session_id. Copy session_id= from the first acquire or batch response in this QA run.`
      );
    }
    const newId = newSessionId();
    const ctx = createClientSession(newId);
    this.sessions.set(newId, ctx);
    return { ctx, created: true };
  }

  delete(id) {
    this.sessions.delete(id);
  }

  /** @returns {ClientSession[]} */
  all() {
    return [...this.sessions.values()];
  }
}

export function formatSessionPrefix(sessionId, created) {
  return `session_id=${sessionId}${created ? " (new — pass this session_id on every later call)" : ""}\n`;
}
