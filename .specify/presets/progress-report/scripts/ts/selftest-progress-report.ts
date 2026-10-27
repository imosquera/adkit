#!/usr/bin/env bun
// progress-report preset: selftest-progress-report.ts
// Drives progress_report.ts through every phase/substep transition against a
// throwaway dashboard (AGENT_OS_DASHBOARD and HOME both point into a temp dir,
// so neither ~/Code/agent-os nor the real autopilot log is touched) and checks
// exit codes, stdout/stderr, and the generated card.
//
// Usage: bun presets/progress-report/scripts/ts/selftest-progress-report.ts
//   PROGRESS_REPORT_CMD="<cmd> <writer>"  run the cases against another writer
//   SELFTEST_RECORD_DIR=<dir>             also dump each step's normalized
//                                         rc/stdout/stderr/card for diffing

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRITER = join(import.meta.dir, "progress_report.ts");
const CMD = process.env.PROGRESS_REPORT_CMD?.split(" ") ?? ["bun", WRITER];
const RECORD = process.env.SELFTEST_RECORD_DIR;
const WORK = mkdtempSync(join(tmpdir(), "selftest-progress-report-"));
const DASH = join(WORK, "dash");
const BRANCHES = join(DASH, "branches");
const HOME = join(WORK, "home");
mkdirSync(HOME, { recursive: true });
let failures = 0;
let step = 0;

function report(ok: boolean, name: string, detail: string) {
  if (ok) console.log(`PASS: ${name}`);
  else { console.log(`FAIL: ${name} — ${detail}`); failures++; }
}

// Everything that legitimately varies between runs is normalized away.
const norm = (s: string) =>
  s.replaceAll(WORK, "<work>")
    .replace(/^updated: \d{4}-\d\d-\d\d \d\d:\d\d$/m, "updated: <stamp>")
    .replace(/progress_report\.(py|ts)/g, "progress_report")
    .replace(/(--items-json is not valid JSON:).*/, "$1 <detail>");

interface Result { code: number; out: string; err: string; card: string }

