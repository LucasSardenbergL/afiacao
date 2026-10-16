// scripts/orcamento-compra/simular.test.ts
import { describe, expect, it } from 'vitest';
import { backtest, continuidadePorDiaUtil, dataLocalSP, extrairJson, lagsAsOf, precisaoPorEpisodio, preVoo, reservaDe, simularCiclo, type Config, type DetalheCorte, type Fatos, type ResultadoCiclo } from './simular';

const cfg: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

const dia = (base: [number, number, number], i: number) => new Date(Date.UTC(base[0], base[1], base[2] + i)).toISOString().slice(0, 10);

/** R39: 10 observações de cada lag, todas concluídas em junho (antes de qualquer ciclo dos testes). */
const lagObs = (fat: number, venc: number, cheg: number, n = 10, base: [number, number, number] = [2026, 5, 1]): Fatos['lag_obs'] => {
  const obs = (dias: number) => Array.from({ length: n }, (_, i) => ({ t1: dia(base, i), fim: dia(base, i + dias), dias }));
  return { faturamento: obs(fat), vencimento: obs(venc), chegada: obs(cheg) };
};
/** R50: disparado antigo (fora dos 180 dias dos compromissos e dos 90 da continuidade) = o motor já existia. */
const HIST = { id: 99, valor_total: 1_000, momento: '2026-03-01T12:00:00Z', nfs: [] as string[] };

const fatos: Fatos = {
  meta: { gerado_em: '2026-10-15T12:00:00Z', hoje: '2026-10-15' },
  ciclos: [{ id: 1, status: 'disparado', data_ciclo: '2026-10-01', horario_geracao: '2026-10-01T12:00:00Z', horario_disparo_real: null, valor_total: 40, omie_pedido_compra_id: null }],
  linhas: [{ raiz: 1, pedido_id: 1, sku_codigo_omie: '9', qtde: 4, fator_embalagem_portal: null, preco_unitario: 10, estoque_atual: 0, estoque_fisico: 0, ponto_pedido: 2, modo_promocao: null, preco_sem_desconto: null }],
  demanda: Array.from({ length: 200 }, (_, i) => ({ sku: '9', data: dia([2026, 3, 1], i), qtde: 1 })),
  recebimentos: [],
  estoque: [{ sku: '9', estoque_fisico: 50 }],
  params: [{ sku: '9', preco_venda_medio: 15, demanda_media_diaria: 1, demanda_sigma_diario: 0.5 }],
  snapshots: [{ dia: '2026-10-01', snapshot_at: '2026-10-01T10:00:00Z', saldo_tesouraria: 646_000, dados: [] }],
  disparados: [HIST],
  titulos_sayerlack: [],
  ids_sayerlack: [],
  chegadas: [],
  pagos_nao_sayerlack: [{ data: '2026-09-05', valor: 1_000 }],
  lag_obs: lagObs(2, 1, 14),
  cm_anual: 0.15,
};

// Ciclo com corte classificável: chegada em 5 dias (14 dias de replay ≥ L+1), caixa zerado (protegida
// fura a reserva → as 3 discricionárias saem 'financeiro'). O estoque reconstruído no fim de 30/09 é
// 50 + 15 (demanda de 01/10..15/10) = 65 — a linha que grava 65 fecha; a que grava 0 não fecha.
const cortavel = (estoqueFisicoDaLinha: number): Fatos => ({
  ...fatos,
  linhas: [{ ...fatos.linhas[0], estoque_fisico: estoqueFisicoDaLinha }],
  snapshots: [{ ...fatos.snapshots[0], saldo_tesouraria: 0 }],
  lag_obs: lagObs(2, 1, 5),
});

// Igual ao `cortavel`, mas HOJE = 15/11 (o ciclo tem 30 dias de horizonte para o ΔDIO). Estoque de hoje 19:
// 19 + 46 (demanda de 01/10..15/11) = 65 no fim de 30/09 — fecha com a linha.
const cortavelLongo = (): Fatos => ({
  ...cortavel(65),
  meta: { ...fatos.meta, hoje: '2026-11-15' },
  demanda: Array.from({ length: 250 }, (_, i) => ({ sku: '9', data: dia([2026, 3, 1], i), qtde: 1 })),
  estoque: [{ sku: '9', estoque_fisico: 19 }],
});

// Base de caixa sem linhas: o piso é só a base (snapshot + compromissos + ritmo + continuidade).
const semLinhas: Fatos = { ...fatos, linhas: [] };
const pisoDe = (f: Fatos) => {
  const e = simularCiclo(f, 1, cfg).estado;
  if (e.tipo === 'inviavel') throw new Error('esperava estado com piso');
  return e.piso as number;
};

describe('extrairJson', () => {
  it('exige o marcador fim|ok', () => {
    expect(() => extrairJson('json|{}\n')).toThrow('sem marcador fim|ok');
  });
  it('reprova ERROR mesmo com marcador', () => {
    expect(() => extrairJson('psql:x: ERROR:  boom\nfim|ok\n')).toThrow('psql devolveu ERROR');
  });
  it('lê a linha json|', () => {
    expect(extrairJson('json|{"a":1}\nfim|ok\n')).toEqual({ a: 1 });
  });
});

describe('preVoo', () => {
  it('ok com fatos completos', () => {
    expect(preVoo(fatos)).toEqual([]);
  });
  it('nomeia o que falta (nunca segue com vazio)', () => {
    expect(preVoo({ ...fatos, params: [], snapshots: [], cm_anual: null })).toEqual([
      'params vazio — conferir case de empresa',
      'snapshots vazio — sem base de caixa',
      'cm_anual ausente — sem custo de capital',
    ]);
  });
  it('quantidade nula em recebimento é falha (ausente ≠ zero)', () => {
    const f = { ...fatos, recebimentos: [{ sku: '9', data: '2026-10-02', qtde: null }] };
    expect(preVoo(f)).toEqual(['recebimentos com qtde nula — reconstrução de estoque inválida']);
  });
});

