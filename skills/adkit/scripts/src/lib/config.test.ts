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
  loadConfig,
  parseConfig,
  PREFERENCE_FIELDS,
  resolveTier,
} from "./config.js";

describe("CONFIG_FIELDS", () => {
  it("lists the exact fields, defaults, and sensitivity, credentials first then preferences", () => {
    expect(CONFIG_FIELDS.map((f) => [f.key, f.default, f.sensitive])).toEqual([
      ["developer_token", "", true],
      ["client_id", "", false],
      ["client_secret", "", true],
      ["refresh_token", "", true],
      ["login_customer_id", "", false],
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
});

describe("buildConfigYamlBody", () => {
  it("emits the header comments, only the present fields quoted in order, then use_proto_plus", () => {
    const values = new Map([
      ["login_customer_id", "1234567890"],
      ["secrets_project", "proj-x"],
    ]);
    expect(buildConfigYamlBody(values)).toBe(
      [
        "# Written by adkit init/render-yaml. Contains secrets — do not commit.",
        "# Explicit flags and env vars still override these values at run time.",
        'login_customer_id: "1234567890"',
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
    const values = new Map([["login_customer_id", ""]]);
    expect(buildConfigYamlBody(values)).not.toContain("login_customer_id");
  });
});

describe("parseConfig", () => {
  it("parses a yaml body into the config shape", () => {
    expect(parseConfig('login_customer_id: "123"\nsecrets_project: "proj-x"\n')).toEqual({
      login_customer_id: "123",
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
      configToValueMap({ secrets_project: "proj-x", login_customer_id: "123", target_customer_id: "" }),
    ).toEqual(
      new Map([
        ["login_customer_id", "123"],
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
