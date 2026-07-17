import { describe, expect, it } from "vitest";
import { toGaql, type SearchArgs } from "./search-args.js";

describe("toGaql", () => {
  it("assembles SELECT/FROM with fields comma-joined", () => {
    const args: SearchArgs = {
      resource: "campaign",
      fields: ["campaign.id", "campaign.name"],
      conditions: [],
    };
    expect(toGaql(args)).toBe("SELECT campaign.id, campaign.name FROM campaign");
  });

  it("AND-joins conditions into a WHERE clause", () => {
    const args: SearchArgs = {
      resource: "campaign",
      fields: ["campaign.id"],
      conditions: ["campaign.status = 'ENABLED'", "campaign.id IN (1,2)"],
    };
    expect(toGaql(args)).toBe(
      "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.id IN (1,2)",
    );
  });

  it("omits WHERE when there are no conditions", () => {
    const args: SearchArgs = { resource: "customer", fields: ["customer.id"], conditions: [] };
    expect(toGaql(args)).toBe("SELECT customer.id FROM customer");
  });

  it("appends ORDER BY only when orderings are present, comma-joined", () => {
    const args: SearchArgs = {
      resource: "campaign",
      fields: ["campaign.id"],
      conditions: [],
      orderings: ["campaign.name", "campaign.id"],
    };
    expect(toGaql(args)).toBe("SELECT campaign.id FROM campaign ORDER BY campaign.name, campaign.id");
  });

  it("appends LIMIT only when set, after WHERE and ORDER BY", () => {
    const args: SearchArgs = {
      resource: "customer",
      fields: ["customer.id"],
      conditions: ["customer.id = 1"],
      orderings: ["customer.id"],
      limit: 1,
    };
    expect(toGaql(args)).toBe(
      "SELECT customer.id FROM customer WHERE customer.id = 1 ORDER BY customer.id LIMIT 1",
    );
  });

  it("treats an empty orderings array like an absent one (no ORDER BY)", () => {
    const args: SearchArgs = {
      resource: "campaign",
      fields: ["campaign.id"],
      conditions: [],
      orderings: [],
    };
    expect(toGaql(args)).toBe("SELECT campaign.id FROM campaign");
  });
});