describe('simularCiclo', () => {
  it('dia sem snapshot → estado indeterminado nomeando a camada (Review Focus 3)', () => {
    const r = simularCiclo({ ...fatos, snapshots: [] }, 1, cfg);
    expect(r.estado.tipo).toBe('indeterminado');
    expect(r.estado.tipo === 'indeterminado' && r.estado.camadas).toContain('snapshot');
  });
  it('snapshot gerado DEPOIS do momento do ciclo não vale (as-of)', () => {
    const r = simularCiclo({ ...fatos, snapshots: [{ ...fatos.snapshots[0], snapshot_at: '2026-10-01T13:00:00Z' }] }, 1, cfg);
    expect(r.estado.tipo === 'indeterminado' && r.estado.camadas).toContain('snapshot');
  });
  it('R8: título não-Sayerlack FORA de [início, início+horizonte) não desconta o ritmo do mês', () => {
    // horizonte 91 a partir de 01/10 = até 30/12; o título de 31/12 cai no fim da trajetória mas
    // não pode abater o ritmo de dezembro (senão a saída some em dobro do lado do ritmo).
    const piso = (saidas: { data: string; valor: number; origem: string }[]) =>
      pisoDe({ ...fatos, snapshots: [{ ...fatos.snapshots[0], dados: [{ inicio: '2026-12-28', fim: '2026-12-31', saidas, entradas: [] }] }] });
    expect(piso([{ data: '2026-12-31', valor: 100, origem: 'cp_omie' }])).toBeCloseTo(piso([]) - 100, 6);
  });
  it('R23: só título do CP (origem cp_omie) desconta o ritmo; evento recorrente/eventual não', () => {
    const piso = (saidas: { data: string; valor: number; origem: string }[]) =>
      pisoDe({ ...fatos, snapshots: [{ ...fatos.snapshots[0], dados: [{ inicio: '2026-12-14', fim: '2026-12-20', saidas, entradas: [] }] }] });
    const base = piso([]);
    // controle: título do CP em dezembro já está no ritmo medido → abate o ritmo, saldo líquido igual
    expect(piso([{ data: '2026-12-15', valor: 100, origem: 'cp_omie' }])).toBeCloseTo(base, 6);
    expect(piso([{ data: '2026-12-15', valor: 100, origem: 'evento_recorrente' }])).toBeCloseTo(base - 100, 6);
  });
  it('R20: entrada do snapshot com data anterior ao ciclo é descartada; saída anterior cai no dia 0', () => {
    const piso = (dados: Fatos['snapshots'][number]['dados']) => pisoDe({ ...fatos, snapshots: [{ ...fatos.snapshots[0], dados }] });
    const base = piso([]);
    expect(piso([{ inicio: '2026-09-28', fim: '2026-10-04', saidas: [], entradas: [{ data: '2026-09-28', valor: 100 }] }])).toBeCloseTo(base, 6);
    // semana agregada (entradas sem data) inteiramente passada: descartada também
    expect(piso([{ inicio: '2026-09-21', fim: '2026-09-27', total_entradas: 100, saidas: [], entradas: [{ valor: 100 }] }])).toBeCloseTo(base, 6);
    expect(piso([{ inicio: '2026-09-28', fim: '2026-10-04', saidas: [{ data: '2026-09-28', valor: 100, origem: 'cp_omie' }], entradas: [] }])).toBeCloseTo(base - 100, 6);
  });
  it('estoque reconstruído ancora em HOJE, não no fim da janela histórica', () => {
    // estoque de hoje 50, 1/dia de demanda: no ciclo (14 dias antes de hoje) o estoque era > 50, nunca censurado
    const r = simularCiclo(fatos, 1, cfg);
    expect(r.semScore).toEqual([]);
  });
  it('ciclo simples: devolve aceitas+cortadas cobrindo todas as embalagens do motor', () => {
    const r = simularCiclo(fatos, 1, cfg);
    expect(r.valorMotor).toBeCloseTo(4 * 10 * 1.025, 9);
    expect(r.aceitas + r.cortadas).toBe(4);
  });
  it('estoque_atual nulo → todas as embalagens sem score com motivo estoque_ausente (nunca 0)', () => {
    const r = simularCiclo({ ...fatos, linhas: [{ ...fatos.linhas[0], estoque_atual: null }] }, 1, cfg);
    expect(r.semScore).toEqual(Array.from({ length: 4 }, () => ({ sku: '9', motivo: 'estoque_ausente' })));
    expect(r.aceitas).toBe(0);
  });
  it('qtde nula na linha → sem score qtde_ausente (não some calada)', () => {
    const r = simularCiclo({ ...fatos, linhas: [{ ...fatos.linhas[0], qtde: null }] }, 1, cfg);
    expect(r.semScore).toEqual([{ sku: '9', motivo: 'qtde_ausente' }]);
  });
  it('R22: demanda do ciclo vem da própria série as-of (o futuro não vaza)', () => {
    // 3 vendas de 1 un antes do ciclo; 5/dia DEPOIS (o params atual diria 5/dia → protegeria tudo)
    const antes = ['2026-06-01', '2026-07-01', '2026-08-01'].map((data) => ({ sku: '9', data, qtde: 1 }));
    const depois = Array.from({ length: 15 }, (_, i) => ({ sku: '9', data: dia([2026, 9, 1], i), qtde: 5 }));
    const f: Fatos = {
      ...fatos,
      demanda: [...antes, ...depois],
      linhas: [{ ...fatos.linhas[0], estoque_atual: 2 }],
      params: [{ ...fatos.params[0], demanda_media_diaria: 5, demanda_sigma_diario: 2 }],
    };
    const r = simularCiclo(f, 1, cfg);
    expect(r.protegidas).toBe(0);
  });
  it('preço unitário 0 é ausente: sem desembolso, sem score', () => {
    const r = simularCiclo({ ...fatos, linhas: [{ ...fatos.linhas[0], preco_unitario: 0 }] }, 1, cfg);
    expect(r.valorMotor).toBe(0);
    expect(r.embalagensSemDesembolso).toBe(4);
    expect(r.semScore.map((s) => s.motivo)).toEqual(Array(4).fill('preco_ou_margem_ausente'));
  });
  it('pagamentos não-Sayerlack sem histórico → camada ritmo_sem_historico (nunca ritmo 0 calado)', () => {
    const r = simularCiclo({ ...fatos, pagos_nao_sayerlack: [] }, 1, cfg);
    expect(r.estado.tipo === 'indeterminado' && r.estado.camadas).toContain('ritmo_sem_historico');
  });
  it('fechamento: linha que grava o estoque reconstruído classifica o corte (controle)', () => {
    const r = simularCiclo(cortavel(65), 1, cfg);
    expect(r.cortesDetalhe.map((x) => [x.motivo, x.classe])).toEqual(Array(3).fill(['financeiro', 'eliminado']));
    expect(r.fechamento).toEqual([{ sku: '9', erro: 0, ok: true }]);
  });
  it('fechamento: estoque_fisico divergente da reconstrução → corte indeterminado', () => {
    const r = simularCiclo(cortavel(0), 1, cfg);
    expect(r.cortesDetalhe.map((x) => [x.motivo, x.classe])).toEqual(Array(3).fill(['financeiro', 'indeterminado']));
    expect(r.fechamento).toEqual([{ sku: '9', erro: 65, ok: false }]);
  });
  it('R26: ciclo não disparado não roda replay (classe nula)', () => {
    const f = cortavel(65);
    const r = simularCiclo({ ...f, ciclos: [{ ...f.ciclos[0], status: 'expirado_sem_aprovacao' }] }, 1, cfg);
    expect(r.cortesDetalhe.map((x) => [x.motivo, x.classe])).toEqual(Array(3).fill(['financeiro', null]));
  });
});

