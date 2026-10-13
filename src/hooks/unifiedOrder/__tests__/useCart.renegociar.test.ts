/**
 * @vitest-environment jsdom
 */
// Fase 2B: negociar uma linha COM COR depois que ela está no carrinho. Prova de ponta a
// ponta no front: edição no carrinho → payload que o submitOrder grava (e o edge leva ao
// `tint_gate_revalida`) → passa a régua do gate. Antes, editar o preço mexia só em
// `unit_price` e o gate recusava no envio (preco_divergente).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/services/omieService', () => ({ syncOrderToOmie: vi.fn() }));
vi.mock('@/services/orderSubmission/buildPrintData', () => ({ buildPrintData: vi.fn().mockReturnValue([]) }));
vi.mock('@/services/orderSubmission/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/orderSubmission/helpers')>()),
  formatCustomerAddress: vi.fn().mockReturnValue('Rua X, 1'),
  resolveCustomerPhone: vi.fn().mockResolvedValue('11999999999'),
}));
vi.mock('@/services/orderSubmission/vendabilidade', () => ({
  validarVendabilidade: vi.fn().mockResolvedValue({ ok: true }),
  bloqueioVendabilidade: vi.fn().mockReturnValue(null),
}));
// Captura o que o submitOrder grava em sales_orders.items (o MESMO jsonb que o edge lê e
// manda ao gate) e aborta ali — nada de Omie neste teste.
const gravado: { items?: Array<Record<string, unknown>> } = {};
vi.mock('@/services/orderSubmission/idempotency', () => ({
  ensureSalesOrderRow: vi.fn(async (_s: unknown, args: { fields: { items: Array<Record<string, unknown>> } }) => {
    gravado.items = args.fields.items;
    throw new Error('parar-aqui');
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), critical: vi.fn(), warn: vi.fn() } }));

import { toast } from 'sonner';
import { useCart } from '../useCart';
import { submitOrder } from '@/services/orderSubmission/submitOrder';
import type { SubmitOrderParams } from '@/services/orderSubmission/types';
import type { Product, ProductCartItem } from '@/hooks/useUnifiedOrder';
import type { OmieCustomer } from '@/hooks/unifiedOrder/types';

const base = (id: string, cod: number): Product => ({
  id, codigo: `BASE-${cod}`, descricao: `Base ${cod}`, unidade: 'GL', valor_unitario: 80, estoque: 10, ativo: true,
  omie_codigo_produto: cod, account: 'oben', is_tintometric: true, tint_type: 'base',
});
const comum: Product = {
  id: 'p-comum', codigo: 'LIXA', descricao: 'Lixa', unidade: 'UN', valor_unitario: 5, estoque: 10, ativo: true,
  omie_codigo_produto: 7001, account: 'oben',
};

/** Régua do `tint_gate_revalida` (migration 20261012150000) para fonte de seletor. */
function gateAceita(item: Record<string, unknown>, baseServidor: number): boolean {
  if (typeof item.tint_formula_id !== 'string') return false;
  if (!['calculado', 'tabela', 'cliente'].includes(item.tint_price_source as string)) return false;
  const d = typeof item.tint_discount_pct === 'number' ? item.tint_discount_pct : 0;
  if (!(d >= 0 && d < 100)) return false;
  const esperado = Math.floor(baseServidor * (1 - d / 100) * 100 + 0.5) / 100;
  const vu = item.valor_unitario as number;
  return vu > 0 && Math.abs(vu - esperado) <= 0.005;
}

function setup() {
  return renderHook(() =>
    useCart({ getProductPrice: (p) => p.valor_unitario ?? 0, getServicePrice: () => null, servicos: [] }),
  );
}

type Hook = ReturnType<typeof setup>['result'];
function addCor(result: Hook, prod: Product, formula: string, cor: string, preco: number, fonte = 'calculado') {
  act(() => {
    result.current.addTintProductToCart(prod, formula, cor, cor, preco, 5, { source: fonte, discountPct: 0, precoSemDesconto: preco }, 2);
  });
}

async function payloadDoEnvio(itens: ProductCartItem[]) {
  gravado.items = undefined;
  await submitOrder({
    customer: { codigo_cliente: 123, razao_social: 'Cliente', nome_fantasia: '', cnpj_cpf: '1' } as OmieCustomer,
    customerUserId: 'cu-1', user: { id: 'u-1' },
    cart: { obenProductItems: itens, colacorProductItems: [], serviceItems: [] },
    subtotals: { oben: 0, colacor: 0, service: 0 }, volumes: { oben: 0, colacor: 0 },
    payment: { parcelaOben: '1', parcelaColacor: '1', afiacaoMethod: 'pix', formasPagamentoOben: [], formasPagamentoColacor: [] },
    delivery: { option: 'balcao', selectedAddress: undefined },
    meta: { notes: '', readyByDate: '', ordemCompra: '' },
    companyProfiles: {}, defaultProductionAssigneeId: null, getServicePrice: () => 0,
    supabase: {}, checkoutId: 'chk', origem: null, atendimentoId: null,
  } as unknown as SubmitOrderParams);
  expect(gravado.items).toBeDefined();
  return gravado.items!;
}

