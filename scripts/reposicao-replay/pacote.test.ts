// Modo PACOTE (spec 2026-11-09 §4.4): oráculos manuais, paridade nula, invariância à avaliação, três estados, régua 3′/3″
// e a máscara de A_alt. Os oráculos são contas à mão, independentes do código (a paridade nula não prova o `du90`).
import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import {
  baseDaCalibracao,
  calibrar,
  calibrarPacote,
  escolherTupla,
  mediaSomas,
  estadoDaTupla,
  mapaDosSuaves,
  perfisDoPacote,
  serializarTupla,
  suavesDaCoorte,
  vereditoDaCalibracaoPacote,
  type PerfilSuaves,
  type ResultadoCalibracao,
  type TuplaPacote,
} from './calibracao';
import { somarDiasUteis } from './calendario';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import { avaliarCriterios, estatCusto, veredito, type Estado } from './estatistica';
import { demandaSigmaPorDu, diagnosticoF0, pontoDePedidoF0, preComputarComOrigem, sigmaDemanda180, type Formula } from './formulas';
import { decomporCapital, familiasDaFronteira, fronteiraDoPacote, lerTetoPacote, montarRelatorioPacote, primeiraSemanaDaCalibracao } from './pacote';
import { decomporDLU, shapley3 } from './pacote-dlu';
import { coorte } from './parados';
import { avaliarCandidata, rodarLote } from './rodar';
import type { Celula } from './simulador';
import type { Dados, EventoRecebimento, Evidencia, EvidenciaServico, IntervaloPorBloco, ItemLT, LinhaVenda, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: 'sayerlack_normal', classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 4, saldoHoje: 0, ativo: true, habilitado: true, unidadeNf: 'L', unidadeEstoque: 'L', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25.75 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
let seq = 0;
const venda = (s: string, data: string, quantidade: number): LinhaVenda => ({ linhaId: `L${seq++}`, sku: s, data, quantidade, valor: quantidade * 10, cmcLinha: 6, noEscopo: true });
const item = (trackingId: string, s: string, t1: string, ltDu: number): ItemLT => ({ trackingId, sku: s, t1, t2: null, t4: somarDiasUteis(t1, ltDu), ltDu, aberto: false });
const dados = (skus: Sku[], vendas: LinhaVenda[], itensLT: ItemLT[], recebimentos: EventoRecebimento[] = [], abertura: Record<string, number> = {}): Dados => ({
  vendas, itensLT, recebimentos, skus: new Map(skus.map((s) => [s.sku, s])),
  zPorClasse: { A: 1.65, B: 1.28, C: 0.84 }, teto: { ativa: true, diasB: 90, diasC: 60 }, equivalencias: [], sugestaoHoje: new Map(), excluidos: [],
  classificacaoHist: { regras: REGRAS, porSku: new Map() }, shareInsumo: new Map(), parametrosView: new Map(), avisos: [], dataExtracao: '2026-10-21',
  posicaoAbertura: new Map(Object.entries(abertura)), posicaoConferencia: null, hashDados: 'h',
  cmcOmie: [{ data: INICIO_AQUECIMENTO, cmc: new Map(skus.map((s) => [s.sku, 4])) }],
});
const diasEntre = (ini: string, fim: string): string[] => Array.from({ length: diffDias(ini, fim) + 1 }, (_, i) => addDias(ini, i));
const P_A_ALT2A_165: PerfilSuaves = { tipo: 'F0', perfil: { nome: 'Alt2a', zA: 1.65 } };

// ── oráculos manuais (§4.4, item 3) ───────────────────────────────────────────────────────────────────────────────
describe('oráculos do F0′ (contas à mão)', () => {
  it('exemplo do Codex: D = 1/du, LT 10, σLT 0, z 1,65 ⇒ PP 10 com σd por du e 13 com σd corrido', () => {
    const d = '2026-04-06'; // segunda, depois do início da calibração (vigência do perfil)
    const dus = diasEntre(INICIO_AQUECIMENTO, addDias(d, -1)).filter(ehDiaUtil);
    // W só para o Pareto pôr X em A (X tem ~77% do valor: o acumulado dele fica ≤ 80%)
    const vendas = [...dus.map((dia) => venda('X', dia, 1)), ...dus.map((dia) => ({ ...venda('W', dia, 1), valor: 3 }))];
    // 6 documentos próprios, todos com LT 10 du, recebidos nos 180 dias anteriores a d
    const itens = [0, 1, 2, 3, 4, 5].map((i) => item(`X${i}`, 'X', addDias('2025-12-01', 7 * i), 10));
    const dd = dados([sku('X'), sku('W')], vendas, itens);
    const g = diagnosticoF0(dd, 'X', d, { calibracao: false, perfilF0: { nome: 'Alt2a', zA: 1.65 } });
    expect(g.status).toBe('OK');
    expect(g.classeProposta).toBe('A');
    expect([g.demanda, g.sigmaD, g.lt, g.sigmaLt, g.z]).toEqual([1, 0, 10, 0, 1.65]);
    expect(g.ppSugerido).toBe(10);
    // o mesmo D por du com o σd CORRIDO (zeros dos fins de semana): ⌈10 + 1,65·√(10·σ²)⌉ = 13
    const sdCorrido = sigmaDemanda180(dd, 'X', d)!;
    expect(sdCorrido).toBeGreaterThan(0.44);
    expect(sdCorrido).toBeLessThan(0.47);
    expect(pontoDePedidoF0({ demanda: 1, sigmaD: sdCorrido, lt: 10, sigmaLt: 0, z: 1.65, minimoOperacional: 2 }).pp).toBe(13);
    expect(pontoDePedidoF0({ demanda: 1, sigmaD: 0, lt: 10, sigmaLt: 0, z: 1.65, minimoOperacional: 2 }).pp).toBe(10);
    // P0 no mesmo dia: D corrido (≈ 5/7) — o perfil é que corrige a unidade
    const g0 = diagnosticoF0(dd, 'X', d, { calibracao: false });
    expect(g0.demanda).toBeLessThan(0.75);
  });

  it('LT e σLT por perfil: Alt2a = max(teórico, p80) com σLT 0; Alt2b herda LT/σLT; z(A) só na classe proposta A', () => {
    const d = '2026-04-06';
    const dus = diasEntre(INICIO_AQUECIMENTO, addDias(d, -1)).filter(ehDiaUtil);
    const vendas = [...dus.map((dia) => venda('X', dia, 1)), ...dus.map((dia) => ({ ...venda('W', dia, 1), valor: 3 }))];
    // LTs próprios 8, 9, 10, 10, 11, 12: p80 tipo 7 = ordenado[(6 − 1)·0,8 = 4] = 11 (à mão); desvio > 0 no P0
    const itens = [8, 9, 10, 10, 11, 12].map((lt, i) => item(`X${i}`, 'X', addDias('2025-12-01', 7 * i), lt));
    const dd = dados([sku('X'), sku('W')], vendas, itens);
    const g0 = diagnosticoF0(dd, 'X', d, { calibracao: false });
    const ga = diagnosticoF0(dd, 'X', d, { calibracao: false, perfilF0: { nome: 'Alt2a', zA: 3.09 } });
    const gb = diagnosticoF0(dd, 'X', d, { calibracao: false, perfilF0: { nome: 'Alt2b', zA: 3.09 } });
    expect(g0.sigmaLt).toBeGreaterThan(0.5);
    expect([ga.lt, ga.sigmaLt, ga.z]).toEqual([11, 0, 3.09]);
    expect([gb.lt, gb.sigmaLt, gb.z]).toEqual([g0.lt, g0.sigmaLt, 3.09]);
    // W é C: o z(A) da grade não vale para ela (B e C herdados)
    const w = diagnosticoF0(dd, 'W', d, { calibracao: false, perfilF0: { nome: 'Alt2a', zA: 3.09 } });
    expect([w.classeProposta, w.z]).toEqual(['C', 0.84]);
  });

  it('LT = 0: o PP cai no piso max(ss, mín. operacional) + 1', () => {
    expect(pontoDePedidoF0({ demanda: 3, sigmaD: 1, lt: 0, sigmaLt: 0, z: 1.65, minimoOperacional: 2 })).toEqual({ ss: 0, pp: 3 });
  });

  it('sábado com NF e borda esquerda: a venda de sábado entra no du anterior; a da borda soma em D (Σ vendas em [d−90,d)) mas fica fora da série do σd', () => {
    const d = '2026-03-06'; // sexta; d − 90 = sábado 06/12/2025
    expect(addDias(d, -90)).toBe('2025-12-06');
    const base = diasEntre(INICIO_AQUECIMENTO, addDias(d, -1)).filter(ehDiaUtil).map((dia) => venda('Y', dia, 1));
    const dd = dados([sku('Y')], [...base, venda('Y', '2025-12-06', 7), venda('Y', '2026-02-28', 5)], []);
    // à mão: du da janela [d − 90, d) — seg–sex, feriado não existe no calendário (25/12 e 01/01 são du)
    expect(ehDiaUtil('2025-12-25') && ehDiaUtil('2026-01-01')).toBe(true);
    const duJanela = diasEntre(addDias(d, -90), addDias(d, -1)).filter(ehDiaUtil);
    const r = demandaSigmaPorDu(dd, 'Y', d);
    expect(r.du).toBe(duJanela.length);
    expect(r.demanda).toBe(Math.round(((duJanela.length + 12) / duJanela.length) * 1e4) / 1e4); // 7 da borda ENTRA no numerador
    // reprodução do Codex (P1): 64 du, 1/du + 7 no sábado 06/12/2025 ⇒ D = 71/64, não 1
    expect(duJanela.length).toBe(64);
    const so7 = dados([sku('Y')], [...base, venda('Y', '2025-12-06', 7)], []);
    expect(demandaSigmaPorDu(so7, 'Y', d).demanda).toBe(Math.round((71 / 64) * 1e4) / 1e4);
    // σd por du (180 dias corridos, du sem venda = 0): sexta 05/12 recebe o sábado 06/12 (dentro da janela de 180)
    const du180 = diasEntre(addDias(d, -180), addDias(d, -1)).filter((x) => ehDiaUtil(x) && x >= INICIO_AQUECIMENTO);
    const serie = du180.map((x) => 1 + (x === '2025-12-05' ? 7 : 0) + (x === '2026-02-27' ? 5 : 0));
    const m = serie.reduce((a, b) => a + b, 0) / serie.length;
    const sd = Math.sqrt(serie.reduce((a, b) => a + (b - m) ** 2, 0) / (serie.length - 1));
    expect(r.sigmaD).toBe(Math.round(sd * 1e4) / 1e4);
  });

  it('histórico < 90 dias: divide pelos du observados desde o início, não por 90 nem pela janela cheia', () => {
    const d = addDias(INICIO_AQUECIMENTO, 40);
    const dd = dados([sku('Z')], diasEntre(INICIO_AQUECIMENTO, addDias(d, -1)).filter(ehDiaUtil).map((x) => venda('Z', x, 2)), []);
    const duObs = diasEntre(INICIO_AQUECIMENTO, addDias(d, -1)).filter(ehDiaUtil).length;
    const r = demandaSigmaPorDu(dd, 'Z', d);
    expect(r.du).toBe(duObs);
    expect(r.demanda).toBe(2);
    expect(r.sigmaD).toBe(0);
  });
});

// ── fixture com coorte: 2 intermitentes + 1 suave ─────────────────────────────────────────────────────────────────
/** `comW`: um 2º suave (W) de valor alto, para haver suave na classe A (S fica B pelo Pareto acumulado). */
function cenario(alterarAvaliacao: boolean, comW = false): Dados {
  const vs: LinhaVenda[] = [];
  const receb: EventoRecebimento[] = [];
  const itens: ItemLT[] = [];
  let k = 0;
  for (const [s, passo, fase] of [['P', 13, 0], ['Q', 9, 2]] as const) {
    for (let d = addDias(INICIO_AQUECIMENTO, fase), i = 0; d <= JANELAS.avaliacaoFim; d = addDias(d, passo + (i % 3)), i++) {
      if (!ehDiaUtil(d)) continue;
      const depois = d > JANELAS.calibracaoFim;
      vs.push({ linhaId: `${s}${k++}`, sku: s, data: d, quantidade: 1 + ((i * 7 + s.charCodeAt(0)) % 4) + (alterarAvaliacao && depois ? 5 : 0), valor: 10, cmcLinha: 6, noEscopo: true });
    }
  }
  // S: suave (venda em todo du, 2–3 unidades); no cenário alterado a avaliação muda e ganha linhas de sábado
  for (const [i, d] of diasEntre(INICIO_AQUECIMENTO, JANELAS.avaliacaoFim).entries()) {
    const depois = d > JANELAS.calibracaoFim;
    if (ehDiaUtil(d)) vs.push({ linhaId: `S${k++}`, sku: 'S', data: d, quantidade: 2 + (i % 2) + (alterarAvaliacao && depois ? 4 : 0), valor: 30, cmcLinha: 6, noEscopo: true });
    else if (alterarAvaliacao && depois) vs.push({ linhaId: `S${k++}`, sku: 'S', data: d, quantidade: 9, valor: 90, cmcLinha: 6, noEscopo: true });
    if (comW && ehDiaUtil(d)) vs.push({ linhaId: `W${k++}`, sku: 'W', data: d, quantidade: 3 + (i % 3), valor: 120, cmcLinha: 6, noEscopo: true });
  }
  for (let t1 = '2025-11-03', j = 0; t1 <= '2026-10-01'; t1 = somarDiasUteis(t1, 15), j++) {
    const lt = 4 + (j % 5);
    const ltFinal = alterarAvaliacao && somarDiasUteis(t1, lt) > JANELAS.calibracaoFim ? lt + 9 : lt;
    itens.push(item(`D${j}`, 'P', t1, ltFinal), item(`D${j}`, 'Q', t1, ltFinal + 1), item(`D${j}`, 'S', t1, ltFinal + 2));
    receb.push({ sku: 'P', data: somarDiasUteis(t1, ltFinal), quantidade: 6 }, { sku: 'Q', data: somarDiasUteis(t1, ltFinal + 1), quantidade: 4 }, { sku: 'S', data: somarDiasUteis(t1, ltFinal + 2), quantidade: 60 });
    if (comW) {
      itens.push(item(`D${j}`, 'W', t1, ltFinal + 3));
      receb.push({ sku: 'W', data: somarDiasUteis(t1, ltFinal + 3), quantidade: 50 });
    }
  }
  receb.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.sku < b.sku ? -1 : 1));
  if (comW) return dados([sku('P', { multiplo: 2 }), sku('Q'), sku('S'), sku('W')], vs, itens, receb, { P: 12, Q: 8, S: 40, W: 30 });
  return dados([sku('P', { multiplo: 2 }), sku('Q'), sku('S')], vs, itens, receb, { P: 12, Q: 8, S: 40 });
}

