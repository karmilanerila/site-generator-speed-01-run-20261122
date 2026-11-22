// Fast drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns, byte for byte, but with far less CPU. Written from
// the README's rules and the reference's observable behaviour; no code is shared
// with the reference or with any earlier entry. Single-pass scanners, batched
// escaping, an ASCII fast path for slugs, and templates compiled once per case
// into plain string-building functions.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KNOWN_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Code-unit order, never the locale's. */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}


const ESC_RE = /[&<>"']/;

/** `text` with & < > " ' escaped, scanning for the next special in one pass. */
export function escapeHtml(text) {
  if (!ESC_RE.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > last) out += text.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  if (last === 0) return text;
  if (last < text.length) out += text.slice(last);
  return out;
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure ASCII text never touches normalize(). */
export function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let plain;
  if (ascii) {
    plain = text;
  } else {
    plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  }
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
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = `${slug}-${n}`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// ---------------------------------------------------------------- front matter

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
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let i = 0;
      while (i < raw.length) {
        const start = i;
        while (i < raw.length) {
          const c = raw.charCodeAt(i);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
          else break;
        }
        if (i === start) return { error: 'key "slug": not a slug' };
        if (i === raw.length) break;
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
        if (i === raw.length) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const line0 = firstNl === -1 ? text : text.slice(0, firstNl);
  if (line0 !== '---') return { error: 'no front matter' };
  // Find the closing line and collect the lines between.
  const fmLines = [];
  let closeLine = -1; // 0-based index of the closing '---'
  let bodyStart = -1;
  let p = firstNl === -1 ? text.length : firstNl + 1;
  let idx = 1;
  while (p <= text.length) {
    const e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    if (line === '---') {
      closeLine = idx;
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) break;
    p = e + 1;
    idx++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // key: value — key of a-z and _, a colon, one space and the value.
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${i + 2} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 2} is not "key: value"` };
    let rEnd = raw.length;
    while (rEnd > 0) {
      const c = raw.charCodeAt(rEnd - 1);
      if (c === 32 || c === 9) rEnd--;
      else break;
    }
    if (rEnd < raw.length) raw = raw.slice(0, rEnd);
    const key = line.slice(0, j);
    if (!KNOWN_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapableCode(c) {
  return c < 128 && ESCAPABLE[c] === 1;
}

/** First index from `from` (below `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (below `end`; one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
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

/** The next index at or after `i` (below `end`) holding a markdown-special char, or `end`. */
function nextSpecial(s, i, end) {
  let j = end;
  for (let k = 0; k < 4; k++) {
    const c = k === 0 ? '\\' : k === 1 ? '`' : k === 2 ? '*' : '[';
    const p = s.indexOf(c, i);
    if (p !== -1 && p < j) j = p;
  }
  return j;
}

/** `s[start..end]` rendered inline, appended to `out`; `env.link(target)` is a link's href. */
function inlineInto(s, env, out, start, end) {
  let i = start;
  let plain = start;
  while (i < end) {
    const j = nextSpecial(s, i, end);
    if (j >= end) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push(escapeHtml(s[j + 1]));
        i = j + 2;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, end);
        if (k > j + 2) {
          if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
          out.push('<strong>');
          inlineInto(s, env, out, j + 2, k);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, end);
      if (k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<em>');
        inlineInto(s, env, out, j + 1, k);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // c === 91 '['
    const k = findUnescaped(s, ']', j + 1, end);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 || m >= end ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s, env, out, j + 1, k);
      out.push('</a>');
      i = m + 1;
      plain = i;
      continue;
    }
    i = j + 1;
  }
  if (end > plain) out.push(escapeHtml(s.slice(plain, end)));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out, 0, s.length);
  return out.join('');
}


function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence-open line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  if (hashes >= line.length) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  let a = hashes;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: hashes, text: line.slice(a, b) };
}


/** Whether `line` ends a paragraph: blank, fence-open, heading or thematic break. */
function endsParagraph(line) {
  const k = lineKind(line);
  return k !== 4;
}

