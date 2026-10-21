import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { uniforme } from './aleatorio';
import { somarDiasUteis } from './calendario';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import {
  chaveCache,
  diagnosticoF0,
  fontesDoCodigo,
  parametrosNoDia,
  preComputarComOrigem,
  quantilTipo7,
  sigmaDemanda180,
  dentroDaTolerancia,
  type ParamsFormula,
} from './formulas';
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
  classificacaoHist: { regras: REGRAS, porSku: new Map() }, shareInsumo: new Map(), avisos: [], dataExtracao: '2026-10-21', hashDados: 'h1', ...extra,
});
const diasCorridos = (ini: string, fim: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i <= diffDias(ini, fim); i++) out.push(addDias(ini, i));
  return out;
};
const QUANTIL: ParamsFormula['quantil'] = { A: 0.9, B: 0.9, C: 0.9 };
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
    const itsFuturo = [...its, item('X', d, 25), item('X', addDias(d, 10), 28), item('OUTRO', addDias(d, -3), 29)];
    const dd2 = dados([sku('X'), sku('Y')], [...base, ...outro, ...futuro], itsFuturo);
    for (const f of ['F0', 'F1', 'F2', 'F3'] as const) {
      const p: ParamsFormula = { beta: 0.01, janelaDias: 90, quantil: QUANTIL };
      expect(parametrosNoDia(f, dd2, 'X', d, p, CTX), f).toEqual(parametrosNoDia(f, dd, 'X', d, p, CTX));
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
