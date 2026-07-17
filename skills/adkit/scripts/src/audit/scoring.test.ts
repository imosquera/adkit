/** Unit tests for the pure scoring/detection logic in audit/scoring — no google-ads needed. */
import { describe, expect, it } from "vitest";

import {
  cannibalization,
  conceptWords,
  differentiationGaps,
  keywordAlignment,
  pathToExcellent,
  requireDigits,
} from "./scoring.js";

// ---------- me-too copy (dynamic differentiation profile) ----------

import type { DifferentiationProfile } from "../lib/brand.js";

// A profile derived (as the model would, per run) for an AI-tool campaign: generic
// category phrases + the three axes a competitor like ChatGPT can't easily replicate.
const AI_TOOL_PROFILE: DifferentiationProfile = {
  competitors: ["ChatGPT", "Claude"],
  genericPhrases: ["ai writer", "ai chatbot"],
  axes: [
    { name: "integration", triggers: ["crm", "hubspot", "integrat"] },
    { name: "consistency", triggers: ["voice-matched", "on-brand", "every channel"] },
    { name: "outcome", triggers: ["reply rate", "conversion", "revenue"] },
  ],
};

describe("differentiationGaps", () => {
  it("flags generic copy with missing axes", () => {
    const f = differentiationGaps(
      ["AI Writer for everyone", "Best AI chatbot"],
      ["Generate content fast"],
      AI_TOOL_PROFILE,
    );
    expect(f).not.toBeNull();
    expect(new Set(f!.missingAxes)).toEqual(new Set(["integration", "consistency", "outcome"]));
  });

  it("is not flagged when all axes present", () => {
    const hs = ["Voice-matched replies in your CRM", "On-brand replies, every channel"];
    const ds = ["Integrates with HubSpot to lift your reply rate and conversions"];
    expect(differentiationGaps(hs, ds, AI_TOOL_PROFILE)).toBeNull();
  });

  it("is not flagged when not generic", () => {
    expect(
      differentiationGaps(["DTC customer service software"], ["Built for CPG brands"], AI_TOOL_PROFILE),
    ).toBeNull();
  });

  it("never flags under an empty profile", () => {
    const empty: DifferentiationProfile = { competitors: [], axes: [], genericPhrases: [] };
    expect(differentiationGaps(["Best AI chatbot"], ["ai writer"], empty)).toBeNull();
  });
});

// ---------- conceptWords ----------

describe("conceptWords", () => {
  it("prefers keywords", () => {
    expect(conceptWords("Best Ai Chatbot", ["best ai chatbot", "ai bot"])).toEqual([
      "best",
      "chatbot",
      "bot", // >2 chars, "ai" dropped
    ]);
  });

  it("falls back to the ad group name when there are no keywords", () => {
    expect(conceptWords("Best Ai Chatbot", [])).toEqual(["best", "chatbot"]);
  });

  it("falls back to the theme name even for a short name without keywords", () => {
    expect(conceptWords("Salon Software", [])).toEqual(["salon", "software"]);
  });

  it("no longer special-cases a former I/N/C/T tier label — falls back to it like any other name", () => {
    // Locks in the removal of TIER_NAMES: these labels used to short-circuit to [] when
    // an ad group had no fetched keywords; now they fall back to the name like any other.
    expect(conceptWords("Commercial", [])).toEqual(["commercial"]);
    expect(conceptWords("transactional", [])).toEqual(["transactional"]);
  });
});

// ---------- pathToExcellent ----------

/** 15 distinct headlines, all containing "chatbot". */
function fullH(): string[] {
  return Array.from({ length: 15 }, (_, i) => `ai chatbot ${i}`);
}

