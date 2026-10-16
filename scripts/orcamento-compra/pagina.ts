// scripts/orcamento-compra/pagina.ts
// resultado.json → index.html (página de decisão do backtest do orçamento de compra).
// Uso: bun scripts/orcamento-compra/pagina.ts <resultado.json> <index.html>
// Ausente ≠ zero: todo número null/undefined vira "—", nunca 0.
import { readFileSync, writeFileSync } from 'node:fs';
import type { backtest } from './simular';

export type Resultado = ReturnType<typeof backtest>;

/** Premissas da leitura que não estão no PREMISSAS do simulador (decisão do controlador, Task 8). */
export const PREMISSAS_EXTRAS: string[] = [
  'semana agregada que atravessa o ciclo perde entradas (conservador)',
  'cortes sem score (revisão humana) entram na quantidade removida do replay do SKU (conservador), mas ficam fora do valor cortado e da precisão (R48)',
];

const AUSENTE = '—';
const finito = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export const brl = (v: number | null | undefined): string =>
  finito(v) ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : AUSENTE;
export const pct = (v: number | null | undefined): string =>
  finito(v) ? `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : AUSENTE;
export const num = (v: number | null | undefined, casas = 0): string =>
  finito(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) : AUSENTE;
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

type Ciclo = Resultado['ciclos'][number];

/** Contagem de ciclos indeterminados por camada ausente (um ciclo pode faltar em mais de uma). */
export function indeterminadosPorCamada(ciclos: Ciclo[]): [string, number][] {
  const m = new Map<string, number>();
  for (const c of ciclos) {
    if (c.estado.tipo !== 'indeterminado') continue;
    for (const camada of c.estado.camadas) m.set(camada, (m.get(camada) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function kpi(rotulo: string, valor: string, nota = ''): string {
  return `<div class="kpi"><span class="rot">${esc(rotulo)}</span><b>${valor}</b>${nota ? `<span class="nota">${nota}</span>` : ''}</div>`;
}

function rotuloEstado(c: Ciclo): string {
  const e = c.estado;
  if (e.tipo === 'indeterminado') return `indeterminado <span class="nota">(${esc(e.camadas.join(', '))})</span>`;
  if (e.tipo === 'inviavel') return `<span class="ruim">inviável</span> <span class="nota">desde ${esc(e.primeiraViolacao)}</span>`;
  return 'viável';
}

/**
 * Critérios do portão da v2 (R31 + R36). "Explicar" inviáveis não abre o portão — só decisão do founder sobre
 * o cenário-guarda. Indeterminado também fecha: ausência de ciclo inviável não comprova viabilidade.
 */
export const PORTAO = { precisaoMin: 0.95, nMin: 30, coberturaMin: 0.5, inviaveisMax: 0, indeterminadosMax: 0 } as const;

/** Portão da v2 derivado do resultado: aberto só se todos os critérios passam; senão a lista dos que falharam. */
export function avaliarPortao(r: Resultado): { aberto: boolean; motivos: string[] } {
  const pe = r.resumo.precisaoEpisodios;
  const cob = r.resumo.coberturaEpisodios;
  const inviaveis = r.ciclos.filter((c) => c.estado.tipo === 'inviavel').length;
  const indeterminados = r.ciclos.filter((c) => c.estado.tipo === 'indeterminado').length;
  const motivos: string[] = [];
  // R47: todo critério é fail-closed — undefined/NaN (resultado.json antigo) nunca passa
  if (!finito(pe?.precisao) || pe.precisao < PORTAO.precisaoMin) motivos.push(`precisão por episódio ${pct(pe?.precisao)} < ${pct(PORTAO.precisaoMin)}`);
  if (!finito(pe?.n) || pe.n < PORTAO.nMin) motivos.push(`${num(pe?.n)} episódios classificados < ${num(PORTAO.nMin)}`);
  if (!finito(cob) || cob < PORTAO.coberturaMin) motivos.push(`cobertura insuficiente: ${pct(cob)} dos episódios classificados (mínimo ${pct(PORTAO.coberturaMin)})`);
  if (inviaveis > PORTAO.inviaveisMax) motivos.push(`${num(inviaveis)} ciclos inviáveis (exige ${num(PORTAO.inviaveisMax)})`);
  if (indeterminados > PORTAO.indeterminadosMax) motivos.push(`${num(indeterminados)} ciclos indeterminados (exige ${num(PORTAO.indeterminadosMax)})`);
  // R55: evidência positiva — abre só com ≥1 ciclo e todos de estado conhecido (ausência de ruim ≠ bom)
  const desconhecidos = r.ciclos.filter((c) => !['viavel', 'inviavel', 'indeterminado'].includes(c.estado?.tipo)).length;
  if (r.ciclos.length === 0) motivos.push('nenhum ciclo simulado');
  if (desconhecidos > 0) motivos.push(`${num(desconhecidos)} ciclos com estado desconhecido`);
  return { aberto: motivos.length === 0, motivos };
}

function secaoPortao(r: Resultado): string {
  const { aberto, motivos } = avaliarPortao(r);
  const lista = motivos.length ? `<ul>${motivos.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
  return `<h2>Portão da v2</h2>
<p>Abre só com precisão por episódio ≥ ${pct(PORTAO.precisaoMin)}, ≥ ${num(PORTAO.nMin)} episódios classificados, cobertura ≥ ${pct(PORTAO.coberturaMin)}, ${num(PORTAO.inviaveisMax)} ciclos inviáveis e ${num(PORTAO.indeterminadosMax)} ciclos indeterminados. Inviáveis “explicados” não abrem o portão; só a decisão do founder sobre o cenário-guarda muda esse critério. Indeterminado também fecha: sem veredito de caixa não há prova de viabilidade.</p>
<p><b class="${aberto ? '' : 'ruim'}">Nesta rodada: ${aberto ? 'ABERTO' : 'FECHADO'}</b>${aberto ? '.' : ', porque:'}</p>${lista}`;
}