describe('R27 — integração da base de caixa (money-path)', () => {
  const momento = '2026-10-01T12:00:00Z';
  const P1 = { id: 10, valor_total: 1_000, momento: '2026-09-25T12:00:00Z', nfs: ['123'] };
  // R35: liquidado antes do snapshot (30/09 < 01/10) → desconta; sem baixa nem representação não descontaria
  const T1 = { id: 't1', nf: '000123', valor: 600, data_emissao: '2026-09-28', created_at: '2026-09-28T12:00:00Z', data_baixa: '2026-09-30' as string | null, valor_baixado: 600 as number | null };
  // pedido disparado DEPOIS do ciclo: nunca pode entrar como compromisso
  const P2 = { id: 11, valor_total: 5_000, momento: '2026-10-01T13:00:00Z', nfs: [] };
  const com = (titulo: typeof T1): Fatos => ({ ...semLinhas, disparados: [HIST, P1, P2], titulos_sayerlack: [titulo] });

  it('(a) título criado antes do snapshot concilia: só o resíduo (400) entra; (b) criado depois é ignorado', () => {
    const antes = com(T1);
    const depois = com({ ...T1, created_at: '2026-10-01T10:30:00Z' });
    expect(simularCiclo(antes, 1, cfg).estado.tipo).toBe('viavel');
    // R30: P1 tem 6 dias e NF sem título as-of → a faturar (inteiro), não indeterminado (antes: nao_conciliado)
    expect(simularCiclo(depois, 1, cfg).estado.tipo).toBe('viavel');
    const velho = { ...com({ ...T1, created_at: '2026-10-01T10:30:00Z' }), disparados: [HIST, { ...P1, momento: '2026-09-10T12:00:00Z' }, P2] };
    const eVelho = simularCiclo(velho, 1, cfg).estado;
    expect(eVelho.tipo === 'indeterminado' && eVelho.camadas).toEqual(['compromisso_nao_conciliado']);
    // a diferença de piso é exatamente o título: 1000 inteiro (depois) − 400 de resíduo (antes)
    expect(pisoDe(antes) - pisoDe(depois)).toBeCloseTo(600, 6);
  });
  it('(c) pedido sem NF com ≥ 15 dias acima de 10% da reserva → indeterminado; abaixo → viável', () => {
    // reserva = 1000/180×30 = 166,67 → limiar 16,67. R28: pedido de 10/09 tem 21 dias no ciclo de 01/10
    const semNf = (valor: number): Fatos => ({ ...semLinhas, disparados: [HIST, { id: 12, valor_total: valor, momento: '2026-09-10T12:00:00Z', nfs: [] }] });
    const acima = simularCiclo(semNf(20), 1, cfg).estado;
    expect(acima.tipo === 'indeterminado' && acima.camadas).toEqual(['compromisso_nao_conciliado']);
    expect(simularCiclo(semNf(10), 1, cfg).estado.tipo).toBe('viavel');
  });
  it('(e) R28: pedido sem NF recente (6 dias) está a faturar — não deixa o ciclo indeterminado, mas baixa o piso pelo valor inteiro', () => {
    const pedido = { id: 13, valor_total: 5_000, momento: '2026-09-25T12:00:00Z' };
    const aFaturar: Fatos = { ...semLinhas, disparados: [HIST, { ...pedido, nfs: [] }] };
    // controle: o mesmo pedido já faturado e titulado por inteiro → resíduo 0 (mesma continuidade, mesmo ritmo)
    const titulado: Fatos = {
      ...semLinhas,
      disparados: [HIST, { ...pedido, nfs: ['555'] }],
      // R35: título só desconta se representado no snapshot ou liquidado antes dele
      titulos_sayerlack: [{ id: 't5', nf: '555', valor: 5_000, data_emissao: '2026-09-27', created_at: '2026-09-27T12:00:00Z', data_baixa: '2026-09-30', valor_baixado: 5_000 }],
    };
    expect(simularCiclo(aFaturar, 1, cfg).estado.tipo).toBe('viavel');
    expect(simularCiclo(titulado, 1, cfg).estado.tipo).toBe('viavel');
    expect(pisoDe(titulado) - pisoDe(aFaturar)).toBeCloseTo(5_000, 6);
  });
  it('(d) reservaDe: 180 dias por data de emissão, título só se criado até o momento do ciclo', () => {
    const f: Fatos = {
      ...fatos,
      pagos_nao_sayerlack: [
        { data: '2026-09-21', valor: 500 },
        { data: '2026-04-04', valor: 50 }, // exatamente D−180: entra
        { data: '2026-04-03', valor: 999 }, // D−181: fora
        { data: '2026-10-01', valor: 777 }, // o próprio dia: fora
      ],
      titulos_sayerlack: [
        { id: 'a', nf: '1', valor: 300, data_emissao: '2026-09-26', created_at: '2026-09-26T12:00:00Z' },
        { id: 'b', nf: '2', valor: 444, data_emissao: '2026-09-28', created_at: '2026-10-01T13:00:00Z' }, // criado depois do momento
        { id: 'c', nf: '3', valor: 555, data_emissao: '2026-03-01', created_at: '2026-03-01T12:00:00Z' }, // fora da janela
      ],
    };
    expect(reservaDe(f, '2026-10-01', momento, 30)).toBeCloseTo(((500 + 50 + 300) / 180) * 30, 9);
  });
});

