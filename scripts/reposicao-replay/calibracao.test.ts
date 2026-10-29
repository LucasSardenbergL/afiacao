import { describe, expect, it } from 'vitest';
import { addDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { alvoDaClasse, avaliarNaCalibracao, baseDaCalibracao, buscarTrio, calibrar, escolherCandidata, fillDaCelula, mediaSomas, somarSomas, vereditoDaCalibracao, type ResultadoCalibracao } from './calibracao';
import { documentoSorteado } from './aleatorio';
import { somarDiasUteis } from './calendario';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import { coorte } from './parados';
import { classeEfetiva, validarClasse } from './classe';
import { diagnosticoEstadoInicial } from './reconstrucao';
import {
  anexarInformativa, avaliarCandidata, conferirParamsDoBaseline, ESTADO_DIVERGENTE_PERMITIDO, etapasPreCalibracao, exigirAncoraOmie, exigirGateParidade,
  exigirValidacaoClasse, falhasDoGate, gateParidadePassa, linhaVeredito, montarGate, vereditoComModo, type DivergenciaEstado, type GateParidade,
} from './rodar';
import { avisoAncora, causaOficial, LIMITES, montarRelatorio, TEXTO_GATE_ECONOMIA, tituloSecaoInformativa, tituloVeredito, type Rodada } from './relatorio';
import { ErroDadosReplay } from './tipos';
import { paridadeF0, parametrosNoDia, preComputarComOrigem, sugestaoDaView, type ParamsDia } from './formulas';
import { decidirCompra, simular } from './simulador';
import type { Dados, EventoRecebimento, ItemLT, LinhaVenda, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: 'sayerlack_normal', classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 4, saldoHoje: 0, ativo: true, habilitado: true, unidadeNf: 'L', unidadeEstoque: 'L', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25.75 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
const venda = (linhaId: string, s: string, data: string, quantidade: number): LinhaVenda => ({
  linhaId, sku: s, data, quantidade, valor: quantidade * 10, cmcLinha: 6, noEscopo: true,
});
const item = (trackingId: string, s: string, t1: string, ltDu: number): ItemLT => ({
  trackingId, sku: s, t1, t2: null, t4: somarDiasUteis(t1, ltDu), ltDu, aberto: false,
});
// Estado inicial no modo ÂNCORA (R31, revisão I2): posição medida fixa e saldoHoje FIXO (0) — nada é recalculado a partir
// dos eventos, ao contrário da compensação revogada da R10.
const dados = (skus: Sku[], vendas: LinhaVenda[], itensLT: ItemLT[], recebimentos: EventoRecebimento[], abertura: Record<string, number> = {}): Dados => ({
  vendas, itensLT, recebimentos, skus: new Map(skus.map((s) => [s.sku, s])),
  zPorClasse: { A: 1.65, B: 1.28, C: 0.84 }, teto: { ativa: true, diasB: 90, diasC: 60 }, equivalencias: [], sugestaoHoje: new Map(), excluidos: [],
  classificacaoHist: { regras: REGRAS, porSku: new Map() }, shareInsumo: new Map(), parametrosView: new Map(), avisos: [], dataExtracao: '2026-10-21',
  posicaoAbertura: new Map(Object.entries(abertura)), posicaoConferencia: null, hashDados: 'h',
});

describe('alvo da calibração', () => {
  it('alvo usa F0 quando F0 > piso: 99,6% → 99,35%', () => {
    expect(alvoDaClasse('A', 0.996)).toBeCloseTo(0.9935, 12);
    expect(alvoDaClasse('A', 0.97)).toBe(0.98); // abaixo do piso: o piso manda
    expect(alvoDaClasse('C', null)).toBeNull(); // classe sem linha: não observável
  });
});

describe('grade', () => {
  it('grade acha ótimo não monotônico (múltiplo 2, LTs [1,3,1,1]): escolhe o quantil menor, que atende 3/3', () => {
    // Três vendas unitárias em du seguidos a partir de a (classe C: sem venda antes de 02-01). Documento X (LT 3) a −10 du
    // de a e Y (LT 1) a +11 du: o pedido feito em a sorteia só X; o de a+1, só Y. Múltiplo 2:
    //  · S = 1: estoque 2; a e a+1 atendem; o pedido de a+1 (LT 1) chega em a+2 → 3/3.
    //  · S = 2: em a a posição cai para 1 < 2 e o pedido sai com LT 3 (chega em a+3); em a+1 a posição é 2 (não pede);
    //    a+2 fica sem estoque → 2/3. Nível MAIOR, serviço MENOR.
    const a = '2026-03-03';
    const vs = [venda('l1', 'P', a, 1), venda('l2', 'P', somarDiasUteis(a, 1), 1), venda('l3', 'P', somarDiasUteis(a, 2), 1)];
    const receb: EventoRecebimento[] = [{ sku: 'P', data: '2026-02-02', quantidade: 3 }]; // histórico: reconstrução sem negativo
    const itens = [item('X', 'P', somarDiasUteis(a, -10), 3), item('Y', 'P', somarDiasUteis(a, 11), 1)];
    const dd = dados([sku('P', { multiplo: 2 })], vs, itens, receb, { P: 0 });
    const nivel = (q: number): number => (q < 0.8 ? 0 : q <= 0.9 ? 1 : 2);
    const mapa = (s: number): Map<string, ParamsDia> => {
      const m = new Map<string, ParamsDia>();
      for (let d = INICIO_AQUECIMENTO; d <= JANELAS.calibracaoFim; d = addDias(d, 1)) if (ehDiaUtil(d)) m.set(`P|${d}`, { tipo: 'S', s });
      return m;
    };
    const avaliar = (q: { A: number; B: number; C: number }) => avaliarNaCalibracao(dd, 'F1', mapa(nivel(q.C)), 2);
    // não monotônico de fato
    expect(avaliar({ A: 0.5, B: 0.5, C: 0.85 }).fill.C).toBe(1);
    expect(avaliar({ A: 0.5, B: 0.5, C: 0.999 }).fill.C).toBeCloseTo(2 / 3, 12);
    const r = buscarTrio(avaliar, { A: null, B: null, C: 1 });
    expect(r.inviavel).toBe(false);
    expect(r.quantil.C).toBe(0.8); // menor quantil que atende 3/3 (empate de estoque entre 0,8 / 0,85 / 0,9)
    expect(r.avaliacao.fill.C).toBe(1);
    expect(r.naoObservaveis).toEqual(['A', 'B']);
  });
});

describe('escolha da candidata', () => {
  const res = (formula: 'F1' | 'F2' | 'F3', inviavel: boolean, estoqueMedio: number) => ({ formula, inviavel, estoqueMedio, estoqueF0: 1000, naoObservaveis: [] });
  it('todas inviáveis → NENHUMA e veredito NO-GO INVIAVEL_NA_CALIBRACAO', () => {
    const rs = [res('F1', true, 800), res('F2', true, 700), res('F3', true, 750)];
    expect(escolherCandidata(rs)).toBe('NENHUMA');
    expect(vereditoDaCalibracao(rs)).toEqual({ veredito: 'NO-GO', motivos: ['INVIAVEL_NA_CALIBRACAO'] });
  });
  it('empate favorece o simples', () => {
    // F2 tem o menor estoque; F3 está a 0,9 p.p. de capital (9 de 1000) e F1 a 1,5 p.p. → F3 fica com a vaga
    expect(escolherCandidata([res('F1', false, 715), res('F2', false, 700), res('F3', false, 709)])).toBe('F3');
    // F1 a exatamente 1 p.p. → F1
    expect(escolherCandidata([res('F1', false, 710), res('F2', false, 700), res('F3', false, 709)])).toBe('F1');
    // inviável não disputa, mesmo mais barata
    expect(escolherCandidata([res('F1', false, 760), res('F2', true, 600), res('F3', false, 740)])).toBe('F3');
    expect(vereditoDaCalibracao([res('F1', false, 760)])).toBeNull();
  });
});

/** A divergência PROVADA da R21 (M2), como medida em 28/10. */
const divR21 = (extra: Partial<DivergenciaEstado> = {}): DivergenciaEstado => ({
  sku: '8689783095', dono: '8689783095', replay: 3, qtdeFinal: 2, estado: { pp: 2, max: 3 }, gravado: { pp: 1, max: 2 }, ...extra,
});
/** Gate de paridade como o do dado real de 28/10: estado 5/6 com a única divergência na allowlist; fora da população 7/8. */
const gateOk = (): GateParidade => ({
  es: 1, pp: 0.9916, max: 0.9916, valor: 0.0005, decisao: { n: 14, de: 14 },
  estado: { n: 5, de: 6, divergentes: [divR21()] },
  estadoForaDaPopulacao: { n: 7, de: 8, divergentes: [{ sku: '11892839175', dono: '11892839175', replay: 0, qtdeFinal: 5, estado: { pp: 1, max: 2 }, gravado: { pp: 17, max: 21 } }] },
  status: { n: 134, de: 134 },
  cobertura: { view: { n: 151, de: 152 }, decisao: { n: 14, de: 14 } },
  paramsBaseline: { n: 6, de: 6 },
});

// ── ponta a ponta: alterar a avaliação não muda nada da calibração (spec §5.9), modo âncora, saldoHoje NÃO compensado ───
function cenario(alterarAvaliacao: boolean): Dados {
  const vs: LinhaVenda[] = [];
  const receb: EventoRecebimento[] = [];
  const itens: ItemLT[] = [];
  let k = 0;
  // demanda intermitente em 3 SKUs: ~1 venda a cada 6–11 dias corridos, quantidades 1–4
  for (const [s, passo, fase] of [['P', 6, 0], ['Q', 9, 2], ['R', 11, 4]] as const) {
    for (let d = addDias(INICIO_AQUECIMENTO, fase), i = 0; d <= JANELAS.avaliacaoFim; d = addDias(d, passo + (i % 3)), i++) {
      if (!ehDiaUtil(d)) continue;
      const depois = d > JANELAS.calibracaoFim;
      const q = 1 + ((i * 7 + s.charCodeAt(0)) % 4) + (alterarAvaliacao && depois ? 5 : 0);
      vs.push(venda(`${s}${k++}`, s, d, q));
      if (alterarAvaliacao && depois && i % 2 === 0) vs.push(venda(`${s}x${k++}`, s, d, 3)); // linhas novas na avaliação
    }
  }
  // documentos de LT a cada ~15 du, 2 itens cada; posteriores à calibração mudam de LT no cenário alterado
  for (let t1 = '2025-11-03', j = 0; t1 <= '2026-10-01'; t1 = somarDiasUteis(t1, 15), j++) {
    const lt = 4 + (j % 5);
    const t4 = somarDiasUteis(t1, lt);
    const ltFinal = alterarAvaliacao && t4 > JANELAS.calibracaoFim ? lt + 9 : lt;
    itens.push(item(`D${j}`, 'P', t1, ltFinal), item(`D${j}`, 'Q', t1, ltFinal + 1));
    receb.push({ sku: 'P', data: somarDiasUteis(t1, ltFinal), quantidade: 6 }, { sku: 'Q', data: somarDiasUteis(t1, ltFinal + 1), quantidade: 4 });
  }
  // review I-1: documentos com t1 nos últimos du da calibração e t4 > 30/04 (sorteáveis por pedidos de abril se o filtro
  // da calibração vazar); no cenário alterado o LT deles muda (continua > 30/04)
  for (const [j, t1] of ['2026-04-20', '2026-04-22', '2026-04-24', '2026-04-27', '2026-04-28'].entries()) {
    const lt = alterarAvaliacao ? 22 : 9;
    itens.push(item(`L${j}`, 'P', t1, lt), item(`L${j}`, 'Q', t1, lt));
    receb.push({ sku: 'P', data: somarDiasUteis(t1, lt), quantidade: 6 }, { sku: 'Q', data: somarDiasUteis(t1, lt), quantidade: 4 });
  }
  if (alterarAvaliacao) receb.push({ sku: 'R', data: '2026-07-15', quantidade: 40 }); // recebimento novo na avaliação
  // CMC da avaliação muda no cenário alterado (vendas posteriores a 30/04 e o cmc de hoje)
  if (alterarAvaliacao) for (const v of vs) if (v.data > JANELAS.calibracaoFim) v.cmcLinha = 9;
  receb.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.sku < b.sku ? -1 : 1));
  const cmc = alterarAvaliacao ? 7 : 4;
  const skus = [sku('P', { multiplo: 2, cmc }), sku('Q', { cmc }), sku('R', { cmc })];
  return dados(skus, vs, itens, receb, { P: 12, Q: 8, R: 30 });
}

