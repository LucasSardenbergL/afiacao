import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard da ficha da BASE DE CONHECIMENTO — 297 documentos vivos, 3 pessoas com acesso.
 *
 * Lia `kb_documents` com `.single()` e escrevia `if (!data) return "Documento não
 * encontrado"`. Com `.single()`, 0 linhas LANÇA PGRST116 e chega ao componente idêntico
 * a uma falha de leitura (achado 3 de docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * O HOOK roda de verdade; só o `supabase` é mockado.
 */

const DOC_ID = 'doc-1';
const NAO_ENCONTRADO = /Documento não encontrado/i;

type Resposta = { data: unknown; error: unknown; count?: number };
let respostas: Record<string, Resposta> = {};

function encadear(tabela: string) {
  const resolver = () => Promise.resolve(respostas[tabela] ?? { data: [], error: null, count: 0 });
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => resolver(),
    limit: () => resolver(),
    maybeSingle: () => resolver(),
    single: () => resolver(),
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => encadear(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isMaster: true, isStaff: true, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'u1' }),
}));

import AdminKnowledgeBaseDetail from '../AdminKnowledgeBaseDetail';

const DOCUMENTO = {
  id: DOC_ID,
  title: 'Boletim Sayerlack XPTO',
  type: 'boletim',
  status: 'aprovado',
  supplier: 'Sayerlack',
  product_code: null,
  tags: [],
  created_at: '2026-01-01T00:00:00Z',
};

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/kb/${DOC_ID}`]}>
        <Routes>
          <Route path="/kb/:id" element={<AdminKnowledgeBaseDetail />} />
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

describe('AdminKnowledgeBaseDetail — "não encontrado" só quando o documento não existe', () => {
  it('PGRST116 (0 linhas no `.single()`) → "Documento não encontrado", sem aviso', async () => {
    respostas = { kb_documents: { data: null, error: { code: 'PGRST116', message: 'no rows' } } };
    renderizar();
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADO)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso de falha, e NUNCA "Documento não encontrado"', async () => {
    respostas = { kb_documents: { data: null, error: { code: '42501', message: 'permission denied' } } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('SEM REDE (pending+paused) → aviso de sem-rede, e NUNCA "Documento não encontrado"', async () => {
    respostas = { kb_documents: { data: DOCUMENTO, error: null } };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('o documento EXISTE → a ficha abre, sem aviso nem não-achado', async () => {
    respostas = { kb_documents: { data: DOCUMENTO, error: null } };
    renderizar();
    await waitFor(() => expect(screen.getByText(/Boletim Sayerlack XPTO/)).toBeInTheDocument());
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });
});
