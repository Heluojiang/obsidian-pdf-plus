#!/usr/bin/env node
/**
 * Find user-facing strings that are still hard-coded in src/.
 *
 * `t()` exists so that no user-facing string sits inline any more, and
 * src/lang/locale/en.ts is meant to be the single source of truth. Upstream PR #587
 * describes its table as holding "every hard-coded, user-facing string"; measured
 * against this code base it does not, so this script is the guard rail.
 *
 * Run it after every upstream merge: new UI strings arrive as hard-coded English, the
 * merge will not route them through t(), and this script is what finds them.
 *
 *   node scripts/scan-ui-strings.mjs          # human-readable report
 *   node scripts/scan-ui-strings.mjs --json   # machine-readable report
 *
 * Exit code 0 when nothing user-visible is un-translated, 1 otherwise.
 *
 * How it works
 * ------------
 * A small lexer walks each file once and records every string literal — both
 * single-quoted strings and whole template literals — together with a map of which
 * characters are code, so comments do not produce false hits.
 *
 * A template literal is recorded as ONE candidate, with every `${...}` rewritten to
 * `{*}`. That is the unit a locale key would cover, and it lines up with the table,
 * whose values use `{name}` placeholders; matching normalises both sides the same way.
 *
 * A candidate is reported when it is not a value in en.ts AND it is reached by one of:
 *   - a UI setter  (.setName, .setTitle, .setButtonText, new Notice, ...)
 *   - a dropdown   (an argument to addDropdownSetting / addOption / addOptions)
 *   - an element text property (`text:`, `.textContent =`, `.appendText(`)
 *   - any prose-looking string anywhere else
 *
 * Excluded as never-user-visible: strings inside `console.*` and `throw new Error(..)`,
 * PDF-spec constants (annotation subtypes, dictionary keys), CSS, icon ids, css
 * classes, URLs, command ids. Anything else that must stay English goes in
 * scripts/ui-string-whitelist.json, with a reason.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const EN_PATH = join(SRC, 'lang', 'locale', 'en.ts');
const ZH_PATH = join(SRC, 'lang', 'locale', 'zh.ts');
const WHITELIST_PATH = join(HERE, 'ui-string-whitelist.json');

/** Directories under src/ that hold no UI copy. */
const SKIP_DIRS = new Set(['lang']);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Unescape a single-quoted TS string body. */
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

/**
 * Normalise interpolated placeholders so that a candidate and a locale value can be
 * compared: `${x}` (already rewritten to `{*}` by the lexer) and `{name}` both
 * become `{*}`.
 */
function normalizePlaceholders(value) {
  return value.replace(/\{[A-Za-z0-9_]*\}/g, '{*}');
}

/**
 * Find the index just past a `${` substitution's closing brace.
 * Tracks brace nesting and skips over nested strings, templates and comments, so a
 * `'…'` or `"…"` inside the substitution does not end it early.
 */
function findSubstitutionEnd(text, start) {
  const n = text.length;
  let i = start;
  let depth = 1;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        if (text[i] === '\n' && quote === "'") break;
        i++;
      }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '`') { i++; break; }
        if (text[i] === '$' && text[i + 1] === '{') {
          i = findSubstitutionEnd(text, i + 2);
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; if (depth === 0) break; continue; }
    i++;
  }
  return i;
}

/**
 * Walk `text` and collect string literals plus a code/not-code map.
 * Comments and double-quoted strings are skipped. Each template literal becomes one
 * token whose value has every `${...}` rewritten to `{*}`; the substitution bodies are
 * lexed separately as code so that `t('a')` nested inside a template is still seen.
 */
function lex(text) {
  const n = text.length;
  const isCode = new Uint8Array(n);
  const tokens = [];
  let i = 0;

  while (i < n) {
    const ch = text[i];

    // line comment
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    // block comment
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      const start = i;
      i++;
      let raw = '';
      while (i < n) {
        const c = text[i];
        if (c === '\\') { raw += c + (text[i + 1] ?? ''); i += 2; continue; }
        if (c === "'") { i++; break; }
        if (c === '\n') break;
        raw += c;
        i++;
      }
      tokens.push({ kind: 'string', raw, value: unescapeTs(raw), start, end: i });
      continue;
    }
    // double-quoted string: never UI copy in this code base
    if (ch === '"') {
      i++;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '"') { i++; break; }
        if (c === '\n') break;
        i++;
      }
      continue;
    }
    // template literal: one token for the whole thing
    if (ch === '`') {
      const start = i;
      i++;
      let value = '';
      let raw = '';
      let chunkStart = i;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
          raw += text.slice(chunkStart, i);
          value += unescapeTs(text.slice(chunkStart, i));
          i++;
          break;
        }
        if (c === '$' && text[i + 1] === '{') {
          raw += text.slice(chunkStart, i) + '${}';
          value += unescapeTs(text.slice(chunkStart, i)) + '{*}';
          const innerStart = i + 2;
          i = findSubstitutionEnd(text, innerStart);
          const inner = lex(text.slice(innerStart, i));
          for (const tk of inner.tokens) {
            tokens.push({ ...tk, start: tk.start + innerStart, end: tk.end + innerStart });
          }
          for (let k = 0; k < inner.isCode.length; k++) {
            if (inner.isCode[k]) isCode[innerStart + k] = 1;
          }
          chunkStart = i;
          continue;
        }
        i++;
      }
      tokens.push({ kind: 'template', raw, value, start, end: i });
      continue;
    }
    isCode[i] = 1;
    i++;
  }

  return { isCode, tokens };
}

