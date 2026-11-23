// A faster drop-in for makefun-site 1.0.0, written from scratch for
// site-generator-speed-01-run-20261122. It returns exactly the output tree
// makefun-site returns for every case, using a different layout throughout:
// a first-character dispatch lexer instead of a regex per line, a single-pass
// inline scanner that copies plain runs in bulk instead of escaping one
// character at a time, a compiled template interpreter that renders into a
// chunk array with one mutable frame per loop instead of a fresh scope object
// per item, memoized slugs, and cards built once per source. No state is kept
// between run() calls: every cache is created inside a single build.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, nothing else. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`, memoized per build in `memo`: NFKD, combining marks
 * dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. Pure-ASCII input skips the
 * normalisation entirely, since it changes nothing there.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  memo.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_TRAILING_WS = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: quoted with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The front matter is
 * walked line by line with indexOf, so the body is one slice, never a
 * split-and-join round trip.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  for (;;) {
    if (pos >= text.length) return { error: 'the front matter is not closed' };
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    if (line === '---') {
      const body = eol === text.length ? '' : text.slice(eol + 1);
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body };
    }
    const c0 = line.charCodeAt(0);
    if (line !== '' && c0 !== 35 && c0 !== 32 && c0 !== 9) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(FM_TRAILING_WS, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    } else if (c0 === 32 || c0 === 9) {
      let allWs = true;
      for (let k = 1; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          allWs = false;
          break;
        }
      }
      if (!allWs) return { error: `line ${lineNo} is not "key: value"` };
    }
    pos = eol + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** A line with spaces and tabs at either end dropped (the line itself back when there is nothing to drop). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether the line range [p, eol) in `src` closes a fence. */
