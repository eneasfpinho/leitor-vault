'use strict';
/* Leitor do Vault: calendário no mesmo formato do plugin "Calendário do mês" do Obsidian.
   Configuração igual à do plugin no vault: sistema misto (juliano até 04/10/1582) e semana começando no domingo. */

const CAL_CFG = { sistema: 'misto', inicioSemana: 0 };
const CAL_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const CAL_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const CAL_SEMANA_NOME = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const CAL_RE_NOME = /^(\d{4})(\d{2})(\d{2})(dC|aC)?$/;
const CAL_MIN = -9998, CAL_MAX = 9999;

const calDiv = (a, b) => Math.floor(a / b);
const calMod = (a, b) => ((a % b) + b) % b;
const calPad = (n, t) => String(n).padStart(t, '0');

function calJdnGreg(y, m, d) { const a = calDiv(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + calDiv(153 * mm + 2, 5) + 365 * yy + calDiv(yy, 4) - calDiv(yy, 100) + calDiv(yy, 400) - 32045; }
function calJdnJul(y, m, d) { const a = calDiv(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3; return d + calDiv(153 * mm + 2, 5) + 365 * yy + calDiv(yy, 4) - 32083; }
const calBisJul = y => calMod(y, 4) === 0;
const calBisGreg = y => (calMod(y, 4) === 0 && calMod(y, 100) !== 0) || calMod(y, 400) === 0;
const CAL_DIAS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const calUsaJuliano = (y, m) => CAL_CFG.sistema === 'misto' && (y < 1582 || (y === 1582 && m < 10));

function calDiasDoMes(y, m) {
  const lista = [];
  if (CAL_CFG.sistema === 'misto' && y === 1582 && m === 10) {
    for (let d = 1; d <= 31; d++) {
      if (d >= 5 && d <= 14) continue;
      const jdn = d <= 4 ? calJdnJul(y, m, d) : calJdnGreg(y, m, d);
      lista.push({ d, semana: calMod(jdn + 1, 7) });
    }
    return lista;
  }
  const jul = calUsaJuliano(y, m);
  const total = m === 2 && (jul ? calBisJul(y) : calBisGreg(y)) ? 29 : CAL_DIAS[m - 1];
  for (let d = 1; d <= total; d++) lista.push({ d, semana: calMod((jul ? calJdnJul(y, m, d) : calJdnGreg(y, m, d)) + 1, 7) });
  return lista;
}

function calDataDe(astro, mes, diario) {
  if (diario) return { ano: astro, mes, sufixo: '', astro };
  return astro <= 0 ? { ano: 1 - astro, mes, sufixo: 'aC', astro } : { ano: astro, mes, sufixo: 'dC', astro };
}
function calInterpretarNome(nome) {
  const r = CAL_RE_NOME.exec(nome || '');
  if (!r) return null;
  const ano = +r[1], mes = +r[2], dia = +r[3], sufixo = r[4] || '';
  return { ano, mes, dia, sufixo, astro: sufixo === 'aC' ? 1 - ano : ano };
}
function calInterpretarBusca(texto) {
  let t = texto.trim();
  if (!t) return null;
  const n = calInterpretarNome(t.replace(/\s+/g, ''));
  if (n) return n;
  let aC = false;
  const era = /\s*(a\.?\s*c\.?|d\.?\s*c\.?)$/i.exec(t);
  if (era) { aC = /^a/i.test(era[1]); t = t.slice(0, era.index).trim(); }
  const p = t.split(/[\/.\-\s]+/).filter(Boolean).map(Number);
  if (!p.length || p.some(x => !Number.isInteger(x) || x < 0)) return null;
  let dia = null, mes = 1, ano;
  if (p.length === 3) [dia, mes, ano] = p;
  else if (p.length === 2) [mes, ano] = p;
  else if (p.length === 1) [ano] = p;
  else return null;
  if (!ano || mes < 1 || mes > 12 || ano > 9999) return null;
  return { ano, mes, dia, sufixo: aC ? 'aC' : '', astro: aC ? 1 - ano : ano };
}
function calObservacao(data) {
  if (CAL_CFG.sistema === 'misto' && data.astro === 1582 && data.mes === 10) return 'transição para o calendário gregoriano';
  if (calUsaJuliano(data.astro, data.mes)) return 'calendário juliano';
  return '';
}

/* Períodos: anos (década), décadas (século), séculos (milênio), milênios */
function calIndicePeriodo(astro, tam) { return astro >= 1 ? calDiv(astro, tam) : -(calDiv(1 - astro, tam) + 1); }
function calInicioPeriodo(s, tam) { if (s >= 0) return Math.max(1, s * tam); const k = -s - 1; return 1 - (k * tam + tam - 1); }
const CAL_ROMANOS = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function calRomano(n) { let r = ''; for (const [v, l] of CAL_ROMANOS) while (n >= v) { r += l; n -= v; } return r; }
const calRotuloAno = (astro, longo) => (astro >= 1 ? String(astro) : `${1 - astro}${longo ? ' a.C.' : ' aC'}`);
function calRotuloPeriodo(s, tam, longo) {
  const aC = s < 0, k = aC ? -s - 1 : s, era = aC ? (longo ? ' a.C.' : ' aC') : '';
  return tam === 10 ? `${Math.max(1, k * 10)}${era}` : `${calRomano(k + 1)}${era}`;
}
function calTituloPeriodo(s, tam) {
  if (tam === 10) return `Década de ${calRotuloPeriodo(s, 10, true)}`;
  if (tam === 100) return `Século ${calRotuloPeriodo(s, 100, true)}`;
  return `Milênio ${calRotuloPeriodo(s, 1000, true)}`;
}

/* Ícones (Lucide) usados pelo plugin */
const CAL_ICO = {
  'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  'calendar-days': '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  'chevrons-left': '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevrons-right': '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>'
};
const calIco = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAL_ICO[n]}</svg>`;

/* Estado: ao abrir o aplicativo, o calendário está no dia de hoje, no modo diário */
const CAL = (() => { const h = new Date(); return { astro: h.getFullYear(), mes: h.getMonth() + 1, modo: 'diario', nivel: 'dias', marcado: { astro: h.getFullYear(), mes: h.getMonth() + 1, dia: h.getDate() }, seguida: null, notaAtiva: null }; })();
const calDiario = () => CAL.modo === 'diario';
function calLimitar(astro) { if (calDiario() && astro < 1) astro = 1; return Math.min(CAL_MAX, Math.max(CAL_MIN, astro)); }
function calIrPara(astro, mes) { CAL.astro = calLimitar(astro); CAL.mes = mes; CAL.nivel = 'dias'; calDesenhar(); }
function calAvancar(passo) {
  const total = CAL.astro * 12 + (CAL.mes - 1) + passo;
  const astro = calDiv(total, 12), mes = calMod(total, 12) + 1;
  if (astro !== calLimitar(astro)) { toast('Limite do calendário atingido.'); return; }
  calIrPara(astro, mes);
}
function calNivel(nivel, astro) { if (astro !== undefined) CAL.astro = calLimitar(astro); CAL.nivel = nivel; calDesenhar(); }

// Nota de data no vault (só arquivos .md)
function calNota(nome) { const a = IX.byName.get(norm(nome + '.md')); return a && a.length ? resolve(nome) : null; }

// Ao abrir o calendário depois de ler uma nota com nome de data, vai para o mês dela (como o plugin faz ao abrir a nota)
function calSeguirNota() {
  const id = CAL.notaAtiva;
  if (!id || id === CAL.seguida) return;
  CAL.seguida = id;
  const it = IX.items.get(id);
  const r = it ? calInterpretarNome(it.n.replace(/\.md$/i, '')) : null;
  if (!r || r.mes < 1 || r.mes > 12 || r.ano === 0) return;
  CAL.modo = r.sufixo === '' ? 'diario' : 'datas';
  CAL.marcado = { astro: r.astro, mes: r.mes, dia: r.dia };
  CAL.astro = calLimitar(r.astro); CAL.mes = r.mes; CAL.nivel = 'dias';
}

function viewCalendar() {
  setTitle('Calendário');
  calSeguirNota();
  view().innerHTML = `<div class="calendario-mes-visao">
    <div class="calendario-mes-ir">
      <button class="calendario-mes-modo" data-modo="diario" title="Diário (notas AAAAMMDD)" aria-label="Diário (notas AAAAMMDD)">${calIco('book-open')}</button>
      <button class="calendario-mes-modo" data-modo="datas" title="Datas (notas AAAAMMDDdC e AAAAMMDDaC)" aria-label="Datas (notas AAAAMMDDdC e AAAAMMDDaC)">${calIco('calendar-days')}</button>
      <button id="calHoje">Hoje</button>
      <input class="calendario-mes-ir-campo" id="calIr" type="text" enterkeyhint="go" placeholder="Ir para: 15/03/44 a.C." title="Aceita DD/MM/AAAA, MM/AAAA, AAAA ou AAAAMMDD, com a.C. opcional; tecle Enter">
    </div>
    <div class="calendario-mes" id="calGrade"></div>
  </div>`;
  view().querySelectorAll('.calendario-mes-modo').forEach(b => b.onclick = () => {
    CAL.modo = b.dataset.modo;
    if (CAL.modo === 'diario' && CAL.astro < 1) CAL.astro = new Date().getFullYear();
    calDesenhar();
  });
  $('#calHoje').onclick = () => { const h = new Date(); CAL.marcado = null; calIrPara(h.getFullYear(), h.getMonth() + 1); };
  $('#calIr').onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const b = calInterpretarBusca(e.target.value);
    if (!b) { toast('Data não reconhecida.'); return; }
    if (b.sufixo === 'aC' || b.sufixo === 'dC' || b.ano < 1000) CAL.modo = 'datas';
    CAL.marcado = { astro: b.astro, mes: b.mes, dia: b.dia || 1 };
    e.target.blur();
    calIrPara(b.astro, b.mes);
  };
  calDesenhar();
}

function calDesenhar() {
  const el = document.getElementById('calGrade'); if (!el) return;
  document.querySelectorAll('.calendario-mes-modo').forEach(b => b.classList.toggle('ativo', b.dataset.modo === CAL.modo));
  if (calDiario() && CAL.astro < 1) CAL.astro = new Date().getFullYear();
  if (CAL.nivel !== 'dias') { calQuadro(el); return; }
  const data = calDataDe(CAL.astro, CAL.mes, calDiario());
  const h = new Date();
  const hoje = h.getFullYear() === data.astro && h.getMonth() + 1 === data.mes ? h.getDate() : null;
  const destaque = CAL.marcado && CAL.marcado.astro === data.astro && CAL.marcado.mes === data.mes ? CAL.marcado.dia : null;
  const ini = CAL_CFG.inicioSemana;
  const clsCol = c => { const s = (ini + c) % 7; return s === 0 ? 'calendario-mes-domingo' : s === 6 ? 'calendario-mes-sabado' : ''; };
  const vazia = c => `<td class="${clsCol(c)}"></td>`;
  let head = '';
  for (let i = 0; i < 7; i++) { const s = (ini + i) % 7; head += `<th class="${clsCol(i)}" title="${CAL_SEMANA_NOME[s]}">${CAL_SEMANA[s]}</th>`; }
  let rows = '', tr = '', col = 0;
  for (const { d, semana } of calDiasDoMes(data.astro, data.mes)) {
    const c = calMod(semana - ini, 7);
    if (c < col) { for (let i = col; i < 7; i++) tr += vazia(i); rows += `<tr>${tr}</tr>`; tr = ''; col = 0; }
    while (col < c) { tr += vazia(col); col++; }
    const alvo = `${calPad(data.ano, 4)}${calPad(data.mes, 2)}${calPad(d, 2)}${data.sufixo}`;
    const id = calNota(alvo);
    const cls = [clsCol(col), d === destaque ? 'calendario-mes-hoje' : '', d === hoje ? 'calendario-mes-dia-atual' : ''].filter(Boolean).join(' ');
    tr += `<td class="${cls}">${id
      ? `<a class="calendario-mes-dia existe" href="${noteHref(id)}" title="${alvo}">${d}</a>`
      : `<a class="calendario-mes-dia nao-existe" data-falta="${alvo}" title="${alvo} (nota inexistente)">${d}</a>`}</td>`;
    col++;
  }
  for (let i = col; i < 7; i++) tr += vazia(i);
  rows += `<tr>${tr}</tr>`;
  const obs = calObservacao(data);
  el.innerHTML = `<table><caption>
      <div class="calendario-mes-nav">
        <button class="calendario-mes-seta" data-passo="-12" title="Ano anterior" aria-label="Ano anterior">${calIco('chevrons-left')}</button>
        <button class="calendario-mes-seta" data-passo="-1" title="Mês anterior" aria-label="Mês anterior">${calIco('chevron-left')}</button>
        <div class="calendario-mes-titulo"><a class="calendario-mes-link" data-nivel="meses" title="Escolher o mês">${CAL_MESES[data.mes - 1]}</a> de <a class="calendario-mes-link" data-nivel="anos" title="Escolher o ano">${calRotuloAno(CAL.astro, true)}</a></div>
        <button class="calendario-mes-seta" data-passo="1" title="Mês seguinte" aria-label="Mês seguinte">${calIco('chevron-right')}</button>
        <button class="calendario-mes-seta" data-passo="12" title="Ano seguinte" aria-label="Ano seguinte">${calIco('chevrons-right')}</button>
      </div>${obs ? `<div class="calendario-mes-obs">${obs}</div>` : ''}
    </caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll('.calendario-mes-seta').forEach(b => b.onclick = () => calAvancar(+b.dataset.passo));
  el.querySelectorAll('.calendario-mes-link').forEach(a => a.onclick = () => calNivel(a.dataset.nivel));
  el.querySelectorAll('a[data-falta]').forEach(a => a.onclick = () => toast(`A nota ${a.dataset.falta} não existe no vault.`));
}

