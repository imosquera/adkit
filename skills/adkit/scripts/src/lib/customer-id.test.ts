import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, preferencesPath, projectConfigPath, writeConfigField } from "./config.js";
import {
  InvalidCustomerIdError,
  MissingTargetCustomerIdError,
  managerRequiredHint,
  parseCustomerId,
  requireTargetCustomerId,
  resolveOptionalMccCustomerId,
  type CustomerId,
  type TargetCustomerIdDeps,
} from "./customer-id.js";

describe("parseCustomerId", () => {
  it("accepts a bare 10-digit id", () => {
    expect(parseCustomerId("target_customer_id", "1234567890")).toEqual({ ok: true, value: "1234567890" });
  });

  it("strips the dashes a human reads off the Ads UI", () => {
    expect(parseCustomerId("target_customer_id", " 123-456-7890 ")).toEqual({ ok: true, value: "1234567890" });
  });

  it("treats blank/absent as no value at this tier, not an error", () => {
    expect(parseCustomerId("target_customer_id", "")).toBeNull();
    expect(parseCustomerId("target_customer_id", "   ")).toBeNull();
    expect(parseCustomerId("target_customer_id", undefined)).toBeNull();
    expect(parseCustomerId("target_customer_id", null)).toBeNull();
  });

  // "say what was wrong with what was typed" — not a generic "invalid".
  it("names the too-short case and echoes what was typed", () => {
    const parsed = parseCustomerId("target_customer_id", "12345");
    expect(parsed).toMatchObject({ ok: false });
    expect((parsed as { message: string }).message).toContain('"12345"');
    expect((parsed as { message: string }).message).toContain("too short");
    expect((parsed as { message: string }).message).toContain("5 digits");
  });

  it("names the too-long case", () => {
    const parsed = parseCustomerId("target_customer_id", "12345678901");
    expect((parsed as { message: string }).message).toContain("too long");
    expect((parsed as { message: string }).message).toContain("11 digits");
  });

  it("names non-digit characters separately from a length problem", () => {
    const parsed = parseCustomerId("GOOGLE_ADS_CUSTOMER_ID", "12345abcde");
    expect((parsed as { message: string }).message).toContain("non-digit");
    expect((parsed as { message: string }).message).toContain("GOOGLE_ADS_CUSTOMER_ID");
  });
});

/** Deps with every effect stubbed; individual tests override what they exercise. */
function deps(over: Partial<TargetCustomerIdDeps> = {}): TargetCustomerIdDeps {
  return {
    flag: null,
    env: {},
    config: {},
    configPath: "/tmp/.adkit.yaml",
    isTty: false,
    prompt: async () => "",
    persist: () => {},
    notify: () => {},
    ...over,
  };
}