describe('fixture do pacote (sanidade: senão os testes abaixo são cegos)', () => {
  it('coorte com 1 suave (S) e 2 intermitentes', () => {
    const c = coorte(cenario(false));
    expect([...suavesDaCoorte(c)]).toEqual(['S']);
    expect([...c.alterados].sort()).toEqual(['P', 'Q']);
  });
});

describe('leave-one-SKU-out (estabilidade): o SKU sai da população MEDIDA, não só volta ao F0', () => {
  it('sem S: as linhas dele saem da calibração do F0 e o estoque muda; com S fora, P0 e Alt1 empatam (não há mais suave)', () => {
    const dd = cenario(false);
    const linhas = (b: ReturnType<typeof baseDaCalibracao>) =>
      (['A', 'B', 'C'] as const).reduce((t, c) => t + b.somasF0.porCelula[c].demandadas.reduce((x, y) => x + y, 0), 0);
    const com = baseDaCalibracao(dd, { reps: 2, cacheDir: null });
    const sem = baseDaCalibracao(dd, { reps: 2, cacheDir: null, semSku: 'S' });
    const linhasS = dd.vendas.filter((v) => v.sku === 'S' && v.data >= JANELAS.calibracaoIni && v.data <= JANELAS.calibracaoFim).length;
    expect(linhasS).toBeGreaterThan(0);
    expect(linhas(sem)).toBe(linhas(com) - linhasS);
    expect(sem.estoqueF0).not.toBeCloseTo(com.estoqueF0 as number, 6);
    const tuplas = calibrarPacote(dd, { reps: 2, cacheDir: null, perfis: [P0, ALT1], formulas: ['F1'], semSku: 'S' });
    const resumo = (t: TuplaPacote) => ({ est: t.resultado.estoqueMedio, fill: t.resultado.fill, e0: t.resultado.estoqueF0 });
    expect(resumo(tuplas[1])).toEqual(resumo(tuplas[0]));
    expect(tuplas[0].resultado.estoqueF0).toBe(sem.estoqueF0);
    expect(() => calibrarPacote(dd, { reps: 2, cacheDir: null, perfis: [P0], formulas: ['F1'], semSku: 'P' })).toThrow('SEM_SUAVE_FORA_DOS_SUAVES:P');
  }, 300_000);
});

