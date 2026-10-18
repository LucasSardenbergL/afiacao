import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Tables } from '@/integrations/supabase/types';

/**
 * A conferência renderizava `item.descricao_produto` — campo que NÃO existe em
 * `nfe_recebimento_itens` (a coluna é `descricao`, gravada pelos dois writers:
 * `omie-nfe-webhook` e `omie-nfe-recebimento-sync`). Como o tipo local tinha
 * `[k: string]: unknown`, o TS aceitou e a descrição saiu EM BRANCO em todos os
 * itens, para quem confere mercadoria no balcão.
 *
 * O item do cenário tem o shape da Row gerada pelo Supabase, então um campo
 * inventado na tela não compila mais aqui — e, se compilar por cast, não aparece.
 */

type ItemRow = Tables<'nfe_recebimento_itens'>;

const NFE_ID = 'nfe-1';
const DESCRICAO = 'Verniz PU Fosco 3,6L';

const ITEM: ItemRow = {
  id: 'item-1',
  nfe_recebimento_id: NFE_ID,
  sequencia: 1,
  codigo_produto: 'SAY-001',
  descricao: DESCRICAO,
  ean: null,
  ncm: null,
  produto_omie_id: null,
  quantidade_nfe: 10,
  quantidade_esperada: 10,
  quantidade_conferida: 0,
  quantidade_convertida: null,
  unidade_nfe: 'UN',
  unidade_estoque: null,
  valor_unitario: null,
  valor_total: null,
  status_item: 'pendente',
  observacao_divergencia: null,
  ajuste_estoque_ok: false,
  ajuste_estoque_at: null,
  ajuste_estoque_omie_id: null,
  created_at: '2026-10-18T12:00:00Z',
};

const NFE = {
  id: NFE_ID,
  numero_nfe: '12345',
  razao_social_emitente: 'Sayerlack Ind. e Com.',
  data_emissao: '2026-01-15',
  valor_total: 1234.56,
  status: 'em_conferencia',
  nfe_recebimento_itens: [ITEM],
  cte_associados: [],
};

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(tabela: string) {
  const resolver = () => Promise.resolve(respostas[tabela] ?? { data: [], error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => resolver(),
    maybeSingle: () => resolver(),
    single: () => resolver(),
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => encadear(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}));
vi.mock('@/hooks/useOfflineMutation', () => ({
  useOfflineMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/recebimento/LoteScannerOCR', () => ({ default: () => null }));

import RecebimentoConferencia from '../RecebimentoConferencia';

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/recebimento/${NFE_ID}`]}>
        <Routes>
          <Route path="/recebimento/:id" element={<RecebimentoConferencia />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  respostas = { nfe_recebimentos: { data: NFE, error: null } };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecebimentoConferencia — descrição do item vem da coluna `descricao`', () => {
  it('renderiza a `descricao` gravada pelos writers no card do item', async () => {
    renderizar();
    expect(await screen.findByText(DESCRICAO)).toBeInTheDocument();
    // O código continua ao lado — prova que é o card do item, não outro texto da tela.
    expect(screen.getByText(/SAY-001/)).toBeInTheDocument();
  });
});
