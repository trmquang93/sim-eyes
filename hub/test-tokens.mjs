import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToken, findToken, listTokens, revokeToken } from "./tokens.mjs";

const dir = await mkdtemp(join(tmpdir(), "hub-tokens-"));
const file = join(dir, "tokens.json");
try {
  const token = await addToken(file, "anna");
  assert.match(token, /^simeyes_[A-Za-z0-9_-]{32}$/);

  // A leaked tokens.json must not log anyone in: only the hash is stored.
  const stored = await readFile(file, "utf8");
  assert.ok(!stored.includes(token), "the raw token must never be written");
  assert.equal((await stat(file)).mode & 0o077, 0, "the file is private to its owner");

  assert.equal(await findToken(file, token), "anna");
  assert.equal(await findToken(file, `${token}x`), null, "a near miss is not a token");
  assert.equal(await findToken(file, ""), null);
  assert.equal(await findToken(file, undefined), null);
  assert.equal(await findToken(join(dir, "missing.json"), token), null, "no file means nobody is let in");

  await assert.rejects(addToken(file, "anna"), /already has a token/);
  await assert.rejects(addToken(file, "../etc"), /A name is/);

  // Revoking is the only way to cut a tester off; their name can then be issued again.
  await revokeToken(file, "anna");
  assert.equal(await findToken(file, token), null, "a revoked token stops working");
  await assert.rejects(revokeToken(file, "anna"), /No active token/);
  const again = await addToken(file, "anna");
  assert.notEqual(again, token);
  assert.equal(await findToken(file, again), "anna");
  assert.equal(await findToken(file, token), null, "the old token stays dead");

  const list = await listTokens(file);
  assert.deepEqual(list.map((t) => [t.name, Boolean(t.revokedAt)]), [["anna", true], ["anna", false]]);
  assert.ok(list.every((t) => !("sha256" in t)), "listing never shows hashes");
  console.log("hub/test-tokens: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
