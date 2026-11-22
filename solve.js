// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input: every page's index.html, the index and tag
// pages, build-report.txt and each static file, byte for byte. The rules it
// implements are the ones stated in makefun-site's README (its front matter,
// its template dialect, its Markdown subset, its slug rule, its report) with
// the reference code as the arbiter wherever the two differ.
//
// Speed comes from doing the same work with cheaper primitives: single-pass
// character-code scanners instead of a regex per line, batched HTML escaping
// instead of a regex replace per character, an ASCII fast path for slugs,
// and rendering Markdown straight into output strings instead of building
// token arrays first. Nothing is cached between run() calls: every call
// builds all of its own state and drops it when it returns.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The five characters HTML escaping replaces, and what they become. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;

/**
 * `text` with & < > " and ' escaped. Strings holding none of them are
 * returned untouched, which is the common case for plain prose.
 */
function esc(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const rep = ESCAPES[text[i]];
    if (rep !== undefined) {
      out += text.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

/** Whether code unit `c` is whitespace in JavaScript's \s sense. */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII fast path: only \t \n \v \f \r and space are whitespace below 128.
    const ws = c < 128 ? c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 : isWS(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * A slug factory scoped to one run() call: slugs repeat a lot inside one
 * site (colliding titles, the same tag spelled twice), so results are
 * memoised in a map that lives and dies with the call.
 */
function makeSlugify() {
  const memo = new Map();
  const MARKS = /\p{M}/gu;
  return function slugify(text) {
    const hit = memo.get(text);
    if (hit !== undefined) return hit;
    // Pure ASCII text needs no normalisation: NFKD leaves every ASCII code
    // point alone and ASCII holds no combining marks. Only when a code
    // point above 127 shows up do we pay for normalize() and mark removal.
    let plain = text;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 127) {
        ascii = false;
        break;
      }
    }
    if (!ascii) plain = text.normalize('NFKD').replace(MARKS, '');
    let out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = out.slice(0, end);
    if (out === '') out = 'untitled';
    memo.set(text, out);
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** The directory of a path ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');


// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: `key "${key}": a quoted string is not closed` };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function fmDate(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) {
        ok = false;
        break;
      }
    }
  }
  const y = ok ? Number(raw.slice(0, 4)) : 0;
  const mo = ok ? Number(raw.slice(5, 7)) : 0;
  const d = ok ? Number(raw.slice(8, 10)) : 0;
  if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ ]. */
function fmTags(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = [];
  for (const part of inner.split(',')) {
    const t = part.trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(t);
  }
  return { value: tags };
}

