#!/usr/bin/env bun
// Git extension: install-deps.ts — install a fresh linked worktree's dependencies (issue #51).
//
// The base checkout is the oracle: a directory is installed here only if the same
// directory there already has node_modules/ (or .venv/). The package manager is read
// off the lockfile, never assumed to be npm. Best effort: every path exits 0.
//
// iOS projects: CocoaPods (Podfile.lock), Carthage (Cartfile.resolved), a Swift package
// (Package.swift) and an Xcode app's SwiftPM dependencies (Package.resolved inside its
// .xcodeproj / .xcworkspace). Pods/ and Carthage/Build/ are installed here only if the
// base has them (and they are not committed); a package is resolved when its
// Package.resolved is tracked or the base has .build/. xcodebuild keeps packages in
// DerivedData keyed by the checkout path, so a tracked app Package.resolved is always
// resolved. Mintfile and Brewfile are left alone (machine-wide tools, not per-checkout).
//
// A repo with both (e.g. a React Native app) gets both: the Node / Python installs run
// first, then the iOS steps, because a Podfile may read from node_modules/. A missing
// tool is named and skipped.
//
// Usage: install-deps.ts <worktree-path>     Env: SPECKIT_SKIP_INSTALL=1 skips entirely

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const say = (s: string) => console.error(`[specify] install-deps: ${s}`);
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const arg = process.argv[2] ?? "";
if (!arg || !isDir(arg)) {
  say(`no such worktree '${arg}'; skipping dependency install`);
  process.exit(0);
}
if (process.env.SPECKIT_SKIP_INSTALL === "1") {
  say("SPECKIT_SKIP_INSTALL=1; skipping dependency install");
  process.exit(0);
}
const WT = resolve(arg);

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", WT, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

// Base checkout = the main worktree. Everything after "worktree " (paths may hold spaces).
const first = git("worktree", "list", "--porcelain", "-z").split("\0")[0] || git("worktree", "list", "--porcelain").split("\n")[0] || "";
const BASE = first.startsWith("worktree ") ? first.slice(9) : "";
if (!BASE || !isDir(BASE)) {
  say("could not resolve the base checkout; skipping dependency install");
  process.exit(0);
}
// Physical paths: git reports /private/var/..., the caller usually passes /var/....
if (realpathSync(BASE) === realpathSync(WT)) process.exit(0); // not a linked worktree

// ---- discovery: tracked manifests, deduplicated to their directories ("." for the root)
const dirOf = (f: string) => f.replace(/[^/]+$/, "").replace(/\/$/, "") || ".";
const tracked = git("ls-files").split("\n").filter(Boolean);
const manifestDirs = [...new Set(tracked.filter((f) => /(^|\/)(package\.json|uv\.lock|poetry\.lock)$/.test(f)).map(dirOf))].sort();

// iOS manifests, grouped by directory.
type IosDir = { spm?: boolean; spmResolved?: boolean; pods?: boolean; carthage?: boolean; containers: Set<string> };
const iosDirs = new Map<string, IosDir>();
const at = (rel: string) => iosDirs.get(rel) ?? (iosDirs.set(rel, { containers: new Set() }), iosDirs.get(rel)!);
for (const f of tracked) {
  const base = f.slice(f.lastIndexOf("/") + 1);
  // An app's SwiftPM lockfile lives inside its container:
  //   App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
  //   App.xcworkspace/xcshareddata/swiftpm/Package.resolved
  const segs = f.split("/");
  const k = segs.findIndex((g) => /\.(xcodeproj|xcworkspace)$/.test(g));
  const tail = k < 0 ? "" : segs.slice(k + 1).join("/");
  const app = k >= 0 && (tail === "xcshareddata/swiftpm/Package.resolved" || (segs[k]!.endsWith(".xcodeproj") && tail === "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"));
  if (app) at(segs.slice(0, k).join("/") || ".").containers.add(segs[k]!);
  else if (base === "Package.swift") at(dirOf(f)).spm = true;
  else if (base === "Package.resolved") at(dirOf(f)).spmResolved = true;
  else if (base === "Podfile.lock") at(dirOf(f)).pods = true;
  else if (base === "Cartfile.resolved") at(dirOf(f)).carthage = true;
}
if (!manifestDirs.length && !iosDirs.size) process.exit(0);

