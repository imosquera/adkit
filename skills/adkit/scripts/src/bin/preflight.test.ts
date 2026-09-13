import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCredentialsExist, main, parsePreflightArgs } from "./preflight.js";
import { KEEP_YAML_MCC, mccCustomerIdFromYaml, resolveMccHeader, type AdsClient } from "../lib/auth.js";

/**
 * The Meta preflight, mocked. `loaded` flips when the factory runs — i.e. when
 * something actually imports the module — so a Google run can prove it never did.
 */
const meta = vi.hoisted(() => ({ loaded: false, main: vi.fn(async () => 0) }));
vi.mock("../meta/bin/preflight.js", () => {
  meta.loaded = true;
  return { main: meta.main };
});

describe("checkCredentialsExist", () => {
  it("passes when the file exists", () => {
    expect(checkCredentialsExist("/some/.adkit.yaml", () => true)).toBeNull();
  });

  it("fails (step 'credentials') when the file is missing", () => {
    const failure = checkCredentialsExist("/nope/.adkit.yaml", () => false);
    expect(failure?.step).toBe("credentials");
    expect(failure?.message).toContain("/nope/.adkit.yaml");
    expect(failure?.message).toMatch(/render-yaml/);
  });
});

describe("parsePreflightArgs", () => {
  it("reads --customer, defaulting to null", () => {
    expect(parsePreflightArgs(["--customer", "1234567890"]).customer).toBe("1234567890");
    expect(parsePreflightArgs([]).customer).toBeNull();
  });
});

/**
 * preflight's client construction and customer-id tiering, driven through `main`
 * with the SDK factory injected. The regression these pin: preflight used to call
 * `loadClient(null)`, which CLEARS the login-customer-id header — so every
 * MCC-managed account failed the one check whose job is to say the credentials
 * work, and the error blamed the operator for the mcc_customer_id preflight was
 * itself discarding.
 */
describe("preflight builds its client the way the commands it gates do", () => {
  let dir: string;
  let prevConfig: string | undefined;
  let prevEnvCustomer: string | undefined;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-preflight-"));
    prevConfig = process.env["ADKIT_CONFIG"];
    prevEnvCustomer = process.env["GOOGLE_ADS_CUSTOMER_ID"];
    process.env["ADKIT_CONFIG"] = join(dir, ".adkit.yaml");
    delete process.env["GOOGLE_ADS_CUSTOMER_ID"];
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore("ADKIT_CONFIG", prevConfig);
    restore("GOOGLE_ADS_CUSTOMER_ID", prevEnvCustomer);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeConfig = (body: string): void => writeFileSync(process.env["ADKIT_CONFIG"]!, body);

  /** A stub client whose one-row probe always succeeds, plus a record of how it was built. */
  function recordingFactory(): { calls: unknown[]; factory: (login?: unknown) => AdsClient } {
    const calls: unknown[] = [];
    const factory = (login?: unknown): AdsClient => {
      calls.push(login);
      return {
        search: async () => [{ customer: { id: "1234567890" } }],
      } as unknown as AdsClient;
    };
    return { calls, factory };
  }

  /**
   * The header the SDK would actually receive, given how preflight built the client.
   * `undefined` in means preflight passed no argument at all, which is loadClient's
   * own KEEP_YAML_MCC default — so substituting it here models the real call, it does
   * not paper over a missing assertion (the `calls` equality above pins the argument).
   */
  const headerFor = (arg: unknown): string | undefined =>
    resolveMccHeader((arg ?? KEEP_YAML_MCC) as Parameters<typeof resolveMccHeader>[0], mccCustomerIdFromYaml());

  // 1. A configured manager id reaches the client as the login header.
  it("sends the yaml's mcc_customer_id as the login header", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\n');
    const { calls, factory } = recordingFactory();
    expect(await main([], factory as never)).toBe(0);
    // The default, not an explicit null — null would clear the header.
    expect(calls).toEqual([undefined]);
    expect(headerFor(calls[0])).toBe("4444444444");
  });

  // 2. A blank/absent manager id still means no header — the directly-accessible case
  //    the old `loadClient(null)` comment was worried about, which the default covers.
  it("sends no login header when mcc_customer_id is blank", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1234567890"\n');
    const { calls, factory } = recordingFactory();
    expect(await main([], factory as never)).toBe(0);
    expect(calls).toEqual([undefined]);
    expect(headerFor(calls[0])).toBeUndefined();
  });

  // 3. flag -> env -> yaml, the same tiering conventions.md documents for every
  //    other command. Running `init` used to be insufficient for preflight alone.
  it("uses target_customer_id from the yaml when GOOGLE_ADS_CUSTOMER_ID is unset", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1234567890"\n');
    const queried: string[] = [];
    const factory = (): AdsClient =>
      ({
        search: async (customerId: string) => {
          queried.push(customerId);
          return [{ customer: { id: customerId } }];
        },
      }) as unknown as AdsClient;
    expect(await main([], factory as never)).toBe(0);
    expect(queried).toEqual(["1234567890"]);
  });

  it("lets GOOGLE_ADS_CUSTOMER_ID win over the yaml, and --customer over both", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1111111111"\n');
    const queried: string[] = [];
    const factory = (): AdsClient =>
      ({
        search: async (customerId: string) => {
          queried.push(customerId);
          return [{ customer: { id: customerId } }];
        },
      }) as unknown as AdsClient;

    process.env["GOOGLE_ADS_CUSTOMER_ID"] = "2222222222";
    expect(await main([], factory as never)).toBe(0);
    expect(await main(["--customer", "333-333-3333"], factory as never)).toBe(0);
    expect(queried).toEqual(["2222222222", "3333333333"]);
  });

  // Off a TTY a missing id is a named failure, not a prompt into a pipe.
  it("fails with the shared customer-id envelope when no tier supplies an id", async () => {
    writeConfig('developer_token: "t"\n');
    const { factory } = recordingFactory();
    expect(await main([], factory as never)).toBe(1);
    const emitted = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(emitted).toContain('"ok": false');
    expect(emitted).toContain("target_customer_id");
  });

  // The old message named mcc_customer_id even when preflight had discarded it.
  it("names the manager id it actually sent when access is denied", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\n');
    const factory = (): AdsClient =>
      ({
        search: async () => {
          throw new Error("USER_PERMISSION_DENIED");
        },
      }) as unknown as AdsClient;
    expect(await main([], factory as never)).toBe(1);
    const emitted = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(emitted).toContain("4444444444");
    expect(emitted).toContain("manages customer 1234567890");
  });

  it("points at mcc_customer_id as the thing to SET when none was configured", async () => {
    writeConfig('developer_token: "t"\ntarget_customer_id: "1234567890"\n');
    const factory = (): AdsClient =>
      ({
        search: async () => {
          throw new Error("USER_PERMISSION_DENIED");
        },
      }) as unknown as AdsClient;
    expect(await main([], factory as never)).toBe(1);
    const emitted = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(emitted).toContain("mcc_customer_id");
    expect(emitted).toContain("directly-accessible");
  });
});

