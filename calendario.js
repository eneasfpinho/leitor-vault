'use strict';
/* Calendário do mês: reprodução, no Leitor do Vault, do plugin "calendario-mes" do vault (Enéas Fonsêca Pinho).
   Notas de diário AAAAMMDD, datas de calendário AAAAMMDDdC/AAAAMMDDaC, sistema juliano/gregoriano,
   navegação por meses, anos, décadas, séculos e milênios, campo "Ir para" e bloco ```calendario-mes``` nas notas.
   Usa funções de app.js (IX, resolve, noteHref, toast, LS, idb, g...) apenas na hora do uso. */
window.CalMes = (() => {
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  const SEMANA_NOME = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const RE_NOME = /^(\d{4})(\d{2})(\d{2})(dC|aC)?$/;
  const PADRAO = { sistema: 'misto', inicioSemana: 0, visaoModo: 'diario' };
  let cfg = Object.assign({}, PADRAO);

  /* ---------- Aritmética de calendário (ano astronômico: 1 a.C. = 0) ---------- */
  const div = (a, b) => Math.floor(a / b);
  const mod = (a, b) => ((a % b) + b) % b;
  function jdnGregoriano(y, m, d) { const a = div(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + div(153 * mm + 2, 5) + 365 * yy + div(yy, 4) - div(yy, 100) + div(yy, 400) - 32045; }
  function jdnJuliano(y, m, d) { const a = div(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + div(153 * mm + 2, 5) + 365 * yy + div(yy, 4) - 32083; }
  const bissextoJuliano = y => mod(y, 4) === 0;
  const bissextoGregoriano = y => (mod(y, 4) === 0 && mod(y, 100) !== 0) || mod(y, 400) === 0;
  const DIAS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const usaJuliano = (s, y, m) => s === 'misto' && (y < 1582 || (y === 1582 && m < 10));
  function diasDoMes(s, y, m) {
    const lista = [];
    if (s === 'misto' && y === 1582 && m === 10) {
      for (let d = 1; d <= 31; d++) { if (d >= 5 && d <= 14) continue; const j = d <= 4 ? jdnJuliano(y, m, d) : jdnGregoriano(y, m, d); lista.push({ d, semana: mod(j + 1, 7) }); }
      return lista;
    }
    const jul = usaJuliano(s, y, m), bis = jul ? bissextoJuliano(y) : bissextoGregoriano(y);
    const total = m === 2 && bis ? 29 : DIAS[m - 1];
    for (let d = 1; d <= total; d++) { const j = jul ? jdnJuliano(y, m, d) : jdnGregoriano(y, m, d); lista.push({ d, semana: mod(j + 1, 7) }); }
    return lista;
  }
  const dataDe = (astro, mes, dia, diario) => diario ? { ano: astro, mes, dia, sufixo: '', astro } : (astro <= 0 ? { ano: 1 - astro, mes, dia, sufixo: 'aC', astro } : { ano: astro, mes, dia, sufixo: 'dC', astro });
  function interpretarNome(nome) { const r = RE_NOME.exec(nome); if (!r) return null; const ano = +r[1], mes = +r[2], dia = +r[3], sufixo = r[4] || ''; return { ano, mes, dia, sufixo, astro: sufixo === 'aC' ? 1 - ano : ano }; }
  function validar(data) {
    if (data.mes < 1 || data.mes > 12) return 'mês inexistente';
    if (data.ano === 0) return 'não existe o ano zero';
    if (data.sufixo === '' && data.ano < 1000) return 'ano inválido para nota de diário';
    if (!diasDoMes(cfg.sistema, data.astro, data.mes).some(x => x.d === data.dia)) return 'dia inexistente neste mês';
    return null;
  }
  function interpretarBusca(texto) {
    let t = texto.trim(); if (!t) return null;
    const n = interpretarNome(t.replace(/\s+/g, '')); if (n) return n;
    let aC = false;
    const era = /\s*(a\.?\s*c\.?|d\.?\s*c\.?)$/i.exec(t);
    if (era) { aC = /^a/i.test(era[1]); t = t.slice(0, era.index).trim(); }
    const p = t.split(/[\/.\-\s]+/).filter(Boolean).map(Number);
    if (!p.length || p.some(x => !Number.isInteger(x) || x < 0)) return null;
    let dia = null, mes = 1, ano;
    if (p.length === 3) [dia, mes, ano] = p; else if (p.length === 2) [mes, ano] = p; else if (p.length === 1) [ano] = p; else return null;
    if (!ano || mes < 1 || mes > 12 || ano > 9999) return null;
    return { ano, mes, dia, sufixo: aC ? 'aC' : '', astro: aC ? 1 - ano : ano, aC };
  }
  const p0 = (n, t) => String(n).padStart(t, '0');
  const nomeDoDia = (data, d) => `${p0(data.ano, 4)}${p0(data.mes, 2)}${p0(d, 2)}${data.sufixo}`;
  const tituloDoMes = data => `${MESES[data.mes - 1]} de ${data.ano}${data.sufixo === 'aC' ? ' a.C.' : ''}`;
  function observacao(data) {
    if (cfg.sistema === 'misto' && data.astro === 1582 && data.mes === 10) return 'transição para o calendário gregoriano';
    if (usaJuliano(cfg.sistema, data.astro, data.mes)) return 'calendário juliano';
    return '';
  }

  /* ---------- Períodos ---------- */
  const indicePeriodo = (astro, tam) => astro >= 1 ? div(astro, tam) : -(div(1 - astro, tam) + 1);
  function inicioPeriodo(s, tam) { if (s >= 0) return Math.max(1, s * tam); const k = -s - 1; return 1 - (k * tam + tam - 1); }
  const ROMANOS = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  function romano(n) { let r = ''; for (const [v, l] of ROMANOS) while (n >= v) { r += l; n -= v; } return r; }
  const rotuloAno = (astro, longo) => astro >= 1 ? String(astro) : `${1 - astro}${longo ? ' a.C.' : ' aC'}`;
  function rotuloPeriodo(s, tam, longo) { const aC = s < 0, k = aC ? -s - 1 : s; const era = aC ? (longo ? ' a.C.' : ' aC') : ''; if (tam === 10) return `${Math.max(1, k * 10)}${era}`; return `${romano(k + 1)}${era}`; }
  function tituloPeriodo(s, tam) { if (tam === 10) return `Década de ${rotuloPeriodo(s, 10, true)}`; if (tam === 100) return `Século ${rotuloPeriodo(s, 100, true)}`; return `Milênio ${rotuloPeriodo(s, 1000, true)}`; }
  const ASTRO_MIN = -9998, ASTRO_MAX = 9999;
  function romanoParaNumero(r) { const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let t = 0; for (let i = 0; i < r.length; i++) { const a = v[r[i]], b = v[r[i + 1]] || 0; t += a < b ? -a : a; } return romano(t) === r ? t : 0; }
  function interpretarPeriodo(nome) {
    const n = nome.trim(); let m, aC, primeiro, mes = 1;
    if ((m = /^(\d{4})(\d{2})(dC|aC)$/.exec(n))) { aC = m[3] === 'aC'; primeiro = +m[1]; mes = +m[2]; if (mes < 1 || mes > 12) return null; }
    else if ((m = /^(\d{1,4})(dC|aC)$/.exec(n))) { aC = m[2] === 'aC'; primeiro = +m[1]; }
    else if ((m = /^Anos (\d{1,4})\s?(dC|aC)?$/i.exec(n))) { aC = m[2] === 'aC'; const k = div(+m[1], 10); primeiro = aC ? k * 10 + 9 : Math.max(1, k * 10); }
    else if ((m = /^S[ée]culo ([IVXLCDM]+)\s?(dC|aC)?$/.exec(n))) { aC = m[2] === 'aC'; const r = romanoParaNumero(m[1]); if (!r) return null; primeiro = aC ? r * 100 - 1 : Math.max(1, (r - 1) * 100); }
    else if ((m = /^([IVXLCDM]+) Mil[êe]nio\s?(dC|aC)?$/.exec(n))) { aC = m[2] === 'aC'; const r = romanoParaNumero(m[1]); if (!r) return null; primeiro = aC ? r * 1000 - 1 : Math.max(1, (r - 1) * 1000); }
    else return null;
    if (primeiro < 1) return null;
    const astro = aC ? 1 - primeiro : primeiro;
    if (astro < ASTRO_MIN || astro > ASTRO_MAX) return null;
    return { astro, mes };
  }

  /* ---------- Configuração: lida do data.json do plugin no vault ---------- */
  let cfgLida = false;
  async function carregarConfig() {
    const salva = await idb.get('calmes:' + IX.vaultId).catch(() => null);
    if (salva) cfg = Object.assign({}, PADRAO, salva);
    if (cfgLida || !navigator.onLine) return;
    try {
      const dir = childByName(IX.vaultId, '.obsidian'), pl = dir && childByName(dir, 'plugins');
      const pasta = pl && childByName(pl, 'calendario-mes'), arq = pasta && childByName(pasta, 'data.json');
      if (arq) {
        const j = JSON.parse(await g('/me/drive/items/' + encodeURIComponent(arq) + '/content', { text: true }));
        cfg = Object.assign({}, PADRAO, { sistema: j.sistema || 'misto', inicioSemana: +j.inicioSemana || 0, visaoModo: j.visaoModo || 'diario' });
        idb.set('calmes:' + IX.vaultId, cfg).catch(() => { });
      }
      cfgLida = true;
    } catch (e) { if (e instanceof Redirecting) throw e; }
  }

  /* ---------- Nota existente e abertura ---------- */
  const notaDe = alvo => { const a = IX.byName.get(norm(alvo + '.md')) || []; return a[0] || null; };
  function abrir(alvo) {
    const id = notaDe(alvo);
    if (id) { location.hash = noteHref(id); return; }
    toast(`A nota ${alvo} não existe. Para criá-la, use o calendário no Obsidian do computador.`);
  }

  /* ---------- Grade do mês ---------- */
  function grade(data, opcoes) {
    const ini = cfg.inicioSemana;
    const dias = diasDoMes(cfg.sistema, data.astro, data.mes);
    const clsCol = c => { const s = (ini + c) % 7; return s === 0 ? 'cm-dom' : s === 6 ? 'cm-sab' : ''; };
    let h = '<thead><tr>';
    for (let i = 0; i < 7; i++) { const s = (ini + i) % 7; h += `<th class="${clsCol(i)}" title="${SEMANA_NOME[s]}">${SEMANA[s]}</th>`; }
    h += '</tr></thead><tbody><tr>';
    let col = 0;
    const vazia = c => `<td class="${clsCol(c)}"></td>`;
    for (const { d, semana } of dias) {
      const c = mod(semana - ini, 7);
      if (c < col) { for (let i = col; i < 7; i++) h += vazia(i); h += '</tr><tr>'; col = 0; }
      while (col < c) { h += vazia(col); col++; }
      const alvo = nomeDoDia(data, d), existe = !!notaDe(alvo);
      const cls = [clsCol(col), d === opcoes.destaque ? 'cm-marcado' : '', d === opcoes.hoje ? 'cm-hoje' : ''].join(' ');
      h += `<td class="${cls}"><a class="cm-dia ${existe ? 'existe' : 'nao-existe'}" data-alvo="${alvo}" title="${existe ? alvo : alvo + ' (não existe)'}">${d}</a></td>`;
      col++;
    }
    for (let i = col; i < 7; i++) h += vazia(i);
    return h + '</tr></tbody>';
  }
  function ligarDias(el) { el.querySelectorAll('a.cm-dia').forEach(a => a.onclick = e => { e.preventDefault(); abrir(a.dataset.alvo); }); }

  /* ---------- Bloco ```calendario-mes``` dentro da nota ---------- */
  async function renderBloco(el, noteId) {
    await carregarConfig().catch(() => { });
    const it = IX.items.get(noteId);
    const nome = it ? it.n.replace(/\.md$/i, '') : '';
    const data = interpretarNome(nome);
    if (!data) { el.innerHTML = `<div class="cm-erro">Calendário: o nome "${esc(nome)}" não está nos formatos AAAAMMDD, AAAAMMDDdC ou AAAAMMDDaC.</div>`; return; }
    const erro = validar(data);
    if (erro && erro !== 'dia inexistente neste mês') { el.innerHTML = `<div class="cm-erro">Calendário: data inválida (${erro}).</div>`; return; }
    let obs = observacao(data);
    if (erro) obs = (obs ? obs + '; ' : '') + `o dia ${data.dia} não existe neste mês`;
    el.className = 'calendario-mes cm-bloco';
    el.innerHTML = `<table><caption><span class="cm-titulo">${tituloDoMes(data)}</span>${obs ? `<div class="cm-obs">${obs}</div>` : ''}</caption>${grade(data, { destaque: data.dia, hoje: null })}</table>`;
    ligarDias(el);
  }

  /* ---------- Visão completa (equivalente à barra lateral) ---------- */
  const h0 = new Date();
  const V = { astro: h0.getFullYear(), mes: h0.getMonth() + 1, nivel: 'dias', marcado: { astro: h0.getFullYear(), mes: h0.getMonth() + 1, dia: h0.getDate() }, seguida: null };
  const modo = () => LS.get('calModo', null) || cfg.visaoModo || 'diario';
  const diario = () => modo() === 'diario';
  const limitar = a => Math.min(ASTRO_MAX, Math.max(ASTRO_MIN, diario() && a < 1 ? 1 : a));
  let caixa = null;

  function irPara(astro, mes) { V.astro = limitar(astro); V.mes = mes; V.nivel = 'dias'; desenhar(); }
  function avancarMeses(passo) {
    const total = V.astro * 12 + (V.mes - 1) + passo, astro = div(total, 12), mes = mod(total, 12) + 1;
    if (astro !== limitar(astro)) { toast('Calendário: limite do calendário atingido.'); return; }
    irPara(astro, mes);
  }
  // Ao voltar de uma nota com nome de data (ou de período), o calendário mostra o mês dela
  function seguirNota(nome) {
    if (!nome || nome === V.seguida) return;
    V.seguida = nome;
    const r = interpretarNome(nome);
    if (r && r.mes >= 1 && r.mes <= 12 && r.ano !== 0) { LS.set('calModo', r.sufixo === '' ? 'diario' : 'datas'); V.marcado = { astro: r.astro, mes: r.mes, dia: r.dia }; V.astro = r.astro; V.mes = r.mes; V.nivel = 'dias'; return; }
    const p = interpretarPeriodo(nome);
    if (p) { LS.set('calModo', 'datas'); V.marcado = { astro: p.astro, mes: p.mes, dia: 1 }; V.astro = p.astro; V.mes = p.mes; V.nivel = 'dias'; }
  }

  function desenhar() {
    if (!caixa) return;
    if (diario() && V.astro < 1) V.astro = new Date().getFullYear();
    const barra = `<div class="cm-ir">
      <button class="cm-modo ${diario() ? 'ativo' : ''}" data-modo="diario" title="Diário (notas AAAAMMDD)">📖</button>
      <button class="cm-modo ${!diario() ? 'ativo' : ''}" data-modo="datas" title="Datas (notas AAAAMMDDdC e AAAAMMDDaC)">🗓</button>
      <button class="cm-hojebtn">Hoje</button>
      <input class="cm-campo" type="text" enterkeyhint="go" placeholder="Ir para: 15/03/44 a.C." title="DD/MM/AAAA, MM/AAAA, AAAA ou AAAAMMDD, com a.C. opcional">
    </div>`;
    caixa.innerHTML = barra + `<div class="calendario-mes cm-visao">${V.nivel === 'dias' ? gradeVisao() : quadro()}</div>`;
    caixa.querySelectorAll('.cm-modo').forEach(b => b.onclick = () => { LS.set('calModo', b.dataset.modo); if (b.dataset.modo === 'diario' && V.astro < 1) V.astro = new Date().getFullYear(); desenhar(); });
    caixa.querySelector('.cm-hojebtn').onclick = () => { const h = new Date(); LS.set('calModo', 'diario'); V.marcado = { astro: h.getFullYear(), mes: h.getMonth() + 1, dia: h.getDate() }; irPara(h.getFullYear(), h.getMonth() + 1); };
    const campo = caixa.querySelector('.cm-campo');
    campo.onkeydown = e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const b = interpretarBusca(campo.value);
      if (!b) { toast('Calendário: data não reconhecida.'); return; }
      if (b.sufixo === 'aC' || b.sufixo === 'dC' || b.ano < 1000) LS.set('calModo', 'datas');
      V.marcado = { astro: b.astro, mes: b.mes, dia: b.dia || 1 };
      irPara(b.astro, b.mes);
    };
    caixa.querySelectorAll('[data-passo]').forEach(b => b.onclick = () => avancarMeses(+b.dataset.passo));
    caixa.querySelectorAll('[data-nivel]').forEach(b => b.onclick = () => { if (b.dataset.astro) V.astro = limitar(+b.dataset.astro); V.nivel = b.dataset.nivel; desenhar(); });
    caixa.querySelectorAll('[data-ir]').forEach(b => b.onclick = () => irPara(V.astro, +b.dataset.ir));
    ligarDias(caixa);
    // deslize lateral troca de mês
    const tab = caixa.querySelector('table.cm-tab');
    if (tab) {
      let x0 = null;
      tab.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
      tab.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) avancarMeses(dx < 0 ? 1 : -1); });
    }
  }
  function gradeVisao() {
    const data = dataDe(V.astro, V.mes, null, diario());
    const obs = observacao(data);
    const h = new Date();
    const hoje = h.getFullYear() === data.astro && h.getMonth() + 1 === data.mes ? h.getDate() : null;
    const destaque = V.marcado && V.marcado.astro === data.astro && V.marcado.mes === data.mes ? V.marcado.dia : null;
    return `<table class="cm-tab"><caption><div class="cm-nav">
        <button class="cm-seta" data-passo="-12" title="Ano anterior">«</button><button class="cm-seta" data-passo="-1" title="Mês anterior">‹</button>
        <div class="cm-titulo"><a class="cm-link" data-nivel="meses" title="Escolher o mês">${MESES[data.mes - 1]}</a> de <a class="cm-link" data-nivel="anos" title="Escolher o ano">${rotuloAno(V.astro, true)}</a></div>
        <button class="cm-seta" data-passo="1" title="Mês seguinte">›</button><button class="cm-seta" data-passo="12" title="Ano seguinte">»</button>
      </div>${obs ? `<div class="cm-obs">${obs}</div>` : ''}</caption>${grade(data, { destaque, hoje })}</table>`;
  }
  function quadro() {
    const h = new Date(), anoHoje = h.getFullYear(), minimo = diario() ? 1 : ASTRO_MIN;
    let titulo, acima = null; const itens = [];
    if (V.nivel === 'meses') {
      titulo = rotuloAno(V.astro, true); acima = 'anos';
      MESES.forEach((m, i) => itens.push({ rotulo: m.slice(0, 3), dica: m, attr: `data-ir="${i + 1}"`, atual: i + 1 === V.mes, hoje: V.astro === anoHoje && i === h.getMonth() }));
    } else if (V.nivel === 'anos') {
      const s = indicePeriodo(V.astro, 10); titulo = tituloPeriodo(s, 10); acima = 'decadas';
      const ini = inicioPeriodo(s, 10), fim = inicioPeriodo(s + 1, 10) - 1, anos = [];
      if (ini - 1 >= minimo) anos.push([ini - 1, true]);
      for (let a = ini; a <= fim; a++) if (a >= minimo) anos.push([a, false]);
      if (fim + 1 <= ASTRO_MAX) anos.push([fim + 1, true]);
      for (const [a, viz] of anos) itens.push({ rotulo: rotuloAno(a, false), dica: rotuloAno(a, true), vizinho: viz, attr: `data-nivel="meses" data-astro="${a}"`, atual: a === V.astro, hoje: a === anoHoje });
    } else {
      const tam = V.nivel === 'decadas' ? 10 : V.nivel === 'seculos' ? 100 : 1000;
      const proximo = V.nivel === 'decadas' ? 'anos' : V.nivel === 'seculos' ? 'decadas' : 'seculos';
      let lista = [];
      if (V.nivel === 'milenios') { titulo = 'Milênios'; for (let s = diario() ? 0 : -10; s <= 9; s++) lista.push([s, false]); }
      else {
        const S = indicePeriodo(V.astro, tam * 10); titulo = tituloPeriodo(S, tam * 10); acima = V.nivel === 'decadas' ? 'seculos' : 'milenios';
        const s0 = indicePeriodo(inicioPeriodo(S, tam * 10), tam), s1 = indicePeriodo(inicioPeriodo(S + 1, tam * 10) - 1, tam);
        if (inicioPeriodo(s0 - 1, tam) >= minimo) lista.push([s0 - 1, true]);
        for (let s = s0; s <= s1; s++) if (inicioPeriodo(s + 1, tam) - 1 >= minimo) lista.push([s, false]);
        if (inicioPeriodo(s1 + 1, tam) <= ASTRO_MAX) lista.push([s1 + 1, true]);
      }
      const sAtual = indicePeriodo(V.astro, tam), sHoje = indicePeriodo(anoHoje, tam);
      for (const [s, viz] of lista) itens.push({ rotulo: rotuloPeriodo(s, tam, false), dica: tituloPeriodo(s, tam), vizinho: viz, attr: `data-nivel="${proximo}" data-astro="${Math.max(minimo, inicioPeriodo(s, tam))}"`, atual: s === sAtual, hoje: s === sHoje });
    }
    const cab = acima ? `<a class="cm-link" data-nivel="${acima}" title="Subir um nível">${titulo}</a>` : titulo;
    return `<div class="cm-quadro"><div class="cm-quadro-titulo">${cab}</div><div class="cm-quadro-grade">${itens.map(it => `<a class="cm-item ${it.vizinho ? 'vizinho' : ''} ${it.atual ? 'atual' : ''} ${it.hoje ? 'hoje' : ''}" ${it.attr} title="${it.dica}">${it.rotulo}</a>`).join('')}</div></div>`;
  }
  async function renderVisao(box, ultimaNota) {
    caixa = box;
    seguirNota(ultimaNota);
    desenhar();
    await carregarConfig().catch(() => { });
    if (caixa === box) desenhar();
  }

  return { renderVisao, renderBloco, interpretarNome, interpretarPeriodo, diasDoMes, interpretarBusca };
})();
