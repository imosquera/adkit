import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaContext, MetaContextFlags } from "../config.js";
import { resolveMetaContext } from "../config.js";
import { MetaConfigError } from "../errors.js";
import { fakeMetaClient, metaApiError, type FakeMetaClient, type FakeMetaClientOptions } from "../fake-client.js";
import { MetaAccessTokenSchema, MetaAdAccountIdSchema } from "../ids.js";
import {
  accountStatusProblem,
  describeAccountStatus,
  main,
  missingPermissions,
  parsePreflightArgs,
} from "./preflight.js";

const CTX: MetaContext = {
  token: MetaAccessTokenSchema.parse("EAAtoken"),
  adAccountId: MetaAdAccountIdSchema.parse("act_1234567890"),
  pageId: null,
  pixelId: null,
  appSecret: null,
  psiApiKey: null,
};

const ACCOUNT = { id: "act_1234567890", name: "Acme", account_status: 1, currency: "USD", disable_reason: 0 };
const GRANTED = [
  { permission: "ads_read", status: "granted" },
  { permission: "ads_management", status: "granted" },
  { permission: "public_profile", status: "granted" },
];

/** A fake answering the three preflight reads, overridable per path. */
const happyGet =
  (overrides: Readonly<Record<string, unknown>> = {}) =>
  (path: string): unknown =>
    path in overrides
      ? overrides[path]
      : path === "me"
        ? { id: "42", name: "Ops" }
        : path === "act_1234567890"
          ? ACCOUNT
          : path === "me/permissions"
            ? GRANTED
            : undefined;

describe("parsePreflightArgs", () => {
  it("reads --ad-account, defaulting to null", () => {
    expect(parsePreflightArgs(["--ad-account", "act_9"])).toEqual({ kind: "ok", value: { adAccount: "act_9" } });
    expect(parsePreflightArgs(["--ad-account=77"])).toEqual({ kind: "ok", value: { adAccount: "77" } });
    expect(parsePreflightArgs([])).toEqual({ kind: "ok", value: { adAccount: null } });
  });

  it("rejects a bare --ad-account instead of falling back to the configured account", () => {
    expect(parsePreflightArgs(["--ad-account"])).toEqual({ kind: "err", message: "--ad-account requires a value" });
  });
});

describe("pure helpers", () => {
  it("describes documented and undocumented account statuses", () => {
    expect(describeAccountStatus(2)).toBe("DISABLED (2)");
    expect(describeAccountStatus(42)).toBe("status 42");
  });

  it("flags only non-active accounts, naming status and disable_reason", () => {
    const parse = (fields: object) => ({ ...ACCOUNT, id: MetaAdAccountIdSchema.parse(ACCOUNT.id), ...fields });
    expect(accountStatusProblem(parse({}))).toBeNull();
    const problem = accountStatusProblem(parse({ account_status: 3, disable_reason: 5 }));
    expect(problem).toContain("UNSETTLED (3)");
    expect(problem).toContain("disable_reason 5");
  });

  it("lists missing permissions, treating declined/expired as missing", () => {
    expect(missingPermissions([])).toEqual(["ads_read", "ads_management"]);
    expect(
      missingPermissions([
        { permission: "ads_read", status: "granted" },
        { permission: "ads_management", status: "declined" },
      ]),
    ).toEqual(["ads_management"]);
  });
});