describe("requireTargetCustomerId", () => {
  it("prefers the flag, then the env, then the config", async () => {
    const all = { flag: "1111111111", env: { GOOGLE_ADS_CUSTOMER_ID: "2222222222" }, config: { target_customer_id: "3333333333" } };
    expect(await requireTargetCustomerId(deps(all))).toBe("1111111111");
    expect(await requireTargetCustomerId(deps({ ...all, flag: null }))).toBe("2222222222");
    expect(await requireTargetCustomerId(deps({ ...all, flag: null, env: {} }))).toBe("3333333333");
  });

  it("dash-strips whatever tier supplied it", async () => {
    expect(await requireTargetCustomerId(deps({ config: { target_customer_id: "111-111-1111" } }))).toBe("1111111111");
  });

  // Test 3: no TTY (CI, a pipe) must fail loudly and must never prompt.
  it("throws a named, actionable error without prompting when there is no TTY", async () => {
    const prompt = vi.fn(async () => "1234567890");
    const persist = vi.fn();
    await expect(
      requireTargetCustomerId(deps({ isTty: false, prompt, persist, configPath: "/repo/.adkit.yaml" })),
    ).rejects.toThrow(MissingTargetCustomerIdError);
    expect(prompt).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("names the field, the config path, and the one-line fix in the no-TTY error", async () => {
    const err = await requireTargetCustomerId(deps({ configPath: "/repo/.adkit.yaml" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTargetCustomerIdError);
    const missing = err as MissingTargetCustomerIdError;
    expect(missing.field).toBe("target_customer_id");
    expect(missing.configPath).toBe("/repo/.adkit.yaml");
    expect(missing.step).toBe("customer-id");
    expect(missing.message).toContain("target_customer_id");
    expect(missing.message).toContain("/repo/.adkit.yaml");
    expect(missing.message).toContain("ads.sh init");
  });

  // Test 4 (unit half): on a TTY it asks once, validates, and hands the answer to persist.
  it("prompts on a TTY, validates the answer, and persists it", async () => {
    const prompt = vi.fn(async () => "123-456-7890");
    const persist = vi.fn();
    const notify = vi.fn();
    const id = await requireTargetCustomerId(deps({ isTty: true, prompt, persist, notify }));
    expect(id).toBe("1234567890");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("1234567890");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("target_customer_id"));
  });

  it("rejects a malformed typed answer and persists nothing", async () => {
    const persist = vi.fn();
    await expect(
      requireTargetCustomerId(deps({ isTty: true, prompt: async () => "12345", persist })),
    ).rejects.toThrow(InvalidCustomerIdError);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not prompt when a tier already supplied an id", async () => {
    const prompt = vi.fn(async () => "9999999999");
    expect(await requireTargetCustomerId(deps({ isTty: true, prompt, config: { target_customer_id: "1234567890" } }))).toBe(
      "1234567890",
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("reports a malformed env value against the env var, not against a flag never passed", async () => {
    const err = await requireTargetCustomerId(
      deps({ env: { GOOGLE_ADS_CUSTOMER_ID: "nope" } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidCustomerIdError);
    expect((err as Error).message).toContain("GOOGLE_ADS_CUSTOMER_ID");
    expect((err as Error).message).not.toContain("--customer-id");
  });
});

// Test 5: absent is a legitimate answer — a directly-accessible account has no manager.
describe("resolveOptionalMccCustomerId", () => {
  it("returns null when no tier carries one, without prompting or throwing", () => {
    expect(resolveOptionalMccCustomerId(null, {}, {}, "/repo/.adkit.yaml")).toBeNull();
  });

  it("prefers the flag, then the env, then the config", () => {
    const env = { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2222222222" };
    const config = { mcc_customer_id: "3333333333" };
    expect(resolveOptionalMccCustomerId("1111111111", env, config, "p")).toBe("1111111111");
    expect(resolveOptionalMccCustomerId(null, env, config, "p")).toBe("2222222222");
    expect(resolveOptionalMccCustomerId(null, {}, config, "p")).toBe("3333333333");
  });

  it("dash-strips and still validates a value that IS supplied", () => {
    expect(resolveOptionalMccCustomerId("444-444-4444", {}, {}, "p")).toBe("4444444444");
    expect(() => resolveOptionalMccCustomerId("444", {}, {}, "p")).toThrow(InvalidCustomerIdError);
  });
});

describe("managerRequiredHint", () => {
  it("names mcc_customer_id as the thing to set, and says when to leave it unset", () => {
    const hint = managerRequiredHint("/repo/.adkit.yaml");
    expect(hint).toContain("mcc_customer_id");
    expect(hint).toContain("/repo/.adkit.yaml");
    expect(hint).toContain("directly-accessible");
  });
});

// Test 4 (persistence half): the prompted answer really lands in the preferences
// file — the committed `adkit.yaml`, since the id is an account number, not a
// secret — and every other field in that file survives the write.
describe("prompt-and-persist writes adkit.yaml", () => {
  let dir: string;
  let cwd: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-cid-"));
    cwd = process.cwd();
    process.chdir(dir);
    prevConfig = process.env["ADKIT_CONFIG"];
    delete process.env["ADKIT_CONFIG"];
  });

  afterEach(() => {
    process.chdir(cwd);
    if (prevConfig === undefined) {
      delete process.env["ADKIT_CONFIG"];
    } else {
      process.env["ADKIT_CONFIG"] = prevConfig;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds target_customer_id and leaves every other field untouched", async () => {
    writeFileSync(projectConfigPath(), 'mcc_customer_id: "4444444444"\nsecrets_project: "proj-x"\n');
    const id = await requireTargetCustomerId(
      deps({
        isTty: true,
        prompt: async () => "123-456-7890",
        config: loadConfig(),
        configPath: preferencesPath(),
        persist: (value: CustomerId) => writeConfigField("target_customer_id", value),
      }),
    );
    expect(id).toBe("1234567890");
    const written = readFileSync(projectConfigPath(), "utf8");
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('mcc_customer_id: "4444444444"');
    expect(written).toContain('secrets_project: "proj-x"');
    // And the next run resolves from the file instead of asking again.
    const prompt = vi.fn(async () => "9999999999");
    expect(await requireTargetCustomerId(deps({ isTty: true, prompt, config: loadConfig() }))).toBe("1234567890");
    expect(prompt).not.toHaveBeenCalled();
  });

  // Compatibility: an unmigrated project keeps its one combined file, credentials
  // and all — the persist must not strand the id in a new file the legacy one
  // would then out-rank.
  it("writes into the legacy .adkit.yaml when that is all the project has", async () => {
    writeFileSync(join(dir, ".adkit.yaml"), 'developer_token: "dev-tok"\nsecrets_project: "proj-x"\n');
    const id = await requireTargetCustomerId(
      deps({
        isTty: true,
        prompt: async () => "1234567890",
        config: loadConfig(),
        configPath: preferencesPath(),
        persist: (value: CustomerId) => writeConfigField("target_customer_id", value),
      }),
    );
    expect(id).toBe("1234567890");
    const written = readFileSync(join(dir, ".adkit.yaml"), "utf8");
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('developer_token: "dev-tok"');
    expect(loadConfig().target_customer_id).toBe("1234567890");
  });
});