// ── paridade nula (§4.4, item 2) com controle na MESMA invocação ─────────────────────────────────────────────────
describe('paridade nula P0 × F0', () => {
  it('P0 = F0 bit a bit em todos os SKU-dias dos suaves, nos dois contextos; o controle (Alt1) diverge', () => {
    const dd = cenario(false);
    for (const calibracao of [true, false]) {
      const f0 = preComputarComOrigem('F0', dd, { quantil: { A: 0.95, B: 0.95, C: 0.95 } }, { calibracao }, { cacheDir: null }).mapa;
      const p0 = mapaDosSuaves(dd, { tipo: 'F0', perfil: { nome: 'P0' } }, { calibracao }, null);
      const alt1 = mapaDosSuaves(dd, { tipo: 'F0', perfil: { nome: 'Alt1' } }, { calibracao }, null);
      expect(p0.size).toBeGreaterThan(100);
      for (const [k, v] of p0) expect(JSON.stringify(v)).toBe(JSON.stringify(f0.get(k)));
      // controle: o perfil que corrige a unidade TEM de mudar algum SKU-dia (senão a comparação é idêntica por construção)
      expect([...alt1].filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(f0.get(k))).length).toBeGreaterThan(0);
      // aquecimento: sempre P0, em qualquer perfil
      for (const [k, v] of alt1) if (k.slice(k.indexOf('|') + 1) < JANELAS.calibracaoIni) expect(JSON.stringify(v)).toBe(JSON.stringify(f0.get(k)));
    }
  });

  it('o perfil entra na chave do cache; P0 mantém a chave do modo oficial', () => {
    const dd = cenario(false);
    const skus = ['S'];
    const ch = (perfilF0?: Parameters<typeof preComputarComOrigem>[3]['perfilF0']) =>
      preComputarComOrigem('F0', dd, { quantil: { A: 0.95, B: 0.95, C: 0.95 } }, { calibracao: true, skus, ...(perfilF0 ? { perfilF0 } : {}) }, { cacheDir: null, hashCodigo: 'x' }).chave;
    expect(ch({ nome: 'P0' })).toBe(ch());
    expect(new Set([ch(), ch({ nome: 'Alt1' }), ch({ nome: 'Alt2a', zA: 2.326 }), ch({ nome: 'Alt2b', zA: 2.326 }), ch({ nome: 'Alt2a', zA: 3.09 })]).size).toBe(5);
    expect(() => preComputarComOrigem('F2', dd, { beta: 0.02, quantil: { A: 0.9, B: 0.9, C: 0.9 } }, { calibracao: true, skus, perfilF0: { nome: 'Alt1' } }, { cacheDir: null })).toThrow(/^PERFIL_F0_FORA_DO_F0:F2$/);
  });
});

