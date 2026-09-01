import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildConfigYamlBody,
  CONFIG_FIELDS,
  configExists,
  configPath,
  configToValueMap,
  CREDENTIAL_FIELDS,
  ensureGitignoreEntry,
  GITIGNORE_ENTRY,
  loadConfig,
  parseConfig,
  PREFERENCE_FIELDS,
  resolveBriefsDir,
  resolveIdeasDir,
  resolveReportsDir,
  resolveTier,
} from "./config.js";

describe("CONFIG_FIELDS", () => {
  it("lists the exact fields, defaults, and sensitivity, credentials first then preferences", () => {
    expect(CONFIG_FIELDS.map((f) => [f.key, f.default, f.sensitive])).toEqual([
      ["developer_token", "", true],
      ["client_id", "", false],
      ["client_secret", "", true],
      ["refresh_token", "", true],
      ["psi_api_key", "", true],
      ["mcc_customer_id", "", false],
      ["target_customer_id", "", false],
      ["secrets_project", "your-project-prod", false],
      ["read_backend", "sdk", false],
      ["reports_dir", "ads/output/reports", false],
      ["briefs_dir", "adbriefs", false],
      ["ideas_dir", "ideas/processed", false],
    ]);
  });

  it("is exactly CREDENTIAL_FIELDS followed by PREFERENCE_FIELDS", () => {
    expect(CONFIG_FIELDS).toEqual([...CREDENTIAL_FIELDS, ...PREFERENCE_FIELDS]);
  });

  // The two customer ids are account numbers, not credentials: they belong to the
  // locally-authored preferences, never to the set render-yaml pulls from Secret Manager.
  it("classifies both customer ids as preferences, not credentials", () => {
    const keys = (fields: readonly { key: string }[]) => fields.map((f) => f.key);
    expect(keys(PREFERENCE_FIELDS)).toContain("mcc_customer_id");
    expect(keys(PREFERENCE_FIELDS)).toContain("target_customer_id");
    expect(keys(CREDENTIAL_FIELDS)).not.toContain("mcc_customer_id");
    expect(keys(CREDENTIAL_FIELDS)).not.toContain("target_customer_id");
  });
});

describe("buildConfigYamlBody", () => {
  it("emits the header comments, only the present fields quoted in order, then use_proto_plus", () => {
    const values = new Map([
      ["mcc_customer_id", "1234567890"],
      ["secrets_project", "proj-x"],
    ]);
    expect(buildConfigYamlBody(values)).toBe(
      [
        "# Written by adkit init/render-yaml. Contains secrets — do not commit.",
        "# Explicit flags and env vars still override these values at run time.",
        'mcc_customer_id: "1234567890"',
        'secrets_project: "proj-x"',
        "use_proto_plus: true",
      ].join("\n") + "\n",
    );
  });

  it("escapes double quotes in a value", () => {
    const values = new Map([["secrets_project", 'has "quotes"']]);
    expect(buildConfigYamlBody(values)).toContain('secrets_project: "has \\"quotes\\""');
  });

  it("skips blank values", () => {
    const values = new Map([["mcc_customer_id", ""]]);
    expect(buildConfigYamlBody(values)).not.toContain("mcc_customer_id");
  });
});

describe("parseConfig", () => {
  it("parses a yaml body into the config shape", () => {
    expect(parseConfig('mcc_customer_id: "123"\nsecrets_project: "proj-x"\n')).toEqual({
      mcc_customer_id: "123",
      secrets_project: "proj-x",
    });
  });

  it("returns {} for an empty document", () => {
    expect(parseConfig("")).toEqual({});
  });
});

describe("configToValueMap", () => {
  it("keeps only non-blank fields, in CONFIG_FIELDS order", () => {
    expect(
      configToValueMap({ secrets_project: "proj-x", mcc_customer_id: "123", target_customer_id: "" }),
    ).toEqual(
      new Map([
        ["mcc_customer_id", "123"],
        ["secrets_project", "proj-x"],
      ]),
    );
  });

  it("returns an empty map for {}", () => {
    expect(configToValueMap({})).toEqual(new Map());
  });
});

