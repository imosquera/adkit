import { describe, expect, it } from "vitest";
import { parseDkiField } from "./parse.js";
import { renderCasing, renderDkiPreview } from "./render.js";

describe("renderCasing", () => {
  it("keyword: lowercases entirely", () => {
    expect(renderCasing("keyword", "Running Shoes")).toBe("running shoes");
  });

  it("Keyword: sentence-cases (first letter only)", () => {
    expect(renderCasing("Keyword", "running shoes")).toBe("Running shoes");
  });

  it("KeyWord: title-cases every word", () => {
    expect(renderCasing("KeyWord", "running shoes")).toBe("Running Shoes");
  });

  it("KeyWord does not preserve all-caps tokens (no token awareness)", () => {
    expect(renderCasing("KeyWord", "trip to usa")).toBe("Trip To Usa");
  });

  it("KEYWord: title-cases but preserves known all-caps tokens", () => {
    expect(renderCasing("KEYWord", "trip to usa")).toBe("Trip To USA");
  });

  it("KeyWORD: title-cases but preserves known all-caps tokens", () => {
    expect(renderCasing("KeyWORD", "usa road trip")).toBe("USA Road Trip");
  });

  it("all-caps token lookup is case-insensitive on the input", () => {
    expect(renderCasing("KEYWord", "flying to UsA")).toBe("Flying To USA");
  });
});

describe("renderDkiPreview", () => {
  it("substitutes each code with the rendered keyword, leaving literal text untouched", () => {
    const field = parseDkiField("headline", "Best {KeyWord:Running Shoes} Deals");
    expect(renderDkiPreview(field, "sneakers")).toBe("Best Sneakers Deals");
  });

  it("substitutes multiple codes independently, each under its own casing mode", () => {
    const field = parseDkiField("description", "{keyword:a} meets {KeyWord:b}");
    expect(renderDkiPreview(field, "shoes")).toBe("shoes meets Shoes");
  });

  it("returns the field unchanged when it has no codes", () => {
    const field = parseDkiField("headline", "Plain headline text");
    expect(renderDkiPreview(field, "shoes")).toBe("Plain headline text");
  });
});
