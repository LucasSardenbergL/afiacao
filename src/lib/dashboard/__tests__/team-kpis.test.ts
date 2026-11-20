import { describe, it, expect } from 'vitest';
import {
  isPedidoValido,
  somarReceita,
  contarVendedoresComPedido,
  montarRanking,
  rankingSemPedido,
  variacaoPct,
  type OrderRow,
  type PedidoVendedorRow,
  type OrderRankRow,
  type RankingResult,
} from '../team-kpis';
import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

describe('team-kpis', () => {
  it('isPedidoValido: o universo da autoridade — orçamento e pendente também não são receita', () => {
    for (const s of STATUS_NAO_VENDA) expect(isPedidoValido(s), s).toBe(false);
    expect(isPedidoValido('orcamento')).toBe(false);
    expect(isPedidoValido('pendente')).toBe(false);
  });

  it('isPedidoValido: cancelado/rascunho/null inválidos, resto válido', () => {
    expect(isPedidoValido('enviado')).toBe(true);
    expect(isPedidoValido('faturado')).toBe(true);
    expect(isPedidoValido('entregue')).toBe(true);
    expect(isPedidoValido('cancelado')).toBe(false);
    expect(isPedidoValido('rascunho')).toBe(false);
    expect(isPedidoValido(null)).toBe(false);
  });

  it('somarReceita: só pedidos válidos com order_date_kpi na janela [de, ate)', () => {
    const orders: OrderRow[] = [
      { total: 1000, status: 'faturado', order_date_kpi: '2026-06-04' },
      { total: 500, status: 'cancelado', order_date_kpi: '2026-06-04' }, // inválido
      { total: 300, status: 'enviado', order_date_kpi: '2026-06-03' }, // fora da janela "hoje"
      { total: 999, status: 'rascunho', order_date_kpi: '2026-06-04' }, // inválido
      { total: 42, status: 'faturado', order_date_kpi: null }, // sem data → fora
    ];
    expect(somarReceita(orders, '2026-06-04', '2026-06-05')).toBe(1000); // só o faturado de hoje
    expect(somarReceita(orders, '2026-06-01', '2026-06-05')).toBe(1300); // faturado + enviado (mês)
  });

  it('[VEND-OMIE] contarVendedoresComPedido: distinct vendedor do Omie; sem vendedor conta à parte', () => {
    const p = (vendedor_user_id: string | null, order_date_kpi: string, status = 'faturado'): PedidoVendedorRow => ({
      total: 100,
      status,
      order_date_kpi,
      vendedor_user_id,
    });
    const orders = [
      p('REGINA', '2026-11-20'),
      p('REGINA', '2026-11-20'), // mesma vendedora
      p('TATY', '2026-11-03'), // no mês, fora de "hoje"
      p(null, '2026-11-20'), // sem vendedor → à parte, não vira vendedor fantasma
      p('CRIS', '2026-11-20', 'cancelado'), // não é venda
      p('ANTIGO', '2026-10-31'), // fora do mês
    ];
    expect(contarVendedoresComPedido(orders, '2026-11-20', '2026-11-21')).toEqual({ vendedores: 1, pedidosSemVendedor: 1 });
    expect(contarVendedoresComPedido(orders, '2026-11-01', '2026-11-21')).toEqual({ vendedores: 2, pedidosSemVendedor: 1 });
    expect(contarVendedoresComPedido([], '2026-11-01', '2026-11-21')).toEqual({ vendedores: 0, pedidosSemVendedor: 0 });
  });

  // ── Ranking pelo DONO DA CARTEIRA (spec 2026-10-06) ──────────────────────────────────────────
  // C1/C2 → carteira de vendedor (Regina, Tatyana) · C3 → carteira do master (não vende) · C4 sem
  // carteira elegível. O `created_by` das importadas é carimbo técnico: não decide nada.
  const vendedores = new Map([['V1', 'Regina'], ['V2', 'Tatyana'], ['V3', 'Cris']]);
  const donoPorCliente = new Map([['C1', 'V1'], ['C2', 'V2'], ['C3', 'MASTER']]);
  const regua = { donoPorCliente, vendedores };
  const vazio = { receita: 0, pedidos: 0 };

  it('[RK-A] carteira elegível de vendedor: a venda é do dono', () => {
    const r = montarRanking([{ total: 1000, status: 'faturado', customer_user_id: 'C1' }], regua);
    expect(r.ranking).toEqual([{ id: 'V1', nome: 'Regina', receita: 1000, pedidos: 1 }]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-B] dono que não é farmer/hunter/closer: rodapé próprio, fora do ranking e do não-atribuído', () => {
    const r = montarRanking([{ total: 700, status: 'faturado', customer_user_id: 'C3' }], regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual({ receita: 700, pedidos: 1 });
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-C] cliente sem carteira elegível: sem vendedor atribuído', () => {
    const r = montarRanking([{ total: 300, status: 'enviado', customer_user_id: 'C4' }], regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual({ receita: 300, pedidos: 1 });
  });

  it('[RK-D] created_by de um vendedor não tira a venda do dono da carteira', () => {
    // Variável, não literal: o tipo não tem `created_by` (nenhuma via o lê), e a linha real tem.
    const linhas = [{ total: 500, status: 'faturado', customer_user_id: 'C2', created_by: 'V1' }];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([{ id: 'V2', nome: 'Tatyana', receita: 500, pedidos: 1 }]);
  });

  it('[RK-E] linha do app e importada do mesmo cliente: o mesmo dono', () => {
    const linhas = [
      { total: 100, status: 'faturado', customer_user_id: 'C2', created_by: 'V1' }, // app: lançada pela V1
      { total: 200, status: 'faturado', customer_user_id: 'C2', created_by: 'SISTEMA' }, // importada: carimbo
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([{ id: 'V2', nome: 'Tatyana', receita: 300, pedidos: 2 }]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
  });

  it('[RK-F] status fora do universo de venda não entra em destino nenhum', () => {
    const linhas: OrderRankRow[] = [
      ...STATUS_NAO_VENDA.map((s) => ({ total: 100, status: s, customer_user_id: 'C1' })),
      { total: 100, status: null, customer_user_id: 'C3' },
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-G] conservação: ranking + não-vendedor + não-atribuído = todos os pedidos válidos', () => {
    const linhas: OrderRankRow[] = [
      { total: 100, status: 'faturado', customer_user_id: 'C1' },
      { total: 200, status: 'enviado', customer_user_id: 'C3' },
      { total: 300, status: 'faturado', customer_user_id: 'C4' },
      { total: 400, status: 'faturado', customer_user_id: null },
      { total: 999, status: 'cancelado', customer_user_id: 'C1' },
    ];
    const r = montarRanking(linhas, regua);
    const soma = (f: 'receita' | 'pedidos') =>
      r.ranking.reduce((s, v) => s + v[f], 0) + r.carteiraNaoVendedor[f] + r.naoAtribuido[f];
    expect(soma('receita')).toBe(1000);
    expect(soma('pedidos')).toBe(4);
  });

  it('[RK-H] ordena por receita desc e conta o vendedor sem venda em semAtividade', () => {
    const linhas: OrderRankRow[] = [
      { total: 300, status: 'faturado', customer_user_id: 'C1' },
      { total: 1000, status: 'faturado', customer_user_id: 'C2' },
      { total: 500, status: 'enviado', customer_user_id: 'C2' },
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([
      { id: 'V2', nome: 'Tatyana', receita: 1500, pedidos: 2 },
      { id: 'V1', nome: 'Regina', receita: 300, pedidos: 1 },
    ]);
    expect(r.semAtividade).toBe(1); // Cris
  });

  it('[RK-I] pedido sem cliente: sem vendedor atribuído', () => {
    const r = montarRanking([{ total: 80, status: 'faturado', customer_user_id: null }], regua);
    expect(r.naoAtribuido).toEqual({ receita: 80, pedidos: 1 });
    expect(r.carteiraNaoVendedor).toEqual(vazio);
  });

  it('[RK-VAZIO] mês sem pedido: os três destinos zerados e todo vendedor em semAtividade', () => {
    expect(montarRanking([], regua)).toEqual({
      ranking: [],
      carteiraNaoVendedor: vazio,
      naoAtribuido: vazio,
      semAtividade: 3,
    });
  });

  it('[RK-SP] rankingSemPedido: só é true com os TRÊS destinos vazios', () => {
    const base: RankingResult = { ranking: [], carteiraNaoVendedor: vazio, naoAtribuido: vazio, semAtividade: 2 };
    expect(rankingSemPedido(base)).toBe(true);
    expect(rankingSemPedido({ ...base, carteiraNaoVendedor: { receita: 50, pedidos: 1 } })).toBe(false);
    expect(rankingSemPedido({ ...base, naoAtribuido: { receita: 50, pedidos: 1 } })).toBe(false);
    expect(rankingSemPedido({ ...base, ranking: [{ id: 'V1', nome: 'Regina', receita: 50, pedidos: 1 }] })).toBe(false);
  });

  it('variacaoPct: fração vs base; null sem base (não fabrica % de zero)', () => {
    expect(variacaoPct(112, 100)).toBeCloseTo(0.12);
    expect(variacaoPct(80, 100)).toBeCloseTo(-0.2);
    expect(variacaoPct(0, 100)).toBe(-1);
    expect(variacaoPct(50, 0)).toBeNull();
    expect(variacaoPct(50, -10)).toBeNull();
  });
});