describe('invariância', () => {
  it('calibração invariante à avaliação de ponta a ponta', () => {
    const roda = (dd: Dados) => {
      const rs = (['F1', 'F2', 'F3'] as const).map((f) => calibrar(dd, f, { reps: 3, cacheDir: null }));
      return { rs, cand: escolherCandidata(rs) };
    };
    const base = roda(cenario(false));
    const alterado = roda(cenario(true));
    const resumo = (r: ResultadoCalibracao) => ({ f: r.formula, params: r.params, inviavel: r.inviavel, estoque: r.estoqueMedio, alvo: r.alvo, fill: r.fill, tentativas: r.tentativas });
    expect(alterado.rs.map(resumo)).toEqual(base.rs.map(resumo));
    expect(alterado.cand).toBe(base.cand);
    // sanidade (senão o teste é cego): há SKUs que trocam de fórmula, a busca saiu do quantil máximo e a avaliação mudou
    expect(coorte(cenario(false)).alterados.size).toBeGreaterThan(0);
    expect(base.rs.some((r) => Object.values(r.params.quantil).some((q) => q < 0.999))).toBe(true);
    expect(cenario(true).vendas.length).toBeGreaterThan(cenario(false).vendas.length);
    // os documentos tardios (t4 > 30/04) são alcançáveis pelo sorteio de abril se o filtro da calibração vazar
    const dd = cenario(false);
    let alcancado = false;
    for (let d = '2026-04-13'; d <= JANELAS.calibracaoFim && !alcancado; d = addDias(d, 1)) {
      if (!ehDiaUtil(d)) continue;
      for (let rep = 0; rep < 3; rep++) if (documentoSorteado(rep, d, dd.itensLT).trackingId.startsWith('L')) alcancado = true;
    }
    expect(alcancado).toBe(true);
  }, 120_000);
});

