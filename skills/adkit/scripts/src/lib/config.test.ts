import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfigYamlBody, CONFIG_FIELDS, configExists, configPath, loadConfig, parseConfig, resolveTier } from "./config.js";

describe("CONFIG_FIELDS", () => {
  it("lists the exact fields, labels, and defaults in emit order", () => {
    expect(CONFIG_FIELDS.map((f) => [f.key, f.default])).toEqual([
      ["login_customer_id", ""],
      ["target_customer_id", ""],
      ["secrets_project", "your-project-prod"],
      ["read_backend", "sdk"],
      ["reports_dir", "ads/output/reports"],
      ["briefs_dir", "adbriefs"],
      ["ideas_dir", "ideas/processed"],
    ]);
  });
});

describe("buildConfigYamlBody", () => {
  it("emits the header comments and only the present fields, quoted, in order", () => {
    const values = new Map([
      ["login_customer_id", "1234567890"],
      ["secrets_project", "proj-x"],
    ]);
    expect(buildConfigYamlBody(values)).toBe(
      [
        "# Written by adkit init. Reusable project defaults — no secrets.",
        "# Explicit flags and env vars still override these values at run time.",
        'login_customer_id: "1234567890"',
        'secrets_project: "proj-x"',
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

describe("configPath / configExists / loadConfig (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-config-"));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env["ADKIT_CONFIG"];
  });

  it("defaults configPath to .adkit.yaml under the cwd", () => {
    expect(configPath()).toBe(join(process.cwd(), ".adkit.yaml"));
  });

  it("ADKIT_CONFIG overrides the default path", () => {
    process.env["ADKIT_CONFIG"] = join(dir, "custom.yaml");
    expect(configPath()).toBe(join(dir, "custom.yaml"));
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
