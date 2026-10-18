import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ItensPreviewLinha } from '../ItensPreviewLinha';

type Resp = { data: unknown; error: { message: string } | null };
let resposta: Resp = { data: [], error: null };
let respostaDecisoes: Resp = { data: [], error: null };
let respostaPerfis: Resp = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => {
  const por = (t: string) => (t === 'raio_x_decisao' ? respostaDecisoes : t === 'profiles' ? respostaPerfis : resposta);
  return {
    supabase: {
      from: (t: string) => {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'range', 'in']) c[m] = () => c;
        c.then = (resolve: (v: unknown) => void) => resolve(por(t));
        return c;
      },
    },
  };
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
  respostaDecisoes = { data: [], error: null };
  respostaPerfis = { data: [], error: null };
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

  describe('selo do Raio-X', () => {
    const decisao = (over: Record<string, unknown> = {}) => ({
      empresa: 'oben', sku_codigo_omie: 1, destino: 'liquidar', decidido_em: '2026-10-05T12:00:00Z',
      decidido_por: 'u1', ...over,
    });

    it('SKU decidido como liquidar mostra o selo com data, autor e classe de aviso', async () => {
      resposta = { data: [item({ sku_codigo_omie: '1' })], error: null };
      respostaDecisoes = { data: [decisao()], error: null };
      respostaPerfis = { data: [{ user_id: 'u1', name: 'Ana' }], error: null };
      renderPrevia();
      const selo = await screen.findByTestId('selo-raio-x');
      expect(selo.textContent).toContain('Raio-X: liquidar · 05/10/2026 ·');
      expect(selo.textContent).toContain('Ana');
      expect(selo.className).toContain('text-status-warning');
    });

    it('manter_suspender_recompra mostra rótulo legível, não snake_case (S11)', async () => {
      resposta = { data: [item({ sku_codigo_omie: '1' })], error: null };
      respostaDecisoes = { data: [decisao({ destino: 'manter_suspender_recompra' })], error: null };
      renderPrevia();
      const selo = await screen.findByTestId('selo-raio-x');
      expect(selo.textContent).toContain('Raio-X: manter · suspender recompra');
      expect(selo.textContent).not.toContain('manter_suspender');
    });

    it('venda_dirigida não gera selo', async () => {
      resposta = { data: [item({ sku_codigo_omie: '1' })], error: null };
      respostaDecisoes = { data: [decisao({ destino: 'venda_dirigida' })], error: null };
      renderPrevia();
      await screen.findByText('Verniz PU');
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId('selo-raio-x')).toBeNull();
    });

    it('falha ao ler as decisões: a linha renderiza normal, sem selo', async () => {
      resposta = { data: [item({ sku_codigo_omie: '1' })], error: null };
      respostaDecisoes = { data: null, error: { message: 'boom' } };
      renderPrevia();
      expect(await screen.findByText('Verniz PU')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId('selo-raio-x')).toBeNull();
      expect(screen.queryByTestId('previa-itens-falhou')).toBeNull();
    });

    it('sem nome do autor: selo aparece sem o autor', async () => {
      resposta = { data: [item({ sku_codigo_omie: '1' })], error: null };
      respostaDecisoes = { data: [decisao({ destino: 'trocar' })], error: null };
      respostaPerfis = { data: null, error: { message: 'x' } };
      renderPrevia();
      const selo = await screen.findByTestId('selo-raio-x');
      expect(selo.textContent).toBe('Raio-X: trocar · 05/10/2026');
    });
  });
});