// ── invariância à avaliação: mutar o que vem depois de 30/04 não muda a calibração de NENHUM perfil (§4.4, item 3) ──
describe('calibração do pacote invariante à avaliação', () => {
  it('os mapas de todos os perfis na calibração e uma calibração (P, X) não mudam com vendas/LT posteriores a 30/04', () => {
    const a = cenario(false);
    const b = cenario(true);
    expect(b.vendas.length).toBeGreaterThan(a.vendas.length); // sanidade: houve mutação
    for (const perfil of perfisDoPacote()) {
      const ma = mapaDosSuaves(a, perfil, { calibracao: true }, null);
      const mb = mapaDosSuaves(b, perfil, { calibracao: true }, null);
      expect(JSON.stringify([...mb])).toBe(JSON.stringify([...ma]));
    }
    const rodar = (dd: Dados) => calibrarPacote(dd, { reps: 2, cacheDir: null, perfis: [{ tipo: 'F0', perfil: { nome: 'P0' } }, P_A_ALT2A_165], formulas: ['F1'] });
    const ra = rodar(a);
    const rb = rodar(b);
    const resumo = (t: TuplaPacote) => ({ t: serializarTupla(t), e: estadoDaTupla(t.resultado), est: t.resultado.estoqueMedio, fill: t.resultado.fill, tent: t.resultado.tentativas });
    expect(rb.map(resumo)).toEqual(ra.map(resumo));
    expect(ra).toHaveLength(2);
  }, 300_000);
});

// ── três estados e seleção determinística (§4.2, itens 3–5) ──────────────────────────────────────────────────────
const res = (formula: Formula, x: Partial<ResultadoCalibracao> = {}): ResultadoCalibracao => ({
  formula, celulasAlvo: 'classe', params: { quantil: { A: 0.9, B: 0.9, C: 0.9 } }, inviavel: false, estoqueMedio: 100, estoqueF0: 1000,
  capitalIndeterminado: false, alvo: { A: 0.98, B: 0.95, C: 0.92 }, fillF0: { A: 0.9, B: 0.9, C: 0.9 }, fill: { A: 0.98, B: 0.95, C: 0.92 },
  naoObservaveis: [], tentativas: [], ...x,
});
const P0: PerfilSuaves = { tipo: 'F0', perfil: { nome: 'P0' } };
const ALT1: PerfilSuaves = { tipo: 'F0', perfil: { nome: 'Alt1' } };
const tu = (perfil: PerfilSuaves, r: ResultadoCalibracao): TuplaPacote => ({ perfil, resultado: r });