// Quadro de escolha (meses, anos, décadas, séculos ou milênios)
function calQuadro(el) {
  const h = new Date(), anoHoje = h.getFullYear(), minimo = calDiario() ? 1 : CAL_MIN;
  let titulo, acima = null; const itens = [];
  if (CAL.nivel === 'meses') {
    titulo = calRotuloAno(CAL.astro, true); acima = 'anos';
    CAL_MESES.forEach((m, i) => itens.push({ rotulo: m.slice(0, 3), dica: m, acao: () => calIrPara(CAL.astro, i + 1), atual: i + 1 === CAL.mes, hoje: CAL.astro === anoHoje && i === h.getMonth() }));
  } else if (CAL.nivel === 'anos') {
    const s = calIndicePeriodo(CAL.astro, 10);
    titulo = calTituloPeriodo(s, 10); acima = 'decadas';
    const ini = calInicioPeriodo(s, 10), fim = calInicioPeriodo(s + 1, 10) - 1, anos = [];
    if (ini - 1 >= minimo) anos.push([ini - 1, true]);
    for (let a = ini; a <= fim; a++) if (a >= minimo) anos.push([a, false]);
    if (fim + 1 <= CAL_MAX) anos.push([fim + 1, true]);
    for (const [a, viz] of anos) itens.push({ rotulo: calRotuloAno(a, false), dica: calRotuloAno(a, true), vizinho: viz, acao: () => calNivel('meses', a), atual: a === CAL.astro, hoje: a === anoHoje });
  } else {
    const tam = CAL.nivel === 'decadas' ? 10 : CAL.nivel === 'seculos' ? 100 : 1000;
    const proximo = CAL.nivel === 'decadas' ? 'anos' : CAL.nivel === 'seculos' ? 'decadas' : 'seculos';
    const lista = [];
    if (CAL.nivel === 'milenios') {
      titulo = 'Milênios';
      for (let s = calDiario() ? 0 : -10; s <= 9; s++) lista.push([s, false]);
    } else {
      const S = calIndicePeriodo(CAL.astro, tam * 10);
      titulo = calTituloPeriodo(S, tam * 10); acima = CAL.nivel === 'decadas' ? 'seculos' : 'milenios';
      const s0 = calIndicePeriodo(calInicioPeriodo(S, tam * 10), tam), s1 = calIndicePeriodo(calInicioPeriodo(S + 1, tam * 10) - 1, tam);
      if (calInicioPeriodo(s0 - 1, tam) >= minimo) lista.push([s0 - 1, true]);
      for (let s = s0; s <= s1; s++) if (calInicioPeriodo(s + 1, tam) - 1 >= minimo) lista.push([s, false]);
      if (calInicioPeriodo(s1 + 1, tam) <= CAL_MAX) lista.push([s1 + 1, true]);
    }
    const sAtual = calIndicePeriodo(CAL.astro, tam), sHoje = calIndicePeriodo(anoHoje, tam);
    for (const [s, viz] of lista) itens.push({ rotulo: calRotuloPeriodo(s, tam, false), dica: calTituloPeriodo(s, tam), vizinho: viz, acao: () => calNivel(proximo, Math.max(minimo, calInicioPeriodo(s, tam))), atual: s === sAtual, hoje: s === sHoje });
  }
  el.innerHTML = `<div class="calendario-mes-quadro">
    <div class="calendario-mes-quadro-titulo">${acima ? `<a class="calendario-mes-link" title="Subir um nível">${esc(titulo)}</a>` : esc(titulo)}</div>
    <div class="calendario-mes-quadro-grade">${itens.map((it, i) => `<a class="calendario-mes-quadro-item${it.vizinho ? ' vizinho' : ''}${it.atual ? ' atual' : ''}${it.hoje ? ' hoje' : ''}" data-i="${i}" title="${esc(it.dica)}">${esc(it.rotulo)}</a>`).join('')}</div>
  </div>`;
  const lk = el.querySelector('.calendario-mes-quadro-titulo a'); if (lk) lk.onclick = () => calNivel(acima);
  el.querySelectorAll('.calendario-mes-quadro-item').forEach(a => a.onclick = () => itens[+a.dataset.i].acao());
}
