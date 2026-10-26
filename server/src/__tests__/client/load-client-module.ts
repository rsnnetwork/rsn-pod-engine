// ─── Running a client file from a server test ────────────────────────────────────────────────────────
//
// The client's source pins used to be regular expressions over a file's text. Some things are better checked by
// running the file: what a component draws, in what order, with which attributes. The client's own imports (its
// `@/` alias, the animation library, the router, the icon set) are not available to jest, so a file is transpiled
// and loaded here with those imports replaced by small stand-ins; everything else (`react`, `@rsn/shared`) is real.
//
// This file ends in .ts, not .test.ts, so jest does not run it as a suite.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createElement } from 'react';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');

/** A client file's text. A Windows working tree is CRLF; normalised so a pattern matches either way. */
export function readClientSource(rel: string): string {
  return fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * A client file, run. `rel` is relative to client/src; `stand` maps an import's exact text ('@/components/ui/Button',
 * 'react-router-dom') to what it should give instead. An import not in `stand` is loaded for real.
 */
export function loadClientModule(rel: string, stand: Record<string, unknown>): Record<string, unknown> {
  const { outputText } = ts.transpileModule(readClientSource(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
  return mod.exports;
}

/** An icon set that draws an empty, tagged svg for any icon asked of it (`<svg data-icon="Check">`). */
export const iconStandIns: Record<string, unknown> = new Proxy({ __esModule: true } as Record<string, unknown>, {
  get: (target, name: string) => (name in target ? target[name] : (props: object) => createElement('svg', { 'data-icon': name, ...props })),
});
