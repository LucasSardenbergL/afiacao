// scripts/orcamento-compra/simular.test.ts
import { describe, expect, it } from 'vitest';
import { backtest, extrairJson, preVoo, reservaDe, simularCiclo, type Config, type Fatos } from './simular';

const cfg: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

const dia = (base: [number, number, number], i: number) => new Date(Date.UTC(base[0], base[1], base[2] + i)).toISOString().slice(0, 10);

const fatos: Fatos = {
  meta: { gerado_em: '2026-10-15T12:00:00Z', hoje: '2026-10-15' },
  ciclos: [{ id: 1, status: 'disparado', data_ciclo: '2026-10-01', horario_geracao: '2026-10-01T12:00:00Z', horario_disparo_real: null, valor_total: 40, omie_pedido_compra_id: null }],
  linhas: [{ raiz: 1, pedido_id: 1, sku_codigo_omie: '9', qtde: 4, fator_embalagem_portal: null, preco_unitario: 10, estoque_atual: 0, estoque_fisico: 0, ponto_pedido: 2, modo_promocao: null, preco_sem_desconto: null }],
  demanda: Array.from({ length: 200 }, (_, i) => ({ sku: '9', data: dia([2026, 3, 1], i), qtde: 1 })),
  recebimentos: [],
  estoque: [{ sku: '9', estoque_fisico: 50 }],
  params: [{ sku: '9', preco_venda_medio: 15, demanda_media_diaria: 1, demanda_sigma_diario: 0.5 }],
  snapshots: [{ dia: '2026-10-01', snapshot_at: '2026-10-01T10:00:00Z', saldo_tesouraria: 646_000, dados: [] }],
  disparados: [],
  titulos_sayerlack: [],
  pagos_nao_sayerlack: [{ data: '2026-09-05', valor: 1_000 }],
  lags: { faturamento_p10: 2, vencimento_p10: 1, chegada_p50: 14 },
  cm_anual: 0.15,
};

// Ciclo com corte classificável: chegada em 5 dias (14 dias de replay ≥ L+1), caixa zerado (protegida
// fura a reserva → as 3 discricionárias saem 'financeiro'). O estoque reconstruído no fim de 30/09 é
// 50 + 15 (demanda de 01/10..15/10) = 65 — a linha que grava 65 fecha; a que grava 0 não fecha.
const cortavel = (estoqueFisicoDaLinha: number): Fatos => ({
  ...fatos,
  linhas: [{ ...fatos.linhas[0], estoque_fisico: estoqueFisicoDaLinha }],
  snapshots: [{ ...fatos.snapshots[0], saldo_tesouraria: 0 }],
  lags: { ...fatos.lags, chegada_p50: 5 },
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
  const T1 = { id: 't1', nf: '000123', valor: 600, data_emissao: '2026-09-28', created_at: '2026-09-28T12:00:00Z' };
  // pedido disparado DEPOIS do ciclo: nunca pode entrar como compromisso
  const P2 = { id: 11, valor_total: 5_000, momento: '2026-10-01T13:00:00Z', nfs: [] };
  const com = (titulo: typeof T1): Fatos => ({ ...semLinhas, disparados: [P1, P2], titulos_sayerlack: [titulo] });

  it('(a) título criado antes do snapshot concilia: só o resíduo (400) entra; (b) criado depois é ignorado', () => {
    const antes = com(T1);
    const depois = com({ ...T1, created_at: '2026-10-01T10:30:00Z' });
    expect(simularCiclo(antes, 1, cfg).estado.tipo).toBe('viavel');
    const eDepois = simularCiclo(depois, 1, cfg).estado;
    expect(eDepois.tipo === 'indeterminado' && eDepois.camadas).toEqual(['compromisso_nao_conciliado']);
    // a diferença de piso é exatamente o título: 1000 inteiro (depois) − 400 de resíduo (antes)
    expect(pisoDe(antes) - pisoDe(depois)).toBeCloseTo(600, 6);
  });
  it('(c) pedido sem NF acima de 10% da reserva → indeterminado; abaixo → viável', () => {
    // reserva = 1000/180×30 = 166,67 → limiar 16,67
    const semNf = (valor: number): Fatos => ({ ...semLinhas, disparados: [{ id: 12, valor_total: valor, momento: '2026-09-25T12:00:00Z', nfs: [] }] });
    const acima = simularCiclo(semNf(20), 1, cfg).estado;
    expect(acima.tipo === 'indeterminado' && acima.camadas).toEqual(['compromisso_nao_conciliado']);
    expect(simularCiclo(semNf(10), 1, cfg).estado.tipo).toBe('viavel');
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
