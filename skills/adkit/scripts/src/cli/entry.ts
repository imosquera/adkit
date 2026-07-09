/**
 * Robust "is this module the process entry point?" check for the bin run-guards.
 *
 * The naive guard `import.meta.url === `file://${process.argv[1]}`` compares raw
 * strings. Node resolves an ES module's `import.meta.url` to the file's REALPATH,
 * but `process.argv[1]` is the path exactly as the launcher passed it — so whenever
 * the two differ (which they always do when the skill is reached through a symlink,
 * e.g. `.claude/skills` → `.agents/skills`) the compare fails, `main()` is skipped,
 * and the process exits 0 with no output. Resolving BOTH sides through
 * {@link realpathSync} makes the check symlink-robust.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module whose `import.meta.url` is passed is the script the process
 * was launched with (Node or tsx). Symlink-safe: compares realpaths, not raw paths.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    // A path that can't be resolved (deleted file, odd loader) is not the entry.
    return false;
  }
}
