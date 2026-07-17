/**
 * Python-compatible value formatting for the CLI print lines the /adkit fixes
 * pipeline emits. These match Python f-string semantics because the human-readable
 * output (and the tests that assert on it) were ported from the original
 * `apply_fixes.py` / plan validator, which used `f"...{x!r}..."` (repr) and
 * `f"...{x}..."` (str). Both `apply-fixes.ts` and `fixes/plan.ts` share these so the
 * exact quoting lives in one place.
 */

/**
 * Python `repr` for the values that flow through the print/error strings:
 * single-quoted strings (backslash + quote escaped), bare `True`/`False`/`None`,
 * numbers as-is. Mirrors `f"...{x!r}..."`.
 */
export function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  return String(value);
}

/** Render a value for a `{x}` (str, not repr) slot; `None` for null/undefined. */
export function pyStr(value: unknown): string {
  if (value === undefined || value === null) {
    return "None";
  }
  return String(value);
}