async function run(args: string[], branch = "feat/my-cool_feature", slug = "feat-my-cool_feature"): Promise<Result> {
  const full = args.includes("--branch") || args.some((a) => a.startsWith("--branch=")) ? args : [...args, "--branch", branch];
  const p = Bun.spawn([...CMD, ...full], {
    cwd: WORK,
    env: { ...process.env, HOME, AGENT_OS_DASHBOARD: DASH },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  const code = await p.exited;
  const cardPath = join(BRANCHES, slug + ".yaml");
  const card = existsSync(cardPath) ? readFileSync(cardPath, "utf8") : "";
  const r = { code, out: norm(out), err: norm(err), card: norm(card) };
  if (RECORD) {
    mkdirSync(RECORD, { recursive: true });
    const n = String(++step).padStart(2, "0");
    writeFileSync(join(RECORD, `${n}.txt`), `$ ${full.join(" ")}\nrc=${r.code}\n--- stdout\n${r.out}--- stderr\n${r.err}--- card\n${r.card}`);
  }
  return r;
}

// "specify:done plan:active ... | code:done arch:active ..." from a card.
function sig(card: string): string {
  const get = (k: string, indent: string) => new RegExp(`^${indent}${k}:\\n    status: (\\w+)`, "m").exec(card)?.[1] ?? "?";
  const phases = ["specify", "plan", "tasks", "implement", "review"].map((p) => `${p}:${get(p, "  ")}`).join(" ");
  const ss = /    substeps:\n((?:      \w+: \w+\n)+)/.exec(card)?.[1] ?? "";
  const subs = ss.trim().split("\n").map((l) => l.trim().replace(": ", ":")).join(" ");
  return `${phases} | ${subs}`;
}

const P = (s: string) => `specify:${s[0]} plan:${s[1]} tasks:${s[2]} implement:${s[3]} review:${s[4]}`
  .replace(/:d/g, ":done").replace(/:a/g, ":active").replace(/:p/g, ":pending").replace(/:b/g, ":blocked");
const S = (s: string) => ["code", "arch", "comments", "tests", "errors", "types", "simplify", "pr"]
  .map((k, i) => `${k}:${({ d: "done", a: "active", p: "pending", b: "blocked" } as Record<string, string>)[s[i] ?? "p"]}`).join(" ");
const WROTE = "progress_report: {v} -> <work>/dash/branches/feat-my-cool_feature.yaml\n";

async function expect(name: string, args: string[], want: { code?: number; phases?: string; subs?: string; out?: string; err?: string | RegExp; card?: RegExp[] }) {
  const r = await run(args);
  const problems: string[] = [];
  const code = want.code ?? 0;
  if (r.code !== code) problems.push(`rc ${r.code} != ${code}`);
  if (want.out !== undefined && r.out !== want.out) problems.push(`stdout ${JSON.stringify(r.out)}`);
  if (code === 0 && want.out === undefined && r.out !== WROTE.replace("{v}", args[0] ?? "")) problems.push(`stdout ${JSON.stringify(r.out)}`);
  if (want.err === undefined ? r.err !== "" : typeof want.err === "string" ? r.err !== want.err : !want.err.test(r.err)) problems.push(`stderr ${JSON.stringify(r.err)}`);
  if (want.phases) {
    const got = sig(r.card);
    const expected = `${P(want.phases)} | ${S(want.subs ?? "pppppppp")}`;
    if (got !== expected) problems.push(`card\n    got  ${got}\n    want ${expected}`);
  }
  for (const re of want.card ?? []) if (!re.test(r.card)) problems.push(`card lacks ${re}`);
  report(problems.length === 0, name, problems.join("; "));
}

// ------------------------------------------------------------------ cases ----
await expect("no dashboard is a no-op", ["enter", "specify"], {
  out: "progress_report: no dashboard at <work>/dash/branches — skipping (not an error)\n",
});
report(!existsSync(BRANCHES), "no dashboard: nothing created", "branches/ was created");
mkdirSync(BRANCHES, { recursive: true });

const FIRST_CARD = `branch: feat/my-cool_feature
title: My Cool Feature
spec: my-cool_feature
updated: <stamp>
note: ""

phases:
  specify:
    status: active
    summary: ""
    description: ""
  plan:
    status: pending
    summary: ""
    description: ""
  tasks:
    status: pending
    summary: ""
  implement:
    status: pending
    summary: ""
  review:
    status: pending
    summary: ""
    substeps:
      code: pending
      arch: pending
      comments: pending
      tests: pending
      errors: pending
      types: pending
      simplify: pending
      pr: pending
`;
{
  const r = await run(["enter", "specify"]);
  report(r.code === 0 && r.card === FIRST_CARD, "enter specify: exact fresh card", JSON.stringify(r.card));
}
await expect("done specify with quoting, items and detail", [
  "done", "specify",
  "--summary", 'N reqs "quoted" \\back  spaced\nnewline',
  "--description", "Shape — ünïcode",
  "--items-json", '[{"id":"US1","title":"As a \\"user\\" I can","status":"done"},{"title":"no id","description":"d  x","status":"weird"},{"id":0,"title":true},"skip",{"id":"US3"}]',
], {
  phases: "dpppp",
  card: [
    /^    summary: "N reqs \\"quoted\\" \\\\back spaced newline"$/m,
    /^    description: "Shape — ünïcode"$/m,
    /^      - id: US1\n        title: "As a \\"user\\" I can"\n        status: done$/m,
    /^      - title: "no id"\n        description: "d x"\n        status: pending$/m,
    /^      - title: "True"\n        status: pending$/m,
    /^      - id: US3\n        title: ""\n        status: pending$/m,
  ],
});
await expect("enter plan keeps specify items", ["enter", "plan"], { phases: "dappp", card: [/id: US1/] });
await expect("done plan", ["done", "plan", "--summary", "arch"], { phases: "ddppp" });
await expect("enter tasks", ["enter", "tasks"], { phases: "ddapp" });
await expect("done tasks with items", ["done", "tasks", "--summary", "tasks", "--items-json", '[{"id":"T001","title":"a"},{"id":"T002","title":"b","status":"pending"}]'], { phases: "dddpp", card: [/id: T002/] });
await expect("enter implement", ["enter", "implement", "--summary", "0/2"], { phases: "dddap" });
await expect("set implement touches no status", ["set", "implement", "--items-json", '[{"id":"T001","title":"a","status":"done"},{"id":"T002","title":"b","status":"active"}]'], { phases: "dddap" });
await expect("done implement adds description", ["done", "implement", "--summary", "shipped", "--description", "impl desc"], { phases: "ddddp", card: [/^  implement:\n    status: done\n    summary: "shipped"\n    description: "impl desc"$/m] });
await expect("enter review", ["enter", "review"], { phases: "dddda" });
await expect("substep code=active", ["substep", "code=active"], { phases: "dddda", subs: "a" });
await expect("substep code=done arch=active", ["substep", "code=done", "arch=active"], { phases: "dddda", subs: "da" });
await expect("unknown substep is a hard exit", ["substep", "bogus=done"], {
  code: 1, out: "", err: "error: unknown substep 'bogus' (want: code, arch, comments, tests, errors, types, simplify, pr)\n",
});
await expect("substep without = is a hard exit", ["substep", "noeq"], { code: 1, out: "", err: "error: substep needs k=v, got 'noeq'\n" });
await expect("invalid substep status reads pending; --note", ["substep", "comments=weird", "tests=done", "--note", "a note"], {
  phases: "dddda", subs: "dapd", card: [/^note: "a note"$/m],
});
await expect("done review", ["done", "review", "--summary", "pass"], { phases: "ddddd", subs: "dapd" });
await expect("substep after done leaves review done", ["substep", "pr=done"], { phases: "ddddd", subs: "dapdpppd" });
await expect("block plan", ["block", "plan", "--reason", 'gate "x"'], { phases: "dbddd", subs: "dapdpppd", card: [/^note: "gate \\"x\\""$/m, /^  plan:\n    status: blocked\n    summary: "gate \\"x\\""$/m] });
await expect("block without reason", ["block", "tasks"], { phases: "dbbdd", subs: "dapdpppd", card: [/^note: "blocked"$/m] });
await expect("done-all with meta options", ["done-all", "--title", "My Title", "--spec", "my-spec", "--issue", "https://github.com/o/r/issues/4", "--session", "sess 1"], {
  phases: "ddddd", subs: "dddddddd",
  card: [/^title: My Title\nspec: my-spec\nissue: https:\/\/github.com\/o\/r\/issues\/4\nsession: "sess 1"\n/m],
});
await expect("unknown phase is a hard exit", ["enter", "badphase"], { code: 1, out: "", err: "error: unknown phase 'badphase' (want: specify, plan, tasks, implement, review)\n" });
await expect("phase verb without a phase", ["enter"], { code: 1, out: "", err: "error: 'enter' needs a phase name\n" });
await expect("non-list --items-json is ignored", ["set", "review", "--items-json", '{"a":1}'], { phases: "ddddd", subs: "dddddddd" });
await expect("invalid --items-json is a hard exit", ["set", "review", "--items-json", "not json"], { code: 1, out: "", err: "error: --items-json is not valid JSON: <detail>\n" });
await expect("set review items render before substeps", ["set", "review", "--items-json", '[{"title":"r"}]'], { card: [/^    items:\n      - title: "r"\n        status: pending\n    substeps:$/m] });
await expect("unknown verb is a usage error", ["bogusverb"], { code: 2, out: "", err: /error: argument verb: invalid choice: 'bogusverb'/ });
await expect("option missing its value", ["enter", "plan", "--summary"], { code: 2, out: "", err: /error: argument --summary: expected one argument/ });
await expect("prefix and = options", ["set", "plan", "--summ", "prefix opt", "--not=eqnote"], { card: [/^note: "eqnote"$/m, /^  plan:\n    status: done\n    summary: "prefix opt"$/m] });

// slugify / humanize
{
  const r = await run(["enter", "plan"], "weird//Br@nch!!name--x", "weird-Br-nch-name-x");
  report(r.code === 0 && /^title: Br@Nch!!Name X$/m.test(r.card) && /^spec: Br-nch-name-x$/m.test(r.card), "odd branch slug/title", r.card || r.out + r.err);
}
{
  const r = await run(["enter", "plan"], "///", "branch");
  report(r.code === 0 && /^branch: \/\/\/\ntitle: \/\/\/\nspec: branch$/m.test(r.card), "all-slash branch falls back", r.card || r.out + r.err);
}

// legacy .md card, hand-mangled so the YAML parser rejects it and the line reader runs
writeFileSync(join(BRANCHES, "legacy.md"),
  'branch: legacy\ntitle: "Legacy T"\nphases:\n  plan:\n    status: done\n    summary: "old \\"s\\""\n    items:\n      - id: X1\n        title: "t"\n        status: active\n\tbad: [\n');
{
  const r = await run(["enter", "tasks"], "legacy", "legacy");
  report(
    r.code === 0 && !existsSync(join(BRANCHES, "legacy.md")) && /^title: Legacy T$/m.test(r.card) &&
      /^    summary: "old \\"s\\""\n    description: ""\n    items:\n      - id: X1\n        title: "t"\n        status: active$/m.test(r.card),
    "legacy .md migrates via the line reader", r.card || r.out + r.err);
}

// ~ in --dashboard expands against $HOME
mkdirSync(join(HOME, "dash2", "branches"), { recursive: true });
{
  const r = await run(["enter", "plan", "--dashboard", "~/dash2"]);
  report(r.code === 0 && existsSync(join(HOME, "dash2", "branches", "feat-my-cool_feature.yaml")), "~ expands in --dashboard", r.out + r.err);
}
report(readFileSync(join(HOME, "Library/Logs/speckit-autopilot.log"), "utf8").includes("SKIP no dashboard"), "log written under $HOME", "no SKIP line");

rmSync(WORK, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
