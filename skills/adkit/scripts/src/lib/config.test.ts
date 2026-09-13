import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeSecretsPath,
  buildConfigYamlBody,
  CONFIG_FIELDS,
  configToValueMap,
  CREDENTIAL_FIELDS,
  credentialFieldsFor,
  ensureGitignoreEntries,
  ensureGitignoreEntry,
  GITIGNORE_ENTRIES,
  LEGACY_GITIGNORE_ENTRY,
  legacyConfigExists,
  legacyConfigPath,
  legacyDeprecationNotice,
  loadConfig,
  mergeConfigs,
  META_CREDENTIAL_FIELDS,
  META_ENV_OVERRIDES,
  META_PREFERENCE_FIELDS,
  META_PROJECT_YAML_SHAPE,
  META_SECRETS_YAML_SHAPE,
  parseConfig,
  PLATFORM_FIELD,
  preferenceFieldsFor,
  preferencesPath,
  PREFERENCE_FIELDS,
  PROJECT_YAML_SHAPE,
  projectYamlShapeFor,
  projectConfigExists,
  projectConfigPath,
  SECRETS_GITIGNORE_ENTRY,
  SECRETS_YAML_SHAPE,
  secretsExist,
  secretsYamlShapeFor,
  secretsPath,
  resolveBriefsDir,
  resolveIdeasDir,
  resolveMetaSetting,
  resolveReportsDir,
  resolveTier,
  shapeKeepingFields,
  withConfigField,
  writeConfigField,
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

