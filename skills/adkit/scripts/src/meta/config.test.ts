import { describe, expect, it, vi } from "vitest";

import type { AdkitConfig } from "../lib/config.js";
import { MetaConfigError } from "./errors.js";
import { AD_ACCOUNT_PROMPT, resolveMetaContext, type MetaContextDeps } from "./config.js";

const deps = (over: Partial<MetaContextDeps> = {}): MetaContextDeps => ({
  isTty: false,
  prompt: vi.fn(async () => ""),
  save: vi.fn(),
  secretsPath: "/p/.adkit.secrets.yaml",
  configPath: "/p/adkit.yaml",
  ...over,
});

const base: AdkitConfig = { meta_access_token: "EAAB-token", meta_ad_account_id: "111" };

const rejection = async (promise: Promise<unknown>): Promise<MetaConfigError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MetaConfigError);
  return error as MetaConfigError;
};

describe("resolveMetaContext", () => {
  it("parses a complete config into a MetaContext", async () => {
    const config: AdkitConfig = {
      ...base,
      meta_page_id: "222",
      meta_pixel_id: "333",
      meta_app_secret: "shh",
      psi_api_key: "psi",
    };
    await expect(resolveMetaContext({}, {}, config, deps())).resolves.toEqual({
      token: "EAAB-token",
      adAccountId: "act_111",
      pageId: "222",
      pixelId: "333",
      appSecret: "shh",
      psiApiKey: "psi",
    });
  });

  it("defaults optional fields to null", async () => {
    const ctx = await resolveMetaContext({}, {}, base, deps());
    expect(ctx).toMatchObject({ pageId: null, pixelId: null, appSecret: null, psiApiKey: null });
  });

  it("ranks --ad-account > META_AD_ACCOUNT_ID > config", async () => {
    const env = { META_AD_ACCOUNT_ID: "act_222" };
    expect((await resolveMetaContext({ adAccount: "333" }, env, base, deps())).adAccountId).toBe("act_333");
    expect((await resolveMetaContext({ adAccount: "  " }, env, base, deps())).adAccountId).toBe("act_222");
    expect((await resolveMetaContext({}, {}, base, deps())).adAccountId).toBe("act_111");
  });

  it("prefers env over config for token, app secret and PSI key; --psi-key wins for PSI", async () => {
    const env = { META_ACCESS_TOKEN: "env-token", META_APP_SECRET: "env-secret", PAGESPEED_API_KEY: "env-psi" };
    const config: AdkitConfig = { ...base, meta_app_secret: "cfg", psi_api_key: "cfg-psi" };
    expect(await resolveMetaContext({}, env, config, deps())).toMatchObject({
      token: "env-token",
      appSecret: "env-secret",
      psiApiKey: "env-psi",
    });
    expect((await resolveMetaContext({ psiKey: "flag-psi" }, env, config, deps())).psiApiKey).toBe("flag-psi");
  });

  it("accepts an unquoted numeric ad account id from YAML", async () => {
    const config = { ...base, meta_ad_account_id: 444 as unknown as string };
    expect((await resolveMetaContext({}, {}, config, deps())).adAccountId).toBe("act_444");
  });

  it("fails with step credentials naming the field, secrets path and ads.sh init when the token is missing", async () => {
    const error = await rejection(resolveMetaContext({}, {}, { meta_ad_account_id: "111" }, deps()));
    expect(error.step).toBe("credentials");
    expect(error.field).toBe("meta_access_token");
    expect(error.path).toBe("/p/.adkit.secrets.yaml");
    expect(error.message).toContain("meta_access_token");
    expect(error.message).toContain("/p/.adkit.secrets.yaml");
    expect(error.message).toContain("ads.sh init");
  });

  it("never prompts for the token, even on a TTY", async () => {
    const d = deps({ isTty: true, prompt: vi.fn(async () => "act_1") });
    await rejection(resolveMetaContext({}, {}, { meta_ad_account_id: "111" }, d));
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it("fails with step ad-account off a TTY when no tier supplies an account, without prompting", async () => {
    const d = deps();
    const error = await rejection(resolveMetaContext({}, {}, { meta_access_token: "t" }, d));
    expect(error.step).toBe("ad-account");
    expect(error.field).toBe("meta_ad_account_id");
    expect(error.path).toBe("/p/adkit.yaml");
    expect(d.prompt).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("prompts once on a TTY and saves the canonical id", async () => {
    const d = deps({ isTty: true, prompt: vi.fn(async () => " 555 ") });
    const ctx = await resolveMetaContext({}, {}, { meta_access_token: "t" }, d);
    expect(ctx.adAccountId).toBe("act_555");
    expect(d.prompt).toHaveBeenCalledTimes(1);
    expect(d.prompt).toHaveBeenCalledWith(AD_ACCOUNT_PROMPT);
    expect(d.save).toHaveBeenCalledWith("meta_ad_account_id", "act_555");
  });

  it("does not save a blank or malformed prompted answer", async () => {
    const blank = deps({ isTty: true, prompt: vi.fn(async () => "  ") });
    expect((await rejection(resolveMetaContext({}, {}, { meta_access_token: "t" }, blank))).step).toBe("ad-account");
    expect(blank.save).not.toHaveBeenCalled();

    const bad = deps({ isTty: true, prompt: vi.fn(async () => "act-12") });
    expect((await rejection(resolveMetaContext({}, {}, { meta_access_token: "t" }, bad))).step).toBe("ad-account");
    expect(bad.save).not.toHaveBeenCalled();
  });

  it("reports a malformed tier against its source and does not fall through", async () => {
    const error = await rejection(
      resolveMetaContext({}, { META_AD_ACCOUNT_ID: "nope" }, base, deps({ isTty: true })),
    );
    expect(error.step).toBe("ad-account");
    expect(error.message).toContain("META_AD_ACCOUNT_ID");
  });

  it("rejects malformed page and pixel ids with step config", async () => {
    const page = await rejection(resolveMetaContext({}, {}, { ...base, meta_page_id: "page-x" }, deps()));
    expect(page).toMatchObject({ step: "config", field: "meta_page_id" });
    const pixel = await rejection(resolveMetaContext({}, {}, { ...base, meta_pixel_id: "px" }, deps()));
    expect(pixel).toMatchObject({ step: "config", field: "meta_pixel_id" });
  });

  it("uses default file names in errors when paths are not injected", async () => {
    const error = await rejection(
      resolveMetaContext({}, {}, {}, { isTty: false, prompt: async () => "", save: () => undefined }),
    );
    expect(error.message).toContain(".adkit.secrets.yaml");
  });
});
