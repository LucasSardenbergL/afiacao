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
  'cortes sem score com preço entram na quantidade removida do episódio',
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
 * "O que o backtest diz sobre o cenário-guarda" (Task 8, fix round 2). Contagens vêm do resultado;
 * o detalhe por camada é o diagnóstico R29 de 2026-10-15 (datado, não recalculado aqui).
 */
export function secaoCenarioGuarda(r: Resultado): string {
  const disp = r.ciclos.filter((c) => c.status === 'disparado');
  const inv = r.ciclos.filter((c) => c.estado.tipo === 'inviavel');
  const invDisp = disp.filter((c) => c.estado.tipo === 'inviavel');
  const datas = inv.map((c) => c.data).sort();
  const faixa = datas.length ? `${esc(datas[0])} a ${esc(datas[datas.length - 1])}` : AUSENTE;
  const motorInv = invDisp.reduce((s, c) => s + c.valorMotor, 0);
  const aceitoInv = invDisp.reduce((s, c) => s + c.valorAceito, 0);
  const fracInv = r.ciclos.length ? inv.length / r.ciclos.length : null;
  return `<h2>O que o backtest diz sobre o cenário-guarda</h2>
<p>Sem nenhuma venda nova, a guarda de caixa olha 91 dias à frente e exige ficar acima de 30 dias de saídas o tempo todo. Nesta rodada, <b>${num(inv.length)} de ${num(r.ciclos.length)} ciclos (${pct(fracInv)}) ficaram inviáveis</b>, todos no período de ${faixa}. Nos disparados foram ${num(invDisp.length)} de ${num(disp.length)}: o motor pediu ${brl(motorInv)} nesses ciclos e a guarda aceitaria ${brl(aceitoInv)}.</p>
<p>Nesses ciclos o veredito não depende da compra: <b>a base de caixa sozinha, sem nenhuma candidata, já fura a reserva</b> em todos (diagnóstico de 2026-10-15). Na mediana, isso acontece 72 dias à frente.</p>
<p>Exemplo do ciclo de 20/07: saldo de R$ 355 mil contra reserva de R$ 291 mil, ou seja, folga de R$ 65 mil. Em 91 dias saem cerca de R$ 390 mil (continuidade do motor R$ 199 mil e saídas não-Sayerlack R$ 190 mil) e entram só R$ 108 mil de títulos já emitidos. O piso projetado fica em R$ 57 mil.</p>
<p>Em períodos de saldo perto da reserva, portanto, a condição de reserva <b>como especificada é estrita demais para decidir compras</b>: corta tudo o que não é protegido, qualquer que seja o pedido. <b>O portão da v2 continua FECHADO.</b> A próxima decisão é do founder, entre três caminhos (sem ordem de preferência):</p>
<ul>
<li><b>Calibrar um cenário de entrada de vendas</b>: substituir o “zero venda nova” por uma entrada conservadora medida, por exemplo um percentil baixo do recebimento histórico.</li>
<li><b>Encurtar o horizonte</b>: verificar a reserva numa janela menor que 91 dias, mais próxima do ciclo pedido → pagamento.</li>
<li><b>Baixar a reserva</b>: exigir menos que 30 dias de saídas (a tabela de sensibilidade abaixo mostra 15 e 45 dias).</li>
</ul>`;
}

export function gerarPagina(r: Resultado): string {
  const res = r.resumo;
  const estados = res.estados as Record<string, number | undefined>;
  const contagem = (t: string) => num(estados[t] ?? null);
  const porCamada = indeterminadosPorCamada(r.ciclos);

  const linhasSens = r.sensibilidade
    .map((s) => `<tr><td>${num(s.reservaDias)} dias</td><td class="n">${brl(s.valorAceito)}</td><td class="n">${num(s.inviaveis)}</td></tr>`)
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

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orçamento de compra</title>
<style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fff;--ruim:#b42318;--aviso:#8a5a00}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0b0b;--fg:#eee;--muted:#9a9a9a;--line:#262626;--card:#141414;--ruim:#f08a7e;--aviso:#e0b45c}}
:root[data-theme="dark"]{--bg:#0b0b0b;--fg:#eee;--muted:#9a9a9a;--line:#262626;--card:#141414;--ruim:#f08a7e;--aviso:#e0b45c}
*{box-sizing:border-box}
html{background:var(--bg)}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0 auto;padding:24px 16px;max-width:1100px;overflow-wrap:anywhere}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
.muted,.nota,.rot{color:var(--muted)}.nota{display:block;font-size:12px}.rot{font-size:13px}
.ruim{color:var(--ruim)}.aviso{color:var(--aviso)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:20px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;min-width:0}.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
ul{padding-left:20px}
</style></head><body>
<h1>Orçamento de compra — backtest 90 dias</h1>
<p class="muted">Simulação (nada mudou em produção). Fatos gerados em ${esc(r.gerado_em)}. Reserva ${num(r.config.reservaDias)} dias; gate ΔV&gt;0 por embalagem; frete ${pct(r.config.fretePerc)} no desembolso; caixa em cenário-guarda (sem vendas novas).</p>

<h2>Corte</h2>
<div class="kpis">
${kpi('Ciclos (disparados / total)', `${num(res.nDisparados)} / ${num(res.nCiclos)}`)}
${kpi('Motor pediu (disparados)', brl(res.valorMotorDisparados))}
${kpi('Orçamento aceitaria (disparados)', brl(res.valorAceitoDisparados))}
${kpi('Valor cortado — efetivo', brl(res.valorCortadoEfetivo), 'ciclos disparados; dedup. por episódio')}
${kpi('Valor cortado — expirado', brl(res.valorCortadoExpirado), 'ciclos não disparados (a compra não aconteceu)')}
${kpi('Cortes sem preço', num(res.cortesSemPreco), 'fora do valor cortado')}
${kpi('Episódios de corte (dedup.)', num(res.episodios))}
${kpi('Embalagens sensíveis ao modelo', num(res.sensiveisAoModelo), 'sinal de ΔV muda entre empírico e gaussiano')}
</div>

<h2>Precisão do corte</h2>
<div class="kpis">
${kpi('Precisão (valor não-rompido / valor classificado)', pct(res.precisao.precisao), `n=${num(res.precisao.n)} classificados · ${num(res.precisao.indeterminados)} indeterminados de ${num(precisaoTotal)}`)}
${kpi('Valor classificado', brl(res.precisao.valorCortado))}
${kpi('SKUs com fechamento ruim', `${num(res.skusFechamentoRuim)} / ${num(res.skusAvaliados)}`, fechamentoFrac == null ? AUSENTE : `${pct(fechamentoFrac)} — replay desses SKUs vira indeterminado`)}
</div>

<h2>Estoque e caixa liberado</h2>
<div class="kpis">
${kpi('ΔDIO (dias)', num(res.deltaDio, 2), `${num(res.episodiosDio)} episódios medidos · ${num(res.episodiosSemHorizonte)} sem horizonte de 30d · ${num(res.episodiosDioIndeterminados)} indeterminados`)}
${kpi('Caixa liberado (R$)', brl(res.caixaLiberado), 'estoque médio a custo, com − sem o corte, nos episódios medidos')}
${kpi('CMV diário do universo do motor', brl(res.cmvDiarioBase))}
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
<div class="wrap"><table><thead><tr><th>Reserva</th><th class="n">Aceito (disparados)</th><th class="n">Ciclos inviáveis</th></tr></thead><tbody>${linhasSens}</tbody></table></div>

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
