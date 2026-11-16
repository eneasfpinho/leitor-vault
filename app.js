'use strict';
/* Leitor do Vault: lê notas Markdown de um vault do Obsidian guardado no OneDrive. */

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.Read offline_access';
const REDIRECT = location.origin + location.pathname;
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const AUD = /\.(mp3|m4a|ogg|oga|wav|flac|webm|3gp)$/i;
const VID = /\.(mp4|mov|m4v|ogv)$/i;
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i;
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = s => String(s).normalize('NFC').toLowerCase();

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('vl_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vl_' + k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem('vl_' + k); } catch { } }
};
const clientId = () => (window.LEITOR_CLIENT_ID || '').trim() || LS.get('clientId', '');

class Redirecting extends Error { }

/* ---------- Autenticação (OAuth 2.0 com PKCE, sem bibliotecas) ---------- */
function b64url(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randStr(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }

async function login() {
  if (!clientId()) { location.hash = '#/config'; throw new Redirecting(); }
  const verifier = randStr(64), state = randStr(16);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  LS.set('pkce', { verifier, state, hash: location.hash });
  const p = new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query',
    scope: SCOPES, code_challenge: b64url(digest), code_challenge_method: 'S256', state
  });
  location.assign(AUTH + '/authorize?' + p);
  throw new Redirecting();
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  const pk = LS.get('pkce'); LS.del('pkce');
  history.replaceState(null, '', REDIRECT + ((pk && pk.hash) || ''));
  if (q.has('error')) throw new Error('Login recusado: ' + (q.get('error_description') || q.get('error')));
  if (!pk || pk.state !== q.get('state')) throw new Error('O login não pôde ser confirmado. Toque em Entrar novamente.');
  await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, code_verifier: pk.verifier });
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: clientId(), scope: SCOPES, ...params });
  const r = await fetch(AUTH + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || ('Erro ' + r.status + ' ao obter o token')); e.oauth = true; throw e; }
  const old = LS.get('tok') || {};
  LS.set('tok', { at: j.access_token, rt: j.refresh_token || old.rt, exp: Date.now() + (j.expires_in - 120) * 1000 });
}

let refreshing = null;
async function token() {
  const t = LS.get('tok');
  if (t && t.at && Date.now() < t.exp) return t.at;
  if (t && t.rt) {
    try {
      if (!refreshing) refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.rt }).finally(() => { refreshing = null; });
      await refreshing;
      return LS.get('tok').at;
    } catch (e) {
      console.warn('Falha ao renovar token', e);
      if (!e.oauth) { const x = new Error('Sem conexão com a internet.'); x.offline = true; throw x; }
    }
  }
  LS.del('tok');
  return login();
}
const loggedIn = () => !!(LS.get('tok') || {}).rt || !!(LS.get('tok') || {}).at;

/* ---------- Microsoft Graph ---------- */
async function g(path, opt = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  for (let i = 0; i < 5; i++) {
    let r;
    try { r = await fetch(url, { headers: { Authorization: 'Bearer ' + await token() } }); }
    catch (e) {
      if (e instanceof Redirecting || e.offline) throw e;
      if (i < 2 && navigator.onLine) { await sleep(1000); continue; }
      const x = new Error('Sem conexão com o OneDrive.'); x.offline = true; throw x;
    }
    if (r.status === 401 && i === 0) { const t = LS.get('tok'); if (t) { t.exp = 0; LS.set('tok', t); } continue; }
    if (r.status === 429 || r.status === 503 || r.status === 504) { await sleep((+r.headers.get('Retry-After') || 2 + i * 2) * 1000); continue; }
    if (!r.ok) {
      let m = 'Erro ' + r.status;
      try { const j = await r.json(); m = (j.error && (j.error.message || j.error.code)) || m; } catch { }
      const e = new Error(m); e.status = r.status; throw e;
    }
    return opt.text ? r.text() : r.json();
  }
  throw new Error('O OneDrive não respondeu. Tente de novo em instantes.');
}

const linkCache = new Map();
async function itemLinks(id) {
  const c = linkCache.get(id);
  if (c && Date.now() - c.t < 40 * 60e3) return c;
  const j = await g('/me/drive/items/' + encodeURIComponent(id));
  const v = { dl: j['@microsoft.graph.downloadUrl'] || j['@content.downloadUrl'], web: j.webUrl, t: Date.now() };
  linkCache.set(id, v);
  return v;
}