// ── avaliação com a candidata congelada (rodar.ts), contratos da revisão da T8 ──────────────────────────────────────
describe('avaliação (rodar.ts)', () => {
  it('R25: capital nos 3 cenários; R26: só a taxa de 25% no gate; Clopper-Pearson com as linhas OBSERVADAS', async () => {
    const dd = cenario(false);
    const reps = 3;
    const r = await avaliarCandidata(dd, '/inexistente', { candidata: 'F1', params: { quantil: { A: 0.9, B: 0.9, C: 0.9 } } }, null, { paralelo: 1, tetoReps: reps, cacheDir: null });
    const ev = r.avaliacao.blocos;
    expect(r.avaliacao.reps).toBe(reps);
    expect(ev.capital.map((c) => c.falta)).toEqual(['espera', 'cancelamento', 'misto']);
    expect(ev.estresse.capital.map((c) => c.falta)).toEqual(['espera', 'cancelamento', 'misto']);
    expect(ev.economia).toHaveLength(27);
    expect(ev.economia.every((e) => e.grade.taxa === 0.25)).toBe(true);
    expect(r.avaliacao.sensibilidadeTaxa).toHaveLength(54);
    expect(new Set(r.avaliacao.sensibilidadeTaxa.map((e) => e.grade.taxa))).toEqual(new Set([0.2, 0.3]));
    // linhas observadas na avaliação (uma vez, não × reps)
    const pop = coorte(dd).populacao;
    const observadas = dd.vendas.filter((v) => pop.has(v.sku) && v.quantidade > 0 && v.data >= JANELAS.avaliacaoIni && v.data <= JANELAS.avaliacaoFim).length;
    for (const sv of ev.servico) {
      const dem = sv.pisos.reduce((t, p) => t + (p.demandadas ?? 0), 0);
      expect(dem).toBe(observadas);
      for (const p of sv.pisos) {
        if (p.demandadas === null) continue;
        expect(p.atendidas).toBeCloseTo((p.fill[4].ponto as number) * p.demandadas, 9);
        expect(p.atendidas!).toBeLessThanOrEqual(p.demandadas);
      }
    }
    expect(r.avaliacao.nulos.length).toBeGreaterThan(0);
    expect(['GO', 'NO-GO', 'INCONCLUSIVO']).toContain(r.veredito.veredito);
    // M-3: teto de replicações reduzido ⇒ a linha Precisão NUNCA passa (rodada incompleta não aprova)
    const prec = r.avaliacao.criterios.find((c) => c.criterio === 'Precisão');
    expect(prec?.estado).toBe('INCERTO');
    expect(prec?.motivo).toMatch(/^3 replicações/);
  }, 300_000);
});