describe('backtest', () => {
  it('R25: ΔDIO e caixa liberado por episódio, replay de 30 dias a partir do ciclo', () => {
    const b = backtest(cortavelLongo(), cfg);
    // episódio = as 3 embalagens de 1 un do ciclo, removidas juntas no dia 5 de 30: 3 × 25/30 un × R$10
    expect(b.resumo.caixaLiberado).toBeCloseTo(3 * (25 / 30) * 10, 9);
    expect(b.resumo.cmvDiarioBase).toBeCloseTo(10, 9);
    expect(b.resumo.deltaDio).toBeCloseTo(2.5, 9);
    expect(b.resumo.episodiosSemHorizonte).toBe(0);
    expect(b.resumo.skusAvaliados).toBe(1);
    expect(b.resumo.skusFechamentoRuim).toBe(0);
  });
  it('R25: episódio sem 30 dias até hoje fica fora do ΔDIO', () => {
    const b = backtest(cortavel(65), cfg);
    expect(b.resumo.episodiosSemHorizonte).toBe(1);
    expect(b.resumo.caixaLiberado).toBeNull();
    expect(b.resumo.deltaDio).toBeNull();
  });
  it('ΔDIO nulo quando o CMV diário está ausente (nunca 0 fabricado)', () => {
    const f = cortavelLongo();
    const b = backtest({ ...f, params: [{ ...f.params[0], demanda_media_diaria: null }] }, cfg);
    expect(b.resumo.caixaLiberado).not.toBeNull();
    expect(b.resumo.cmvDiarioBase).toBeNull();
    expect(b.resumo.deltaDio).toBeNull();
  });
  it('corte sem preço não entra no valor cortado; é contado em cortesSemPreco', () => {
    const f = cortavel(65);
    const b = backtest({ ...f, linhas: [{ ...f.linhas[0], preco_unitario: null }] }, cfg);
    expect(b.resumo.valorCortadoEfetivo).toBe(0);
    expect(b.resumo.cortesSemPreco).toBe(4);
    // corte sem preço não vira episódio de R$ 0 (Number(null) somado = 0 fabricado)
    expect(b.resumo.episodios).toBe(0);
  });
  it('premissas declaradas no resultado', () => {
    const b = backtest(fatos, cfg);
    expect(b.premissas.length).toBeGreaterThanOrEqual(8);
    expect(b.premissas.join(' ')).toContain('obsolescência');
  });
  it('valor cortado separa efetivo × expirado, somando o SKU no ciclo e deduplicando por episódio', () => {
    const f = cortavel(65);
    const dois: Fatos = {
      ...f,
      ciclos: [f.ciclos[0], { ...f.ciclos[0], id: 2, status: 'expirado_sem_aprovacao', data_ciclo: '2026-10-03', horario_geracao: '2026-10-03T12:00:00Z' }],
      linhas: [f.linhas[0], { ...f.linhas[0], raiz: 2, pedido_id: 2 }],
      snapshots: [...f.snapshots, { ...f.snapshots[0], dia: '2026-10-03', snapshot_at: '2026-10-03T10:00:00Z' }],
    };
    const b = backtest(dois, cfg);
    expect(b.resumo.valorCortadoEfetivo).toBeCloseTo(3 * 10 * 1.025, 9);
    expect(b.resumo.valorCortadoExpirado).toBeCloseTo(3 * 10 * 1.025, 9);
    // ciclo 2: a linha grava 65 e a reconstrução no fim de 02/10 dá 63 — erro 2 ≤ 10% de 65, fecha
    expect(b.resumo.skusAvaliados).toBe(1);
    expect(b.resumo.skusFechamentoRuim).toBe(0);
  });
});

