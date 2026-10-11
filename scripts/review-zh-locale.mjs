#!/usr/bin/env node
/**
 * Review src/lang/locale/zh.ts against en.ts.
 *
 * Flags the mechanical problems that a 759-key hand-written table tends to have:
 *
 *   1. placeholder mismatch — the set of {placeholders} differs between en and zh, so
 *      the Chinese would drop a value or print a literal `{name}`.
 *   2. untranslated — the Chinese value is byte-identical to the English one, or
 *      contains a long run of Latin prose, so it was probably left as-is by accident.
 *   3. whitespace mismatch — leading/trailing spaces differ, which matters for the
 *      strings that are concatenated with other fragments.
 *
 * This is a *mechanical* review. It cannot judge whether the Chinese reads well; the
 * wording pass is manual.
 *
 *   node scripts/review-zh-locale.mjs
 *   node scripts/review-zh-locale.mjs --json
 *
 * Exit code is always 0: this reports, it does not gate. The gate that matters is
 * `tsc`, which already proves key parity.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EN_PATH = join(ROOT, 'src', 'lang', 'locale', 'en.ts');
const ZH_PATH = join(ROOT, 'src', 'lang', 'locale', 'zh.ts');

const ENTRY = /^\t'([^']+)':\s*'((?:[^'\\\n]|\\.)*)',?\s*$/gm;

function unescapeTs(raw) {
  return raw.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[\s\S])/g, (_, g) => {
    switch (g[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'x':
      case 'u': return String.fromCharCode(parseInt(g.slice(1), 16));
      case '\n': return '';
      default: return g;
    }
  });
}

function readTable(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const map = new Map();
  for (const m of text.matchAll(ENTRY)) {
    const line = lines.findIndex((l) => l.includes(`'${m[1]}':`)) + 1;
    map.set(m[1], { value: unescapeTs(m[2]), line });
  }
  return map;
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function latinRuns(value) {
  // runs of 4+ ASCII words, the tell-tale of untranslated prose
  return [...value.matchAll(/\b[A-Za-z][A-Za-z''-]*(?:\s+[A-Za-z][A-Za-z''-]*){3,}\b/g)].map((m) => m[0]);
}

/**
 * Keys reviewed by hand and accepted.
 *
 * `settings.misc.help.v0-each-will-be-evaluated-as-a-javascrip` is dead: it is a leftover
 * duplicate from upstream PR #588 with no call site anywhere (`grep -rn
 * 'v0-each-will-be-evaluated' src/` matches only the two table entries), so its unused
 * `{v0}`/`{v1}` never render. Both tables are upstream-owned, so it is left as-is and
 * reported to #588 instead of being deleted here.
 */
const REVIEWED = new Set([
  'settings.misc.help.v0-each-will-be-evaluated-as-a-javascrip',
]);

const en = readTable(EN_PATH);
const zh = readTable(ZH_PATH);

const findings = { placeholderMismatch: [], untranslated: [], whitespace: [], missing: [] };

for (const [key, e] of en) {
  if (REVIEWED.has(key)) continue;
  const z = zh.get(key);
  if (!z) {
    findings.missing.push({ key, enLine: e.line });
    continue;
  }

  const pe = placeholders(e.value);
  const pz = placeholders(z.value);
  if (pe.join(',') !== pz.join(',')) {
    findings.placeholderMismatch.push({ key, enLine: e.line, zhLine: z.line, en: pe, zh: pz });
  }

  const enWs = e.value.match(/^\s*/)[0] + '|' + e.value.match(/\s*$/)[0];
  const zhWs = z.value.match(/^\s*/)[0] + '|' + z.value.match(/\s*$/)[0];
  if (enWs !== zhWs) {
    findings.whitespace.push({ key, enLine: e.line, zhLine: z.line, en: enWs, zh: zhWs });
  }

  if (e.value === z.value) {
    findings.untranslated.push({ key, enLine: e.line, zhLine: z.line, reason: 'identical to English', value: e.value });
    continue;
  }
  // A Chinese value with no CJK at all cannot be a translation.
  if (!/[\u3400-\u9FFF]/.test(z.value) && /[A-Za-z]{3}/.test(z.value)) {
    findings.untranslated.push({ key, enLine: e.line, zhLine: z.line, reason: 'no CJK characters', value: z.value });
    continue;
  }
  const runs = latinRuns(z.value);
  if (runs.length) {
    findings.untranslated.push({ key, enLine: e.line, zhLine: z.line, reason: 'long Latin run', value: runs[0] });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    enKeys: en.size,
    zhKeys: zh.size,
    ...findings,
  }, null, 2));
  process.exit(0);
}

console.log('zh.ts review');
console.log('============');
console.log(`en keys: ${en.size}   zh keys: ${zh.size}`);
console.log('');

const sections = [
  ['missing', 'keys present in en.ts but absent from zh.ts', (f) => `  ${f.key}`],
  ['placeholderMismatch', 'placeholder mismatch (Chinese would print a literal {name} or drop a value)', (f) => `  ${f.key}  en={${f.en.join(',')}}  zh={${f.zh.join(',')}}`],
  ['untranslated', 'looks untranslated', (f) => `  ${f.key}  [${f.reason}]  ${JSON.stringify(f.value).slice(0, 100)}`],
  ['whitespace', 'leading/trailing whitespace differs (matters for concatenated fragments)', (f) => `  ${f.key}  en=${JSON.stringify(f.en)}  zh=${JSON.stringify(f.zh)}`],
];

for (const [name, title, fmt] of sections) {
  const list = findings[name];
  console.log(`## ${title}: ${list.length}`);
  for (const f of list.slice(0, 60)) console.log(fmt(f));
  if (list.length > 60) console.log(`  ... and ${list.length - 60} more`);
  console.log('');
}

const total = Object.values(findings).reduce((n, l) => n + l.length, 0);
console.log(total === 0 ? 'No mechanical problems found.' : `${total} finding(s).`);