function isFenceCloseRange(src, p, eol) {
  if (src.charCodeAt(p) !== 96 || src.charCodeAt(p + 1) !== 96 || src.charCodeAt(p + 2) !== 96) return false;
  for (let k = p + 3; k < eol; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list line's item text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's number and item text, or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) >= 48 && line.charCodeAt(n) <= 57) n++;
  if (n === 0 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { num: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 2;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k >= line.length) return false;
  return !WS_RE.test(line[k]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src`'s block tokens, in order. Lines are walked with indexOf, never split
 * into an array; a fence body is one slice of the source, and a paragraph or
 * list item is joined once from its lines.
 */
function lex(src) {
  const tokens = [];
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = src.slice(pos, eol);
    const after = eol + 1;
    if (isBlank(line)) {
      pos = after;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      let p = after;
      let closed = false;
      let bodyEnd = n;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        if (isFenceCloseRange(src, p, e2)) {
          bodyEnd = p;
          closed = true;
          pos = e2 + 1;
          break;
        }
        p = e2 + 1;
      }
      if (!closed) {
        let text = src.slice(after, n);
        if (after <= n) text += '\n';
        tokens.push({ type: 'code', lang, text });
        pos = n + 1;
      } else {
        tokens.push({ type: 'code', lang, text: src.slice(after, bodyEnd) });
      }
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      pos = after;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      pos = after;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      let p = pos;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l = src.slice(p, e2);
        if (l.charCodeAt(0) !== 62) break;
        let t = l.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') parts.push(t);
        p = e2 + 1;
      }
      tokens.push({ type: 'blockquote', text: parts.join('\n') });
      pos = p;
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      let p = pos;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l = src.slice(p, e2);
        if (isOrdered) {
          const no = orderedOf(l);
          if (no !== null) {
            items.push([trimLine(no.text)]);
            p = e2 + 1;
            continue;
          }
        } else {
          const nb = bulletOf(l);
          if (nb !== null) {
            items.push([trimLine(nb)]);
            p = e2 + 1;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          p = e2 + 1;
          continue;
        }
        break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? o.num : 1, items: items.map((parts) => parts.join('\n')) });
      pos = p;
      continue;
    }
    const parts = [trimLine(line)];
    let p = after;
    while (p < n) {
      let e2 = src.indexOf('\n', p);
      if (e2 === -1) e2 = n;
      const l = src.slice(p, e2);
      if (endsParagraph(l)) break;
      parts.push(trimLine(l));
      p = e2 + 1;
    }
    tokens.push({ type: 'paragraph', text: parts.join('\n') });
    pos = p;
  }
  return tokens;
}

/** How many backslashes stand immediately before `j` (counted back to `from`). */
function countBackslashes(s, from, j) {
  let n = 0;
  for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
  return n;
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when the run of backslashes
 * before it is odd, which is what a left-to-right scan would find.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (countBackslashes(s, from, j) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (countBackslashes(s, from, j) % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One native scan
 * jumps from one special character to the next, and the plain runs between
 * them are copied whole: no character is ever visited twice, and no escape
 * table is run over plain text.
 */
function inline(s, env) {
  const re = /[\\`*[&<>"']/g;
  let out = '';
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&') {
      out += '&amp;';
      i = j + 1;
    } else if (c === '<') {
      out += '&lt;';
      i = j + 1;
    } else if (c === '>') {
      out += '&gt;';
      i = j + 1;
    } else if (c === '"') {
      out += '&quot;';
      i = j + 1;
    } else if (c === "'") {
      out += '&#39;';
      i = j + 1;
    } else if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        out += escapeHtml(s[j + 1]);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else {
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = q + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    }
    re.lastIndex = i;
  }
  if (i < s.length) out += s.slice(i);
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugMemo) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    if (t.type === 'heading') {
      const id = uniqueSlug(slugify(t.text, slugMemo), ids);
      const html = inline(t.text, env);
      blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
      if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
    } else if (t.type === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
      blocks.push(`<pre><code${cls}>${escapeHtml(t.text)}</code></pre>`);
    } else if (t.type === 'hr') {
      blocks.push('<hr>');
    } else if (t.type === 'blockquote') {
      blocks.push(t.text === '' ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.text, env)}</p>\n</blockquote>`);
    } else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
    } else {
      const html = inline(t.text, env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const LINE_WS_RE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = LINE_WS_RE.test(src.slice(lineStart, open)) && LINE_WS_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * A parsed tree compiled to flat ops, once per template per build:
 * [0, text], [1, path, raw], [2, path, not, thenOps, elseOps|null],
 * [3, name, path, bodyOps], [4, templateName].
 */
function compile(nodes) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text') ops.push([0, n.text]);
    else if (n.kind === 'var') ops.push([1, n.path, false]);
    else if (n.kind === 'raw') ops.push([1, n.path, true]);
    else if (n.kind === 'if') ops.push([2, n.path, n.not, compile(n.then), n.else === null ? null : compile(n.else)]);
    else if (n.kind === 'for') ops.push([3, n.name, n.path, compile(n.body)]);
    else if (n.kind === 'include') ops.push([4, n.name]);
  }
  return ops;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let k = scopes.length - 1; k >= 0; k--) {
    const s = scopes[k];
    if (Object.hasOwn(s, path[0])) {
      let v = s[path[0]];
      for (let j = 1; j < path.length; j++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[j])) return undefined;
        v = v[path[j]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered into `out` (an array of chunks, joined once by the caller).
 * `scopes` is a stack of plain vars objects; a for loop pushes one frame per
 * execution and mutates its element and loop fields per item instead of
 * allocating a fresh scope per item.
 */
function renderOps(ops, scopes, out, ctx, depth) {
  for (const op of ops) {
    const k = op[0];
    if (k === 0) {
      out.push(op[1]);
    } else if (k === 1) {
      const t = textOf(lookup(scopes, op[1]));
      out.push(op[2] ? t : escapeHtml(t));
    } else if (k === 2) {
      const v = truthy(lookup(scopes, op[1]));
      const br = v !== op[2] ? op[3] : op[4];
      if (br !== null) renderOps(br, scopes, out, ctx, depth);
    } else if (k === 3) {
      const xs = lookup(scopes, op[2]);
      if (!Array.isArray(xs)) continue;
      const lp = { index: 0, first: false, last: false, length: xs.length };
      const frame = {};
      frame[op[1]] = null;
      frame.loop = lp;
      scopes.push(frame);
      for (let q = 0; q < xs.length; q++) {
        frame[op[1]] = xs[q];
        frame.loop = lp;
        lp.index = q + 1;
        lp.first = q === 0;
        lp.last = q === xs.length - 1;
        renderOps(op[3], scopes, out, ctx, depth);
      }
      scopes.pop();
    } else {
      const t = ctx.templates.get(op[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderOps(t, scopes, out, ctx, depth + 1);
    }
  }
}

/** `ops` rendered with `vars` as the only scope, to one string. */
function renderTemplate(ops, vars, ctx) {
  const out = [];
  renderOps(ops, [vars], out, ctx, 0);
  return out.join('');
}

// ---------------------------------------------------------------- build

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/**
 * One site's output tree: path -> text. The reference's eight plugins in
 * order, over one build object that is thrown away when run() returns:
 * sources, front matter, permalinks, markdown, collections, tags, layouts,
 * report. Every cache (slug memo, link resolutions) is created here, inside
 * this one build, so one run() can never see another's state.
 */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compile(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugMemo = new Map();
  const sources = [];
  const statics = [];
  const bySource = new Map();
  const broken = new Set();

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const resolveMemo = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') {
          path = null;
        } else {
          const key = `${dir}\n${rel}`;
          path = resolveMemo.get(key);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            resolveMemo.set(key, path);
          }
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugMemo);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it; one card per source, built once and reused by every page that shows it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    return renderTemplate(ops, { site, tags: allTags, recent, ...vars }, ctx);
  };
  for (const s of kept) {
    const page = cards.get(s);
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        ...page,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
