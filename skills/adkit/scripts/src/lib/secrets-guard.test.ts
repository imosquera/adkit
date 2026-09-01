import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWritableSecretsPath,
  type GitFacts,
  gitFactsFor,
  judgeSecretsPath,
  SecretsPathError,
  secretsReadWarning,
} from "./secrets-guard.js";

const facts = (overrides: Partial<GitFacts> = {}): GitFacts => ({
  inRepo: true,
  repoRoot: "/repo",
  ignored: true,
  tracked: false,
  trackedAncestor: null,
  ...overrides,
});

describe("judgeSecretsPath", () => {
  // The recommended placement: ~/.config/adkit/<project>.secrets.yaml is in no work
  // tree, so there is nothing there that could ever commit it.
  it("allows a path outside any git repo", () => {
    expect(judgeSecretsPath("/home/me/.config/adkit/proj.secrets.yaml", facts({ inRepo: false, repoRoot: null, ignored: false }))).toEqual({
      kind: "ok",
    });
  });

  it("allows an ignored path at the repo root", () => {
    expect(judgeSecretsPath("/repo/.adkit.secrets.yaml", facts())).toEqual({ kind: "ok" });
  });

  it("refuses a path git does not ignore, naming the path and the .gitignore fix", () => {
    const verdict = judgeSecretsPath("/repo/config/.adkit.secrets.yaml", facts({ ignored: false }));
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind !== "refuse") return;
    expect(verdict.reason).toBe("not-ignored");
    expect(verdict.message).toContain("/repo/config/.adkit.secrets.yaml");
    expect(verdict.message).toContain("/config/.adkit.secrets.yaml");
    expect(verdict.message).toContain("ADKIT_CONFIG");
    expect(verdict.message).toContain("Nothing was written");
  });

  it("refuses an already-tracked path, and says to rotate what it carried", () => {
    const verdict = judgeSecretsPath("/repo/.agents/skills/adkit/.adkit.secrets.yaml", facts({ tracked: true }));
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind !== "refuse") return;
    expect(verdict.reason).toBe("already-tracked");
    expect(verdict.message).toContain("git rm --cached .agents/skills/adkit/.adkit.secrets.yaml");
    expect(verdict.message).toContain("rotate");
    expect(verdict.message).toContain("left untouched");
  });

  // Order matters: a not-ignored path is reported as not-ignored even if it is also
  // tracked — that is the commoner mistake and the cheaper fix.
  it("reports not-ignored before already-tracked when both hold, and mentions the tracking", () => {
    const verdict = judgeSecretsPath("/repo/x.yaml", facts({ ignored: false, tracked: true }));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("not-ignored");
    expect(verdict.kind === "refuse" && verdict.message).toContain("git rm --cached x.yaml");
  });

  it("warns — but does not refuse — for an ignored path under a tracked ancestor", () => {
    const verdict = judgeSecretsPath("/repo/.agents/skills/adkit/.adkit.secrets.yaml", facts({ trackedAncestor: "/repo/.agents/skills/adkit" }));
    expect(verdict.kind).toBe("warn");
    if (verdict.kind !== "warn") return;
    expect(verdict.reason).toBe("tracked-ancestor");
    expect(verdict.message).toContain("/repo/.agents/skills/adkit");
    expect(verdict.message).toContain("reinstalling");
  });
});

describe("secretsReadWarning", () => {
  it("says nothing about a path outside a repo, or an ignored one", () => {
    expect(secretsReadWarning("/home/me/.config/adkit/p.secrets.yaml", facts({ inRepo: false, repoRoot: null, ignored: false }))).toBeNull();
    expect(secretsReadWarning("/repo/.adkit.secrets.yaml", facts())).toBeNull();
  });

  // The read side never fails a run — a file that already exists is not made safer
  // by refusing to read it — so the wording is a warning, not a refusal.
  it("warns about a not-ignored file without claiming nothing was written", () => {
    const warning = secretsReadWarning("/repo/.adkit.secrets.yaml", facts({ ignored: false }));
    expect(warning).toContain("WARNING");
    expect(warning).toContain("does NOT ignore it");
    expect(warning).not.toContain("Nothing was written");
    expect(warning).not.toContain("refusing");
  });

  it("warns about a tracked file, naming the git rm and the rotation", () => {
    const warning = secretsReadWarning("/repo/creds.yaml", facts({ tracked: true }));
    expect(warning).toContain("git rm --cached creds.yaml");
    expect(warning).toContain("rotate");
  });
});

