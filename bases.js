'use strict';
/* Bases do Obsidian (.base): leitura do YAML, avaliação de filtros e fórmulas e exibição das visões.
   Depende de funções definidas em app.js (IX, BL, pathOf, resolve, wikiHTML etc.), chamadas só na hora do uso. */

/* ---------- Tipos auxiliares ---------- */
class BDur { constructor(ms) { this.ms = ms; } get days() { return Math.floor(this.ms / 864e5); } get hours() { return Math.floor(this.ms / 36e5); } get minutes() { return Math.floor(this.ms / 6e4); } get seconds() { return Math.floor(this.ms / 1e3); } get milliseconds() { return this.ms; } }
class BLink { constructor(target, display) { this.target = String(target); this.display = display; } get id() { return resolve(parseLink(this.target).file, null); } toString() { return this.display || parseLink(this.target).file.replace(/\.md$/i, ''); } }
const isDateStr = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(s);
function toDate(v) {
  if (v instanceof Date) return v;
  if (isDateStr(v)) { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v); return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); }
  return null;
}
function parseDur(s) {
  if (s instanceof BDur) return s;
  const re = /(-?\d+(?:\.\d+)?)\s*(years?|y|months?|M|weeks?|w|days?|d|hours?|h|minutes?|m|seconds?|s)\b/g;
  let m, out = { y: 0, M: 0, ms: 0 }, ok = false;
  while ((m = re.exec(String(s)))) {
    ok = true; const n = +m[1], u = m[2];
    if (/^y/.test(u)) out.y += n; else if (u === 'M' || /^month/.test(u)) out.M += n;
    else if (/^w/.test(u)) out.ms += n * 7 * 864e5; else if (/^d/.test(u)) out.ms += n * 864e5;
    else if (/^h/.test(u)) out.ms += n * 36e5; else if (u === 'm' || /^minute/.test(u)) out.ms += n * 6e4; else out.ms += n * 1e3;
  }
  return ok ? out : null;
}
function addDur(d, dur, sign) {
  const r = new Date(d.getTime());
  if (dur instanceof BDur) { r.setTime(r.getTime() + sign * dur.ms); return r; }
  if (dur.y) r.setFullYear(r.getFullYear() + sign * dur.y);
  if (dur.M) r.setMonth(r.getMonth() + sign * dur.M);
  r.setTime(r.getTime() + sign * dur.ms); return r;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtDate(d, f) {
  const mes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const sem = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  return String(f).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case 'YYYY': return d.getFullYear(); case 'YY': return pad(d.getFullYear() % 100);
      case 'MMMM': return mes[d.getMonth()]; case 'MMM': return mes[d.getMonth()].slice(0, 3);
      case 'MM': return pad(d.getMonth() + 1); case 'M': return d.getMonth() + 1;
      case 'DD': return pad(d.getDate()); case 'D': return d.getDate();
      case 'dddd': return sem[d.getDay()]; case 'ddd': return sem[d.getDay()].slice(0, 3);
      case 'HH': return pad(d.getHours()); case 'H': return d.getHours();
      case 'mm': return pad(d.getMinutes()); case 'ss': return pad(d.getSeconds());
    }
    return t;
  });
}
const isEmptyV = v => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !(v instanceof Date) && !(v instanceof BDur) && !(v instanceof BLink) && !v.__file && !Object.keys(v).length);
const truthy = v => !isEmptyV(v) && v !== false && v !== 0;