// The split: `adkit.yaml` is committed, `.adkit.secrets.yaml` (or the ADKIT_CONFIG
// path) is not, and a legacy combined `.adkit.yaml` is still read on top of both.
describe("paths, existence, and the merge order (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  const write = (path: string, body: string): void => writeFileSync(path, body);

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

  it("defaults the three paths to the repo root", () => {
    expect(projectConfigPath()).toBe(join(process.cwd(), "adkit.yaml"));
    expect(secretsPath()).toBe(join(process.cwd(), ".adkit.secrets.yaml"));
    expect(legacyConfigPath()).toBe(join(process.cwd(), ".adkit.yaml"));
  });

  // The out-of-repo placement: nothing in the tree can commit it, and it survives
  // into a git worktree (which an ignored root file never does).
  it("ADKIT_CONFIG moves only the secrets file, never the committed one", () => {
    process.env["ADKIT_CONFIG"] = join(dir, "elsewhere", "proj.secrets.yaml");
    expect(secretsPath()).toBe(join(dir, "elsewhere", "proj.secrets.yaml"));
    expect(projectConfigPath()).toBe(join(process.cwd(), "adkit.yaml"));
  });

  it("GOOGLE_ADS_CREDENTIALS is a legacy alias, used when ADKIT_CONFIG is absent", () => {
    process.env["GOOGLE_ADS_CREDENTIALS"] = join(dir, "legacy.yaml");
    expect(secretsPath()).toBe(join(dir, "legacy.yaml"));
  });

  it("ADKIT_CONFIG wins over GOOGLE_ADS_CREDENTIALS when both are set", () => {
    process.env["ADKIT_CONFIG"] = join(dir, "new.yaml");
    process.env["GOOGLE_ADS_CREDENTIALS"] = join(dir, "old.yaml");
    expect(secretsPath()).toBe(join(dir, "new.yaml"));
  });

  it("reports each file's existence independently", () => {
    expect(projectConfigExists()).toBe(false);
    expect(secretsExist()).toBe(false);
    expect(legacyConfigExists()).toBe(false);
    write(projectConfigPath(), 'secrets_project: "proj-x"\n');
    expect(projectConfigExists()).toBe(true);
    expect(secretsExist()).toBe(false);
    write(secretsPath(), 'developer_token: "tok"\n');
    expect(secretsExist()).toBe(true);
  });

  it("loadConfig returns {} when no file exists", () => {
    expect(loadConfig()).toEqual({});
  });

  it("merges the committed preferences with the credentials file", () => {
    write(projectConfigPath(), 'secrets_project: "proj-x"\nreports_dir: "ads/reports"\nmcc_customer_id: "4444444444"\n');
    write(secretsPath(), 'developer_token: "tok"\nrefresh_token: "rtok"\n');
    expect(loadConfig()).toEqual({
      secrets_project: "proj-x",
      reports_dir: "ads/reports",
      mcc_customer_id: "4444444444",
      developer_token: "tok",
      refresh_token: "rtok",
    });
  });

  // Merge order, stated as a rule: adkit.yaml <- secrets <- legacy.
  it("lets the secrets file win over adkit.yaml where they overlap", () => {
    write(projectConfigPath(), 'secrets_project: "from-project"\n');
    write(secretsPath(), 'secrets_project: "from-secrets"\n');
    expect(loadConfig().secrets_project).toBe("from-secrets");
  });

  it("overlays a legacy .adkit.yaml last, so it wins over both", () => {
    write(projectConfigPath(), 'secrets_project: "from-project"\nreports_dir: "ads/reports"\n');
    write(secretsPath(), 'secrets_project: "from-secrets"\ndeveloper_token: "from-secrets"\n');
    write(legacyConfigPath(), 'secrets_project: "from-legacy"\ndeveloper_token: "from-legacy"\n');
    const config = loadConfig();
    expect(config.secrets_project).toBe("from-legacy");
    expect(config.developer_token).toBe("from-legacy");
    // A field the legacy file does not carry still comes through from below it.
    expect(config.reports_dir).toBe("ads/reports");
  });

  // Compatibility: an unmigrated project holds both halves in one file and must
  // behave exactly as it did before the split.
  it("reads an unmigrated project out of the legacy file alone", () => {
    write(legacyConfigPath(), 'developer_token: "tok"\nmcc_customer_id: "4444444444"\nreports_dir: "legacy/reports"\n');
    expect(loadConfig()).toEqual({
      developer_token: "tok",
      mcc_customer_id: "4444444444",
      reports_dir: "legacy/reports",
    });
    expect(resolveReportsDir(null, loadConfig())).toBe("legacy/reports");
  });

  it("treats a malformed layer as absent rather than throwing", () => {
    write(projectConfigPath(), 'secrets_project: "proj-x"\n');
    write(secretsPath(), "not: [valid: yaml");
    expect(loadConfig()).toEqual({ secrets_project: "proj-x" });
  });

  // activeSecretsPath is the READ path: it falls back to the legacy file so an
  // unmigrated project's credentials are still found (and named in error text).
  it("activeSecretsPath prefers the secrets file, falls back to legacy, else names the secrets file", () => {
    expect(activeSecretsPath()).toBe(secretsPath());
    write(legacyConfigPath(), 'developer_token: "tok"\n');
    expect(activeSecretsPath()).toBe(legacyConfigPath());
    write(secretsPath(), 'developer_token: "tok"\n');
    expect(activeSecretsPath()).toBe(secretsPath());
  });

  it("activeSecretsPath honours an explicit override even when the file is absent", () => {
    write(legacyConfigPath(), 'developer_token: "tok"\n');
    process.env["ADKIT_CONFIG"] = join(dir, "elsewhere.yaml");
    expect(activeSecretsPath()).toBe(join(dir, "elsewhere.yaml"));
  });

  it("preferencesPath is adkit.yaml, except on an unmigrated project", () => {
    expect(preferencesPath()).toBe(projectConfigPath());
    write(legacyConfigPath(), 'secrets_project: "proj-x"\n');
    expect(preferencesPath()).toBe(legacyConfigPath());
    write(projectConfigPath(), 'secrets_project: "proj-x"\n');
    expect(preferencesPath()).toBe(projectConfigPath());
  });
});

