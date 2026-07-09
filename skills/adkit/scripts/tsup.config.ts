import { defineConfig } from "tsup";

export default defineConfig([
  // The library entry ships dual-format: `exports.require` → dist/index.cjs, so
  // CommonJS consumers need it. This is the only entry that emits .cjs.
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: { entry: "src/index.ts" },
    clean: true,
    sourcemap: true,
    target: "node24",
    splitting: false,
  },
  // The bin entrypoints ship ESM only. They run under Node via `import.meta.url`
  // run-guards (and the package `bin` map + ads.sh both point at dist/bin/*.js);
  // a .cjs build compiles `import.meta.url` to `import_meta = {}`, silently turning
  // every bin into a no-op, so we don't emit one.
  {
    entry: {
      "bin/audit": "src/bin/audit.ts",
      "bin/create": "src/bin/create.ts",
      "bin/apply-fixes": "src/bin/apply-fixes.ts",
      "bin/report": "src/bin/report.ts",
      "bin/keyword-ideas": "src/bin/keyword-ideas.ts",
      "bin/preflight": "src/bin/preflight.ts",
      "bin/render-yaml": "src/bin/render-yaml.ts",
      "bin/bootstrap-secrets": "src/bin/bootstrap-secrets.ts",
    },
    format: ["esm"],
    sourcemap: true,
    target: "node24",
    splitting: false,
  },
]);
