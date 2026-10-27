#!/usr/bin/env bun
/*
Maintain one dashboard branch-status card per git branch as a feature moves
through the SpecKit cycle (specify -> plan -> tasks -> implement -> review).

The card is a pure YAML file (branches/<slug>.yaml) the agent-os dashboard renders
as a live "Active branches" card. This script is the single deterministic writer:
it rewrites the WHOLE file on every phase transition (never patches in place),
always bumps `updated`, and enforces the status rules so the model never has to
hand-author fiddly YAML.

Each phase carries: status + summary (one line, always shown) + description (a
paragraph shown in the expanded panel) + items (the work list — user stories in
`specify`, tasks in `tasks`/`implement`). `review` also carries substeps (the
review-extension passes) nested directly under phases.review.substeps. Items and
descriptions are preserved across rewrites, so setting specify's user stories once
keeps them through later phases.

Usage (verbs):
  progress_report.ts enter <phase> [--summary S] [--description D] [--items-json J]
      phase active; priors done; laters pending
  progress_report.ts done  <phase> [--summary S] [--description D] [--items-json J]
      phase done (+ all priors done)
  progress_report.ts block <phase> --reason R
      phase blocked; reason -> summary + note
  progress_report.ts set   <phase> [--summary S] [--description D] [--items-json J]
      update a phase's summary/description/items WITHOUT touching any statuses
      (use mid-phase as items flip to done, e.g. implement progress)
  progress_report.ts substep k=v [k=v ...] [--note N]
      review substeps (review -> active)
  progress_report.ts done-all
      all five phases done (card shows "done")

Phases : specify plan tasks implement review
Substeps (review): code arch comments tests errors types simplify pr
Status : done | active | pending | blocked   (nothing else)

--items-json takes a JSON array; each element is an object with keys:
  title (required), id (optional), description (optional),
  status (optional, default pending). It REPLACES the target phase's item list,
  so re-send the full list with updated statuses as work lands. Example:
  --items-json '[{"id":"US1","title":"As a user, I can ...","status":"active"}]'

Common options (all verbs):
  --branch B      default: current git branch (`git rev-parse --abbrev-ref HEAD`)
  --title  T      human label   (default: preserved, else derived from branch)
  --spec   S      feature slug   (default: preserved, else derived from branch)
  --issue  U      GitHub issue or PR URL (e.g. https://github.com/owner/repo/issues/42)
  --dashboard D   dashboard repo (default: $AGENT_OS_DASHBOARD or ~/Code/agent-os)
  --note   N      trailing one-line note

Graceful skip: if <dashboard>/branches does not exist, print a note and exit 0 —
progress reporting must never break the pipeline it observes.

An unknown phase or substep, a malformed k=v pair, or invalid --items-json is a
hard exit 1; an argument error is exit 2 with a usage line on stderr.
*/
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = process.env.HOME || homedir();
const LOG_PATH = join(HOME, "Library/Logs/speckit-autopilot.log");

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(withSeconds: boolean): string {
  const d = new Date();
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** Append a timestamped line to the autopilot log, silently skipping on any error. */
function log(msg: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${stamp(true)} ${msg}\n`);
  } catch {
    // never break the pipeline over a log line
  }
}

const PHASES = ["specify", "plan", "tasks", "implement", "review"] as const;
type Phase = (typeof PHASES)[number];
const SUBSTEPS = ["code", "arch", "comments", "tests", "errors", "types", "simplify", "pr"] as const;
type Substep = (typeof SUBSTEPS)[number];
const STATUSES = new Set(["done", "active", "pending", "blocked"]);
const ITEM_KEYS = new Set(["id", "title", "description", "status"]);

interface Item { id?: string; title?: string; description?: string; status?: string }
interface PhaseState { status: string; summary: string; description?: string; items?: Item[]; substeps?: Record<Substep, string> }
interface State {
  branch: string; title: string; spec: string; issue: string; session: string; note: string;
  phases: Record<Phase, PhaseState>;
}

const isPhase = (s: string): s is Phase => (PHASES as readonly string[]).includes(s);
const isSubstep = (s: string): s is Substep => (SUBSTEPS as readonly string[]).includes(s);

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Python str()/truthiness, so values from YAML/JSON render as the Python writer did.
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}
function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}
const isDict = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- helpers ----
function sh(...args: string[]): string {
  try {
    const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString().trim();
  } catch {
    return "";
  }
}

const currentBranch = () => sh("git", "rev-parse", "--abbrev-ref", "HEAD") || "HEAD";

function slugify(branch: string): string {
  let s = branch.replaceAll("/", "-");
  s = s.replace(/[^A-Za-z0-9._-]+/g, "-");
  return s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

// Python str.title(): a letter is upper-cased after a non-letter, lower-cased otherwise.
const pyTitle = (s: string) => s.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

function humanize(branch: string): string {
  const tail = branch.split("/").at(-1) ?? "";
  return pyTitle(tail.replace(/[-_]+/g, " ").trim()) || branch;
}

function expandUser(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}

const resolveDashboard = (explicit: string | undefined) =>
  expandUser(explicit || process.env.AGENT_OS_DASHBOARD || "~/Code/agent-os");

function blankState(branch: string): State {
  return {
    branch, title: "", spec: "", issue: "", session: "", note: "",
    phases: {
      specify: { status: "pending", summary: "", description: "", items: [] },
      plan: { status: "pending", summary: "", description: "", items: [] },
      tasks: { status: "pending", summary: "", items: [] },
      implement: { status: "pending", summary: "", items: [] },
      review: {
        status: "pending", summary: "",
        substeps: Object.fromEntries(SUBSTEPS.map((s) => [s, "pending"])) as Record<Substep, string>,
      },
    },
  };
}

const valid = (s: string) => (STATUSES.has(s) ? s : "pending");

function unquote(v: string): string {
  v = v.trim();
  if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
  return v.replaceAll('\\"', '"');
}

function normItem(raw: Record<string, unknown>): Item {
  const it: Item = {};
  if (pyTruthy(raw.id)) it.id = pyStr(raw.id).trim();
  it.title = pyStr("title" in raw ? raw.title : "").trim();
  if (pyTruthy(raw.description)) it.description = pyStr(raw.description).trim();
  it.status = valid(pyStr("status" in raw ? raw.status : "pending").trim());
  return it;
}

// ------------------------------------------------------------- read/parse ----
/** Tolerant reader for our own block-style YAML output. Recovers statuses/
 *  summaries/descriptions/items/substeps + meta so a rewrite preserves earlier
 *  phases. A YAML parse failure degrades to the manual line reader. */
function parseCard(text: string, branch: string): State {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch {
    return manualParse(text, branch);
  }
  return fromYamlDict(raw, branch);
}

// `raw.get(k, d) or ""` then str()
const field = (raw: Record<string, unknown>, k: string, d: unknown = "") => {
  const v = k in raw ? raw[k] : d;
  return pyTruthy(v) ? pyStr(v) : "";
};

function fromYamlDict(raw: unknown, branch: string): State {
  if (!isDict(raw)) return blankState(branch);
  const st = blankState(branch);
  st.branch = field(raw, "branch", branch) || branch;
  st.title = field(raw, "title");
  st.spec = field(raw, "spec");
  st.issue = field(raw, "issue");
  st.session = field(raw, "session");
  st.note = field(raw, "note");
  const phasesRaw = pyTruthy(raw.phases) ? raw.phases : {};
  if (isDict(phasesRaw)) {
    for (const p of PHASES) {
      const pr = phasesRaw[p];
      if (!isDict(pr)) continue;
      const ph = st.phases[p];
      ph.status = valid(pyStr("status" in pr ? pr.status : "pending"));
      ph.summary = field(pr, "summary");
      if ("description" in pr) ph.description = field(pr, "description");
      if (Array.isArray(pr.items)) ph.items = pr.items.filter(isDict).map(normItem);
      if (p === "review" && isDict(pr.substeps) && ph.substeps) {
        for (const s of SUBSTEPS) ph.substeps[s] = valid(pyStr(s in pr.substeps ? pr.substeps[s] : "pending"));
      }
    }
  }
  return st;
}

function setItem(item: Item, key: string, val: string): void {
  if (!ITEM_KEYS.has(key)) return;
  if (key === "status") item.status = valid(val.trim());
  else item[key as "id" | "title" | "description"] = unquote(val);
}

/** Line-by-line fallback for text the YAML parser rejects. */
function manualParse(text: string, branch: string): State {
  const st = blankState(branch);
  let curPhase: Phase | null = null;
  let mode: null | "items" | "substeps" = null;
  let curItem: Item | null = null;

  const closeItem = () => {
    if (curItem !== null && curPhase && (curItem.title || curItem.id)) {
      (st.phases[curPhase].items ??= []).push(curItem);
    }
    curItem = null;
  };

  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    const mt = /^(branch|title|spec|issue|session|updated|note):\s*(.*)$/.exec(line);
    if (indent === 0 && mt) {
      closeItem();
      const k = mt[1] ?? "";
      const v = unquote(mt[2] ?? "");
      if (k !== "updated") {
        const key = k as "branch" | "title" | "spec" | "issue" | "session" | "note";
        st[key] = v || st[key];
      }
      curPhase = null; mode = null;
      continue;
    }
    if (indent === 0 && line.startsWith("phases:")) {
      closeItem();
      curPhase = null; mode = null;
      continue;
    }

    const mp = /^([a-z]+):\s*$/.exec(line);
    if (indent === 2 && mp && isPhase(mp[1] ?? "")) {
      closeItem();
      curPhase = mp[1] as Phase; mode = null;
      continue;
    }

    if (!curPhase) continue;

    if (indent === 4) {
      closeItem();
      if (line.startsWith("items:")) { mode = "items"; continue; }
      if (line.startsWith("substeps:")) { mode = "substeps"; continue; }
      mode = null;
      const ms = /^status:\s*(\w+)/.exec(line);
      if (ms) { st.phases[curPhase].status = valid(ms[1] ?? ""); continue; }
      const msum = /^summary:\s*(.*)$/.exec(line);
      if (msum) { st.phases[curPhase].summary = unquote(msum[1] ?? ""); continue; }
      const mdesc = /^description:\s*(.*)$/.exec(line);
      if (mdesc) { st.phases[curPhase].description = unquote(mdesc[1] ?? ""); continue; }
      continue;
    }

    if (mode === "substeps" && curPhase === "review") {
      const mss = /^([a-z]+):\s*(\w+)/.exec(line);
      const ss = st.phases.review.substeps;
      if (mss && isSubstep(mss[1] ?? "") && ss) ss[mss[1] as Substep] = valid(mss[2] ?? "");
      continue;
    }

    if (mode === "items") {
      const mnew = /^-\s+(\w+):\s*(.*)$/.exec(line);
      if (mnew) {
        closeItem();
        const it: Item = {};
        curItem = it;
        setItem(it, mnew[1] ?? "", mnew[2] ?? "");
        continue;
      }
      const mkv = /^(\w+):\s*(.*)$/.exec(line);
      if (mkv && curItem !== null) setItem(curItem, mkv[1] ?? "", mkv[2] ?? "");
      continue;
    }
  }
  closeItem();
  return st;
}

// ---------------------------------------------------------------- render ----
function q(s: string): string {
  const flat = s.split(/\s+/).filter(Boolean).join(" ");
  return '"' + flat.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function renderItems(items: Item[]): string[] {
  const lines = ["    items:"];
  for (const it of items) {
    let first = true;
    const emit = (k: string, v: string, quote: boolean) => {
      lines.push(`${first ? "      - " : "        "}${k}: ${quote ? q(v) : v}`);
      first = false;
    };
    if (it.id) emit("id", it.id, false);
    emit("title", it.title ?? "", true);
    if (it.description) emit("description", it.description, true);
    emit("status", it.status ?? "pending", false);
  }
  return lines;
}

function render(st: State): string {
  const out: string[] = [];
  out.push(`branch: ${st.branch}`);
  out.push(`title: ${st.title || humanize(st.branch)}`);
  if (st.spec) out.push(`spec: ${st.spec}`);
  if (st.issue) out.push(`issue: ${st.issue}`);
  if (st.session) out.push(`session: ${q(st.session)}`);
  out.push(`updated: ${stamp(false)}`);
  out.push(`note: ${st.note ? q(st.note) : '""'}`);
  out.push("");
  out.push("phases:");
  for (const p of PHASES) {
    const ph = st.phases[p];
    out.push(`  ${p}:`);
    out.push(`    status: ${ph.status}`);
    out.push(`    summary: ${ph.summary ? q(ph.summary) : '""'}`);
    if (ph.description !== undefined) out.push(`    description: ${ph.description ? q(ph.description) : '""'}`);
    if (ph.items && ph.items.length) out.push(...renderItems(ph.items));
    if (p === "review") {
      out.push("    substeps:");
      for (const s of SUBSTEPS) out.push(`      ${s}: ${ph.substeps?.[s] ?? "pending"}`);
    }
  }
  return out.join("\n") + "\n";
}

function atomicWrite(path: string, text: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ------------------------------------------------------------------ args ----
const VERBS = ["enter", "done", "block", "set", "substep", "done-all"] as const;
type Verb = (typeof VERBS)[number];
const OPTIONS = ["summary", "description", "items-json", "reason", "note", "branch", "title", "spec", "issue", "session", "dashboard"] as const;
type Opt = (typeof OPTIONS)[number];

interface Args { verb: Verb; rest: string[]; opts: Partial<Record<Opt, string>> }

const PROG = basename(process.argv[1] ?? "progress_report.ts");
const USAGE_PAD = " ".repeat(`usage: ${PROG} `.length);
const USAGE =
  `usage: ${PROG} [-h] [--summary SUMMARY] [--description DESCRIPTION]\n` +
  `${USAGE_PAD}[--items-json ITEMS_JSON] [--reason REASON]\n` +
  `${USAGE_PAD}[--note NOTE] [--branch BRANCH] [--title TITLE]\n` +
  `${USAGE_PAD}[--spec SPEC] [--issue ISSUE] [--session SESSION]\n` +
  `${USAGE_PAD}[--dashboard DASHBOARD]\n` +
  `${USAGE_PAD}{${VERBS.join(",")}} [rest ...]\n`;

function usageError(msg: string): never {
  process.stderr.write(`${USAGE}${PROG}: error: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const opts: Partial<Record<Opt, string>> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (a === "-h" || a === "--help") {
      process.stdout.write(`${USAGE}\nUpdate a dashboard branch-status card.\n`);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      // argparse accepts any unambiguous prefix of a long option
      const hits = OPTIONS.filter((o) => o === name || o.startsWith(name));
      const opt = hits.includes(name as Opt) ? (name as Opt) : hits.length === 1 ? hits[0] : undefined;
      if (!opt) {
        if (hits.length > 1) usageError(`ambiguous option: --${name} could match ${hits.map((h) => "--" + h).join(", ")}`);
        usageError(`unrecognized arguments: ${a}`);
      }
      let val: string | undefined;
      if (eq !== -1) val = a.slice(eq + 1);
      else {
        val = argv[i + 1];
        if (val === undefined || (val.startsWith("-") && val !== "-")) usageError(`argument --${opt}: expected one argument`);
        i++;
      }
      opts[opt] = val;
      continue;
    }
    positionals.push(a);
  }
  const [verb, ...rest] = positionals;
  if (verb === undefined) usageError("the following arguments are required: verb");
  if (!(VERBS as readonly string[]).includes(verb)) {
    usageError(`argument verb: invalid choice: '${verb}' (choose from ${VERBS.map((v) => `'${v}'`).join(", ")})`);
  }
  return { verb: verb as Verb, rest, opts };
}

