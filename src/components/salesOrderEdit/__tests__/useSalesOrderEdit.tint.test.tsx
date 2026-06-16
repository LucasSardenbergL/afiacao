// Trava o contrato do item tintométrico na EDIÇÃO de pedido: o item gravado
// precisa carregar `tint_formula_id` (a fórmula da cor), além de cor/nome — é o
// que permite auditoria e re-precificação (flip do preço via get_tint_price).
// Espelha o que o balcão já grava (src/services/orderSubmission/submitOrder.ts).
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Sem `id` na rota → loadOrder() não dispara: handleTintConfirm fica testável isolado.
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useSalesOrderEdit } from '../useSalesOrderEdit';
import type { OmieProduct } from '../types';

const baseTint: OmieProduct = {
  id: 'prod-base-1',
  omie_codigo_produto: 9001,
  codigo: 'BASE-INC',
  descricao: 'Base Incolor Tintométrica',
  unidade: 'GL',
  valor_unitario: 80,
  estoque: 10,
  ativo: true,
  is_tintometric: true,
  tint_type: 'base',
};

describe('useSalesOrderEdit.handleTintConfirm', () => {
  it('grava tint_formula_id (além de cor/nome) no item de tinta', () => {
    const { result } = renderHook(() => useSalesOrderEdit());

    // Selecionar a base tintométrica abre o diálogo de cor (seta tintPendingProduct).
    act(() => {
      result.current.addProduct(baseTint);
    });

    // onConfirm: (formulaId, corId, nomeCor, precoFinal, custoCorantes, alt?)
    act(() => {
      result.current.handleTintConfirm('formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      tint_cor_id: 'RAL5005',
      tint_nome_cor: 'Azul Genciana',
      tint_formula_id: 'formula-uuid-123',
    });
  });
});