/**
 * "O que o backtest diz sobre o cenário-guarda" — só existe com ciclo inviável. Contagens vêm do resultado;
 * o exemplo por camada é o diagnóstico R29, num bloco datado e não recalculado.
 */
export function secaoCenarioGuarda(r: Resultado): string {
  const inv = r.ciclos.filter((c) => c.estado.tipo === 'inviavel');
  if (inv.length === 0) return '';
  const disp = r.ciclos.filter((c) => c.status === 'disparado');
  const invDisp = disp.filter((c) => c.estado.tipo === 'inviavel');
  const datas = inv.map((c) => c.data).sort();
  const faixa = `${esc(datas[0])} a ${esc(datas[datas.length - 1])}`;
  const motorInv = invDisp.reduce((s, c) => s + c.valorMotor, 0);
  const aceitoInv = invDisp.reduce((s, c) => s + c.valorAceito, 0);
  const fracInv = r.ciclos.length ? inv.length / r.ciclos.length : null;
  const h = num(r.config.horizonteDias);
  const res = num(r.config.reservaDias);
  const outras = r.sensibilidade.filter((s) => s.reservaDias !== r.config.reservaDias).map((s) => `${num(s.reservaDias)}`).join(' e ');
  return `<h2>O que o backtest diz sobre o cenário-guarda</h2>
<p>Sem nenhuma venda nova, a guarda de caixa olha ${h} dias à frente e exige que o saldo fique acima de ${res} dias de saídas em todos os dias. Nesta rodada, <b>${num(inv.length)} de ${num(r.ciclos.length)} ciclos (${pct(fracInv)}) ficaram inviáveis</b>, no período de ${faixa}. Entre os disparados foram ${num(invDisp.length)} de ${num(disp.length)}: o motor pediu ${brl(motorInv)} nesses ciclos e a guarda aceitaria ${brl(aceitoInv)}.</p>
<div class="diag"><p class="rot">Diagnóstico datado 2026-10-15, não recalculado</p>
<p>Nos inviáveis da rodada de 2026-10-15, a base de caixa sozinha, sem nenhuma candidata, já furava a reserva (mediana: 72 dias à frente). Exemplo do ciclo de 20/07: saldo de R$ 355 mil, reserva de R$ 291 mil. Em 91 dias, a continuidade do motor tirava R$ 199 mil e as saídas não-Sayerlack R$ 190 mil, contra R$ 108 mil de títulos a receber. O piso projetado ficava em R$ 57 mil.</p></div>
<p>Quando a base sozinha fura a reserva, a condição de reserva <b>como especificada não distingue um pedido de outro</b> e não serve para decidir compras. A próxima decisão é do founder, entre três caminhos (sem ordem de preferência):</p>
<ul>
<li><b>Calibrar um cenário de entrada de vendas</b>: substituir o “zero venda nova” por uma entrada conservadora medida.</li>
<li><b>Encurtar o horizonte</b>: verificar a reserva numa janela menor que ${h} dias.</li>
<li><b>Baixar a reserva</b>: exigir menos que ${res} dias de saídas${outras ? ` (a tabela de sensibilidade mostra ${outras} dias)` : ''}.</li>
</ul>`;
}