/* ---------- IndexedDB simples ---------- */
const idb = {
  _db: null,
  open() {
    return this._db || (this._db = new Promise((res, rej) => {
      const r = indexedDB.open('leitor-vault', 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('img')) db.createObjectStore('img');
        if (!db.objectStoreNames.contains('att')) db.createObjectStore('att');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async get(k, st = 'kv') { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction(st).objectStore(st).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v, st = 'kv') { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(st, 'readwrite'); t.objectStore(st).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  async del(k, st = 'kv') { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(st, 'readwrite'); t.objectStore(st).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  async clear(st) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(st, 'readwrite'); t.objectStore(st).clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
};

/* ---------- Cache de imagens (LRU com limite de espaço) ---------- */
const MB = 1024 * 1024;
const imgLimit = () => LS.get('imgLimitMB', 300) * MB;
const IC = {
  meta: null, // { id: [tamanho, últimoUso] }
  async load() { if (!this.meta) this.meta = (await idb.get('imgmeta').catch(() => null)) || {}; return this.meta; },
  _saveT: null,
  save() { clearTimeout(this._saveT); this._saveT = setTimeout(() => idb.set('imgmeta', this.meta).catch(() => { }), 800); },
  total() { let t = 0; for (const k in this.meta || {}) t += this.meta[k][0]; return t; },
  async get(id) {
    await this.load(); if (!this.meta[id]) return null;
    const b = await idb.get(id, 'img').catch(() => null);
    if (!b) { delete this.meta[id]; this.save(); return null; }
    this.meta[id][1] = Date.now(); this.save(); return b;
  },
  async put(id, blob) {
    await this.load();
    const lim = imgLimit(); if (!lim || blob.size > lim / 4) return;
    await idb.set(id, blob, 'img');
    this.meta[id] = [blob.size, Date.now()];
    let tot = this.total();
    if (tot > lim) {
      const old = Object.entries(this.meta).sort((a, b) => a[1][1] - b[1][1]);
      for (const [k, [sz]] of old) { if (tot <= lim * 0.9) break; if (k === id) continue; await idb.del(k, 'img').catch(() => { }); delete this.meta[k]; tot -= sz; }
    }
    this.save();
  },
  async drop(id) { await this.load(); if (this.meta[id]) { delete this.meta[id]; this.save(); await idb.del(id, 'img').catch(() => { }); } },
  async clear() { this.meta = {}; await idb.clear('img'); await idb.set('imgmeta', {}); }
};

async function loadImage(img) {
  const id = img.dataset.img;
  if (OFF.have[id] != null) { const b = await idb.get(id, 'att').catch(() => null); if (b) { img.src = URL.createObjectURL(b); return; } }
  const cached = await IC.get(id);
  if (cached) { img.src = URL.createObjectURL(cached); return; }
  const L = await itemLinks(id);
  try {
    const r = await fetch(L.dl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    img.src = URL.createObjectURL(blob);
    IC.put(id, blob).catch(e => console.warn('cache de imagem', e));
  } catch (e) {
    console.warn('download direto falhou; exibindo sem guardar', e);
    img.src = L.dl;
  }
}

/* ---------- Índice do vault ---------- */
const IX = { vaultId: null, items: new Map(), byName: new Map(), byPath: new Map(), paths: new Map(), notes: [], deltaLink: null, mode: 'delta', ready: false, t: 0 };

function pathOf(id) {
  if (IX.paths.has(id)) return IX.paths.get(id);
  const parts = []; let cur = id, guard = 0;
  while (cur && cur !== IX.vaultId && guard++ < 80) { const it = IX.items.get(cur); if (!it) break; parts.unshift(it.n); cur = it.p; }
  const p = parts.join('/'); IX.paths.set(id, p); return p;
}
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const isMd = n => /\.md$/i.test(n || '');
const hidden = p => /(^|\/)\./.test(p);

function ixRebuild() {
  IX.byName.clear(); IX.byPath.clear(); IX.paths.clear(); IX.notes = [];
  for (const [id, it] of IX.items) {
    if (it.f) continue;
    const k = norm(it.n);
    let a = IX.byName.get(k); if (!a) IX.byName.set(k, a = []); a.push(id);
    const p = pathOf(id); IX.byPath.set(norm(p), id);
    if (isMd(it.n) && !hidden(p)) IX.notes.push({ id, name: it.n.slice(0, -3), key: fold(it.n.slice(0, -3)), path: p });
  }
  IX.notes.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function ixSave() {
  await idb.set('ix:' + IX.vaultId, { items: [...IX.items].map(([id, v]) => [id, v.n, v.p, v.f ? 1 : 0]), deltaLink: IX.deltaLink, mode: IX.mode, t: Date.now() });
  IX.t = Date.now();
}

async function ixLoad() {
  IX.vaultId = LS.get('vaultId'); IX.items.clear(); IX.ready = false;
  const d = await idb.get('ix:' + IX.vaultId).catch(() => null);
  if (!d) return false;
  for (const [id, n, p, f] of d.items) IX.items.set(id, { n, p, f: !!f });
  IX.deltaLink = d.deltaLink; IX.mode = d.mode || 'delta'; IX.t = d.t || 0;
  ixRebuild(); IX.ready = true; return true;
}

async function ixDelta(progress) {
  let url = IX.deltaLink || `/me/drive/items/${encodeURIComponent(IX.vaultId)}/delta?$select=id,name,parentReference,folder,file,deleted`;
  let n = 0, changed = false;
  const incremental = !!IX.deltaLink;
  await IC.load();
  while (url) {
    let j;
    try { j = await g(url); }
    catch (e) {
      if (e.status === 410 && IX.deltaLink) { IX.deltaLink = null; IX.items.clear(); url = `/me/drive/items/${encodeURIComponent(IX.vaultId)}/delta?$select=id,name,parentReference,folder,file,deleted`; continue; }
      throw e;
    }
    for (const it of j.value || []) {
      n++;
      if (it.id === IX.vaultId) continue;
      if (incremental && IC.meta && IC.meta[it.id]) IC.drop(it.id);
      if (incremental && OFF.have[it.id] != null) OFF.stale.add(it.id);
      if (it.deleted) { if (IX.items.delete(it.id)) changed = true; continue; }
      IX.items.set(it.id, { n: it.name, p: it.parentReference && it.parentReference.id, f: !!it.folder }); changed = true;
      if (incremental && !it.folder && isMd(it.name)) BL.pending.add(it.id);
    }
    progress && progress(n);
    if (j['@odata.nextLink']) url = j['@odata.nextLink'];
    else { IX.deltaLink = j['@odata.deltaLink'] || null; url = null; }
  }
  return changed;
}

async function ixCrawl(progress) {
  const items = new Map(); const queue = [IX.vaultId]; let active = 0, n = 0;
  async function worker() {
    for (; ;) {
      if (!queue.length) { if (!active) return; await sleep(80); continue; }
      const fid = queue.shift(); active++;
      try {
        let url = `/me/drive/items/${encodeURIComponent(fid)}/children?$select=id,name,folder,file&$top=999`;
        while (url) {
          const j = await g(url);
          for (const it of j.value || []) { items.set(it.id, { n: it.name, p: fid, f: !!it.folder }); if (it.folder) queue.push(it.id); n++; }
          progress && progress(n);
          url = j['@odata.nextLink'];
        }
      } finally { active--; }
    }
  }
  await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
  IX.items = items; IX.deltaLink = null;
}

let syncing = null;
function ixSync(full) {
  if (syncing) return syncing;
  syncing = (async () => {
    const prog = n => status(`Indexando o vault… ${n.toLocaleString('pt-BR')} itens lidos`);
    status(IX.ready ? 'Verificando alterações no vault…' : 'Indexando o vault pela primeira vez…');
    try {
      if (full) { IX.items.clear(); IX.deltaLink = null; }
      if (IX.mode === 'crawl' && !full && Date.now() - IX.t < 12 * 3600e3) { status(''); return; }
      let changed;
      try { changed = await ixDelta(IX.ready ? null : prog); IX.mode = 'delta'; }
      catch (e) {
        if (e instanceof Redirecting || e.status === 401 || e.status === 403) throw e;
        console.warn('delta indisponível, usando varredura', e);
        IX.mode = 'crawl'; await ixCrawl(prog); changed = true;
      }
      if (changed || !IX.ready) { ixRebuild(); }
      await ixSave();
      const first = !IX.ready; IX.ready = true;
      if (BL.vault !== IX.vaultId) await blLoad();
      status('');
      if (changed || !IX.ready) BL.rev = null;
      if (first || changed) route();
      blSchedule();
      if (OFF.vault !== IX.vaultId) await offLoad();
      offSave(); offRun();
    } finally { syncing = null; }
  })().catch(e => { if (!(e instanceof Redirecting)) status(navigator.onLine ? 'Falha ao atualizar o índice: ' + e.message : 'Sem internet: usando o que está guardado no aparelho.'); throw e; });
  return syncing;
}

/* ---------- Resolução de links ---------- */
function resolve(target, fromId) {
  let t = String(target || '').trim().replace(/\\/g, '/');
  if (!t) return null;
  t = t.replace(/^\.\//, '').replace(/^\//, '');
  const parts = t.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  let cands = IX.byName.get(norm(last)) || [];
  if (!cands.length) cands = IX.byName.get(norm(last + '.md')) || [];
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  if (parts.length > 1) {
    const suf = norm(parts.join('/'));
    const f = cands.filter(id => { const p = norm(pathOf(id)); return p === suf || p.endsWith('/' + suf) || p === suf + '.md' || p.endsWith('/' + suf + '.md'); });
    if (f.length) cands = f;
  }
  const fromDir = fromId ? dirOf(pathOf(fromId)) : '';
  const score = id => { const p = pathOf(id); return (dirOf(p) === fromDir ? 0 : 1000) + p.split('/').length; };
  return cands.slice().sort((a, b) => score(a) - score(b))[0];
}

function resolveRelative(href, fromId) {
  let h = href.split('#')[0];
  try { h = decodeURIComponent(h); } catch { }
  if (!h) return fromId;
  const base = fromId ? dirOf(pathOf(fromId)).split('/').filter(Boolean) : [];
  const segs = h.startsWith('/') ? [] : base.slice();
  for (const s of h.split('/')) { if (!s || s === '.') continue; if (s === '..') segs.pop(); else segs.push(s); }
  const rel = norm(segs.join('/'));
  return IX.byPath.get(rel) || IX.byPath.get(rel + '.md') || IX.byPath.get(norm(h.replace(/^\//, ''))) || resolve(h, fromId);
}

function parseLink(raw) {
  let s = String(raw).replace(/\\$/, ''), alias = null, sub = null;
  const pi = s.search(/\\?\|/);
  if (pi >= 0) { alias = s.slice(pi).replace(/^\\?\|/, '').trim(); s = s.slice(0, pi); }
  const hi = s.indexOf('#');
  if (hi >= 0) { sub = s.slice(hi + 1).trim(); s = s.slice(0, hi); }
  return { file: s.trim(), sub, alias };
}

const noteHref = (id, sub) => '#/n/' + encodeURIComponent(id) + (sub ? '?h=' + encodeURIComponent(sub) : '');
const prettySub = s => s ? s.replace(/^\^/, '').split('#').join(' > ') : '';

/* ---------- Markdown (marked + extensões do Obsidian) ---------- */
let ctx = { id: null, depth: 0 };

function wikiHTML(raw) {
  const L = parseLink(raw);
  const label = L.alias || (L.file ? L.file.replace(/\.md$/i, '') + (L.sub ? ' > ' + prettySub(L.sub) : '') : prettySub(L.sub));
  const id = L.file ? resolve(L.file, ctx.id) : ctx.id;
  if (!id) return `<a class="wl missing" title="Arquivo não encontrado no vault">${esc(label)}</a>`;
  const n = (IX.items.get(id) || {}).n;
  if (isMd(n)) return `<a class="wl" href="${noteHref(id, L.sub)}">${esc(label)}</a>`;
  return `<a class="wl att" href="#" data-att="${esc(id)}">📎 ${esc(L.alias || n)}</a>`;
}

function mediaHTML(id, name, alias) {
  if (IMG.test(name)) {
    let st = '';
    if (alias && /^\d+(x\d+)?$/.test(alias)) st = ` style="width:${alias.split('x')[0]}px"`;
    const alt = alias && !st ? alias : name;
    return `<img class="embed-img" data-img="${esc(id)}" alt="${esc(alt)}"${st}>`;
  }
  if (AUD.test(name)) return `<audio controls preload="none" data-media="${esc(id)}"></audio>`;
  if (VID.test(name)) return `<video controls preload="none" playsinline data-media="${esc(id)}" style="max-width:100%"></video>`;
  return `<a class="wl att" href="#" data-att="${esc(id)}">📎 ${esc(alias || name)}</a>`;
}

function embedHTML(raw) {
  const L = parseLink(raw);
  const id = L.file ? resolve(L.file, ctx.id) : ctx.id;
  if (!id) return `<a class="wl missing" title="Arquivo não encontrado no vault">${esc(L.file || raw)}</a>`;
  const name = (IX.items.get(id) || {}).n || '';
  if (isMd(name)) {
    if (ctx.depth >= 2 || (id === ctx.id && !L.sub)) return wikiHTML(raw);
    return `<span class="transclusion" data-note="${esc(id)}" data-sub="${esc(L.sub || '')}"><a class="wl" href="${noteHref(id, L.sub)}">${esc(name.slice(0, -3))}${L.sub ? ' > ' + esc(prettySub(L.sub)) : ''}</a><span class="tc-body muted"> carregando…</span></span>`;
  }
  return mediaHTML(id, name, L.alias);
}

const isExternal = h => /^[a-z][a-z0-9+.-]*:/i.test(h);

marked.use({
  gfm: true, breaks: true,
  extensions: [
    { name: 'embed', level: 'inline', start(s) { const i = s.indexOf('![['); return i < 0 ? undefined : i; },
      tokenizer(s) { const m = /^!\[\[([^\[\]\n]+?)\]\]/.exec(s); if (m) return { type: 'embed', raw: m[0], target: m[1] }; },
      renderer(t) { return embedHTML(t.target); } },
    { name: 'wikilink', level: 'inline', start(s) { const i = s.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(s) { const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(s); if (m) return { type: 'wikilink', raw: m[0], target: m[1] }; },
      renderer(t) { return wikiHTML(t.target); } },
    { name: 'hl', level: 'inline', start(s) { const i = s.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(s) { const m = /^==(?=\S)([^=\n]*?\S)==/.exec(s); if (m) return { type: 'hl', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; },
      renderer(t) { return '<mark>' + this.parser.parseInline(t.tokens) + '</mark>'; } },
    { name: 'tag', level: 'inline', start(s) { const m = /(^|[\s(])#[\p{L}\p{N}_\-\/]*[\p{L}_\-\/]/u.exec(s); return m ? m.index + m[1].length : undefined; },
      tokenizer(s) { const m = /^#([\p{L}\p{N}_\-\/]*[\p{L}_\-\/][\p{L}\p{N}_\-\/]*)/u.exec(s); if (m) return { type: 'tag', raw: m[0], tag: m[1] }; },
      renderer(t) { return `<span class="tag">#${esc(t.tag)}</span>`; } }
  ],
  renderer: {
    link(tok) {
      const text = this.parser.parseInline(tok.tokens);
      const href = tok.href || '';
      if (isExternal(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
      if (href.startsWith('#')) return `<a class="wl" href="${noteHref(ctx.id, decodeURIComponent(href.slice(1)))}">${text}</a>`;
      const id = resolveRelative(href, ctx.id);
      if (!id) return `<a class="wl missing" title="Arquivo não encontrado no vault">${text}</a>`;
      const n = (IX.items.get(id) || {}).n;
      const sub = href.includes('#') ? decodeURIComponent(href.split('#').slice(1).join('#')) : null;
      if (isMd(n)) return `<a class="wl" href="${noteHref(id, sub)}">${text}</a>`;
      return `<a class="wl att" href="#" data-att="${esc(id)}">📎 ${text}</a>`;
    },
    image(tok) {
      const href = tok.href || '';
      if (isExternal(href)) return `<img src="${esc(href)}" alt="${esc(tok.text)}">`;
      const id = resolveRelative(href, ctx.id);
      if (!id) return `<a class="wl missing">${esc(tok.text || href)}</a>`;
      return mediaHTML(id, (IX.items.get(id) || {}).n || '', tok.text);
    }
  }
});

function splitFM(md) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  return m ? { fm: m[1], body: md.slice(m[0].length) } : { fm: null, body: md.replace(/^\uFEFF/, '') };
}

const normH = s => fold(String(s).replace(/[#*_`=\[\]]/g, '').trim()).replace(/\s+/g, ' ');

function section(md, sub) {
  if (!sub) return md;
  const lines = md.split('\n');
  if (sub.startsWith('^')) {
    const i = lines.findIndex(l => l.trimEnd().endsWith('^' + sub.slice(1)));
    return i < 0 ? md : lines[i];
  }
  const target = normH(sub.split('#').pop());
  let start = -1, lvl = 0, fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) { if (normH(m[2]) === target) { start = i; lvl = m[1].length; } }
    else if (m[1].length <= lvl) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? md : lines.slice(start).join('\n');
}

function renderMd(md, id, depth) {
  const prev = ctx; ctx = { id, depth };
  try { return marked.parse(md.replace(/%%[\s\S]*?%%/g, '')); }
  finally { ctx = prev; }
}

function fmHTML(fm, id) {
  const prev = ctx; ctx = { id, depth: 0 };
  try {
    const html = esc(fm).replace(/\[\[([^\[\]\n]+?)\]\]/g, (_, t) => wikiHTML(t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')));
    return `<details class="fm"><summary>Propriedades</summary><pre>${html}</pre></details>`;
  } finally { ctx = prev; }
}

/* Pós-processamento: callouts, legendas, ids de blocos e de títulos */
function postProcess(root) {
  root.querySelectorAll('blockquote').forEach(bq => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P' || !p.firstChild || p.firstChild.nodeType !== 3) return;
    const m = /^\s*\[!([\w-]+)\]([+-]?)[ \t]*/.exec(p.firstChild.textContent);
    if (!m) return;
    const type = m[1].toLowerCase();
    const title = document.createElement('div'); title.className = 'callout-title';
    p.firstChild.textContent = p.firstChild.textContent.slice(m[0].length);
    const head = [];
    while (p.firstChild && !(p.firstChild.nodeName === 'BR')) { head.push(p.firstChild); p.removeChild(p.firstChild); }
    if (p.firstChild && p.firstChild.nodeName === 'BR') p.removeChild(p.firstChild);
    head.forEach(n => title.appendChild(n));
    if (!title.textContent.trim()) title.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    if (!p.childNodes.length || !p.textContent.trim() && !p.querySelector('img,a,span')) p.remove();
    bq.prepend(title);
    bq.classList.add('callout', 'callout-' + type);
    if (m[2]) { if (m[2] === '-') bq.classList.add('fechado'); title.addEventListener('click', () => bq.classList.toggle('fechado')); }
  });

  // Legendas: linha logo abaixo da imagem que começa com "Legenda: "
  root.querySelectorAll('p').forEach(p => {
    const nodes = [...p.childNodes];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType !== 3 || !/^\s*Legenda:\s/.test(n.textContent)) continue;
      let k = i - 1; while (k >= 0 && nodes[k].nodeType === 3 && !nodes[k].textContent.trim()) k--;
      const isStart = k < 0 || nodes[k].nodeName === 'BR';
      if (!isStart) continue;
      let j = k - 1; while (j >= 0 && nodes[j].nodeType === 3 && !nodes[j].textContent.trim()) j--;
      const prevEl = j >= 0 ? nodes[j] : (p.previousElementSibling && p.previousElementSibling.lastElementChild);
      const prevIsImg = prevEl && prevEl.nodeType === 1 && (prevEl.matches('img') || prevEl.querySelector && prevEl.querySelector('img'));
      if (!prevIsImg && k >= 0) continue;
      const cap = document.createElement('span'); cap.className = 'legenda';
      n.textContent = n.textContent.replace(/^\s*Legenda:\s*/, '');
      p.insertBefore(cap, n);
      if (k >= 0) nodes[k].remove();
      for (let x = i; x < nodes.length; x++) cap.appendChild(nodes[x]);
      break;
    }
  });

  // Identificadores de bloco (^id) no fim de parágrafos e itens
  root.querySelectorAll('p, li').forEach(el => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let last = null, t;
    while ((t = w.nextNode())) last = t;
    if (!last) return;
    const m = /\s\^([\w-]+)\s*$/.exec(last.textContent);
    if (m) { last.textContent = last.textContent.slice(0, m.index); el.dataset.block = m[1]; }
  });
}

async function hydrate(root, depth) {
  root.querySelectorAll('img[data-img]').forEach(async img => {
    try {
      await loadImage(img);
      img.addEventListener('click', () => openAttachment(img.dataset.img));
    } catch (e) { img.alt = '⚠ ' + img.alt + ' (' + e.message + ')'; }
  });
  root.querySelectorAll('[data-media]').forEach(async m => {
    try {
      const id = m.dataset.media;
      const b = OFF.have[id] != null ? await idb.get(id, 'att').catch(() => null) : null;
      m.src = b ? URL.createObjectURL(b) : (await itemLinks(id)).dl;
    } catch { }
  });
  for (const tc of root.querySelectorAll('.transclusion[data-note]')) {
    const body = tc.querySelector('.tc-body');
    try {
      const md = splitFM(await readNote(tc.dataset.note)).body;
      const box = document.createElement('div');
      box.innerHTML = renderMd(section(md, tc.dataset.sub), tc.dataset.note, depth + 1);
      postProcess(box);
      body.replaceWith(box);
      hydrate(box, depth + 1);
    } catch (e) { body.textContent = ' (não foi possível carregar: ' + e.message + ')'; }
  }
}

async function openAttachment(id) {
  const name = (IX.items.get(id) || {}).n || '';
  if (OFF.have[id] != null) {
    const b = await idb.get(id, 'att').catch(() => null);
    if (b) {
      const u = URL.createObjectURL(b), a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 120000); return;
    }
  }
  const w = window.open('', '_blank');
  try {
    const L = await itemLinks(id);
    const url = OFFICE.test(name) && L.web ? L.web : L.dl;
    if (w) w.location.href = url; else location.href = url;
  } catch (e) { if (w) w.close(); alert('Não foi possível abrir o anexo: ' + e.message); }
}

async function readNote(id) {
  if (!navigator.onLine) {
    const c = await idb.get('note:' + id).catch(() => null);
    if (c != null) { status('Sem internet: exibindo a cópia guardada no aparelho.'); return c; }
  }
  try {
    const txt = await g('/me/drive/items/' + encodeURIComponent(id) + '/content', { text: true });
    idb.set('note:' + id, txt).catch(() => { });
    if (OFF.have[id] != null) { OFF.have[id] = txt.length; OFF.stale.delete(id); offSave(); }
    return txt;
  } catch (e) {
    if (e instanceof Redirecting) throw e;
    const c = await idb.get('note:' + id).catch(() => null);
    if (c != null) { status('Sem conexão: exibindo a última cópia salva desta nota.'); return c; }
    throw e;
  }
}

/* ---------- Backlinks ---------- */
// Para cada nota, guarda a lista de destinos dos links que ela contém ("w:" wikilink, "m:" link Markdown).
const BL = { targets: new Map(), pending: new Set(), rev: null, running: false, vault: null };

function extractLinks(txt) {
  const out = new Set();
  const t = String(txt).replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '').replace(/%%[\s\S]*?%%/g, '');
  let m;
  const re = /\[\[([^\[\]\n]+?)\]\]/g;
  while ((m = re.exec(t))) { const f = parseLink(m[1]).file; if (f) out.add('w:' + f); }
  const re2 = /\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
  while ((m = re2.exec(t))) { const h = m[1].replace(/^<|>$/g, ''); if (h && !isExternal(h) && !h.startsWith('#')) out.add('m:' + h); }
  return [...out];
}

async function blLoad() {
  BL.targets.clear(); BL.pending.clear(); BL.rev = null; BL.vault = IX.vaultId;
  const d = await idb.get('bl:' + IX.vaultId).catch(() => null);
  if (d) { for (const [id, t] of d.t || []) BL.targets.set(id, t); for (const id of d.p || []) BL.pending.add(id); }
}
let blSaveT = null;
function blSave(now) {
  clearTimeout(blSaveT);
  const doIt = () => idb.set('bl:' + BL.vault, { t: [...BL.targets], p: [...BL.pending] }).catch(() => { });
  if (now) return doIt();
  blSaveT = setTimeout(doIt, 1500);
}
function blMode() { return LS.get('blMode', 'wifi'); }
function blAllowed() {
  if (blMode() === 'off' || !navigator.onLine) return false;
  if (blMode() === 'wifi') { const c = navigator.connection; if (c && c.type && !['wifi', 'ethernet', 'unknown', 'other'].includes(c.type)) return false; }
  return true;
}
function blSchedule() {
  if (!IX.ready || BL.vault !== IX.vaultId) return;
  const live = new Set(IX.notes.map(n => n.id));
  for (const id of [...BL.targets.keys()]) if (!live.has(id)) BL.targets.delete(id);
  for (const id of [...BL.pending]) if (!live.has(id)) BL.pending.delete(id);
  for (const id of live) if (!BL.targets.has(id)) BL.pending.add(id);
  BL.rev = null; blSave(); blRun();
}
function blNoteRead(id, txt) {
  if (BL.vault !== IX.vaultId) return;
  BL.targets.set(id, extractLinks(txt)); BL.pending.delete(id); BL.rev = null; blSave();
}
async function blRun() {
  if (BL.running || !BL.pending.size || !blAllowed()) { blProgress(); return; }
  BL.running = true;
  const vault = BL.vault;
  try {
    const queue = [...BL.pending];
    let n = 0;
    const worker = async () => {
      while (queue.length && blAllowed() && BL.vault === vault) {
        const id = queue.shift();
        if (!BL.pending.has(id)) continue;
        try {
          const txt = await g('/me/drive/items/' + encodeURIComponent(id) + '/content', { text: true });
          if (BL.vault !== vault) return;
          BL.targets.set(id, extractLinks(txt)); BL.pending.delete(id); BL.rev = null;
          if (++n % 50 === 0) { blSave(); blProgress(); }
        } catch (e) {
          if (e instanceof Redirecting) throw e;
          if (e.status === 404) { BL.pending.delete(id); BL.targets.delete(id); }
          else await sleep(3000);
        }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
  } catch (e) { console.warn('backlinks', e); }
  finally { BL.running = false; blSave(true); blProgress(true); }
}
function blReverse() {
  if (BL.rev) return BL.rev;
  const rev = new Map();
  for (const [src, ts] of BL.targets) {
    if (!IX.items.has(src)) continue;
    for (const t of ts) {
      const id = t.startsWith('w:') ? resolve(t.slice(2), src) : resolveRelative(t.slice(2), src);
      if (!id || id === src) continue;
      let s = rev.get(id); if (!s) rev.set(id, s = new Set()); s.add(src);
    }
  }
  return BL.rev = rev;
}
function blStatusText() {
  const total = IX.notes.length, left = BL.pending.size;
  if (!left) return '';
  const done = Math.max(0, total - left);
  const why = blMode() === 'off' ? ' A análise está desligada em Configurações.' : !blAllowed() ? ' A análise continua quando o celular estiver no Wi-Fi.' : '';
  return `Análise das notas em andamento: ${done.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}. A lista pode estar incompleta.${why}`;
}
function blHTML(id) {
  const ids = [...(blReverse().get(id) || [])].filter(x => IX.items.has(x))
    .sort((a, b) => IX.items.get(a).n.localeCompare(IX.items.get(b).n, 'pt-BR'));
  const st = blStatusText();
  return `<h2 class="sec">Backlinks (${ids.length})</h2>${ids.length ? `<ul class="list">${ids.map(noteLi).join('')}</ul>` : '<p class="muted">Nenhuma nota do vault aponta para esta.</p>'}${st ? `<p class="muted">${esc(st)}</p>` : ''}`;
}
let blProgT = 0;
function blProgress(force) {
  const box = document.getElementById('backlinks');
  if (box && currentNote && (force || Date.now() - blProgT > 1500)) { blProgT = Date.now(); box.innerHTML = blHTML(currentNote); }
  const cfg = document.getElementById('blstatus');
  if (cfg) cfg.textContent = blStatusText() || 'Todas as notas já foram analisadas.';
}
window.addEventListener('online', () => blRun());
if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => blRun());

/* ---------- Itens disponíveis offline ---------- */
// pins: { id: { att: bool } } para notas ou pastas; have: { id: tamanho } do que está guardado.
const OFF = { pins: {}, have: {}, stale: new Set(), running: false, vault: null, again: false };
async function offLoad() {
  OFF.vault = IX.vaultId; OFF.pins = LS.get('pins:' + IX.vaultId, {});
  const d = await idb.get('off:' + IX.vaultId).catch(() => null);
  OFF.have = (d && d.have) || {}; OFF.stale = new Set((d && d.stale) || []);
}
function offSave() {
  if (!OFF.vault) return;
  LS.set('pins:' + OFF.vault, OFF.pins);
  idb.set('off:' + OFF.vault, { have: OFF.have, stale: [...OFF.stale] }).catch(() => { });
}
const offMode = () => LS.get('offMode', 'wifi');
function offAllowed() {
  if (!navigator.onLine) return false;
  if (offMode() === 'wifi') { const c = navigator.connection; if (c && c.type && !['wifi', 'ethernet', 'unknown', 'other'].includes(c.type)) return false; }
  return true;
}
const folderPrefix = fid => fid === IX.vaultId ? '' : norm(pathOf(fid)) + '/';
function offFolderPinFor(noteId) {
  const p = norm(pathOf(noteId));
  let best = null;
  for (const [id, pin] of Object.entries(OFF.pins)) {
    const it = IX.items.get(id); if (!it || !it.f) continue;
    const pre = folderPrefix(id);
    if (!pre || p.startsWith(pre)) { if (!best || (pin.att && !best.pin.att)) best = { id, pin }; }
  }
  return best;
}
function offRequired() {
  const req = new Map();
  const add = (id, att) => req.set(id, req.get(id) || att);
  for (const [id, pin] of Object.entries(OFF.pins)) {
    const it = IX.items.get(id); if (!it) continue;
    if (!it.f) { if (isMd(it.n)) add(id, !!pin.att); continue; }
    const pre = folderPrefix(id);
    for (const n of IX.notes) if (!pre || norm(n.path).startsWith(pre)) add(n.id, !!pin.att);
  }
  return req;
}
function offDeps(txt, src) {
  const embeds = new Set(), atts = new Set();
  const t = String(txt).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/%%[\s\S]*?%%/g, '');
  let m;
  const re = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
  while ((m = re.exec(t))) {
    const L = parseLink(m[2]); if (!L.file) continue;
    const id = resolve(L.file, src); if (!id || id === src) continue;
    const n = (IX.items.get(id) || {}).n;
    if (isMd(n)) { if (m[1]) embeds.add(id); } else atts.add(id);
  }
  const re2 = /\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
  while ((m = re2.exec(t))) {
    const h = m[1].replace(/^<|>$/g, ''); if (!h || isExternal(h) || h.startsWith('#')) continue;
    const id = resolveRelative(h, src); if (!id) continue;
    if (!isMd((IX.items.get(id) || {}).n)) atts.add(id);
  }
  return { embeds, atts };
}
const offOk = id => OFF.have[id] != null && !OFF.stale.has(id);
async function pool(list, fn, n = 4) {
  const q = list.slice();
  await Promise.all(Array.from({ length: n }, async () => { while (q.length && offAllowed()) { const x = q.shift(); try { await fn(x); } catch (e) { if (e instanceof Redirecting) throw e; console.warn('offline', x, e); } } }));
}
async function offFetchText(id) {
  const txt = await g('/me/drive/items/' + encodeURIComponent(id) + '/content', { text: true });
  await idb.set('note:' + id, txt);
  OFF.have[id] = txt.length; OFF.stale.delete(id); blNoteRead(id, txt);
  return txt;
}
async function offFetchBlob(id) {
  const L = await itemLinks(id);
  const r = await fetch(L.dl); if (!r.ok) throw new Error('HTTP ' + r.status);
  const b = await r.blob();
  await idb.set(id, b, 'att');
  OFF.have[id] = b.size; OFF.stale.delete(id);
}
async function offRun() {
  if (!IX.ready || OFF.vault !== IX.vaultId) return;
  if (OFF.running) { OFF.again = true; return; }
  OFF.running = true; OFF.again = false;
  try {
    const req = offRequired();
    const keep = new Set(req.keys());
    let k = 0; const tick = () => { if (++k % 20 === 0) { offSave(); offProgress(); } };
    // 1. textos das notas escolhidas
    await pool([...req.keys()].filter(id => !offOk(id)), async id => { await offFetchText(id); tick(); });
    // 2. notas incorporadas e anexos
    const embeds = new Set(), atts = new Set();
    for (const [id, att] of req) {
      const txt = await idb.get('note:' + id).catch(() => null); if (txt == null) continue;
      const d = offDeps(txt, id);
      d.embeds.forEach(e => embeds.add(e));
      if (att) d.atts.forEach(a => atts.add(a));
    }
    embeds.forEach(e => keep.add(e)); atts.forEach(a => keep.add(a));
    await pool([...embeds].filter(id => !offOk(id)), async id => { await offFetchText(id); tick(); });
    await pool([...atts].filter(id => !offOk(id)), async id => { await offFetchBlob(id); tick(); }, 3);
    // 3. libera o que não é mais necessário
    for (const id of Object.keys(OFF.have)) {
      if (keep.has(id)) continue;
      const it = IX.items.get(id);
      if (!it || !isMd(it.n)) await idb.del(id, 'att').catch(() => { });
      delete OFF.have[id]; OFF.stale.delete(id);
    }
  } catch (e) { console.warn('offline', e); }
  finally { OFF.running = false; offSave(); offProgress(); if (OFF.again) offRun(); }
}
function offSummary() {
  const req = offRequired();
  let pend = 0; for (const id of req.keys()) if (!offOk(id)) pend++;
  let bytes = 0; for (const v of Object.values(OFF.have)) bytes += v;
  return { notes: req.size, pend, bytes };
}
function offStateText(kind, id) {
  const req = offRequired();
  if (kind === 'note') {
    if (!req.has(id)) return '';
    if (offOk(id)) return '✓ Guardada no aparelho.' + (OFF.running ? ' Atualizando anexos…' : '');
  } else {
    const pre = folderPrefix(id);
    const ids = IX.notes.filter(n => !pre || norm(n.path).startsWith(pre)).map(n => n.id).filter(x => req.has(x));
    if (!ids.length) return '';
    const left = ids.filter(x => !offOk(x)).length;
    if (!left && !OFF.running) return ids.length === 1 ? '✓ 1 nota guardada no aparelho.' : `✓ ${ids.length} notas guardadas no aparelho.`;
    if (!left) return `✓ ${ids.length} notas guardadas. Atualizando anexos…`;
    if (!offAllowed()) return `${ids.length - left} de ${ids.length} notas guardadas. O restante será baixado ${navigator.onLine ? 'no Wi-Fi' : 'quando houver internet'}.`;
    return `Baixando: ${ids.length - left} de ${ids.length} notas…`;
  }
  return offAllowed() ? 'Baixando…' : `Será baixada ${navigator.onLine ? 'no Wi-Fi' : 'quando houver internet'}.`;
}
function offBarHTML(kind, id) {
  const pin = OFF.pins[id];
  const v = pin ? (pin.att ? 'att' : 'txt') : '';
  const labels = kind === 'note' ? ['Não guardar no aparelho', 'Guardar no aparelho (só o texto)', 'Guardar no aparelho com anexos'] : ['Não guardar esta pasta no aparelho', 'Guardar as notas desta pasta (só textos)', 'Guardar as notas desta pasta com anexos'];
  let inh = '';
  if (kind === 'note') { const f = offFolderPinFor(id); if (f) inh = `Já é guardada pela pasta “${esc(IX.items.get(f.id).n || 'vault')}”${f.pin.att ? ', com anexos' : ''}. `; }
  return `<div class="offbar"><select data-off="${kind}" data-id="${esc(id)}">${['', 'txt', 'att'].map((o, i) => `<option value="${o}" ${v === o ? 'selected' : ''}>📥 ${labels[i]}</option>`).join('')}</select><div class="muted offinfo">${inh}${esc(offStateText(kind, id))}</div></div>`;
}
let offProgT = 0;
function offProgress() {
  if (Date.now() - offProgT < 700 && OFF.running) return; offProgT = Date.now();
  document.querySelectorAll('select[data-off]').forEach(sel => {
    const info = sel.parentElement.querySelector('.offinfo'); if (!info) return;
    const html = offBarHTML(sel.dataset.off, sel.dataset.id);
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    info.innerHTML = tmp.querySelector('.offinfo').innerHTML;
  });
  const cfg = document.getElementById('offstatus');
  if (cfg) { const s = offSummary(); cfg.textContent = `${s.notes} ${s.notes === 1 ? 'nota escolhida' : 'notas escolhidas'}, ${(s.bytes / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB guardados${s.pend ? `, ${s.pend} ainda por baixar` : ''}.`; }
}
document.addEventListener('change', ev => {
  const sel = ev.target.closest && ev.target.closest('select[data-off]');
  if (!sel) return;
  const id = sel.dataset.id;
  if (!sel.value) delete OFF.pins[id]; else OFF.pins[id] = { att: sel.value === 'att' };
  offSave(); offProgT = 0; offProgress(); offRun();
});
window.addEventListener('online', () => offRun());
if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => offRun());

/* ---------- Interface ---------- */
const view = () => $('#view');
function status(msg) { const s = $('#status'); s.textContent = msg || ''; s.hidden = !msg; }
function setTitle(t) { $('#title').textContent = t || 'Leitor do Vault'; document.title = t ? t + ' · Leitor do Vault' : 'Leitor do Vault'; }
function showError(e) { view().innerHTML = `<div class="err">${esc(e.message || e)}</div><p><button class="btn sec" onclick="location.hash='#/'">Voltar ao início</button></p>`; }

function addRecent(id) {
  const r = LS.get('recent:' + IX.vaultId, []).filter(x => x !== id);
  r.unshift(id); LS.set('recent:' + IX.vaultId, r.slice(0, 25));
}

function noteLi(id) {
  const it = IX.items.get(id); if (!it) return '';
  const p = pathOf(id);
  return `<li><a href="${noteHref(id)}">${esc(it.n.replace(/\.md$/i, ''))}<span class="p">${esc(dirOf(p) || '/')}</span></a></li>`;
}

function search(q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const n of IX.notes) {
    if (!words.every(w => n.key.includes(w))) continue;
    out.push({ n, s: (n.key === words.join(' ') ? 0 : n.key.startsWith(words[0]) ? 1 : 2) });
  }
  out.sort((a, b) => a.s - b.s || a.n.name.length - b.n.name.length);
  return out.slice(0, 80).map(x => x.n.id);
}

function viewHome(focus) {
  setTitle(LS.get('vaultName') || 'Leitor do Vault');
  const recent = LS.get('recent:' + IX.vaultId, []).filter(id => IX.items.has(id));
  view().innerHTML = `
    <input type="search" id="q" placeholder="Nome da nota…" autocomplete="off" enterkeyhint="search">
    <ul class="list" id="res"></ul>
    <div id="home-extra">
      ${recent.length ? `<h2 class="sec">Abertas recentemente</h2><ul class="list">${recent.map(noteLi).join('')}</ul>` : ''}
      <h2 class="sec">Vault</h2>
      <ul class="list">
        <li><a href="#/pasta/${encodeURIComponent(IX.vaultId)}">📁 Navegar pelas pastas</a></li>
        <li><a href="#/config">⚙ Configurações</a></li>
      </ul>
      <p class="muted">${IX.notes.length.toLocaleString('pt-BR')} notas no índice${IX.t ? ', atualizado em ' + new Date(IX.t).toLocaleString('pt-BR') : ''}.</p>
    </div>`;
  const q = $('#q'), res = $('#res'), extra = $('#home-extra');
  const saved = sessionStorage.getItem('vl_q') || '';
  const run = () => {
    sessionStorage.setItem('vl_q', q.value);
    const ids = search(q.value);
    res.innerHTML = q.value.trim() ? (ids.length ? ids.map(noteLi).join('') : '<li class="muted" style="padding:10px 4px">Nenhuma nota com esse nome.</li>') : '';
    extra.hidden = !!q.value.trim();
  };
  q.value = saved; run();
  q.addEventListener('input', run);
  if (focus) q.focus();
}

function viewFolder(fid) {
  const it = IX.items.get(fid);
  const name = fid === IX.vaultId ? (LS.get('vaultName') || 'Vault') : (it ? it.n : 'Pasta');
  setTitle(name);
  const kids = [...IX.items].filter(([, v]) => v.p === fid && !v.n.startsWith('.'));
  const folders = kids.filter(([, v]) => v.f).sort((a, b) => a[1].n.localeCompare(b[1].n, 'pt-BR'));
  const files = kids.filter(([, v]) => !v.f).sort((a, b) => a[1].n.localeCompare(b[1].n, 'pt-BR'));
  const up = fid !== IX.vaultId && it ? `<li><a href="#/pasta/${encodeURIComponent(it.p)}">⬑ Pasta acima</a></li>` : '';
  view().innerHTML = `<div class="notepath">${esc(fid === IX.vaultId ? '/' : pathOf(fid))}</div>${offBarHTML('folder', fid)}<ul class="list">${up}
    ${folders.map(([id, v]) => `<li><a href="#/pasta/${encodeURIComponent(id)}">📁 ${esc(v.n)}</a></li>`).join('')}
    ${files.map(([id, v]) => isMd(v.n) ? `<li><a href="${noteHref(id)}">📝 ${esc(v.n.slice(0, -3))}</a></li>` : `<li><a href="#" data-att="${esc(id)}">📎 ${esc(v.n)}</a></li>`).join('')}
  </ul>${!folders.length && !files.length ? '<p class="muted">Pasta vazia.</p>' : ''}`;
}

let currentNote = null;
async function viewNote(id, sub) {
  const it = IX.items.get(id);
  if (!it) { showError(new Error('Esta nota não está no índice. Ela pode ter sido renomeada ou apagada.')); return; }
  if (currentNote === id && view().querySelector('.note')) { scrollToSub(sub); return; }
  currentNote = id;
  const title = it.n.replace(/\.md$/i, '');
  setTitle(title);
  view().innerHTML = `<p class="muted">Carregando…</p>`;
  try {
    const raw = await readNote(id);
    if (currentNote !== id) return;
    blNoteRead(id, raw);
    const { fm, body } = splitFM(raw);
    const html = renderMd(body, id, 0);
    view().innerHTML = `<div class="notepath">${esc(dirOf(pathOf(id)) || '/')}</div>${offBarHTML('note', id)}<article class="note"><h1 class="ntitle">${esc(title)}</h1>${fm ? fmHTML(fm, id) : ''}${html}</article><section id="backlinks">${blHTML(id)}</section>`;
    const art = view().querySelector('.note');
    // O nome do arquivo só vira título quando a própria nota não tem nenhum título de nível 1.
    if (art.querySelector('h1:not(.ntitle)')) art.querySelector('.ntitle').remove();
    postProcess(art);
    hydrate(art, 0);
    addRecent(id);
    scrollToSub(sub);
  } catch (e) { if (!(e instanceof Redirecting)) showError(e); }
}

function scrollToSub(sub) {
  if (!sub) { window.scrollTo(0, 0); return; }
  const art = view().querySelector('.note'); if (!art) return;
  let el = null;
  if (sub.startsWith('^')) el = art.querySelector(`[data-block="${CSS.escape(sub.slice(1))}"]`);
  else {
    const t = normH(sub.split('#').pop());
    el = [...art.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => !h.classList.contains('ntitle') && normH(h.textContent) === t);
  }
  if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); }
}

async function viewPicker(fid) {
  setTitle('Escolher a pasta do vault');
  view().innerHTML = '<p class="muted">Carregando pastas do OneDrive…</p>';
  try {
    const base = fid ? `/me/drive/items/${encodeURIComponent(fid)}` : '/me/drive/root';
    const [me, kids] = await Promise.all([g(base + '?$select=id,name,parentReference'), g(base + '/children?$select=id,name,folder&$top=999&$orderby=name')]);
    const folders = (kids.value || []).filter(x => x.folder);
    const parent = fid && me.parentReference && me.parentReference.id;
    view().innerHTML = `
      <p>Abra a pasta que é o seu vault do Obsidian (a que contém a pasta <span class="mono">.obsidian</span>) e toque no botão abaixo.</p>
      <div class="box"><b>Pasta atual:</b> ${esc(fid ? me.name : 'OneDrive (raiz)')}<br>
      <button class="btn" id="usar" ${fid ? '' : 'disabled'}>Usar esta pasta como vault</button></div>
      <ul class="list">
        ${fid ? `<li><a href="#/escolher/${/root:$/.test((me.parentReference && me.parentReference.path) || '') ? '' : encodeURIComponent(parent || '')}">⬑ Pasta acima</a></li>` : ''}
        ${folders.map(f => `<li><a href="#/escolher/${encodeURIComponent(f.id)}">${f.name === '.obsidian' ? '⚙' : '📁'} ${esc(f.name)}</a></li>`).join('')}
      </ul>`;
    const btn = $('#usar');
    if (btn) btn.onclick = async () => {
      LS.set('vaultId', me.id); LS.set('vaultName', me.name);
      IX.vaultId = me.id; IX.items.clear(); IX.ready = false; IX.deltaLink = null; IX.mode = 'delta';
      location.hash = '#/';
      const had = await ixLoad(); await blLoad(); await offLoad();
      if (!had) ixSync(true).catch(() => { }); else { route(); blSchedule(); }
    };
  } catch (e) { if (!(e instanceof Redirecting)) showError(e); }
}

function viewConfig() {
  setTitle('Configurações');
  const fixed = !!(window.LEITOR_CLIENT_ID || '').trim();
  view().innerHTML = `
    <div class="box"><b>Endereço de redirecionamento</b> (deve ser cadastrado no portal Microsoft Entra como <i>Aplicativo de página única</i>):<br><span class="mono">${esc(REDIRECT)}</span></div>
    <p><b>ID do aplicativo (cliente)</b><br>
    ${fixed ? `<span class="mono">${esc(clientId())}</span><br><span class="muted">Definido no arquivo config.js.</span>` : `<input type="text" id="cid" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(clientId())}"><button class="btn" id="salvar">Salvar</button>`}</p>
    <p><b>Conta:</b> ${loggedIn() ? 'conectada' : 'não conectada'}<br>
    ${loggedIn() ? '<button class="btn sec" id="sair">Sair da conta</button>' : '<button class="btn" id="entrar">Entrar com a conta Microsoft</button>'}</p>
    <p><b>Vault:</b> ${esc(LS.get('vaultName') || 'não escolhido')}<br>
    <button class="btn sec" id="trocar">Escolher outra pasta</button>
    ${IX.vaultId ? '<button class="btn sec" id="reindex">Refazer o índice</button>' : ''}</p>
    <p><b>Imagens guardadas no celular:</b> <span id="icuso">calculando…</span><br>
    Limite: <select id="iclim">${[0, 100, 300, 1000, 3000].map(v => `<option value="${v}" ${LS.get('imgLimitMB', 300) === v ? 'selected' : ''}>${v ? (v >= 1000 ? v / 1000 + ' GB' : v + ' MB') : 'não guardar'}</option>`).join('')}</select>
    <button class="btn sec" id="iclimpar">Apagar imagens guardadas</button></p>
    <p><b>Aparência:</b> <select id="theme">${[['auto', 'Automática (segue o celular)'], ['light', 'Tema claro'], ['dark', 'Tema escuro']].map(([v, t]) => `<option value="${v}" ${LS.get('theme', 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></p>
    <p><b>Disponível sem internet:</b> escolha as notas ou pastas no topo de cada nota ou pasta, na caixa 📥.<br><span class="muted" id="offstatus"></span><br>
    <select id="offmode">${[['wifi', 'Baixar só no Wi-Fi'], ['always', 'Baixar também nos dados móveis']].map(([v, t]) => `<option value="${v}" ${offMode() === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    ${Object.keys(OFF.pins).length ? `<ul class="list">${Object.entries(OFF.pins).filter(([id]) => IX.items.has(id)).map(([id, p]) => { const it = IX.items.get(id); const href = it.f ? '#/pasta/' + encodeURIComponent(id) : noteHref(id); return `<li><a href="${href}">${it.f ? '📁' : '📝'} ${esc(id === IX.vaultId ? 'Vault inteiro' : it.n.replace(/\.md$/i, ''))}<span class="p">${p.att ? 'com anexos' : 'só texto'}</span></a></li>`; }).join('')}</ul>` : ''}</p>
    <p><b>Backlinks:</b> para mostrar quais notas apontam para a nota aberta, o aplicativo lê uma vez todas as notas do vault e guarda só a lista de links de cada uma; depois relê apenas as notas alteradas.<br>
    <select id="blmode">${[['wifi', 'Analisar só no Wi-Fi'], ['always', 'Analisar também nos dados móveis'], ['off', 'Não analisar']].map(([v, t]) => `<option value="${v}" ${blMode() === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <button class="btn sec" id="blredo">Refazer a análise</button><br><span class="muted" id="blstatus"></span></p>
    <p class="muted">O índice guarda apenas nomes e localização dos arquivos, neste aparelho. As notas são lidas do OneDrive a cada abertura; a última versão lida fica guardada para consulta sem internet, assim como as imagens já exibidas, até o limite escolhido; quando ele é atingido, as imagens vistas há mais tempo são apagadas primeiro.</p>`;
  const s = $('#salvar'); if (s) s.onclick = () => { LS.set('clientId', $('#cid').value.trim()); location.hash = '#/'; route(); };
  const e = $('#entrar'); if (e) e.onclick = () => login().catch(() => { });
  const o = $('#sair'); if (o) o.onclick = () => { LS.del('tok'); viewConfig(); };
  $('#trocar').onclick = () => { location.hash = '#/escolher/'; };
  const showUse = async () => { await IC.load(); const n = Object.keys(IC.meta).length; $('#icuso').textContent = `${n} ${n === 1 ? 'imagem' : 'imagens'}, ${(IC.total() / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`; };
  showUse();
  $('#iclim').onchange = async ev => { LS.set('imgLimitMB', +ev.target.value); if (+ev.target.value === 0) await IC.clear(); showUse(); };
  $('#iclimpar').onclick = async () => { await IC.clear(); showUse(); };
  blProgress(); offProgT = 0; offProgress();
  $('#theme').onchange = ev => { LS.set('theme', ev.target.value); applyTheme(); };
  $('#offmode').onchange = ev => { LS.set('offMode', ev.target.value); offRun(); offProgT = 0; offProgress(); };
  $('#blmode').onchange = ev => { LS.set('blMode', ev.target.value); blRun(); blProgress(); };
  $('#blredo').onclick = () => { BL.targets.clear(); BL.rev = null; blSchedule(); blProgress(); };
  const r = $('#reindex'); if (r) r.onclick = () => { location.hash = '#/'; ixSync(true).catch(() => { }); };
}

function viewWelcome() {
  setTitle('Leitor do Vault');
  view().innerHTML = `<p>Este aplicativo lê as notas do seu vault do Obsidian diretamente do OneDrive.</p>
    <button class="btn" id="entrar">Entrar com a conta Microsoft</button>
    <p><a href="#/config">Configurações</a></p>`;
  $('#entrar').onclick = () => login().catch(() => { });
}

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'n') currentNote = null;
  try {
    if (seg[0] === 'config') return viewConfig();
    if (!clientId()) return viewConfig();
    if (!loggedIn()) return viewWelcome();
    if (seg[0] === 'escolher') return viewPicker(seg[1] ? decodeURIComponent(seg[1]) : '');
    if (!LS.get('vaultId')) { location.hash = '#/escolher/'; return; }
    if (!IX.ready) { setTitle(LS.get('vaultName')); view().innerHTML = '<p class="muted">Preparando o índice do vault. Na primeira vez isso pode levar alguns minutos em vaults grandes; nas próximas será quase instantâneo.</p>'; return; }
    if (seg[0] === 'n' && seg[1]) return viewNote(decodeURIComponent(seg[1]), params.get('h'));
    if (seg[0] === 'pasta' && seg[1]) return viewFolder(decodeURIComponent(seg[1]));
    if (seg[0] === 'buscar') return viewHome(true);
    return viewHome(false);
  } catch (e) { if (!(e instanceof Redirecting)) showError(e); }
}

document.addEventListener('click', ev => {
  const a = ev.target.closest('a[data-att]');
  if (a) { ev.preventDefault(); openAttachment(a.dataset.att); }
});
$('#btnHome').onclick = () => { sessionStorage.removeItem('vl_q'); location.hash = '#/'; if (location.hash === '#/') route(); };
$('#btnConfig').onclick = () => { location.hash = '#/config'; };
function applyTheme() {
  const t = LS.get('theme', 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
$('#btnSearch').onclick = () => { location.hash = '#/buscar'; route(); };
window.addEventListener('hashchange', route);

(async function start() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  try { await handleRedirect(); }
  catch (e) { view().innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  if (clientId() && loggedIn() && LS.get('vaultId')) {
    const had = await ixLoad();
    await blLoad(); await offLoad();
    route();
    if (had) { blSchedule(); offRun(); }
    ixSync(!had).catch(() => { });
  } else route();
})();