/* ---------- Analisador de expressões ---------- */
function btokens(src) {
  const out = []; let i = 0;
  const two = ['==', '!=', '>=', '<=', '&&', '||'];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) { j++; v += { n: '\n', t: '\t' }[src[j]] || src[j]; } else v += src[j]; j++; }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (/\d/.test(c)) { const m = /^\d+(\.\d+)?/.exec(src.slice(i)); out.push({ t: 'num', v: +m[0] }); i += m[0].length; continue; }
    if (/[\p{L}_$]/u.test(c)) { const m = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i)); out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const t2 = src.slice(i, i + 2);
    if (two.includes(t2)) { out.push({ t: 'op', v: t2 }); i += 2; continue; }
    if ('+-*/%<>!().,[]{}:'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('Caractere inesperado: ' + c);
  }
  return out;
}
function bparse(src) {
  const T = btokens(src); let k = 0;
  const peek = v => T[k] && T[k].t === 'op' && T[k].v === v;
  const eat = v => { if (!peek(v)) throw new Error('Esperado ' + v); k++; };
  const bin = (next, ops) => () => { let l = next(); while (T[k] && T[k].t === 'op' && ops.includes(T[k].v)) { const op = T[k++].v; l = { k: 'bin', op, l, r: next() }; } return l; };
  let expr;
  const primary = () => {
    const t = T[k++];
    if (!t) throw new Error('Expressão incompleta');
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') { if (t.v === 'true') return { k: 'lit', v: true }; if (t.v === 'false') return { k: 'lit', v: false }; if (t.v === 'null') return { k: 'lit', v: null }; return { k: 'id', v: t.v }; }
    if (t.v === '(') { const e = expr(); eat(')'); return e; }
    if (t.v === '[') { const items = []; if (!peek(']')) { do items.push(expr()); while (peek(',') && ++k); } eat(']'); return { k: 'list', items }; }
    if (t.v === '{') { const props = []; if (!peek('}')) { do { const key = T[k++]; eat(':'); props.push([key.v, expr()]); } while (peek(',') && ++k); } eat('}'); return { k: 'obj', props }; }
    throw new Error('Símbolo inesperado: ' + t.v);
  };
  const postfix = () => {
    let e = primary();
    for (; ;) {
      if (peek('.')) { k++; const n = T[k++]; e = { k: 'mem', o: e, n: n.v }; }
      else if (peek('[')) { k++; const ix = expr(); eat(']'); e = { k: 'idx', o: e, i: ix }; }
      else if (peek('(')) { k++; const args = []; if (!peek(')')) { do args.push(expr()); while (peek(',') && ++k); } eat(')'); e = { k: 'call', f: e, args }; }
      else return e;
    }
  };
  const unary = () => { if (peek('!')) { k++; return { k: 'not', e: unary() }; } if (peek('-')) { k++; return { k: 'neg', e: unary() }; } return postfix(); };
  const mul = bin(unary, ['*', '/', '%']); const add = bin(mul, ['+', '-']);
  const cmp = bin(add, ['>', '<', '>=', '<=']); const eq = bin(cmp, ['==', '!=']);
  const and = bin(eq, ['&&']); expr = bin(and, ['||']);
  const e = expr(); if (k < T.length) throw new Error('Sobrou texto na expressão'); return e;
}
const parseCache = new Map();
function bcompile(src) { src = String(src); if (!parseCache.has(src)) { let a; try { a = bparse(src); } catch (e) { a = { k: 'err', m: e.message }; } parseCache.set(src, a); } return parseCache.get(src); }

