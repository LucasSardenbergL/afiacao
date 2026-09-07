import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard do 360 do GRUPO DE CLIENTE — "Grupo não encontrado." não pode ser o que a falha diz.
 *
 * `cliente_grupos` tem 0 linhas hoje; o fix sai antes da primeira linha, quando não há
 * comportamento observável a regredir (docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * Este sítio é o da DERIVADA: o guard é `if (!grupo)` sobre `grupos?.find(g => g.id === …)`.
 * Com a leitura falha, `grupos` é `undefined`, o `?.` devolve `undefined` sem erro e a tela
 * afirma que o grupo não existe — a mesma frase que ela usaria para um id de rota inválido.
 * São coisas diferentes e agora dizem coisas diferentes.
 *
 * O hook roda de verdade; só o `supabase` é mockado.
 */

const GRUPO_ID = 'grupo-1';

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: [], error: null });
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

import GrupoCliente360 from '../GrupoCliente360';

const GRUPO = {
  id: GRUPO_ID,
  nome: 'Grupo Colacor',
  notas: null,
  ativo: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  membros: [
    { id: 'm-1', grupo_id: GRUPO_ID, documento: '12345678000199', relation_type: 'multi_ativo', created_at: '2026-01-01T00:00:00Z' },
  ],
};

const NAO_ENCONTRADO = /Grupo não encontrado/i;

function renderizar(rota = GRUPO_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/gestao/grupos-cliente/${rota}`]}>
        <Routes>
          <Route path="/gestao/grupos-cliente/:grupoId" element={<GrupoCliente360 />} />
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

describe('GrupoCliente360 — "não encontrado" volta a significar não encontrado', () => {
  it('o grupo EXISTE → a tela mostra o grupo, sem aviso', async () => {
    respostas.cliente_grupos = { data: [GRUPO], error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText('Grupo Colacor')).toBeInTheDocument());
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a leitura foi OK e o id não está na lista → "não encontrado" legítimo, sem aviso', async () => {
    respostas.cliente_grupos = { data: [GRUPO], error: null };
    renderizar('grupo-que-nao-existe');
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADO)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso, e NUNCA "Grupo não encontrado."', async () => {
    respostas.cliente_grupos = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA o não-achado', async () => {
    respostas.cliente_grupos = { data: [GRUPO], error: null };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });
});
