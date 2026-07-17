import { describe, expect, it } from "vitest";
import { createMcpReadClient, McpNotConfiguredError, toMcpSearchParams } from "./mcp-client.js";
import type { SearchArgs } from "../gaql/search-args.js";

describe("toMcpSearchParams", () => {
  it("passes the decomposed args through verbatim for the MCP search tool", () => {
    const args: SearchArgs = {
      resource: "search_term_view",
      fields: ["campaign.id", "search_term_view.search_term"],
      conditions: ["campaign.id IN (1,2)"],
      orderings: ["campaign.id"],
      limit: 50,
    };
    expect(toMcpSearchParams("123", args)).toEqual({
      customer_id: "123",
      resource: "search_term_view",
      fields: ["campaign.id", "search_term_view.search_term"],
      conditions: ["campaign.id IN (1,2)"],
      orderings: ["campaign.id"],
      limit: 50,
    });
  });

  it("normalizes absent orderings to [] and omits an absent limit", () => {
    const args: SearchArgs = { resource: "campaign", fields: ["campaign.id"], conditions: [] };
    const params = toMcpSearchParams("123", args);
    expect(params.orderings).toEqual([]);
    expect("limit" in params).toBe(false);
  });
});

describe("createMcpReadClient", () => {
  it("fails loudly until the live transport is wired (never silently degrades)", async () => {
    const client = createMcpReadClient();
    await expect(
      client.searchStructured("123", { resource: "campaign", fields: ["campaign.id"], conditions: [] }),
    ).rejects.toBeInstanceOf(McpNotConfiguredError);
  });
});
