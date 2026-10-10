#!/usr/bin/env node
/**
 * Merge the fork's locale additions into src/lang/locale/{en,zh}.ts.
 *
 * The five batch edits each write a pair of fragment files:
 *
 *   scripts/.i18n/keys-<batch>.en.ts   English entries
 *   scripts/.i18n/keys-<batch>.zh.ts   the matching Chinese entries
 *
 * This script validates them and splices them into a single
 * `// ---- fork additions ----` block just before the closing `};` of each table.
 * Re-running it is idempotent: the existing block is replaced, never duplicated.
 *
 *   node scripts/merge-locale-fragments.mjs           # merge
 *   node scripts/merge-locale-fragments.mjs --check   # validate only
 *
 * Exits non-zero on: a duplicate key across batches, a key that already exists in the
 * upstream table, an en/zh fragment key mismatch, a missing fragment, or an entry whose
 * value is not a plain single-quoted string.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FRAG_DIR = join(HERE, '.i18n');
const EN_PATH = join(ROOT, 'src', 'lang', 'locale', 'en.ts');
const ZH_PATH = join(ROOT, 'src', 'lang', 'locale', 'zh.ts');

const BLOCK_START = '\t// ---- fork additions ----';

/** Parse fragment entries: `\t'key': 'value',` */
function parseFragment(path) {
  const entries = [];
  const text = readFileSync(path, 'utf8');
  const re = /^\t'((?:[^'\\]|\\.)+)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*$/gm;
  let matched = 0;
  for (const m of text.matchAll(re)) {
    entries.push({ key: m[1], value: m[2], raw: m[0] });
    matched++;
  }
  // every non-comment, non-blank line must have parsed
  const offenders = text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() && !line.trim().startsWith('//'))
    .filter(({ line }) => !/^\t'(?:[^'\\]|\\.)+'\s*:\s*'(?:[^'\\]|\\.)*'\s*,\s*$/.test(line));
  if (offenders.length) {
    throw new Error(
      `${basename(path)}: ${offenders.length} line(s) are not a plain single-quoted entry:\n`
      + offenders.map(({ line, n }) => `  ${n}: ${line}`).join('\n'),
    );
  }
  return entries;
}

/** Split an existing locale file into `head` (up to the fork block) and `tail`. */
function splitLocale(path) {
  const text = readFileSync(path, 'utf8');
  const close = text.lastIndexOf('\n};');
  if (close < 0) throw new Error(`${basename(path)}: no closing "};" found`);
  const start = text.indexOf(BLOCK_START);
  const head = (start < 0 ? text.slice(0, close) : text.slice(0, start)).replace(/\n+$/, '');
  return { head, tail: text.slice(close) };
}

function escapeValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * A nested `t()` whose result feeds another `t()` is legitimate — a sentence can
 * interpolate a value that is itself translated — but it is also how a double-substitution
 * bug hides: if the inner translation ever contains a literal `{name}` that the outer
 * template happens to use, the outer pass would substitute it. Flag it for review.
 */
