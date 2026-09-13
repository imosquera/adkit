import { describe, expect, it } from "vitest";

import { DEFAULT_RESULT_ACTION, parseAdAccountFlag, parseResultAction } from "./args.js";

describe("parseAdAccountFlag", () => {
  it.each([
    [[], null],
    [["--ad-account", "act_9"], "act_9"],
    [["--ad-account=77"], "77"],
    [["--ad-account", " act_9 ", "--days", "7"], "act_9"],
    [["--ad-account", "act_1", "--ad-account=act_2"], "act_2"],
    [["--days", "7"], null],
  ])("%j → %j", (argv, expected) => {
    expect(parseAdAccountFlag(argv)).toEqual({ kind: "ok", value: expected });
  });

  it.each([[["--ad-account"]], [["--ad-account", "--days", "7"]], [["--ad-account="]], [["--ad-account", "  "]], [["--ad-account", "act_1", "--ad-account"]]])(
    "rejects a valueless flag in %j",
    (argv) => {
      expect(parseAdAccountFlag(argv)).toEqual({ kind: "err", message: "--ad-account requires a value" });
    },
  );
});

describe("parseResultAction", () => {
  it("defaults when absent and trims a given value", () => {
    expect(parseResultAction(undefined)).toEqual({ kind: "ok", value: DEFAULT_RESULT_ACTION });
    expect(parseResultAction(" purchase ")).toEqual({ kind: "ok", value: "purchase" });
  });

  it.each([[""], ["   "], [true]])("rejects %j", (raw) => {
    expect(parseResultAction(raw)).toMatchObject({ kind: "err", message: expect.stringMatching(/--result-action/) });
  });
});
