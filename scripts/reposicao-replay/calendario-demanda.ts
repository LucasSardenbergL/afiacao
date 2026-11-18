// Replay da Etapa 2 do calendário (spec docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §7-E2 b/c):
// nas datas-base, o PP do F0 (réplica da view) com o `d` cru e com o `d` ajustado pelo calendário — viés agregado,
// rupturas evitadas (proxy) e capital adicional (ΔPP × cmc) por SKU.
//
//   bun scripts/reposicao-replay/calendario-demanda.ts [--dados DIR] [2026-01-19 2026-02-02 …]
//
// Entrada: a extração do replay ($REPLAY_DADOS, padrão ~/.cache/afiacao/reposicao-replay — nunca no repo) + o
// calendário da OBEN exportado do banco para o mesmo diretório (`data|status`, só exceções):
//   ~/.config/afiacao/psql-ro -At -F'|' -c "select data, status from calendario_operacao_empresa
//     where empresa='OBEN' order by data" | grep -E '^[0-9]{4}-' > $REPLAY_DADOS/calendario_operacao_oben.csv
//
// O fator é o MESMO da função SQL calendario_fator_demanda (U/W, guardas W/U < 0,6 e teto 1,35, pendente_dado fora),
// sobre a MESMA janela da SQL ([d − 90, d]: o estado do dia d já é conhecido de madrugada — Codex P1-7). O σ e o LT ficam os
// do diagnóstico (a spec não os toca; o fallback de σ é d_cru × 0,5, como na view).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { carregarDados } from './dados';
import { diagnosticoF0, pontoDePedidoF0 } from './formulas';

export type StatusCalendario = 'aberto' | 'fechado' | 'meia_equipe' | 'pendente_dado';

export interface FatorCalendario {
  diasBase: number;
  diasEfetivos: number;
  diasPendentes: number;
  fator: number;
  baixaConfianca: boolean;
}

const ehDiaUtil = (d: string): boolean => {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};

/** Espelho de calendario_fator_demanda sobre os dias [ini, fim] (inclusive). */
export function fatorCalendario(cal: ReadonlyMap<string, StatusCalendario>, ini: string, fim: string): FatorCalendario {
  let u = 0;
  let w = 0;
  let p = 0;
  for (let d = ini; d <= fim; d = addDias(d, 1)) {
    if (!ehDiaUtil(d)) continue;
    const st = cal.get(d);
    if (st === 'pendente_dado') { p++; continue; }
    u++;
    if (st === undefined || st === 'aberto' || st === 'meia_equipe') w++;
  }
  const baixaConfianca = u === 0 || w / u < 0.6;
  return { diasBase: u, diasEfetivos: w, diasPendentes: p, fator: baixaConfianca ? 1 : Math.min(u / w, 1.35), baixaConfianca };
}

export const arred4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export function lerCalendario(texto: string): Map<string, StatusCalendario> {
  const cal = new Map<string, StatusCalendario>();
  for (const linha of texto.split('\n')) {
    const [data, status] = linha.trim().split('|');
    if (!data) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !['aberto', 'fechado', 'meia_equipe', 'pendente_dado'].includes(status)) {
      throw new Error(`calendário ilegível: [${linha}]`);   // fail-closed: um dia mal lido mudaria o fator
    }
    cal.set(data, status as StatusCalendario);
  }
  if (cal.size === 0) throw new Error('calendário vazio — exporte calendario_operacao_oben.csv (ver cabeçalho)');
  return cal;
}

interface LinhaSku {
  sku: string;
  d0: number;
  d1: number;
  pp0: number;
  pp1: number;
  real30: number;
  realLt: number;
  cmc: number | null;
}

