import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { toast } from 'sonner';

/**
 * A gravação de um item da campanha passa pela conferência de LINHA AFETADA: o PostgREST responde 204
 * sem erro a um PATCH que não casa nada (item excluído depois do carregamento), e a tela tratava isso
 * como sucesso — no vínculo manual, irmãos nasciam sobre um original inexistente. Aqui a edição inline
 * do desconto atravessa a página de verdade (só o `supabase` é mockado) até o toast de erro.
 */

const CAMPANHA = { id: 7, nome: 'Campanha Sayerlack Outubro', tipo_origem: 'fornecedor_impoe', estado: 'rascunho', empresa: 'OBEN' };
const ITEM = {
  id: 151, campanha_id: 7, sku_codigo_fornecedor: 'DR.4403', descricao_produto_fornecedor: 'THINNER - OFERTA',
  sku_codigo_omie: null, mapeamento_qualidade: 'nao_encontrado', mapeamento_candidatos: null, desconto_perc: 20,
  volume_minimo: null, confirmado: false, ativo: true, desconto_extra_perc: null, desconto_extra_observacoes: null,
  desconto_extra_negociado_por: null, desconto_extra_negociado_em: null, desconto_extra_email_referencia: null,
};

const { patches } = vi.hoisted(() => ({ patches: [] as unknown[] }));

function encadear(tabela: string) {
  const resposta = () =>
    Promise.resolve(
      tabela === 'promocao_campanha' ? { data: CAMPANHA, error: null }
        : tabela === 'promocao_item' ? { data: [ITEM], error: null }
          : { data: [], error: null },
    );
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => resposta(),
    limit: () => resposta(),
    maybeSingle: () => resposta(),
    single: () => resposta(),
    then: (ok: unknown, falha: unknown) => resposta().then(ok as never, falha as never),
    // O PATCH que não casa linha: sem erro e sem dado (o 204 do PostgREST).
    update: (changes: unknown) => {
      patches.push(changes);
      const semLinha = () => Promise.resolve({ data: [], error: null });
      const filtro = {
        eq: () => filtro,
        select: () => semLinha(),
        then: (ok: unknown, falha: unknown) => Promise.resolve({ error: null }).then(ok as never, falha as never),
      };
      return filtro;
    },
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => encadear(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: null }) }) },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'lucas@colacor.com.br' }, isMaster: true, isStaff: true, loading: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdminReposicaoPromocaoDetail from '../AdminReposicaoPromocaoDetail';

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  patches.length = 0;
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe('AdminReposicaoPromocaoDetail — gravação de item', () => {
  it('editar o desconto de um item que sumiu (PATCH sem linha) vira ERRO na tela, não sucesso silencioso', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/promocao/7']}>
          <Routes>
            <Route path="/promocao/:id" element={<AdminReposicaoPromocaoDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Itens/ }), { button: 0 });
    const desconto = (await screen.findAllByRole('spinbutton'))[0];
    fireEvent.change(desconto, { target: { value: '33' } });
    fireEvent.blur(desconto);

    // 1º: o PATCH saiu (senão o vermelho abaixo seria por a edição nem ter chegado lá).
    await waitFor(() => expect(patches).toStrictEqual([{ desconto_perc: 33 }]));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toMatch(/nenhuma linha/);
  }, 20000);
});