/** One scan classifying a line: 0 blank, 1 fence-open, 2 heading, 3 thematic break, 4 other. */
function lineKind(line) {
  const n = line.length;
  if (n === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 4;
    }
    return 0;
  }
  if (c0 === 35) {
    let h = 0;
    while (h < n && line.charCodeAt(h) === 35) h++;
    if (h > 6 || h >= n) return 4;
    const c = line.charCodeAt(h);
    if (c !== 32 && c !== 9) return 4;
    let a = h;
    while (a < n && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
    if (a === n) return 4;
    return 2;
  }
  if (c0 === 96) {
    if (n >= 3 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let i = 3;
      while (i < n) {
        const c = line.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
        else break;
      }
      for (let j = i; j < n; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) return 4;
      }
      return 1;
    }
    return 4;
  }
  if (c0 === 45) {
    if (n >= 3 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) {
      for (let j = 3; j < n; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) return 4;
      }
      return 3;
    }
    return 4;
  }
  if (c0 === 42) {
    if (n >= 3 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42) {
      for (let j = 3; j < n; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) return 4;
      }
      return 3;
    }
    return 4;
  }
  return 4;
}

function isContinued(line) {
  return /^ {2,}\S/.test(line);
}

/**
 * `src` rendered: its HTML, table of contents (level 2/3 headings) and excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceLang(line);
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`);
      for (let k = 0; k < body.length; k++) out.push(escapeHtml(body[k]), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      const tmp = [];
      inlineInto(heading.text, env, tmp, 0, heading.text.length);
      const html = tmp.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const text = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(text, env, out, 0, text.length);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const c0 = line.charCodeAt(0);
    const bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    let ordered = false;
    let firstNum = 0;
    if (!bullet) {
      let d = 0;
      while (d < line.length && d < 10) {
        const c = line.charCodeAt(d);
        if (c >= 48 && c <= 57) d++;
        else break;
      }
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        firstNum = Number(line.slice(0, d));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        let mText = null;
        if (ordered) {
          let d = 0;
          while (d < l.length && d < 10) {
            const c = l.charCodeAt(d);
            if (c >= 48 && c <= 57) d++;
            else break;
          }
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) mText = l.slice(d + 2);
        } else {
          const cc = l.charCodeAt(0);
          if ((cc === 45 || cc === 42) && l.charCodeAt(1) === 32) mText = l.slice(2);
        }
        if (mText !== null) {
          items.push([trimLine(mText)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        const text = items[k].join('\n');
        inlineInto(text, env, out, 0, text.length);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineInto(text, env, out, 0, text.length);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}


// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

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
      const raw = src.charCodeAt(open + 2) === 123;
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
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
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`'s first name in the scope chain. */
function lookupFirst(scope, first) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  return s === null ? undefined : s.vars[first];
}

/** One own property step, or undefined. */
function propOf(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value written escaped, as a {{ }} tag writes it. */
function escapeText(v) {
  return typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v));
}