describe("pathToExcellent", () => {
  it("flags underfill", () => {
    const steps = pathToExcellent("Best Ai Chatbot", ["ai chatbot"], ["a", "b"], ["d"], [], [], [], [], [], "POOR");
    const joined = steps.join(" ");
    expect(joined).toContain("Add 13 more headlines");
    expect(joined).toContain("Add 3 more descriptions");
  });

  it("flags keyword inclusion gap", () => {
    // 15 headlines, none contain the keyword "chatbot"
    const hs = Array.from({ length: 15 }, (_, i) => `generic line ${i}`);
    const steps = pathToExcellent(
      "Best Ai Chatbot",
      ["ai chatbot"],
      hs,
      ["a", "b", "c", "d"],
      [],
      [],
      [],
      [],
      [],
      "POOR",
    );
    expect(steps.some((s) => s.includes("in >=3 headlines"))).toBe(true);
  });

  it("dedups Google hint against emitted step", () => {
    // under-filled headlines already emitted → Google's headline hint is skipped
    const steps = pathToExcellent(
      "Best Ai Chatbot",
      ["ai chatbot"],
      ["a"],
      ["a", "b", "c", "d"],
      [],
      [],
      [],
      [],
      ["Try including more keywords in your headlines."],
      "POOR",
    );
    expect(steps.some((s) => s.startsWith("Google says"))).toBe(false);
  });

  it("keeps unrelated Google hint", () => {
    const steps = pathToExcellent(
      "Best Ai Chatbot",
      ["ai chatbot"],
      fullH(),
      ["a", "b", "c", "d"],
      [],
      [],
      [],
      [],
      ["Add 6 more sitelinks in your ad"],
      "GOOD",
    );
    expect(steps.some((s) => s.includes("Google says: Add 6 more sitelinks"))).toBe(true);
  });

  it("is empty for an excellent full ad", () => {
    const steps = pathToExcellent(
      "Best Ai Chatbot",
      ["ai chatbot"],
      fullH(),
      ["a", "b", "c", "d"],
      [],
      [],
      [],
      [],
      [],
      "EXCELLENT",
    );
    expect(steps).toEqual([]);
  });

  it("flags dup, echo, banned and pins on a known-bad ad", () => {
    // a fully-loaded-but-contaminated ad: dup headline, echoing description,
    // banned phrase, and a pinned asset must each surface as their own step.
    const hs = Array.from({ length: 15 }, () => "ai chatbot offer"); // all identical -> duplicate
    const ds = ["ai chatbot offer", "b", "c", "d"]; // first echoes a headline
    const steps = pathToExcellent(
      "Best Ai Chatbot",
      ["ai chatbot"],
      hs,
      ds,
      ["ai chatbot offer"], // dupH
      ["ai chatbot offer"], // echo
      ["Portugal"], // bannedHit
      ["pinned head"], // pins
      [], // actionItems
      "GOOD",
    );
    const joined = steps.join(" ");
    expect(joined).toContain("Replace duplicate headlines");
    expect(joined).toContain("Rewrite descriptions that just echo a headline");
    expect(joined).toContain("Remove off-product / contaminated copy");
    expect(joined).toContain("Unpin all assets");
  });
});

// ---------- cannibalization ----------

describe("cannibalization", () => {
  it("flags shared keyword and names starved", () => {
    const serving = [
      { campaignId: 1, campaignName: "lineal-search", impressions: 2500 },
      { campaignId: 2, campaignName: "lineal-stag-search", impressions: 0 },
    ];
    const kw = { 1: { ag: ["Retail Data Analytics"] }, 2: { ag: ["retail data analytics", "other"] } };
    const pairs = cannibalization(serving, kw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].shared).toEqual(["retail data analytics"]);
    expect(pairs[0].starvedLikely).toBe("lineal-stag-search"); // lower impressions
  });

  it("yields no pairs when no overlap", () => {
    const serving = [
      { campaignId: 1, campaignName: "a", impressions: 10 },
      { campaignId: 2, campaignName: "b", impressions: 20 },
    ];
    const kw = { 1: { ag: ["alpha"] }, 2: { ag: ["beta"] } };
    expect(cannibalization(serving, kw)).toEqual([]);
  });

  it("yields all pairs when overlap spans three campaigns", () => {
    // three campaigns sharing one keyword -> 3 unordered pairs, each flagged.
    const serving = [
      { campaignId: 1, campaignName: "a", impressions: 30 },
      { campaignId: 2, campaignName: "b", impressions: 20 },
      { campaignId: 3, campaignName: "c", impressions: 10 },
    ];
    const kw = {
      1: { ag: ["shared kw", "alpha"] },
      2: { ag: ["Shared KW"] },
      3: { ag: ["shared kw", "gamma"] },
    };
    const pairs = cannibalization(serving, kw);
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.shared.length === 1 && p.shared[0] === "shared kw")).toBe(true);
    // the lowest-impression member of each pair is named as starved
    const byMembers = new Map(pairs.map((p) => [[p.a, p.b].sort().join("|"), p.starvedLikely]));
    expect(byMembers.get(["a", "b"].sort().join("|"))).toBe("b");
    expect(byMembers.get(["a", "c"].sort().join("|"))).toBe("c");
    expect(byMembers.get(["b", "c"].sort().join("|"))).toBe("c");
  });
});

// ---------- keywordAlignment ----------