describe('fix round 1', () => {
  it('I-2: inviável só se NENHUM trio avaliado atinge as três classes (a descida pode terminar num trio que falha)', () => {
    // baixar C derruba A (efeito cruzado); B e C sempre atingem; estoque = soma dos quantis
    const avaliar = (q: { A: number; B: number; C: number }) => ({ fill: { A: q.C >= 0.9 ? 1 : 0.5, B: 1, C: 1 }, estoque: q.A + q.B + q.C });
    const r = buscarTrio(avaliar, { A: 0.99, B: 0.99, C: 0.99 });
    // a descida termina em (0,5; 0,5; 0,5), que falha em A; (0,5; 0,5; 0,9) foi avaliado e passa nas três
    expect(r.inviavel).toBe(false);
    expect(r.quantil).toEqual({ A: 0.5, B: 0.5, C: 0.9 });
    expect(r.avaliacao.fill.A).toBe(1);
  });
  it('I-2: nenhum trio atinge → inviável', () => {
    const r = buscarTrio(() => ({ fill: { A: 0.5, B: 1, C: 1 }, estoque: 1 }), { A: 0.99, B: 0.99, C: 0.99 });
    expect(r.inviavel).toBe(true);
  });
  it('I-3: gate de paridade em FALHA lança erro de dado (rc ≠ 0), nunca segue para o veredito', () => {
    const ok = gateOk();
    expect(gateParidadePassa(ok)).toBe(true);
    expect(() => exigirGateParidade(ok)).not.toThrow();
    for (const ruim of [{ ...ok, max: 0.94 }, { ...ok, valor: 0.021 }, { ...ok, valor: null }, { ...ok, decisao: { n: 7, de: 8 } }, { ...ok, decisao: { n: 0, de: 0 } }]) {
      expect(gateParidadePassa(ruim)).toBe(false);
      expect(() => exigirGateParidade(ruim)).toThrow(ErroDadosReplay);
      expect(() => exigirGateParidade(ruim)).toThrow(/^GATE_PARIDADE_FALHA/);
    }
  });
});

// ── R27: rodada informativa (alvo nas células *_alt) sem mexer no caminho oficial ───────────────────────────────────
describe('R27 — modo informativo', () => {
  it('caminho oficial não muda (snapshot do veredito oficial na fixture)', () => {
    const dd = cenario(false);
    const rs = (['F1', 'F2', 'F3'] as const).map((f) => calibrar(dd, f, { reps: 3, cacheDir: null }));
    const got = { rs: rs.map((r) => ({ f: r.formula, params: r.params, inviavel: r.inviavel, estoque: r.estoqueMedio, alvo: r.alvo })), cand: escolherCandidata(rs), v: vereditoDaCalibracao(rs) };
    // recapturado no achado 7 do Codex (leva B): célula e quantil pela classe do DIA mudam o trio (causa isolada revertendo
    // só a classe do dia); o modo informativo continua sem mexer no caminho oficial
    expect(got).toEqual(JSON.parse(
      "{\"rs\":[{\"f\":\"F1\",\"params\":{\"quantil\":{\"A\":0.5,\"B\":0.999,\"C\":0.999}},\"inviavel\":false,\"estoque\":208.02247191011236,\"alvo\":{\"A\":0.9975,\"B\":null,\"C\":0.9975}},{\"f\":\"F2\",\"params\":{\"beta\":0.005,\"quantil\":{\"A\":0.5,\"B\":0.999,\"C\":0.995}},\"inviavel\":false,\"estoque\":206.76404494382024,\"alvo\":{\"A\":0.9975,\"B\":null,\"C\":0.9975}},{\"f\":\"F3\",\"params\":{\"janelaDias\":90,\"quantil\":{\"A\":0.999,\"B\":0.999,\"C\":0.8}},\"inviavel\":true,\"estoque\":180.47191011235955,\"alvo\":{\"A\":0.9975,\"B\":null,\"C\":0.9975}}],\"cand\":\"F1\",\"v\":{\"veredito\":\"INCONCLUSIVO\",\"motivos\":[\"CLASSE_NAO_OBSERVAVEL_NA_CALIBRACAO:B\"]}}"
    ));
  }, 120_000);

  it("modo 'alt' mede o alvo nas células *_alt (só os alterados entram)", () => {
    const dd = cenario(false);
    const c = coorte(dd);
    const suaves = [...c.populacao].filter((s) => !c.alterados.has(s));
    expect(suaves.length).toBeGreaterThan(0); // senão o teste é cego
    const base = baseDaCalibracao(dd, { reps: 3, cacheDir: null, celulasAlvo: 'alt' });
    for (const k of base.f0Mapa.keys()) expect(c.alterados.has(k.slice(0, k.indexOf('|')))).toBe(true);
    // referência independente: o F0 oficial (coorte inteira) lido nas células *_alt
    const oficial = baseDaCalibracao(dd, { reps: 3, cacheDir: null });
    const ref = avaliarNaCalibracao(dd, 'F0', oficial.f0Mapa, 3).somas;
    for (const cl of ['A', 'B', 'C'] as const) expect(base.alvo[cl]).toBe(alvoDaClasse(cl, fillDaCelula(ref, `${cl}_alt`)));
    const r = calibrar(dd, 'F1', { reps: 3, cacheDir: null, celulasAlvo: 'alt' });
    expect(r.alvo).toEqual(base.alvo);
    expect(r.celulasAlvo).toBe('alt');
  }, 120_000);

  it("avaliação informativa: só a população alterada é simulada (células = *_alt)", async () => {
    const dd = cenario(false);
    const c = coorte(dd);
    const r = await avaliarCandidata(dd, '/inexistente', { candidata: 'F1', params: { quantil: { A: 0.9, B: 0.9, C: 0.9 } }, celulasAlvo: 'alt' }, null, { paralelo: 1, tetoReps: 2, cacheDir: null });
    const lin = dd.vendas.filter((v) => c.alterados.has(v.sku) && v.quantidade > 0 && v.data >= JANELAS.avaliacaoIni && v.data <= JANELAS.avaliacaoFim).length;
    const ex = r.avaliacao.blocos.exposicao;
    const soma = (cs: string[]) => ex.filter((x) => cs.includes(x.celula)).reduce((t, x) => t + (x.linhas ?? 0), 0);
    expect(soma(['A', 'B', 'C'])).toBe(lin);
    expect(soma(['A_alt', 'B_alt', 'C_alt'])).toBe(lin);
  }, 300_000);
});

