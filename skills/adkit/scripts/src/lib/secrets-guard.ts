/**
 * The guardrail that keeps credentials off a committable path.
 *
 * Before anything writes a file carrying credential fields, the target path is
 * judged against git: a path git does not ignore, or one git already tracks, is
 * refused outright — loudly, naming the path, the reason, and the fix — rather than
 * silently downgraded to somewhere else.
 *
 * This is not hypothetical. A vendored skill commonly lives at
 * `.claude/skills/adkit` -> `.agents/skills/adkit`, and "put the secrets next to
 * adkit, which is gitignored" is a natural-sounding, wrong instinct: those trees are
 * committed (hundreds of tracked files), so the file would be committed on the next
 * `git add` — and wiped whenever the vendored skill is reinstalled. The third check
 * catches exactly that shape.
 *
 * The three checks, in order:
 *  1. `git check-ignore --no-index <path>` — not ignored? **refuse** (`not-ignored`).
 *  2. `git ls-files --error-unmatch <path>` — already tracked? **refuse**
 *     (`already-tracked`), without overwriting it.
 *  3. an ancestor directory (below the repo root) that itself holds tracked files?
 *     **warn** loudly, naming that ancestor.
 *
 * A path outside any git work tree — the recommended `~/.config/adkit/…` placement —
 * passes every check: there is nothing there that could commit it.
 *
 * The decision is a pure function of {@link GitFacts}; the git shell-outs that
 * gather those facts are isolated in {@link gitFactsFor}.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Everything the decision needs to know about a path's relationship to git. */
export interface GitFacts {
  /** Whether the path lies inside a git work tree at all. `false` short-circuits every check. */
  readonly inRepo: boolean;
  /** The work tree's root, when {@link inRepo}. */
  readonly repoRoot: string | null;
  /** `git check-ignore` says the path is ignored. */
  readonly ignored: boolean;
  /** `git ls-files --error-unmatch` says the path is already tracked. */
  readonly tracked: boolean;
  /** The nearest ancestor directory BELOW the repo root that itself contains tracked files, if any. */
  readonly trackedAncestor: string | null;
}

/** Why a path was refused, or flagged. */
export type SecretsPathReason = "not-ignored" | "already-tracked" | "tracked-ancestor";

/** The envelope `step` every refusal reports under. */
export const SECRETS_PATH_STEP = "secrets-path";

/** The verdict on one candidate secrets path. */
export type SecretsPathVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "warn"; readonly reason: "tracked-ancestor"; readonly message: string }
  | { readonly kind: "refuse"; readonly reason: "not-ignored" | "already-tracked"; readonly message: string };

/** The out-of-repo placement suggested in every refusal, since it is the one that cannot go wrong. */
const OUT_OF_REPO_FIX =
  "or keep the credentials outside the repo entirely: " +
  "`export ADKIT_CONFIG=~/.config/adkit/<project>.secrets.yaml` (nothing in the tree can commit it, " +
  "and it survives into git worktrees)";

/** A path relative to the repo root when we know one, else the path itself — what a `.gitignore` line or a `git rm` would name. */
function repoRelative(path: string, repoRoot: string | null): string {
  return repoRoot ? relative(repoRoot, path) : path;
}

/**
 * Judge a candidate credentials path. Pure — the caller supplies the git facts.
 *
 * The check order is the issue's: "not ignored" is reported before "already
 * tracked" because it is the commoner mistake and the cheaper fix, and both are
 * reachable (a tracked file that also matches a `.gitignore` pattern still reports
 * as ignored, so it falls through to the tracked check).
 */
export function judgeSecretsPath(path: string, facts: GitFacts): SecretsPathVerdict {
  if (!facts.inRepo) {
    return { kind: "ok" };
  }
  const rel = repoRelative(path, facts.repoRoot);
  if (!facts.ignored) {
    // When the path is ALSO tracked, say so here rather than making the operator
    // rediscover it on the next run: ignoring it afterwards does not untrack it.
    const alsoTracked = facts.tracked
      ? ` git already tracks this file too, so its contents are in the repo's history: run ` +
        `\`git rm --cached ${rel}\` and rotate every credential it has carried.`
      : "";
    return {
      kind: "refuse",
      reason: "not-ignored",
      message:
        `refusing to write credentials to ${path}: git does not ignore that path, so the next ` +
        `\`git add\` would commit your ads credentials. Fix: add \`/${rel}\` to .gitignore, ${OUT_OF_REPO_FIX}. ` +
        `Nothing was written.${alsoTracked}`,
    };
  }
  if (facts.tracked) {
    return {
      kind: "refuse",
      reason: "already-tracked",
      message:
        `refusing to write credentials to ${path}: git already tracks that file, so its contents are ` +
        `in the repo's history. Fix: \`git rm --cached ${rel}\`, add \`/${rel}\` to .gitignore, and rotate every ` +
        `credential that file has already carried — ${OUT_OF_REPO_FIX}. Nothing was written, and the ` +
        "existing file was left untouched.",
    };
  }
  if (facts.trackedAncestor !== null) {
    return {
      kind: "warn",
      reason: "tracked-ancestor",
      message:
        `WARNING: ${path} sits inside ${facts.trackedAncestor}, a directory whose files are committed. ` +
        "The path is git-ignored today, but one .gitignore edit commits it — and reinstalling whatever " +
        `vendors that directory deletes it. Prefer the repo root's ${basename(path)}, ${OUT_OF_REPO_FIX}.`,
    };
  }
  return { kind: "ok" };
}

