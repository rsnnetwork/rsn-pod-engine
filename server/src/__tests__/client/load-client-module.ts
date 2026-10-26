// ─── Running a client file from a server test ────────────────────────────────────────────────────────
//
// The client's source pins used to be regular expressions over a file's text. Some things are better checked by
// running the file: what a component draws, in what order, with which attributes. The client's own imports (its
// `@/` alias, the animation library, the router, the icon set) are not available to jest, so a file is transpiled
// and loaded here with those imports replaced by small stand-ins; everything else (`react`, `@rsn/shared`) is real.
// An import of another client file (`./pod-form`, `@/lib/utils`) is followed into the client source and run the
// same way, unless a stand-in is given for it.
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

/** The client file an import names, relative to client/src, or null when it names no client file (a package). */
function clientFileFor(fromRel: string, id: string): string | null {
  if (!id.startsWith('.') && !id.startsWith('@/')) return null;
  const base = id.startsWith('@/') ? id.slice(2) : path.posix.join(path.posix.dirname(fromRel), id);
  const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .find((candidate) => {
      const file = path.join(CLIENT_SRC, candidate);
      return fs.existsSync(file) && fs.statSync(file).isFile();
    });
  if (!found) throw new Error(`${fromRel} imports ${id}, which is no client file`);
  return found;
}

function run(rel: string, stand: Record<string, unknown>, loaded: Map<string, Record<string, unknown>>): Record<string, unknown> {
  const cached = loaded.get(rel);
  if (cached) return cached;
  const { outputText } = ts.transpileModule(readClientSource(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  loaded.set(rel, mod.exports);
  const load = (id: string): unknown => {
    if (id in stand) return stand[id];
    const file = clientFileFor(rel, id);
    return file ? run(file, stand, loaded) : require(id);
  };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
  return mod.exports;
}

/**
 * A client file, run. `rel` is relative to client/src; `stand` maps an import's exact text ('@/components/ui/Button',
 * 'react-router-dom') to what it should give instead. Any other import is loaded for real: a package from node_modules,
 * a client file from the client source.
 */
export function loadClientModule(rel: string, stand: Record<string, unknown>): Record<string, unknown> {
  return run(rel, stand, new Map());
}

/** An icon set that draws an empty, tagged svg for any icon asked of it (`<svg data-icon="Check">`). */
export const iconStandIns: Record<string, unknown> = new Proxy({ __esModule: true } as Record<string, unknown>, {
  get: (target, name: string) => (name in target ? target[name] : (props: object) => createElement('svg', { 'data-icon': name, ...props })),
});