describe("configPath / configExists / loadConfig (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-config-"));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
    delete process.env["GOOGLE_ADS_CREDENTIALS"];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env["ADKIT_CONFIG"];
    delete process.env["GOOGLE_ADS_CREDENTIALS"];
  });

  it("defaults configPath to .adkit.yaml under the cwd", () => {
    expect(configPath()).toBe(join(process.cwd(), ".adkit.yaml"));
  });

  it("ADKIT_CONFIG overrides the default path", () => {
    process.env["ADKIT_CONFIG"] = join(dir, "custom.yaml");
    expect(configPath()).toBe(join(dir, "custom.yaml"));
  });

  it("GOOGLE_ADS_CREDENTIALS is a legacy alias, used when ADKIT_CONFIG is absent", () => {
    process.env["GOOGLE_ADS_CREDENTIALS"] = join(dir, "legacy.yaml");
    expect(configPath()).toBe(join(dir, "legacy.yaml"));
  });

  it("ADKIT_CONFIG wins over GOOGLE_ADS_CREDENTIALS when both are set", () => {
    process.env["ADKIT_CONFIG"] = join(dir, "new.yaml");
    process.env["GOOGLE_ADS_CREDENTIALS"] = join(dir, "legacy.yaml");
    expect(configPath()).toBe(join(dir, "new.yaml"));
  });

  it("configExists is false with no file and true once written", () => {
    expect(configExists()).toBe(false);
    writeFileSync(configPath(), 'secrets_project: "proj-x"\n');
    expect(configExists()).toBe(true);
  });

  it("loadConfig returns {} when the file is absent", () => {
    expect(loadConfig()).toEqual({});
  });

  it("loadConfig reads the written config", () => {
    writeFileSync(configPath(), 'secrets_project: "proj-x"\nread_backend: "mcp"\n');
    expect(loadConfig()).toEqual({ secrets_project: "proj-x", read_backend: "mcp" });
  });

  it("loadConfig returns {} for unreadable/malformed yaml rather than throwing", () => {
    writeFileSync(configPath(), "not: [valid: yaml");
    expect(loadConfig()).toEqual({});
  });
});

describe("ensureGitignoreEntry", () => {
  it("appends the entry to an empty .gitignore", () => {
    expect(ensureGitignoreEntry("", GITIGNORE_ENTRY)).toBe("/.adkit.yaml\n");
  });

  it("appends the entry after a blank-line separator when content already exists", () => {
    expect(ensureGitignoreEntry("node_modules/\n", GITIGNORE_ENTRY)).toBe("node_modules/\n\n/.adkit.yaml\n");
  });

  it("is a no-op when the entry is already present", () => {
    const content = "node_modules/\n/.adkit.yaml\n";
    expect(ensureGitignoreEntry(content, GITIGNORE_ENTRY)).toBe(content);
  });

  it("matches an existing entry regardless of surrounding whitespace", () => {
    const content = "node_modules/\n  /.adkit.yaml  \n";
    expect(ensureGitignoreEntry(content, GITIGNORE_ENTRY)).toBe(content);
  });

  it("does not match a different entry sharing a substring", () => {
    expect(ensureGitignoreEntry("skills/.adkit.yaml\n", GITIGNORE_ENTRY)).toBe(
      "skills/.adkit.yaml\n\n/.adkit.yaml\n",
    );
  });
});

