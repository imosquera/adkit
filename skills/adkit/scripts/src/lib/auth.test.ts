import { describe, expect, it } from "vitest";
import { parseReadBackend, toSdkMutateOperations } from "./auth.js";

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

// NOTE: the SDK client's `searchStructured(args) === search(toGaql(args))` guarantee
// is established structurally in loadClient (both delegate to Customer.query, the
// structured path via toGaql). Exercising the real loadClient needs live credentials,
// so the migration is instead protected end-to-end by the exhaustive golden-string
// parity suite in gaql/builders-parity.test.ts (every builder's toGaql output pinned
// to the exact pre-refactor GAQL) plus the loadReadClient dispatch tests in
// lib/mcp-client.test.ts. A hand-rolled stub mirroring loadClient would only assert
// toGaql === toGaql, so it is intentionally omitted.