// ----------------------------------------------------------------- verbs ----
function applyDetail(st: State, phase: Phase, a: Args): void {
  const { summary, description } = a.opts;
  const itemsJson = a.opts["items-json"];
  if (summary) st.phases[phase].summary = summary;
  if (description) st.phases[phase].description = description;
  if (itemsJson !== undefined) {
    let data: unknown;
    try {
      data = JSON.parse(itemsJson);
    } catch (e) {
      die(`error: --items-json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Array.isArray(data)) st.phases[phase].items = data.filter(isDict).map(normItem);
  }
}

function applyVerb(st: State, a: Args, target: string | undefined): State {
  const o = a.opts;
  if (o.title) st.title = o.title;
  if (o.spec) st.spec = o.spec;
  if (o.issue) st.issue = o.issue;
  if (o.session) st.session = o.session;
  if (!st.title) st.title = humanize(st.branch);
  if (!st.spec) st.spec = slugify(st.branch.split("/").at(-1) ?? "");

  const verb = a.verb;
  if (verb === "enter" || verb === "done" || verb === "block" || verb === "set") {
    const phase = target ?? "";
    if (!isPhase(phase)) die(`error: unknown phase '${phase}' (want: ${PHASES.join(", ")})`);
    const idx = PHASES.indexOf(phase);
    if (verb === "enter") {
      PHASES.forEach((p, i) => {
        st.phases[p].status = i < idx ? "done" : i === idx ? "active" : "pending";
      });
      applyDetail(st, phase, a);
    } else if (verb === "done") {
      for (const p of PHASES.slice(0, idx)) st.phases[p].status = "done";
      st.phases[phase].status = "done";
      applyDetail(st, phase, a);
    } else if (verb === "set") {
      applyDetail(st, phase, a);
    } else {
      const reason = o.reason || "blocked";
      st.phases[phase].status = "blocked";
      st.phases[phase].summary = reason;
      st.note = reason;
    }
  } else if (verb === "substep") {
    const review = st.phases.review;
    const ss = (review.substeps ??= Object.fromEntries(SUBSTEPS.map((s) => [s, "pending"])) as Record<Substep, string>);
    for (const pair of a.rest) {
      const eq = pair.indexOf("=");
      if (eq === -1) die(`error: substep needs k=v, got '${pair}'`);
      const k = pair.slice(0, eq);
      if (!isSubstep(k)) die(`error: unknown substep '${k}' (want: ${SUBSTEPS.join(", ")})`);
      ss[k] = valid(pair.slice(eq + 1));
    }
    if (review.status !== "done" && review.status !== "blocked") {
      review.status = "active";
      for (const p of PHASES.slice(0, PHASES.indexOf("review"))) st.phases[p].status = "done";
    }
  } else {
    for (const p of PHASES) st.phases[p].status = "done";
    const ss = (st.phases.review.substeps ??= {} as Record<Substep, string>);
    for (const s of SUBSTEPS) ss[s] = "done";
  }

  if (o.note) st.note = o.note;
  return st;
}

// ------------------------------------------------------------------ main ----
function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const phaseVerb = a.verb === "enter" || a.verb === "done" || a.verb === "block" || a.verb === "set";
  const target = phaseVerb ? a.rest[0] : undefined;
  if (phaseVerb && !target) die(`error: '${a.verb}' needs a phase name`);

  const branch = a.opts.branch || currentBranch();
  log(`[${branch}] ${a.verb} ${a.rest.join(" ")}`);

  const branches = join(resolveDashboard(a.opts.dashboard), "branches");
  let isDir = false;
  try { isDir = statSync(branches).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    const msg = `no dashboard at ${branches} — skipping`;
    console.log(`progress_report: ${msg} (not an error)`);
    log(`[${branch}] SKIP ${msg}`);
    return;
  }

  const slug = slugify(branch);
  // Support reading an existing .md card from a prior format; always write .yaml.
  const yamlPath = join(branches, slug + ".yaml");
  const mdPath = join(branches, slug + ".md");
  const srcPath = existsSync(yamlPath) ? yamlPath : existsSync(mdPath) ? mdPath : null;

  let st: State;
  if (srcPath) {
    try {
      st = parseCard(readFileSync(srcPath, "utf8"), branch);
    } catch (e) {
      const msg = `could not parse ${srcPath} (${e instanceof Error ? e.message : String(e)}); starting fresh`;
      console.log(`progress_report: ${msg}`);
      log(`[${branch}] ERROR ${msg}`);
      st = blankState(branch);
    }
    st.branch = branch;
    // Migrate: remove old .md file after first successful read
    if (srcPath === mdPath) {
      try { unlinkSync(mdPath); } catch { /* ignore */ }
    }
  } else {
    st = blankState(branch);
  }

  st = applyVerb(st, { ...a, opts: { ...a.opts, branch } }, target);
  atomicWrite(yamlPath, render(st));

  const phaseStatuses = PHASES.map((p) => `${p}:${st.phases[p].status}`).join(" | ");
  const reviewSs = st.phases.review.substeps;
  const activeSs = SUBSTEPS.filter((s) => reviewSs?.[s] === "active");
  const ssPart = activeSs.length ? ` substeps:${activeSs.join(",")}` : "";
  log(`[${branch}] OK ${a.verb} ${a.rest.join(" ")} — ${phaseStatuses}${ssPart}`);

  console.log(`progress_report: ${a.verb} -> ${yamlPath}`);
}

main();
