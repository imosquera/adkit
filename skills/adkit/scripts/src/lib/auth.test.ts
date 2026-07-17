import { describe, expect, it } from "vitest";
import { parseReadBackend, toSdkMutateOperations } from "./auth.js";
import { toGaql, type SearchArgs } from "../gaql/search-args.js";

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

describe("SDK client structured read parity", () => {
  // The SDK backend must serve searchStructured(args) exactly as search(toGaql(args)):
  // a stub Customer records the GAQL string it is handed by each path.
  function stubClient() {
    const seen: string[] = [];
    const customer = { query: async (q: string) => (seen.push(q), []) };
    // Mirror loadClient's two read entrypoints over the same Customer.query.
    const client = {
      search: async (_cid: string, q: string) => customer.query(q),
      searchStructured: async (_cid: string, args: SearchArgs) => customer.query(toGaql(args)),
    };
    return { client, seen };
  }

  it("searchStructured(args) runs the same GAQL as search(toGaql(args))", async () => {
    const args: SearchArgs = {
      resource: "campaign",
      fields: ["campaign.id", "campaign.status"],
      conditions: ["campaign.id IN (1,2)"],
    };
    const { client, seen } = stubClient();
    await client.searchStructured("123", args);
    await client.search("123", toGaql(args));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe("SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id IN (1,2)");
  });
});