describe('fix round 2 (relatório e orquestração)', () => {
  const diag = (suaves: number) => ({
    fillF0A: { total: 0.935, alterados: 0.95, suaves, linhasAlterados: 287, linhasSuaves: 416 },
    semanalA: [], demandaA: [], lt: { desde: '2026-03-16', pedidos: 0, sorteadoMedio: null, parametroMedio: null },
    real: { estoqueReal: 2, estoqueF0: 1, recebidoReal: 2, recebidoF0: 1 },
  });
  it('I-novo-1: o título da seção 11 interpola o veredito OFICIAL real', () => {
    expect(tituloSecaoInformativa('NO-GO')).toContain('o veredito oficial é o NO-GO acima');
    expect(tituloSecaoInformativa('INCONCLUSIVO')).toContain('o veredito oficial é o INCONCLUSIVO acima');
    expect(tituloSecaoInformativa('GO')).not.toContain('NO-GO');
  });
  it('M-2: o subtítulo do veredito da rodada informativa diz NÃO OFICIAL', () => {
    expect(tituloVeredito('NO-GO', false)).toMatch(/NÃO OFICIAL/);
    expect(tituloVeredito('NO-GO', true)).not.toMatch(/NÃO OFICIAL/);
  });
  it('M-4: a causa só é atribuída à régua se os suaves ficam abaixo do piso de A; senão, texto neutro', () => {
    const v = { veredito: 'NO-GO' as const, motivos: ['INVIAVEL_NA_CALIBRACAO'] };
    expect(causaOficial({ veredito: v, diagnostico: diag(0.9249) }).join(' ')).toMatch(/decorre da régua/);
    const neutro = causaOficial({ veredito: v, diagnostico: diag(0.985) }).join(' ');
    expect(neutro).not.toMatch(/decorre da régua/);
    expect(neutro).toMatch(/INVIAVEL_NA_CALIBRACAO/);
    expect(causaOficial({ veredito: { veredito: 'GO', motivos: [] }, diagnostico: diag(0.9) })).toEqual([]);
  });
  it('M-1: exceção na informativa não impede o relatório oficial (gravado antes) e fica registrada', async () => {
    const gravados: { informativo: unknown; informativoErro: string | null }[] = [];
    const oficial = { informativo: null, informativoErro: null } as unknown as Rodada;
    const r = await anexarInformativa(oficial, async () => { throw new Error('boom'); }, (x) => gravados.push({ informativo: x.informativo, informativoErro: x.informativoErro }));
    expect(gravados[0]).toEqual({ informativo: null, informativoErro: null }); // oficial gravado ANTES da informativa
    expect(r.informativoErro).toMatch(/boom/);
    expect(gravados.at(-1)?.informativoErro).toMatch(/boom/);
    const ok = await anexarInformativa({ informativo: null, informativoErro: null } as unknown as Rodada, async () => ({ marcador: 1 }) as never, () => {});
    expect(ok.informativo).toEqual({ marcador: 1 });
  });
});

describe('revisão final (relatório)', () => {
  it('I1: o texto do gate do critério 5 descreve o misto 60% espera / 30% emergencial / 10% cancelamento', () => {
    expect(TEXTO_GATE_ECONOMIA).toContain('60% espera');
    expect(TEXTO_GATE_ECONOMIA).toContain('30% compra emergencial');
    expect(TEXTO_GATE_ECONOMIA).toContain('10% cancelamento');
  });
  it('Minor 3: os limites declaram R10, R11, R17 e as compras abertas vazias no início', () => {
    const t = LIMITES.join('\n');
    for (const x of ['R10', 'R11', '312/238', '373/276', 'R17', '14 legítimos', '36 órfãos', 'compras abertas no início']) expect(t).toContain(x);
  });
});