function nestedInterpolations() {
  const hits = [];
  const call = /t\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/gs;
  for (const file of walkSources()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(call)) {
      const inner = [...m[2].matchAll(/t\(\s*'([^']+)'/g)];
      if (inner.length) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({
          where: `${file.replace(/\\/g, '/')}:${line}`,
          outer: m[1],
          inner: inner.map((x) => x[1]),
          params: m[2].replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return hits;
}

function walkSources(dir = join(ROOT, 'src'), out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'lang') continue;
      walkSources(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function formatBlock(entries, comment) {
  const lines = [BLOCK_START, `\t// ${comment}`];
  for (const { key, value } of entries) {
    lines.push(`\t'${key}': '${value}',`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

const batches = existsSync(FRAG_DIR)
  ? readdirSync(FRAG_DIR)
    .filter((f) => /^keys-[A-Z]\.en\.ts$/.test(f))
    .map((f) => f.replace(/^keys-/, '').replace(/\.en\.ts$/, ''))
    .sort()
  : [];

if (batches.length === 0) {
  console.error(`error: no keys-*.en.ts fragments in ${FRAG_DIR}`);
  process.exit(2);
}

const seenKeys = new Map(); // key -> batch
const allEn = [];
const allZh = [];
const problems = [];

/**
 * Keys present in a locale file *outside* the fork block. Re-running the merge must not
 * treat the block it wrote last time as an upstream key.
 */
function upstreamKeys(path) {
  const text = readFileSync(path, 'utf8');
  const cut = text.indexOf(BLOCK_START);
  const body = cut < 0 ? text : text.slice(0, cut);
  return new Set([...body.matchAll(/^\t'([^']+)':/gm)].map((m) => m[1]));
}

const existingEn = upstreamKeys(EN_PATH);
const existingZh = upstreamKeys(ZH_PATH);
if (existingEn.size !== existingZh.size) {
  console.warn(`warning: upstream key counts differ (en ${existingEn.size}, zh ${existingZh.size})`);
}

for (const batch of batches) {
  const enPath = join(FRAG_DIR, `keys-${batch}.en.ts`);
  const zhPath = join(FRAG_DIR, `keys-${batch}.zh.ts`);
  if (!existsSync(zhPath)) {
    problems.push(`batch ${batch}: missing ${basename(zhPath)}`);
    continue;
  }

  let en;
  let zh;
  try {
    en = parseFragment(enPath);
    zh = parseFragment(zhPath);
  } catch (err) {
    problems.push(String(err.message));
    continue;
  }

  const zhByKey = new Map(zh.map((e) => [e.key, e.value]));
  const enKeys = new Set(en.map((e) => e.key));

  for (const { key } of en) {
    if (!zhByKey.has(key)) problems.push(`batch ${batch}: ${key} — English present, Chinese missing`);
  }
  for (const { key } of zh) {
    if (!enKeys.has(key)) problems.push(`batch ${batch}: ${key} — Chinese present, English missing`);
  }

  for (const { key, value } of en) {
    if (existingEn.has(key)) problems.push(`batch ${batch}: ${key} already exists in en.ts`);
    if (seenKeys.has(key)) problems.push(`batch ${batch}: ${key} already defined by batch ${seenKeys.get(batch)}`);
    seenKeys.set(key, batch);
    allEn.push({ key, value });
    allZh.push({ key, value: zhByKey.get(key) ?? '' });
  }

  console.log(`batch ${batch}: ${en.length} keys`);
}

if (problems.length) {
  console.error('\nvalidation failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

allEn.sort((a, b) => a.key.localeCompare(b.key));
allZh.sort((a, b) => a.key.localeCompare(b.key));

// Chinese side: drop empty values defensively
const emptyZh = allZh.filter((e) => !e.value.trim());
if (emptyZh.length) {
  console.error('empty Chinese values:');
  for (const e of emptyZh) console.error(`  - ${e.key}`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log(`\nOK: ${allEn.length} keys across ${batches.length} batches`);
  process.exit(0);
}

const enParts = splitLocale(EN_PATH);
const zhParts = splitLocale(ZH_PATH);

writeFileSync(
  EN_PATH,
  `${enParts.head}\n\n${formatBlock(allEn, 'English (fork additions: strings upstream PR #588 missed).')}\n${enParts.tail}`,
  'utf8',
);
writeFileSync(
  ZH_PATH,
  `${zhParts.head}\n\n${formatBlock(allZh, '简体中文(fork additions)。')}\n${zhParts.tail}`,
  'utf8',
);

console.log(`\nwrote ${allEn.length} keys into en.ts and zh.ts`);

const nested = nestedInterpolations();
if (nested.length) {
  // The real hazard is a double substitution: the outer pass rewrites `{name}` in the
  // value the inner pass returned. That can only happen if an inner value itself contains
  // a brace placeholder, so test for exactly that instead of asking for a human look.
  const dangerous = [];
  for (const n of nested) {
    for (const key of n.inner) {
      const value = allZh.find((e) => e.key === key)?.value ?? allEn.find((e) => e.key === key)?.value ?? '';
      if (/\{[A-Za-z_$][\w$]*\}/.test(value)) dangerous.push({ ...n, key, value });
    }
  }
  if (dangerous.length) {
    console.error(`\n${dangerous.length} nested t() call(s) would double-substitute:`);
    for (const d of dangerous) {
      console.error(`  ${d.where}  ${d.key} = ${JSON.stringify(d.value)}`);
    }
    process.exit(1);
  }
  console.log(`\n${nested.length} nested t() call(s): no inner value contains a brace placeholder,`);
  console.log('so the outer substitution pass cannot rewrite it. Safe.');
}
