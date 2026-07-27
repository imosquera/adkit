import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doneLine, existsLine, main, promptFor } from "./init.js";

describe("promptFor", () => {
  it("shows the default inline when one is present", () => {
    expect(promptFor("Read backend (sdk|mcp)", "sdk")).toBe("Read backend (sdk|mcp) [sdk]: ");
  });

  it("omits the bracketed default when there isn't one", () => {
    expect(promptFor("Default target/leaf customer id", "")).toBe("Default target/leaf customer id: ");
  });
});

describe("messages", () => {
  it("formats the completion and already-exists lines", () => {
    expect(doneLine("/a/.adkit.yaml")).toBe("wrote /a/.adkit.yaml\n");
    expect(existsLine("/a/.adkit.yaml")).toBe(
      "/a/.adkit.yaml already exists — leaving it in place. Edit it directly, or delete it and rerun init.\n",
    );
  });
});

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

describe("main (temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-init-"));
    cwd = process.cwd();
    process.chdir(dir);
    delete process.env["ADKIT_CONFIG"];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env["ADKIT_CONFIG"];
    vi.mocked(createInterface).mockReset();
  });

  /** Answers are consumed in field order via the async-iterator protocol `promptAll` reads from. */
  function mockAnswers(answers: string[]): void {
    let i = 0;
    vi.mocked(createInterface).mockImplementation(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (i >= answers.length) {
                return { value: undefined, done: true };
              }
              const value = answers[i];
              i += 1;
              return { value, done: false };
            },
          }),
          close: () => {},
        }) as unknown as ReturnType<typeof createInterface>,
    );
  }

  it("writes the config from prompted answers when no file exists", async () => {
    mockAnswers(["1234567890", "", "proj-x", "", "", "", ""]);
    const code = await main();
    expect(code).toBe(0);
    const written = readFileSync(join(dir, ".adkit.yaml"), "utf8");
    expect(written).toContain('login_customer_id: "1234567890"');
    expect(written).toContain('secrets_project: "proj-x"');
    expect(written).toContain('read_backend: "sdk"');
    expect(written).toContain('reports_dir: "ads/output/reports"');
    expect(written).not.toContain("target_customer_id");
  });

  it("leaves an existing config file untouched", async () => {
    writeFileSync(join(dir, ".adkit.yaml"), 'secrets_project: "already-here"\n');
    mockAnswers([]);
    const code = await main();
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".adkit.yaml"), "utf8")).toBe('secrets_project: "already-here"\n');
    expect(createInterface).not.toHaveBeenCalled();
  });
});
