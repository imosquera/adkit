import { defineConfig } from "tsup";

export default defineConfig({
  // Explicit entry map: keeps the `bin/` output structure (package `bin` scripts
  // point at dist/bin/*.js) and excludes the co-located *.test.ts files.
  entry: {
    index: "src/index.ts",
    "bin/audit": "src/bin/audit.ts",
    "bin/create": "src/bin/create.ts",
    "bin/apply-fixes": "src/bin/apply-fixes.ts",
    "bin/report": "src/bin/report.ts",
    "bin/keyword-ideas": "src/bin/keyword-ideas.ts",
    "bin/preflight": "src/bin/preflight.ts",
    "bin/render-yaml": "src/bin/render-yaml.ts",
    "bin/bootstrap-secrets": "src/bin/bootstrap-secrets.ts",
  },
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  target: "node24",
  splitting: false,
});