describe('Fix Codex leva C (minors da revisão B)', () => {
  it('M5 (achado 3 ponta a ponta): preComputar × simular — os pedidos até 30/04 são os mesmos na calibração e na avaliação', () => {
    const calib = cenario(false);
    const aval = cenario(true); // a avaliação ainda muda vendas, LT e CMC depois de 30/04
    for (const [f, p] of [['F0', { quantil: { A: 0.95, B: 0.95, C: 0.95 } }], ['F1', { quantil: { A: 0.9, B: 0.95, C: 0.97 } }]] as const) {
      const mc = preComputarComOrigem(f, calib, p, { calibracao: true }, { cacheDir: null }).mapa;
      const ma = preComputarComOrigem(f, aval, p, { calibracao: false }, { cacheDir: null }).mapa;
      for (let rep = 0; rep < 3; rep++) {
        const base = { formula: f, rep, lt: 'empirico' as const, falta: 'espera' as const, inicial: 'reconstruido' as const, rastro: true };
        const c = simular({ ...base, params: mc, janela: [JANELAS.calibracaoIni, JANELAS.calibracaoFim], dados: calib });
        const a = simular({ ...base, params: ma, janela: [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim], dados: aval });
        const ate = (x: typeof c) => (x.pedidos ?? []).filter((q) => q.dia <= JANELAS.calibracaoFim);
        const pc = ate(c);
        const pa = ate(a);
        expect(pc.length).toBeGreaterThan(5); // senão o teste é cego
        expect(pa.map((q) => [q.dia, q.sku, q.qtd])).toEqual(pc.map((q) => [q.dia, q.sku, q.qtd]));
        // a chegada é a mesma; na calibração, a que cai depois de 30/04 fica fora do horizonte (null)
        pc.forEach((q, i) => expect(q.chegada === null ? pa[i].chegada! > JANELAS.calibracaoFim : pa[i].chegada === q.chegada).toBe(true));
        expect(pc.some((q) => q.dia >= '2026-04-01')).toBe(true);
      }
    }
  }, 300_000);

  it('M4: somarSomas e mediaSomas agregam as obrigações herdadas (média das reps, não a rep 0)', () => {
    const dd = cenario(false);
    const m = preComputarComOrigem('F0', dd, { quantil: { A: 0.95, B: 0.95, C: 0.95 } }, { calibracao: false }, { cacheDir: null }).mapa;
    const s0 = simular({ formula: 'F0', params: m, rep: 0, lt: 'empirico', falta: 'espera', inicial: 'reconstruido', janela: [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim], dados: dd });
    const a = structuredClone(s0);
    const b = structuredClone(s0);
    a.herdadas = { abertura: { unidades: 2, valor: 20 }, entregue: { unidades: 1, valor: 10 }, terminal: { unidades: 1, valor: 10 } };
    b.herdadas = { abertura: { unidades: 6, valor: 60 }, entregue: { unidades: 6, valor: 60 }, terminal: { unidades: 0, valor: 0 } };
    a.estoqueNaoValoradoDias = a.estoqueNaoValoradoDias.map(() => 2);
    b.estoqueNaoValoradoDias = b.estoqueNaoValoradoDias.map(() => 4);
    const med = mediaSomas(somarSomas(somarSomas(null, a), b), 2);
    expect(med.herdadas).toEqual({ abertura: { unidades: 4, valor: 40 }, entregue: { unidades: 3.5, valor: 35 }, terminal: { unidades: 0.5, valor: 5 } });
    expect(med.estoqueNaoValoradoDias.every((x) => x === 3)).toBe(true);
    expect(med.estoqueCmcDias).toEqual(s0.estoqueCmcDias.map((x) => (x + x) / 2));
  }, 120_000);
});