describe('três estados, nunca dois', () => {
  it('caso mínimo 1: única tupla com capital desconhecido ⇒ seleção INDETERMINADA, veredito INCONCLUSIVO', () => {
    const e = escolherTupla([tu(P0, res('F1', { estoqueMedio: null, capitalIndeterminado: true }))]);
    expect(e.tipo).toBe('INDETERMINADA');
    expect(vereditoDaCalibracaoPacote(e)?.veredito).toBe('INCONCLUSIVO');
    expect(vereditoDaCalibracaoPacote(e)?.motivos[0]).toMatch(/^CAPITAL_NAO_VALORADO_NA_CALIBRACAO: /);
  });
  it('caso mínimo 2: valorada + capital desconhecido ⇒ INDETERMINADA (nunca escolhe a valorada por exclusão)', () => {
    const e = escolherTupla([tu(P0, res('F1', { estoqueMedio: 100 })), tu(ALT1, res('F2', { estoqueMedio: null, capitalIndeterminado: true }))]);
    expect(e.tipo).toBe('INDETERMINADA');
    expect(vereditoDaCalibracaoPacote(e)?.veredito).toBe('INCONCLUSIVO');
  });
  it('inviável por busca valorada é INVIAVEL; inviável com capital desconhecido é INDETERMINADO (ausente ≠ inviável)', () => {
    expect(estadoDaTupla(res('F1', { inviavel: true }))).toBe('INVIAVEL');
    expect(estadoDaTupla(res('F1', { inviavel: true, capitalIndeterminado: true }))).toBe('INDETERMINADO');
    expect(estadoDaTupla(res('F1', { estoqueF0: null }))).toBe('INDETERMINADO');
    expect(escolherTupla([tu(P0, res('F1', { inviavel: true, capitalIndeterminado: true }))]).tipo).toBe('INDETERMINADA');
  });
  it('todas inviáveis (valoradas) ⇒ NENHUMA ⇒ NO-GO INVIAVEL_NA_CALIBRACAO', () => {
    const e = escolherTupla([tu(P0, res('F1', { inviavel: true })), tu(ALT1, res('F2', { inviavel: true }))]);
    expect(e.tipo).toBe('NENHUMA');
    expect(vereditoDaCalibracaoPacote(e)).toEqual({ veredito: 'NO-GO', motivos: ['INVIAVEL_NA_CALIBRACAO'] });
  });
  it('classe não observável ⇒ tupla INDETERMINADA (achado P2 do Codex), com o motivo próprio, nunca "capital"', () => {
    expect(estadoDaTupla(res('F1', { naoObservaveis: ['A'] }))).toBe('INDETERMINADO');
    expect(estadoDaTupla(res('F1', { naoObservaveis: ['A'], inviavel: true }))).toBe('INDETERMINADO');
    // valorada + inobservável ⇒ a seleção NÃO congela a valorada por exclusão
    const e = escolherTupla([tu(P0, res('F1', { estoqueMedio: 100 })), tu(ALT1, res('F2', { naoObservaveis: ['C'] }))]);
    expect(e.tipo).toBe('INDETERMINADA');
    expect(vereditoDaCalibracaoPacote(e)?.motivos).toEqual(['CLASSE_NAO_OBSERVAVEL_NA_CALIBRACAO:C: Alt1|F2|beta=-|janela=-|q=0.9,0.9,0.9']);
    const mista = escolherTupla([
      tu(P0, res('F1', { naoObservaveis: ['A'] })),
      tu(ALT1, res('F2', { estoqueMedio: null, capitalIndeterminado: true })),
    ]);
    expect(vereditoDaCalibracaoPacote(mista)?.motivos.map((m) => m.split(': ')[0])).toEqual([
      'CAPITAL_NAO_VALORADO_NA_CALIBRACAO',
      'CLASSE_NAO_OBSERVAVEL_NA_CALIBRACAO:A',
    ]);
  });
});

describe('seleção determinística', () => {
  const nome = (e: ReturnType<typeof escolherTupla>) => (e.tipo === 'TUPLA' ? serializarTupla(e.tupla) : e.tipo);
  it('menor estoque vence; a fórmula mais simples a ≤ 1 p.p. (do F0) fica com a vaga, a 1,1 p.p. não', () => {
    expect(nome(escolherTupla([tu(P0, res('F2', { estoqueMedio: 500 })), tu(ALT1, res('F1', { estoqueMedio: 510 }))]))).toMatch(/^Alt1\|F1\|/);
    expect(nome(escolherTupla([tu(P0, res('F2', { estoqueMedio: 500 })), tu(ALT1, res('F1', { estoqueMedio: 511 }))]))).toMatch(/^P0\|F2\|/);
    expect(nome(escolherTupla([tu(P0, res('F2', { estoqueMedio: 500 })), tu(ALT1, res('F3', { estoqueMedio: 499 }))]))).toMatch(/^Alt1\|F3\|/);
  });
  it('estoque empatado: perfil mais simples, depois menor z(A)/q, depois a tupla serializada', () => {
    const z = (zA: number): PerfilSuaves => ({ tipo: 'F0', perfil: { nome: 'Alt2b', zA } });
    expect(nome(escolherTupla([tu(ALT1, res('F1')), tu(P0, res('F1'))]))).toMatch(/^P0\|/);
    expect(nome(escolherTupla([tu({ tipo: 'F1', q: 0.9 }, res('F1')), tu(z(3.09), res('F1'))]))).toMatch(/^Alt2b:z3.09\|/);
    expect(nome(escolherTupla([tu(z(2.326), res('F1')), tu(z(1.88), res('F1'))]))).toMatch(/^Alt2b:z1.88\|/);
    expect(nome(escolherTupla([tu({ tipo: 'F0', perfil: { nome: 'Alt2b', zA: 2.326 } }, res('F1')), tu({ tipo: 'F0', perfil: { nome: 'Alt2a', zA: 2.326 } }, res('F1'))]))).toMatch(/^Alt2a:z2.326\|/);
    // a ordem de entrada não importa
    const xs = [tu(z(2.326), res('F1')), tu(P0, res('F1')), tu(ALT1, res('F1'))];
    expect(nome(escolherTupla(xs))).toBe(nome(escolherTupla([...xs].reverse())));
  });
  it('a lista de perfis é a da §4.2: P0, Alt1, 6 z × (Alt2a, Alt2b) e a grade de q da Alt3', () => {
    const ps = perfisDoPacote();
    expect(ps.slice(0, 2)).toEqual([P0, ALT1]);
    expect(ps.filter((p) => p.tipo === 'F0' && p.perfil.nome === 'Alt2a').map((p) => (p.tipo === 'F0' && p.perfil.nome === 'Alt2a' ? p.perfil.zA : 0))).toEqual([1.65, 1.88, 2.054, 2.326, 2.576, 3.09]);
    expect(ps.filter((p) => p.tipo === 'F1')).toHaveLength(15);
  });
});