const NODE_LOCKS = ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const has = (dir: string, f: string) => existsSync(`${dir}/${f}`) && !isDir(`${dir}/${f}`);

// Nearest ancestor (self first) with a node lockfile: a workspace installs its children
// from the root, and a child's own `npm install` would race the root's pnpm install.
function nodeInstallRoot(rel: string): string {
  for (let r = rel; ; r = dirname(r)) {
    if (NODE_LOCKS.some((l) => has(`${WT}/${r}`, l))) return r;
    if (r === ".") return rel;
  }
}
function planNode(abs: string): string[] {
  if (has(abs, "bun.lockb") || has(abs, "bun.lock")) return ["bun", "install"];
  if (has(abs, "pnpm-lock.yaml")) return ["pnpm", "install", "--frozen-lockfile"];
  if (has(abs, "yarn.lock")) return ["yarn", "install", "--frozen-lockfile"];
  if (has(abs, "package-lock.json")) return ["npm", "ci"];
  return ["npm", "install"];
}

const trackedUnder = (rel: string, sub: string) => {
  const p = rel === "." ? `${sub}/` : `${rel}/${sub}/`;
  return tracked.some((f) => f.startsWith(p));
};
// A shared scheme for `-workspace` (xcodebuild wants one): the workspace's own, else one
// from a project beside it. Undefined when none is tracked; xcodebuild then decides.
function sharedScheme(rel: string, workspace: string): string | undefined {
  const pre = rel === "." ? "" : `${rel}/`;
  const schemes = tracked
    .filter((f) => f.startsWith(pre) && f.endsWith(".xcscheme"))
    .map((f) => f.slice(pre.length).split("/"))
    .filter((p) => p.length === 4 && /\.(xcworkspace|xcodeproj)$/.test(p[0]!) && p[1] === "xcshareddata" && p[2] === "xcschemes");
  const pick = schemes.find((p) => p[0] === workspace) ?? schemes[0];
  return pick?.[3]!.replace(/\.xcscheme$/, "");
}

// A step's phase: 0 = Node / Python, 1 = iOS (after phase 0 everywhere: a Podfile may
// read node_modules/). A directory's steps run in order and stop at the first failure.
type Step = { argv: string[]; phase: 0 | 1 };
const plan: { rel: string; steps: Step[] }[] = [];
const entry = (rel: string) => plan.find((p) => p.rel === rel) ?? (plan.push({ rel, steps: [] }), plan[plan.length - 1]!);
let skippedNoTool = "";
const add = (rel: string, argv: string[], phase: 0 | 1) => {
  if (Bun.which(argv[0]!)) entry(rel).steps.push({ argv, phase });
  else skippedNoTool += ` ${rel}(${argv[0]})`;
};

// ---- Node / Python
const langPlanned = new Set<string>();
for (let rel of manifestDirs) {
  let abs = `${WT}/${rel}`;
  const baseAbs = `${BASE}/${rel}`;
  if (!isDir(abs)) continue;
  let cmd: string[] = [];
  if (has(abs, "package.json")) {
    // pnpm keeps node_modules in both; npm workspaces hoist to the root only.
    const rootRel = nodeInstallRoot(rel);
    if (isDir(`${baseAbs}/node_modules`) || isDir(`${BASE}/${rootRel}/node_modules`)) {
      rel = rootRel;
      abs = `${WT}/${rel}`;
      cmd = planNode(abs);
    }
  } else if (has(abs, "uv.lock") && isDir(`${baseAbs}/.venv`)) cmd = ["uv", "sync"];
  else if (has(abs, "poetry.lock") && isDir(`${baseAbs}/.venv`)) cmd = ["poetry", "install"];
  if (!cmd.length || langPlanned.has(rel)) continue;
  langPlanned.add(rel);
  add(rel, cmd, 0);
}

