import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { uniforme } from './aleatorio';
import { somarDiasUteis } from './calendario';
import { classeEfetiva } from './classe';
import { CENARIOS_FALTA, INICIO_AQUECIMENTO, JANELAS } from './config';
import type { ParamsDia } from './formulas';
import { conferirEstoque, conferirFechamento, convDoGrupo, decidirCompra, embalagemEscolhida, paridadeQuantidade, simular, type EntradaSimulacao, type SomasSemanais } from './simulador';
import type { Dados, Equivalencia, EventoRecebimento, ItemLT, LinhaVenda, PrecosEmbalagem, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: 'sayerlack_normal', classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 4, saldoHoje: 0, ativo: true, habilitado: true, unidadeNf: 'L', unidadeEstoque: 'L', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25.75 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
const venda = (linhaId: string, s: string, data: string, quantidade: number, valor = quantidade * 10, cmcLinha: number | null = 6): LinhaVenda => ({
  linhaId, sku: s, data, quantidade, valor, cmcLinha, noEscopo: true,
});
const item = (trackingId: string, s: string, t1: string, ltDu: number): ItemLT => ({
  trackingId, sku: s, t1, t2: null, t4: somarDiasUteis(t1, ltDu), ltDu, aberto: false,
});
/** Estoque de ABERTURA desejado: saldoHoje = abertura − Σ vendas + Σ recebimentos (a reconstrução volta disso). */
const comAbertura = (s: Sku, abertura: number, vendas: LinhaVenda[], receb: EventoRecebimento[] = []): Sku => ({
  ...s,
  saldoHoje: abertura - vendas.filter((v) => v.sku === s.sku).reduce((a, v) => a + v.quantidade, 0) + receb.filter((r) => r.sku === s.sku).reduce((a, r) => a + r.quantidade, 0),
});
const dados = (skus: Sku[], vendas: LinhaVenda[], extra: Partial<Dados> = {}): Dados => ({
  vendas, itensLT: [item('DOC0', 'Q', '2026-05-04', 2)], recebimentos: [], skus: new Map(skus.map((s) => [s.sku, s])),
  zPorClasse: { A: 1.65, B: 1.28, C: 0.84 }, teto: { ativa: true, diasB: 90, diasC: 60 }, equivalencias: [], sugestaoHoje: new Map(), excluidos: [],
  classificacaoHist: { regras: REGRAS, porSku: new Map() }, shareInsumo: new Map(), parametrosView: new Map(), avisos: [], dataExtracao: '2026-10-21',
  posicaoAbertura: null, posicaoConferencia: null, hashDados: 'h', ...extra,
});
const JANELA: [string, string] = ['2026-05-04', '2026-05-29'];
const SEM: ParamsDia = { tipo: 'SEM_DECISAO', motivo: 'F0_SEM_PARAMETRO' };
/** Parâmetros em todo dia útil do início do aquecimento ao fim da janela. */
const params = (por: Record<string, ParamsDia | ((d: string) => ParamsDia)>, fim = JANELA[1]): Map<string, ParamsDia> => {
  const m = new Map<string, ParamsDia>();
  for (let d = INICIO_AQUECIMENTO; d <= fim; d = addDias(d, 1)) {
    if (!ehDiaUtil(d)) continue;
    for (const [s, p] of Object.entries(por)) m.set(`${s}|${d}`, typeof p === 'function' ? p(d) : p);
  }
  return m;
};
const roda = (dd: Dados, p: Map<string, ParamsDia>, extra: Partial<EntradaSimulacao> = {}): SomasSemanais =>
  simular({ formula: 'F1', params: p, rep: 0, lt: 'empirico', falta: 'espera', inicial: 'reconstruido', janela: JANELA, dados: dd, ...extra });
const soma = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

describe('decidirCompra', () => {
  const f0 = (pp: number, max: number, cob: number | null = null, dem: number | null = null): ParamsDia => ({ tipo: 'F0', pp, max, coberturaTetoDias: cob, demandaDiariaLinha: dem });

  it('teto não se aplica com mínimo forçado', () => {
    // posição 0, máximo 20, teto de 5 dias × 1/dia ⇒ cap 5; com mínimo forçado 2 o cap some ⇒ compra 20
    expect(decidirCompra(f0(5, 20, 5, 1), 0, sku('M', { minimoForcado: 2 }))).toBe(20);
    expect(decidirCompra(f0(5, 20, 5, 1), 0, sku('M'))).toBe(5);
  });

  it('teto B/C: max(floor(dias·d − posição), ceil(pp − posição)) sobre a posição realizada', () => {
    // dias 10 × 0,35 = 3,5 − 1 = 2,5 → floor 2; piso ceil(4 − 1) = 3 ⇒ 3 (nunca abaixo do pp)
    expect(decidirCompra(f0(4, 12, 10, 0.35), 1, sku('T'))).toBe(3);
    // dias 60 × 0,35 = 21 − 1 = 20 → cap 20 > necessidade 11 ⇒ 11
    expect(decidirCompra(f0(4, 12, 60, 0.35), 1, sku('T'))).toBe(11);
    // demanda da linha ausente (null) ⇒ sem cap (COALESCE(…,0) > 0 do motor)
    expect(decidirCompra(f0(4, 12, 10, null), 1, sku('T'))).toBe(11);
  });

  it('mínimo e múltiplo só com necessidade positiva', () => {
    const s = sku('MM', { minimoForcado: 2, multiplo: 5 });
    expect(decidirCompra(f0(3, 8), 4, s)).toBe(0); // posição > pp: nada, nem mínimo nem múltiplo
    expect(decidirCompra({ tipo: 'S', s: 6 }, 6, s)).toBe(0); // posição = S: nada
    expect(decidirCompra({ tipo: 'S', s: 6 }, 5, s)).toBe(5); // necessidade 1 → mínimo 2 → múltiplo 5
    expect(decidirCompra(f0(3, 8), 3, s)).toBe(5); // necessidade 5 → já múltiplo
    expect(decidirCompra(f0(3, 9), 3, s)).toBe(10); // necessidade 6 → 10
    // cap ZERA a linha (pp 1, posição 1, cobertura 1 dia × 0,5): sem mínimo, o múltiplo não ressuscita a compra
    expect(decidirCompra(f0(1, 10, 1, 0.5), 1, sku('Z', { multiplo: 5 }))).toBe(0);
    expect(decidirCompra(SEM, -10, s)).toBe(0);
  });

  it('posição fracionária: ceil da necessidade (poeira decimal do Omie)', () => {
    expect(decidirCompra(f0(3, 8), 2.5, sku('F'))).toBe(6);
    expect(decidirCompra({ tipo: 'S', s: 4 }, 0.2, sku('F'))).toBe(4);
  });

  it('grupo de embalagem: decide na unidade-base, divide por conv, sem cap e sem múltiplo do portal', () => {
    const anc = sku('QT', { grupoEmbalagemId: 'G', multiplo: 5 });
    // (3 − 0,81) / 0,81 = 2,70 → 3 embalagens (o motor: ceil((máx − efetivo)/conv_ancora))
    expect(decidirCompra(f0(2, 3, 60, 1), 0.81, anc, { conv: 0.81 })).toBe(3);
    // mínimo forçado em unidades-âncora ANTES de dividir: max(0,19, 2) / 0,81 = 2,47 → 3
    expect(decidirCompra(f0(2, 1, null, null), 0.81, { ...anc, minimoForcado: 2 }, { conv: 0.81 })).toBe(3);
    // necessidade 0 (máximo = posição): o mínimo forçado não cria compra
    expect(decidirCompra(f0(2, 0.81, null, null), 0.81, { ...anc, minimoForcado: 2 }, { conv: 0.81 })).toBe(0);
    expect(decidirCompra({ tipo: 'S', s: 4 }, 0, anc, { conv: 0.81 })).toBe(5); // 4/0,81 = 4,94 → 5
  });

  it('convDoGrupo: u da âncora se o grupo inteiro é coerente (u/fator igual); senão o fator', () => {
    const eq = (s: string, e: string, fs: number, fe: number, us: number | null, ue: number | null): Equivalencia => ({
      sku: s, skuEquivalente: e, fator: fs / fe, grupoId: 'G1', fatorParaBaseSku: fs, fatorParaBaseEquivalente: fe, unidadesOmieSku: us, unidadesOmieEquivalente: ue,
    });
    const base = [eq('QT', 'GL', 1, 4, 0.81, 3.24), eq('GL', 'QT', 4, 1, 3.24, 0.81)];
    const dd = dados([sku('QT'), sku('GL')], [], { equivalencias: base });
    expect(convDoGrupo(dd, 'QT')).toBeCloseTo(0.81, 12);
    expect(convDoGrupo(dd, 'GL')).toBeCloseTo(3.24, 12);
    expect(convDoGrupo(dd, 'OUTRO')).toBeNull();
    const incoerente = dados([sku('QT'), sku('GL')], [], { equivalencias: [eq('QT', 'GL', 1, 4, 0.81, 3.0), eq('GL', 'QT', 4, 1, 3.0, 0.81)] });
    expect(convDoGrupo(incoerente, 'QT')).toBe(1);
  });
});

describe('simular', () => {
  it('linha parcial', () => {
    const vs = [venda('a1', 'P', '2026-05-05', 2), venda('a2', 'P', '2026-05-05', 2)];
    const r = roda(dados([comAbertura(sku('P'), 3, vs)], vs), params({ P: SEM }));
    const t = r.porCelula.total;
    expect(soma(t.demandadas)).toBe(2);
    expect(soma(t.integrais)).toBe(1); // uma falha só
    expect(soma(t.unidDem)).toBe(4);
    expect(soma(t.unidAt)).toBe(3); // 2 + a unidade disponível
    expect(soma(r.entregue.imediata)).toBe(30);
    expect(r.terminal.backlogValor).toBe(10); // 1 unidade em obrigação
    expect(r.terminal.backlogDiasAtraso).toBe(10 * diffDias('2026-05-05', JANELA[1]));
  });

  it('obrigação atendida depois não vira sucesso', () => {
    const vs = [venda('a1', 'P', '2026-05-05', 2), venda('a2', 'P', '2026-05-05', 2)];
    // S = 0: só compra quando a posição fica negativa (−1 depois das linhas), LT do documento = 2 du
    const r = roda(dados([comAbertura(sku('P'), 3, vs)], vs), params({ P: { tipo: 'S', s: 0 } }), { rastro: true });
    expect(r.pedidos).toEqual([{ dia: '2026-05-05', sku: 'P', qtd: 1, chegada: '2026-05-07' }]);
    expect(soma(r.porCelula.total.integrais)).toBe(1);
    expect(soma(r.porCelula.total.demandadas)).toBe(2);
    expect(soma(r.entregue.tardia)).toBe(10);
    expect(soma(r.valorDiasAtraso)).toBe(10 * 2); // 05-05 → 05-07
    expect(r.terminal.backlogValor).toBe(0);
  });

  it('cancelamento e emergencial não geram backlog', () => {
    const vs = [venda('a1', 'P', '2026-05-05', 2), venda('a2', 'P', '2026-05-05', 2)];
    const dd = dados([comAbertura(sku('P'), 3, vs)], vs);
    const c = roda(dd, params({ P: SEM }), { falta: 'cancelamento' });
    expect(c.terminal.backlogValor).toBe(0);
    expect(soma(c.cancelada.valor)).toBe(10);
    expect(soma(c.cancelada.margem)).toBe(10 - 6); // valor − cmcLinha × quantidade
    expect(soma(c.entregue.emergencial)).toBe(0);
    // misto: linhaId cujo sorteio cai na faixa da compra emergencial ([0,6; 0,9) — spec §6: 60/30/10)
    let id = 0;
    for (let u = uniforme(0, 'falta', `e${id}`); !(u >= 0.6 && u < 0.9); u = uniforme(0, 'falta', `e${id}`)) id++;
    const vm = [venda('a1', 'P', '2026-05-05', 2), venda(`e${id}`, 'P', '2026-05-05', 2)];
    const m = roda(dados([comAbertura(sku('P'), 3, vm)], vm), params({ P: SEM }), { falta: 'misto' });
    expect(m.terminal.backlogValor).toBe(0);
    expect(soma(m.entregue.emergencial)).toBe(10);
    expect(soma(m.cancelada.valor)).toBe(0);
    expect(soma(m.porCelula.total.integrais)).toBe(1); // emergencial NÃO é sucesso
  });

  it('cancelamento com cmcLinha ausente: margem null contada à parte, nunca fabricada', () => {
    const vs = [venda('a1', 'P', '2026-05-05', 2, 20, null)];
    const r = roda(dados([comAbertura(sku('P'), 0, vs)], vs), params({ P: SEM }), { falta: 'cancelamento' });
    expect(soma(r.cancelada.valor)).toBe(20);
    // M1: semana só com canceladas sem cmc ⇒ margem null (ausente ≠ zero); semana sem cancelada ⇒ 0 real
    expect(r.cancelada.margem[0]).toBeNull();
    expect(r.cancelada.margem.slice(1).every((m) => m === 0)).toBe(true);
    expect(soma(r.canceladaSemCmc.linhas)).toBe(1);
    expect(soma(r.canceladaSemCmc.valor)).toBe(20);
  });

  it('fechamento', () => {
    const vs: LinhaVenda[] = [];
    let n = 0;
    for (let d = '2026-04-20'; d <= JANELA[1]; d = addDias(d, 1)) {
      if (ehDiaUtil(d) || d === '2026-05-09') {
        vs.push(venda(`f${n++}`, 'P', d, 1 + (n % 3), (1 + (n % 3)) * 10, n % 4 === 0 ? null : 6));
        if (n % 2 === 0) vs.push(venda(`g${n++}`, 'Q', d, 0.5 + (n % 2), 7, 3));
      }
    }
    const dd = dados([comAbertura(sku('P'), 6, vs), comAbertura(sku('Q', { cmc: null }), 2, vs)], vs, {
      itensLT: [item('D1', 'P', '2026-04-20', 3), item('D1', 'Q', '2026-04-20', 9), item('D2', 'P', '2026-05-12', 0)],
    });
    for (const falta of ['espera', 'cancelamento', 'misto'] as const) {
      const r = roda(dd, params({ P: { tipo: 'S', s: 5 }, Q: { tipo: 'F0', pp: 1, max: 3, coberturaTetoDias: null, demandaDiariaLinha: null } }), { falta, rep: 3 });
      const dem = soma(r.porCelula.total.valorDem);
      // achado 13: tardia e terminal incluem as obrigações herdadas de antes da janela (valor), que fecham à parte
      const h = r.herdadas!;
      const desfechos = soma(r.entregue.imediata) + soma(r.entregue.tardia) + soma(r.entregue.emergencial) + soma(r.cancelada.valor) + r.terminal.backlogValor;
      expect(desfechos - h.entregue.valor - h.terminal.valor).toBeCloseTo(dem, 9);
      expect(h.entregue.valor + h.terminal.valor).toBeCloseTo(h.abertura.valor, 9);
      expect(dem).toBeGreaterThan(0);
      const b = r.balanco;
      expect(b.inicial + b.recebido - b.entregue).toBeCloseTo(b.final, 9);
      expect(b.recebido).toBeGreaterThan(0);
      expect(r.skusSemCmc).toEqual(['Q']); // capital sem fabricar CMC
    }
  });

  it('sem compra em sábado', () => {
    // venda de sábado derruba a posição abaixo de S; o pedido só sai na segunda
    const vs = [venda('s1', 'P', '2026-05-09', 3)];
    const r = roda(dados([comAbertura(sku('P'), 3, vs)], vs), params({ P: { tipo: 'S', s: 1 } }), { rastro: true });
    expect(r.pedidos!.length).toBeGreaterThan(0);
    for (const p of r.pedidos!) expect(ehDiaUtil(p.dia)).toBe(true);
    expect(r.pedidos![0].dia).toBe('2026-05-11');
  });

  it('ltDu = 0 chega no próximo dia útil (LT efetivo mínimo de 1 du)', () => {
    const vs = [venda('z1', 'P', '2026-05-08', 3)]; // sexta
    const dd = dados([comAbertura(sku('P'), 3, vs)], vs, { itensLT: [item('D0', 'X', '2026-05-07', 0)] });
    const r = roda(dd, params({ P: { tipo: 'S', s: 1 } }), { rastro: true });
    expect(r.pedidos![0]).toEqual({ dia: '2026-05-08', sku: 'P', qtd: 1, chegada: '2026-05-11' });
  });

  it('compras abertas no início: pedido com t1 < início e chegada >= início entra como chegada programada', () => {
    const chegada = '2025-10-23';
    const receb: EventoRecebimento[] = [{ sku: 'P', data: chegada, quantidade: 4 }];
    const vs = [venda('o1', 'P', '2025-10-24', 4)];
    const dd = dados([comAbertura(sku('P'), 0, vs, receb)], vs, {
      recebimentos: receb,
      itensLT: [{ trackingId: 'ANT', sku: 'P', t1: '2025-10-15', t2: null, t4: chegada, ltDu: 6, aberto: false }, item('DOC0', 'Q', '2026-05-04', 2)],
    });
    const r = roda(dd, params({ P: SEM }), { janela: ['2025-10-21', '2025-10-31'] });
    expect(soma(r.porCelula.total.integrais)).toBe(1);
    expect(r.balanco.recebido).toBe(4);
    // um recebimento de pedido feito DEPOIS do início é substituído pelas compras simuladas: não entra
    const dd2 = dados([comAbertura(sku('P'), 0, vs, receb)], vs, {
      recebimentos: receb, itensLT: [{ trackingId: 'NOVO', sku: 'P', t1: '2025-10-21', t2: null, t4: chegada, ltDu: 2, aberto: false }],
    });
    const r2 = roda(dd2, params({ P: SEM }), { janela: ['2025-10-21', '2025-10-31'] });
    expect(r2.balanco.recebido).toBe(0);
    expect(soma(r2.porCelula.total.integrais)).toBe(0);
  });

  it('grupo de embalagem: a âncora decide pela posição do grupo; o galão não decide; atendimento por SKU', () => {
    const eqs: Equivalencia[] = [
      { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'G', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
      { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'G', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
    ];
    const vs = [venda('q1', 'QT', '2026-05-05', 0.81)];
    const dd = dados([comAbertura(sku('QT', { grupoEmbalagemId: 'G' }), 0.81, vs), comAbertura(sku('GL', { grupoEmbalagemId: 'G' }), 3.24, vs)], vs, { equivalencias: eqs });
    const p = params({ QT: { tipo: 'S', s: 4 }, GL: { tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' } });
    const r = roda(dd, p, { rastro: true });
    // posição do grupo = 0,81 + 3,24 = 4,05 ≥ 4: não compra antes da venda; depois 3,24 < 4 ⇒ ceil(0,76/0,81) = 1 QT = 0,81 L
    expect(r.pedidos!.map((x) => [x.dia, x.sku, x.qtd])).toEqual([['2026-05-05', 'QT', 0.81]]);
    expect(r.pedidos!.every((x) => x.sku === 'QT')).toBe(true);
  });

  it('substituição usa a equivalência e BAIXA o estoque do equivalente (o mesmo galão não salva duas linhas)', () => {
    const eqs: Equivalencia[] = [
      { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'G', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
      { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'G', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
    ];
    // duas linhas de 4 QT (3,24 L) sem QT em estoque; 1 galão (3,24 L)
    const vs = [venda('s1', 'QT', '2026-05-05', 3.24), venda('s2', 'QT', '2026-05-05', 3.24)];
    const dd = dados([comAbertura(sku('QT', { grupoEmbalagemId: 'G' }), 0, vs), comAbertura(sku('GL', { grupoEmbalagemId: 'G' }), 3.24, vs)], vs, { equivalencias: eqs });
    const p = params({ QT: SEM, GL: SEM });
    const exato = roda(dd, p);
    const sub = roda(dd, p, { substituicao: true });
    expect(soma(exato.porCelula.total.integrais)).toBe(0);
    expect(soma(sub.porCelula.total.integrais)).toBe(1);
    expect(sub.balanco.final).toBeCloseTo(0, 12);
    // 1 QT (0,81 L) não é galão inteiro: não substitui
    const v1 = [venda('u1', 'QT', '2026-05-05', 0.81)];
    const d1 = dados([comAbertura(sku('QT', { grupoEmbalagemId: 'G' }), 0, v1), comAbertura(sku('GL', { grupoEmbalagemId: 'G' }), 3.24, v1)], v1, { equivalencias: eqs });
    expect(soma(roda(d1, p, { substituicao: true }).porCelula.total.integrais)).toBe(0);
  });

  it('células: total = A + B + C; capital ponderado por dias corridos', () => {
    const vs = [venda('c1', 'P', '2026-05-05', 1)];
    const r = roda(dados([comAbertura(sku('P', { cmc: 4 }), 3, vs)], vs), params({ P: SEM }));
    const t = r.porCelula.total.demandadas;
    const abc = ['A', 'B', 'C'] as const;
    expect(soma(t)).toBe(abc.reduce((a, c) => a + soma(r.porCelula[c].demandadas), 0));
    expect(soma(r.diasCorridos)).toBe(diffDias(JANELA[0], JANELA[1]) + 1);
    // 3 L até 05-04 e 05-05 depois da venda 2 L: 4 × (3 × 1 dia + 2 × 25 dias)
    expect(soma(r.estoqueCmcDias)).toBe(4 * (3 + 2 * 25));
    expect(r.semanas[0]).toBe(JANELA[0]);
  });

  it('parâmetro ausente num dia útil lança (fail-closed)', () => {
    const vs = [venda('c1', 'P', '2026-05-05', 1)];
    const p = params({ P: SEM });
    p.delete('P|2026-05-06');
    expect(() => roda(dados([comAbertura(sku('P'), 3, vs)], vs), p)).toThrow(/^PARAMS_AUSENTES:P\|2026-05-06$/);
  });
});

describe('paridadeQuantidade', () => {
  it('compara a decisão com qtde_final na posição gravada; membro não-âncora e SKU fora são informativos', () => {
    const s1 = sku('S1', { hoje: { es: 1, pp: 3, max: 8 } });
    const s2 = sku('S2', { hoje: { es: 1, pp: 1, max: 2 } });
    const dd = dados([s1, s2], [], {
      sugestaoHoje: new Map([
        ['S1', { posicao: 3, qtdeFinal: 5 }],
        ['S2', { posicao: 1, qtdeFinal: 1 }],
        ['NAO_EXISTE', { posicao: 0, qtdeFinal: 3 }],
      ]),
    });
    const f0 = (pp: number, max: number): ParamsDia => ({ tipo: 'F0', pp, max, coberturaTetoDias: null, demandaDiariaLinha: null });
    // replay: S1 igual ao gravado; S2 com estado diferente (pp 2 / máx 3 ⇒ compra 2 ≠ 1)
    const r = paridadeQuantidade(dd, (s) => (s === 'S1' ? f0(3, 8) : f0(2, 3)));
    expect(r.replay).toEqual({ n: 1, de: 2 });
    expect(r.gravado).toEqual({ n: 2, de: 2 });
    expect(r.linhas.find((l) => l.sku === 'NAO_EXISTE')!.fora).toBe('FORA_DOS_DADOS');
  });
});

describe('fix round 1', () => {
  it('I1: na calibração o capital usa o último cmcLinha <= fim da calibração, nunca o cmc de hoje', () => {
    const vs = [venda('k1', 'P', '2026-03-10', 1, 10, 5), venda('k2', 'P', '2026-05-12', 1, 10, 7)];
    const JC: [string, string] = ['2026-02-02', JANELAS.calibracaoFim];
    const roda2 = (cmcHoje: number | null) =>
      roda(dados([comAbertura(sku('P', { cmc: cmcHoje }), 10, vs), comAbertura(sku('SEMCMC', { cmc: 9 }), 4, vs)], vs), params({ P: SEM, SEMCMC: SEM }), { janela: JC });
    const a = roda2(4);
    const b = roda2(99);
    expect(b.estoqueCmcDias).toEqual(a.estoqueCmcDias);
    // P: 10 L até 03-09, 9 L de 03-10 ao fim, valorado a 5 (cmcLinha de 03-10; o de 05-12 é futuro)
    const diasAntes = diffDias(JC[0], '2026-03-09') + 1;
    const diasDepois = diffDias('2026-03-10', JC[1]) + 1;
    expect(soma(a.estoqueCmcDias)).toBeCloseTo(5 * (10 * diasAntes + 9 * diasDepois), 9);
    expect(a.terminal.estoqueCmc).toBe(5 * 9);
    // SKU sem cmcLinha até o fim da calibração fica fora do capital, mesmo com cmc de hoje
    expect(a.skusSemCmc).toEqual(['SEMCMC']);
    // na avaliação continua o cmc de hoje (numerário constante, declarado)
    const av = roda(dados([comAbertura(sku('P', { cmc: 4 }), 10, vs)], vs), params({ P: SEM }));
    expect(av.terminal.estoqueCmc).toBe(4 * 8);
  });

  it('M2: marcas dos ramos fail-closed', () => {
    expect(() => conferirFechamento('X', 10, 9)).toThrow(/^FECHAMENTO_VIOLADO:X:/);
    expect(() => conferirFechamento('X', 10, 10 + 1e-12)).not.toThrow();
    expect(() => conferirEstoque('X', 5, 3, 2, 7)).toThrow(/^ESTOQUE_NAO_FECHA:X$/);
    expect(() => conferirEstoque('X', 5, 3, 2, 6)).not.toThrow();
    const eqs: Equivalencia[] = [
      { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'G', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
      { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'G', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
    ];
    const dg = dados([comAbertura(sku('QT', { grupoEmbalagemId: 'G' }), 1, []), comAbertura(sku('GL', { grupoEmbalagemId: 'G' }), 1, [])], [], { equivalencias: eqs });
    expect(() => roda(dg, params({ QT: { tipo: 'S', s: 1 }, GL: { tipo: 'S', s: 1 } }))).toThrow(/^GRUPO_MEMBRO_COM_DECISAO:GL\|/);
    const dp = dados([comAbertura(sku('P'), 1, [])], []);
    expect(() => roda(dp, params({ P: { tipo: 'S', s: 1 } }), { formula: 'F0' })).toThrow(/^FORMULA_INCOERENTE:P\|/);
  });

  it('M3: pareamento — F0 e Fn com a mesma rep sorteiam o mesmo LT no mesmo (d, sku) e o mesmo desfecho na mesma linha', () => {
    const vs: LinhaVenda[] = [];
    let n = 0;
    for (let d = '2026-05-04'; d <= JANELA[1]; d = addDias(d, 1)) if (ehDiaUtil(d)) vs.push(venda(`m${n++}`, 'P', d, 2), venda(`m${n++}`, 'P', d, 1));
    const its = [3, 5, 8, 13, 21].flatMap((lt, k) => [item(`D${k}`, 'X', addDias('2026-05-04', 3 * k), lt), item(`D${k}`, 'Y', addDias('2026-05-04', 3 * k), lt + 4)]);
    const dd = dados([comAbertura(sku('P'), 2, vs)], vs, { itensLT: its });
    const f0: ParamsDia = { tipo: 'F0', pp: 0, max: 3, coberturaTetoDias: null, demandaDiariaLinha: null };
    const fn: ParamsDia = { tipo: 'S', s: 1 };
    let comparados = 0;
    let desfechosComuns = 0;
    for (const rep of [0, 1, 2, 3]) {
      const a = roda(dd, params({ P: f0 }), { formula: 'F0', rep, falta: 'misto', rastro: true });
      const b = roda(dd, params({ P: fn }), { formula: 'F1', rep, falta: 'misto', rastro: true });
      const chegB = new Map(b.pedidos!.map((p) => [`${p.dia}|${p.sku}`, p.chegada]));
      for (const p of a.pedidos!) {
        const k = `${p.dia}|${p.sku}`;
        if (!chegB.has(k)) continue;
        expect(chegB.get(k)).toBe(p.chegada);
        comparados++;
      }
      const desB = new Map(b.desfechos!.map((x) => [x.linhaId, x.desfecho]));
      for (const x of a.desfechos!) {
        if (!desB.has(x.linhaId)) continue;
        expect(desB.get(x.linhaId)).toBe(x.desfecho);
        desfechosComuns++;
      }
    }
    expect(comparados).toBeGreaterThan(0);
    expect(desfechosComuns).toBeGreaterThan(0);
  });
});

describe('revisão final da branch', () => {
  it('I1: misto = 60% espera, 30% compra EMERGENCIAL, 10% cancelamento (spec §6)', () => {
    expect(CENARIOS_FALTA.misto).toEqual({ espera: 0.6, emergencial: 0.3, cancelamento: 0.1 });
    // 10k linhas sem estoque nem compra: toda linha falha e segue o desfecho do misto
    const vs: LinhaVenda[] = [];
    for (let i = 0; i < 10_000; i++) vs.push(venda(`m${i}`, 'P', addDias(JANELA[0], i % 20), 1));
    const r = roda(dados([comAbertura(sku('P'), 0, vs)], vs), params({ P: SEM }), { falta: 'misto', rastro: true });
    const n = r.desfechos!.length;
    expect(n).toBe(10_000);
    const fr = (d: string) => r.desfechos!.filter((x) => x.desfecho === d).length / n;
    expect(Math.abs(fr('espera') - 0.6)).toBeLessThan(0.02);
    expect(Math.abs(fr('emergencial') - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(fr('cancelamento') - 0.1)).toBeLessThan(0.02);
  });
  it('I2: as células *_alt seguem o conjunto `alterados` passado (a mesma fonte que troca a fórmula)', () => {
    const vs = [venda('a1', 'P', '2026-05-05', 1), venda('a2', 'P', '2026-05-12', 1)];
    const dd = dados([comAbertura(sku('P'), 5, vs)], vs);
    const soma2 = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(soma2(roda(dd, params({ P: SEM })).porCelula.C_alt.demandadas)).toBe(0); // P não é alterado na coorte
    const r = roda(dd, params({ P: SEM }), { alterados: new Set(['P']) });
    expect(soma2(r.porCelula.C_alt.demandadas)).toBe(2);
  });
});

describe('Fix Codex leva B', () => {
  const diasUteis = (ini: string, fim: string): string[] => {
    const out: string[] = [];
    for (let d = ini; d <= fim; d = addDias(d, 1)) if (ehDiaUtil(d)) out.push(d);
    return out;
  };
  const CALIB: [string, string] = [JANELAS.calibracaoIni, JANELAS.calibracaoFim];
  const AVAL: [string, string] = [JANELAS.avaliacaoIni, '2026-05-29'];

  // Achado 3 (contraprova): o MESMO pedido de 20/04, mesma rep e mesmos parâmetros, chegava em 21/04 na calibração e em
  // 04/05 na avaliação, porque a avaliação sorteava entre documentos que só terminaram depois de 30/04.
  it('achado 3: pedido de 20/04 chega no mesmo dia na calibração e na avaliação (restrição por fase do calendário)', () => {
    const vs = [venda('v1', 'P', '2026-05-20', 1)];
    const its: ItemLT[] = [
      { trackingId: 'A', sku: 'Q', t1: '2026-04-17', t2: null, t4: '2026-04-21', ltDu: 2, aberto: false },
      { trackingId: 'B', sku: 'Q', t1: '2026-04-20', t2: null, t4: '2026-05-04', ltDu: 10, aberto: false },
      { trackingId: 'C', sku: 'Q', t1: '2026-04-21', t2: null, t4: null, ltDu: 15, aberto: true },
    ];
    const dd = dados([comAbertura(sku('P'), 0, vs)], vs, { itensLT: its });
    const p = params({ P: (d: string) => (d === '2026-04-20' ? { tipo: 'S', s: 3 } : SEM) }, AVAL[1]);
    let comDocPosterior = 0;
    for (let rep = 0; rep < 30; rep++) {
      const c = roda(dd, p, { rep, janela: CALIB, rastro: true }).pedidos!;
      const a = roda(dd, p, { rep, janela: AVAL, rastro: true }).pedidos!;
      expect(c).toEqual([{ dia: '2026-04-20', sku: 'P', qtd: 3, chegada: '2026-04-22' }]);
      expect(a.filter((x) => x.dia <= JANELAS.calibracaoFim), `rep ${rep}`).toEqual(c);
      if (uniforme(rep, 'doc', '2026-04-20') >= 1 / 3) comDocPosterior++;
    }
    expect(comDocPosterior).toBeGreaterThan(5); // controle: sem a fase, essas reps sorteariam B ou C na avaliação
  });

  it('achado 3: compra aberta no início que chega depois de 30/04 conta na posição dos dois ambientes', () => {
    const receb: EventoRecebimento[] = [{ sku: 'P', data: '2026-05-12', quantidade: 4 }];
    const vs = [venda('v1', 'P', '2026-05-20', 1)];
    const dd = dados([comAbertura(sku('P'), 0, vs, receb)], vs, {
      recebimentos: receb,
      itensLT: [
        { trackingId: 'ANT', sku: 'P', t1: '2025-10-15', t2: null, t4: '2026-05-12', ltDu: 149, aberto: false },
        { trackingId: 'A', sku: 'Q', t1: '2025-10-22', t2: null, t4: '2025-10-24', ltDu: 2, aberto: false },
      ],
    });
    const p = params({ P: { tipo: 'S', s: 4 } }, AVAL[1]);
    const c = roda(dd, p, { janela: CALIB, rastro: true });
    const a = roda(dd, p, { janela: AVAL, rastro: true });
    expect(c.pedidos).toEqual([]); // posição = 0 + 4 abertas: não compra
    expect(a.pedidos!.filter((x) => x.dia <= JANELAS.calibracaoFim)).toEqual(c.pedidos);
  });

  // Achado 7: célula e quantil pela classe do DIA (dados até a véspera), não pela do início da janela.
  it('achado 7: cada linha cai na célula A/B/C da classe efetiva do seu dia', () => {
    const dus = diasUteis(INICIO_AQUECIMENTO, AVAL[1]);
    // X é B até 11/05; Y passa a vender muito a partir de 11/05 e X cai para C (Z* só compõem o Pareto do universo)
    const vx = dus.map((d, i) => venda(`x${i}`, 'X', d, 1, 1000));
    const vy = dus.filter((d) => d >= '2026-05-11').map((d, i) => venda(`y${i}`, 'Y', d, 1, 100000));
    const vz = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'].flatMap((z) => dus.map((d, i) => venda(`${z}${i}`, z, d, 1, 10)));
    const vs = [...vx, ...vy, ...vz];
    const dd = dados([comAbertura(sku('X'), 10000, vs), comAbertura(sku('Y'), 10000, vs)], vs);
    const r = roda(dd, params({ X: SEM, Y: SEM }), { janela: AVAL });
    const esperado = { A: 0, B: 0, C: 0 };
    let mudaram = 0;
    const inicio = classeEfetiva(dd, AVAL[0]);
    for (const v of [...vx, ...vy].filter((x) => x.data >= AVAL[0] && x.data <= AVAL[1])) {
      const c = classeEfetiva(dd, v.data).get(v.sku) ?? 'C';
      esperado[c]++;
      if (c !== (inicio.get(v.sku) ?? 'C')) mudaram++;
    }
    expect(mudaram).toBeGreaterThan(3); // controle: a classe muda dentro da janela
    expect({ A: soma(r.porCelula.A.demandadas), B: soma(r.porCelula.B.demandadas), C: soma(r.porCelula.C.demandadas) }).toEqual(esperado);
    // *_alt = classe do dia ∩ coorte alterada
    const ra = roda(dd, params({ X: SEM, Y: SEM }), { janela: AVAL, alterados: new Set(['X']) });
    const altX = { A: 0, B: 0, C: 0 };
    for (const v of vx.filter((x) => x.data >= AVAL[0])) altX[classeEfetiva(dd, v.data).get('X') ?? 'C']++;
    expect({ A: soma(ra.porCelula.A_alt.demandadas), B: soma(ra.porCelula.B_alt.demandadas), C: soma(ra.porCelula.C_alt.demandadas) }).toEqual(altX);
  });

  // Achado 13 (contraprova): falta de 30/04 atendida em 21/05 dava ZERO entrega tardia e ZERO valor×dias na avaliação.
  it('achado 13: obrigação de antes da janela entra na conta econômica e no backlog terminal, não no serviço', () => {
    const vs = [venda('v1', 'P', '2026-04-30', 1, 10)];
    const its: ItemLT[] = [
      { trackingId: 'A', sku: 'Q', t1: '2026-04-01', t2: null, t4: '2026-04-03', ltDu: 2, aberto: false },
      { trackingId: 'D', sku: 'Q', t1: '2026-05-19', t2: null, t4: '2026-05-21', ltDu: 2, aberto: false },
    ];
    const dd = dados([comAbertura(sku('P'), 0, vs)], vs, { itensLT: its });
    const comCompra = params({ P: (d: string) => (d === '2026-05-19' ? { tipo: 'S', s: 1 } : SEM) }, AVAL[1]);
    const r = roda(dd, comCompra, { janela: AVAL, rastro: true, inicial: 'piso_zero' });
    expect(r.pedidos).toEqual([{ dia: '2026-05-19', sku: 'P', qtd: 2, chegada: '2026-05-21' }]);
    expect(soma(r.porCelula.total.demandadas)).toBe(0); // o denominador de serviço segue só com as linhas da janela
    expect(soma(r.entregue.tardia)).toBe(10);
    expect(soma(r.valorDiasAtraso)).toBe(10 * 21); // 30/04 → 21/05: os dias depois do fim da calibração
    expect(r.terminal.backlogValor).toBe(0);
    // sem a compra: a obrigação fica no backlog terminal da avaliação, com o atraso contado desde o fim da calibração
    const sem = roda(dd, params({ P: SEM }, AVAL[1]), { janela: AVAL, inicial: 'piso_zero' });
    expect(sem.terminal.backlogValor).toBe(10);
    expect(sem.terminal.backlogDiasAtraso).toBe(10 * 29);
    // a calibração mede a linha e custeia o terminal no seu último dia (0 dias); a avaliação não a conta de novo no serviço
    const cal = roda(dd, params({ P: SEM }, AVAL[1]), { janela: CALIB, inicial: 'piso_zero' });
    expect(soma(cal.porCelula.total.demandadas)).toBe(1);
    expect(cal.terminal).toMatchObject({ backlogValor: 10, backlogDiasAtraso: 0 });
  });
});

// Achado 9: a produção pode comprar o membro do grupo (galão) mais barato por unidade-base (db/embalagem-motor-rpc.sql,
// CTEs preco_app/membro_elegivel/embalagem_escolhida e o "trocou"); o replay sempre comprava a âncora.
describe('achado 9: escolha de embalagem do grupo', () => {
  const eqs: Equivalencia[] = [
    { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'G', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
    { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'G', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
  ];
  const precos = (cap: Record<string, [string, number][]>, elegivel: Record<string, boolean> = { QT: true, GL: true }): PrecosEmbalagem => ({
    staleDias: 45,
    elegivel: new Map(Object.entries(elegivel)),
    capturas: new Map(Object.entries(cap).map(([k, v]) => [k, v.map(([data, preco]) => ({ data, preco }))])),
  });
  const grupo = (pe: PrecosEmbalagem | null, vs: LinhaVenda[] = [], abQT = 0, abGL = 0, extra: Partial<Dados> = {}) =>
    dados([comAbertura(sku('QT', { grupoEmbalagemId: 'G' }), abQT, vs), comAbertura(sku('GL', { grupoEmbalagemId: 'G' }), abGL, vs)], vs, { equivalencias: eqs, precosEmbalagem: pe, ...extra });

  it('troca para o galão só com preço-app conhecido (captura < d), fresco (<= 45 d), elegível e ESTRITAMENTE mais barato por base', () => {
    const barato = precos({ QT: [['2026-06-05', 10]], GL: [['2026-06-05', 36]] }); // GL: 36/4 = 9 < 10
    const dd = grupo(barato);
    expect(embalagemEscolhida(dd, 'QT', '2026-06-05')).toEqual({ sku: 'QT', conv: 0.81 }); // captura do próprio dia: ainda não
    expect(embalagemEscolhida(dd, 'QT', '2026-06-08')).toEqual({ sku: 'GL', conv: 3.24 });
    expect(embalagemEscolhida(dd, 'QT', '2026-07-20')).toEqual({ sku: 'GL', conv: 3.24 }); // 45 dias depois: ainda fresco
    expect(embalagemEscolhida(dd, 'QT', '2026-07-21')).toEqual({ sku: 'QT', conv: 0.81 }); // velho: não troca
    // a captura MAIS RECENTE decide (DISTINCT ON): GL ficou caro em 10/06
    const subiu = grupo(precos({ QT: [['2026-06-05', 10]], GL: [['2026-06-05', 36], ['2026-06-10', 44]] }));
    expect(embalagemEscolhida(subiu, 'QT', '2026-06-15')?.sku).toBe('QT');
    expect(embalagemEscolhida(grupo(precos({ QT: [['2026-06-05', 10]], GL: [['2026-06-05', 36]] }, { QT: true, GL: false })), 'QT', '2026-06-08')?.sku).toBe('QT');
    expect(embalagemEscolhida(grupo(precos({ GL: [['2026-06-05', 36]] })), 'QT', '2026-06-08')?.sku).toBe('QT'); // âncora sem preço: estrito
    expect(embalagemEscolhida(grupo(precos({ QT: [['2026-06-05', 9]], GL: [['2026-06-05', 36]] })), 'QT', '2026-06-08')?.sku).toBe('QT'); // empate
    expect(embalagemEscolhida(grupo(null), 'QT', '2026-06-08')).toEqual({ sku: 'QT', conv: 0.81 });
    expect(embalagemEscolhida(grupo(barato), 'GL', '2026-06-08')).toBeNull(); // galão não é âncora
  });

  it('simular: a compra cai no galão escolhido, com a conversão completa, e chega no estoque dele', () => {
    const vs = [venda('q1', 'QT', '2026-06-09', 0.81)];
    const dd = grupo(precos({ QT: [['2026-06-05', 10]], GL: [['2026-06-05', 36]] }), vs, 0.81, 0, {
      itensLT: [item('A', 'Q', '2026-04-01', 2), item('B', 'Q', '2026-06-09', 2)],
    });
    const fim = '2026-06-30';
    const p = params({ QT: (d: string) => (d === '2026-06-09' ? { tipo: 'S', s: 4 } : SEM), GL: { tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' } }, fim);
    const r = roda(dd, p, { janela: ['2026-06-01', fim], rastro: true });
    // posição do grupo 0 < 4: ceil(4 / 3,24) = 2 galões = 6,48 L no estoque do GL
    expect(r.pedidos).toEqual([{ dia: '2026-06-09', sku: 'GL', qtd: 6.48, chegada: '2026-06-11' }]);
    expect(r.balanco.recebido).toBeCloseTo(6.48, 9);
    // o galão fora da população (sem parâmetros no mapa) entra no plano como EXTRA: recebe a compra, não é medido
    const vs2 = [...vs, venda('g1', 'GL', '2026-06-16', 3.24)];
    const dd2 = grupo(precos({ QT: [['2026-06-05', 10]], GL: [['2026-06-05', 36]] }), vs2, 0.81, 0, { itensLT: dd.itensLT });
    const pSoQT = params({ QT: (d: string) => (d === '2026-06-09' ? { tipo: 'S', s: 4 } : SEM) }, fim);
    const r2 = roda(dd2, pSoQT, { janela: ['2026-06-01', fim], rastro: true });
    expect(r2.pedidos).toEqual(r.pedidos);
    expect(soma(r2.porCelula.total.demandadas)).toBe(1); // só a linha do QT
    expect(r2.balanco.entregue).toBeCloseTo(0.81 + 3.24, 9); // a linha do galão consumiu o estoque comprado
  });

  it('paridadeQuantidade inclui o membro escolhido pela produção (o galão) e compara a escolha', () => {
    const pe = precos({ QT: [['2026-10-01', 10]], GL: [['2026-10-01', 36]] });
    const sQT = sku('QT', { grupoEmbalagemId: 'G', hoje: { es: 1, pp: 3, max: 8 } });
    const sGL = sku('GL', { grupoEmbalagemId: 'G' });
    const f0 = (pp: number, max: number): ParamsDia => ({ tipo: 'F0', pp, max, coberturaTetoDias: null, demandaDiariaLinha: null });
    const comGL = dados([sQT, sGL], [], { equivalencias: eqs, precosEmbalagem: pe, sugestaoHoje: new Map([['GL', { posicao: 1, qtdeFinal: 3 }]]) });
    const r = paridadeQuantidade(comGL, (s) => (s === 'QT' ? f0(3, 8) : { tipo: 'SEM_DECISAO', motivo: 'MEMBRO_GRUPO_NAO_ANCORA' }));
    // (8 − 1) / 3,24 = 2,16 → 3 galões, com os parâmetros da âncora
    expect(r.linhas).toEqual([{ sku: 'GL', posicao: 1, qtdeFinal: 3, replay: 3, gravado: 3, fora: null }]);
    expect(r.replay).toEqual({ n: 1, de: 1 });
    // a produção comprou a âncora, mas o replay escolheria o galão: não bate
    const comQT = dados([sQT, sGL], [], { equivalencias: eqs, precosEmbalagem: pe, sugestaoHoje: new Map([['QT', { posicao: 1, qtdeFinal: 9 }]]) });
    const r2 = paridadeQuantidade(comQT, () => f0(3, 8));
    expect(r2.linhas[0]).toMatchObject({ sku: 'QT', replay: 0, fora: null });
    expect(r2.replay).toEqual({ n: 0, de: 1 });
  });
});


describe('Fix Codex leva C', () => {
  it('achado 10: o estoque de SKU sem CMC não some do capital; vai para estoqueNaoValoradoDias (unidades × dias)', () => {
    // contraprova do Codex: o aumento de estoque concentrado no SKU sem CMC não aparecia no capital
    const vs = [venda('n1', 'P', '2026-05-05', 1)];
    const r = roda(dados([comAbertura(sku('P', { cmc: 4 }), 3, vs), comAbertura(sku('N', { cmc: null }), 50, vs)], vs), params({ P: SEM, N: SEM }));
    const dias = diffDias(JANELA[0], JANELA[1]) + 1;
    expect(soma(r.estoqueCmcDias)).toBe(4 * (3 + 2 * 25)); // o valorado continua o mesmo
    expect(soma(r.estoqueNaoValoradoDias)).toBe(50 * dias);
    expect(soma(r.estoqueUnidadesDias)).toBe(3 + 2 * 25 + 50 * dias);
    expect(r.skusSemCmc).toEqual(['N']);
    // sem SKU sem CMC: zero não valorado
    const ok = roda(dados([comAbertura(sku('P', { cmc: 4 }), 3, vs)], vs), params({ P: SEM }));
    expect(soma(ok.estoqueNaoValoradoDias)).toBe(0);
  });

  it('R37: o capital dos grupos de embalagem sai à parte (fração dos grupos no capital)', () => {
    const eqs: Equivalencia[] = [
      { sku: 'QT', skuEquivalente: 'GL', fator: 0.25, grupoId: 'G', fatorParaBaseSku: 1, fatorParaBaseEquivalente: 4, unidadesOmieSku: 0.81, unidadesOmieEquivalente: 3.24 },
      { sku: 'GL', skuEquivalente: 'QT', fator: 4, grupoId: 'G', fatorParaBaseSku: 4, fatorParaBaseEquivalente: 1, unidadesOmieSku: 3.24, unidadesOmieEquivalente: 0.81 },
    ];
    const vs: LinhaVenda[] = [];
    const dd = dados(
      [comAbertura(sku('QT', { grupoEmbalagemId: 'G', cmc: 2 }), 0.81, vs), comAbertura(sku('GL', { grupoEmbalagemId: 'G', cmc: 3 }), 3.24, vs), comAbertura(sku('P', { cmc: 4 }), 5, vs)],
      vs, { equivalencias: eqs },
    );
    const r = roda(dd, params({ QT: SEM, GL: SEM, P: SEM }));
    const dias = diffDias(JANELA[0], JANELA[1]) + 1;
    expect(soma(r.estoqueCmcDiasGrupos)).toBeCloseTo((2 * 0.81 + 3 * 3.24) * dias, 9);
    expect(soma(r.estoqueCmcDias)).toBeCloseTo((2 * 0.81 + 3 * 3.24 + 4 * 5) * dias, 9);
  });
});