// ── régua de capital do pacote: 3′ e 3″ nos limites (§4.3) ─────────────────────────────────────────────────────────
const iv = (ponto: number | null, li: number | null, ls: number | null): IntervaloPorBloco => ({ 4: { ponto, li, ls }, 8: { ponto, li, ls } });
const CEL6: Celula[] = ['A', 'B', 'C', 'A_alt', 'B_alt', 'C_alt'];
const servicoOk = (falta: 'espera' | 'cancelamento'): EvidenciaServico => ({
  falta,
  pisos: (['A', 'B', 'C'] as const).map((classe) => ({ classe, fill: iv(0.995, 0.993, 0.997), atendidas: 4975, demandadas: 5000 })),
  naoInferioridade: CEL6.map((celula) => ({ celula, delta: iv(0.01, 0.005, 0.02) })),
});
const FALTAS3 = ['espera', 'cancelamento', 'misto'] as const;
const grade = (custo: IntervaloPorBloco) => FALTAS3.flatMap((falta) => [0.05, 0.1, 0.2].flatMap((emergencialPerc) => [0, 0.005, 0.01].map((atrasoPerc) => ({
  falta, grade: { taxa: 0.25, emergencialPerc, atrasoPerc }, custo, linhasMargemDesconhecida: 0, valorMargemDesconhecida: 0, linhasDemandadas: 5000, valorDemandado: 100000,
}))));
function evidenciaPacote(reducao: IntervaloPorBloco, custo: IntervaloPorBloco): Evidencia {
  return {
    servico: [servicoOk('espera'), servicoOk('cancelamento')],
    capital: FALTAS3.map((falta) => ({ falta, reducao })),
    estresse: { servico: [servicoOk('espera'), servicoOk('cancelamento')], capital: FALTAS3.map((falta) => ({ falta, reducao })), economia: grade(custo) },
    economia: grade(custo),
    exposicao: CEL6.map((celula) => ({ celula, linhas: 5000 })),
    precisao: { replicacoes: 200, teto: 1000, meiaLarguraServico: 0.0005, alvoServico: 0.001, meiaLarguraEstoque: 0.005, alvoEstoque: 0.01 },
    estadosIniciais: [{ rotulo: 'reconstruido', veredito: 'GO' }, { rotulo: 'piso_zero', veredito: 'GO' }],
  };
}
const TETO = { pacote: { teto: 0.2 } };
const estado = (ev: Evidencia, criterio: string): Estado | undefined => avaliarCriterios(ev, TETO).find((c) => c.criterio === criterio)?.estado;
const CUSTO_OK = iv(500, 100, 900);

describe('3″ (teto de aumento do estoque médio = −redução)', () => {
  it('PASSA com LS(aumento) = teto exato; INCERTO acima dele; FALHA só com LI(aumento) > teto', () => {
    // aumento = −redução: LS(aumento) = −LI(redução), LI(aumento) = −LS(redução)
    expect(estado(evidenciaPacote(iv(-0.1, -0.2, -0.05), CUSTO_OK), '3" Teto [espera]')).toBe('PASSA');
    expect(estado(evidenciaPacote(iv(-0.1, -0.2001, -0.05), CUSTO_OK), '3" Teto [espera]')).toBe('INCERTO');
    expect(estado(evidenciaPacote(iv(-0.3, -0.4, -0.2), CUSTO_OK), '3" Teto [espera]')).toBe('INCERTO');
    expect(estado(evidenciaPacote(iv(-0.3, -0.4, -0.2001), CUSTO_OK), '3" Teto [espera]')).toBe('FALHA');
    expect(estado(evidenciaPacote(iv(null, null, null), CUSTO_OK), '3" Teto [espera]')).toBe('INCERTO');
    // D1b: o teto também no estresse
    expect(estado(evidenciaPacote(iv(-0.3, -0.4, -0.2001), CUSTO_OK), '4 Estresse 3" Teto [misto]')).toBe('FALHA');
  });
});

