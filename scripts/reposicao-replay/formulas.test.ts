import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { uniforme } from './aleatorio';
import { classeEfetiva } from './classe';
import { somarDiasUteis } from './calendario';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import {
  chaveCache,
  diagnosticoF0,
  sugestaoDaView,
  fontesDoCodigo,
  parametrosNoDia,
  preComputarComOrigem,
  quantilTipo7,
  sigmaDemanda180,
  dentroDaTolerancia,
  type ParamsFormula,
} from './formulas';
import { consolidarLtMotor, precosCompraPorDocumento, type LinhaLtMotorCrua, type RecebLinha } from './dados';
import type { Dados, ItemLT, LinhaVenda, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: 'sayerlack_normal', classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 2, saldoHoje: 5, ativo: true, habilitado: true, unidadeNf: 'UN', unidadeEstoque: 'UN', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25.75 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
let seq = 0;
const venda = (s: string, data: string, quantidade: number, valor = quantidade): LinhaVenda => ({
  linhaId: `L${seq++}`, sku: s, data, quantidade, valor, cmcLinha: null, noEscopo: true,
});
const item = (s: string, t1: string, ltDu: number, tracking = `T${seq++}`): ItemLT => ({
  trackingId: tracking, sku: s, t1, t2: null, t4: somarDiasUteis(t1, ltDu), ltDu, aberto: false,
});
const dados = (skus: Sku[], vendas: LinhaVenda[], itensLT: ItemLT[] = [], extra: Partial<Dados> = {}): Dados => ({
  vendas, itensLT, recebimentos: [], skus: new Map(skus.map((s) => [s.sku, s])), zPorClasse: { A: 1.65, B: 1.28, C: 0.84 },
  teto: { ativa: true, diasB: 90, diasC: 60 }, equivalencias: [], sugestaoHoje: new Map(), excluidos: [],
  classificacaoHist: { regras: REGRAS, porSku: new Map() }, shareInsumo: new Map(), parametrosView: new Map(), avisos: [], dataExtracao: '2026-10-21', posicaoAbertura: null, posicaoConferencia: null, hashDados: 'h1', ...extra,
});
const diasCorridos = (ini: string, fim: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i <= diffDias(ini, fim); i++) out.push(addDias(ini, i));
  return out;
};
const QUANTIL: ParamsFormula['quantil'] = { A: 0.9, B: 0.9, C: 0.9 };
/** Quantis DISTINTOS por classe: um teste de vazamento com o mesmo quantil nas 3 classes é cego à classe do quantil. */
const QUANTIL_POR_CLASSE: ParamsFormula['quantil'] = { A: 0.5, B: 0.85, C: 0.99 };
const CTX = { calibracao: false };
const SEM_CACHE = { cacheDir: null };

// Lead times da Sayerlack toda (para F1–F3 terem amostra) — 6 itens de outro SKU, recebidos bem antes dos dias testados.
const ltSayerlack = (): ItemLT[] => [3, 5, 6, 8, 9, 12].map((lt, i) => item('OUTRO', addDias('2025-10-22', 7 * i), lt));

