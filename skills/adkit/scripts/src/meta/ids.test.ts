import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ImageHashSchema,
  MetaAccessTokenSchema,
  MetaAdAccountIdSchema,
  MetaAdIdSchema,
  MetaAdSetIdSchema,
  MetaCampaignIdSchema,
  parseMetaAdAccountId,
  type MetaAdId,
  type MetaAdSetId,
} from "./ids.js";

describe("parseMetaAdAccountId", () => {
  it.each([
    ["123", "act_123"],
    ["act_123", "act_123"],
    ["  act_987654321  ", "act_987654321"],
    [" 42 ", "act_42"],
    [123, "act_123"],
  ])("accepts %j as %s", (raw, expected) => {
    expect(parseMetaAdAccountId(raw, "--ad-account")).toEqual({ kind: "ok", value: expected });
  });

  it.each([["act_"], [""], ["act_12a"], ["ACT_123"], ["abc"], ["act-123"], [-1], [1.5], [null], [undefined], [{}]])(
    "rejects %j naming the source",
    (raw) => {
      const result = parseMetaAdAccountId(raw, "META_AD_ACCOUNT_ID");
      expect(result.kind).toBe("err");
      if (result.kind === "err") expect(result.message).toContain("META_AD_ACCOUNT_ID");
    },
  );
});

describe("numeric id schemas", () => {
  it("accepts digit strings and coerces numbers", () => {
    expect(MetaCampaignIdSchema.parse("120210000000001")).toBe("120210000000001");
    expect(MetaAdIdSchema.parse(42)).toBe("42");
    expect(MetaAdSetIdSchema.parse(" 7 ")).toBe("7");
  });

  it("rejects non-digit values", () => {
    expect(MetaCampaignIdSchema.safeParse("act_1").success).toBe(false);
    expect(MetaCampaignIdSchema.safeParse("").success).toBe(false);
    expect(MetaCampaignIdSchema.safeParse(null).success).toBe(false);
    expect(MetaCampaignIdSchema.safeParse(1.2).success).toBe(false);
  });

  it("embeds in zod objects", () => {
    const Row = z.object({ id: MetaCampaignIdSchema, account_id: MetaAdAccountIdSchema });
    expect(Row.parse({ id: "1", account_id: "99" })).toEqual({ id: "1", account_id: "act_99" });
  });

  it("brands are not interchangeable", () => {
    const adSet: MetaAdSetId = MetaAdSetIdSchema.parse("1");
    // @ts-expect-error an ad set id is not an ad id
    const ad: MetaAdId = adSet;
    expect(ad).toBe("1");
  });
});

describe("opaque token schemas", () => {
  it("accept non-empty trimmed strings", () => {
    expect(ImageHashSchema.parse(" abc123 ")).toBe("abc123");
    expect(MetaAccessTokenSchema.parse("EAAB")).toBe("EAAB");
  });

  it("reject empty or whitespace-containing values", () => {
    expect(ImageHashSchema.safeParse("   ").success).toBe(false);
    expect(MetaAccessTokenSchema.safeParse("a b").success).toBe(false);
    expect(MetaAccessTokenSchema.safeParse(123).success).toBe(false);
  });
});