describe("main", () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const emitted = (): Record<string, unknown> =>
    JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join("")) as Record<string, unknown>;

  const run = async (
    fake: FakeMetaClientOptions = { get: happyGet() },
    resolveContext: (flags: MetaContextFlags) => Promise<MetaContext> = async () => CTX,
    argv: string[] = [],
  ): Promise<{ code: number; client: FakeMetaClient; built: MetaContext[] }> => {
    const client = fakeMetaClient({ readOnly: true, ...fake });
    const built: MetaContext[] = [];
    const code = await main(argv, {}, {
      resolveContext,
      clientFactory: (ctx) => {
        built.push(ctx);
        return client;
      },
    });
    return { code, client, built };
  };

  it("emits the success envelope after auth, access and permissions pass", async () => {
    const { code, client, built } = await run();
    expect(code).toBe(0);
    expect(emitted()).toEqual({
      ok: true,
      platform: "meta",
      adAccountId: "act_1234567890",
      accountName: "Acme",
      currency: "USD",
    });
    expect(built).toEqual([CTX]);
    expect(client.calls.map((c) => [c.method, c.path, c.step])).toEqual([
      ["get", "me", "auth"],
      ["get", "act_1234567890", "access"],
      ["getAll", "me/permissions", "permissions"],
    ]);
    expect(client.calls[1]).toMatchObject({
      params: { fields: ["name", "account_status", "currency", "disable_reason"] },
    });
  });

  it("passes --ad-account to the context resolver", async () => {
    const seen: MetaContextFlags[] = [];
    await run(undefined, async (flags) => {
      seen.push(flags);
      return CTX;
    }, ["--ad-account", "act_555"]);
    expect(seen).toEqual([{ adAccount: "act_555" }]);
  });

  it.each([[["--ad-account"]], [["--ad-account="]]])("fails at args on a valueless --ad-account %j without resolving context", async (argv) => {
    const seen: MetaContextFlags[] = [];
    const { code, client, built } = await run(undefined, async (flags) => {
      seen.push(flags);
      return CTX;
    }, argv);
    expect(code).toBe(1);
    expect(emitted()).toEqual({ ok: false, step: "args", message: "--ad-account requires a value" });
    expect(seen).toEqual([]);
    expect(built).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("fails at credentials (with the resolver's own step) and never builds a client", async () => {
    const { code, built } = await run(undefined, (flags) =>
      resolveMetaContext(flags, {}, {}, { isTty: false, prompt: async () => "", save: () => undefined }),
    );
    expect(code).toBe(1);
    expect(built).toEqual([]);
    expect(emitted()).toMatchObject({ ok: false, step: "credentials" });
    expect(String(emitted()["message"])).toContain("meta_access_token");
  });

  it("reports the ad-account step when the account cannot be resolved", async () => {
    const { code } = await run(undefined, async () => {
      throw new MetaConfigError("ad-account", "no meta_ad_account_id", "meta_ad_account_id", "adkit.yaml");
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "ad-account" });
  });

  it("fails at auth when the token is rejected", async () => {
    const { code, client } = await run({
      get: happyGet(),
      failOn: (call) => (call.path === "me" ? metaApiError(190, "Invalid OAuth access token") : null),
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "auth" });
    expect(String(emitted()["message"])).toContain("Invalid OAuth access token");
    expect(client.calls).toHaveLength(1);
  });

  it("fails at access when the account is not visible", async () => {
    const { code } = await run({
      get: happyGet(),
      failOn: (call) => (call.path === "act_1234567890" ? metaApiError(100, "Unsupported get request") : null),
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "access" });
  });

  it("fails at access naming a non-active account_status", async () => {
    const { code, client } = await run({ get: happyGet({ act_1234567890: { ...ACCOUNT, account_status: 2 } }) });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "access" });
    expect(String(emitted()["message"])).toContain("DISABLED (2)");
    expect(client.calls.map((c) => c.path)).not.toContain("me/permissions");
  });

  it("fails at permissions naming each missing permission", async () => {
    const { code } = await run({
      get: happyGet({ "me/permissions": [{ permission: "ads_read", status: "granted" }] }),
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "permissions" });
    const message = String(emitted()["message"]);
    expect(message).toContain("ads_management");
    expect(message).not.toContain("ads_read,");
  });

  it("labels a non-Meta throw with the step that was running", async () => {
    const { code } = await run({
      get: (path) => {
        if (path === "me/permissions") throw new Error("network down");
        return happyGet()(path);
      },
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "permissions" });
  });
});