describe("keywordAlignment", () => {
  // 3 headlines and a description all carrying the "chatbot" theme, plus an aligned name.
  const alignedHs = ["ai chatbot fast", "best chatbot", "chatbot for teams"];
  const alignedDs = ["The ai chatbot your team will love"];
  const alignedUrl = "https://acme.com/ai-chatbot";

  it("returns null when name, copy, and landing page all align", () => {
    expect(
      keywordAlignment("Best Ai Chatbot", ["ai chatbot"], alignedHs, alignedDs, alignedUrl),
    ).toBeNull();
  });

  it("returns null when there are no keywords to align to", () => {
    // an empty keyword set can't be a mismatch — nothing to compare against
    expect(keywordAlignment("Widgets", [], ["totally unrelated"], ["nope"], alignedUrl)).toBeNull();
  });

  it("does not judge the landing page when the final URL is absent", () => {
    // null URL => landing-page level is skipped, not flagged
    const f = keywordAlignment("Best Ai Chatbot", ["ai chatbot"], alignedHs, alignedDs, null);
    expect(f).toBeNull();
  });

  it("flags an ad group name that drifts off the keyword theme", () => {
    // name shares no theme word with "chatbot", but the copy and URL do
    const f = keywordAlignment("Generic Bundle", ["ai chatbot"], alignedHs, alignedDs, alignedUrl);
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["ad group name"]);
    expect(f!.nameAligned).toBe(false);
  });

  it("flags headlines that fail to carry the keyword theme", () => {
    const hs = ["one thing", "chatbot only here", "another"]; // only 1 of 3 carries the theme
    const f = keywordAlignment("Ai Chatbot", ["ai chatbot"], hs, alignedDs, alignedUrl);
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["headlines"]);
    expect(f!.headlinesWithKeyword).toBe(1);
  });

  it("flags descriptions that omit the keyword theme", () => {
    const f = keywordAlignment("Ai Chatbot", ["ai chatbot"], alignedHs, ["buy now, act fast"], alignedUrl);
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["descriptions"]);
    expect(f!.descriptionsWithKeyword).toBe(0);
  });

  it("flags a landing page URL that drifts off the keyword theme", () => {
    // name + copy align, but the ad points at an off-theme landing page
    const f = keywordAlignment(
      "Ai Chatbot",
      ["ai chatbot"],
      alignedHs,
      alignedDs,
      "https://acme.com/generic-pricing-page",
    );
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["landing page"]);
    expect(f!.landingPageAligned).toBe(false);
  });

  it("aligns on the landing page when a theme word is in the URL slug", () => {
    expect(
      keywordAlignment("Ai Chatbot", ["ai chatbot"], alignedHs, alignedDs, "acme.com/best-chatbot-tool"),
    ).toBeNull(); // slug carries "chatbot"; scheme-less URL still parses
  });

  it("aligns on the landing page via substring (plural slug covers singular theme)", () => {
    // "chatbots" in the slug must cover the "chatbot" theme, same as it would in a headline
    expect(
      keywordAlignment("Ai Chatbot", ["ai chatbot"], alignedHs, alignedDs, "https://acme.com/ai-chatbots-tool"),
    ).toBeNull();
  });

  it("does not flag headlines when an under-filled ad group carries the theme in all it has", () => {
    // only 2 headlines, both on-theme: target is capped at 2, so headlines align (the
    // count shortfall is `headlines_under`'s job, not a message-match miss)
    const f = keywordAlignment("Ai Chatbot", ["ai chatbot"], ["ai chatbot", "best chatbot"], alignedDs, alignedUrl);
    expect(f).toBeNull();
  });

  it("matches on word boundaries, not mid-word substrings (app != happy)", () => {
    // "app" appears only inside "happy"/"apply" — no level actually mentions the keyword,
    // so all four must be flagged rather than silently passing on the substring.
    const f = keywordAlignment(
      "Happy Customers",
      ["app"],
      ["be happy", "stay happy", "get happy"],
      ["your happiness matters"],
      "https://acme.com/happiness",
    );
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["ad group name", "headlines", "descriptions", "landing page"]);
  });

  it("still matches inflections at a word boundary (chatbot -> chatbots)", () => {
    const f = keywordAlignment(
      "Chatbots",
      ["chatbot"],
      ["our chatbots", "best chatbots", "fast chatbots"],
      ["the chatbots your team loves"],
      "https://acme.com/chatbots",
    );
    expect(f).toBeNull();
  });

  it("does not treat a multi-label public suffix as landing-page copy (com.br)", () => {
    // keyword theme "com" (Portuguese "with") must NOT be satisfied by the ".com.br" suffix
    const f = keywordAlignment(
      "Com Desconto",
      ["com desconto"],
      ["desconto agora", "melhor desconto", "desconto real"],
      ["compre com desconto hoje"],
      "https://loja.com.br/promocoes", // slug has no "desconto" and "com" is suffix noise
    );
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["landing page"]);
    expect(f!.landingPageAligned).toBe(false);
  });

  it("reports every misaligned level at once", () => {
    const f = keywordAlignment("Generic Bundle", ["ai chatbot"], ["a", "b", "c"], ["d"], "https://acme.com/pricing");
    expect(f).not.toBeNull();
    expect(f!.misaligned).toEqual(["ad group name", "headlines", "descriptions", "landing page"]);
    expect(f!.issue).toBe("keyword_alignment");
    expect(f!.themeWords).toContain("chatbot");
  });
});

// ---------- requireDigits ----------

describe("requireDigits", () => {
  it("accepts digits and null", () => {
    expect(() => requireDigits("customer", "1111111111")).not.toThrow();
    expect(() => requireDigits("campaign", null)).not.toThrow(); // absent is fine
  });

  it("rejects injection", () => {
    expect(() => requireDigits("campaign", "1 OR 1=1")).toThrow();
  });
});