export function gerarPagina(r: Resultado): string {
  const res = r.resumo;
  const estados = res.estados as Record<string, number | undefined>;
  const contagem = (t: string) => num(estados[t] ?? null);
  const porCamada = indeterminadosPorCamada(r.ciclos);

  const linhasSens = r.sensibilidade
    .map((s) => `<tr><td>${num(s.reservaDias)} dias</td><td class="n">${brl(s.valorAceito)}</td><td class="n">${num(s.inviaveis)}</td><td class="n">${brl(s.valorAceitoSemGuarda)}</td><td class="n">${num(s.indeterminados)}</td></tr>`)
    .join('');
  const linhasCamada = porCamada.length
    ? porCamada.map(([camada, n]) => `<tr><td>${esc(camada)}</td><td class="n">${num(n)}</td></tr>`).join('')
    : `<tr><td colspan="2">${AUSENTE}</td></tr>`;
  const linhasCiclos = r.ciclos
    .filter((c) => c.status === 'disparado')
    .map((c) => {
      const cortes = Object.entries(c.cortesPorMotivo).map(([m, v]) => `${esc(m)} ${brl(v)}`).join(' · ') || AUSENTE;
      return `<tr><td>${esc(c.data)}</td><td class="n">${brl(c.valorMotor)}</td><td class="n">${brl(c.valorAceito)}</td><td>${rotuloEstado(c)}</td><td>${cortes}</td></tr>`;
    })
    .join('');
  const premissas = [...r.premissas, ...PREMISSAS_EXTRAS].map((p) => `<li>${esc(p)}</li>`).join('');
  const fechamentoFrac = res.skusAvaliados > 0 ? res.skusFechamentoRuim / res.skusAvaliados : null;
  const precisaoTotal = res.precisao.n + res.precisao.indeterminados;
  const datasCiclos = r.ciclos.map((c) => c.data).sort();
  const periodo = datasCiclos.length ? `${esc(datasCiclos[0])} a ${esc(datasCiclos[datasCiclos.length - 1])}` : AUSENTE;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orçamento de compra</title>
<style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fff;--ruim:#b42318;--line2:#f2f2f2}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0b0b;--fg:#eee;--muted:#9a9a9a;--line:#262626;--card:#141414;--ruim:#f08a7e;--line2:#1c1c1c}}
:root[data-theme="dark"]{--bg:#0b0b0b;--fg:#eee;--muted:#9a9a9a;--line:#262626;--card:#141414;--ruim:#f08a7e;--line2:#1c1c1c}
*{box-sizing:border-box}
html{background:var(--bg)}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0 auto;padding:24px 16px;max-width:1100px;overflow-wrap:anywhere}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
.muted,.nota,.rot{color:var(--muted)}.nota{display:block;font-size:12px}.rot{font-size:13px}
.ruim{color:var(--ruim)}
.diag{border-left:3px solid var(--line);background:var(--line2);padding:8px 12px;margin:12px 0;border-radius:6px}.diag p{margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:20px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;min-width:0}.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
ul{padding-left:20px}
</style></head><body>
<h1>Orçamento de compra — backtest ${periodo}</h1>
<p class="muted">Simulação (nada mudou em produção). Fatos gerados em ${esc(r.gerado_em)}. Reserva ${num(r.config.reservaDias)} dias; horizonte de caixa ${num(r.config.horizonteDias)} dias; gate ΔV&gt;0 por embalagem; frete ${pct(r.config.fretePerc)} no desembolso; caixa em cenário-guarda (sem vendas novas).</p>

${secaoPortao(r)}

<h2>Corte</h2>
<div class="kpis">
${kpi('Ciclos (disparados / total)', `${num(res.nDisparados)} / ${num(res.nCiclos)}`)}
${kpi('Motor pediu (disparados)', brl(res.valorMotorDisparados))}
${kpi('Orçamento aceitaria (disparados com guarda de caixa)', brl(res.valorAceitoDisparados), `de ${brl(res.valorMotorComGuarda)} que o motor pediu nesses ciclos (viáveis ou inviáveis)`)}
${kpi('Aceito sem guarda de caixa', brl(res.valorAceitoSemGuarda), `${num(res.ciclosSemGuarda)} ciclos disparados indeterminados — só o gate econômico decidiu; fora do “aceitaria”`)}
${kpi('Valor cortado — efetivo', brl(res.valorCortadoEfetivo), 'ciclos disparados; dedup. por episódio; sem score fora (revisão humana)')}
${kpi('Revisão humana (sem score)', brl(res.revisaoHumana?.valor), `${num(res.revisaoHumana?.embalagens)} embalagens nos disparados (${num(res.revisaoHumana?.semPreco)} sem preço) — fora do valor cortado e da precisão`)}
${kpi('Valor cortado — expirado', brl(res.valorCortadoExpirado), 'ciclos não disparados (a compra não aconteceu)')}
${kpi('Cortes sem preço', num(res.cortesSemPreco), 'fora do valor cortado')}
${kpi('Episódios de corte (dedup.)', num(res.episodios))}
${kpi('Embalagens sensíveis ao modelo', num(res.sensiveisAoModelo), 'sinal de ΔV muda entre empírico e gaussiano')}
</div>

<h2>Precisão do corte</h2>
<div class="kpis">
${kpi('Precisão por episódio (valor não-rompido / valor classificado)', pct(res.precisaoEpisodios.precisao), `${num(res.precisaoEpisodios.n)} episódios classificados · ${num(res.precisaoEpisodios.indeterminados)} indeterminados. Ruptura em período censurado vira indeterminado por construção — a precisão só cobre os episódios classificados (cobertura ${pct(res.coberturaEpisodios)})`)}
${kpi('Precisão por corte', pct(res.precisao.precisao), `${num(res.precisao.n)} cortes classificados · ${num(res.precisao.indeterminados)} indeterminados de ${num(precisaoTotal)} · valor classificado ${brl(res.precisao.valorCortado)}`)}
${kpi('Cortes com chegada aproximada', num(res.cortesChegadaAproximada), 'pedido sem t4 no tracking: remoção na chegada mediana as-of')}
${kpi('SKUs com fechamento ruim', `${num(res.skusFechamentoRuim)} / ${num(res.skusAvaliados)}`, fechamentoFrac == null ? AUSENTE : `${pct(fechamentoFrac)} — replay desses SKUs vira indeterminado`)}
</div>

<h2>Estoque e caixa liberado</h2>
<div class="kpis">
${kpi('ΔDIO (dias; positivo = menos estoque)', num(res.deltaDio, 2), `soma dos episódios medidos, não média do período · ${num(res.episodiosDioNoCmv)} episódios no subconjunto do CMV de ${num(res.episodiosDio)} medidos · ${num(res.episodiosSemHorizonte)} sem horizonte de replay · ${num(res.episodiosDioIndeterminados)} indeterminados · cobertura do CMV ${pct(res.cmvCobertura)} (abaixo de 80% → —)`)}
${kpi('Caixa liberado (R$)', brl(res.caixaLiberado), 'estoque médio a custo, com − sem o corte, nos episódios medidos')}
${kpi('CMV diário do universo do motor', brl(res.cmvDiarioBase), `SKUs com preço e demanda: ${pct(res.cmvCobertura)} do universo`)}
</div>

<h2>Estado do caixa por ciclo</h2>
<div class="kpis">
${kpi('Viável', contagem('viavel'))}
${kpi('Inviável', contagem('inviavel'))}
${kpi('Indeterminado', contagem('indeterminado'))}
</div>
<div class="wrap"><table><thead><tr><th>Camada ausente (indeterminado)</th><th class="n">Ciclos</th></tr></thead><tbody>${linhasCamada}</tbody></table></div>

${secaoCenarioGuarda(r)}

<h2>Sensibilidade da reserva</h2>
<div class="wrap"><table><thead><tr><th>Reserva</th><th class="n">Aceito (disparados com guarda)</th><th class="n">Ciclos inviáveis</th><th class="n">Aceito sem guarda</th><th class="n">Indeterminados</th></tr></thead><tbody>${linhasSens}</tbody></table></div>

<h2>Ciclos disparados</h2>
<div class="wrap"><table><thead><tr><th>Data</th><th class="n">Motor</th><th class="n">Aceito</th><th>Caixa</th><th>Cortes por motivo</th></tr></thead><tbody>${linhasCiclos}</tbody></table></div>

<h2>Premissas e limites</h2>
<ul>${premissas}</ul>
<p class="muted">Mínimo de pedido Sayerlack na simulação: ${brl(r.config.minimoPedido)}${r.config.minimoPedido === 0 ? ' (não modelado — pergunta aberta)' : ' (pergunta aberta)'}. Guloso não é ótimo; "score marginal" ≠ preço-sombra.</p>
</body></html>
`;
}

if (import.meta.main) {
  const [entrada, saida] = process.argv.slice(2);
  if (!entrada || !saida) throw new Error('uso: bun scripts/orcamento-compra/pagina.ts <resultado.json> <index.html>');
  writeFileSync(saida, gerarPagina(JSON.parse(readFileSync(entrada, 'utf8')) as Resultado));
  console.log('fim|ok');
}