describe('R31 — precisão por episódio (portão da v2)', () => {
  const corte = (sku: string, classe: DetalheCorte['classe'], valor: number | null, motivo = 'economico'): DetalheCorte => ({
    sku, k: 1, qtde: 1, valor, motivo, classe, estoqueMedioCom: null, estoqueMedioSem: null, precoUnit: 10, fechamentoOk: true,
  });
  const ciclo = (cicloId: number, data: string, cortesDetalhe: DetalheCorte[]): ResultadoCiclo => ({
    cicloId, data, status: 'disparado', valorMotor: 0, valorAceito: 0, aceitas: 0, cortadas: cortesDetalhe.length,
    embalagensSemDesembolso: 0, protegidas: 0, cortesPorMotivo: {}, estado: { tipo: 'viavel', piso: 0, dataPiso: data },
    scoreMarginal: null, escassezCaixa: false, semScore: [], sensiveisAoModelo: 0, fechamento: [], cortesDetalhe,
  });
  const efetivos = [
    ciclo(1, '2026-09-01', [corte('A', 'adiado', 100), corte('B', 'indeterminado', 40), corte('E', 'eliminado', null)]),
    ciclo(2, '2026-09-03', [corte('A', 'teria_rompido', 50), corte('B', 'eliminado', 40)]),
    ciclo(3, '2026-09-20', [corte('A', 'adiado', 30), corte('C', 'eliminado', 70), corte('D', null, 20, 'sem_score')]),
  ];
  it('episódio = dedup 7d; teria_rompido se QUALQUER corte romperia; senão o pior caso (R37)', () => {
    const p = precisaoPorEpisodio(efetivos);
    // episódios: A(01–03/09, valor 100, teria_rompido) · A(20/09, 30, adiado) · B(01–03/09, indeterminado)
    //            C(70, eliminado). R48: D (só sem_score) é revisão humana, não episódio; E (sem preço) também não.
    expect(p.n).toBe(3);
    expect(p.indeterminados).toBe(1);
    expect(p.cobertura).toBeCloseTo(3 / 4, 12);
    expect(p.precisao).toBeCloseTo((30 + 70) / (100 + 30 + 70), 12);
  });
  it('sem episódio classificado → precisão e cobertura ausentes (nunca 0 nem 100%)', () => {
    const p = precisaoPorEpisodio([ciclo(1, '2026-09-01', [corte('B', 'indeterminado', 40)])]);
    expect(p).toMatchObject({ precisao: null, n: 0, indeterminados: 1, cobertura: 0 });
    expect(precisaoPorEpisodio([]).cobertura).toBeNull();
  });
  it('backtest expõe precisaoEpisodios e coberturaEpisodios no resumo', () => {
    const b = backtest(cortavelLongo(), cfg);
    expect(b.resumo.precisaoEpisodios.n + b.resumo.precisaoEpisodios.indeterminados).toBe(b.resumo.episodios);
    expect(b.resumo.coberturaEpisodios).not.toBeUndefined();
  });
});

describe('R31 — idade do pedido em data local de São Paulo', () => {
  it('dataLocalSP converte o instante UTC para o dia em America/Sao_Paulo', () => {
    expect(dataLocalSP('2026-09-17T01:00:00+00:00')).toBe('2026-09-16');
    expect(dataLocalSP('2026-09-17T03:00:00Z')).toBe('2026-09-17');
  });
  it('pedido das 22h locais de 16/09 tem 15 dias no ciclo de 01/10 → não conciliado (o recorte UTC daria 14 → a faturar)', () => {
    const semLinhasLocal: Fatos = { ...fatos, linhas: [], disparados: [HIST, { id: 21, valor_total: 20, momento: '2026-09-17T01:00:00Z', nfs: [] }] };
    const e = simularCiclo(semLinhasLocal, 1, cfg).estado;
    expect(e.tipo === 'indeterminado' && e.camadas).toEqual(['compromisso_nao_conciliado']);
  });
});