describe('Fix Codex leva C — gate de paridade (achado 8), classe (achado 14) e âncora (R30)', () => {
  it('achado 8: estado {n:0, de:8} reprova (contraprova do Codex)', () => {
    const outros = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((sku) => divR21({ sku, dono: sku }));
    const g = { ...gateOk(), estado: { n: 0, de: 8, divergentes: outros } };
    expect(gateParidadePassa(g)).toBe(false);
    expect(() => exigirGateParidade(g)).toThrow(/^GATE_PARIDADE_FALHA/);
    expect(falhasDoGate(g).join(' ')).toMatch(/ESTADO_DIVERGENTE_FORA_DA_ALLOWLIST/);
  });
  it('achado 8 + M2: só passa a divergência PROVADA da R21 (mesmo SKU e mesmo par de PP/máximo), nunca o SKU inteiro', () => {
    expect(Object.keys(ESTADO_DIVERGENTE_PERMITIDO)).toEqual(['8689783095']);
    expect(ESTADO_DIVERGENTE_PERMITIDO['8689783095'].justificativa).toMatch(/R21/);
    expect(gateParidadePassa(gateOk())).toBe(true);
    const com = (d: DivergenciaEstado) => ({ ...gateOk(), estado: { n: 5, de: 6, divergentes: [d] } });
    expect(gateParidadePassa(com(divR21({ estado: { pp: 4, max: 6 } })))).toBe(false); // o replay mudou: outra divergência
    expect(gateParidadePassa(com(divR21({ gravado: { pp: 3, max: 5 } })))).toBe(false); // a produção mudou
    expect(gateParidadePassa(com(divR21({ estado: null })))).toBe(false);
    expect(gateParidadePassa(com(divR21({ sku: '1234', dono: '1234' })))).toBe(false); // outro SKU, mesmo par
    expect(gateParidadePassa({ ...gateOk(), estado: { n: 4, de: 6, divergentes: [divR21()] } })).toBe(false); // incoerente
    expect(gateParidadePassa({ ...gateOk(), estado: { n: 0, de: 0, divergentes: [] } })).toBe(false);
  });
  it('R42: divergência de estado de dono FORA da população simulada é informativa (não reprova); a decisão continua em todas', () => {
    const g = gateOk();
    expect(g.estadoForaDaPopulacao.divergentes).toHaveLength(1);
    expect(gateParidadePassa(g)).toBe(true);
    expect(gateParidadePassa({ ...g, decisao: { n: 13, de: 14 } })).toBe(false);
  });
  it('achado 8: status, cobertura e os parâmetros do baseline também reprovam', () => {
    const casos: [string, Partial<GateParidade>][] = [
      ['STATUS', { status: { n: 120, de: 134 } }],
      ['STATUS', { status: null }],
      ['COBERTURA_VIEW', { cobertura: { view: { n: 140, de: 152 }, decisao: { n: 14, de: 14 } } }],
      ['COBERTURA_DECISAO', { cobertura: { view: { n: 151, de: 152 }, decisao: { n: 13, de: 14 } } }],
      ['PARAMS_BASELINE', { paramsBaseline: { n: 5, de: 6 } }],
      ['PARAMS_BASELINE', { paramsBaseline: { n: 0, de: 0 } }],
    ];
    for (const [marca, ruim] of casos) {
      const g = { ...gateOk(), ...ruim };
      expect(falhasDoGate(g).some((f) => f.startsWith(marca))).toBe(true);
      expect(() => exigirGateParidade(g)).toThrow(ErroDadosReplay);
    }
  });
  it('M3: conferirParamsDoBaseline exige o mapa do gate idêntico ao do baseline em TODOS os dias úteis simulados', () => {
    const dd = cenario(false);
    const p = { quantil: { A: 0.95, B: 0.95, C: 0.95 } };
    const base = preComputarComOrigem('F0', dd, p, { calibracao: false }, { cacheDir: null }).mapa;
    const gate = preComputarComOrigem('F0', dd, p, { calibracao: false, dias: [INICIO_AQUECIMENTO, dd.dataExtracao], skus: ['P', 'Q', 'R'] }, { cacheDir: null }).mapa;
    expect(conferirParamsDoBaseline(base, gate, ['P', 'Q', 'R'])).toEqual({ n: 3, de: 3 });
    const meio = [...base.keys()].filter((k) => k.startsWith('Q|')).sort()[50];
    const adulterado = new Map(gate);
    adulterado.set(meio, { tipo: 'S', s: 999 });
    expect(conferirParamsDoBaseline(base, adulterado, ['P', 'Q', 'R'])).toEqual({ n: 2, de: 3 });
    adulterado.delete(meio);
    expect(conferirParamsDoBaseline(base, adulterado, ['P', 'Q', 'R'])).toEqual({ n: 2, de: 3 }); // ausente = diverge
    expect(conferirParamsDoBaseline(base, gate, ['NAO_SIMULADO'])).toEqual({ n: 0, de: 1 });
  });
  it('M3: montarGate decide com os parâmetros do dia da DECISÃO (a extração, dia de SP), separa a população e lista as divergências', () => {
    const dd = cenario(false);
    // venda grande de P na véspera da extração: os parâmetros do dia da extração diferem dos do fim da avaliação
    dd.vendas.push(venda('Pv', 'P', '2026-10-20', 40));
    dd.skus.set('FORA', sku('FORA', { hoje: { es: 1, pp: 5, max: 9 } }));
    const p = { quantil: { A: 0.95, B: 0.95, C: 0.95 } };
    const dP = parametrosNoDia('F0', dd, 'P', dd.dataExtracao, p, { calibracao: false });
    const dPvespera = parametrosNoDia('F0', dd, 'P', '2026-10-20', p, { calibracao: false });
    expect(dP).not.toEqual(dPvespera); // senão o teste é cego à data
    const qP = decidirCompra(dP, 0, dd.skus.get('P')!);
    dd.sugestaoHoje = new Map([
      ['P', { posicao: 0, qtdeFinal: qP }],
      ['Q', { posicao: 0, qtdeFinal: 777 }],
      ['FORA', { posicao: 0, qtdeFinal: 777 }],
    ]);
    const r = montarGate(dd, { cacheDir: null });
    expect(r.paramsDecisao.get('P')).toEqual(dP);
    expect(r.gate.estado.de).toBe(2);
    expect(r.gate.estado.divergentes.map((x) => x.sku)).toEqual(['Q']);
    const q = r.gate.estado.divergentes[0];
    const pq = r.paramsDecisao.get('Q')!;
    expect(q.estado).toEqual(pq.tipo === 'F0' ? { pp: pq.pp, max: pq.max } : null);
    expect(r.gate.estadoForaDaPopulacao).toMatchObject({ n: 0, de: 1 });
    expect(r.gate.estadoForaDaPopulacao.divergentes[0]).toMatchObject({ sku: 'FORA', gravado: { pp: 5, max: 9 } });
    expect(r.gate.paramsBaseline).toEqual({ n: 2, de: 2 });
    expect(r.gate.cobertura.decisao).toEqual({ n: 3, de: 3 });
  });
  it('achado 8: a cobertura da view compara a presença do SKU na view de produção com a do replay', () => {
    const dd = cenario(false);
    const r = paridadeF0(dd);
    const esperado = [...coorte(dd).populacao].filter((s) => !sugestaoDaView(dd, s, dd.dataExtracao).naView).length;
    expect(r.presencaNaView).toEqual({ n: esperado, de: coorte(dd).populacao.size });
    expect(esperado).toBeLessThan(coorte(dd).populacao.size); // a fixture não tem view: só concorda quem o replay tira dela
  });
  it('achado 14: divergência de classe > 5% do valor A interrompe; sem valor A também (ausente ≠ 0)', () => {
    const v = (a: number | null) => ({ porClasse: { A: a, B: 0, C: 0 }, valorADivergente: a, detalhe: { skusComparados: 10, skusSemClasseReconstruida: 0, skusDivergentes: 1, skusDivergentesNaClasseA: 1 } });
    expect(() => exigirValidacaoClasse(v(4.99))).not.toThrow();
    expect(() => exigirValidacaoClasse(v(5))).not.toThrow();
    expect(() => exigirValidacaoClasse(v(5.01))).toThrow(/^CLASSE_DIVERGENTE/);
    expect(() => exigirValidacaoClasse(v(5.01))).toThrow(ErroDadosReplay);
    expect(() => exigirValidacaoClasse(v(null))).toThrow(/^CLASSE_DIVERGENTE/);
  });
  it('N1: os limites declaram por extenso R29, R34 e R35 (encerramento de hoje; tracking contaminado igual nos dois braços) e os rulings da leva B', () => {
    const t = LIMITES.join('\n');
    for (const x of ['R29', 'R34', 'estado de HOJE do Omie', 'R35', 'pesa igual nos dois braços', 'R36', 'R37', 'R38', 'R39', 'desde o início do aquecimento', 'capturas de preço-app até a extração', 'achado 11', 'achado 12', 'achado 10']) {
      expect(t).toContain(x);
    }
    expect(t).not.toContain('limitada a [0, valor]'); // R24 revogada
    expect(t).not.toContain('entra uma vez, não é reamostrado'); // achado 12
  });
  it('R30: sem a posição Omie a rodada oficial para; o legado só com --informativo-saldo-hoje e rotulado não oficial', () => {
    const ancorado = cenario(false);
    const legado = { ...cenario(false), posicaoAbertura: null };
    expect(exigirAncoraOmie(ancorado, false)).toBe('oficial');
    expect(exigirAncoraOmie(ancorado, true)).toBe('oficial');
    expect(() => exigirAncoraOmie(legado, false)).toThrow(/^ANCORA_OMIE_AUSENTE/);
    expect(() => exigirAncoraOmie(legado, false)).toThrow(ErroDadosReplay);
    expect(exigirAncoraOmie(legado, true)).toBe('nao_oficial_saldo_hoje');
    expect(avisoAncora('nao_oficial_saldo_hoje').join(' ')).toMatch(/NÃO OFICIAL/);
    expect(avisoAncora('oficial')).toEqual([]);
  });
});

