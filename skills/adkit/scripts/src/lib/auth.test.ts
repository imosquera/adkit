import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  customerIdFromYaml,
  KEEP_YAML_LOGIN,
  loginCustomerIdFromYaml,
  parseReadBackend,
  resolveLoginHeader,
  toSdkMutateOperations,
} from "./auth.js";

describe("toSdkMutateOperations", () => {
  it("unwraps a remove op's resource to the bare resource-name string", () => {
    const [op] = toSdkMutateOperations([
      { entity: "ad_group_criterion", operation: "remove", resource: { resource_name: "customers/1/adGroupCriteria/9~11" } },
    ]);
    expect(op!.resource).toBe("customers/1/adGroupCriteria/9~11");
    expect(op!.operation).toBe("remove");
    expect(op!.entity).toBe("ad_group_criterion");
  });

  it("leaves create and update ops' resource objects untouched", () => {
    const ops = toSdkMutateOperations([
      { entity: "campaign_budget", operation: "create", resource: { name: "B", amount_micros: 5 } },
      { entity: "campaign", operation: "update", resource: { resource_name: "customers/1/campaigns/9", status: 3 } },
    ]);
    expect(ops[0]!.resource).toEqual({ name: "B", amount_micros: 5 });
    expect(ops[1]!.resource).toEqual({ resource_name: "customers/1/campaigns/9", status: 3 });
  });

  it("defaults a missing resource_name on a remove to an empty string", () => {
    const [op] = toSdkMutateOperations([{ entity: "campaign", operation: "remove", resource: {} }]);
    expect(op!.resource).toBe("");
  });
});

describe("parseReadBackend", () => {
  it("defaults to sdk when the flag is absent", () => {
    expect(parseReadBackend(undefined)).toBe("sdk");
  });

  it("defaults to sdk for an unrecognized value", () => {
    expect(parseReadBackend("grpc")).toBe("sdk");
    expect(parseReadBackend("")).toBe("sdk");
  });

  it("selects mcp only when explicitly requested (case/space-insensitive)", () => {
    expect(parseReadBackend("mcp")).toBe("mcp");
    expect(parseReadBackend("  MCP ")).toBe("mcp");
  });
});

// The login-header mapping loadClient applies. Pinned here so the two zero-flag
// report paths cannot regress into each other: an MCC-nested account (yaml carries a
// login) and a directly-accessible one (yaml carries none) must BOTH work from the
// same KEEP_YAML_LOGIN decision.
describe("resolveLoginHeader", () => {
  it("maps KEEP_YAML_LOGIN to the yaml's login_customer_id (MCC-nested leaf)", () => {
    expect(resolveLoginHeader(KEEP_YAML_LOGIN, "9999999999")).toBe("9999999999");
  });

  it("omits the header when KEEP_YAML_LOGIN meets a yaml with no login (direct leaf)", () => {
    expect(resolveLoginHeader(KEEP_YAML_LOGIN, undefined)).toBeUndefined();
  });

  it("omits the header for an explicit null even when the yaml carries a login", () => {
    expect(resolveLoginHeader(null, "9999999999")).toBeUndefined();
  });

  it("sends an explicit string override in place of the yaml value", () => {
    expect(resolveLoginHeader("1234567890", "9999999999")).toBe("1234567890");
  });
});

// NOTE: the SDK client's `searchStructured(args) === search(toGaql(args))` guarantee
// is established structurally in loadClient (both delegate to Customer.query, the
// structured path via toGaql). Exercising the real loadClient needs live credentials,
// so the migration is instead protected end-to-end by the exhaustive golden-string
// parity suite in gaql/builders-parity.test.ts (every builder's toGaql output pinned
// to the exact pre-refactor GAQL) plus the loadReadClient dispatch tests in
// lib/mcp-client.test.ts. A hand-rolled stub mirroring loadClient would only assert
// toGaql === toGaql, so it is intentionally omitted.

describe("loginCustomerIdFromYaml", () => {
  let dir: string;
  let credsPath: string;
  let orig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-"));
    credsPath = join(dir, "google-ads.yaml");
    orig = process.env.GOOGLE_ADS_CREDENTIALS;
    process.env.GOOGLE_ADS_CREDENTIALS = credsPath;
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.GOOGLE_ADS_CREDENTIALS;
    } else {
      process.env.GOOGLE_ADS_CREDENTIALS = orig;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the yaml's login_customer_id as a string", () => {
    writeFileSync(credsPath, "developer_token: t\nlogin_customer_id: 4444444444\n");
    expect(loginCustomerIdFromYaml()).toBe("4444444444");
  });

  it("returns undefined when the yaml carries no login_customer_id", () => {
    writeFileSync(credsPath, "developer_token: t\n");
    expect(loginCustomerIdFromYaml()).toBeUndefined();
  });

  it("reads the LOGIN id, never the target id customerIdFromYaml prefers", () => {
    // customerIdFromYaml answers "which account do we query" (target first), so
    // reusing it here would report a leaf account as the manager.
    writeFileSync(credsPath, "target_customer_id: 1111111111\nlogin_customer_id: 4444444444\n");
    expect(loginCustomerIdFromYaml()).toBe("4444444444");
    expect(customerIdFromYaml()).toBe("1111111111");
  });

  it("throws (rather than reporting 'no login') when the credentials are unreadable", () => {
    expect(() => loginCustomerIdFromYaml()).toThrow();
  });
});
