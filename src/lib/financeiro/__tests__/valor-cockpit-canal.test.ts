// Canal do pedido no Cockpit de Valor (programa Cabreúva-Colacor, PR1).
// Contexto de dado (psql-ro 2026-08-03): origem é ~100% NULL em prod (30.650 pedidos, 1 web_staff);
// TODA a venda entra pelo ERP → o rollup por canal nasce como ESPELHO DE DIGITALIZAÇÃO
// (quanto da venda passa pelo app) e vira comparação de margem quando houver volume digital.
import { describe, it, expect } from 'vitest';
import { classificarCanalPedido, agregarPorCanal, type CanalPedido } from '../valor-cockpit-helpers';

describe('classificarCanalPedido', () => {
  it('origem explícita manda: web_customer → app_cliente, web_staff → app_staff', () => {
    expect(classificarCanalPedido({ origem: 'web_customer', checkout_id: null })).toBe('app_cliente');
    expect(classificarCanalPedido({ origem: 'web_staff', checkout_id: 'c1' })).toBe('app_staff');
  });

  it('ligações (sainte e entrante) caem no canal ligacao', () => {
    expect(classificarCanalPedido({ origem: 'ligacao_sainte', checkout_id: 'c1' })).toBe('ligacao');
    expect(classificarCanalPedido({ origem: 'ligacao_entrante', checkout_id: 'c1' })).toBe('ligacao');
  });

  it('sem origem: checkout presente → app_sem_origem (nasceu no app antes do rastreio); sem nada → erp_direto', () => {
    expect(classificarCanalPedido({ origem: null, checkout_id: 'chk-1' })).toBe('app_sem_origem');
    expect(classificarCanalPedido({ origem: null, checkout_id: null })).toBe('erp_direto');
  });

  it('origem desconhecida NÃO é fabricada em bucket conhecido → outro', () => {
    expect(classificarCanalPedido({ origem: 'whatsapp_bot', checkout_id: null })).toBe('outro');
  });

  it('string vazia/espaços = ausência de origem (normaliza antes de classificar)', () => {
    expect(classificarCanalPedido({ origem: '', checkout_id: null })).toBe('erp_direto');
    expect(classificarCanalPedido({ origem: '  ', checkout_id: 'c1' })).toBe('app_sem_origem');
  });
});

describe('agregarPorCanal', () => {
  const canalDe = (pares: Record<string, CanalPedido>) => new Map(Object.entries(pares));

  it('agrega receita/qtd/desconto por canal e conta pedidos e clientes DISTINTOS', () => {
    const rollups = agregarPorCanal(
      [
        { sales_order_id: 'p1', cliente: 'A', receita_liquida: 100, quantidade: 2, desconto: 5, custo_unitario: 10 },
        { sales_order_id: 'p1', cliente: 'A', receita_liquida: 50, quantidade: 1, desconto: 0, custo_unitario: 20 },
        { sales_order_id: 'p2', cliente: 'B', receita_liquida: 300, quantidade: 3, desconto: 10, custo_unitario: 50 },
      ],
      canalDe({ p1: 'app_staff', p2: 'erp_direto' }),
    );
    const app = rollups.find((r) => r.canal === 'app_staff')!;
    expect(app).toMatchObject({ pedidos: 1, clientes: 1, receita: 150, quantidade: 3, desconto: 5 });
    // cm item a item: (100 − 10·2) + (50 − 20·1) = 80 + 30 = 110
    expect(app.cm).toBe(110);
    expect(app.cm_incompleto).toBe(false);
    expect(app.receita_sem_cm).toBe(0);
    const erp = rollups.find((r) => r.canal === 'erp_direto')!;
    expect(erp).toMatchObject({ pedidos: 1, clientes: 1, receita: 300, cm: 150 });
  });

  it('custo ausente NÃO fabrica margem: item sem custo sai do cm, marca cm_incompleto e soma receita_sem_cm', () => {
    const [r] = agregarPorCanal(
      [
        { sales_order_id: 'p1', cliente: 'A', receita_liquida: 100, quantidade: 1, desconto: 0, custo_unitario: 40 },
        { sales_order_id: 'p1', cliente: 'A', receita_liquida: 70, quantidade: 1, desconto: 0, custo_unitario: null },
      ],
      canalDe({ p1: 'erp_direto' }),
    );
    expect(r.cm).toBe(60); // só o item com custo (100−40); o de 70 NÃO vira margem 70
    expect(r.cm_incompleto).toBe(true);
    expect(r.receita_sem_cm).toBe(70);
  });

  it('canal onde NENHUM item tem custo → cm null (ausente ≠ zero)', () => {
    const [r] = agregarPorCanal(
      [{ sales_order_id: 'p1', cliente: 'A', receita_liquida: 100, quantidade: 1, desconto: 0, custo_unitario: null }],
      canalDe({ p1: 'ligacao' }),
    );
    expect(r.cm).toBeNull();
    expect(r.receita_sem_cm).toBe(100);
  });

  it('pedido fora do mapa de canais cai em outro (defensivo — não fabrica erp_direto)', () => {
    const [r] = agregarPorCanal(
      [{ sales_order_id: 'orfao', cliente: 'A', receita_liquida: 10, quantidade: 1, desconto: 0, custo_unitario: 1 }],
      canalDe({}),
    );
    expect(r.canal).toBe('outro');
  });

  it('ordena por receita desc e não inventa canal sem item', () => {
    const rollups = agregarPorCanal(
      [
        { sales_order_id: 'p1', cliente: 'A', receita_liquida: 10, quantidade: 1, desconto: 0, custo_unitario: 1 },
        { sales_order_id: 'p2', cliente: 'B', receita_liquida: 999, quantidade: 1, desconto: 0, custo_unitario: 1 },
      ],
      canalDe({ p1: 'app_cliente', p2: 'erp_direto' }),
    );
    expect(rollups.map((r) => r.canal)).toEqual(['erp_direto', 'app_cliente']);
    expect(rollups).toHaveLength(2);
  });
});