/** Run a git command in `cwd`, reporting only whether it succeeded and what it printed. */
function git(args: readonly string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * `path` with its nearest EXISTING ancestor directory resolved through any symlinks,
 * and the not-yet-created segments re-appended.
 *
 * Needed because git reports a work-tree root in real-path form (`/private/var/…` on
 * macOS, where `/var` is a symlink), and the ancestor walk below compares the two by
 * string prefix. A path whose parent directory does not exist yet is a normal case:
 * the out-of-repo placement is typically `~/.config/adkit/…` before that directory
 * has ever been created.
 */
function realpathish(path: string): string {
  const abs = resolve(path);
  const missing: string[] = [];
  let cursor = dirname(abs);
  while (!existsSync(cursor) && dirname(cursor) !== cursor) {
    missing.unshift(basename(cursor));
    cursor = dirname(cursor);
  }
  const real = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return join(real, ...missing, basename(abs));
}

/** The directories between `from` (inclusive) and `stopAt` (exclusive), nearest first. */
function ancestorsBelow(from: string, stopAt: string): string[] {
  const chain: string[] = [];
  let cursor = from;
  while (cursor !== stopAt && cursor !== dirname(cursor)) {
    chain.push(cursor);
    cursor = dirname(cursor);
  }
  // Ran past the root without meeting it — the path is not under `stopAt` at all.
  return cursor === stopAt ? chain : [];
}

/**
 * Gather the git facts for `path` by shelling out. All IO lives here.
 *
 * Every command runs from the nearest existing ancestor of `path`, not the process
 * cwd, so the answer is about the repo that would actually contain the file. A path
 * in no repo comes back with `inRepo: false` and nothing else consulted.
 */
export function gitFactsFor(path: string): GitFacts {
  const target = realpathish(path);
  const dir = ((): string => {
    let cursor = dirname(target);
    while (!existsSync(cursor) && dirname(cursor) !== cursor) {
      cursor = dirname(cursor);
    }
    return cursor;
  })();
  const root = git(["rev-parse", "--show-toplevel"], dir);
  if (!root.ok) {
    return { inRepo: false, repoRoot: null, ignored: false, tracked: false, trackedAncestor: null };
  }
  const repoRoot = realpathish(root.stdout.trim());
  // `--no-index` asks purely about the ignore rules. Without it git refuses to call
  // a TRACKED path ignored, however the rules read — which would collapse the two
  // refusals into one and hide the more serious "already in the history" case.
  const ignored = git(["check-ignore", "-q", "--no-index", "--", target], repoRoot).ok;
  const tracked = git(["ls-files", "--error-unmatch", "--", target], repoRoot).ok;
  // A directory counts as tracked when it holds tracked files. The repo root itself
  // is excluded — it holds tracked files in every real repo, so including it would
  // fire the warning on the ordinary repo-root placement and mean nothing.
  const trackedAncestor =
    ancestorsBelow(dirname(target), repoRoot).find((ancestor) => git(["ls-files", "--", ancestor], repoRoot).stdout.trim() !== "") ?? null;
  return { inRepo: true, repoRoot, ignored, tracked, trackedAncestor };
}

/** Thrown when a credentials write targets a committable path. Carries the envelope fields verbatim. */
export class SecretsPathError extends Error {
  readonly step = SECRETS_PATH_STEP;
  constructor(
    message: string,
    readonly path: string,
    readonly reason: SecretsPathReason,
  ) {
    super(message);
  }
}

/**
 * Judge `path` against the live repo: throw {@link SecretsPathError} on a refusal,
 * return the warning text when the path is merely suspicious, `null` when it is
 * fine. For call sites that would rather branch than catch, use
 * {@link judgeSecretsPath} with {@link gitFactsFor} directly.
 */
export function assertWritableSecretsPath(path: string): string | null {
  const verdict = judgeSecretsPath(path, gitFactsFor(path));
  if (verdict.kind === "refuse") {
    throw new SecretsPathError(verdict.message, path, verdict.reason);
  }
  return verdict.kind === "warn" ? verdict.message : null;
}

/**
 * The read-side counterpart: the warning to print when a secrets file that is
 * ALREADY in use sits on a committable path, or `null` when it does not.
 *
 * Deliberately never fatal. A run is not made safer by refusing to read a file that
 * already exists, and the recommended out-of-repo placement makes `check-ignore`
 * meaningless anyway — there the facts come back `inRepo: false` and nothing is
 * said. The wording is the read side's own: the write-side text ends in "nothing
 * was written", which would be a lie here.
 */
export function secretsReadWarning(path: string, facts: GitFacts = gitFactsFor(path)): string | null {
  const verdict = judgeSecretsPath(path, facts);
  if (verdict.kind === "ok") {
    return null;
  }
  const rel = repoRelative(path, facts.repoRoot);
  if (verdict.reason === "not-ignored") {
    return (
      `WARNING: ${path} holds credentials and git does NOT ignore it — the next \`git add\` would ` +
      `commit your ads credentials. Add \`/${rel}\` to .gitignore, ${OUT_OF_REPO_FIX}.`
    );
  }
  if (verdict.reason === "already-tracked") {
    return (
      `WARNING: ${path} holds credentials and git already TRACKS it — its contents are in the repo's ` +
      `history. Run \`git rm --cached ${rel}\`, add \`/${rel}\` to .gitignore, and rotate every credential ` +
      "that file has carried."
    );
  }
  return verdict.message;
}