describe('onda final — base de caixa as-of (R34, R35, R38, R39, R41, R42, R45, R50, R52)', () => {
  type Dados = Fatos['snapshots'][number]['dados'];
  const snapCom = (dados: Dados, extra: Partial<Fatos> = {}): Fatos => ({ ...semLinhas, snapshots: [{ ...fatos.snapshots[0], dados }], ...extra });

  it('R34: título Sayerlack (por id do fornecedor) não abate o ritmo não-Sayerlack (Codex P1-3)', () => {
    const saida = { data: '2026-12-15', valor: 100, origem: 'cp_omie', id_origem: 'say-1' };
    const semana = (s: typeof saida) => [{ inicio: '2026-12-14', fim: '2026-12-20', saidas: [s], entradas: [] }];
    const base = pisoDe(semLinhas);
    // controle: título não-Sayerlack do CP abate o ritmo (R23) — saldo líquido igual
    expect(pisoDe(snapCom(semana({ ...saida, id_origem: 'outro' }), { ids_sayerlack: ['say-1'] }))).toBeCloseTo(base, 6);
    // Sayerlack: duas despesas — a saída do título e o ritmo inteiro
    expect(pisoDe(snapCom(semana(saida), { ids_sayerlack: ['say-1'] }))).toBeCloseTo(base - 100, 6);
  });

  it('R35: título existente fora da trajetória e não liquidado até o snapshot NÃO apaga o compromisso (Codex P1-4)', () => {
    const P = { id: 30, valor_total: 1_000, momento: '2026-09-25T12:00:00Z', nfs: ['777'] };
    const T = { id: 't7', nf: '777', valor: 1_000, data_emissao: '2026-09-25', created_at: '2026-09-25T12:00:00Z', data_baixa: null as string | null, valor_baixado: null as number | null };
    const comP: Fatos = { ...semLinhas, disparados: [HIST, P] };
    const semTitulo = pisoDe(comP);
    expect(pisoDe({ ...comP, titulos_sayerlack: [T] })).toBeCloseTo(semTitulo, 6);
    // liquidado DEPOIS do snapshot: ainda não representado → não desconta
    expect(pisoDe({ ...comP, titulos_sayerlack: [{ ...T, data_baixa: '2026-10-05', valor_baixado: 1_000 }] })).toBeCloseTo(semTitulo, 6);
    // liquidado ANTES do snapshot: já saiu do saldo → desconta (sobra o resíduo de frete)
    expect(pisoDe({ ...comP, titulos_sayerlack: [{ ...T, data_baixa: '2026-09-30', valor_baixado: 1_000 }] })).toBeCloseTo(semTitulo + 1_000, 6);
    // representado no snapshot (id_origem): a saída está na base e o compromisso fica só com o resíduo → total conservado
    const representado = snapCom(
      [{ inicio: '2026-10-05', fim: '2026-10-11', saidas: [{ data: '2026-10-06', valor: 1_000, origem: 'cp_omie', id_origem: 't7' }], entradas: [] }],
      { disparados: [HIST, P], titulos_sayerlack: [T], ids_sayerlack: ['t7'] },
    );
    expect(pisoDe(representado)).toBeCloseTo(semTitulo, 6);
  });

  it('R38: pedido sem NF com 61+ dias continua compromisso inteiro — não some aos 61 dias (Codex P1-7)', () => {
    const estado = (momento: string) => simularCiclo({ ...semLinhas, disparados: [HIST, { id: 31, valor_total: 100_000, momento, nfs: [] }] }, 1, cfg).estado;
    const e = estado('2026-07-31T12:00:00Z');
    expect(e.tipo === 'indeterminado' && e.camadas).toEqual(['compromisso_nao_conciliado']);
    // controle: fora da janela de 180 dias não entra
    expect(estado('2026-03-31T12:00:00Z').tipo).toBe('viavel');
  });

  it('R39: lags as-of — só observações concluídas antes do ciclo; futuras não mudam a decisão (Codex P1-8)', () => {
    const antes = lagObs(3, 1, 14);
    const depois = lagObs(0, 0, 0, 10, [2026, 9, 2]);
    const f: Fatos = { ...fatos, lag_obs: { faturamento: [...antes.faturamento, ...depois.faturamento], vencimento: [...antes.vencimento, ...depois.vencimento], chegada: [...antes.chegada, ...depois.chegada] } };
    expect(lagsAsOf(f, '2026-10-01')).toEqual({ faturamentoP10: 3, vencimentoP10: 1, chegadaP50: 14 });
    // concluída no próprio dia do ciclo ainda não é conhecida; t1 antes de data−180 está fora da janela
    const borda: Fatos = { ...fatos, lag_obs: { ...antes, faturamento: [...antes.faturamento.slice(1), { t1: '2026-09-29', fim: '2026-10-01', dias: 2 }] } };
    expect(lagsAsOf(borda, '2026-10-01').faturamentoP10).toBeNull();
    const velho: Fatos = { ...fatos, lag_obs: { ...antes, faturamento: [...antes.faturamento.slice(1), { t1: '2026-04-03', fim: '2026-04-05', dias: 2 }] } };
    expect(lagsAsOf(velho, '2026-10-01').faturamentoP10).toBeNull();
  });
  it('R39: < 10 observações → ausência lags_insuficientes (caixa) e embalagens sem score (chegada)', () => {
    const nove = lagObs(2, 1, 14, 9);
    const e = simularCiclo({ ...fatos, lag_obs: { ...fatos.lag_obs, faturamento: nove.faturamento } }, 1, cfg).estado;
    expect(e.tipo === 'indeterminado' && e.camadas).toContain('lags_insuficientes');
    const r = simularCiclo({ ...fatos, lag_obs: { ...fatos.lag_obs, chegada: nove.chegada } }, 1, cfg);
    expect(r.semScore.map((x) => x.motivo)).toEqual(Array(4).fill('lags_insuficientes'));
    expect(r.aceitas).toBe(0);
  });

  it('R41: compromisso = valor_total × (1 + frete) antes de descontar títulos (Codex P1-10)', () => {
    const pedido = { id: 32, valor_total: 100_000, momento: '2026-09-25T12:00:00Z' };
    const aFaturar = pisoDe({ ...semLinhas, disparados: [HIST, { ...pedido, nfs: [] }] });
    // mesmo pedido com NF titulada e paga por 102.500 (valor + frete) → resíduo 0
    const quitado = pisoDe({
      ...semLinhas, disparados: [HIST, { ...pedido, nfs: ['900'] }],
      titulos_sayerlack: [{ id: 't9', nf: '900', valor: 102_500, data_emissao: '2026-09-26', created_at: '2026-09-26T12:00:00Z', data_baixa: '2026-09-29', valor_baixado: 102_500 }],
    });
    expect(quitado - aFaturar).toBeCloseTo(102_500, 6);
  });

  it('R42: semana com total_saidas sem detalhe → saídas agregadas no 1º dia, nunca 0 (Codex P2-11)', () => {
    const base = pisoDe(semLinhas);
    expect(pisoDe(snapCom([{ inicio: '2026-10-05', fim: '2026-10-11', total_saidas: 1_000, entradas: [] }]))).toBeCloseTo(base - 1_000, 6);
    // detalhe parcial: o que falta para o total também entra no 1º dia
    const parcial = [{ inicio: '2026-10-05', fim: '2026-10-11', total_saidas: 1_000, saidas: [{ data: '2026-10-07', valor: 400, origem: 'evento' }], entradas: [] }];
    expect(pisoDe(snapCom(parcial))).toBeCloseTo(base - 1_000, 6);
  });

  it('R45: pai split_em_filhos com filho disparado conta como disparado — mesmo resultado do pedido inteiro (Codex P2-14)', () => {
    const inteiro = cortavel(65);
    const split: Fatos = {
      ...inteiro,
      ciclos: [{ ...inteiro.ciclos[0], status: 'split_em_filhos', filhos: [{ id: 2, status: 'disparado' }] }],
      linhas: [{ ...inteiro.linhas[0], pedido_id: 2 }],
    };
    const a = backtest(inteiro, cfg).resumo;
    const b = backtest(split, cfg).resumo;
    expect(b.nDisparados).toBe(1);
    expect(b.valorCortadoExpirado).toBe(0);
    expect(b.valorCortadoEfetivo).toBeCloseTo(a.valorCortadoEfetivo, 9);
    expect(b.episodios).toBe(a.episodios);
    // controle: filho não disparado → o pai continua não efetivo
    const naoDisp = backtest({ ...split, ciclos: [{ ...split.ciclos[0], filhos: [{ id: 2, status: 'expirado_sem_aprovacao' }] }] }, cfg).resumo;
    expect(naoDisp.nDisparados).toBe(0);
  });

  it('R50: continuidade com janela incompleta = média por dia útil desde o 1º disparado; sem disparado anterior → null', () => {
    const P = { id: 40, valor_total: 1_000, momento: '2026-09-21T12:00:00Z', nfs: [] as string[] };
    // 21/09 (seg) a 30/09 (qua) = 8 dias úteis
    expect(continuidadePorDiaUtil({ ...fatos, disparados: [P] }, '2026-10-01')).toBeCloseTo(1_000 / 8, 9);
    expect(continuidadePorDiaUtil({ ...fatos, disparados: [] }, '2026-10-01')).toBeNull();
    // controle: motor já existia antes da janela → 90 dias corridos (03/07 a 30/09 = 64 dias úteis)
    expect(continuidadePorDiaUtil({ ...fatos, disparados: [HIST, P] }, '2026-10-01')).toBeCloseTo(1_000 / 64, 9);
    const e = simularCiclo({ ...semLinhas, disparados: [] }, 1, cfg).estado;
    expect(e.tipo === 'indeterminado' && e.camadas).toContain('continuidade_sem_historico');
  });

  it('R52: momento as-of = horario_geracao (decisão do motor), não o disparo real', () => {
    const f: Fatos = { ...fatos, ciclos: [{ ...fatos.ciclos[0], horario_geracao: '2026-10-01T09:00:00Z', horario_disparo_real: '2026-10-01T12:00:00Z' }] };
    const e = simularCiclo(f, 1, cfg).estado;
    expect(e.tipo === 'indeterminado' && e.camadas).toContain('snapshot');
  });
});

