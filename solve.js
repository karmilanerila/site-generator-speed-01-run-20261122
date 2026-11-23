// solve.js — a minimal drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written fresh for round 4: one small module, no dependencies. run(input) returns
// exactly the output tree makefun-site 1.0.0 builds for the input, byte for byte.
// Design: single-pass rendering (no token trees), flat template ops, cached slugs.

const E = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const esc = (s) => {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const slugCache = new Map();
function slug(s) {
  const hit = slugCache.get(s);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? s : s.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(s, out);
  return out;
}

function uniq(s, taken) {
  let out = s;
  for (let n = 2; taken.has(out); n++) out = s + '-' + n;
  taken.add(out);
  return out;
}

const longDate = (d) => Number(d.slice(8, 10)) + ' ' + MO[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};
const wordsOf = (t) => {
  let n = 0;
  let inW = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || (c > 127 && /\s/.test(t[i]));
    if (ws) inW = false;
    else if (!inW) {
      inW = true;
      n++;
    }
  }
  return n;
};

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

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  if (key === 'layout') return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  if (key === 'slug') return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  return { error: 'unknown key "' + key + '"' };
}

function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci === -1) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = line.slice(0, ci);
    let keyOk = key.length > 0;
    for (let k = 0; keyOk && k < key.length; k++) {
      const cc = key.charCodeAt(k);
      if (!((cc >= 97 && cc <= 122) || cc === 95)) keyOk = false;
    }
    if (!keyOk) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const rest = line.slice(ci + 1);
    if (rest !== '' && rest[0] !== ' ') return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let raw = rest === '' ? '' : rest.slice(1);
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const isContinued = (l) => {
  let j = 0;
  while (l[j] === ' ') j++;
  if (j < 2 || j >= l.length) return false;
  const c = l[j];
  return c !== ' ' && c !== '\t' && c !== '\r' && c !== '\f' && c !== '\v';
};
const trim = (l) => {
  let a = 0;
  let b = l.length;
  while (a < b && (l.charCodeAt(a) === 32 || l.charCodeAt(a) === 9)) a++;
  while (b > a && (l.charCodeAt(b - 1) === 32 || l.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
};
const WS_RE = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUn(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = 0;
    for (let p = j - 1; p >= from && s[p] === '\\'; p--) k++;
    if (k % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

function findStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = 0;
    for (let p = j - 1; p >= from && s[p] === '\\'; p--) k++;
    if (k % 2 === 1) {
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

function inline(s, env) {
  const re = /[\\`*\[]/g;
  let out = '';
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += esc(s[i + 1]);
        re.lastIndex = i + 2;
        plain = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        re.lastIndex = j + 1;
        plain = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUn(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out += esc(s.slice(plain, i));
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          re.lastIndex = j + 2;
          plain = j + 2;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out += esc(s.slice(plain, i));
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        re.lastIndex = j + 1;
        plain = j + 1;
      }
      continue;
    }
    const k = findUn(s, ']', i + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const t = mm === -1 ? '' : s.slice(k + 2, mm);
    if (t !== '' && !WS_RE.test(t)) {
      if (i > plain) out += esc(s.slice(plain, i));
      out += '<a href="' + esc(env(t)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
      re.lastIndex = mm + 1;
      plain = mm + 1;
    }
  }
  if (s.length > plain) out += esc(s.slice(plain));
  return out;
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

const isBlank = (l) => {
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
};

const isFenceClose = (l) => {
  if (!l.startsWith('```')) return false;
  for (let i = 3; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
};

function endsPara(line) {
  const c = line[0];
  if (c === undefined) return true;
  if (c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return FENCE_OPEN_RE.test(line);
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return HR_RE.test(line);
  return false;
}

function renderMd(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  const ids = new Set();
  while (i < n) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined || ((c0 === ' ' || c0 === '\t') && isBlank(line))) {
      i++;
      continue;
    }
    let m = c0 === '`' ? FENCE_OPEN_RE.exec(line) : null;
    if (m !== null) {
      const lang = m[1];
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      html += '<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>' + (body.length === 0 ? '' : esc(body.join('\n')) + '\n') + '</code></pre>\n';
      continue;
    }
    const h = c0 === '#' ? headingOf(line) : null;
    if (h !== null) {
      const id = uniq(slug(h.text), ids);
      const ht = inline(h.text, link);
      html += '<h' + h.depth + ' id="' + id + '">' + ht + '</h' + h.depth + '>\n';
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: ht });
      i++;
      continue;
    }
    if ((c0 === '-' || c0 === '*') && HR_RE.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const q = lines[i++];
        body.push(q.slice(q[1] === ' ' ? 2 : 1));
      }
      const t = body.map(trim).filter((l) => l !== '');
      html += t.length === 0 ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(t.join('\n'), link) + '</p>\n</blockquote>\n';
      continue;
    }
    m = (c0 === '-' || c0 === '*') ? BULLET_RE.exec(line) : null;
    const o = m === null && c0 >= '0' && c0 <= '9' ? ORDERED_RE.exec(line) : null;
    if (m !== null || o !== null) {
      const ord = o !== null;
      const marker = ord ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < n) {
        const l0 = lines[i][0];
        const mm = (ord ? (l0 >= '0' && l0 <= '9') : (l0 === '-' || l0 === '*')) ? marker.exec(lines[i]) : null;
        if (mm !== null) {
          items.push([trim(ord ? mm[2] : mm[1])]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trim(lines[i]));
          i++;
        } else break;
      }
      const start = ord ? Number(o[1]) : 1;
      html += ord && start !== 1 ? '<ol start="' + start + '">' : '<' + (ord ? 'ol' : 'ul') + '>';
      html += '\n';
      for (const it of items) html += '<li>' + inline(it.join('\n'), link) + '</li>\n';
      html += '</' + (ord ? 'ol' : 'ul') + '>\n';
      continue;
    }
    const body = [trim(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trim(lines[i++]));
    const ht = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = ht;
    html += '<p>' + ht + '</p>\n';
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates
// Ops: [0, text] [1, path] escaped var [2, path] raw var [3, tag] (tokenizer only)
//      [4, name, path, body] for [5, not, path, then, else|null] if [6, name] include

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new Error('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function parseTpl(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new Error('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') {
        toks.push([0, text]);
        text = '';
      }
      toks.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new Error('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const ls = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const le = nl === -1 ? src.length : nl;
    const solo = /^[ \t]*$/.test(src.slice(ls, open)) && /^[ \t]*$/.test(src.slice(end, le));
    if (solo) text = text.slice(0, text.length - (open - ls));
    if (text !== '') {
      toks.push([0, text]);
      text = '';
    }
    toks.push([3, src.slice(open + 2, close).trim()]);
    i = solo ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push([0, text]);
  const root = [];
  const stack = [{ n: null, b: root }];
  let body = root;
  for (const tk of toks) {
    if (tk[0] === 0) body.push([0, tk[1]]);
    else if (tk[0] === 1 || tk[0] === 2) body.push([tk[0], tk[1]]);
    else {
      const tag = tk[1];
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const nd = [4, m[1], pathOf(name, m[2]), []];
        body.push(nd);
        stack.push({ n: nd, b: nd[3] });
        body = nd[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const nd = [5, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(nd);
        stack.push({ n: nd, b: nd[3] });
        body = nd[3];
      } else if (tag === 'else') {
        if (top.n === null || top.n[0] !== 5 || top.n[4] !== null) throw new Error('template "' + name + '": an else outside an if');
        top.n[4] = [];
        top.b = top.n[4];
        body = top.b;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.n === null || top.n[0] !== (tag === 'endfor' ? 4 : 5)) throw new Error('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        body = stack[stack.length - 1].b;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push([6, m[1]]);
      else throw new Error('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new Error('template "' + name + '": a ' + (stack[stack.length - 1].n[0] === 4 ? 'for' : 'if') + ' is not closed');
  return root;
}

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

function txtOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txtOf).join(', ');
  return '';
}

function escTxt(v) {
  if (typeof v === 'string') return esc(v);
  return esc(txtOf(v));
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function render(ops, scope, ctx, depth) {
  let out = '';
  for (const n of ops) {
    const k = n[0];
    if (k === 0) out += n[1];
    else if (k === 1) out += escTxt(lookup(scope, n[1]));
    else if (k === 2) out += txtOf(lookup(scope, n[1]));
    else if (k === 5) {
      const br = (truthy(lookup(scope, n[2])) !== n[1] ? n[3] : n[4]);
      if (br !== null) out += render(br, scope, ctx, depth);
    } else if (k === 4) {
      const xs = lookup(scope, n[2]);
      if (Array.isArray(xs)) {
        const vars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars[n[1]] = xs[0];
        vars.loop = loop;
        const sc = { vars, parent: scope };
        for (let j = 0; j < xs.length; j++) {
          vars[n[1]] = xs[j];
          loop.index = j + 1;
          loop.first = j === 0;
          loop.last = j === xs.length - 1;
          out += render(n[3], sc, ctx, depth);
        }
      }
    } else if (k === 6) {
      const t = ctx.get(n[1]);
      if (t !== undefined && depth < 8) out += render(t, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- build

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (e) {
      report.push(e.message);
    }
  }
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }
  const kept = [];
  for (const s of sources) {
    const f = parseFM(s.text);
    if (f.error) {
      report.push('refused ' + s.path + ': ' + f.error);
      continue;
    }
    s.data = f.data;
    s.body = f.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniq(s.data.slug !== undefined ? s.data.slug : slug(s.data.title), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (t) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || t[0] === '/' || t[0] === '#') return t;
      const h = t.indexOf('#');
      const rel = h === -1 ? t : t.slice(0, h);
      const frag = h === -1 ? '' : t.slice(h);
      const p = rel === '' ? null : resolvePath(dir, rel);
      if (p !== null && bySource.has(p)) return bySource.get(p).url + frag;
      if (p !== null && staticPaths.has(p)) return base + '/' + p + frag;
      broken.add('broken-link ' + s.path + ' -> ' + t);
      return t;
    };
    const r = renderMd(s.body, link);
    s.html = r.html;
    s.toc = r.toc;
    s.excerpt = r.excerpt;
    s.words = wordsOf(s.body);
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags !== undefined ? s.data.tags : []) {
      const sl = slug(name);
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
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: base + '/tags/' + sl + '/', posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) || { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const output = {};
  const rootVars = { site, tags: allTags, recent };
  const rootScope = { vars: rootVars, parent: null };
  const renderPage = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (!Object.hasOwn(vars, 'page')) delete rootVars.page;
    if (!Object.hasOwn(vars, 'posts')) delete rootVars.posts;
    if (!Object.hasOwn(vars, 'pager')) delete rootVars.pager;
    if (!Object.hasOwn(vars, 'tag')) delete rootVars.tag;
    Object.assign(rootVars, vars);
    return render(nodes, rootScope, templates, 0);
  };
  for (const s of kept) {
    output[s.outDir + '/index.html'] = renderPage(s.layout, {
      page: {
        ...(cards.get(s) || cardOf(s)),
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer !== undefined ? s.newer : null),
        older: linkOf(s.older !== undefined ? s.older : null),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderPage('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = renderPage('tag', { tag: tagOf(t) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderPage('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(cmp);
  const npages = kept.filter((s) => !s.post).length;
  lines.push('built ' + npages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