// The live git probes. Each test builds a throwaway repo, because the whole point
// of the guard is what `git check-ignore` and `git ls-files` actually say.
describe("gitFactsFor / assertWritableSecretsPath (real repos)", () => {
  let dir: string;

  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "adkit-guard-")));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a path outside any repo as inRepo: false, and allows it", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "adkit-outside-")));
    const target = join(outside, "nested", "proj.secrets.yaml");
    expect(gitFactsFor(target).inRepo).toBe(false);
    // Not even the directory exists yet — the common case for ~/.config/adkit.
    expect(assertWritableSecretsPath(target)).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows the repo-root secrets file once .gitignore covers it", () => {
    writeFileSync(join(dir, ".gitignore"), "/.adkit.secrets.yaml\n");
    const target = join(dir, ".adkit.secrets.yaml");
    const probed = gitFactsFor(target);
    expect(probed.ignored).toBe(true);
    expect(probed.trackedAncestor).toBeNull();
    expect(assertWritableSecretsPath(target)).toBeNull();
  });

  it("throws SecretsPathError for a path .gitignore does not cover", () => {
    const target = join(dir, ".adkit.secrets.yaml");
    expect(gitFactsFor(target).ignored).toBe(false);
    expect(() => assertWritableSecretsPath(target)).toThrow(SecretsPathError);
    try {
      assertWritableSecretsPath(target);
    } catch (exc) {
      expect(exc).toBeInstanceOf(SecretsPathError);
      expect((exc as SecretsPathError).reason).toBe("not-ignored");
      expect((exc as SecretsPathError).step).toBe("secrets-path");
      expect((exc as SecretsPathError).path).toBe(target);
    }
  });

  it("throws for a file git already tracks, even when .gitignore now lists it", () => {
    const target = join(dir, "creds.yaml");
    writeFileSync(target, "developer_token: committed-by-mistake\n");
    git("add", "creds.yaml");
    git("commit", "-qm", "oops");
    // Ignoring a file after the fact does not untrack it — that is exactly why the
    // tracked check exists behind the ignore check.
    writeFileSync(join(dir, ".gitignore"), "/creds.yaml\n");
    const probed = gitFactsFor(target);
    expect(probed.ignored).toBe(true);
    expect(probed.tracked).toBe(true);
    expect(() => assertWritableSecretsPath(target)).toThrow(/already tracks/);
    // And the file it refused to write is still exactly as it was.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim()).toBe("?? .gitignore");
  });

  // The case from the issue: a vendored skill tree that "looks gitignored" but is
  // committed wholesale — 110 tracked files under .agents/, 181 under .claude/.
  it("warns about an ignored file inside a committed vendored-skill tree", () => {
    mkdirSync(join(dir, ".agents", "skills", "adkit"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "adkit", "SKILL.md"), "# vendored\n");
    git("add", ".agents");
    git("commit", "-qm", "vendor the skill");
    writeFileSync(join(dir, ".gitignore"), ".adkit.secrets.yaml\n");

    const target = join(dir, ".agents", "skills", "adkit", ".adkit.secrets.yaml");
    const probed = gitFactsFor(target);
    expect(probed.ignored).toBe(true);
    expect(probed.tracked).toBe(false);
    expect(probed.trackedAncestor).toBe(join(dir, ".agents", "skills", "adkit"));

    const warning = assertWritableSecretsPath(target);
    expect(warning).toContain(join(dir, ".agents", "skills", "adkit"));
    expect(warning).toContain("committed");
  });

  // And the same tree without the .gitignore line — the actual "put it next to
  // adkit, which is gitignored" proposal, which is refused outright.
  it("refuses a path in that tree when nothing ignores it", () => {
    mkdirSync(join(dir, ".agents", "skills", "adkit"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "adkit", "SKILL.md"), "# vendored\n");
    git("add", ".agents");
    git("commit", "-qm", "vendor the skill");
    const target = join(dir, ".agents", "skills", "adkit", ".adkit.secrets.yaml");
    expect(() => assertWritableSecretsPath(target)).toThrow(/does not ignore/);
  });

  // The repo root always holds tracked files; treating it as a "tracked ancestor"
  // would fire this warning on every ordinary project and mean nothing.
  it("does not count the repo root itself as a tracked ancestor", () => {
    writeFileSync(join(dir, "README.md"), "# repo\n");
    git("add", "README.md");
    git("commit", "-qm", "init");
    writeFileSync(join(dir, ".gitignore"), "/.adkit.secrets.yaml\n");
    expect(gitFactsFor(join(dir, ".adkit.secrets.yaml")).trackedAncestor).toBeNull();
  });

  it("does not warn about an ignored directory that holds no tracked files", () => {
    writeFileSync(join(dir, ".gitignore"), "/secrets/\n");
    mkdirSync(join(dir, "secrets"));
    const target = join(dir, "secrets", "adkit.secrets.yaml");
    const probed = gitFactsFor(target);
    expect(probed.ignored).toBe(true);
    expect(probed.trackedAncestor).toBeNull();
    expect(assertWritableSecretsPath(target)).toBeNull();
  });
});
