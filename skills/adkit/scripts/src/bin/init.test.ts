import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doneLine, existsLine, gitignoredLine, main, promptFor } from "./init.js";

/** Collect what `main` writes to stdout (the JSON envelope, the notices) for the duration of one call. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { text: () => chunks.join(""), restore: () => void (process.stdout.write = original) };
}

describe("promptFor", () => {
  it("shows the default inline when one is present", () => {
    expect(promptFor("Read backend (sdk|mcp)", "sdk")).toBe("Read backend (sdk|mcp) [sdk]: ");
  });

  it("omits the bracketed default when there isn't one", () => {
    expect(promptFor("Default target/leaf customer id", "")).toBe("Default target/leaf customer id: ");
  });
});

describe("messages", () => {
  it("formats the completion, already-exists, and gitignored lines", () => {
    expect(doneLine("/a/adkit.yaml")).toBe("wrote /a/adkit.yaml\n");
    expect(existsLine("/a/adkit.yaml")).toBe(
      "/a/adkit.yaml already exists — leaving it in place. Edit it directly, or delete it and rerun init.\n",
    );
    expect(gitignoredLine(["/.adkit.secrets.yaml", "/.adkit.yaml"], "/a/.gitignore")).toBe(
      "added /.adkit.secrets.yaml, /.adkit.yaml to /a/.gitignore\n",
    );
  });
});

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

describe("main (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-init-"));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env["ADKIT_CONFIG"];
    vi.mocked(createInterface).mockReset();
  });

  /** Answers are consumed in field order via the async-iterator protocol `promptAll` reads from. */
  function mockAnswers(answers: string[]): void {
    let i = 0;
    vi.mocked(createInterface).mockImplementation(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (i >= answers.length) {
                return { value: undefined, done: true };
              }
              const value = answers[i];
              i += 1;
              return { value, done: false };
            },
          }),
          close: () => {},
        }) as unknown as ReturnType<typeof createInterface>,
    );
  }

  /** Answers for every field: 5 credentials then 7 preferences. */
  const ALL_BLANK = ["", "", "", "", "", "", "", "", "", "", "", ""];

  it("writes the preferences to adkit.yaml and the credentials to .adkit.secrets.yaml", async () => {
    // developer_token, client_id, client_secret, refresh_token, psi_api_key,
    // mcc_customer_id, target_customer_id, secrets_project, read_backend,
    // reports_dir, briefs_dir, ideas_dir
    mockAnswers(["dev-tok", "cid", "csecret", "rtok", "", "1234567890", "", "proj-x", "", "", "", ""]);
    const code = await main();
    expect(code).toBe(0);

    const project = readFileSync(join(dir, "adkit.yaml"), "utf8");
    expect(project).toContain('mcc_customer_id: "1234567890"');
    expect(project).toContain('secrets_project: "proj-x"');
    expect(project).toContain('read_backend: "sdk"');
    expect(project).toContain('reports_dir: "ads/output/reports"');
    expect(project).not.toContain("target_customer_id");

    const secrets = readFileSync(join(dir, ".adkit.secrets.yaml"), "utf8");
    expect(secrets).toContain('developer_token: "dev-tok"');
    expect(secrets).toContain('client_id: "cid"');
    expect(secrets).toContain('client_secret: "csecret"');
    expect(secrets).toContain('refresh_token: "rtok"');
    expect(secrets).toContain("use_proto_plus: true");
    expect(secrets).not.toContain("psi_api_key");

    // The whole point of the split: no credential in the committed file, no
    // preference in the git-ignored one.
    expect(project).not.toContain("dev-tok");
    expect(project).not.toContain("csecret");
    expect(secrets).not.toContain("proj-x");
    expect(secrets).not.toContain("reports_dir");
  });

  it("writes the credentials file 0600 and the committed file world-readable", async () => {
    mockAnswers(ALL_BLANK);
    await main();
    expect(statSync(join(dir, ".adkit.secrets.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "adkit.yaml")).mode & 0o777).toBe(0o644);
  });

  it("writes psi_api_key to the secrets file when answered (issue #40)", async () => {
    mockAnswers(["dev-tok", "cid", "csecret", "rtok", "psi-key-value", "1234567890", "", "proj-x", "", "", "", ""]);
    expect(await main()).toBe(0);
    expect(readFileSync(join(dir, ".adkit.secrets.yaml"), "utf8")).toContain('psi_api_key: "psi-key-value"');
    expect(readFileSync(join(dir, "adkit.yaml"), "utf8")).not.toContain("psi_api_key");
  });

  it("ADKIT_CONFIG moves the credentials out of the repo, leaving adkit.yaml at the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adkit-outside-"));
    process.env["ADKIT_CONFIG"] = join(outside, "proj.secrets.yaml");
    mockAnswers(["dev-tok", "cid", "csecret", "rtok", "", "", "", "proj-x", "", "", "", ""]);
    expect(await main()).toBe(0);
    expect(readFileSync(join(outside, "proj.secrets.yaml"), "utf8")).toContain('developer_token: "dev-tok"');
    expect(readFileSync(join(dir, "adkit.yaml"), "utf8")).toContain('secrets_project: "proj-x"');
    expect(existsSync(join(dir, ".adkit.secrets.yaml"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("prompts only for the missing half when one file already exists", async () => {
    writeFileSync(join(dir, ".adkit.secrets.yaml"), 'developer_token: "already-here"\n');
    // Seven answers: the preferences only. A credential prompt would consume one of
    // these and shift every value, so the assertions below pin the field order too.
    mockAnswers(["1234567890", "", "proj-x", "", "", "", ""]);
    expect(await main()).toBe(0);
    const project = readFileSync(join(dir, "adkit.yaml"), "utf8");
    expect(project).toContain('mcc_customer_id: "1234567890"');
    expect(project).toContain('secrets_project: "proj-x"');
    expect(readFileSync(join(dir, ".adkit.secrets.yaml"), "utf8")).toBe('developer_token: "already-here"\n');
  });

  it("leaves both existing files untouched and asks nothing", async () => {
    writeFileSync(join(dir, "adkit.yaml"), 'secrets_project: "already-here"\n');
    writeFileSync(join(dir, ".adkit.secrets.yaml"), 'developer_token: "already-here"\n');
    mockAnswers([]);
    expect(await main()).toBe(0);
    expect(readFileSync(join(dir, "adkit.yaml"), "utf8")).toBe('secrets_project: "already-here"\n');
    expect(readFileSync(join(dir, ".adkit.secrets.yaml"), "utf8")).toBe('developer_token: "already-here"\n');
    expect(createInterface).not.toHaveBeenCalled();
  });

  // Compatibility: an unmigrated project is left exactly as it is, and told what to
  // create by hand. There is deliberately no automated migration.
  it("leaves a legacy .adkit.yaml alone and prints the deprecation notice", async () => {
    writeFileSync(join(dir, ".adkit.yaml"), 'developer_token: "dev-tok"\nsecrets_project: "proj-x"\n');
    mockAnswers([]);
    const out = captureStdout();
    expect(await main()).toBe(0);
    out.restore();
    expect(readFileSync(join(dir, ".adkit.yaml"), "utf8")).toBe('developer_token: "dev-tok"\nsecrets_project: "proj-x"\n');
    expect(existsSync(join(dir, "adkit.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".adkit.secrets.yaml"))).toBe(false);
    expect(createInterface).not.toHaveBeenCalled();
    expect(out.text()).toContain(".adkit.secrets.yaml");
    expect(out.text()).toContain("deprecated");
  });

  it("creates .gitignore with both entries when none exists", async () => {
    mockAnswers(ALL_BLANK);
    await main();
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("/.adkit.secrets.yaml\n\n/.adkit.yaml\n");
  });

  it("appends the missing entries to an existing .gitignore", async () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    mockAnswers(ALL_BLANK);
    await main();
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n\n/.adkit.secrets.yaml\n\n/.adkit.yaml\n",
    );
  });

  it("leaves an already-protecting .gitignore untouched", async () => {
    const content = "node_modules/\n/.adkit.secrets.yaml\n/.adkit.yaml\n";
    writeFileSync(join(dir, ".gitignore"), content);
    mockAnswers(ALL_BLANK);
    await main();
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(content);
  });

  it("retrofits gitignore protection even when the config already exists", async () => {
    writeFileSync(join(dir, "adkit.yaml"), 'secrets_project: "already-here"\n');
    writeFileSync(join(dir, ".adkit.secrets.yaml"), 'developer_token: "already-here"\n');
    mockAnswers([]);
    await main();
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("/.adkit.secrets.yaml\n\n/.adkit.yaml\n");
  });
});

// The guardrail as `init` surfaces it: a refusal is the standard ok:false envelope,
// and nothing is prompted for or written.
describe("main (inside a real git repo)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "adkit-init-git-")));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env["ADKIT_CONFIG"];
    vi.mocked(createInterface).mockReset();
  });

  it("refuses a credentials path git does not ignore, writing nothing", async () => {
    // The vendored-skill shape: a directory inside the repo that .gitignore does not
    // cover. `init` writes its .gitignore at the repo root, which protects
    // /.adkit.secrets.yaml — not this one.
    mkdirSync(join(dir, ".agents", "skills", "adkit"), { recursive: true });
    const target = join(dir, ".agents", "skills", "adkit", ".adkit.secrets.yaml");
    process.env["ADKIT_CONFIG"] = target;
    const out = captureStdout();
    const code = await main();
    out.restore();
    expect(code).toBe(1);
    const envelope = JSON.parse(out.text().slice(out.text().indexOf("{")));
    expect(envelope.ok).toBe(false);
    expect(envelope.step).toBe("secrets-path");
    expect(envelope.reason).toBe("not-ignored");
    expect(envelope.message).toContain(target);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, "adkit.yaml"))).toBe(false);
  });
});
