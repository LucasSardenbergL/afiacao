import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ItensPreviewLinha } from '../ItensPreviewLinha';

let resposta: { data: unknown; error: { message: string } | null } = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'range']) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta);
  return { supabase: { from: () => c } };
});

function renderPrevia() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <table>
        <tbody>
          <ItensPreviewLinha pedidoId={7} colunas={7} onAbrirDetalhes={() => {}} />
        </tbody>
      </table>
    </QueryClientProvider>,
  );
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 1, sku_codigo_omie: 'SKU-1', sku_descricao: 'Verniz PU', qtde_sugerida: 3.2, qtde_final: null,
  preco_unitario: 10, fator_embalagem_portal: null, ...over,
});

beforeEach(() => {
  resposta = { data: [], error: null };
});

describe('ItensPreviewLinha', () => {
  it('mostra SKU, descrição e a quantidade CANÔNICA (a mesma do modal: 3,2 → 4)', async () => {
    resposta = { data: [item()], error: null };
    renderPrevia();
    expect(await screen.findByText('Verniz PU')).toBeTruthy();
    expect(screen.getByText('SKU-1')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/R\$\s*40,00/)).toBeTruthy();
  });

  it('preço ausente vira "—", não R$ 0,00', async () => {
    resposta = { data: [item({ preco_unitario: null })], error: null };
    renderPrevia();
    await screen.findByText('Verniz PU');
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('leitura falha FALA (com retry) — não vira "Pedido sem itens"', async () => {
    resposta = { data: null, error: { message: 'permission denied' } };
    renderPrevia();
    expect(await screen.findByTestId('previa-itens-falhou')).toBeTruthy();
    expect(screen.queryByText(/Pedido sem itens/)).toBeNull();
  });

  it('pedido sem itens diz isso', async () => {
    renderPrevia();
    expect(await screen.findByText(/Pedido sem itens/)).toBeTruthy();
  });
});
