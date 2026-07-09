import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "./entry.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsRoot = resolve(here, "..", ".."); // .../scripts
const tsxBin = join(scriptsRoot, "node_modules", ".bin", "tsx");

describe("isMainModule", () => {
  const savedArgv1 = process.argv[1];
  afterEach(() => {
    process.argv[1] = savedArgv1;
  });

  it("matches through a symlink: entry is the symlinked path, module url is the realpath", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-"));
    const real = join(dir, "real-bin.ts");
    writeFileSync(real, "export {};\n");
    const link = join(dir, "linked-bin.ts");
    symlinkSync(real, link);

    // Reproduces the launch shape: process.argv[1] is the symlink the launcher
    // passed; import.meta.url is Node's realpath-resolved module URL.
    process.argv[1] = link;
    expect(isMainModule(pathToFileURL(realpathSync(real)).href)).toBe(true);
  });

  it("still matches when both sides are the same real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-"));
    const real = join(dir, "bin.ts");
    writeFileSync(real, "export {};\n");
    process.argv[1] = real;
    expect(isMainModule(pathToFileURL(real).href)).toBe(true);
  });

  it("does not match a different file", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "export {};\n");
    writeFileSync(b, "export {};\n");
    process.argv[1] = a;
    expect(isMainModule(pathToFileURL(b).href)).toBe(false);
  });
});

describe("bin run-guard through a symlinked path (integration)", () => {
  it("preflight launched via a symlink still runs main() and produces output", () => {
    // The original bug: launching a bin through a symlinked path skipped main() and
    // exited 0 with NO output. Symlink the real preflight.ts and run it via tsx.
    const dir = mkdtempSync(join(tmpdir(), "entry-run-"));
    const link = join(dir, "preflight-link.ts");
    symlinkSync(join(scriptsRoot, "src", "bin", "preflight.ts"), link);

    // preflight needs no creds to emit its JSON envelope; a non-zero exit is fine —
    // we assert only that it produced output (proving the guard fired).
    let stdout = "";
    try {
      stdout = execFileSync(tsxBin, [link], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // preflight exits non-zero without credentials; capture its stdout envelope.
      stdout = String((err as { stdout?: Buffer | string }).stdout ?? "");
    }
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain("\"ok\"");
  }, 20_000);
});