// ---- iOS
for (const rel of [...iosDirs.keys()].sort()) {
  const d = iosDirs.get(rel)!;
  const baseAbs = `${BASE}/${rel}`;
  if (!isDir(`${WT}/${rel}`)) continue;
  // CocoaPods first: an app workspace references Pods.xcodeproj, so xcodebuild's
  // resolve below needs it. Only where the base checkout installed Pods/ and it is
  // not committed (a committed Pods/ already came with the checkout).
  if (d.pods && isDir(`${baseAbs}/Pods`) && !trackedUnder(rel, "Pods")) add(rel, ["pod", "install"], 1);
  // Carthage: only where the base checkout has built frameworks.
  if (d.carthage && isDir(`${baseAbs}/Carthage/Build`) && !trackedUnder(rel, "Carthage/Build"))
    add(rel, ["carthage", "bootstrap", "--use-xcframeworks"], 1);
  // A Swift package: resolve when the lockfile is tracked or the base has resolved it.
  if (d.spm && (d.spmResolved || isDir(`${baseAbs}/.build`))) add(rel, ["swift", "package", "resolve"], 1);
  // An app: xcodebuild caches packages in DerivedData, keyed by the checkout path, so a
  // new worktree always starts cold. The tracked Package.resolved is the signal.
  if (d.containers.size) {
    const all = [...d.containers].sort();
    const ws = all.find((c) => c.endsWith(".xcworkspace"));
    if (ws) {
      const scheme = sharedScheme(rel, ws);
      add(rel, ["xcodebuild", "-resolvePackageDependencies", "-workspace", ws, ...(scheme ? ["-scheme", scheme] : [])], 1);
    } else for (const proj of all) add(rel, ["xcodebuild", "-resolvePackageDependencies", "-project", proj], 1);
  }
}

if (skippedNoTool) say(`not on PATH, skipped:${skippedNoTool}`);
const todo = plan.filter((p) => p.steps.length);
if (!todo.length) process.exit(0);

// ---- directories run concurrently, phase by phase, a directory's steps in order; one
// line of summary, details only on failure
const show = (st: Step) => st.argv.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ");
const logdir = mkdtempSync(`${tmpdir()}/install-deps-`);
say(`installing dependencies in ${todo.length} director${todo.length === 1 ? "y" : "ies"} ...`);
const failed: (Step | null)[] = todo.map(() => null);
for (const phase of [0, 1] as const) {
  await Promise.all(
    todo.map(async ({ rel, steps }, i) => {
      const mine = steps.filter((s) => s.phase === phase);
      if (failed[i] || !mine.length) return;
      const cwd = resolve(WT, rel);
      const fd = openSync(`${logdir}/${i}.log`, "a");
      try {
        for (const st of mine) {
          try {
            // PWD matches the bash subshell's `cd`, so tools see the logical path.
            const p = Bun.spawn(st.argv, { cwd, env: { ...process.env, PWD: cwd }, stdin: "ignore", stdout: fd, stderr: fd });
            if ((await p.exited) !== 0) return void (failed[i] = st);
          } catch {
            return void (failed[i] = st);
          }
        }
      } finally {
        closeSync(fd);
      }
    }),
  );
}

const ok = todo.filter((_, i) => !failed[i]).map((p) => ` ${p.rel}`).join("");
if (ok) say(`installed:${ok}`);
todo.forEach(({ rel }, i) => {
  const st = failed[i];
  if (!st) return;
  say(`FAILED in ${rel}: ${show(st)} — run it by hand before implementing`);
  let log = "";
  try {
    log = readFileSync(`${logdir}/${i}.log`, "utf8").replace(/\n$/, "");
  } catch {}
  if (log) console.error(log.split("\n").slice(-15).map((l) => `    ${l}`).join("\n"));
});
rmSync(logdir, { recursive: true, force: true });