// The persist path behind the prompted target_customer_id. The temp dir is not a
// git repo, so the guardrail has nothing to say about it.
describe("writeConfigField (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-write-"));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
    delete process.env["GOOGLE_ADS_CREDENTIALS"];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the preference into the committed adkit.yaml, never the secrets file", () => {
    writeFileSync(projectConfigPath(), 'secrets_project: "proj-x"\n');
    writeFileSync(secretsPath(), 'developer_token: "dev-tok"\n');
    writeConfigField("target_customer_id", "1234567890");
    const project = readFileSync(projectConfigPath(), "utf8");
    expect(project).toContain('target_customer_id: "1234567890"');
    expect(project).toContain('secrets_project: "proj-x"');
    // The credential was never merged in — the secrets file is read by nothing here.
    expect(project).not.toContain("dev-tok");
    expect(readFileSync(secretsPath(), "utf8")).toBe('developer_token: "dev-tok"\n');
  });

  it("keeps a Meta project's platform and meta_* fields when writing a preference", () => {
    writeFileSync(projectConfigPath(), 'platform: "meta"\nmeta_page_id: "123"\nreports_dir: "r"\n');
    writeFileSync(secretsPath(), 'meta_access_token: "EAAB-secret"\n');
    writeConfigField("meta_ad_account_id", "act_42");
    expect(readFileSync(projectConfigPath(), "utf8")).toBe(
      buildConfigYamlBody(
        new Map([
          ["platform", "meta"],
          ["meta_ad_account_id", "act_42"],
          ["meta_page_id", "123"],
          ["reports_dir", "r"],
        ]),
        META_PROJECT_YAML_SHAPE,
      ),
    );
    expect(readFileSync(projectConfigPath(), "utf8")).not.toContain("EAAB-secret");
  });

  it("writes a Google project (no platform key) byte-identically to the Google shape", () => {
    writeFileSync(projectConfigPath(), 'secrets_project: "proj-x"\n');
    writeConfigField("target_customer_id", "1234567890");
    expect(readFileSync(projectConfigPath(), "utf8")).toBe(
      buildConfigYamlBody(
        new Map([
          ["target_customer_id", "1234567890"],
          ["secrets_project", "proj-x"],
        ]),
        PROJECT_YAML_SHAPE,
      ),
    );
  });

  // A Google-shaped file (no platform key) saving a Meta field: the key must land,
  // or the prompt that saved it would repeat on every run.
  it("writes a Meta field into a Google-shaped adkit.yaml without dropping the Google fields", () => {
    writeFileSync(projectConfigPath(), 'target_customer_id: "1234567890"\nsecrets_project: "proj-x"\n');
    writeConfigField("meta_ad_account_id", "act_42");
    expect(readFileSync(projectConfigPath(), "utf8")).toBe(
      [
        ...PROJECT_YAML_SHAPE.header,
        'target_customer_id: "1234567890"',
        'secrets_project: "proj-x"',
        'meta_ad_account_id: "act_42"',
      ].join("\n") + "\n",
    );
    expect(loadConfig().meta_ad_account_id).toBe("act_42");
  });

  it("writes a Google field into a Meta adkit.yaml without erasing the Meta fields", () => {
    writeFileSync(projectConfigPath(), 'platform: "meta"\nmeta_ad_account_id: "act_42"\nmeta_page_id: "123"\n');
    writeConfigField("target_customer_id", "1234567890");
    const written = readFileSync(projectConfigPath(), "utf8");
    expect(written).toBe(
      [
        ...META_PROJECT_YAML_SHAPE.header,
        'platform: "meta"',
        'meta_ad_account_id: "act_42"',
        'meta_page_id: "123"',
        'target_customer_id: "1234567890"',
      ].join("\n") + "\n",
    );
  });

  it("keeps a previously saved foreign field on the next write", () => {
    writeFileSync(projectConfigPath(), 'secrets_project: "proj-x"\nmeta_ad_account_id: "act_42"\n');
    writeConfigField("target_customer_id", "1234567890");
    const written = readFileSync(projectConfigPath(), "utf8");
    expect(written).toContain('meta_ad_account_id: "act_42"');
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('secrets_project: "proj-x"');
  });

  it("rewrites a Google file holding only Google keys byte-identically", () => {
    const body = buildConfigYamlBody(
      new Map([
        ["mcc_customer_id", "4444444444"],
        ["target_customer_id", "1234567890"],
        ["secrets_project", "proj-x"],
        ["read_backend", "sdk"],
      ]),
      PROJECT_YAML_SHAPE,
    );
    writeFileSync(projectConfigPath(), body);
    writeConfigField("target_customer_id", "1234567890");
    expect(readFileSync(projectConfigPath(), "utf8")).toBe(body);
  });

  it("keeps writing the legacy combined file on an unmigrated project", () => {
    writeFileSync(legacyConfigPath(), 'developer_token: "dev-tok"\nmcc_customer_id: "4444444444"\n');
    writeConfigField("target_customer_id", "1234567890");
    const written = readFileSync(legacyConfigPath(), "utf8");
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('developer_token: "dev-tok"');
    expect(written).toContain('mcc_customer_id: "4444444444"');
    expect(existsSync(projectConfigPath())).toBe(false);
  });
});