describe('onda final — medição (R32, R33, R37, R46, R48, R51)', () => {
  // Codex P1-1: estoque 10 no fim de 30/09, recebimento de 3 em 03/10 (dia 2), demanda 2/dia de 01 a 06/10, PP 0, L 2.
  // Linha de 4 un: k=1 protegida, k=2..4 cortadas (caixa zerado). Tirar 1 un por vez → adiado; tirar as 3 juntas → 2 un perdidas.
  const conjunto = (): Fatos => ({
    ...fatos,
    meta: { ...fatos.meta, hoje: '2026-10-08' },
    linhas: [{ ...fatos.linhas[0], estoque_fisico: 10, ponto_pedido: 0 }],
    demanda: [
      ...Array.from({ length: 183 }, (_, i) => ({ sku: '9', data: dia([2026, 3, 1], i), qtde: 1 })),
      ...Array.from({ length: 6 }, (_, i) => ({ sku: '9', data: dia([2026, 9, 1], i), qtde: 2 })),
    ],
    recebimentos: [{ sku: '9', data: '2026-10-03', qtde: 3 }],
    estoque: [{ sku: '9', estoque_fisico: 1 }],
    snapshots: [{ ...fatos.snapshots[0], saldo_tesouraria: 0 }],
    lag_obs: lagObs(2, 1, 2),
    chegadas: [{ pedido_id: 1, t4: '2026-10-03' }],
  });
  it('R32: replay por (ciclo, SKU) remove TODAS as embalagens cortadas juntas (Codex P1-1)', () => {
    const r = simularCiclo(conjunto(), 1, cfg);
    expect(r.cortesDetalhe.map((x) => [x.k, x.motivo])).toEqual([[2, 'financeiro'], [3, 'financeiro'], [4, 'financeiro']]);
    expect(r.cortesDetalhe.map((x) => x.classe)).toEqual(Array(3).fill('teria_rompido'));
  });

  // Codex P1-2: estoque 2 no fim de 30/09, compra de 5 recebida em 02/10 (dia 1), demanda 1/dia de 02 a 05/10, L = 5.
  const chegadaReal = (t4: string | null): Fatos => ({
    ...fatos,
    meta: { ...fatos.meta, hoje: '2026-10-08' },
    linhas: [{ ...fatos.linhas[0], qtde: 5, estoque_atual: 100, estoque_fisico: 2, ponto_pedido: 0 }],
    demanda: [
      ...Array.from({ length: 183 }, (_, i) => ({ sku: '9', data: dia([2026, 3, 1], i), qtde: 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ sku: '9', data: dia([2026, 9, 2], i), qtde: 1 })),
    ],
    recebimentos: [{ sku: '9', data: '2026-10-02', qtde: 5 }],
    estoque: [{ sku: '9', estoque_fisico: 3 }],
    snapshots: [{ ...fatos.snapshots[0], saldo_tesouraria: 0 }],
    lag_obs: lagObs(2, 1, 5),
    chegadas: [{ pedido_id: 1, t4 }],
  });
  it('R33: remoção no recebimento REAL (t4) do pedido, não na chegada mediana (Codex P1-2)', () => {
    const r = simularCiclo(chegadaReal('2026-10-02'), 1, cfg);
    expect(r.cortesDetalhe).toHaveLength(5);
    expect(r.cortesDetalhe.map((x) => [x.classe, x.chegadaAproximada])).toEqual(Array(5).fill(['teria_rompido', false]));
  });
  it('R33: sem t4 → chegada mediana L e marca aproximada', () => {
    const r = simularCiclo(chegadaReal(null), 1, cfg);
    expect(r.cortesDetalhe.every((x) => x.chegadaAproximada === true)).toBe(true);
    expect(r.cortesDetalhe.every((x) => x.classe === 'adiado')).toBe(true);
  });
  it('R33: t4 depois de hoje → indeterminado (a remoção ainda não aconteceu)', () => {
    const r = simularCiclo(chegadaReal('2026-10-09'), 1, cfg);
    expect(r.cortesDetalhe.every((x) => x.classe === 'indeterminado')).toBe(true);
  });

  const corte = (sku: string, classe: DetalheCorte['classe'], valor: number | null, motivo = 'economico'): DetalheCorte => ({
    sku, k: 1, qtde: 1, valor, motivo, classe, estoqueMedioCom: null, estoqueMedioSem: null, precoUnit: 10, fechamentoOk: true, chegadaAproximada: false,
  });
  const ciclo = (cicloId: number, data: string, cortesDetalhe: DetalheCorte[]): ResultadoCiclo => ({
    cicloId, data, status: 'disparado', valorMotor: 0, valorAceito: 0, aceitas: 0, cortadas: cortesDetalhe.length,
    embalagensSemDesembolso: 0, protegidas: 0, cortesPorMotivo: {}, estado: { tipo: 'viavel', piso: 0, dataPiso: data },
    scoreMarginal: null, escassezCaixa: false, semScore: [], sensiveisAoModelo: 0, fechamento: [], cortesDetalhe,
  });
  it('R37: episódio com qualquer corte indeterminado é indeterminado — o 1º corte conhecido não cobre o resto (Codex P1-6)', () => {
    const p = precisaoPorEpisodio([
      ciclo(1, '2026-09-01', [corte('A', 'eliminado', 10)]),
      ciclo(2, '2026-09-03', [corte('A', 'indeterminado', 1_000)]),
    ]);
    expect(p).toMatchObject({ precisao: null, n: 0, indeterminados: 1, cobertura: 0 });
  });
  it('R37: teria_rompido ainda vence indeterminado (controle)', () => {
    const p = precisaoPorEpisodio([
      ciclo(1, '2026-09-01', [corte('A', 'indeterminado', 10)]),
      ciclo(2, '2026-09-03', [corte('A', 'teria_rompido', 1_000)]),
    ]);
    expect(p).toMatchObject({ precisao: 0, n: 1, indeterminados: 0 });
  });

  it('R48: sem_score com preço é revisão humana — fora do valor cortado e dos episódios', () => {
    const f = cortavel(65);
    const b = backtest({ ...f, params: [{ ...f.params[0], preco_venda_medio: null }] }, cfg).resumo;
    expect(b.valorCortadoEfetivo).toBe(0);
    expect(b.episodios).toBe(0);
    // k=1 protegida (aceita); k=2..4 sem score
    expect(b.revisaoHumana.embalagens).toBe(3);
    expect(b.revisaoHumana.valor).toBeCloseTo(3 * 10 * 1.025, 9);
  });

  it('R51: "orçamento aceitaria" só soma ciclos com guarda de caixa; indeterminado vai em KPI próprio', () => {
    const dois: Fatos = {
      ...fatos,
      ciclos: [fatos.ciclos[0], { ...fatos.ciclos[0], id: 2, data_ciclo: '2026-10-03', horario_geracao: '2026-10-03T12:00:00Z' }],
      linhas: [fatos.linhas[0], { ...fatos.linhas[0], raiz: 2, pedido_id: 2 }],
    };
    const b = backtest(dois, cfg);
    const [c1, c2] = b.ciclos;
    expect(c1.estado.tipo).toBe('viavel');
    expect(c2.estado.tipo).toBe('indeterminado'); // sem snapshot de 02–03/10
    expect(c2.valorAceito).toBeGreaterThan(0);
    expect(b.resumo.valorAceitoDisparados).toBeCloseTo(c1.valorAceito, 9);
    expect(b.resumo.valorAceitoSemGuarda).toBeCloseTo(c2.valorAceito, 9);
    expect(b.sensibilidade.find((x) => x.reservaDias === 30)).toMatchObject({ valorAceito: c1.valorAceito, valorAceitoSemGuarda: c2.valorAceito, indeterminados: 1 });
  });

  it('R46: ΔDIO só com CMV comparável — cobertura < 80% dos SKUs do universo → null (Codex P2-15)', () => {
    const f = cortavelLongo();
    // SKU 8 no universo (linha de outra raiz) sem demanda nos params → CMV cobre 1 de 2 SKUs
    const b = backtest({ ...f, linhas: [...f.linhas, { ...f.linhas[0], raiz: 77, pedido_id: 77, sku_codigo_omie: '8' }] }, cfg).resumo;
    expect(b.cmvCobertura).toBeCloseTo(0.5, 12);
    expect(b.deltaDio).toBeNull();
    expect(b.caixaLiberado).not.toBeNull();
  });
  it('R46: numerador do ΔDIO só com episódios de SKUs do subconjunto do CMV', () => {
    const f = cortavelLongo();
    const extras = ['5', '6', '7', '8'];
    const g: Fatos = {
      ...f,
      linhas: [...f.linhas, ...extras.map((sku) => ({ ...f.linhas[0], raiz: 77, pedido_id: 77, sku_codigo_omie: sku }))],
      params: [{ ...f.params[0], demanda_media_diaria: null }, ...extras.map((sku) => ({ ...f.params[0], sku }))],
    };
    const b = backtest(g, cfg).resumo;
    expect(b.cmvCobertura).toBeCloseTo(0.8, 12);
    expect(b.cmvDiarioBase).toBeCloseTo(40, 9);
    // o episódio é do SKU 9, fora do subconjunto → ΔDIO sem numerador comparável
    expect(b.deltaDio).toBeNull();
    expect(b.caixaLiberado).not.toBeNull();
  });
});

