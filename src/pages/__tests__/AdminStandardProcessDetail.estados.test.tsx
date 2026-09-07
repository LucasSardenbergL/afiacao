import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard do detalhe do PROCESSO PADRÃO — "Processo não encontrado." não pode ser o que a
 * falha de leitura diz.
 *
 * `standard_processes` tem 0 linhas hoje: o fix sai antes da primeira linha, quando não há
 * comportamento observável a regredir (docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * O `.maybeSingle()` PRESERVA a diferença — `null` = este processo não existe, `undefined`
 * = loading ou erro — e o `if (!data)` a descartava. O hook roda de verdade; só o
 * `supabase` e o `useAuth` são mockados.
 */

const PROCESSO_ID = 'processo-1';

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: null, error: null });
  const chain: Record<string, unknown> = {
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'maybeSingle', 'single']) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => encadear(tabela) },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'master-1' }, isMaster: true, isStaff: true }),
}));

import AdminStandardProcessDetail from '../AdminStandardProcessDetail';

const PROCESSO = {
  id: PROCESSO_ID,
  name: 'Acabamento poliuretano fosco',
  slug: 'acabamento-pu-fosco',
  description: null,
  segmento: 'moveleiro',
  porte_alvo: [],
  tags: [],
  etapas: [],
  expected_outcomes: [],
  target_audience: null,
  prerequisites: [],
  status: 'draft',
  status_notes: null,
  version: 1,
  parent_id: null,
  created_by: 'master-1',
  reviewed_by: null,
  reviewed_at: null,
  created_at: '2026-09-01T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z',
};

const NAO_ENCONTRADO = /Processo não encontrado/i;

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/admin/processos/${PROCESSO_ID}`]}>
        <Routes>
          <Route path="/admin/processos/:id" element={<AdminStandardProcessDetail />} />
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

describe('AdminStandardProcessDetail — "não encontrado" volta a significar não encontrado', () => {
  it('o processo EXISTE → a tela mostra o processo, sem aviso', async () => {
    respostas.standard_processes = { data: PROCESSO, error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(/Acabamento poliuretano fosco/)).toBeInTheDocument());
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('o processo NÃO EXISTE (maybeSingle devolveu null) → "não encontrado", sem aviso', async () => {
    respostas.standard_processes = { data: null, error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADO)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso, e NUNCA "Processo não encontrado."', async () => {
    respostas.standard_processes = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA o não-achado', async () => {
    respostas.standard_processes = { data: PROCESSO, error: null };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });
});
