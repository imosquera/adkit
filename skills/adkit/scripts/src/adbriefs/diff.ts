/**
 * Pure brief diffing: compare the on-disk brief against a proposed one and render a
 * human-readable, line-based diff of their stable YAML serialization. This is the
 * "show the diff before applying" gate both `/adkit create` and `/adkit update` use.
 *
 * No I/O — `diffBriefs` is a pure function of two briefs (or `null` current, meaning
 * "no prior brief", which renders as an all-added diff).
 */

import { serializeBrief } from "./store.js";
import type { Brief } from "../lib/schema.js";

/**
 * The result of comparing two briefs. `changed` is the single fact both commands
 * gate on (FR-007: a no-op change → `changed === false`, empty render); `added` /
 * `removed` count the line deltas; `render` is the unified-diff-style text.
 */
export interface BriefDiff {
  changed: boolean;
  added: number;
  removed: number;
  render: string;
}

/**
 * Longest-common-subsequence table over two line arrays. Pure; returns the classic
 * DP matrix used to walk out a minimal add/remove diff.
 */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/** A single diff line: kept context (` `), removed (`-`), or added (`+`). */
type DiffOp = readonly [" " | "-" | "+", string];

/**
 * Walk the LCS table into an ordered op list. Pure — builds a new array, never
 * mutates its inputs.
 */
function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const table = lcsLengths(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]!]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push(["-", a[i]!]);
      i++;
    } else {
      ops.push(["+", b[j]!]);
      j++;
    }
  }
  while (i < a.length) ops.push(["-", a[i++]!]);
  while (j < b.length) ops.push(["+", b[j++]!]);
  return ops;
}

/**
 * Diff the current brief (or `null` for "none yet") against a proposed brief. Only
 * changed lines and a little surrounding context are rendered, so a small edit shows
 * a small, scoped diff (FR-009).
 */
export function diffBriefs(current: Brief | null, proposed: Brief): BriefDiff {
  const currentLines = current === null ? [] : serializeBrief(current).split("\n");
  const proposedLines = serializeBrief(proposed).split("\n");
  const ops = diffOps(currentLines, proposedLines);

  const added = ops.filter(([tag]) => tag === "+").length;
  const removed = ops.filter(([tag]) => tag === "-").length;
  if (added === 0 && removed === 0) {
    return { changed: false, added: 0, removed: 0, render: "" };
  }

  // Keep up to 2 lines of context around each changed hunk; elide long unchanged runs.
  const CONTEXT = 2;
  const keep = ops.map(([tag]) => tag !== " ");
  const withContext = keep.map((isChange, idx) => {
    if (isChange) return true;
    for (let d = 1; d <= CONTEXT; d++) {
      if (keep[idx - d] || keep[idx + d]) return true;
    }
    return false;
  });

  const rendered: string[] = [];
  let elided = false;
  ops.forEach(([tag, line], idx) => {
    if (withContext[idx]) {
      rendered.push(`${tag} ${line}`);
      elided = false;
    } else if (!elided) {
      rendered.push("  …");
      elided = true;
    }
  });

  return { changed: true, added, removed, render: rendered.join("\n") };
}
