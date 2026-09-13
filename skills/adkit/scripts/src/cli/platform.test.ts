import { describe, expect, it } from "vitest";
import { PlatformError, googleOnlyRefusal, parsePlatform, resolvePlatform, stripPlatformFlag } from "./platform.js";

describe("parsePlatform", () => {
  it("defaults undefined, null and blank to google", () => {
    expect(parsePlatform(undefined, "x")).toEqual({ kind: "ok", value: "google" });
    expect(parsePlatform(null, "x")).toEqual({ kind: "ok", value: "google" });
    expect(parsePlatform("  ", "x")).toEqual({ kind: "ok", value: "google" });
  });

  it("accepts google and meta, trimming whitespace", () => {
    expect(parsePlatform("google", "x")).toEqual({ kind: "ok", value: "google" });
    expect(parsePlatform(" meta ", "x")).toEqual({ kind: "ok", value: "meta" });
  });

  it("rejects unknown values naming the source", () => {
    const result = parsePlatform("tiktok", "ADKIT_PLATFORM");
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.message).toContain("ADKIT_PLATFORM");
    expect(result.kind === "err" && result.message).toContain("tiktok");
  });

  it("rejects non-string values", () => {
    expect(parsePlatform(42, "adkit.yaml").kind).toBe("err");
    expect(parsePlatform("META", "x").kind).toBe("err");
  });
});

describe("resolvePlatform", () => {
  it("defaults to google with nothing set", () => {
    expect(resolvePlatform([], {}, {})).toBe("google");
    expect(resolvePlatform([], { ADKIT_PLATFORM: "" }, { platform: " " })).toBe("google");
  });

  it("uses the config tier", () => {
    expect(resolvePlatform([], {}, { platform: "meta" })).toBe("meta");
  });

  it("env beats config", () => {
    expect(resolvePlatform([], { ADKIT_PLATFORM: "google" }, { platform: "meta" })).toBe("google");
    expect(resolvePlatform([], { ADKIT_PLATFORM: "meta" }, {})).toBe("meta");
  });

  it("flag beats env and config, in both spellings", () => {
    const env = { ADKIT_PLATFORM: "google" };
    expect(resolvePlatform(["--days", "7", "--platform", "meta"], env, { platform: "google" })).toBe("meta");
    expect(resolvePlatform(["--platform=meta"], env, { platform: "google" })).toBe("meta");
    expect(resolvePlatform(["--platform=google"], { ADKIT_PLATFORM: "meta" }, {})).toBe("google");
  });

  it("throws PlatformError naming the source of an invalid value", () => {
    const run = (argv: string[], env: NodeJS.ProcessEnv, config: { platform?: string }) => {
      try {
        resolvePlatform(argv, env, config);
        return null;
      } catch (error) {
        return error;
      }
    };
    const fromFlag = run(["--platform", "bing"], {}, {});
    expect(fromFlag).toBeInstanceOf(PlatformError);
    expect((fromFlag as PlatformError).step).toBe("platform");
    expect((fromFlag as PlatformError).message).toContain("--platform");
    expect((run([], { ADKIT_PLATFORM: "bing" }, {}) as Error).message).toContain("ADKIT_PLATFORM");
    expect((run([], {}, { platform: "bing" }) as Error).message).toContain("adkit.yaml");
  });

  it("does not fall through past an invalid higher tier", () => {
    expect(() => resolvePlatform([], { ADKIT_PLATFORM: "bing" }, { platform: "meta" })).toThrow(PlatformError);
  });

  it("throws when the flag has no value", () => {
    expect(() => resolvePlatform(["--platform"], {}, {})).toThrow(PlatformError);
    expect(() => resolvePlatform(["--platform="], {}, { platform: "meta" })).toThrow(/requires a value/);
  });
});

describe("stripPlatformFlag", () => {
  it("removes both spellings and keeps other args in order", () => {
    expect(stripPlatformFlag(["--days", "7", "--platform", "meta", "--json"])).toEqual(["--days", "7", "--json"]);
    expect(stripPlatformFlag(["--platform=meta", "brief.yaml"])).toEqual(["brief.yaml"]);
  });

  it("removes repeated occurrences", () => {
    expect(stripPlatformFlag(["--platform", "meta", "a", "--platform=google"])).toEqual(["a"]);
  });

  it("returns argv unchanged when no flag is present, without mutating input", () => {
    const argv = Object.freeze(["--days", "7"]);
    const out = stripPlatformFlag(argv);
    expect(out).toEqual(["--days", "7"]);
    expect(out).not.toBe(argv);
  });
});

describe("googleOnlyRefusal", () => {
  it("returns null when the platform resolves to google", () => {
    expect(googleOnlyRefusal("research", [], {}, {})).toBeNull();
    expect(googleOnlyRefusal("research", ["--platform", "google"], { ADKIT_PLATFORM: "meta" }, {})).toBeNull();
  });

  it("refuses a Meta run with a platform-step envelope naming the command", () => {
    expect(googleOnlyRefusal("keyword-ideas", ["--platform=meta"], {}, {})).toEqual({
      ok: false,
      message: "keyword-ideas is Google-only; Meta has no keyword planner equivalent",
      step: "platform",
    });
    expect(googleOnlyRefusal("research", [], {}, { platform: "meta" })).toMatchObject({
      message: "research is Google-only; Meta has no keyword planner equivalent",
    });
  });

  it("turns an unparseable platform into a platform-step envelope naming the tier", () => {
    const refusal = googleOnlyRefusal("research", [], { ADKIT_PLATFORM: "bing" }, {});
    expect(refusal).toMatchObject({ ok: false, step: "platform" });
    expect(refusal?.message).toContain("ADKIT_PLATFORM");
    expect(googleOnlyRefusal("research", ["--platform"], {}, {})).toMatchObject({
      ok: false,
      step: "platform",
      message: expect.stringMatching(/requires a value/),
    });
  });
});