describe("mergeConfigs / withConfigField", () => {
  it("lets later layers win per field, leaving fields they omit alone", () => {
    expect(mergeConfigs([{ secrets_project: "a", reports_dir: "r" }, { secrets_project: "b" }])).toEqual({
      secrets_project: "b",
      reports_dir: "r",
    });
  });

  it("returns {} for no layers", () => {
    expect(mergeConfigs([])).toEqual({});
  });

  it("withConfigField returns a new object rather than mutating", () => {
    const original = { secrets_project: "proj-x" };
    expect(withConfigField(original, "target_customer_id", "1234567890")).toEqual({
      secrets_project: "proj-x",
      target_customer_id: "1234567890",
    });
    expect(original).toEqual({ secrets_project: "proj-x" });
  });
});

describe("legacyDeprecationNotice", () => {
  it("names both files to create and which fields go in each", () => {
    const notice = legacyDeprecationNotice("/repo/.adkit.yaml");
    expect(notice).toContain("/repo/.adkit.yaml");
    expect(notice).toContain(".adkit.secrets.yaml");
    expect(notice).toContain("adkit.yaml");
    expect(notice).toContain("developer_token");
    expect(notice).toContain("reports_dir");
  });
});

describe("ensureGitignoreEntry", () => {
  it("appends the entry to an empty .gitignore", () => {
    expect(ensureGitignoreEntry("", SECRETS_GITIGNORE_ENTRY)).toBe("/.adkit.secrets.yaml\n");
  });

  it("appends the entry after a blank-line separator when content already exists", () => {
    expect(ensureGitignoreEntry("node_modules/\n", SECRETS_GITIGNORE_ENTRY)).toBe(
      "node_modules/\n\n/.adkit.secrets.yaml\n",
    );
  });

  it("is a no-op when the entry is already present", () => {
    const content = "node_modules/\n/.adkit.secrets.yaml\n";
    expect(ensureGitignoreEntry(content, SECRETS_GITIGNORE_ENTRY)).toBe(content);
  });

  it("matches an existing entry regardless of surrounding whitespace", () => {
    const content = "node_modules/\n  /.adkit.secrets.yaml  \n";
    expect(ensureGitignoreEntry(content, SECRETS_GITIGNORE_ENTRY)).toBe(content);
  });

  it("does not match a different entry sharing a substring", () => {
    expect(ensureGitignoreEntry("skills/.adkit.secrets.yaml\n", SECRETS_GITIGNORE_ENTRY)).toBe(
      "skills/.adkit.secrets.yaml\n\n/.adkit.secrets.yaml\n",
    );
  });

  // The legacy entry stays in the set: an unmigrated project's .adkit.yaml still
  // holds credentials, so dropping its protection would expose them.
  it("ensureGitignoreEntries adds both entries, and keeps the legacy one", () => {
    expect(GITIGNORE_ENTRIES).toEqual([SECRETS_GITIGNORE_ENTRY, LEGACY_GITIGNORE_ENTRY]);
    expect(ensureGitignoreEntries("", GITIGNORE_ENTRIES)).toBe("/.adkit.secrets.yaml\n\n/.adkit.yaml\n");
  });

  it("ensureGitignoreEntries adds only what is missing", () => {
    expect(ensureGitignoreEntries("/.adkit.yaml\n", GITIGNORE_ENTRIES)).toBe("/.adkit.yaml\n\n/.adkit.secrets.yaml\n");
  });
});

