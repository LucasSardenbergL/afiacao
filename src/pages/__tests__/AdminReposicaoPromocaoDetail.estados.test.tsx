import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard da campanha de PROMOÇÃO — `.single()` sobre `promocao_campanha`.
 *
 * O guard era `if (!isNew && !campanha) return "Campanha não encontrada."`. O `!isNew` só
 * protege o MODO DE CRIAÇÃO: no modo edição a frase segue mentindo quando a leitura falha
 * (achado 4 de docs/historico/o-check-verde-que-a-falha-acende.md — este é um dos dois
 * "falsos positivos" que a medição foi conferir e derrubou).
 *
 * O HOOK roda de verdade; só o `supabase` é mockado.
 */

const CAMPANHA_ID = '7';
const NAO_ENCONTRADA = /Campanha não encontrada/i;

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(tabela: string) {
  const resolver = () => Promise.resolve(respostas[tabela] ?? { data: [], error: null });
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
  useAuth: () => ({ user: { id: 'u1', email: 'lucas@colacor.com.br' }, isMaster: true, isStaff: true, loading: false }),
}));

import AdminReposicaoPromocaoDetail from '../AdminReposicaoPromocaoDetail';

const CAMPANHA = {
  id: 7,
  nome: 'Campanha Sayerlack Outubro',
  tipo_origem: 'fornecedor_impoe',
  estado: 'rascunho',
  fornecedor: 'Sayerlack',
};

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/promocao/${CAMPANHA_ID}`]}>
        <Routes>
          <Route path="/promocao/:id" element={<AdminReposicaoPromocaoDetail />} />
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

describe('AdminReposicaoPromocaoDetail — "não encontrada" só quando a campanha não existe', () => {
  it('PGRST116 (0 linhas no `.single()`) → "Campanha não encontrada.", sem aviso', async () => {
    respostas = { promocao_campanha: { data: null, error: { code: 'PGRST116', message: 'no rows' } } };
    renderizar();
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADA)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso de falha, e NUNCA "Campanha não encontrada"', async () => {
    respostas = { promocao_campanha: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
  });

  it('SEM REDE (pending+paused) → aviso de sem-rede, e NUNCA "não encontrada"', async () => {
    respostas = { promocao_campanha: { data: CAMPANHA, error: null } };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
  });

  it('a campanha EXISTE → a tela abre, sem aviso nem não-achado', async () => {
    respostas = { promocao_campanha: { data: CAMPANHA, error: null } };
    renderizar();
    await waitFor(() => expect(screen.getAllByText(/Campanha Sayerlack Outubro/).length).toBeGreaterThan(0));
    expect(screen.queryByText(NAO_ENCONTRADA)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });
});
