import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlatformError,
  googleOnlyRefusal,
  parsePlatform,
  resolvePlatform,
  routePlatform,
  runMeta,
  stripPlatformFlag,
} from "./platform.js";

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

describe("routePlatform / runMeta", () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const envelope = (): Record<string, unknown> =>
    JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join("")) as Record<string, unknown>;

  it("continues on the Google path with --platform stripped, never loading Meta", async () => {
    const load = vi.fn(async () => ({ main: async () => 0 }));
    expect(await routePlatform(["--platform", "google", "x"], {}, {}, load)).toEqual({ kind: "google", argv: ["x"] });
    expect(load).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("runs the Meta main on stripped argv and exits with its code", async () => {
    const main = vi.fn(async () => 3);
    const env = { ADKIT_PLATFORM: "meta" };
    expect(await routePlatform(["--platform=meta", "a"], env, {}, async () => ({ main }))).toEqual({ kind: "exit", code: 3 });
    expect(main).toHaveBeenCalledWith(["a"], env);
  });

  it("delegates when the input itself declares Meta, passing it the stripped argv", async () => {
    const main = vi.fn(async () => 0);
    const declares = vi.fn((argv: readonly string[]) => argv[0] === "meta-brief.yaml");
    expect(await routePlatform(["--platform", "google", "meta-brief.yaml"], {}, {}, async () => ({ main }), declares)).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(declares).toHaveBeenCalledWith(["meta-brief.yaml"]);
    expect(main).toHaveBeenCalledWith(["meta-brief.yaml"], {});
  });

  it("emits a platform-step envelope and exits 1 on an unknown platform", async () => {
    const load = vi.fn(async () => ({ main: async () => 0 }));
    expect(await routePlatform([], { ADKIT_PLATFORM: "bing" }, {}, load)).toEqual({ kind: "exit", code: 1 });
    expect(load).not.toHaveBeenCalled();
    expect(envelope()).toMatchObject({ ok: false, step: "platform" });
  });

  it("turns a throw from the Meta main into a redacted unexpected-step envelope, exit 1", async () => {
    const main = async (): Promise<number> => {
      throw new TypeError("boom at https://graph.facebook.com/v1?access_token=EAABsecret&x=1");
    };
    expect(await runMeta(["--platform", "meta"], {}, async () => ({ main }))).toBe(1);
    const out = envelope();
    expect(out).toMatchObject({ ok: false, step: "unexpected" });
    expect(String(out["message"])).toContain("TypeError: boom");
    expect(String(out["message"])).not.toContain("EAABsecret");
    expect(String(out["message"])).toContain("access_token=[REDACTED]");
  });
});