beforeEach(() => vi.clearAllMocks());

describe('Fase 2B — editar a linha com cor no carrinho', () => {
  it('editar o PREÇO regrava fonte/desconto/partida e o payload do envio passa a régua do gate', async () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 160.7);
    let ok = false;
    act(() => { ok = result.current.updateProductPrice(0, 150); });
    expect(ok).toBe(true);
    const item = result.current.productItems[0];
    expect(item).toMatchObject({ unit_price: 150, tint_price_source: 'calculado', tint_preco_sem_desconto: 160.7 });
    expect(item.tint_discount_pct).toBeCloseTo(6.6584, 3);

    const [enviado] = await payloadDoEnvio(result.current.obenProductItems);
    expect(enviado).toMatchObject({ valor_unitario: 150, tint_formula_id: 'f-1', tint_price_source: 'calculado', tint_preco_sem_desconto: 160.7 });
    expect(gateAceita(enviado, 160.7)).toBe(true);
  });

  it('editar o DESCONTO recalcula o preço a partir da partida', async () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 611.9, 'tabela');
    act(() => { result.current.updateTintDiscount(0, 12.5); });
    expect(result.current.productItems[0]).toMatchObject({ unit_price: 535.41, tint_discount_pct: 12.5, tint_preco_sem_desconto: 611.9, tint_price_source: 'tabela' });
    const [enviado] = await payloadDoEnvio(result.current.obenProductItems);
    expect(gateAceita(enviado, 611.9)).toBe(true);
  });

  it('preço acima da partida é recusado NA HORA: item intacto + toast com o motivo', () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 160.7);
    const antes = result.current.productItems[0];
    let ok = true;
    act(() => { ok = result.current.updateProductPrice(0, 170); });
    expect(ok).toBe(false);
    expect(result.current.productItems[0]).toBe(antes);
    expect(toast.error).toHaveBeenCalledWith('Preço da cor não alterado', expect.objectContaining({ description: expect.stringContaining('não para subir') }));
  });

  it('desconto que arredonda a R$ 0,00 é recusado (nunca R$ 0)', () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 20);
    act(() => { result.current.updateTintDiscount(0, 99.99); });
    expect(result.current.productItems[0].unit_price).toBe(20);
    expect(toast.error).toHaveBeenCalled();
  });

  it('linha SEM cor segue com a edição livre de antes', () => {
    const { result } = setup();
    act(() => { result.current.addProductToCart(comum, 1); });
    act(() => { result.current.updateProductPrice(0, 7.5); });
    expect(result.current.productItems[0].unit_price).toBe(7.5);
  });
});

describe('Fase 2B — desconto do pedido nas cores', () => {
  it('aplica o mesmo % às N cores de uma vez; o produto sem cor fica intacto; o payload passa o gate', async () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 160.7);
    act(() => { result.current.addProductToCart(comum, 3); });
    addCor(result, base('b2', 9002), 'f-2', 'RAL5005', 611.9, 'tabela');
    addCor(result, base('b3', 9003), 'f-3', 'Q77', 169.3);

    let r: { aplicadas: number } | null = null;
    act(() => { r = result.current.aplicarDescontoCores(10); });
    expect(r).toEqual({ aplicadas: 3 });
    expect(result.current.productItems.map((i) => i.unit_price)).toEqual([144.63, 5, 550.71, 152.37]);

    const enviados = await payloadDoEnvio(result.current.obenProductItems);
    const partidas: Record<string, number> = { 'f-1': 160.7, 'f-2': 611.9, 'f-3': 169.3 };
    for (const e of enviados.filter((x) => x.tint_formula_id)) {
      expect(e.tint_discount_pct).toBe(10);
      expect(gateAceita(e, partidas[e.tint_formula_id as string])).toBe(true);
    }
  });

  it('cor adicionada DEPOIS do desconto do pedido entra sem desconto (não é estado ambiente)', () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 160.7);
    addCor(result, base('b2', 9002), 'f-2', 'RAL5005', 611.9);
    act(() => { result.current.aplicarDescontoCores(10); });
    addCor(result, base('b3', 9003), 'f-3', 'Q77', 169.3);
    expect(result.current.productItems[2]).toMatchObject({ unit_price: 169.3, tint_discount_pct: 0 });
  });

  it('uma cor que não aceita recusa o lote inteiro (tudo-ou-nada) e nada muda', () => {
    const { result } = setup();
    addCor(result, base('b1', 9001), 'f-1', 'H109', 160.7);
    addCor(result, base('b2', 9002), 'f-2', 'BARATA', 0.5);
    const antes = result.current.cart;
    let r: { aplicadas: number } | null = { aplicadas: -1 };
    act(() => { r = result.current.aplicarDescontoCores(99.5); });
    expect(r).toBeNull();
    expect(result.current.cart).toBe(antes);
    expect(toast.error).toHaveBeenCalledWith('Desconto não aplicado em nenhuma cor', expect.objectContaining({ description: expect.stringContaining('BARATA') }));
  });
});
