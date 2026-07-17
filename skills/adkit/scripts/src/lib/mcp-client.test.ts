import { afterEach, describe, expect, it } from "vitest";
import { createMcpReadClient, loadReadClient, McpNotConfiguredError, toMcpSearchParams } from "./mcp-client.js";
import { READ_BACKEND_ENV } from "./auth.js";
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
  const args: SearchArgs = { resource: "campaign", fields: ["campaign.id"], conditions: [] };

  it("structured reads fail loudly until the live transport is wired", async () => {
    await expect(createMcpReadClient().searchStructured("123", args)).rejects.toBeInstanceOf(
      McpNotConfiguredError,
    );
  });

  it("raw search also fails loudly (never silently falls back to SDK)", async () => {
    await expect(createMcpReadClient().search("123", "SELECT customer.id FROM customer")).rejects.toBeInstanceOf(
      McpNotConfiguredError,
    );
  });

  it("mutate fails loudly (MCP is read-only; mutations stay on the SDK)", async () => {
    await expect(createMcpReadClient().mutate("123", [])).rejects.toBeInstanceOf(McpNotConfiguredError);
  });
});

describe("loadReadClient (backend dispatch)", () => {
  const prev = process.env[READ_BACKEND_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[READ_BACKEND_ENV];
    else process.env[READ_BACKEND_ENV] = prev;
  });

  it("returns the throwing MCP client when ADKIT_READ_BACKEND=mcp (flag is observed at runtime)", async () => {
    process.env[READ_BACKEND_ENV] = "mcp";
    const client = loadReadClient();
    await expect(
      client.searchStructured("123", { resource: "campaign", fields: ["campaign.id"], conditions: [] }),
    ).rejects.toBeInstanceOf(McpNotConfiguredError);
  });
});
