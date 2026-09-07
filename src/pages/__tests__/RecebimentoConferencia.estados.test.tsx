import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard da CONFERÊNCIA DE NF-e — o sítio mais sensível do 3º front.
 *
 * A tela lia `nfe_recebimentos` com `.single()` e escrevia `if (!nfe) return "NF-e não
 * encontrada"`. Com `.single()`, "não achei a linha" LANÇA PGRST116 e chega ao componente
 * IDÊNTICO a uma queda de rede — a distinção não existe sem ler `error.code`
 * (achado 3 de docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * Por que este é o pior: a conferência é passo de RECEBIMENTO. "NF-e não encontrada"
 * durante uma falha manda o operador procurar um documento que EXISTE — ele para a
 * descarga, liga para o fornecedor, ou pior: conclui que a nota não foi lançada.
 *
 * O HOOK roda de verdade; só o `supabase` é mockado. O defeito mora na tradução
 * "PostgREST lançou" → `data === undefined` → tela do não-achado.
 */

const NFE_ID = 'nfe-1';

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

const NAO_ENCONTRADA = /NF-e não encontrada/i;

const NFE = {
  id: NFE_ID,
  numero_nfe: '12345',
  razao_social_emitente: 'Sayerlack Ind. e Com.',
  data_emissao: '2026-01-15',
  valor_total: 12345.67,
  status: 'em_conferencia',
  nfe_recebimento_itens: [],
  cte_associados: [],
};

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
  respostas = {};
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('RecebimentoConferencia — "NF-e não encontrada" só quando a NF-e não existe', () => {
  it('PGRST116 (0 linhas no `.single()`) → "NF-e não encontrada", sem aviso de falha', async () => {
    respostas = {
      nfe_recebimentos: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
    };
    renderizar();
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADA)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso de falha, e NUNCA "NF-e não encontrada"', async () => {
    // O operador não pode ser mandado procurar um documento que existe.
    respostas = {
      nfe_recebimentos: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } },
    };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
  });

  it('erro SEM `code` (queda de rede crua) também é falha, não não-achado', async () => {
    respostas = { nfe_recebimentos: { data: null, error: { message: 'Failed to fetch' } } };
    renderizar();
    await screen.findByTestId('aviso-leitura-falhou');
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA "não encontrada"', async () => {
    // PWA de campo: `isLoading` é FALSE, `data` é `undefined` e `error` é `null`.
    respostas = { nfe_recebimentos: { data: NFE, error: null } };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
  });

  it('a NF-e EXISTE → a tela abre a conferência, sem aviso nem não-achado', async () => {
    respostas = { nfe_recebimentos: { data: NFE, error: null } };
    renderizar();
    await waitFor(() => expect(screen.getAllByText(/12345/).length).toBeGreaterThan(0));
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });
});