// ---------------------------------------------------------------------------
// Code regions: argument lists of calls that are not user-visible
// ---------------------------------------------------------------------------

const DROPDOWN_CALLS = [
  'addDropdownSetting',
  'addEnumDropdownSetting',
  'addIndexDropdownSetting',
  'addOptions',
  'addOption',
];

const SILENT_CALLS = [
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug',
  'console.trace', 'console.assert',
];

/**
 * Objects whose string values are persisted user data rather than UI copy.
 * `DEFAULT_SETTINGS` holds template/color *names* and template *bodies*: users can
 * rename them in the settings tab, the values are written to data.json, and there is no
 * way to tell an untouched default from a name the user chose. Translating them would
 * silently rewrite existing user settings, so they stay English.
 */
const DATA_OBJECTS = ['DEFAULT_SETTINGS'];

/** Character ranges covering the object literal assigned to one of `names`. */
function objectRegions(text, isCode, names) {
  const regions = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*(?::[^=]*)?=\\s*\\{`, 'g');
    for (const m of text.matchAll(re)) {
      const open = text.lastIndexOf('{', m.index + m[0].length);
      if (open < 0 || !isCode[open]) continue;
      regions.push(spanBraces(text, isCode, open));
    }
  }
  return regions;
}

function spanBraces(text, isCode, open) {
  let depth = 0;
  let j = open;
  for (; j < text.length; j++) {
    if (!isCode[j]) continue;
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return [open, j];
}

/** Character ranges covering the argument list of every call to one of `names`. */
function callRegions(text, isCode, names) {
  const regions = [];
  for (const name of names) {
    const escaped = name.replace(/\./g, '\\.');
    const re = new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, 'g');
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      if (!isCode[open]) continue;
      regions.push(spanParentheses(text, isCode, open));
    }
  }
  for (const m of text.matchAll(/(?:new\s+|throw\s+new\s+)Error\s*\(/g)) {
    const open = text.indexOf('(', m.index);
    if (open < 0 || !isCode[open]) continue;
    regions.push(spanParentheses(text, isCode, open));
  }
  return regions;
}

function spanParentheses(text, isCode, open) {
  let depth = 0;
  let j = open;
  for (; j < text.length; j++) {
    if (!isCode[j]) continue;
    const c = text[j];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  return [open, j];
}

function inAnyRegion(regions, index) {
  for (const [a, b] of regions) if (index > a && index < b) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Sink detection
// ---------------------------------------------------------------------------

const LOOKBEHIND = 120;

const SINK_PATTERNS = [
  [/setName\(\s*$/, 'setName'],
  [/\.setDesc\(\s*$/, 'setDesc'],
  [/\.setTitle\(\s*$/, 'setTitle'],
  [/\.setTooltip\(\s*$/, 'setTooltip'],
  [/\.setButtonText\(\s*$/, 'setButtonText'],
  [/\.setPlaceholder\(\s*$/, 'setPlaceholder'],
  [/\.appendText\(\s*$/, 'appendText'],
  [/addHeading\(\s*$/, 'addHeading'],
  [/new\s+Notice\(\s*$/, 'Notice'],
  [/\.setText\(\s*$/, 'setText'],
  [/\.textContent\s*=\s*$/, 'textContent'],
  [/text:\s*$/, 'createEl.text'],
  [/\.setMessage\(\s*$/, 'setMessage'],
];

function sinkOf(text, token) {
  const before = text.slice(Math.max(0, token.start - LOOKBEHIND), token.start);
  for (const [re, name] of SINK_PATTERNS) if (re.test(before)) return name;
  return null;
}

// ---------------------------------------------------------------------------
// "Is this UI copy?" heuristics
// ---------------------------------------------------------------------------

const MACHINEY = [
  /^[a-z0-9-]+$/, // slug / css class / icon id / enum value
  /^[a-z][A-Za-z0-9]*$/, // camelCase identifier
  /^https?:\/\//i,
  /^(?:obsidian|file|data|mailto|app):/i,
  /^lucide-/,
  /^[./\\]/,
  /^var\(/,
  /^\s*--/,
  /^#[0-9a-f]{3,8}$/i,
  /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)+$/, // dotted identifier / command id
  /^\d+(?:\.\d+)?(?:px|em|rem|%)?$/,
  /^\s*[<>{}[\](),;:=+\-*/|&!?]+\s*$/, // punctuation-only
  /^\s*[a-z-]+:\s*$/, // bare css property
  /^\d+(?:\.\d+)?[a-z]{0,3}(?:\s+\d+(?:\.\d+)?[a-z]{0,3})+$/, // length list: "1rem 0"
  /<\w+[\s/>]/, // HTML/JSX fragment
  /\\[dDsSwWbB]/, // regex source
  /^(?:const|let|var|function|class|async|await|return|import|export)\b/, // code snippet
  /=>|;\s*$|\{\s*$/,
];

/** PDF-spec constants: they read as English but are protocol values. */
const PDF_SPEC = new Set([
  'Dests', 'Names', 'Nums', 'Kids', 'Limits', 'First', 'Last', 'Next', 'Prev', 'Parent',
  'Count', 'Dest', 'Outlines', 'Annot', 'Annots', 'Contents', 'Border', 'Link', 'Stamp',
  'Square', 'Squiggly', 'Highlight', 'Underline', 'Text', 'Popup', 'Widget',
  'Rect', 'QuadPoints', 'Vertices', 'InkList',
  'Type', 'Page', 'Pages', 'Catalog', 'Info', 'Root', 'MediaBox', 'CropBox', 'Rotate',
  'Title', 'Author', 'Subject', 'Keywords', 'Producer', 'Creator', 'ModDate', 'CreationDate',
]);

/** Keyboard/modifier key names, provided by Obsidian or the OS. */
const KEY_NAMES = new Set([
  'Mod', 'Ctrl', 'Control', 'Alt', 'Shift', 'Meta', 'Cmd', 'Command', 'Option', 'Win', 'Super',
  'Enter', 'Return', 'Escape', 'Esc', 'Tab', 'Backspace', 'Space', 'Delete', 'Insert', 'Home',
  'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Bslash', 'Bar',
]);

/**
 * DOM node type names, passed to `instanceofInWindow('Node', ...)`.
 * These are class names, not UI copy, and the sink heuristic would otherwise
 * promote them because they sit in an argument list.
 */
const DOM_TYPES = new Set(['Node', 'Element', 'HTMLElement', 'Document', 'Window']);

/**
 * Look like a CSS selector rather than prose? A predicate, not a regex, on purpose:
 * a broad "contains a colon" rule would swallow every vim help string such as
 * ":0 - Go to the first page".
 */
function looksLikeCssSelector(value) {
  const s = value.trim();
  if (!s || s.includes('\n')) return false;
  if (s.startsWith('.')) return true;
  // `#id` is a selector; `#### Heading` is Markdown and must not be swallowed.
  if (/^#[\w-]+(?:[\s>+~.,:[\]]|$)/.test(s) && !/^#+\s/.test(s)) return true;
  if (s.startsWith('[')) return true;
  if (/^:(?:scope|not|nth-|hover|last-|first-|is|where)\b/.test(s)) return true;
  if (/\[(?:data-|class|href|style|aria-)/.test(s)) return true;
  if (/var\(--/.test(s)) return true;
  if (/\s[>+~]\s/.test(s)) return true;
  if (/^[\w-]+\.[\w-]/.test(s)) return true; // element.class chain
  return false;
}

/**
 * Does this look like English prose a human reads on screen?
 * A multi-line string is treated as a Markdown help block and always counts; a
 * single-line string needs a space, or a capitalised bare word such as "Cancel".
 */
function looksLikeProse(value) {
  if (value.length < 3 || value.length > 4000) return false;
  if (KEY_NAMES.has(value) || PDF_SPEC.has(value) || DOM_TYPES.has(value)) return false;
  if (value.includes('\n')) return /[A-Za-z]{3}/.test(value);
  if (MACHINEY.some((re) => re.test(value))) return false;
  if (!/[A-Za-z]{2}/.test(value)) return false;
  if (looksLikeCssSelector(value)) return false;
  if (/\s/.test(value)) return true;
  return /^[A-Z][a-z]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Locale table
// ---------------------------------------------------------------------------

function readLocale(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const keys = [];
  const values = new Set();
  const re = /^\t'([^']+)':\s*'((?:[^'\\\n]|\\.)*)',?\s*$/gm;
  for (const m of text.matchAll(re)) {
    keys.push(m[1]);
    values.add(normalizePlaceholders(unescapeTs(m[2])));
  }
  return { keys, values };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function scanFile(file, en) {
  const text = readFileSync(file, 'utf8');
  const { isCode, tokens } = lex(text);
  const dropdowns = callRegions(text, isCode, DROPDOWN_CALLS);
  const silent = callRegions(text, isCode, SILENT_CALLS);
  const dataObjects = objectRegions(text, isCode, DATA_OBJECTS);

  const findings = [];
  const seen = new Set();

  for (const token of tokens) {
    if (!token.value || token.value.length < 2) continue;
    if (inAnyRegion(silent, token.start)) continue;
    // Persisted user data, not UI copy.
    if (inAnyRegion(dataObjects, token.start)) continue;

    let sink = sinkOf(text, token);
    if (!sink && inAnyRegion(dropdowns, token.start)) sink = 'dropdown';

    if (!sink && !looksLikeProse(token.value)) continue;
    if (sink && !looksLikeProse(token.value) && token.kind === 'string') {
      // a sink can only receive UI copy; keep short labels like "None" that the
      // prose heuristic rejects
      if (MACHINEY.some((re) => re.test(token.value))) continue;
      if (KEY_NAMES.has(token.value) || PDF_SPEC.has(token.value) || DOM_TYPES.has(token.value)) continue;
      if (looksLikeCssSelector(token.value)) continue;
    }
    if (PDF_SPEC.has(token.value)) continue;

    if (en.values.has(normalizePlaceholders(token.value))) continue;

    if (seen.has(token.value)) continue;
    seen.add(token.value);

    findings.push({
      line: lineOf(text, token.start),
      sink,
      kind: token.kind,
      value: token.value,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const en = readLocale(EN_PATH);
if (!en) {
  console.error(`error: cannot read ${relative(ROOT, EN_PATH)}`);
  process.exit(2);
}
const zh = readLocale(ZH_PATH);

const whitelist = existsSync(WHITELIST_PATH)
  ? JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'))
  : {};
const reasons = new Map();
for (const [bucket, list] of Object.entries(whitelist)) {
  if (bucket.startsWith('$')) continue;
  for (const entry of list ?? []) {
    const value = typeof entry === 'string' ? entry : entry.value;
    reasons.set(value, typeof entry === 'string' ? bucket : entry.reason ?? bucket);
  }
}

const gaps = [];
const exempted = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  for (const f of scanFile(file, en)) {
    const record = { file: rel, ...f };
    const reason = reasons.get(f.value);
    if (reason) exempted.push({ ...record, reason });
    else gaps.push(record);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    enKeys: en.keys.length,
    zhKeys: zh ? zh.keys.length : null,
    gaps,
    exempted,
  }, null, 2));
} else {
  console.log('PDF++ UI string scan');
  console.log('====================');
  console.log(`en.ts keys: ${en.keys.length}` + (zh ? `   zh.ts keys: ${zh.keys.length}` : ''));
  if (zh && zh.keys.length !== en.keys.length) {
    console.log(`WARNING: en/zh key counts differ (${en.keys.length} vs ${zh.keys.length})`);
  }
  console.log(`distinct locale values: ${en.values.size}`);
  console.log('');

  if (gaps.length === 0) {
    console.log('No un-translated user-visible strings found.');
  } else {
    const byFile = new Map();
    for (const g of gaps) {
      if (!byFile.has(g.file)) byFile.set(g.file, []);
      byFile.get(g.file).push(g);
    }
    console.log(`${gaps.length} string(s) not in the locale table:`);
    console.log('');
    for (const [file, list] of [...byFile].sort()) {
      console.log(`  ${file}`);
      for (const g of list.sort((a, b) => a.line - b.line)) {
        const flat = g.value.replace(/\n/g, '\\n');
        const shown = flat.length > 84 ? flat.slice(0, 81) + '...' : flat;
        const tag = g.sink ?? (g.kind === 'template' ? 'template' : 'prose');
        console.log(`    ${String(g.line).padStart(5)}  [${tag}] ${JSON.stringify(shown)}`);
      }
    }
  }

  if (exempted.length > 0) {
    console.log('');
    console.log(`${exempted.length} string(s) exempted by scripts/ui-string-whitelist.json.`);
  }
}

process.exit(gaps.length === 0 ? 0 : 1);