/**
 * Platform delegation (plan D1). The Google-path test runs first on purpose: the
 * mocked Meta module's factory runs once per file, on first import, so `loaded`
 * is only meaningful before any Meta run in this file has imported it.
 */
describe("preflight platform delegation", () => {
  let dir: string;
  let prevConfig: string | undefined;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-preflight-platform-"));
    prevConfig = process.env["ADKIT_CONFIG"];
    process.env["ADKIT_CONFIG"] = join(dir, ".adkit.yaml");
    writeFileSync(process.env["ADKIT_CONFIG"], 'developer_token: "t"\ntarget_customer_id: "1234567890"\n');
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    meta.main.mockClear();
  });

  afterEach(() => {
    if (prevConfig === undefined) {
      delete process.env["ADKIT_CONFIG"];
    } else {
      process.env["ADKIT_CONFIG"] = prevConfig;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const probingFactory = (): AdsClient =>
    ({ search: async () => [{ customer: { id: "1234567890" } }] }) as unknown as AdsClient;

  it("runs the Google checks without importing the Meta module when no platform is set", async () => {
    expect(await main([], probingFactory as never, {})).toBe(0);
    expect(await main(["--platform", "google"], probingFactory as never, {})).toBe(0);
    expect(meta.loaded).toBe(false);
    expect(meta.main).not.toHaveBeenCalled();
  });

  it("delegates --platform meta to the Meta preflight with the flag stripped and env passed through", async () => {
    const env = { META_ACCESS_TOKEN: "tok" };
    const factory = vi.fn(probingFactory);
    expect(await main(["--platform", "meta", "--ad-account", "act_1"], factory as never, env)).toBe(0);
    expect(meta.main).toHaveBeenCalledWith(["--ad-account", "act_1"], env);
    expect(factory).not.toHaveBeenCalled();
  });

  it("delegates when ADKIT_PLATFORM=meta and returns the Meta exit code", async () => {
    meta.main.mockResolvedValueOnce(1);
    expect(await main([], probingFactory as never, { ADKIT_PLATFORM: "meta" })).toBe(1);
    expect(meta.main).toHaveBeenCalledWith([], { ADKIT_PLATFORM: "meta" });
  });

  it("fails with step 'platform' on an unknown platform, before any check", async () => {
    const factory = vi.fn(probingFactory);
    expect(await main(["--platform", "tiktok"], factory as never, {})).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(meta.main).not.toHaveBeenCalled();
    const envelope = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join("")) as Record<string, unknown>;
    expect(envelope["ok"]).toBe(false);
    expect(envelope["step"]).toBe("platform");
    expect(String(envelope["message"])).toContain("tiktok");
  });
});