/** Compile parsed `nodes` into a render function (S, D, O, T, H): scope, include depth, output chunks, template table, helpers. */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = [];
  const pathExpr = (scopeVar, path) => {
    let e = `H.lk(${scopeVar},${JSON.stringify(path[0])})`;
    for (let k = 1; k < path.length; k++) e = `H.pr(${e},${JSON.stringify(path[k])})`;
    return e;
  };
  const gen = (list, scopeVar) => {
    for (const n of list) {
      if (n.kind === 'text') {
        parts.push(`O.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var') {
        parts.push(`O.push(H.et(${pathExpr(scopeVar, n.path)}));`);
      } else if (n.kind === 'raw') {
        parts.push(`O.push(H.txt(${pathExpr(scopeVar, n.path)}));`);
      } else if (n.kind === 'if') {
        parts.push(`if(H.tr(${pathExpr(scopeVar, n.path)})!==${n.not ? 'true' : 'false'}){`);
        gen(n.then, scopeVar);
        if (n.else !== null) {
          parts.push('}else{');
          gen(n.else, scopeVar);
        }
        parts.push('}');
      } else if (n.kind === 'for') {
        const a = `a${uid}`;
        const k = `k${uid}`;
        const s = `s${uid}`;
        uid++;
        parts.push(`var ${a}=H.lk(${scopeVar},${JSON.stringify(n.path[0])});`);
        for (let j = 1; j < n.path.length; j++) parts.push(`${a}=H.pr(${a},${JSON.stringify(n.path[j])});`);
        parts.push(`if(Array.isArray(${a})){for(var ${k}=0;${k}<${a}.length;${k}++){var ${s}={vars:{[${JSON.stringify(n.name)}]:${a}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length}},parent:${scopeVar}};`);
        gen(n.body, s);
        parts.push('}}');
      } else if (n.kind === 'include') {
        const f = `f${uid++}`;
        parts.push(`if(D<${INCLUDE_DEPTH}){var ${f}=T[${JSON.stringify(n.name)}];if(${f})${f}(${scopeVar},D+1,O,T,H);}`);
      }
    }
  };
  gen(nodes, 'S');
  return new Function('S', 'D', 'O', 'T', 'H', parts.join(''));
}

// ---------------------------------------------------------------- the build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** A post's card, as lists show it. */
function cardOf(s, slugCache) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date === undefined ? '' : s.data.date, date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };

  // Templates, parsed and compiled in code-unit order of name. One that does
  // not parse is reported and left out, as if it were not there.
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; line ends made "\n"; the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 0; d < RESERVED.length; d++) {
      const dir = RESERVED[d];
      if (dir !== 'posts' && s.path.startsWith(`${dir}/`)) { own = dir; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout === undefined ? (s.post ? 'post' : 'page') : s.data.layout;
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
  sources = kept;

  // 3. Permalinks: each page's directory and url, its slug unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const baseSlug = s.data.slug === undefined ? slug(s.data.title) : s.data.slug;
    s.slug = uniqueSlug(baseSlug, set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (
          (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)
        ) {
          let j = 1;
          while (j < target.length) {
            const c = target.charCodeAt(j);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
            else break;
          }
          if (target.charCodeAt(j) === 58) return target;
        }
        if (c0 === 47 || c0 === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = [];
  for (let i = 0; i < sources.length; i++) if (sources[i].post) posts.push(sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags === undefined ? [] : s.data.tags;
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const sg = slug(name);
      if (!seen.has(sg)) {
        seen.add(sg);
        out.push(name);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const sg = slug(name);
      let tag = bySlug.get(sg);
      if (tag === undefined) {
        tag = { name, slug: sg, url: `${base}/tags/${sg}/`, posts: [] };
        bySlug.set(sg, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = new Array(names2.length);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const sg = slug(name);
      const t = bySlug.get(sg);
      s.tagRefs[j] = t === undefined ? { name, slug: sg, url: '', posts: [] } : t;
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i], slugCache));
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const H = { esc: escapeHtml, txt: textOf, et: escapeText, lk: lookupFirst, pr: propOf, tr: truthy };
  // A plain lookup table for the compiled templates (a Map cannot be indexed by name).
  const table = Object.create(null);
  for (const [name, fn] of templates) table[name] = fn;
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const O = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, O, table, H);
    return O.join('');
  };
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const card = s.post ? cards.get(s) : cardOf(s, slugCache);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer === undefined ? null : s.newer),
      older: linkOf(s.older === undefined ? null : s.older),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const plist = new Array(slice.length);
    for (let j = 0; j < slice.length; j++) plist[j] = cards.get(slice[j]);
    const html = render('index', {
      posts: plist,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const tposts = new Array(t.posts.length);
    for (let j = 0; j < t.posts.length; j++) tposts[j] = cards.get(t.posts[j]);
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tposts } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < sources.length; i++) if (!sources[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
