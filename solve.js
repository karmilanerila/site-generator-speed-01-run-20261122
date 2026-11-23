// solve.js — site-generator-speed-01 round 5: radical rewrite, written fresh in this session.
// run(input) returns exactly makefun-site 1.0.0's answer for the input, faster.
// Architecture: allocation-cutting throughout — range-based inline rendering, char-dispatch
// block lexer, codegen'd templates (compiled once per template source, cached), link cache,
// slug cache, mutable loop frames. No regex on hot paths except C-level scans.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*[]/g;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML-escape: fast path returns the string untouched when it holds no escapable char. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whether char code c is JS whitespace (\s), exactly. */
function isWSCode(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 11 || c === 12 || c === 160 || c === 1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

/** The words of a body: runs of non-whitespace, counted without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Slug of text (NFKD, marks dropped, A-Z lowered, runs of other chars one '-', cut to 64, 'untitled' when empty). */
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const v = slugifySlow(text);
  if (slugCache.size < 16384) slugCache.set(text, v);
  return v;
}
function slugifySlow(text) {
  // Pure ASCII: NFKD is the identity and there are no combining marks, so skip both.
  if (/^[\x00-\x7F]*$/.test(text)) return slugFromChars(text, false);
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  return slugFromChars(plain, true);
}
function slugFromChars(s, codePoints) {
  let out = '';
  let gap = false;
  const push = (keep) => {
    if (keep === null) { gap = out.length > 0; return; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  };
  if (codePoints) {
    for (const ch of s) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      push(keep);
    }
  } else {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      push(keep);
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Slug made unique against taken (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_OK = /^[^"[\]]+$/;
const NAME_OK = /^[a-z0-9-]+$/;
const SLUG_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_OK.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_OK.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_OK.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether s is blank (spaces and tabs only, or empty). */
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. Scans lines without splitting the body. */
function parseFM(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = nl === -1 ? text.length : nl + 1;
  let close = -1;
  let closeEnd = -1;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') { close = pos; closeEnd = e === -1 ? text.length : e + 1; break; }
    if (e === -1) break;
    pos = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl === -1 ? text.length : nl + 1;
  let lineno = 2;
  while (p < close) {
    const e = text.indexOf('\n', p);
    const line = e === -1 || e > close ? text.slice(p, close) : text.slice(p, e);
    if (!isBlankStr(line) && line[0] !== '#') {
      let k = 0;
      while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
      if (k === 0 || line[k] !== ':') return { error: `line ${lineno} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
      else return { error: `line ${lineno} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1 || e >= close) break;
    p = e + 1;
    lineno++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** Trim spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** Fence-open language, or null when the line is not a fence open. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') { lang += c; i++; }
    else break;
  }
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

/** Whether the line closes a fence. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let s = n;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  const text = line.slice(s).replace(/[ \t]+$/, '');
  if (text === '') return null;
  return { depth: n, text };
}

/** Whether the line is a heading (boolean-only, no allocation). */
function isHeading(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6 || n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return false;
  let s = n;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  for (let i = s; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return true;
  return false;
}

/** Whether the line is a thematic break. */
function isHr(line) {
  if (line !== '---' && line !== '***' && !line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** Whether the line ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line.length === 0 || isBlankStr(line)) return true;
  if (line[0] === '`' && fenceLang(line) !== null) return true;
  if (line[0] === '#' && isHeading(line)) return true;
  if ((line[0] === '-' || line[0] === '*') && isHr(line)) return true;
  return false;
}

/** Whether the line continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** Ordered-list marker: { num, rest } or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

/** Backslashes immediately before j, counted back to `from` (the scan start). */
function backslashRun(s, from, j) {
  let b = 0;
  for (let k = j - 1; k >= from && s[k] === '\\'; k--) b++;
  return b;
}

/** First index >= from and < hi holding `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j < hi) {
    if (backslashRun(s, from, j) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** First single * >= from and < hi (one not beside another *), outside an escape, or -1. */
function findEm(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    // An escaped * is never a candidate (the reference skips the \X pair first).
    if (backslashRun(s, from, j) % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (j + 1 < hi && s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** s[lo..hi) rendered inline into out[]. `link` resolves a link target to its href. */
function inlineRange(s, lo, hi, link, out) {
  let i = lo;
  INLINE_RE.lastIndex = lo;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null && m.index < hi) {
    const j = m.index;
    if (j > i) out.push(esc(s.slice(i, j)));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) { out.push(esc(s[j + 1])); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        out.push('<code>'); out.push(esc(s.slice(j + 1, k))); out.push('</code>');
        i = k + 1;
      } else { out.push('`'); i = j + 1; }
    } else if (c === '*') {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnesc(s, '**', j + 2, hi);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>'); inlineRange(s, j + 2, k, link, out); out.push('</strong>');
          i = k + 2;
        } else { out.push('**'); i = j + 2; }
      } else {
        const k = findEm(s, j + 1, hi);
        if (k !== -1 && k > j + 1) {
          out.push('<em>'); inlineRange(s, j + 1, k, link, out); out.push('</em>');
          i = k + 1;
        } else { out.push('*'); i = j + 1; }
      }
    } else { // '['
      const k = findUnesc(s, ']', j + 1, hi);
      let done = false;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        const m2 = s.indexOf(')', k + 2);
        if (m2 !== -1 && m2 < hi) {
          const target = s.slice(k + 2, m2);
          if (target !== '' && !/\s/.test(target)) {
            out.push('<a href="'); out.push(esc(link(target))); out.push('">');
            inlineRange(s, j + 1, k, link, out);
            out.push('</a>');
            i = m2 + 1;
            done = true;
          }
        }
      }
      if (!done) { out.push('['); i = j + 1; }
    }
    INLINE_RE.lastIndex = i;
  }
  if (i < hi) out.push(esc(s.slice(i, hi)));
}

/** src rendered: pushes HTML parts into out, returns { toc, excerpt }. */
function renderMd(src, link, out) {
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let pos = 0;
  const N = src.length;
  while (pos < N) {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = N;
    const line = src.slice(pos, e);
    let np = e === N ? N + 1 : e + 1;
    if (isBlankStr(line)) { pos = np; continue; }
    const c0 = line[0];
    // Fence.
    if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        pos = np;
        let closed = false;
        while (pos < N) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = N;
          const l2 = src.slice(pos, e2);
          const nx = e2 === N ? N + 1 : e2 + 1;
          if (isFenceClose(l2)) { pos = nx; closed = true; break; }
          body.push(l2);
          pos = nx;
        }
        // The reference splits on '\n', so an unclosed fence at the end of a
        // '\n'-terminated source takes the trailing empty string as a code line.
        if (!closed && N > 0 && src[N - 1] === '\n') body.push('');
        out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
        for (let q = 0; q < body.length; q++) { out.push(esc(body[q])); out.push('\n'); }
        out.push('</code></pre>\n');
        continue;
      }
    }
    // Heading.
    if (c0 === '#') {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const tmp = [];
        inlineRange(hd.text, 0, hd.text.length, link, tmp);
        const html = tmp.join('');
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        pos = np;
        continue;
      }
    }
    // Thematic break.
    if ((c0 === '-' || c0 === '*') && isHr(line)) {
      out.push('<hr>\n');
      pos = np;
      continue;
    }
    // Blockquote.
    if (c0 === '>') {
      const qlines = [];
      while (pos < N) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = N;
        const l2 = src.slice(pos, e2);
        if (l2[0] !== '>') break;
        const nx = e2 === N ? N + 1 : e2 + 1;
        qlines.push(trimLine(l2[1] === ' ' ? l2.slice(2) : l2.slice(1)));
        pos = nx;
      }
      const kept = qlines.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const qtext = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(qtext, 0, qtext.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List.
    if ((c0 === '-' || c0 === '*') && line[1] === ' ') {
      const items = [];
      let cur = null;
      while (pos < N) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = N;
        const l2 = src.slice(pos, e2);
        const nx = e2 === N ? N + 1 : e2 + 1;
        if ((l2[0] === '-' || l2[0] === '*') && l2[1] === ' ') {
          cur = [trimLine(l2.slice(2))];
          items.push(cur);
          pos = nx;
        } else if (isContinued(l2)) {
          cur.push(trimLine(l2));
          pos = nx;
        } else break;
      }
      out.push('<ul>\n');
      for (const parts of items) {
        const text = parts.join('\n');
        out.push('<li>');
        inlineRange(text, 0, text.length, link, out);
        out.push('</li>\n');
      }
      out.push('</ul>\n');
      continue;
    }
    if (c0 >= '0' && c0 <= '9') {
      const ord = orderedOf(line);
      if (ord !== null) {
        const items = [];
        let cur = null;
        let start = Number(ord.num);
        while (pos < N) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = N;
          const l2 = src.slice(pos, e2);
          const nx = e2 === N ? N + 1 : e2 + 1;
          const o2 = orderedOf(l2);
          if (o2 !== null) {
            cur = [trimLine(o2.rest)];
            items.push(cur);
            pos = nx;
          } else if (isContinued(l2)) {
            cur.push(trimLine(l2));
            pos = nx;
          } else break;
        }
        out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        for (const parts of items) {
          const text = parts.join('\n');
          out.push('<li>');
          inlineRange(text, 0, text.length, link, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // Paragraph.
    {
      const body = [trimLine(line)];
      pos = np;
      while (pos < N) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = N;
        const l2 = src.slice(pos, e2);
        if (endsParagraph(l2)) break;
        body.push(trimLine(l2));
        pos = e2 === N ? N + 1 : e2 + 1;
      }
      const text = body.join('\n');
      const tmp = [];
      inlineRange(text, 0, text.length, link, tmp);
      const html = tmp.join('');
      if (excerpt === null) excerpt = html;
      out.push('<p>', html, '</p>\n');
    }
  }
  return { toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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
    const standalone = isBlankStr(src.slice(lineStart, open)) && isBlankStr(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

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

/** The value at path in the scope chain (prototype chain of frames; root frame has a null prototype). */
function lookup(S, path) {
  let s = S;
  while (s !== null && !Object.hasOwn(s, path[0])) s = Object.getPrototypeOf(s);
  if (s === null) return undefined;
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, number in JS digits, true/false, array items joined by ', ', else ''. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELPERS = { lookup, textOf, truthy, esc };

/** Compiled template functions, cached by template source (a function depends only on its source). */
const fnCache = new Map();

function getCompiled(name, src) {
  let fn = fnCache.get(src);
  if (fn !== undefined) return fn;
  const nodes = parseTemplate(name, src);
  fn = codegen(nodes);
  fnCache.set(src, fn);
  return fn;
}

/** Compile a parsed template into function (S, O, C, D): scope chain, output array, template map, depth. */
function codegen(nodes) {
  const paths = [];
  const pathIndex = new Map();
  const pid = (path) => {
    const k = path.join('.');
    let i = pathIndex.get(k);
    if (i === undefined) { i = paths.length; paths.push(path); pathIndex.set(k, i); }
    return i;
  };
  let uid = 0;
  const gen = (ns, S) => {
    let out = '';
    for (const n of ns) {
      if (n.kind === 'text') out += `O.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') out += `O.push(H.esc(H.textOf(H.lookup(${S},_p${pid(n.path)}))));`;
      else if (n.kind === 'raw') out += `O.push(H.textOf(H.lookup(${S},_p${pid(n.path)})));`;
      else if (n.kind === 'if') {
        out += `if(H.truthy(H.lookup(${S},_p${pid(n.path)}))!==${n.not}){${gen(n.then, S)}}`;
        if (n.else !== null) out += `else{${gen(n.else, S)}}`;
      } else if (n.kind === 'for') {
        uid++;
        const S2 = 'S' + uid;
        const x = '_x' + uid;
        const nn = '_n' + uid;
        const k = '_k' + uid;
        const lp = '_l' + uid;
        out += `{const ${x}=H.lookup(${S},_p${pid(n.path)});if(Array.isArray(${x})){const ${nn}=${x}.length;const ${S2}=Object.create(${S});const ${lp}={index:0,first:false,last:false,length:${nn}};${S2}.loop=${lp};for(let ${k}=0;${k}<${nn};${k}++){`;
        if (n.name !== 'loop') {
          if (n.name === '__proto__') out += `Object.defineProperty(${S2},'__proto__',{value:${x}[${k}],enumerable:true,configurable:true,writable:true});`;
          else out += `${S2}.${n.name}=${x}[${k}];`;
        }
        out += `${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${nn}-1;`;
        out += gen(n.body, S2);
        out += `}}}`;
      } else if (n.kind === 'include') {
        out += `if(D<8){const _f=C.get(${JSON.stringify(n.name)});if(_f)_f(${S},O,C,D+1);}`;
      }
    }
    return out;
  };
  const body = gen(nodes, 'S0');
  const decls = paths.map((p, i) => `_p${i}=${JSON.stringify(p)}`).join(',');
  const src = `return function(S0,O,C,D){${decls ? 'const ' + decls + ';' : ''}${body}}`;
  return new Function('H', src)(HELPERS);
}

/** Render template `name` with root vars `vars`; null when the template is missing. */
function renderTpl(templates, name, vars) {
  const fn = templates.get(name);
  if (fn === undefined) return null;
  const O = [];
  fn(vars, O, templates, 0);
  return O.join('');
}

// ---------------------------------------------------------------- build

/** `rel` from directory `dir`, or null when it climbs out of the root. */
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

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates: parsed (and compiled) in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, getCompiled(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of path; line ends made "\n"; non-.md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped, in order.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFM(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    const linkCache = new Map();
    const resolveLink = (target, dir, srcPath) => {
      const key = dir + '\n' + target;
      let href = linkCache.get(key);
      if (href === undefined) {
        href = null;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) href = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) href = `${b.bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${b.base}/${path}${frag}`;
        }
        linkCache.set(key, href);
      }
      if (href === null) {
        b.broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      }
      return href;
    };
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const link = (target) => resolveLink(target, dir, s.path);
      const parts = [];
      const md = renderMd(s.body, link, parts);
      s.html = parts.join('');
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, equal dates by slug; newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags: grouped by slug, each named as first met in the posts' order, ordered by count then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (!seen.has(slug)) { seen.add(slug); out.push(name); }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts.
  {
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
    const pageOf = (s) => ({
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    });
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    // Root vars in a null-prototype object so scope lookup never sees Object.prototype.
    const rootVars = (extra) => {
      const v = Object.create(null);
      v.site = site;
      v.tags = allTags;
      v.recent = recent;
      Object.assign(v, extra);
      return v;
    };
    for (const s of b.sources) {
      const html = renderTpl(b.templates, s.layout, rootVars({ page: pageOf(s) }));
      b.output[`${s.outDir}/index.html`] = html;
    }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = renderTpl(b.templates, 'index', rootVars({
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      }));
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = renderTpl(b.templates, 'tag', rootVars({ tag: tagOf(t) }));
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = renderTpl(b.templates, 'tags', rootVars({}));
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
