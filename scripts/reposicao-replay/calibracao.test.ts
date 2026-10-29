import { describe, expect, it } from 'vitest';
import { addDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { alvoDaClasse, avaliarNaCalibracao, baseDaCalibracao, buscarTrio, calibrar, escolherCandidata, fillDaCelula, vereditoDaCalibracao, type ResultadoCalibracao } from './calibracao';
import { documentoSorteado } from './aleatorio';
import { somarDiasUteis } from './calendario';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import { coorte } from './parados';
import { anexarInformativa, avaliarCandidata, exigirGateParidade, gateParidadePassa } from './rodar';
import { causaOficial, LIMITES, TEXTO_GATE_ECONOMIA, tituloSecaoInformativa, tituloVeredito, type Rodada } from './relatorio';
import { ErroDadosReplay } from './tipos';
import type { ParamsDia } from './formulas';
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
    const ok = { es: 1, pp: 0.975, max: 0.967, valor: 0.008, decisao: { n: 8, de: 8 }, estado: { n: 7, de: 8 } };
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