describe("resolveTier", () => {
  it("prefers the flag over env, config, and fallback", () => {
    expect(resolveTier("flag", "env", "config", "fallback")).toBe("flag");
  });

  it("prefers env over config and fallback when there is no flag", () => {
    expect(resolveTier(null, "env", "config", "fallback")).toBe("env");
    expect(resolveTier(undefined, "env", "config", "fallback")).toBe("env");
  });

  it("prefers config over fallback when there is no flag or env", () => {
    expect(resolveTier(null, undefined, "config", "fallback")).toBe("config");
  });

  it("falls back when nothing else resolves", () => {
    expect(resolveTier(null, undefined, undefined, "fallback")).toBe("fallback");
  });

  it("returns undefined when nothing resolves and there is no fallback", () => {
    expect(resolveTier(null, undefined, undefined)).toBeUndefined();
  });

  it("treats blank/whitespace-only tiers as absent", () => {
    expect(resolveTier("  ", "env", "config", "fallback")).toBe("env");
    expect(resolveTier(null, "  ", "config", "fallback")).toBe("config");
    expect(resolveTier(null, undefined, "  ", "fallback")).toBe("fallback");
  });
});

// The three output directories were declared, prompted for by `init`, and read by
// nothing — setting them in .adkit.yaml moved no file (issue #69). These lock in that
// each one is actually honoured, through the same flag -> env -> yaml -> default chain
// as every other setting, AND that an unset project still lands on the old paths.
describe("resolveReportsDir / resolveBriefsDir / resolveIdeasDir", () => {
  const ENV_KEYS = ["ADKIT_REPORTS_DIR", "ADKIT_BRIEFS_DIR", "ADKIT_IDEAS_DIR"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // The whole point of the defaults: an existing project that sets none of these keeps
  // writing exactly where it wrote before the settings were honoured.
  it("falls back to the historical hard-coded paths when nothing is set", () => {
    expect(resolveReportsDir(null, {})).toBe("ads/output/reports");
    expect(resolveBriefsDir(null, {})).toBe("adbriefs");
    expect(resolveIdeasDir(null, {})).toBe("ideas/processed");
  });

  it("reads the yaml tier", () => {
    expect(resolveReportsDir(null, { reports_dir: "ads/reports" })).toBe("ads/reports");
    expect(resolveBriefsDir(null, { briefs_dir: "ads/briefs" })).toBe("ads/briefs");
    expect(resolveIdeasDir(null, { ideas_dir: "ads/ideas" })).toBe("ads/ideas");
  });

  it("prefers the env var over the yaml tier", () => {
    process.env["ADKIT_REPORTS_DIR"] = "env/reports";
    process.env["ADKIT_BRIEFS_DIR"] = "env/briefs";
    process.env["ADKIT_IDEAS_DIR"] = "env/ideas";
    expect(resolveReportsDir(null, { reports_dir: "yaml/reports" })).toBe("env/reports");
    expect(resolveBriefsDir(null, { briefs_dir: "yaml/briefs" })).toBe("env/briefs");
    expect(resolveIdeasDir(null, { ideas_dir: "yaml/ideas" })).toBe("env/ideas");
  });

  it("prefers an explicit flag over both", () => {
    process.env["ADKIT_REPORTS_DIR"] = "env/reports";
    expect(resolveReportsDir("flag/reports", { reports_dir: "yaml/reports" })).toBe("flag/reports");
  });

  // Blank/whitespace is "absent", not "the empty directory" — otherwise a key left
  // blank by `init` would resolve every path to the repo root.
  it("treats a blank value as absent and falls through", () => {
    expect(resolveBriefsDir("   ", { briefs_dir: "" })).toBe("adbriefs");
  });

  // The prompt `init` shows and the fallback the resolver uses must not drift apart.
  it("matches the defaults PREFERENCE_FIELDS prompts with", () => {
    const promptDefault = (key: string) => PREFERENCE_FIELDS.find((f) => f.key === key)!.default;
    expect(promptDefault("reports_dir")).toBe(resolveReportsDir(null, {}));
    expect(promptDefault("briefs_dir")).toBe(resolveBriefsDir(null, {}));
    expect(promptDefault("ideas_dir")).toBe(resolveIdeasDir(null, {}));
  });
});
