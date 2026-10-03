// Why: the package ships a prebuilt OCR binary so a stranger needs no swiftc. It may only run when it still matches the
// ocr.swift beside it and has not been altered; otherwise running it would execute stale or corrupted native code, so
// the old compile-on-first-use path must take over.
import assert from "node:assert/strict";
import { ensureOcrBinary } from "../ocr.mjs";

const PACKAGED = "/pkg/bin/ocr";
const META = "/pkg/bin/ocr.json";
const SOURCE = "/pkg/ocr.swift";
const COMPILED = "/home/.local/sim-eyes/bin/ocr";

function setup({ files = [PACKAGED, META], meta = { sourceSha256: "src1", sha256: "bin1" }, hashes = { [SOURCE]: "src1", [PACKAGED]: "bin1" }, fresh = false } = {}) {
  const log = { compiled: 0, chmod: [] };
  const deps = {
    packaged: { binary: PACKAGED, meta: META },
    compiled: COMPILED,
    source: SOURCE,
    exists: (p) => files.includes(p),
    readJson: () => meta,
    hash: (p) => hashes[p],
    chmod: (p) => log.chmod.push(p),
    isFresh: () => fresh,
    compile: async () => {
      log.compiled++;
    },
  };
  return { deps, log };
}

{
  const { deps, log } = setup();
  assert.equal(await ensureOcrBinary(deps), PACKAGED, "a matching prebuilt binary is used");
  assert.equal(log.compiled, 0, "and nothing is compiled");
  assert.deepEqual(log.chmod, [PACKAGED], "npm does not keep the exec bit, so it is set at first use");
}
{
  const { deps, log } = setup({ hashes: { [SOURCE]: "src2", [PACKAGED]: "bin1" } });
  assert.equal(await ensureOcrBinary(deps), COMPILED, "a binary built from an older ocr.swift is not used");
  assert.equal(log.compiled, 1);
  assert.deepEqual(log.chmod, [], "a binary that is not trusted is not made executable");
}
{
  const { deps, log } = setup({ hashes: { [SOURCE]: "src1", [PACKAGED]: "tampered" } });
  assert.equal(await ensureOcrBinary(deps), COMPILED, "a binary whose hash differs from the recorded one is not used");
  assert.equal(log.compiled, 1);
}
{
  const { deps, log } = setup({ files: [] });
  assert.equal(await ensureOcrBinary(deps), COMPILED, "a checkout has no prebuilt binary: compile as before");
  assert.equal(log.compiled, 1);
}
{
  const { deps, log } = setup({ files: [PACKAGED], meta: null });
  assert.equal(await ensureOcrBinary(deps), COMPILED, "a binary with no recorded hashes is not trusted");
  assert.equal(log.compiled, 1);
}
{
  const { deps, log } = setup({ files: [COMPILED], fresh: true });
  assert.equal(await ensureOcrBinary(deps), COMPILED, "an up-to-date compiled binary is reused");
  assert.equal(log.compiled, 0);
}
console.log("test-ocr-binary: ok");
