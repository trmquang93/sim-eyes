// Builds bin/ocr (universal arm64 + x86_64, ad-hoc signed) and bin/ocr.json for the npm package. Run by prepublishOnly.
// ocr.mjs only trusts the binary while both hashes in bin/ocr.json still match, so a stale build is never run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_MACOS = "13.0";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function tool(name, args) {
  try {
    return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error(`build-ocr: ${name} ${args.join(" ")} failed: ${err.code === "ENOENT" ? `${name} is not installed (Xcode command line tools)` : err.stderr || err.message}`);
    process.exit(1);
  }
}

const source = join(root, "ocr.swift");
const out = join(root, "bin");
mkdirSync(out, { recursive: true });
const slices = ["arm64", "x86_64"].map((arch) => {
  const path = join(out, `ocr-${arch}`);
  tool("swiftc", ["-O", "-target", `${arch}-apple-macos${MIN_MACOS}`, source, "-o", path]);
  return path;
});
const binary = join(out, "ocr");
tool("lipo", ["-create", ...slices, "-output", binary]);
slices.forEach((p) => rmSync(p));
tool("codesign", ["--force", "--sign", "-", binary]);

const archs = tool("lipo", ["-archs", binary]).trim().split(/\s+/).sort();
if (archs.join(" ") !== "arm64 x86_64") {
  console.error(`build-ocr: expected a universal binary, got ${archs.join(" ")}`);
  process.exit(1);
}
tool("codesign", ["--verify", "--strict", binary]);
writeFileSync(join(out, "ocr.json"), JSON.stringify({ sourceSha256: sha256(source), sha256: sha256(binary), target: `universal-macos${MIN_MACOS}` }, null, 2) + "\n");
console.log(`build-ocr: bin/ocr (${archs.join(" + ")}, macOS ${MIN_MACOS}+, ad-hoc signed)`);
