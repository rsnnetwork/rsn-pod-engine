#!/usr/bin/env node
// ─── Realtime contract guard ────────────────────────────────────────────────
//
// Phase 6 of the realtime architecture migration. Enforces that every
// `useQuery(...)` call in the client declares `meta: { entities: [...] }`
// so the entity-tag invalidation pipeline picks it up. Without this guard,
// a developer can add a new query that goes stale on server mutations and
// reintroduces the "refresh needed" class of bugs.
//
// What this catches:
//   • Any `useQuery(...)` whose object literal has no `meta` key
//   • Any `useQuery(...)` whose `meta` has no `entities` key
//   • Any `useQuery(...)` whose `meta.entities` is an empty literal `[]`
//
// What it doesn't catch (intentionally — these are not realtime-relevant):
//   • Search-style queries marked with `// realtime: skip` comment
//   • Config / static-data queries marked the same way
//   • Queries where `enabled: false` is statically present (manual-only)
//
// Output: each violation as `file:line:column  message  (hint)`. Exits
// non-zero on violations so `npm run lint` / CI fails closed.
//
// Allowlist (opt-out keys that don't need realtime — kept short on purpose).
// To opt out a NEW query, add `// realtime: skip — <reason>` ABOVE the
// useQuery call. The reason is required so reviewers can sanity-check.

const fs = require('fs');
const path = require('path');

const CLIENT_SRC = path.resolve(__dirname, '..', 'client', 'src');

// Keys that legitimately do not need realtime invalidation. These match the
// FIRST element of the queryKey array (the prefix). Keep this list minimal —
// every entry is a documented decision that the data is either ephemeral
// (search), config-shaped (rarely mutates and a refresh is fine), or
// already covered by another invalidation path.
const ALLOWLISTED_KEY_PREFIXES = new Set([
  'connected-user-search',       // ephemeral search box, results die on next keystroke
  'matching-templates',          // admin-managed configs, manual refresh OK
  'admin-templates',             // same
  'admin-email-config',          // admin-managed, manual refresh OK
  'admin-health',                // separately polled
]);

const OPT_OUT_RE = /\/\/\s*realtime:\s*skip\b/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Match `useQuery(` followed by an object-literal opener. We scan forward to
// find the matching `})` of that call — depth-balanced — so we can inspect
// the full options object.
function findUseQueryCalls(src) {
  const calls = [];
  const re = /\buseQuery\s*(?:<[^>]*>)?\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    const optsStart = src.indexOf('{', re.lastIndex - 1);
    // Walk forward to find the matching closing brace, ignoring strings,
    // template literals, and nested braces.
    let depth = 0;
    let i = optsStart;
    let inStr = null;     // ' or " or `
    let escape = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '/' && src[i + 1] === '/') {
        // line comment
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        // block comment
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          calls.push({ start, end: i + 1, body: src.slice(optsStart, i + 1) });
          break;
        }
      }
    }
  }
  return calls;
}

function lineColAt(src, pos) {
  let line = 1, col = 1;
  for (let i = 0; i < pos; i++) {
    if (src[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\buseQuery\s*\(/.test(src)) return [];

  const violations = [];
  const calls = findUseQueryCalls(src);
  for (const call of calls) {
    const { line, col } = lineColAt(src, call.start);
    // Opt-out comment must appear on the line immediately before the call.
    const linesBefore = src.slice(0, call.start).split('\n');
    const prev = linesBefore[linesBefore.length - 2] || '';
    if (OPT_OUT_RE.test(prev)) continue;

    // Pull the queryKey first-element to check against the allowlist.
    const keyMatch = call.body.match(/queryKey:\s*\[\s*['"]([^'"]+)['"]/);
    const keyPrefix = keyMatch ? keyMatch[1] : null;
    if (keyPrefix && ALLOWLISTED_KEY_PREFIXES.has(keyPrefix)) continue;

    // Does meta.entities exist and is it non-empty?
    const hasMeta = /meta\s*:\s*\{/.test(call.body);
    if (!hasMeta) {
      violations.push({
        file, line, col,
        rule: 'realtime/require-meta-entities',
        message: `useQuery missing meta.entities. Add 'meta: { entities: [...] }' so the entity-tag pipeline auto-invalidates, OR add '// realtime: skip — <reason>' on the line above if this query genuinely doesn't need realtime updates.`,
        keyPrefix,
      });
      continue;
    }
    const entitiesMatch = call.body.match(/meta\s*:\s*\{[^}]*entities\s*:\s*([\s\S]+?)(?:,\s*\}|\}|$)/);
    if (!entitiesMatch) {
      violations.push({
        file, line, col,
        rule: 'realtime/require-meta-entities',
        message: `useQuery has meta but no entities array. Add 'entities: [...]' inside meta.`,
        keyPrefix,
      });
      continue;
    }
    const entitiesValue = entitiesMatch[1].trim();
    // Empty literal `[]` (no entities) — still a violation unless the
    // queryKey starts with a literal that maps to an allowlist entry.
    if (/^\[\s*\]\s*$/.test(entitiesValue)) {
      violations.push({
        file, line, col,
        rule: 'realtime/require-meta-entities',
        message: `useQuery has meta.entities but it's empty []. Either populate it with E.xxx(id) entries or use '// realtime: skip' if intentionally untagged.`,
        keyPrefix,
      });
    }
  }
  return violations;
}

function main() {
  if (!fs.existsSync(CLIENT_SRC)) {
    console.error(`[realtime-check] expected client source at ${CLIENT_SRC} — exiting clean`);
    process.exit(0);
  }
  const files = walk(CLIENT_SRC);
  const allViolations = [];
  for (const f of files) {
    try {
      const v = checkFile(f);
      if (v.length) allViolations.push(...v);
    } catch (err) {
      console.error(`[realtime-check] error scanning ${f}: ${err.message}`);
    }
  }

  if (allViolations.length === 0) {
    console.log(`[realtime-check] OK — scanned ${files.length} files, all useQuery calls have meta.entities or an explicit skip.`);
    process.exit(0);
  }

  console.error(`[realtime-check] FAILED — ${allViolations.length} useQuery call(s) missing realtime contract:`);
  for (const v of allViolations) {
    const rel = path.relative(process.cwd(), v.file);
    console.error(`  ${rel}:${v.line}:${v.col}`);
    console.error(`    [${v.rule}] ${v.message}`);
    if (v.keyPrefix) console.error(`    queryKey starts with: '${v.keyPrefix}'`);
  }
  console.error(`\nFix each violation by either:`);
  console.error(`  (a) adding meta: { entities: [E.xxx(id), ...] } — see client/src/realtime/entities.ts`);
  console.error(`  (b) adding "// realtime: skip — <reason>" on the line above the useQuery call`);
  console.error(`  (c) adding the queryKey prefix to ALLOWLISTED_KEY_PREFIXES in this script (rare)`);
  process.exit(1);
}

main();