// The shapes are what keep credentials out of the committed file: the emitter walks
// the shape's fields, so a credential in the value map simply has nowhere to go.
describe("buildConfigYamlBody shapes", () => {
  const everything = new Map([
    ["developer_token", "dev-tok"],
    ["psi_api_key", "psi"],
    ["mcc_customer_id", "4444444444"],
    ["reports_dir", "ads/reports"],
  ]);

  it("PROJECT_YAML_SHAPE emits only preferences, and says the file is safe to commit", () => {
    const body = buildConfigYamlBody(everything, PROJECT_YAML_SHAPE);
    expect(body).toContain('mcc_customer_id: "4444444444"');
    expect(body).toContain('reports_dir: "ads/reports"');
    expect(body).not.toContain("dev-tok");
    expect(body).not.toContain("psi_api_key");
    expect(body).toContain("safe to commit");
    // use_proto_plus belongs to the credentials file the client libraries read.
    expect(body).not.toContain("use_proto_plus");
  });

  it("SECRETS_YAML_SHAPE emits only credentials, and says never to commit it", () => {
    const body = buildConfigYamlBody(everything, SECRETS_YAML_SHAPE);
    expect(body).toContain('developer_token: "dev-tok"');
    expect(body).toContain('psi_api_key: "psi"');
    expect(body).not.toContain("mcc_customer_id");
    expect(body).not.toContain("reports_dir");
    expect(body).toContain("never commit");
    expect(body).toContain("use_proto_plus: true");
  });

  it("configToValueMap can be narrowed to one shape's fields", () => {
    expect(configToValueMap({ developer_token: "tok", reports_dir: "r" }, CREDENTIAL_FIELDS)).toEqual(
      new Map([["developer_token", "tok"]]),
    );
    expect(configToValueMap({ developer_token: "tok", reports_dir: "r" }, PREFERENCE_FIELDS)).toEqual(
      new Map([["reports_dir", "r"]]),
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

  it("accepts a NUMBER config tier, as an unquoted yaml id parses to", () => {
    // `mcc_customer_id: 1234567890` written without quotes is a yaml number.
    // The blank check used to call .trim() straight on it and threw
    // `candidate.trim is not a function`, taking the whole command down.
    expect(resolveTier(null, undefined, 1234567890 as unknown as number)).toBe("1234567890");
    expect(resolveTier(null, 9999999999 as unknown as number, "config")).toBe("9999999999");
  });

  it("does not treat a numeric 0 as a blank tier", () => {
    // `0` is falsy; a truthiness check would skip it and silently fall through.
    expect(resolveTier(null, undefined, 0 as unknown as number)).toBe("0");
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

// Meta parity (plan D2): the Meta fields are a separate set selected by platform;
// every un-suffixed constant and the `google` selectors are exactly today's Google set.
describe("platform-scoped fields and shapes", () => {
  const everything = new Map([
    ["developer_token", "dev-tok"],
    ["psi_api_key", "psi"],
    ["mcc_customer_id", "4444444444"],
    ["read_backend", "sdk"],
    ["reports_dir", "ads/reports"],
    ["platform", "meta"],
    ["meta_access_token", "EAAB-token"],
    ["meta_app_id", "999"],
    ["meta_app_secret", "app-secret"],
    ["meta_ad_account_id", "act_123"],
    ["meta_page_id", "555"],
    ["meta_pixel_id", "777"],
  ]);

  it("google selectors return exactly the existing constants (same references)", () => {
    expect(credentialFieldsFor("google")).toBe(CREDENTIAL_FIELDS);
    expect(preferenceFieldsFor("google")).toBe(PREFERENCE_FIELDS);
    expect(secretsYamlShapeFor("google")).toBe(SECRETS_YAML_SHAPE);
    expect(projectYamlShapeFor("google")).toBe(PROJECT_YAML_SHAPE);
  });

  it("the Google sets carry no Meta field and no platform key", () => {
    const googleKeys = [...CONFIG_FIELDS, ...PROJECT_YAML_SHAPE.fields, ...SECRETS_YAML_SHAPE.fields].map((f) => f.key);
    expect(googleKeys.filter((k) => k === "platform" || k.startsWith("meta_"))).toEqual([]);
  });

  it("Google yaml output is byte-identical even when Meta values are in the map", () => {
    expect(buildConfigYamlBody(everything, PROJECT_YAML_SHAPE)).toBe(
      [
        "# Written by adkit init. Project preferences — safe to commit.",
        "# Credentials live in the git-ignored .adkit.secrets.yaml, never here.",
        "# Explicit flags and env vars still override these values at run time.",
        'mcc_customer_id: "4444444444"',
        'read_backend: "sdk"',
        'reports_dir: "ads/reports"',
      ].join("\n") + "\n",
    );
    expect(buildConfigYamlBody(everything, SECRETS_YAML_SHAPE)).toBe(
      [
        "# Written by adkit init/render-yaml. CREDENTIALS — never commit this file.",
        "# Project preferences live in the committed adkit.yaml, not here.",
        'developer_token: "dev-tok"',
        'psi_api_key: "psi"',
        "use_proto_plus: true",
      ].join("\n") + "\n",
    );
  });

  it("meta credential fields are the token (sensitive), app id, app secret (sensitive) and the shared PSI key (sensitive)", () => {
    expect(credentialFieldsFor("meta")).toBe(META_CREDENTIAL_FIELDS);
    expect(META_CREDENTIAL_FIELDS.map((f) => [f.key, f.sensitive])).toEqual([
      ["meta_access_token", true],
      ["meta_app_id", false],
      ["meta_app_secret", true],
      ["psi_api_key", true],
    ]);
  });

  it("meta preference prompts carry the ids and shared dirs, but not platform or Google-only fields", () => {
    const keys = preferenceFieldsFor("meta").map((f) => f.key);
    expect(preferenceFieldsFor("meta")).toBe(META_PREFERENCE_FIELDS);
    expect(keys).toEqual(["meta_ad_account_id", "meta_page_id", "meta_pixel_id", "secrets_project", "reports_dir", "briefs_dir", "ideas_dir"]);
    expect(PLATFORM_FIELD).toMatchObject({ key: "platform", default: "google", sensitive: false });
  });

  it("the Meta project shape writes platform first and never a credential", () => {
    expect(projectYamlShapeFor("meta")).toBe(META_PROJECT_YAML_SHAPE);
    const body = buildConfigYamlBody(everything, META_PROJECT_YAML_SHAPE);
    expect(body).toBe(
      [
        ...PROJECT_YAML_SHAPE.header,
        'platform: "meta"',
        'meta_ad_account_id: "act_123"',
        'meta_page_id: "555"',
        'meta_pixel_id: "777"',
        'reports_dir: "ads/reports"',
      ].join("\n") + "\n",
    );
    expect(body).not.toContain("EAAB-token");
    expect(body).not.toContain("app-secret");
    expect(body).not.toContain("mcc_customer_id");
  });

  it("the Meta secrets shape writes only the Meta credentials, without use_proto_plus", () => {
    expect(secretsYamlShapeFor("meta")).toBe(META_SECRETS_YAML_SHAPE);
    const body = buildConfigYamlBody(everything, META_SECRETS_YAML_SHAPE);
    expect(body).toBe(
      [
        ...SECRETS_YAML_SHAPE.header,
        'meta_access_token: "EAAB-token"',
        'meta_app_id: "999"',
        'meta_app_secret: "app-secret"',
        'psi_api_key: "psi"',
      ].join("\n") + "\n",
    );
    expect(body).not.toContain("act_123");
    expect(body).not.toContain("developer_token");
  });
});

describe("resolveMetaSetting", () => {
  it("maps each Meta field to its env var", () => {
    expect(META_ENV_OVERRIDES).toEqual({
      meta_access_token: "META_ACCESS_TOKEN",
      meta_ad_account_id: "META_AD_ACCOUNT_ID",
      meta_app_id: "META_APP_ID",
      meta_app_secret: "META_APP_SECRET",
    });
  });

  it("prefers the env var over the yaml value", () => {
    expect(resolveMetaSetting("meta_access_token", { META_ACCESS_TOKEN: "env-tok" }, { meta_access_token: "yaml-tok" })).toBe("env-tok");
    expect(resolveMetaSetting("meta_ad_account_id", { META_AD_ACCOUNT_ID: "act_1" }, { meta_ad_account_id: "act_2" })).toBe("act_1");
  });

  it("falls back to yaml when the env var is blank or absent, else undefined", () => {
    expect(resolveMetaSetting("meta_app_id", { META_APP_ID: "  " }, { meta_app_id: "42" })).toBe("42");
    expect(resolveMetaSetting("meta_app_secret", {}, { meta_app_secret: "s" })).toBe("s");
    expect(resolveMetaSetting("meta_app_secret", {}, {})).toBeUndefined();
  });
});

describe("shapeKeepingFields", () => {
  it("returns the shape itself when the config holds only its own fields", () => {
    expect(shapeKeepingFields(PROJECT_YAML_SHAPE, { secrets_project: "p" }, "target_customer_id")).toBe(PROJECT_YAML_SHAPE);
  });

  it("appends the written key and every foreign field present, once, after the shape's own", () => {
    const shape = shapeKeepingFields(PROJECT_YAML_SHAPE, { platform: "google", meta_page_id: "1" }, "meta_ad_account_id");
    expect(shape.fields.map((f) => f.key)).toEqual([
      ...PROJECT_YAML_SHAPE.fields.map((f) => f.key),
      "platform",
      "meta_ad_account_id",
      "meta_page_id",
    ]);
    expect(shape.header).toEqual(PROJECT_YAML_SHAPE.header);
  });
});
