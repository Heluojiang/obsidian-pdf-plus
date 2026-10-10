#!/usr/bin/env node
/**
 * English-fidelity check for the fork's locale additions.
 *
 * The rule from scripts/I18N.md: adding a key must NOT change what English users see.
 * The English value has to be byte-identical to the literal it replaced (up to
 * `{placeholder}` naming and the collapse of a concatenated sentence into one string).
 *
 * This compares each English fragment value against every string literal in the
 * pre-i18n source, which is `HEAD` for whichever commit the fragments were written
 * against. Pass a git rev to compare against something else:
 *
 *   node scripts/check-en-fidelity.mjs              # against HEAD
 *   node scripts/check-en-fidelity.mjs 6a3218b      # against upstream main
 *
 * For each fragment value it reports either a match or a miss. A miss is not
 * automatically wrong — a sentence genuinely assembled from several literals that the
 * fragment re-joined will not be found verbatim — but every miss deserves a look,
 * because the usual cause is a typo in the English value.
 *
 * Exit code 1 when any value is unmatched.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FRAG_DIR = join(HERE, '.i18n');
const REV = process.argv[2] ?? 'HEAD';

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Literals in the pre-i18n source
// ---------------------------------------------------------------------------

/** `${...}` and `{name}` both become `{*}`; whitespace runs collapse to one space. */
function normalize(value) {
  return value
    .replace(/\$\{[^}]*\}/g, '{*}')
    .replace(/\{[A-Za-z_$][\w$]*\}/g, '{*}')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect single-quoted and template literals, skipping comments.
 * Rough on purpose: a false extra literal only creates a false match, and the check
 * that matters is whether the fragment value is found at all.
 */
function literals(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"') { i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; continue; }
    if (c === "'") {
      let s = '';
      i++;
      while (i < n && text[i] !== "'") {
        if (text[i] === '\\') { s += text[i + 1] === 'n' ? '\n' : text[i + 1] === 't' ? '\t' : text[i + 1]; i += 2; continue; }
        s += text[i++];
      }
      i++;
      out.push(s);
      continue;
    }
    if (c === '`') {
      let s = '';
      i++;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') { s += text[i + 1] === 'n' ? '\n' : text[i + 1] === 't' ? '\t' : text[i + 1]; i += 2; continue; }
        s += text[i++];
      }
      i++;
      out.push(s);
      continue;
    }
    i++;
  }
  return out;
}

const files = git(['ls-tree', '-r', '--name-only', REV, '--', 'src'])
  .split('\n')
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('src/lang/'));

const corpus = new Map(); // normalized literal -> { file, raw }
const haystacks = []; // per-file concatenation, for re-joined multi-literal sentences
for (const file of files) {
  let text;
  try {
    text = git(['show', `${REV}:${file}`]);
  } catch {
    continue;
  }
  const lits = literals(text);
  for (const lit of lits) {
    if (!lit.trim()) continue;
    const key = normalize(lit);
    if (!corpus.has(key)) corpus.set(key, { file: basename(file), raw: lit });
  }
  // A sentence assembled from several literals around real DOM nodes gets re-joined into
  // one key, so the value is no longer a literal anywhere. Index the literals as a
  // concatenated stream too — both with and without a separating space, because
  // `[a, b].join(' ')` and `a + b` are both used in the original.
  haystacks.push({ file: basename(file), hay: normalize(lits.join('')) });
  haystacks.push({ file: basename(file), hay: normalize(lits.join(' ')) });
}

/**
 * Deliberate re-joins the substring test cannot confirm, each reviewed by hand.
 *
 * The vim `:map` help is one template literal in the original:
 *
 *   `:${signature} <from> <to> - Map <from> to <to> ${noremap ? 'non-recusively ' : ''}in
 *    ${modes.length > 1 ? … + ' modes' : modes[0] + ' mode'}. If <to> is an ex-command…`
 *
 * Splitting it turns the interpolations into `{v0}`/`{v1}` and hoists the literal
 * `'non-recusively '` out, so neither half survives as a contiguous literal. English
 * output is unchanged; the English value keeps the upstream typo on purpose.
 */
const REVIEWED = new Set([
  'vimExCommands.map-command.multiple-modes.help',
  'vimExCommands.map-command.single-mode.help',
  'vimExCommands.map-command.non-recursively',
]);

// ---------------------------------------------------------------------------
// Fragment values
// ---------------------------------------------------------------------------

const fragments = existsSync(FRAG_DIR)
  ? readdirSync(FRAG_DIR).filter((f) => /^keys-[A-Z]\.en\.ts$/.test(f)).sort()
  : [];

if (!fragments.length) {
  console.error(`error: no keys-*.en.ts fragments in ${FRAG_DIR}`);
  process.exit(2);
}

const ENTRY = /^\t'((?:[^'\\]|\\.)+)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*$/;

let checked = 0;
const misses = [];

/**
 * A literal that was only sentence-final punctuation gets folded into the key so the
 * sentence lives entirely in the table (English '.' would stay an ASCII period in the
 * middle of a Chinese sentence). Accept a value that matches a literal once a trailing
 * sentence-final period is set aside.
 */
function matches(norm) {
  if (corpus.has(norm)) return true;
  const bare = norm.replace(/[.。]$/, '');
  if (bare !== norm && corpus.has(bare)) return true;
  if (haystacks.some((h) => h.hay.includes(norm))) return true;
  if (bare !== norm && haystacks.some((h) => h.hay.includes(bare))) return true;
  return false;
}

for (const fragment of fragments) {
  const text = readFileSync(join(FRAG_DIR, fragment), 'utf8');
  for (const line of text.split('\n')) {
    const m = ENTRY.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    checked++;
    if (REVIEWED.has(key)) continue;
    if (!matches(normalize(value))) misses.push({ fragment, key, value });
  }
}

console.log(`comparing ${checked} English value(s) against ${REV} (${corpus.size} distinct literals)`);
if (!misses.length) {
  console.log(`\nOK: every English value matches a literal in ${REV}.`);
  process.exit(0);
}

console.log(`\n${misses.length} value(s) not found verbatim in ${REV}:\n`);
for (const { fragment, key, value } of misses) {
  console.log(`  [${fragment}] ${key}`);
  console.log(`      ${JSON.stringify(value.length > 160 ? value.slice(0, 157) + '...' : value)}`);
}
console.log('\nEach of these is either a re-joined multi-literal sentence (fine) or a typo (fix it).');
process.exit(1);
