#!/usr/bin/env node
/*
 * Parse, Don't Validate — TypeScript AST scanner.
 *
 * Uses the TypeScript Compiler API (`typescript`, resolved from the target
 * project) to walk a real AST — no regex. Reads a JSON job on stdin:
 *
 *     { "files": [ { "path": "src/user.ts", "isParser": false }, ... ] }
 *
 * and writes findings to stdout:
 *
 *     { "findings": [ { "rule": "PDV004", "path": "src/user.ts", "line": 12 }, ... ] }
 *
 * Waiver comments and result presentation are handled by the Python driver;
 * this helper only reports structural findings. Exits non-zero (with a message
 * on stderr) when the TypeScript compiler cannot be loaded — the caller treats
 * that as a hard failure, never a silent downgrade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadTypeScript() {
  // Resolve `typescript` from the target project first (its node_modules),
  // then from this helper's own location as a fallback resolution base.
  for (const base of [process.cwd(), __dirname]) {
    try {
      const req = createRequire(path.join(base, '__pdv_resolve__.cjs'));
      return req('typescript');
    } catch (_) { /* try next base */ }
  }
  try { return require('typescript'); } catch (_) { return null; }
}

const ts = loadTypeScript();
if (!ts) {
  process.stderr.write(
    'cannot scan TypeScript — the `typescript` package is not installed in ' +
    'this project. Add it (e.g. `npm i -D typescript`) so the parser can ' +
    'build an AST.\n');
  process.exit(3);
}

// Casts to these types are ordinary structural narrowing (built-ins, DOM/BOM,
// standard-library globals), NOT domain-brand forging — PDV004 ignores them.
// A cast to a project brand like `Email`/`UserId` is not in this set and still
// flags outside a parser module.
const IGNORE = new Set([
  // language / utility types
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Record', 'Readonly',
  'Partial', 'Required', 'Pick', 'Omit', 'Promise', 'Error', 'Function',
  'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Uint32Array', 'Float32Array', 'Float64Array',
  // DOM / BOM / web-platform globals
  'Node', 'Element', 'Event', 'EventTarget', 'Document', 'Window', 'Text',
  'Blob', 'File', 'FormData', 'URL', 'URLSearchParams', 'Headers', 'Request',
  'Response', 'FileList', 'DataTransfer', 'MouseEvent', 'KeyboardEvent',
  'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'TouchEvent',
  'CustomEvent', 'ErrorEvent', 'MessageEvent', 'Storage', 'Location',
]);
// Whole families of platform types that are always structural narrowing.
const IGNORE_PREFIX = /^(HTML|SVG|CSS|WebGL|Audio|Video|Media|Canvas|RTCP?|IDB)/;
const VALIDATOR = /^(is[A-Z]\w*|validate\w*|checkValid\w*)$/;

function scanFile(file, findings) {
  let text;
  try {
    text = fs.readFileSync(file.path, 'utf8');
  } catch (_) {
    return;
  }
  const sf = ts.createSourceFile(
    file.path, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  const lineOf = (node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (rule, node) =>
    findings.push({ rule, path: file.path, line: lineOf(node) });
  const isUnknown = (t) => t && t.kind === ts.SyntaxKind.UnknownKeyword;

  const checkValidator = (name, returnType, node) => {
    if (name && returnType &&
        returnType.kind === ts.SyntaxKind.BooleanKeyword &&
        VALIDATOR.test(name)) {
      add('PDV003', node);
    }
  };

  const visit = (node) => {
    // PDV001 — the `any` type, wherever it appears (`: any`, `as any`, `T<any>`).
    if (node.kind === ts.SyntaxKind.AnyKeyword) add('PDV001', node);

    // PDV002 — JSON.parse whose result is not immediately typed `unknown`.
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'JSON' &&
        node.expression.name.text === 'parse') {
      const p = node.parent;
      const typedUnknown =
        (p && p.kind === ts.SyntaxKind.AsExpression && isUnknown(p.type)) ||
        (p && ts.isVariableDeclaration(p) && isUnknown(p.type));
      if (!typedUnknown) add('PDV002', node);
    }

    // PDV003 — boolean validator (function decl, method, or arrow/fn expr).
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      checkValidator(node.name.getText(sf), node.type, node.name);
    }
    if (ts.isVariableDeclaration(node) && node.name && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      checkValidator(node.name.getText(sf), node.initializer.type, node.name);
    }

    // PDV004 — brand cast (`x as Brand` / `<Brand>x`) outside a parser module.
    if (!file.isParser) {
      let typeNode = null;
      if (node.kind === ts.SyntaxKind.AsExpression ||
          node.kind === ts.SyntaxKind.TypeAssertionExpression) {
        typeNode = node.type;
      }
      if (typeNode && ts.isTypeReferenceNode(typeNode) &&
          ts.isIdentifier(typeNode.typeName)) {
        const name = typeNode.typeName.text;
        if (!IGNORE.has(name) && !IGNORE_PREFIX.test(name)) {
          add('PDV004', node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function main() {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    job = {};
  }
  const findings = [];
  for (const file of job.files || []) scanFile(file, findings);
  process.stdout.write(JSON.stringify({ findings }));
}

main();