describe("3′ (benefício líquido em toda a grade, também no estresse)", () => {
  it('PASSA com LI > 0; INCERTO com LI = 0; FALHA com LS < 0; null ⇒ INCERTO', () => {
    const red = iv(-0.05, -0.1, -0.02);
    const c = "3' Economia [espera taxa 25,0% emerg 5,0% atraso 0,0%]";
    expect(estado(evidenciaPacote(red, iv(10, 0.01, 20)), c)).toBe('PASSA');
    expect(estado(evidenciaPacote(red, iv(10, 0, 20)), c)).toBe('INCERTO');
    expect(estado(evidenciaPacote(red, iv(-10, -20, -0.01)), c)).toBe('FALHA');
    expect(estado(evidenciaPacote(red, iv(null, null, null)), c)).toBe('INCERTO');
    expect(estado(evidenciaPacote(red, iv(-10, -20, -0.01)), `4 Estresse ${c}`)).toBe('FALHA');
  });
  it('empírico PASSA e estresse FALHA: cada linha lê a SUA grade (o 3′ não contamina o 4 nem vice-versa) ⇒ NO-GO', () => {
    const ev = evidenciaPacote(iv(-0.05, -0.1, -0.02), CUSTO_OK);
    ev.estresse.economia = ev.estresse.economia!.map((e) => (e.falta === 'misto' && e.grade.emergencialPerc === 0.2 ? { ...e, custo: iv(-30, -50, -5) } : e));
    const cs = avaliarCriterios(ev, TETO);
    expect(cs.filter((x) => x.criterio.startsWith("3' Economia [")).every((x) => x.estado === 'PASSA')).toBe(true);
    const falhas = cs.filter((x) => x.estado === 'FALHA').map((x) => x.criterio);
    expect(falhas).toHaveLength(3); // misto × emergencial 20% × 3 atrasos
    expect(falhas.every((f) => f.startsWith("4 Estresse 3' Economia [misto") && f.includes('emerg 20,0%'))).toBe(true);
    expect(veredito(cs).veredito).toBe('NO-GO');
  });
  it('a régua do pacote substitui 3, 4-capital e 5; sem a grade do estresse vira INCERTO; teto inválido lança', () => {
    const ev = evidenciaPacote(iv(-0.05, -0.1, -0.02), CUSTO_OK);
    const nomes = avaliarCriterios(ev, TETO).map((x) => x.criterio);
    expect(nomes.some((n) => /^3 Capital|^5 Economia|^4 Estresse \[/.test(n))).toBe(false);
    expect(nomes.filter((n) => n.startsWith("3' Economia ["))).toHaveLength(27);
    expect(nomes.filter((n) => n.startsWith("4 Estresse 3' Economia ["))).toHaveLength(27);
    const semEstresse = { ...ev, estresse: { servico: ev.estresse.servico, capital: ev.estresse.capital } };
    expect(avaliarCriterios(semEstresse, TETO).find((x) => x.criterio === "4 Estresse 3' Economia")?.estado).toBe('INCERTO');
    expect(() => avaliarCriterios(ev, { pacote: { teto: 0 } })).toThrow(/^PACOTE_TETO_INVALIDO:0$/);
    // o oficial continua com 3/5 (e redução ≥ 10% reprova quem aumenta estoque)
    expect(avaliarCriterios(ev).find((x) => x.criterio === '3 Capital [espera]')?.estado).toBe('FALHA');
  });
});

// ── avaliação do pacote: máscara de A_alt = intermitentes ORIGINAIS, nunca a união com os suaves ─────────────────────
describe('avaliação do pacote', () => {
  it('as células *_alt continuam só com os alterados (os suaves ficam fora), nos dois braços', () => {
    const dd = cenario(false);
    const c = coorte(dd);
    const cg = { candidata: 'F1' as const, params: { quantil: { A: 0.9, B: 0.9, C: 0.9 } }, suaves: P_A_ALT2A_165 };
    const lote = rodarLote(dd, cg, [0], null);
    const m = lote.somas['coorte|reconstruido|empirico|espera|exato'];
    const soma = (s: typeof m.alt, cs: Celula[]) => cs.reduce((t, x) => t + s.porCelula[x].demandadas.reduce((a, b) => a + b, 0), 0);
    const linhasAlterados = dd.vendas.filter((v) => c.alterados.has(v.sku) && v.quantidade > 0 && v.data >= JANELAS.avaliacaoIni && v.data <= JANELAS.avaliacaoFim).length;
    const linhasTodas = dd.vendas.filter((v) => c.populacao.has(v.sku) && v.quantidade > 0 && v.data >= JANELAS.avaliacaoIni && v.data <= JANELAS.avaliacaoFim).length;
    expect(linhasTodas).toBeGreaterThan(linhasAlterados); // sanidade: o suave tem linhas na avaliação
    for (const braco of [m.alt, m.f0]) {
      expect(soma(braco, ['A_alt', 'B_alt', 'C_alt'])).toBe(linhasAlterados);
      expect(soma(braco, ['A', 'B', 'C'])).toBe(linhasTodas);
    }
  }, 300_000);

  it('a régua do pacote chega à tabela (3′/3″, também no estresse); pacote sem perfil (ou vice-versa) lança', async () => {
    const dd = cenario(false);
    const cg = { candidata: 'F1' as const, params: { quantil: { A: 0.9, B: 0.9, C: 0.9 } }, suaves: P_A_ALT2A_165 };
    const r = await avaliarCandidata(dd, '/inexistente', cg, null, { paralelo: 1, tetoReps: 1, cacheDir: null, pacote: { teto: 0.2 } });
    const nomes = r.avaliacao.criterios.map((x) => x.criterio);
    expect(nomes).toContain('3" Teto [espera]');
    expect(nomes).toContain('4 Estresse 3" Teto [misto]');
    expect(nomes.filter((n) => n.startsWith("4 Estresse 3' Economia ["))).toHaveLength(27);
    expect(nomes.some((n) => /^3 Capital|^5 Economia/.test(n))).toBe(false);
    expect(r.avaliacao.blocos.estresse.economia).toHaveLength(27);
    // oráculo numérico (achado P2 do Codex: a sabotagem cen('empirico') no estresse ficava verde): o ponto de cada célula da
    // economia do ESTRESSE é o custo líquido das médias do cenário estresse15 do mesmo lote, e difere do empírico
    const n = r.avaliacao.reps;
    const lote = rodarLote(dd, cg, Array.from({ length: n }, (_, i) => i), null);
    let difere = 0;
    for (const e of r.avaliacao.blocos.estresse.economia!) {
      const m = lote.somas[`coorte|reconstruido|estresse15|${e.falta}|exato`];
      const todas = Array.from({ length: m.f0.semanas.length }, (_, i) => i);
      const esperado = estatCusto(e.grade)([mediaSomas(m.f0, n)], [mediaSomas(m.alt, n)], todas);
      expect(esperado).not.toBeNull();
      expect(e.custo[4].ponto).toBeCloseTo(esperado as number, 6);
      const emp = r.avaliacao.blocos.economia.find((x) => x.falta === e.falta && JSON.stringify(x.grade) === JSON.stringify(e.grade))!;
      if (Math.abs((emp.custo[4].ponto as number) - (e.custo[4].ponto as number)) > 1e-6) difere++;
    }
    expect(difere).toBeGreaterThan(0); // sanidade: o fixture distingue estresse de empírico (senão o oráculo é cego)
    await expect(avaliarCandidata(dd, '/inexistente', { candidata: 'F1', params: cg.params }, null, { paralelo: 1, tetoReps: 1, cacheDir: null, pacote: { teto: 0.2 } })).rejects.toThrow(/^PACOTE_INCOERENTE/);
    await expect(avaliarCandidata(dd, '/inexistente', cg, null, { paralelo: 1, tetoReps: 1, cacheDir: null })).rejects.toThrow(/^PACOTE_INCOERENTE/);
  }, 300_000);
});

describe('teto e capital por SKU', () => {
  it('teto ausente ou fora de (0, 1] para a rodada (nunca um padrão do código)', () => {
    expect(() => lerTetoPacote('/inexistente-teto')).toThrow(/^TETO_PACOTE_AUSENTE/);
  });
  it('decomposição do aumento: suaves, intermitentes, outros e o maior SKU; sem aumento ⇒ frações null', () => {
    const k = decomporCapital({ S: 100, P: 50, X: 10 }, { S: 160, P: 70, X: 30 }, new Set(['S']), new Set(['P']));
    expect(k.aumento).toBe(100);
    expect([k.suaves, k.intermitentes, k.outros]).toEqual([0.6, 0.2, 0.2]);
    expect(k.maior).toEqual({ sku: 'S', parte: 0.6 });
    const z = decomporCapital({ S: 100 }, { S: 90 }, new Set(['S']), new Set());
    expect([z.suaves, z.maior]).toEqual([null, null]);
  });
});

describe('diagnósticos da rodada do pacote (achados P2 do Codex)', () => {
  it('Shapley de 3 fatores: aditivo devolve cada efeito; a interação D×L reparte meio a meio; a soma fecha f(111) − f(000)', () => {
    const ad = shapley3((d, l, u) => 0.9 + 0.01 * d + 0.02 * l + 0.03 * u);
    expect(ad.D).toBeCloseTo(0.01, 12);
    expect(ad.L).toBeCloseTo(0.02, 12);
    expect(ad.U).toBeCloseTo(0.03, 12);
    const it = shapley3((d, l, u) => 0.9 + 0.01 * d + 0.02 * l + 0.03 * u + 0.04 * d * l);
    expect([it.D, it.L, it.U].map((x) => Math.round(x * 1e12) / 1e12)).toEqual([0.03, 0.04, 0.03]);
  });

  it('D/L/U no fixture: 8 combinações, controle e Shapley que fecha a soma', () => {
    const dd = cenario(false, true);
    expect([...suavesDaCoorte(coorte(dd))].sort()).toEqual(['S', 'W']); // sanidade do fixture
    const r = decomporDLU(dd, 2);
    if ('indisponivel' in r) throw new Error(r.indisponivel);
    const k = r;
    expect(k.combinacoes).toHaveLength(8);
    expect(k.linhasSuavesA).toBeGreaterThan(0);
    const f = (d: number, l: number, u: number) => k.combinacoes.find((x) => x.D === d && x.L === l && x.U === u)!.fillSuavesA;
    expect(k.controle.recalculo).toBe(f(0, 0, 0));
    expect(k.shapley.D + k.shapley.L + k.shapley.U).toBeCloseTo(f(1, 1, 1) - f(0, 0, 0), 12);
    expect(k.residual).toBeCloseTo(1 - f(1, 1, 1), 12);
    // U multiplica o termo médio por 7/5 nos suaves: o estoque da coorte sobe (senão o fator não chegou ao mapa)
    const u = k.combinacoes.find((x) => x.D === 0 && x.L === 0 && x.U === 1)!;
    expect(u.deltaEstoque as number).toBeGreaterThan(0);
  }, 300_000);

  it('Codex r2 (P2): A sem linha dos suaves ⇒ D/L/U n/d, e o relatório INCONCLUSIVO da calibração sai (nunca uma exceção)', () => {
    const dd = cenario(false); // sem W: nenhum suave em A, A inobservável
    const e = escolherTupla(calibrarPacote(dd, { reps: 2, cacheDir: null, perfis: [P0], formulas: ['F1'] }));
    const vc = vereditoDaCalibracaoPacote(e);
    expect(vc?.veredito).toBe('INCONCLUSIVO');
    const dlu = decomporDLU(dd, 2);
    expect(dlu).toEqual({ indisponivel: 'DLU_SEM_LINHAS_A_DOS_SUAVES' });
    const md = montarRelatorioPacote({
      geradoEm: 'x', chave: { hashDados: 'h', hashCodigo: 'c', dataExtracao: '2026-11-09', protocolo: 'p', perfis: ['P0'] },
      teto: { teto: 0.2, sha256: 's' }, modoAncora: 'm', tuplas: [], escolha: e.tipo, veredito: vc!, congelado: null, criterios: [],
      reps: null, diagnostico: null, fronteira: [], primeiraSemana: primeiraSemanaDaCalibracao(dd, null, null, 2), dlu, estabilidade: null, segundos: 0,
    });
    expect(md).toContain('## Veredito: **INCONCLUSIVO**');
    expect(md).toContain('n/d — DLU_SEM_LINHAS_A_DOS_SUAVES');
  }, 300_000);

  it('1ª semana é a da CALIBRAÇÃO (01–07/02), rotulada; fronteira varre o alvo de A por nível com a seleção intocada', () => {
    const dd = cenario(false, true); // com W: há suave em A, o alvo de A é observável
    const ps = primeiraSemanaDaCalibracao(dd, null, null, 2);
    expect(ps.f0.semana).toEqual(['2026-02-01', '2026-02-07']);
    expect(ps.pacote).toBeNull();
    const b = baseDaCalibracao(dd, { reps: 2, cacheDir: null });
    const dA = b.somasF0.porCelula.A.demandadas;
    const iA = b.somasF0.porCelula.A.integrais;
    const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
    expect(ps.f0.sem).toBe(sum(dA.slice(1)) > 0 ? sum(iA.slice(1)) / sum(dA.slice(1)) : null);
    expect(ps.f0.com).toBe(sum(dA) > 0 ? sum(iA) / sum(dA) : null);
    expect(familiasDaFronteira({ tipo: 'NENHUMA' }).map((x) => `${x.perfil.tipo}:${x.formula}`)).toEqual(['F0:F1', 'F0:F2', 'F0:F3']);
    const pts = fronteiraDoPacote(dd, [{ perfil: P0, formula: 'F1' }], { cacheDir: null, reps: 2, niveis: [0.95, 0.99] });
    expect(pts.map((p) => [p.nivel, p.familia])).toEqual([[0.95, 'P0|F1'], [0.99, 'P0|F1']]);
    // o nível chega ao alvo da busca: a 99% o quantil de A não fica abaixo do de 95%
    const qA = (t: string) => Number(t.split('q=')[1].split(',')[0]);
    expect(qA(pts[1].tupla)).toBeGreaterThanOrEqual(qA(pts[0].tupla));
    expect(() => fronteiraDoPacote(dd, [{ perfil: P0, formula: 'F1' }], { cacheDir: null, reps: 2, niveis: [1] })).toThrow('ALVO_A_INVALIDO:1');
    // o nível É o alvo da busca: o resultado carrega alvo A = 99% e, se viável, atinge-o (B e C no alvo oficial)
    const r99 = calibrar(dd, 'F1', { reps: 2, cacheDir: null, alvoA: 0.99 });
    expect(b.alvo.A).not.toBeNull(); // sanidade: A observável no fixture
    expect(r99.alvo.A).toBe(0.99);
    expect([r99.alvo.B, r99.alvo.C]).toEqual([b.alvo.B, b.alvo.C]);
    if (!r99.inviavel) expect(r99.fill.A as number).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});