function principal(): void {
  const args = process.argv.slice(2);
  const iDados = args.indexOf('--dados');
  const dir = iDados >= 0 ? args[iDados + 1] : (process.env.REPLAY_DADOS ?? join(homedir(), '.cache/afiacao/reposicao-replay'));
  const datas = args.filter((a, i) => /^\d{4}-\d{2}-\d{2}$/.test(a) && !(iDados >= 0 && i === iDados + 1));
  const bases = datas.length ? datas : ['2026-01-19', '2026-02-02', '2026-03-02', '2026-03-16', '2026-04-06', '2026-09-01'];
  const dados = carregarDados(dir);
  const cal = lerCalendario(readFileSync(join(dir, 'calendario_operacao_oben.csv'), 'utf8'));

  const vendas = new Map<string, Map<string, number>>();
  for (const v of dados.vendas) {
    if (!v.noEscopo) continue;
    const m = vendas.get(v.sku) ?? new Map<string, number>();
    m.set(v.data, (m.get(v.data) ?? 0) + v.quantidade);
    vendas.set(v.sku, m);
  }
  const somar = (sku: string, dias: string[]): number => dias.reduce((s, d) => s + (vendas.get(sku)?.get(d) ?? 0), 0);

  console.log(`# Replay §7-E2 — demanda ajustada pelo calendário\n\nDados: ${dir} (extração ${dados.dataExtracao}, hash ${dados.hashDados.slice(0, 12)})\n`);
  console.log('| data-base | fator (U/W) | SKUs com PP (ativos e habilitados) | paridade PP F0 | viés cru | viés ajust. | venda no LT > PP: cru → ajust. (deixam de exceder) | ΔPP total (un) | capital adicional R$ | SKUs sem cmc |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const D of bases) {
    if (addDias(D, 59) > dados.dataExtracao) throw new Error(`horizonte de ${D} passa da extração (${dados.dataExtracao}): dia sem dado viraria venda zero`);
    const f = fatorCalendario(cal, addDias(D, -90), D);
    const linhas: LinhaSku[] = [];
    let paridadeOk = 0;
    for (const s of dados.skus.values()) {
      if (!s.ativo || !s.habilitado) continue;   // coorte: o que o motor compra hoje
      const g = diagnosticoF0(dados, s.sku, D, { calibracao: false });
      if (g.status !== 'OK' || g.demanda === null || g.lt === null || g.sigmaLt === null || g.z === null) continue;
      const base = { sigmaD: g.sigmaD ?? g.demanda * 0.5, lt: g.lt, sigmaLt: g.sigmaLt, z: g.z, minimoOperacional: g.minimoOperacional ?? 0 };
      const pp0 = pontoDePedidoF0({ ...base, demanda: g.demanda }).pp;
      if (pp0 === g.ppSugerido) paridadeOk++;
      const d1 = f.fator === 1 ? g.demanda : arred4(g.demanda * f.fator);
      const pp1 = pontoDePedidoF0({ ...base, demanda: d1 }).pp;
      const dias30 = Array.from({ length: 30 }, (_, i) => addDias(D, i));
      const diasLt: string[] = [];
      for (let d = D; diasLt.length < Math.ceil(g.lt); d = addDias(d, 1)) if (ehDiaUtil(d)) diasLt.push(d);
      linhas.push({ sku: s.sku, d0: g.demanda, d1, pp0, pp1, real30: somar(s.sku, dias30), realLt: somar(s.sku, diasLt), cmc: s.cmc });
    }
    const real = linhas.reduce((a, l) => a + l.real30, 0);
    const vies0 = real > 0 ? linhas.reduce((a, l) => a + l.d0 * 30, 0) / real : null;
    const vies1 = real > 0 ? linhas.reduce((a, l) => a + l.d1 * 30, 0) / real : null;
    const rup0 = linhas.filter((l) => l.realLt > l.pp0).length;
    const rup1 = linhas.filter((l) => l.realLt > l.pp1).length;
    const evit = linhas.filter((l) => l.realLt > l.pp0 && l.realLt <= l.pp1).length;
    const dPP = linhas.reduce((a, l) => a + (l.pp1 - l.pp0), 0);
    const comCmc = linhas.filter((l) => l.cmc !== null);
    const capital = comCmc.reduce((a, l) => a + (l.pp1 - l.pp0) * (l.cmc as number), 0);
    const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
    console.log(`| ${D} | ${f.fator.toFixed(4)} (${f.diasBase}/${f.diasEfetivos}${f.diasPendentes ? `, ${f.diasPendentes} pend.` : ''}${f.baixaConfianca ? ', baixa conf.' : ''}) | ${linhas.length} | ${paridadeOk}/${linhas.length} | ${fmt(vies0)} | ${fmt(vies1)} | ${rup0} → ${rup1} (${evit}) | ${dPP} | ${capital.toFixed(0)} | ${linhas.length - comCmc.length} |`);
    const csv = ['sku|d_cru|d_ajust|pp_cru|pp_ajust|real_30d|real_lt|cmc|delta_capital',
      ...linhas.map((l) => [l.sku, l.d0, l.d1, l.pp0, l.pp1, l.real30, l.realLt, l.cmc ?? '', l.cmc === null ? '' : ((l.pp1 - l.pp0) * l.cmc).toFixed(2)].join('|'))];
    writeFileSync(join(dir, `calendario-demanda-${D}.csv`), `${csv.join('\n')}\n`);
  }
  console.log('\nViés = Σ(d × 30) / Σ(venda realizada nos 30 dias corridos a partir da data-base), SKUs com status OK. "Venda no LT > PP" = a venda realizada nos ceil(LT) dias úteis seguintes passou do PP sugerido — NÃO é ruptura (ignora posição e recebimentos); é o sinal de que o gatilho estava baixo. Capital = ΔPP × cmc de hoje (sem cmc fica fora da soma e é contado).');
}

if (import.meta.main) principal();