describe('Fix Codex leva C round 1 — I1 (legado nunca com cara de oficial) e M1 (fiação da pré-calibração)', () => {
  const rodada = (modo: 'oficial' | 'nao_oficial_saldo_hoje'): Rodada => {
    const dd = cenario(false);
    return {
      geradoEm: '2026-10-29T00:00:00Z', nomeMetrica: 'atendimento', chave: {},
      coorte: { populacao: 3, alterados: 1, todos: 3, excluidosInsumo: [] },
      paridade: { f0: paridadeF0(dd), quantidade: { linhas: [], replay: { n: 0, de: 0 }, gravado: { n: 0, de: 0 } }, gate: gateOk(), gatePassa: true, allowlistEstado: ESTADO_DIVERGENTE_PERMITIDO },
      modoAncora: modo, validacaoClasse: validarClasse(dd),
      calibracao: { alvo: { A: 0.98, B: 0.95, C: 0.9 }, fillF0: { A: 0.99, B: 0.96, C: 0.95 }, resultados: [], candidata: 'NENHUMA' },
      fronteira: [], excluidosDados: [], avisos: [], parados: [], negativos: [], estadoInicial: diagnosticoEstadoInicial(dd),
      congelado: null, veredito: vereditoComModo({ veredito: 'GO', motivos: [] }, modo), avaliacao: null, diagnostico: null,
      informativo: null, informativoErro: null, tempos: {}, segundos: 0,
    };
  };
  it('I1: no modo legado a seção 1 sai NÃO OFICIAL, a 11 não fala em veredito oficial e o veredito carrega o modo', () => {
    const r = rodada('nao_oficial_saldo_hoje');
    expect(r.veredito.modo).toBe('nao_oficial_saldo_hoje');
    const t = montarRelatorio(r);
    expect(t).not.toMatch(/^## 1\. Veredito: \*\*/m);
    expect(t).toMatch(/^## 1\. Veredito NÃO OFICIAL \(R30, âncora no saldo de hoje\): \*\*GO\*\*$/m);
    expect(t).toMatch(/^# Replay TSB .*NÃO OFICIAL/m);
    expect(t).not.toMatch(/veredito oficial/i);
    const s11 = t.split('\n').find((l) => l.startsWith('## 11.'))!;
    expect(s11).toMatch(/NÃO OFICIAL \(R30/);
    expect(linhaVeredito('GO', 'nao_oficial_saldo_hoje')).toMatch(/^VEREDITO NÃO OFICIAL \(R30/);
  });
  it('I1 (controle): no modo oficial, título e seção 11 oficiais e o log sem rótulo', () => {
    const t = montarRelatorio(rodada('oficial'));
    expect(t).toMatch(/^## 1\. Veredito: \*\*GO\*\*$/m);
    expect(t.split('\n').find((l) => l.startsWith('## 11.'))).toContain('o veredito oficial é o GO acima');
    expect(linhaVeredito('GO', 'oficial')).toBe('VEREDITO GO');
  });
  it('M1: a pré-calibração roda âncora → classe → gate, nesta ordem, e para em cada uma', () => {
    const semLog = { informativoSaldoHoje: false, cacheDir: null, log: () => {} };
    expect(() => etapasPreCalibracao({ ...cenario(false), posicaoAbertura: null }, semLog)).toThrow(/^ANCORA_OMIE_AUSENTE/);
    // classe de hoje oposta à recalculada: a validação para ANTES do gate
    const div = cenario(false);
    const ef = classeEfetiva(div, div.dataExtracao);
    for (const [k, s] of div.skus) div.skus.set(k, { ...s, classeAbcHoje: (ef.get(k) ?? 'C') === 'A' ? 'C' : 'A' });
    const l1: string[] = [];
    expect(() => etapasPreCalibracao(div, { ...semLog, log: (m) => l1.push(m) })).toThrow(/^CLASSE_DIVERGENTE/);
    expect(l1.some((m) => m.startsWith('GATE_PARIDADE'))).toBe(false);
    // classe de hoje = a recalculada: passa da classe e chega ao gate (que reprova na fixture: sem sugestao_hoje)
    const ok = cenario(false);
    const ef2 = classeEfetiva(ok, ok.dataExtracao);
    for (const [k, s] of ok.skus) ok.skus.set(k, { ...s, classeAbcHoje: ef2.get(k) ?? null });
    expect(validarClasse(ok).valorADivergente).toBe(0); // senão o controle é cego
    const l2: string[] = [];
    expect(() => etapasPreCalibracao(ok, { ...semLog, log: (m) => l2.push(m) })).toThrow(/^GATE_PARIDADE_FALHA/);
    const iClasse = l2.findIndex((m) => m.startsWith('VALIDAÇÃO DE CLASSE'));
    const iGate = l2.findIndex((m) => m.startsWith('GATE_PARIDADE'));
    expect(iClasse).toBeGreaterThanOrEqual(0);
    expect(iGate).toBeGreaterThan(iClasse);
  });
});