describe('F0 — fiel à fonte (v_sku_sigma_demanda / v_sku_parametros_sugeridos / atualizar_parametros_numericos_skus)', () => {
  it('F0 usa σ de 180 dias com zeros', () => {
    const d = '2026-05-04'; // janela de 180 dias corridos [d-180, d-1] inteira dentro do histórico
    const ini = addDias(d, -180);
    // venda só nos dias 1–90 da janela (um dia sim, outro não, sempre 4), zeros nos 90 seguintes: σ só dos positivos seria 0
    const v = diasCorridos(ini, addDias(ini, 89)).filter((_, i) => i % 2 === 0).map((dia) => venda('X', dia, 4));
    const dd = dados([sku('X')], v);
    const serie = diasCorridos(ini, addDias(d, -1)).map((dia) => v.filter((x) => x.data === dia).reduce((s, x) => s + x.quantidade, 0));
    expect(serie).toHaveLength(180);
    const media = serie.reduce((s, x) => s + x, 0) / 180;
    const esperado = Math.sqrt(serie.reduce((s, x) => s + (x - media) ** 2, 0) / 179); // stddev_samp com os 90 zeros
    const soPositivos = v.map((x) => x.quantidade);
    const mp = soPositivos.reduce((s, x) => s + x, 0) / soPositivos.length;
    const sigmaPositivos = Math.sqrt(soPositivos.reduce((s, x) => s + (x - mp) ** 2, 0) / (soPositivos.length - 1));
    const sigma = sigmaDemanda180(dd, 'X', d);
    expect(sigma).toBeCloseTo(Math.round(esperado * 1e4) / 1e4, 10); // round(…, 4) como a view
    expect(Math.abs((sigma ?? 0) - sigmaPositivos)).toBeGreaterThan(0.5);
    // Sem venda nos últimos 90 dias o SKU sai de v_sku_demanda_estatisticas: o motor NÃO recalcula, mantém o último parâmetro.
    // última venda em ini+88 ⇒ o último dia com ela na janela [d'-90, d') é d' = ini+178 = d-2
    expect(diagnosticoF0(dd, 'X', addDias(d, -2), CTX).naView).toBe(true);
    expect(diagnosticoF0(dd, 'X', addDias(d, -1), CTX).naView).toBe(false);
    const congelado = parametrosNoDia('F0', dd, 'X', d, { quantil: QUANTIL }, CTX);
    expect(congelado.tipo).toBe('F0');
    expect(congelado).toEqual(parametrosNoDia('F0', dd, 'X', addDias(d, -2), { quantil: QUANTIL }, CTX));
    // e um SKU sem venda no dia d continua sem σ (null, nunca 0 fabricado)
    expect(sigmaDemanda180(dd, 'NUNCA', d)).toBeNull();
  });

  it('F0 respeita minimo_operacional e PP ≥ ss + 1', () => {
    const d = '2026-05-04';
    const dias = diasCorridos(INICIO_AQUECIMENTO, addDias(d, -1));
    // A1: demanda CONSTANTE (σd = 0) e LT do SKU constante (σLT = 0) ⇒ ss_calculado = 0; é A (75% do valor) ⇒ mínimo operacional 2
    const v = [...dias.map((dia) => venda('A1', dia, 0.01, 10)), ...dias.filter((_, i) => i % 3 === 0).map((dia) => venda('Z', dia, 1, 10))];
    // LT do SKU constante em toda a janela de 180 dias de cada passada (>= 3 obs, desvio 0)
    const its = diasCorridos('2025-07-01', addDias(d, -10)).filter((_, i) => i % 20 === 0).map((t1) => item('A1', t1, 5));
    const dd = dados([sku('A1'), sku('Z')], v, its);
    const diag = diagnosticoF0(dd, 'A1', d, CTX);
    expect(diag.classeProposta).toBe('A');
    expect(diag.ssCalculado).toBe(0);
    expect(diag.minimoOperacional).toBe(2);
    const p = parametrosNoDia('F0', dd, 'A1', d, { quantil: QUANTIL }, CTX);
    if (p.tipo !== 'F0') throw new Error('esperado F0');
    expect(p.pp).toBe(3); // max(ceil(0,01·10), max(0, 2) + 1)
    expect(diag.es).toBe(0); // estoque_seguranca gravado = ss_calculado (sem o mínimo)
    expect(p.max).toBeGreaterThanOrEqual(p.pp + 1); // + EOQ ≥ 1
    // propriedade geral, em vários dias e no SKU C
    for (const dia of ['2026-02-02', '2026-03-03', '2026-04-06']) {
      for (const s of ['A1', 'Z']) {
        const g = diagnosticoF0(dd, s, dia, CTX);
        if (g.pp === null || g.es === null) continue;
        expect(g.pp).toBeGreaterThanOrEqual(Math.max(g.ssCalculado ?? 0, g.minimoOperacional ?? 0) + 1);
      }
    }
  });

  it('antes da 1ª sugestão OK vale o fallback do cold start (pp 1 / máx. 2); a 1ª OK o substitui', () => {
    // X vende 1 vez (1 ordem: AGUARDANDO_SEGUNDA_ORDEM) e só ganha a 2ª ordem em 2026-03-02
    const dd = dados([sku('X')], [venda('X', '2026-02-02', 5), venda('X', '2026-03-02', 5)], ltSayerlack());
    expect(parametrosNoDia('F0', dd, 'X', '2025-10-28', { quantil: QUANTIL }, CTX)).toMatchObject({ tipo: 'F0', pp: 1, max: 2 }); // motor ainda não roda
    expect(parametrosNoDia('F0', dd, 'X', '2026-02-27', { quantil: QUANTIL }, CTX)).toMatchObject({ tipo: 'F0', pp: 1, max: 2 });
    expect(diagnosticoF0(dd, 'X', '2026-02-27', CTX).status).toBe('AGUARDANDO_SEGUNDA_ORDEM');
    const g = diagnosticoF0(dd, 'X', '2026-03-03', CTX);
    expect(g.gravacao).toBe('semeado');
    expect(g.coldStart).toBe(false);
    expect(g.pp).toBe(g.ppSugerido);
  });

  it('LT do motor: NFe ≈ (sku, t2, t4) — duas NFes no mesmo dia contam 2 obs; cópias da mesma NFe com LT igual contam 1', () => {
    const d = '2026-05-04';
    const v = diasCorridos('2026-02-02', addDias(d, -1)).filter((_, i) => i % 3 === 0).map((dia) => venda('X', dia, 1));
    const t4 = '2026-04-20';
    const nfe = (tracking: string, t1: string, t2: string, ltDu: number): ItemLT => ({ trackingId: tracking, sku: 'X', t1, t2, t4, ltDu, aberto: false });
    const its = [
      nfe('A', '2026-04-08', '2026-04-15', 8), // NFe 1
      nfe('B', '2026-03-31', '2026-04-16', 14), // NFe 2, mesmo t4
      nfe('C', '2026-04-07', '2026-04-15', 9), // cópia da NFe 1 (mesmo t2 e t4) com LT diferente => a NFe 1 sai (LT NULL)
      { ...nfe('C2', '2026-03-20', '2026-03-25', 9), t4: '2026-04-02' }, // NFe 3, cópia 1
      { ...nfe('C3', '2026-03-20', '2026-03-25', 9), t4: '2026-04-02' }, // NFe 3, cópia 2 (mesmo LT) => 1 obs
    ];
    const dd = dados([sku('X', { grupo: 'sayerlack_rapido' })], v, its);
    // (sku,t2,t4): A+C divergem (mesma NFe 04-15, LT 8 vs 9) => fora; B (14); C2/C3 => 1 obs (9) => 2 obs < 3 => fornecedor = as mesmas 2 => média 11,5
    const g = diagnosticoF0(dd, 'X', d, CTX);
    expect(g.lt).toBe(11.5);
  });

  it('grupo de embalagem: o galão (fator_para_base > 1) não decide; a âncora decide sem teto', () => {
    const d = '2026-05-04';
    const dias = diasCorridos('2026-01-02', addDias(d, -1)).filter((_, i) => i % 4 === 0);
    const v = [...dias.map((dia) => venda('QT', dia, 0.81)), ...dias.map((dia) => venda('GL', dia, 3.24))];
    const eq = [
      { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'g1', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
      { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'g1', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
    ];
    const dd = dados([sku('QT', { grupoEmbalagemId: 'g1', unidadeEstoque: 'L' }), sku('GL', { grupoEmbalagemId: 'g1', unidadeEstoque: 'L' })], v, ltSayerlack(), { equivalencias: eq });
    expect(parametrosNoDia('F0', dd, 'GL', d, { quantil: QUANTIL }, CTX)).toEqual({ tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' });
    expect(parametrosNoDia('F1', dd, 'GL', d, { quantil: QUANTIL }, CTX)).toEqual({ tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' });
    const ancora = parametrosNoDia('F0', dd, 'QT', d, { quantil: QUANTIL }, CTX);
    expect(ancora.tipo === 'F0' && ancora.coberturaTetoDias).toBeNull();
    // F1 na unidade-base do grupo: a demanda do galão soma à da âncora (mesma unidade de estoque, L)
    const soQT = dados([sku('QT')], v.filter((x) => x.sku === 'QT'), ltSayerlack());
    const f1Grupo = parametrosNoDia('F1', dd, 'QT', d, { quantil: QUANTIL }, CTX);
    const f1Sozinho = parametrosNoDia('F1', soQT, 'QT', d, { quantil: QUANTIL }, CTX);
    if (f1Grupo.tipo !== 'S' || f1Sozinho.tipo !== 'S') throw new Error('esperado S');
    expect(f1Grupo.s).toBeGreaterThan(f1Sozinho.s);
  });
});

describe('F1–F3 (spec §5.9 "Equações")', () => {
  it('F2 decai sem demanda', () => {
    // vende 1 du sim, 1 não desde o início; depois 60 du sem venda até a véspera de d
    const fimVenda = somarDiasUteis(INICIO_AQUECIMENTO, 110);
    const d = somarDiasUteis(fimVenda, 61);
    const v: LinhaVenda[] = [];
    for (let i = 0, dia = INICIO_AQUECIMENTO; dia <= fimVenda; i++, dia = somarDiasUteis(dia, 1)) if (i % 2 === 0) v.push(venda('X', dia, 10));
    const dd = dados([sku('X')], v, ltSayerlack());
    const s = (beta: 0.005 | 0.01 | 0.02) => {
      const p = parametrosNoDia('F2', dd, 'X', d, { beta, quantil: QUANTIL }, CTX);
      if (p.tipo !== 'S') throw new Error(`esperado S, veio ${p.tipo}`);
      return p.s;
    };
    expect(s(0.02)).toBeLessThan(s(0.005));
    expect(s(0.01)).toBeLessThanOrEqual(s(0.005));
  });

  it('nenhuma fórmula vê o futuro', () => {
    const d = '2026-03-10';
    const dias = diasCorridos(INICIO_AQUECIMENTO, '2026-10-20').filter((x) => ehDiaUtil(x));
    const base = dias.filter((_, i) => i % 3 === 0).map((dia, i) => venda('X', dia, 1 + (i % 4)));
    const outro = dias.filter((_, i) => i % 2 === 0).map((dia) => venda('Y', dia, 1));
    const its = [...ltSayerlack(), ...[0, 1, 2, 3, 4, 5].map((i) => item('X', addDias('2025-11-03', 14 * i), 4 + i))];
    const dd = dados([sku('X'), sku('Y')], [...base, ...outro], its);
    // futuro: duplica as vendas de d em diante, acrescenta vendas novas e recebimentos com t4 >= d
    const futuro = [...base, ...outro].filter((x) => x.data >= d).map((x) => venda(x.sku, x.data, x.quantidade * 7, x.valor * 7));
    // ...e o Y passa a vender muito valor depois de d: no início da avaliação o X deixa de ser A (vira C)
    const yGrande = dias.filter((x) => x >= d).map((dia) => venda('Y', dia, 1, 1000));
    const itsFuturo = [...its, item('X', d, 25), item('X', addDias(d, 10), 28), item('OUTRO', addDias(d, -3), 29)];
    const dd2 = dados([sku('X'), sku('Y')], [...base, ...outro, ...futuro, ...yGrande], itsFuturo);
    // controle: o futuro muda a classe do X no início da janela (senão o teste não enxergaria a classe do quantil)
    expect(classeEfetiva(dd2, JANELAS.avaliacaoIni).get('X')).not.toBe(classeEfetiva(dd2, d).get('X'));
    for (const f of ['F0', 'F1', 'F2', 'F3'] as const) {
      const p: ParamsFormula = { beta: 0.01, janelaDias: 90, quantil: QUANTIL_POR_CLASSE };
      expect(parametrosNoDia(f, dd2, 'X', d, p, CTX), f).toEqual(parametrosNoDia(f, dd, 'X', d, p, CTX));
    }
  });

  // Achado 7: um SKU promovido de C para A continuava julgado no quantil de C (classe do início da janela).
  it('o quantil sai da classe efetiva do DIA (dados até a véspera), não da do início da janela', () => {
    const dias = diasCorridos(INICIO_AQUECIMENTO, '2026-08-31').filter((x) => ehDiaUtil(x));
    // X vende pouco até junho e muito a partir de 01/06; Z* compõem o Pareto
    const vx = dias.map((dia) => venda('X', dia, 1, dia >= '2026-06-01' ? 100000 : 10));
    const vz = ['Z1', 'Z2', 'Z3', 'Z4'].flatMap((z) => dias.map((dia) => venda(z, dia, 1, 1000)));
    const its = [...ltSayerlack(), ...[0, 1, 2, 3, 4, 5].map((i) => item('X', addDias('2025-11-03', 14 * i), 4 + i))];
    const dd = dados([sku('X'), sku('Z1'), sku('Z2'), sku('Z3'), sku('Z4')], [...vx, ...vz], its);
    const d = '2026-07-06';
    const doDia = classeEfetiva(dd, d).get('X') ?? 'C';
    expect(doDia).not.toBe(classeEfetiva(dd, JANELAS.avaliacaoIni).get('X') ?? 'C'); // controle: a classe mudou na janela
    const q = QUANTIL_POR_CLASSE[doDia];
    for (const f of ['F1', 'F3'] as const) {
      const p: ParamsFormula = { janelaDias: 90, quantil: QUANTIL_POR_CLASSE };
      const soDoDia: ParamsFormula = { janelaDias: 90, quantil: { A: q, B: q, C: q } };
      expect(parametrosNoDia(f, dd, 'X', d, p, CTX), f).toEqual(parametrosNoDia(f, dd, 'X', d, soDoDia, CTX));
      expect(parametrosNoDia(f, dd, 'X', d, p, { calibracao: true }), f).toEqual(parametrosNoDia(f, dd, 'X', d, soDoDia, { calibracao: true }));
    }
  });

  it('calibração não vê LT posterior ao corte', () => {
    const d = '2026-05-15'; // depois do fim da calibração: só aqui o filtro t4 <= FIM_CALIBRACAO morde
    const dias = diasCorridos(INICIO_AQUECIMENTO, d).filter((x) => ehDiaUtil(x));
    const v = dias.filter((_, i) => i % 3 === 0).map((dia, i) => venda('X', dia, 1 + (i % 5)));
    const its = [...ltSayerlack(), ...[0, 1, 2, 3, 4, 5].map((i) => item('X', addDias('2025-11-03', 14 * i), 4 + i))];
    // recebimentos com t4 > fim da calibração (e < d): na calibração não existem
    const tardios = [item('X', '2026-05-04', 3), item('X', '2026-05-05', 4), item('X', '2026-05-06', 2)];
    expect(tardios.every((x) => x.t4 !== null && x.t4 > JANELAS.calibracaoFim && x.t4 < d)).toBe(true);
    const alterados = tardios.map((x) => ({ ...x, ltDu: x.ltDu + 20 })); // mesmo t4 (> corte), LT diferente
    const dA = dados([sku('X')], v, [...its, ...tardios]);
    const dB = dados([sku('X')], v, [...its, ...alterados, item('X', '2026-05-07', 1)]);
    let algumMudouForaDaCalibracao = false;
    for (const f of ['F0', 'F1', 'F2', 'F3'] as const) {
      const p: ParamsFormula = { beta: 0.01, janelaDias: 180, quantil: QUANTIL };
      expect(parametrosNoDia(f, dB, 'X', d, p, { calibracao: true }), f).toEqual(parametrosNoDia(f, dA, 'X', d, p, { calibracao: true }));
      if (JSON.stringify(parametrosNoDia(f, dB, 'X', d, p, CTX)) !== JSON.stringify(parametrosNoDia(f, dA, 'X', d, p, CTX))) algumMudouForaDaCalibracao = true;
    }
    expect(algumMudouForaDaCalibracao).toBe(true); // controle: fora da calibração a mudança aparece (o teste não é vácuo)
  });

  it('histórico insuficiente cai em F0', () => {
    const d = '2026-03-10';
    // X vendeu em 1 só dia útil antes de d (< 2 dias positivos); Y dá volume ao universo
    const dias = diasCorridos(INICIO_AQUECIMENTO, addDias(d, -1)).filter((x) => ehDiaUtil(x));
    const v = [venda('X', '2026-02-10', 3), venda('X', '2026-02-10', 2), ...dias.map((dia) => venda('Y', dia, 1))];
    const dd = dados([sku('X'), sku('Y')], v, ltSayerlack());
    const f0 = parametrosNoDia('F0', dd, 'X', d, { quantil: QUANTIL }, CTX);
    for (const f of ['F1', 'F2', 'F3'] as const) expect(parametrosNoDia(f, dd, 'X', d, { beta: 0.01, janelaDias: 90, quantil: QUANTIL }, CTX), f).toEqual(f0);
  });

  it('quantil tipo 7 (interpolação linear)', () => {
    expect(quantilTipo7([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantilTipo7([10], 0.9)).toBe(10);
    expect(quantilTipo7([0, 10], 0.95)).toBeCloseTo(9.5, 12);
  });
});

describe('contas à mão e preço do EOQ', () => {
  // X vende em TODO dia útil, alternando 1 e 3 (sem fim de semana); 5 LTs próprios [2,3,4,5,6] (t4 bem antes de d)
  const montar = (lts: number[], sk: Sku = sku('X')) => {
    const d = '2026-04-07';
    const dus = diasCorridos(INICIO_AQUECIMENTO, addDias(d, -1)).filter((x) => ehDiaUtil(x));
    const v = dus.map((dia, i) => venda('X', dia, i % 2 === 0 ? 1 : 3));
    const its = lts.map((lt, i) => item(sk.sku, addDias('2025-11-03', 7 * i), lt));
    return { d, dus, dd: dados([sk], v, its), serie: dus.map((_, i) => (i % 2 === 0 ? 1 : 3)) };
  };

  it('F1: S = ceil(H·d̄ + z·√(H·σd² + d̄²·σLT²)) feito à mão', () => {
    const { d, dd, serie } = montar([2, 3, 4, 5, 6]);
    const j = serie.slice(-63); // 63 du antes de d
    const m = j.reduce((a, b) => a + b, 0) / 63;
    const sd2 = j.reduce((a, b) => a + (b - m) ** 2, 0) / 62;
    const ltBar = 4;
    const sLt2 = (4 + 1 + 0 + 1 + 4) / 4; // stddev_samp² de [2..6] = 2,5
    const H = ltBar + 1;
    const z90 = 1.2815515655446004; // Φ⁻¹(0,90)
    const esperado = Math.ceil(H * m + z90 * Math.sqrt(H * sd2 + m * m * sLt2));
    expect(parametrosNoDia('F1', dd, 'X', d, { quantil: QUANTIL }, CTX)).toEqual({ tipo: 'S', s: esperado });
  });

  it('F1: σLT com 1 observação segue o COALESCE da produção (teórico·0,3), nunca 0', () => {
    // amostra da Sayerlack toda com 1 LT (X tem < 5): σLT = LT teórico (normal = 10)·0,3 = 3
    const { d, dd, serie } = montar([4]);
    const j = serie.slice(-63);
    const m = j.reduce((a, b) => a + b, 0) / 63;
    const sd2 = j.reduce((a, b) => a + (b - m) ** 2, 0) / 62;
    const z90 = 1.2815515655446004;
    const esperado = Math.ceil(5 * m + z90 * Math.sqrt(5 * sd2 + m * m * 9));
    expect(parametrosNoDia('F1', dd, 'X', d, { quantil: QUANTIL }, CTX)).toEqual({ tipo: 'S', s: esperado });
  });

  it('F3: blocos de H = ceil(LT̄)+1 du na janela, quantil tipo 7, feito à mão', () => {
    // LT̄ = 4 => H = 5; somas de 5 du alternando 1/3 = 9 ou 11, 28 de cada nos 56 blocos dos últimos 60 du
    const { d, dd } = montar([2, 3, 4, 5, 6]);
    // q 0,90: h = 55·0,9 = 49,5 => x[49] = x[50] = 11 => S = 11; q 0,50: h = 27,5 => (9 + 11)/2 = 10 => S = 10
    expect(parametrosNoDia('F3', dd, 'X', d, { janelaDias: 60, quantil: QUANTIL }, CTX)).toEqual({ tipo: 'S', s: 11 });
    expect(parametrosNoDia('F3', dd, 'X', d, { janelaDias: 60, quantil: { A: 0.5, B: 0.5, C: 0.5 } }, CTX)).toEqual({ tipo: 'S', s: 10 });
  });

  it('EOQ do F0 usa o cmc do último snapshot ANTERIOR a d; o de hoje só sem snapshot', () => {
    const d = '2026-04-07';
    const dias = diasCorridos('2025-12-01', addDias(d, -1)).filter((_, i) => i % 2 === 0);
    // cmc histórico 50 até 03/2026; HOJE o cmc é 2 (dado do futuro para d)
    const v = dias.map((dia) => ({ ...venda('X', dia, 1), cmcLinha: dia >= '2026-01-15' ? 50 : null }));
    const dd = dados([sku('X', { cmc: 2 })], v, ltSayerlack());
    const g = diagnosticoF0(dd, 'X', d, CTX);
    expect(g.fontePreco).toBe('cmc_anterior');
    expect(g.precoEoq).toBe(50);
    // a conta do EOQ com 50: ceil(√(2·d·252·3 / (0,2575·50)))
    const qc = Math.ceil(Math.sqrt((2 * (g.demanda ?? 0) * 252 * 3) / (0.2575 * 50)));
    expect(g.maxSugerido).toBe((g.ppSugerido ?? 0) + Math.max(qc, 1));
    // antes do 1º snapshot (aquecimento): a cadeia da produção sem preço futuro — venda 180 d × 0,55, nunca o cmc de hoje
    expect(diagnosticoF0(dd, 'X', '2026-01-10', CTX)).toMatchObject({ fontePreco: 'venda_x055', precoEoq: 0.55 });
  });

  // Achado 2 do Codex (contraprova): em 02/02 os SKUs sem snapshot usavam o cmc de HOJE; dobrá-lo mudava o máximo gravado.
  it('dobrar só o cmc de hoje não muda nenhum máximo (nem a sugestão) em dia nenhum', () => {
    // vende de 2 em 2 dias até 10/01 (antes do 1º snapshot de cmc) e volta a vender em março: em fev/2026 não há snapshot
    const dias = diasCorridos(INICIO_AQUECIMENTO, '2026-04-30').filter((x, i) => i % 2 === 0 && (x <= '2026-01-10' || x >= '2026-03-02'));
    const v = dias.map((dia) => ({ ...venda('X', dia, 2, 6), cmcLinha: dia >= '2026-01-15' ? 3 : null }));
    const its = ltSayerlack();
    const a = dados([sku('X', { cmc: 2 })], v, its);
    const b = dados([sku('X', { cmc: 4 })], v, its);
    const dus = diasCorridos('2025-11-20', '2026-04-30').filter((x) => ehDiaUtil(x));
    let comparados = 0;
    for (const d of dus) {
      const ga = diagnosticoF0(a, 'X', d, CTX);
      const gb = diagnosticoF0(b, 'X', d, CTX);
      expect(ga.fontePreco, d).not.toBe('cmc_hoje_fallback');
      expect([gb.maxSugerido, gb.max], d).toEqual([ga.maxSugerido, ga.max]);
      if (ga.maxSugerido !== null) comparados++;
    }
    // controle: há sugestão OK sem snapshot (fevereiro), que é onde o cmc de hoje entrava
    expect(diagnosticoF0(a, 'X', '2026-02-02', CTX)).toMatchObject({ status: 'OK', fontePreco: 'venda_x055' });
    expect(comparados).toBeGreaterThan(50);
  });

  it('preco_compra_real point-in-time: média dos documentos com t4 < d, depois do cmc e antes da venda × 0,55', () => {
    const dias = diasCorridos('2025-12-01', '2026-01-10').filter((_, i) => i % 2 === 0);
    const v = dias.map((dia) => venda('X', dia, 1, 10));
    const dd = dados([sku('X', { cmc: 2 })], v, ltSayerlack(), {
      precosCompra: [{ sku: 'X', desde: '2026-01-05', preco: 4 }, { sku: 'X', desde: '2026-01-08', preco: 6 }, { sku: 'Y', desde: '2026-01-01', preco: 99 }],
    });
    expect(diagnosticoF0(dd, 'X', '2026-01-05', CTX)).toMatchObject({ fontePreco: 'venda_x055', precoEoq: 5.5 }); // t4 = d ainda não é conhecido
    expect(diagnosticoF0(dd, 'X', '2026-01-06', CTX)).toMatchObject({ fontePreco: 'compra_real', precoEoq: 4 });
    expect(diagnosticoF0(dd, 'X', '2026-01-09', CTX)).toMatchObject({ fontePreco: 'compra_real', precoEoq: 5 });
  });
});

describe('cache, paridade e aleatoriedade', () => {
  it('cache invalida quando o código ou os dados mudam', () => {
    const d = '2026-02-03';
    const dias = diasCorridos(INICIO_AQUECIMENTO, d).filter((x) => ehDiaUtil(x));
    const v = dias.filter((_, i) => i % 2 === 0).map((dia) => venda('X', dia, 2));
    const dd = dados([sku('X')], v, ltSayerlack());
    const dir = mkdtempSync(join(tmpdir(), 'replay-cache-'));
    const ctx = { calibracao: true, dias: ['2026-02-02', '2026-02-04'] as [string, string], skus: ['X'] };
    const p: ParamsFormula = { janelaDias: 60, quantil: QUANTIL };
    const r1 = preComputarComOrigem('F3', dd, p, ctx, { cacheDir: dir, hashCodigo: 'c1' });
    expect(r1.origem).toBe('calculado');
    expect(preComputarComOrigem('F3', dd, p, ctx, { cacheDir: dir, hashCodigo: 'c1' }).origem).toBe('memoria');
    const r2 = preComputarComOrigem('F3', { ...dd }, p, ctx, { cacheDir: dir, hashCodigo: 'c1' }); // outro processo: só o disco
    expect(r2.origem).toBe('cache');
    expect([...r2.mapa]).toEqual([...r1.mapa]);
    expect(preComputarComOrigem('F3', dd, p, ctx, { cacheDir: dir, hashCodigo: 'c2' }).origem).toBe('calculado'); // código mudou
    expect(preComputarComOrigem('F3', { ...dd, hashDados: 'h2' }, p, ctx, { cacheDir: dir, hashCodigo: 'c1' }).origem).toBe('calculado'); // dados mudaram
    expect(preComputarComOrigem('F3', { ...dd, dataExtracao: '2026-10-22' }, p, ctx, { cacheDir: dir, hashCodigo: 'c1' }).origem).toBe('calculado'); // extração mudou
    expect(readdirSync(dir).length).toBe(4);
    // a chave cobre cada componente
    const base = { hashDados: 'h', dataExtracao: '2026-10-21', hashCodigo: 'c', formula: 'F2' as const, janelaDias: null, ctx: { calibracao: false, dias: ['a', 'b'] as [string, string], skus: ['X'] } };
    const k = chaveCache(base);
    expect(chaveCache({ ...base, hashCodigo: 'c2' })).not.toBe(k);
    expect(chaveCache({ ...base, hashDados: 'h2' })).not.toBe(k);
    expect(chaveCache({ ...base, dataExtracao: '2026-10-22' })).not.toBe(k);
    expect(chaveCache({ ...base, formula: 'F1' })).not.toBe(k);
    expect(chaveCache({ ...base, ctx: { ...base.ctx, calibracao: true } })).not.toBe(k);
    // hashCodigo cobre os .ts da pasta, sem os testes
    const fontes = fontesDoCodigo();
    expect(fontes.some((f) => f.endsWith('formulas.ts'))).toBe(true);
    expect(fontes.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('preComputar devolve o mesmo que parametrosNoDia, dia a dia', () => {
    const dias = diasCorridos(INICIO_AQUECIMENTO, '2026-03-31').filter((x) => ehDiaUtil(x));
    const v = [...dias.filter((_, i) => i % 3 === 0).map((dia, i) => venda('X', dia, 1 + (i % 4))), ...dias.filter((_, i) => i % 2 === 0).map((dia) => venda('Y', dia, 1))];
    const dd = dados([sku('X'), sku('Y')], v, ltSayerlack());
    const ctx = { calibracao: true, dias: ['2026-03-02', '2026-03-06'] as [string, string], skus: ['X', 'Y'] };
    for (const f of ['F0', 'F1', 'F2', 'F3'] as const) {
      const p: ParamsFormula = { beta: 0.02, janelaDias: 90, quantil: { A: 0.95, B: 0.8, C: 0.9 } };
      const m = preComputarComOrigem(f, dd, p, ctx, SEM_CACHE).mapa;
      expect(m.size).toBe(10);
      for (const s of ['X', 'Y']) for (const dia of ['2026-03-02', '2026-03-04', '2026-03-06']) expect(m.get(`${s}|${dia}`), `${f} ${s} ${dia}`).toEqual(parametrosNoDia(f, dd, s, dia, p, ctx));
    }
  });

  it('tolerância da paridade é max(1, 5%)', () => {
    expect(dentroDaTolerancia(10, 11)).toBe(true);
    expect(dentroDaTolerancia(10, 12)).toBe(false);
    expect(dentroDaTolerancia(100, 105)).toBe(true);
    expect(dentroDaTolerancia(100, 106)).toBe(false);
    expect(dentroDaTolerancia(null, 1)).toBe(false);
  });

  it('uniforme é estável e independe da ordem de chamada', () => {
    const a = uniforme('X', 3, 'b');
    uniforme('outra', 1);
    expect(uniforme('X', 3, 'b')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(uniforme('X', 3, 'c')).not.toBe(a);
  });
});

describe('Fix Codex leva C round 1 — R41 (janela da view) e R43 (LT do F0 da view de produção)', () => {
  const E = '2026-06-01';
  it('R41: a primária lê a view viva — demanda e ordens de hoje−90 até hoje (91 dias) ÷ 90; o cron segue [d−90, d)', () => {
    const vs = [venda('X', addDias(E, -90), 9, 90), venda('X', addDias(E, -10), 3, 30), venda('X', E, 6, 60), venda('X', addDias(E, -200), 1, 10)];
    const dd = dados([sku('X', { grupo: 'outro' })], vs, ltSayerlack());
    const v = sugestaoDaView(dd, 'X', E);
    expect(v.demanda).toBeCloseTo((9 + 3 + 6) / 90, 4);
    expect(v.numOrdens).toBe(3);
    // a passada do dia seguinte (cron, dados < E+1) não vê o dia E−90
    const cron = diagnosticoF0(dd, 'X', addDias(E, 1), CTX);
    expect(cron.demanda).toBeCloseTo((3 + 6) / 90, 4);
    expect(cron.numOrdens).toBe(2);
  });
  it('R43: com ltMotor, o LT do SKU é a média do lt_bruto da produção (t4 < d e t2 >= d − 180), não o dos itens documentais', () => {
    const vs = [venda('X', addDias(E, -30), 2, 20), venda('X', addDias(E, -20), 2, 20), venda('X', addDias(E, -5), 2, 20)];
    const ltMotor = [
      { sku: 'X', fornecedor: 7, t2: '2026-03-02', t4: '2026-03-09', lt: 4 },
      { sku: 'X', fornecedor: 7, t2: '2026-04-01', t4: '2026-04-08', lt: 5 },
      { sku: 'X', fornecedor: 7, t2: '2026-05-04', t4: '2026-05-11', lt: 6 },
      { sku: 'X', fornecedor: 7, t2: '2026-05-25', t4: E, lt: 40 }, // t4 = d: ainda não aconteceu
      { sku: 'X', fornecedor: 7, t2: '2025-11-01', t4: '2025-11-20', lt: 30 }, // t2 antes da janela de 180 d
    ];
    const itens = [3, 3, 3, 3].map((lt, i) => item('X', addDias('2026-02-02', 14 * i), lt)); // documentais: média 3
    const dd = dados([sku('X', { grupo: 'outro' })], vs, itens, { ltMotor });
    expect(diagnosticoF0(dd, 'X', E, CTX).lt).toBe(5);
    // sem ltMotor (fixture antiga), cai nos documentais
    expect(diagnosticoF0(dados([sku('X', { grupo: 'outro' })], vs, itens), 'X', E, CTX).lt).toBe(3);
  });
  it('R43: com < 3 observações do SKU, vale a média do FORNECEDOR do SKU (o maior código na janela), como a view', () => {
    const vs = [venda('Y', addDias(E, -30), 2, 20), venda('Y', addDias(E, -20), 2, 20), venda('Y', addDias(E, -5), 2, 20)];
    const ltMotor = [
      { sku: 'Y', fornecedor: 7, t2: '2026-04-01', t4: '2026-04-08', lt: 5 },
      { sku: 'Z1', fornecedor: 7, t2: '2026-04-02', t4: '2026-04-10', lt: 9 },
      { sku: 'Z2', fornecedor: 7, t2: '2026-04-03', t4: '2026-04-11', lt: 10 },
      { sku: 'W', fornecedor: 8, t2: '2026-04-03', t4: '2026-04-11', lt: 50 }, // outro fornecedor: fora da média
    ];
    const dd = dados([sku('Y', { grupo: 'outro' })], vs, [], { ltMotor });
    expect(diagnosticoF0(dd, 'Y', E, CTX).lt).toBe(8); // (5 + 9 + 10) / 3
    // sem fornecedor no SKU: a view não acha a média do fornecedor (LEFT JOIN com NULL) ⇒ sem LT
    const semForn = ltMotor.map((o) => (o.sku === 'Y' ? { ...o, fornecedor: null } : o));
    expect(diagnosticoF0(dados([sku('Y', { grupo: 'outro' })], vs, [], { ltMotor: semForn }), 'Y', E, CTX).lt).toBeNull();
  });
});

describe('Fix Codex leva D — N3 (consolidação no corte temporal)', () => {
  // Contraprova N3 do Codex: documento de janeiro a preço 1 → máximo F0 de fevereiro 14; com uma cópia de t4 = 10/05 o
  // preço de fevereiro caía no fallback e o máximo virava 7. E a cópia de maio mudava o LT de fevereiro de 40 para 10 du.
  it('N3: a cópia futura de um documento não muda o preço nem o LT do F0 de fevereiro', () => {
    const D = '2026-02-16';
    // vendas também em maio/junho (o SKU segue na view em 15/06); nenhuma antes de 16/02 muda
    const vs = [venda('X', '2026-01-08', 2, 20), venda('X', '2026-01-20', 2, 20), venda('X', '2026-02-05', 2, 20), venda('X', '2026-05-20', 2, 20), venda('X', '2026-06-01', 2, 20)];
    const l = (tr: string, t4: string): RecebLinha => ({
      trackingId: tr, sku: 'X', t1: '2026-01-02', t2: null, t4, pedida: 10, recebida: 10, docId: 'nfe1', unidadeNfe: 'UN', encerradoEm: null, status: 'FATURADO', valor: 10,
    });
    const lt = (t2: string, t4: string, v: number): LinhaLtMotorCrua => ({ doc: 'D', sku: 'X', fornecedor: 7, t2, t4, lt: v });
    const jan = { rec: [l('a', '2026-01-12')], lt: [lt('2026-01-02 10:00:00', '2026-01-12 09:00:00', 40)] };
    const mai = { rec: [...jan.rec, l('b', '2026-05-10')], lt: [...jan.lt, lt('2026-05-01 10:00:00', '2026-05-12 09:00:00', 10)] };
    const dd = (x: typeof jan) => dados([sku('X', { grupo: 'outro' })], vs, [], { precosCompra: precosCompraPorDocumento(x.rec), ltMotor: consolidarLtMotor(x.lt) });
    const a = diagnosticoF0(dd(jan), 'X', D, CTX);
    const b = diagnosticoF0(dd(mai), 'X', D, CTX);
    expect(a.fontePreco).toBe('compra_real');
    expect(a.precoEoq).toBe(1);
    expect(a.lt).toBe(40);
    expect(a.maxSugerido).not.toBeNull();
    expect({ preco: b.precoEoq, lt: b.lt, max: b.maxSugerido, fonte: b.fontePreco }).toEqual({ preco: a.precoEoq, lt: a.lt, max: a.maxSugerido, fonte: a.fontePreco });
    // depois da cópia divergente (LT 10 ≠ 40), a view anula o documento: em junho ele não existe mais; sem ela, segue valendo
    expect(diagnosticoF0(dd(mai), 'X', '2026-06-15', CTX).lt).toBeNull();
    expect(diagnosticoF0(dd(jan), 'X', '2026-06-15', CTX).lt).toBe(40);
  });
});