/* ---------- Objetos de arquivo ---------- */
const fileCache = new Map();
function bfile(id) {
  if (!id) return null;
  if (fileCache.has(id)) return fileCache.get(id);
  const it = IX.items.get(id); if (!it) return null;
  const path = pathOf(id), name = it.n, dot = name.lastIndexOf('.');
  const meta = BL.meta.get(id) || { p: {}, t: [], e: [] };
  const f = {
    __file: true, id, name, path, basename: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot + 1) : '',
    folder: dirOf(path), size: it.s || 0, ctime: it.c ? new Date(it.c) : null, mtime: it.m ? new Date(it.m) : null,
    properties: meta.p || {}, tags: meta.t || [],
    get links() { return (BL.targets.get(id) || []).map(t => t.startsWith('w:') ? new BLink(t.slice(2)) : null).filter(Boolean); },
    get embeds() { return (meta.e || []).map(t => new BLink(t)); },
    get backlinks() { return [...(blReverse().get(id) || [])].map(x => new BLink(pathOf(x))); },
    toString() { return this.basename; }
  };
  fileCache.set(id, f); return f;
}
function bClearCache() { fileCache.clear(); }
function linkIds(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(linkIds);
  if (v.__file) return [v.id];
  if (v instanceof BLink) return [v.id];
  const s = String(v); const m = /^\[\[([^\]]+)\]\]$/.exec(s.trim());
  return [resolve(parseLink(m ? m[1] : s).file, null)];
}
function fileMethod(f, n, args) {
  switch (n) {
    case 'hasTag': return args.some(a => { const t = String(a).replace(/^#/, '').toLowerCase(); return f.tags.some(x => { x = x.toLowerCase(); return x === t || x.startsWith(t + '/'); }); });
    case 'inFolder': { const fo = norm(String(args[0] || '').replace(/^\/+|\/+$/g, '')); const mine = norm(f.folder); return !fo || mine === fo || mine.startsWith(fo + '/'); }
    case 'hasLink': { const want = linkIds(args[0]).filter(Boolean); const mine = new Set(f.links.map(l => l.id)); return want.some(w => mine.has(w)); }
    case 'hasProperty': return Object.prototype.hasOwnProperty.call(f.properties, String(args[0]));
    case 'asLink': return new BLink(f.path, args[0]);
  }
  throw new Error('Função de arquivo desconhecida: ' + n);
}

/* ---------- Avaliação ---------- */
function getProp(obj, name) {
  if (!obj) return null;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const low = String(name).toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === low) return obj[k];
  return null;
}
function coerceLink(v) { if (typeof v === 'string') { const m = /^\[\[([^\]]+)\]\]$/.exec(v.trim()); if (m) return new BLink(m[1]); } return v; }
function cmpVals(a, b) {
  if (a instanceof Date || b instanceof Date || (isDateStr(a) && isDateStr(b))) { const x = toDate(a), y = toDate(b); if (x && y) return x - y; }
  if (a instanceof BDur && b instanceof BDur) return a.ms - b.ms;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number' && b !== '' && !isNaN(+b)) return a - +b;
  if (typeof b === 'number' && a !== '' && !isNaN(+a)) return +a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR');
}
function eqVals(a, b) {
  if (a == null || b == null) return (a == null || a === '') && (b == null || b === '');
  if (a instanceof BLink || b instanceof BLink || a.__file || b.__file) { const x = linkIds(a)[0], y = linkIds(b)[0]; return !!x && x === y; }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b) && (typeof a === typeof b || String(a) === String(b));
  return cmpVals(a, b) === 0;
}
function arith(op, a, b) {
  if (op === '+' || op === '-') {
    const da = toDate(a);
    if (da && (a instanceof Date || isDateStr(a))) {
      if (op === '-' && (b instanceof Date || isDateStr(b))) return new BDur(da - toDate(b));
      const d = parseDur(b); if (d) return addDur(da, d, op === '+' ? 1 : -1);
    }
    if (a instanceof BDur && b instanceof BDur) return new BDur(op === '+' ? a.ms + b.ms : a.ms - b.ms);
  }
  if (op === '+' && (typeof a === 'string' || typeof b === 'string') && !(typeof a === 'number' && !isNaN(+b) && b !== '')) return String(a ?? '') + String(b ?? '');
  const x = +a, y = +b;
  switch (op) { case '+': return x + y; case '-': return x - y; case '*': return x * y; case '/': return x / y; case '%': return x % y; }
}
const lazyMethods = new Set(['map', 'filter', 'reduce', 'any', 'all']);
function callMethod(o, n, argNodes, env) {
  if (lazyMethods.has(n) && Array.isArray(o)) {
    const run = (node, value, index, acc) => bev(node, { ...env, locals: { ...(env.locals || {}), value, index, acc } });
    switch (n) {
      case 'map': return o.map((v, i) => run(argNodes[0], v, i));
      case 'filter': return o.filter((v, i) => truthy(run(argNodes[0], v, i)));
      case 'any': return o.some((v, i) => truthy(run(argNodes[0], v, i)));
      case 'all': return o.every((v, i) => truthy(run(argNodes[0], v, i)));
      case 'reduce': { let acc = argNodes[1] ? bev(argNodes[1], env) : null; o.forEach((v, i) => { acc = run(argNodes[0], v, i, acc); }); return acc; }
    }
  }
  const a = argNodes.map(x => bev(x, env));
  if (o && o.__file) return fileMethod(o, n, a);
  // comuns a qualquer tipo
  if (n === 'isEmpty') return isEmptyV(o);
  if (n === 'isTruthy') return truthy(o);
  if (n === 'toString') return valText(o);
  if (n === 'isType') { const t = String(a[0]).toLowerCase(); const ty = o == null ? 'null' : Array.isArray(o) ? 'list' : o instanceof Date ? 'date' : o instanceof BLink ? 'link' : typeof o; return ty === t; }
  if (o instanceof Date) {
    switch (n) {
      case 'format': return fmtDate(o, a[0] || 'YYYY-MM-DD');
      case 'date': return new Date(o.getFullYear(), o.getMonth(), o.getDate());
      case 'time': return fmtDate(o, 'HH:mm:ss');
      case 'relative': { const d = Math.round((o - new Date()) / 864e5); return d === 0 ? 'hoje' : d > 0 ? `em ${d} dia(s)` : `há ${-d} dia(s)`; }
    }
  }
  if (typeof o === 'number') {
    switch (n) {
      case 'round': { const p = 10 ** (a[0] || 0); return Math.round(o * p) / p; }
      case 'floor': return Math.floor(o); case 'ceil': return Math.ceil(o); case 'abs': return Math.abs(o);
      case 'toFixed': return o.toFixed(a[0] || 0);
    }
  }
  if (Array.isArray(o)) {
    switch (n) {
      case 'contains': return o.some(x => eqVals(coerceLink(x), coerceLink(a[0])));
      case 'containsAny': return a.some(y => o.some(x => eqVals(coerceLink(x), coerceLink(y))));
      case 'containsAll': return a.every(y => o.some(x => eqVals(coerceLink(x), coerceLink(y))));
      case 'join': return o.map(valText).join(a[0] ?? ', ');
      case 'reverse': return o.slice().reverse();
      case 'sort': return o.slice().sort(cmpVals);
      case 'unique': { const seen = new Set(); return o.filter(x => { const k = valText(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
      case 'slice': return o.slice(a[0], a[1]);
      case 'flat': return o.flat(Infinity);
      case 'mean': case 'average': { const nums = o.map(Number).filter(x => !isNaN(x)); return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null; }
      case 'sum': return o.map(Number).filter(x => !isNaN(x)).reduce((s, x) => s + x, 0);
      case 'min': return o.length ? o.slice().sort(cmpVals)[0] : null;
      case 'max': return o.length ? o.slice().sort(cmpVals).pop() : null;
    }
  }
  if (o instanceof BLink) {
    if (n === 'asFile') return bfile(o.id);
    if (n === 'linksTo') return linkIds(a[0])[0] === o.id;
  }
  if (typeof o === 'string') {
    switch (n) {
      case 'contains': return o.toLowerCase().includes(String(a[0] ?? '').toLowerCase());
      case 'containsAny': return a.some(y => o.toLowerCase().includes(String(y).toLowerCase()));
      case 'containsAll': return a.every(y => o.toLowerCase().includes(String(y).toLowerCase()));
      case 'startsWith': return o.startsWith(String(a[0])); case 'endsWith': return o.endsWith(String(a[0]));
      case 'lower': return o.toLowerCase(); case 'upper': return o.toUpperCase();
      case 'title': return o.replace(/\p{L}+/gu, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case 'trim': return o.trim();
      case 'replace': return o.split(String(a[0])).join(String(a[1] ?? ''));
      case 'split': return o.split(String(a[0] ?? ','));
      case 'slice': return o.slice(a[0], a[1]);
      case 'repeat': return o.repeat(a[0] || 0);
      case 'reverse': return [...o].reverse().join('');
      case 'matches': try { return new RegExp(a[0]).test(o); } catch { return false; }
    }
    if (isDateStr(o)) return callMethod(toDate(o), n, argNodes, env);
  }
  throw new Error('Função desconhecida: ' + n);
}
function member(o, n) {
  if (o == null) return null;
  if (o.__file) return n in o ? o[n] : null;
  if (o instanceof BDur) return o[n];
  if (o instanceof Date) { switch (n) { case 'year': return o.getFullYear(); case 'month': return o.getMonth() + 1; case 'day': return o.getDate(); case 'hour': return o.getHours(); case 'minute': return o.getMinutes(); case 'second': return o.getSeconds(); case 'millisecond': return o.getMilliseconds(); } return null; }
  if (n === 'length' && (Array.isArray(o) || typeof o === 'string')) return o.length;
  if (o instanceof BLink) return n === 'display' ? o.display : null;
  if (typeof o === 'string' && isDateStr(o)) return member(toDate(o), n);
  if (typeof o === 'object') return getProp(o, n);
  return null;
}
function globalFn(n, a, env) {
  switch (n) {
    case 'date': return a[0] instanceof Date ? a[0] : toDate(String(a[0] ?? '')) || (isNaN(Date.parse(a[0])) ? null : new Date(a[0]));
    case 'now': return new Date();
    case 'today': { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    case 'if': return truthy(a[0]) ? a[1] : (a.length > 2 ? a[2] : null);
    case 'duration': { const d = parseDur(a[0]); return d ? new BDur(d.ms + d.M * 30 * 864e5 + d.y * 365 * 864e5) : null; }
    case 'link': return new BLink(a[0] && a[0].__file ? a[0].path : String(a[0]), a[1]);
    case 'list': return Array.isArray(a[0]) ? a[0] : a[0] == null ? [] : [a[0]];
    case 'number': return a[0] instanceof Date ? a[0].getTime() : typeof a[0] === 'boolean' ? +a[0] : parseFloat(a[0]);
    case 'min': return a.flat().filter(x => x != null).sort(cmpVals)[0] ?? null;
    case 'max': return a.flat().filter(x => x != null).sort(cmpVals).pop() ?? null;
    case 'file': return bfile(a[0] && a[0].__file ? a[0].id : resolve(String(a[0]), null) || IX.byPath.get(norm(String(a[0]))));
    case 'image': case 'icon': case 'html': case 'escapeHTML': return a[0];
  }
  throw new Error('Função desconhecida: ' + n);
}
function bev(node, env) {
  switch (node.k) {
    case 'err': throw new Error(node.m);
    case 'lit': return node.v;
    case 'list': return node.items.map(x => bev(x, env));
    case 'obj': { const o = {}; node.props.forEach(([key, v]) => { o[key] = bev(v, env); }); return o; }
    case 'id': {
      const n = node.v;
      if (env.locals && n in env.locals) return env.locals[n];
      if (n === 'file') return env.file;
      if (n === 'note') return env.file ? env.file.properties : {};
      if (n === 'this') return env.thisFile;
      if (n === 'formula') return { __formula: true };
      if (n === 'values' && env.values) return env.values;
      return coerceLink(getProp(env.file ? env.file.properties : {}, n));
    }
    case 'mem': {
      if (node.o.k === 'id' && node.o.v === 'formula' && !(env.locals && 'formula' in env.locals)) return formulaVal(node.n, env);
      if (node.o.k === 'id' && node.o.v === 'note') return coerceLink(getProp(env.file ? env.file.properties : {}, node.n));
      const o = bev(node.o, env);
      if (o && o.__file && node.o.k === 'id' && node.o.v === 'this' && !(node.n in o)) return coerceLink(getProp(o.properties, node.n));
      return member(o, node.n);
    }
    case 'idx': { const o = bev(node.o, env), i = bev(node.i, env); if (Array.isArray(o) || typeof o === 'string') return o[i < 0 ? o.length + i : i] ?? null; if (o && o.__file) return getProp(o.properties, i); return o && typeof o === 'object' ? getProp(o, i) : null; }
    case 'call': {
      if (node.f.k === 'id') return globalFn(node.f.v, node.args.map(x => bev(x, env)), env);
      if (node.f.k === 'mem') return callMethod(bev(node.f.o, env), node.f.n, node.args, env);
      throw new Error('Chamada inválida');
    }
    case 'not': return !truthy(bev(node.e, env));
    case 'neg': return -bev(node.e, env);
    case 'bin': {
      if (node.op === '&&') return truthy(bev(node.l, env)) && truthy(bev(node.r, env));
      if (node.op === '||') { const l = bev(node.l, env); return truthy(l) ? l : bev(node.r, env); }
      const l = bev(node.l, env), r = bev(node.r, env);
      switch (node.op) {
        case '==': return eqVals(l, r); case '!=': return !eqVals(l, r);
        case '>': return l != null && r != null && cmpVals(l, r) > 0; case '<': return l != null && r != null && cmpVals(l, r) < 0;
        case '>=': return l != null && r != null && cmpVals(l, r) >= 0; case '<=': return l != null && r != null && cmpVals(l, r) <= 0;
        default: return arith(node.op, l, r);
      }
    }
  }
  throw new Error('Expressão inválida');
}
function formulaVal(name, env) {
  const cache = env.fcache || (env.fcache = {});
  if (name in cache) return cache[name];
  const src = env.base && env.base.formulas && getProp(env.base.formulas, name);
  if (src == null) return null;
  cache[name] = null; // evita laços
  let v = null; try { v = bev(bcompile(src), env); } catch { v = null; }
  return cache[name] = v;
}
function bEval(src, env) { try { return bev(bcompile(src), env); } catch { return null; } }
function bFilter(f, env) {
  if (f == null || f === '') return true;
  if (typeof f === 'string') return truthy(bEval(f, env));
  if (typeof f === 'boolean') return f;
  if (Array.isArray(f)) return f.every(x => bFilter(x, env));
  if (f.and) return [].concat(f.and).every(x => bFilter(x, env));
  if (f.or) return [].concat(f.or).some(x => bFilter(x, env));
  if (f.not) return ![].concat(f.not).some(x => bFilter(x, env));
  return true;
}
// Valor de uma coluna: "file.x", "formula.x", "note.x" ou o nome da propriedade.
function colVal(col, env) {
  col = String(col);
  if (col.startsWith('formula.')) return formulaVal(col.slice(8), env);
  if (col.startsWith('file.')) return member(env.file, col.slice(5));
  if (col.startsWith('note.')) return coerceLink(getProp(env.file.properties, col.slice(5)));
  if (col.startsWith('this.')) return env.thisFile ? coerceLink(getProp(env.thisFile.properties, col.slice(5))) : null;
  return coerceLink(getProp(env.file.properties, col));
}
function colLabel(col, base) {
  const p = base.properties && getProp(base.properties, col);
  if (p && p.displayName) return p.displayName;
  const nice = { 'file.name': 'Nome', 'file.basename': 'Nome', 'file.path': 'Caminho', 'file.folder': 'Pasta', 'file.ext': 'Extensão', 'file.size': 'Tamanho', 'file.ctime': 'Criado', 'file.mtime': 'Modificado', 'file.tags': 'Tags', 'file.links': 'Links', 'file.backlinks': 'Backlinks', 'file.embeds': 'Incorporações' };
  return nice[col] || String(col).replace(/^(note|formula)\./, '');
}

/* ---------- Exibição ---------- */
function valText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valText).filter(Boolean).join(', ');
  if (v instanceof Date) return (v.getHours() || v.getMinutes()) ? fmtDate(v, 'DD/MM/YYYY HH:mm') : fmtDate(v, 'DD/MM/YYYY');
  if (v instanceof BDur) { const d = v.days; return d ? d + (Math.abs(d) === 1 ? ' dia' : ' dias') : Math.round(v.ms / 36e5) + ' h'; }
  if (v instanceof BLink || v.__file) return v.toString();
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('pt-BR') : v.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => k + ': ' + valText(x)).join('; ');
  return String(v);
}
function valHTML(v, rowId) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map(x => valHTML(x, rowId)).filter(Boolean).join(', ');
  if (v.__file) return linkToId(v.id, v.basename);
  if (v instanceof BLink) { const id = v.id; return id ? linkToId(id, v.toString()) : `<a class="wl missing">${esc(v.toString())}</a>`; }
  if (typeof v === 'boolean') return v ? '☑' : '☐';
  if (typeof v === 'string') {
    if (isDateStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)) return esc(valText(toDate(v)));
    if (/\[\[[^\]]+\]\]/.test(v)) { const prev = ctx; ctx = { id: rowId, depth: 9 }; try { return esc(v).replace(/\[\[([^\[\]\n]+?)\]\]/g, (_, t) => wikiHTML(t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'))); } finally { ctx = prev; } }
    if (/^https?:\/\/\S+$/.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
  }
  return esc(valText(v));
}
function linkToId(id, label) {
  const it = IX.items.get(id); if (!it) return esc(label);
  if (isMd(it.n)) return `<a class="wl" href="${noteHref(id)}">${esc(label)}</a>`;
  if (/\.base$/i.test(it.n)) return `<a class="wl" href="#/b/${encodeURIComponent(id)}">${esc(label)}</a>`;
  return `<a class="wl att" href="#" data-att="${esc(id)}">📎 ${esc(label)}</a>`;
}
function cellHTML(col, v, file) {
  if (col === 'file.name' || col === 'file.basename') return linkToId(file.id, file.basename);
  if (col === 'file.size' && typeof v === 'number') return esc(v < 1024 ? v + ' B' : v < 1048576 ? (v / 1024).toFixed(1).replace('.', ',') + ' KB' : (v / 1048576).toFixed(1).replace('.', ',') + ' MB');
  return valHTML(v, file.id);
}
const SUMS = {
  average: vs => { const n = vs.map(Number).filter(x => !isNaN(x)); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null; },
  sum: vs => vs.map(Number).filter(x => !isNaN(x)).reduce((s, x) => s + x, 0),
  min: vs => vs.filter(x => !isEmptyV(x)).sort(cmpVals)[0] ?? null,
  max: vs => vs.filter(x => !isEmptyV(x)).sort(cmpVals).pop() ?? null,
  earliest: vs => SUMS.min(vs), latest: vs => SUMS.max(vs),
  range: vs => { const a = SUMS.min(vs), b = SUMS.max(vs); if (a == null) return null; const da = toDate(a), db = toDate(b); return da && db ? new BDur(db - da) : +b - +a; },
  median: vs => { const n = vs.map(Number).filter(x => !isNaN(x)).sort((x, y) => x - y); if (!n.length) return null; const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  stddev: vs => { const n = vs.map(Number).filter(x => !isNaN(x)); if (!n.length) return null; const mu = n.reduce((s, x) => s + x, 0) / n.length; return Math.sqrt(n.reduce((s, x) => s + (x - mu) ** 2, 0) / n.length); },
  checked: vs => vs.filter(x => x === true).length, unchecked: vs => vs.filter(x => x === false).length,
  empty: vs => vs.filter(isEmptyV).length, filled: vs => vs.filter(x => !isEmptyV(x)).length,
  unique: vs => new Set(vs.filter(x => !isEmptyV(x)).map(valText)).size
};
const SUM_PT = { average: 'Média', sum: 'Soma', min: 'Mínimo', max: 'Máximo', earliest: 'Mais antigo', latest: 'Mais recente', range: 'Amplitude', median: 'Mediana', stddev: 'Desvio padrão', checked: 'Marcados', unchecked: 'Desmarcados', empty: 'Vazios', filled: 'Preenchidos', unique: 'Únicos' };
function summaryHTML(name, vals, base) {
  const key = String(name).toLowerCase();
  let v, label = SUM_PT[key] || name;
  if (SUMS[key]) v = SUMS[key](vals);
  else { const src = base.summaries && getProp(base.summaries, name); v = src ? bEval(src, { values: vals, base }) : null; }
  return `<span class="muted">${esc(label)}:</span> ${esc(valText(v))}`;
}

/* ---------- Montagem de uma visão ---------- */
function baseRows(base, view, thisFile) {
  const rows = [];
  for (const [id, it] of IX.items) {
    if (it.f) continue;
    const p = pathOf(id); if (hidden(p)) continue;
    const env = { file: bfile(id), thisFile, base };
    if (!bFilter(base.filters, env) || !bFilter(view.filters, env)) continue;
    rows.push(env);
  }
  const sorts = [];
  if (Array.isArray(view.sort)) view.sort.forEach(x => x && x.property && sorts.push(x));
  if (!sorts.length) sorts.push({ property: 'file.name', direction: 'ASC' });
  rows.sort((a, b) => {
    for (const s of sorts) {
      const x = colVal(s.property, a), y = colVal(s.property, b);
      if (isEmptyV(x) !== isEmptyV(y)) return isEmptyV(x) ? 1 : -1;
      const c = cmpVals(x, y); if (c) return String(s.direction).toUpperCase() === 'DESC' ? -c : c;
    }
    return 0;
  });
  return view.limit ? rows.slice(0, +view.limit) : rows;
}
function groupRows(rows, view) {
  const gb = view.groupBy; if (!gb || !gb.property) return [[null, rows]];
  const groups = new Map();
  for (const r of rows) { const v = colVal(gb.property, r); const k = valText(v); if (!groups.has(k)) groups.set(k, { v, rows: [] }); groups.get(k).rows.push(r); }
  const list = [...groups.entries()].sort((a, b) => { if (!a[0] !== !b[0]) return a[0] ? -1 : 1; const c = cmpVals(a[1].v, b[1].v); return String(gb.direction).toUpperCase() === 'DESC' ? -c : c; });
  return list.map(([k, g]) => [k || '(vazio)', g.rows]);
}
function viewHTML(base, view, thisFile) {
  const type = String(view.type || 'table').toLowerCase();
  if (type === 'map') return '<p class="muted">Visões do tipo mapa não são exibidas no Leitor do Vault.</p>';
  let cols = Array.isArray(view.order) && view.order.length ? view.order.map(String) : ['file.name'];
  const rows = baseRows(base, view, thisFile);
  const groups = groupRows(rows, view);
  const count = `<p class="muted bcount">${rows.length.toLocaleString('pt-BR')} ${rows.length === 1 ? 'resultado' : 'resultados'}</p>`;
  if (!rows.length) return count;
  if (type === 'cards') {
    const imgCol = view.image ? String(view.image) : null;
    const rest = cols.filter(c => c !== imgCol && c !== 'file.name' && c !== 'file.basename');
    return count + groups.map(([g, rs]) => (g ? `<h3 class="bgroup">${esc(g)}</h3>` : '') + `<div class="bcards">${rs.map(r => {
      let img = '';
      if (imgCol) { const v = colVal(imgCol, r); img = cardImg(v, r.file.id); }
      return `<div class="bcard">${img}<div class="bcard-t">${linkToId(r.file.id, r.file.basename)}</div>${rest.map(c => { const h = cellHTML(c, colVal(c, r), r.file); return h ? `<div class="bcard-f"><span class="muted">${esc(colLabel(c, base))}:</span> ${h}</div>` : ''; }).join('')}</div>`;
    }).join('')}</div>`).join('');
  }
  if (type === 'list') {
    const rest = cols.filter(c => c !== 'file.name' && c !== 'file.basename');
    return count + groups.map(([g, rs]) => (g ? `<h3 class="bgroup">${esc(g)}</h3>` : '') + `<ul class="blist">${rs.map(r => `<li>${linkToId(r.file.id, r.file.basename)}${rest.map(c => { const h = cellHTML(c, colVal(c, r), r.file); return h ? ` <span class="muted">·</span> ${h}` : ''; }).join('')}</li>`).join('')}</ul>`).join('');
  }
  // tabela
  const head = `<tr>${cols.map(c => `<th>${esc(colLabel(c, base))}</th>`).join('')}</tr>`;
  const sums = view.summaries && typeof view.summaries === 'object' ? view.summaries : null;
  const body = groups.map(([g, rs]) => (g ? `<tr class="bgrow"><td colspan="${cols.length}">${esc(g)} <span class="muted">(${rs.length})</span></td></tr>` : '') +
    rs.map(r => `<tr>${cols.map(c => `<td>${cellHTML(c, colVal(c, r), r.file)}</td>`).join('')}</tr>`).join('')).join('');
  const foot = sums ? `<tr class="bsum">${cols.map(c => { const n = getProp(sums, c); return `<td>${n ? summaryHTML(n, rows.map(r => colVal(c, r)), base) : ''}</td>`; }).join('')}</tr>` : '';
  return count + `<div class="btable"><table><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
}
function cardImg(v, rowId) {
  if (Array.isArray(v)) v = v[0];
  if (v == null || v === '') return '<div class="bcard-noimg"></div>';
  if (v instanceof BLink) { const id = v.id; return id ? `<img class="bcard-img" data-img="${esc(id)}" alt="">` : ''; }
  const s = String(v).trim();
  if (/^https?:\/\//.test(s)) return `<img class="bcard-img" src="${esc(s)}" alt="">`;
  const m = /^!?\[\[([^\]]+)\]\]$/.exec(s);
  const id = resolve(parseLink(m ? m[1] : s).file, rowId);
  return id ? `<img class="bcard-img" data-img="${esc(id)}" alt="">` : '';
}

/* ---------- Pontos de entrada usados por app.js ---------- */
function parseBase(yamlText) {
  const y = jsyaml.load(String(yamlText || ''), { schema: jsyaml.CORE_SCHEMA }) || {};
  if (typeof y !== 'object') throw new Error('A base não está em YAML válido.');
  if (!Array.isArray(y.views) || !y.views.length) y.views = [{ type: 'table', name: 'Tabela', order: ['file.name'] }];
  return y;
}
// Desenha a base dentro de "box". thisId: arquivo que faz o papel de "this"; viewName: visão inicial.
function renderBaseInto(box, yamlText, thisId, viewName, opts = {}) {
  bClearCache();
  let base;
  try { base = parseBase(yamlText); } catch (e) { box.innerHTML = `<div class="err">Não foi possível ler a base: ${esc(e.message)}</div>`; return; }
  const thisFile = thisId ? bfile(thisId) : null;
  let vi = Math.max(0, base.views.findIndex(v => viewName && String(v.name || '').toLowerCase() === String(viewName).toLowerCase()));
  const draw = () => {
    const view = base.views[vi];
    const tabs = base.views.length > 1 && !opts.single ? `<select class="bview">${base.views.map((v, i) => `<option value="${i}" ${i === vi ? 'selected' : ''}>${esc(v.name || ('Visão ' + (i + 1)))}</option>`).join('')}</select>` : (view.name && opts.showName ? `<div class="muted">${esc(view.name)}</div>` : '');
    let html;
    try { html = viewHTML(base, view, thisFile); } catch (e) { html = `<div class="err">Erro ao montar a visão: ${esc(e.message)}</div>`; }
    const st = BL.pending.size ? `<p class="muted">${esc(blStatusText())} As propriedades das notas ainda não lidas não entram nos resultados.</p>` : '';
    box.innerHTML = tabs + html + st;
    const sel = box.querySelector('select.bview'); if (sel) sel.onchange = () => { vi = +sel.value; draw(); if (opts.onView) opts.onView(base.views[vi].name); };
    hydrate(box, 3);
  };
  draw();
}
