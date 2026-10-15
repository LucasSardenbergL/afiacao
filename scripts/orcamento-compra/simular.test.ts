// scripts/orcamento-compra/simular.test.ts
import { describe, expect, it } from 'vitest';
import { backtest, extrairJson, preVoo, simularCiclo, type Config, type Fatos } from './simular';

const cfg: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

const fatos: Fatos = {
  meta: { gerado_em: '2026-10-15T12:00:00Z', hoje: '2026-10-15' },
  ciclos: [{ id: 1, status: 'disparado', data_ciclo: '2026-10-01', horario_geracao: '2026-10-01T12:00:00Z', horario_disparo_real: null, valor_total: 40, omie_pedido_compra_id: null }],
  linhas: [{ raiz: 1, pedido_id: 1, sku_codigo_omie: '9', qtde: 4, fator_embalagem_portal: null, preco_unitario: 10, estoque_atual: 0, estoque_fisico: 0, ponto_pedido: 2, modo_promocao: null, preco_sem_desconto: null }],
  demanda: Array.from({ length: 200 }, (_, i) => ({ sku: '9', data: new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10), qtde: 1 })),
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
    const piso = (saidas: { data: string; valor: number }[]) => {
      const snap = { ...fatos.snapshots[0], dados: [{ inicio: '2026-12-28', fim: '2026-12-31', saidas, entradas: [] }] };
      const r = simularCiclo({ ...fatos, snapshots: [snap] }, 1, cfg);
      if (r.estado.tipo !== 'viavel') throw new Error('esperava viável');
      return r.estado.piso;
    };
    expect(piso([{ data: '2026-12-31', valor: 100 }])).toBeCloseTo(piso([]) - 100, 6);
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
  it('demanda_media_diaria nula → histórico insuficiente (sem amostras, sem proteção)', () => {
    const f = { ...fatos, params: [{ ...fatos.params[0], demanda_media_diaria: null }] };
    const r = simularCiclo(f, 1, cfg);
    expect(r.semScore.map((s) => s.motivo)).toEqual(Array(4).fill('historico_insuficiente'));
  });
  it('preço unitário 0 é ausente: sem desembolso, sem score', () => {
    const r = simularCiclo({ ...fatos, linhas: [{ ...fatos.linhas[0], preco_unitario: 0 }] }, 1, cfg);
    expect(r.valorMotor).toBe(0);
    expect(r.embalagensSemDesembolso).toBe(4);
    expect(r.semScore.map((s) => s.motivo)).toEqual(Array(4).fill('preco_ou_margem_ausente'));
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
});

describe('backtest', () => {
  it('ΔDIO e caixa liberado dos cortes efetivos classificados', () => {
    const b = backtest(cortavel(65), cfg);
    // 3 embalagens de 1 un removidas no dia 5 de 15: (10/15) un × R$10 cada
    expect(b.resumo.caixaLiberado).toBeCloseTo(3 * (10 / 15) * 10, 9);
    expect(b.resumo.cmvDiarioBase).toBeCloseTo(10, 9);
    expect(b.resumo.deltaDio).toBeCloseTo(2, 9);
    expect(b.resumo.skusAvaliados).toBe(1);
    expect(b.resumo.skusFechamentoRuim).toBe(0);
  });
  it('ΔDIO nulo quando o CMV diário está ausente (nunca 0 fabricado)', () => {
    const f = cortavel(65);
    const b = backtest({ ...f, params: [{ ...f.params[0], demanda_media_diaria: null }] }, cfg);
    expect(b.resumo.cmvDiarioBase).toBeNull();
    expect(b.resumo.deltaDio).toBeNull();
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