/** Whether `raw` is a template name (a-z, 0-9 and -). */
function isTemplateName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single - between). */
function isSlugValue(raw) {
  if (raw.length === 0) return false;
  let prevDash = true; // a slug may not open on -
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else if (c === 45 && !prevDash) prevDash = true;
    else return false;
  }
  return !prevDash; // and may not close on -
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(key, raw);
    case 'date':
      return fmDate(raw);
    case 'tags':
      return fmTags(raw);
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Only the front
 * matter region is scanned line by line; the body is the untouched tail of
 * the text after the closing --- line.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  // Find the closing --- line; line 1 is the opening ---.
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    lineNo++;
    if (text.slice(pos, e) === '---') {
      closeStart = pos;
      closeEnd = e;
      break;
    }
    if (e === text.length) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = firstNl === -1 ? text.length : firstNl + 1;
  let n = 2;
  while (p < closeStart) {
    let e = text.indexOf('\n', p);
    if (e === -1 || e > closeStart) e = closeStart;
    const line = text.slice(p, e);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // A "key: value" line: key of a-z and _, a colon, one space and the value.
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if ((c >= 97 && c <= 122) || c === 95) i++;
        else break;
      }
      if (i === 0 || line.charCodeAt(i) !== 58) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${n} is not "key: value"` };
      let rlen = raw.length;
      while (rlen > 0 && (raw.charCodeAt(rlen - 1) === 32 || raw.charCodeAt(rlen - 1) === 9)) rlen--;
      raw = raw.slice(0, rlen);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    n++;
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}


// ---------------------------------------------------------------- Markdown

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length || (line.charCodeAt(h) !== 32 && line.charCodeAt(h) !== 9)) return null;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break (--- or ***, then spaces or tabs only). */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null when `line` does not open one. */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (j === 9 && line.charCodeAt(9) >= 48 && line.charCodeAt(9) <= 57) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  return false;
}

/** The characters a backslash escapes (as code units). */
const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const last = hi - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The five HTML-special characters, by code unit, and what they escape to. */
const ENT = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };

/** One character escaped (used for a backslash-escaped character). */
function esc1(ch) {
  const rep = ENT[ch.charCodeAt(0)];
  return rep === undefined ? ch : rep;
}

/** What each ASCII code unit means to the inline scanner: 0 plain, 1 backslash, 2 backtick, 3 star, 4 bracket, 5 HTML-special. */
const INLINE_KIND = new Uint8Array(128);
INLINE_KIND[92] = 1;
INLINE_KIND[96] = 2;
INLINE_KIND[42] = 3;
INLINE_KIND[91] = 4;
INLINE_KIND[38] = 5;
INLINE_KIND[60] = 5;
INLINE_KIND[62] = 5;
INLINE_KIND[34] = 5;
INLINE_KIND[39] = 5;

/**
 * `s[lo..hi)` rendered inline; `env.link(target)` is a link's href. Plain
 * runs are copied verbatim and an HTML-special character is escaped the
 * moment it is met, so a run never passes through esc() at all.
 */
function inlineRange(s, lo, hi, env) {
  let out = '';
  let i = lo;
  let run = lo;
  while (i < hi) {
    const c = s.charCodeAt(i);
    const kind = c < 128 ? INLINE_KIND[c] : 0;
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1 && i + 1 < hi && ESCAPABLE.has(s.charCodeAt(i + 1))) {
      out += s.slice(run, i) + esc1(s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (kind === 1) {
      i++;
      continue;
    }
    if (kind === 2) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        out += s.slice(run, i) + '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (kind === 3) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          out += s.slice(run, i) + '<strong>' + inlineRange(s, i + 2, j, env) + '</strong>';
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, hi);
        if (j !== -1 && j > i + 1) {
          out += s.slice(run, i) + '<em>' + inlineRange(s, i + 1, j, env) + '</em>';
          i = j + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    if (kind === 4) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      if (m !== -1 && m < hi) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !/\s/.test(target)) {
          out += s.slice(run, i) + '<a href="' + esc(env.link(target)) + '">' + inlineRange(s, i + 1, k, env) + '</a>';
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // kind === 5: an HTML-special character.
    out += s.slice(run, i) + ENT[c];
    i++;
    run = i;
  }
  return out + s.slice(run, hi);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugify) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: only `, #, >, - and * and a digit can
    // open a block other than a paragraph, and a line of spaces or tabs is
    // blank or a paragraph line. Anything else is a paragraph line.
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        let code = '';
        i++;
        while (i < n && !fenceClose(lines[i])) {
          code += `${esc(lines[i])}\n`;
          i++;
        }
        i++;
        const cls = fence === '' ? '' : ` class="language-${esc(fence)}"`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineRange(heading.text, 0, heading.text.length, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const quoted = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        quoted.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = quoted.filter((l) => l !== '');
      if (kept.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else {
        const text = kept.join('\n');
        blocks.push(`<blockquote>\n<p>${inlineRange(text, 0, text.length, env)}</p>\n</blockquote>`);
      }
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [[trimLine(bullet)]];
        i++;
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        let itemsHtml = '';
        for (const parts of items) {
          const text = parts.join('\n');
          itemsHtml += `<li>${inlineRange(text, 0, text.length, env)}</li>\n`;
        }
        blocks.push(`<ul>\n${itemsHtml}</ul>`);
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [[trimLine(ordered.text)]];
        i++;
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = ordered.start !== 1 ? `<ol start="${ordered.start}">` : '<ol>';
        let itemsHtml = '';
        for (const parts of items) {
          const text = parts.join('\n');
          itemsHtml += `<li>${inlineRange(text, 0, text.length, env)}</li>\n`;
        }
        blocks.push(`${open}\n${itemsHtml}</ol>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineRange(text, 0, text.length, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}


// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaceTab(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
      tokens.push({ t: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
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
  const frames = [root];
  let cur = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      cur.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      cur.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = frames[frames.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathParts(name, m[2]), body: [] };
      cur.push(node);
      frames.push(node);
      cur = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathParts(name, m[2]), then: [], else: null };
      cur.push(node);
      frames.push(node);
      cur = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.else = [];
      cur = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      frames.pop();
      const parent = frames[frames.length - 1];
      cur = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      cur.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (frames.length > 1) {
    throw new TemplateError(`template "${name}": a ${frames[frames.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
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
 * `nodes` rendered in `scope` ({ vars, parent }). `templates` holds the
 * parsed templates (a template that did not parse is absent), `depth` the
 * include depth.
 */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}


// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` opens with a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < target.length && target.charCodeAt(i) === 58;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugify();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  let pageCount = 0;
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
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
    if (!s.post) pageCount++;
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const pg = bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // A card reads this once per page the source appears on; count the words once here.
    s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading_minutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => {
    const c = cardOf(s);
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
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
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
