import { describe, expect, it } from "vitest";
import { toSdkMutateOperations } from "./auth.js";

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
