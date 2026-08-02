import { describe, expect, it } from "vitest";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import {
  createCustomIntentAudience,
  listAudiences,
  parseArgs,
  parseCustomerMatchCsv,
  parseCustomerMatchRow,
  uploadCustomerMatch,
  type RunOfflineUserDataJob,
} from "./audiences.js";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses the list subcommand with --customer", () => {
    const args = parseArgs(["list", "--customer", "1234567890"]);
    expect(args.subcommand).toBe("list");
    expect(args.customerId).toBe("1234567890");
  });

  it("parses create-custom-intent with comma-separated keywords and urls", () => {
    const args = parseArgs([
      "create-custom-intent",
      "--name",
      "my-audience",
      "--keywords",
      "running shoes, marathon training",
      "--urls",
      "https://example.com/a,https://example.com/b",
    ]);
    expect(args.name).toBe("my-audience");
    expect(args.keywords).toEqual(["running shoes", "marathon training"]);
    expect(args.urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("parses upload-customer-match with --file and --list-name", () => {
    const args = parseArgs(["upload-customer-match", "--file", "/tmp/list.csv", "--list-name", "vip-customers"]);
    expect(args.file).toBe("/tmp/list.csv");
    expect(args.listName).toBe("vip-customers");
  });

  it("null subcommand when argv is empty", () => {
    expect(parseArgs([]).subcommand).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listAudiences (FR-001)
// ---------------------------------------------------------------------------

function makeSearchClient(byTable: Record<string, Array<{ id: number; name: string }>>): AdsClient {
  return {
    search: async (_customerId, query) => {
      for (const [table, rows] of Object.entries(byTable)) {
        if (query.includes(`FROM ${table} `)) {
          return rows.map((r) => ({ [table]: r })) as never[];
        }
      }
      return [];
    },
    searchStructured: async () => [],
    mutate: async (_customerId, ops): Promise<MutateResult> => ({
      results: ops.map((_, i) => ({ resource_name: `rn/${i}` })),
    }),
  };
}

describe("listAudiences", () => {
  it("returns rows tagged with their audience type", async () => {
    const client = makeSearchClient({
      user_list: [{ id: 111, name: "Site visitors 30d" }],
      custom_audience: [{ id: 222, name: "In-market: running shoes" }],
    });
    const rows = await listAudiences(client, "123");
    expect(rows).toContainEqual({ id: 111, name: "Site visitors 30d", type: "user-list" });
    expect(rows).toContainEqual({ id: 222, name: "In-market: running shoes", type: "custom-audience" });
  });

  it("returns a valid empty array for an account with zero audiences", async () => {
    const client = makeSearchClient({});
    const rows = await listAudiences(client, "123");
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createCustomIntentAudience (FR-002) — keywords, URLs, or both in one call
// ---------------------------------------------------------------------------

describe("createCustomIntentAudience", () => {
  function makeMutateClient(): { client: AdsClient; calls: AdsMutateOperation[][] } {
    const calls: AdsMutateOperation[][] = [];
    const client: AdsClient = {
      search: async () => [],
      searchStructured: async () => [],
      mutate: async (_customerId, ops) => {
        calls.push(ops);
        return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
      },
    };
    return { client, calls };
  }

  it("accepts keywords only", async () => {
    const { client, calls } = makeMutateClient();
    await createCustomIntentAudience(client, "123", "kw-only", ["running shoes"], []);
    const members = calls[0]![0]!.resource["members"] as Array<Record<string, unknown>>;
    expect(members).toEqual([{ keyword: "running shoes" }]);
  });

  it("accepts URLs only", async () => {
    const { client, calls } = makeMutateClient();
    await createCustomIntentAudience(client, "123", "url-only", [], ["https://example.com"]);
    const members = calls[0]![0]!.resource["members"] as Array<Record<string, unknown>>;
    expect(members).toEqual([{ url: "https://example.com" }]);
  });

  it("accepts both keywords and URLs together in one call", async () => {
    const { client, calls } = makeMutateClient();
    await createCustomIntentAudience(client, "123", "mixed", ["running shoes"], ["https://example.com"]);
    const members = calls[0]![0]!.resource["members"] as Array<Record<string, unknown>>;
    expect(members).toEqual([{ keyword: "running shoes" }, { url: "https://example.com" }]);
    expect(calls).toHaveLength(1); // one call, not two
  });
});

// ---------------------------------------------------------------------------
// upload-customer-match (FR-003) — never plaintext
// ---------------------------------------------------------------------------

describe("parseCustomerMatchCsv", () => {
  it("parses header + rows into records", () => {
    const csv = "email,phone\na@example.com,555-123-4567\n,555-000-0000\n";
    const rows = parseCustomerMatchCsv(csv);
    expect(rows).toEqual([
      { email: "a@example.com", phone: "555-123-4567" },
      { email: "", phone: "555-000-0000" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCustomerMatchCsv("")).toEqual([]);
  });
});

describe("parseCustomerMatchRow", () => {
  it("hashes a row with both email and phone", () => {
    const result = parseCustomerMatchRow({ email: "a@example.com", phone: "5551234567" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hashedEmail).toMatch(/^[0-9a-f]{64}$/);
      expect(result.value.hashedPhone).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("skips a row with neither email nor phone", () => {
    const result = parseCustomerMatchRow({ email: "", phone: undefined });
    expect(result.ok).toBe(false);
  });
});

describe("uploadCustomerMatch", () => {
  const noopJob: RunOfflineUserDataJob = async () => {};

  it("hashes every row and never passes plaintext to the job runner (SC-003)", async () => {
    const csv = "email,phone\nsensitive@example.com,5551234567\n";
    let capturedIdentifiers: readonly { hashedEmail?: string; hashedPhone?: string }[] = [];
    const captureJob: RunOfflineUserDataJob = async (_customerId, _listName, identifiers) => {
      capturedIdentifiers = identifiers;
    };
    const result = await uploadCustomerMatch(csv, "123", "my-list", captureJob);
    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(0);
    const serialized = JSON.stringify(capturedIdentifiers);
    expect(serialized).not.toContain("sensitive@example.com");
    expect(serialized).not.toContain("5551234567");
  });

  it("skips a malformed row and counts it", async () => {
    const csv = "email,phone\nvalid@example.com,5551234567\n,\n";
    const result = await uploadCustomerMatch(csv, "123", "my-list", noopJob);
    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("rejects pre-flight with zero network calls when every row is invalid", async () => {
    const csv = "email,phone\n,\n,\n";
    let jobCalled = false;
    const trackingJob: RunOfflineUserDataJob = async () => {
      jobCalled = true;
    };
    await expect(uploadCustomerMatch(csv, "123", "my-list", trackingJob)).rejects.toThrow(/no valid rows/);
    expect(jobCalled).toBe(false);
  });
});
