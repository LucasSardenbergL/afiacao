import { describe, it, expect } from 'vitest';
import {
  STATUS_SEM_NOTA,
  janelaSemNotaAntiga,
  resumirSemNota,
  faixaSemNota,
  resumirPorFaixa,
  clientesSemNotaRecentes,
  type PedidoSemNotaDetalhe,
} from '../pedidos-sem-nota';
import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

describe('STATUS_SEM_NOTA', () => {
  it('são os status do Omie anteriores à nota — nem faturado, nem cancelado, nem status do app', () => {
    expect([...STATUS_SEM_NOTA].sort()).toEqual(['enviado', 'importado', 'separacao']);
  });

  it('todos estão DENTRO do universo de venda (é por isso que contam como venda)', () => {
    for (const s of STATUS_SEM_NOTA) expect(STATUS_NAO_VENDA).not.toContain(s);
  });
});

describe('janelaSemNotaAntiga', () => {
  it('último ano, excluindo os 30 dias mais recentes (pedido recente sem nota é fila normal)', () => {
    expect(janelaSemNotaAntiga('2026-10-12')).toEqual({ de: '2025-10-12', ate: '2026-09-12' });
  });

  it('atravessa fevereiro e a virada do ano sem erro de calendário', () => {
    expect(janelaSemNotaAntiga('2026-03-01')).toEqual({ de: '2025-03-01', ate: '2026-01-30' });
  });
});

describe('resumirSemNota', () => {
  it('soma receita e conta pedidos, total e por empresa (maior primeiro)', () => {
    const r = resumirSemNota([
      { account: 'colacor', total: 100 },
      { account: 'oben', total: 300 },
      { account: 'oben', total: 200 },
    ]);
    expect(r.receita).toBe(600);
    expect(r.pedidos).toBe(3);
    expect(r.porEmpresa).toEqual([
      { account: 'oben', receita: 500, pedidos: 2 },
      { account: 'colacor', receita: 100, pedidos: 1 },
    ]);
  });

  it('pedido sem valor conta como pedido e soma R$ 0 (não some da contagem)', () => {
    const r = resumirSemNota([{ account: 'oben', total: null }]);
    expect(r).toEqual({ receita: 0, pedidos: 1, porEmpresa: [{ account: 'oben', receita: 0, pedidos: 1 }] });
  });

  it('lista vazia = zero MEDIDO (não ausência)', () => {
    expect(resumirSemNota([])).toEqual({ receita: 0, pedidos: 0, porEmpresa: [] });
  });
});

describe('quebra por idade e por cliente (banner acionável)', () => {
  const hoje = '2026-11-20';
  const p = (
    id: string,
    order_date_kpi: string | null,
    total: number,
    customer_user_id: string | null = 'C1',
    account = 'colacor',
  ): PedidoSemNotaDetalhe => ({
    id,
    account,
    total,
    order_date_kpi,
    customer_user_id,
    vendedor_user_id: 'V1',
    omie_numero_pedido: id,
  });

  it('[SN-FAIXA] fronteiras: 89d → 30–90, 90d → 90–180, 180d → 180+, sem data → fora', () => {
    expect(faixaSemNota('2026-08-23', hoje)).toBe('30-90'); // 89 dias
    expect(faixaSemNota('2026-08-22', hoje)).toBe('90-180'); // 90 dias
    expect(faixaSemNota('2026-05-24', hoje)).toBe('180+'); // 180 dias
    expect(faixaSemNota(null, hoje)).toBeNull();
  });

  it('[SN-FAIXA-SOMA] soma por faixa; sempre as 3 faixas, zero medido incluso', () => {
    const r = resumirPorFaixa([p('a', '2026-10-01', 100), p('b', '2026-10-10', 50), p('c', '2025-12-01', 7), p('d', null, 999)], hoje);
    expect(r).toEqual([
      { faixa: '30-90', receita: 150, pedidos: 2 },
      { faixa: '90-180', receita: 0, pedidos: 0 },
      { faixa: '180+', receita: 7, pedidos: 1 },
    ]);
  });

  it('[SN-CLIENTES] só a faixa 30–90d, agrupada por empresa+cliente, receita desc, pedidos por data', () => {
    const r = clientesSemNotaRecentes(
      [
        p('a', '2026-10-10', 100, 'C1'),
        p('b', '2026-09-30', 300, 'C1'),
        p('c', '2026-10-01', 250, 'C2'),
        p('d', '2026-10-01', 999, 'C1', 'oben'), // mesmo cliente, outra empresa → linha à parte
        p('e', '2025-12-01', 5000, 'C3'), // velho → fora
        p('f', '2026-10-01', 10, null), // sem cliente → fora
      ],
      hoje,
    );
    expect(r.map((c) => [c.account, c.customerUserId, c.receita])).toEqual([
      ['oben', 'C1', 999],
      ['colacor', 'C1', 400],
      ['colacor', 'C2', 250],
    ]);
    expect(r[1].pedidos.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
