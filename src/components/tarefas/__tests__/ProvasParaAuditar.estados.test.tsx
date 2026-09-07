import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard do painel de AUDITORIA — "Nenhuma prova aguardando auditoria" é uma AFIRMAÇÃO DE
 * CONTROLE, e não pode ser o que a falha de leitura diz.
 *
 * `v_tarefas_estado` (requer_auditoria) tem 0 linhas hoje: é exatamente por isso que o fix
 * é barato agora — não há comportamento observável a regredir, e quando a fila encher o
 * defeito já não existe (docs/historico/o-check-verde-que-a-falha-acende.md, item 4).
 *
 * O colapso aqui NÃO era `!data || data.length === 0`: era o default `= []` do binding.
 * `useProvasParaAuditar` faz `if (error) throw error`, então no erro `data` é `undefined`
 * e o default o converte em `[]` — a lista vazia e a leitura falha viram a MESMA tela.
 *
 * O hook roda de verdade; só `supabase` e o `useAuth` são mockados. Mockar
 * `useProvasParaAuditar` provaria apenas que a tela renderiza um estado montado por mim —
 * e o defeito mora na tradução "PostgREST falhou" → `data === undefined` → `[]`.
 */

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: [], error: null });
  // Todo método devolve a própria chain, e a chain é THENABLE: assim o `await` funciona em
  // qualquer ponto da cadeia, sem eu precisar saber qual terminador cada hook usa.
  const chain: Record<string, unknown> = {
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'maybeSingle', 'single']) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => encadear(tabela),
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: null }) }) },
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'gestor-1' }, isMaster: true, isStaff: true }),
}));

import { ProvasParaAuditar } from '../ProvasParaAuditar';

const PROVA = {
  id: 'prova-1',
  descricao: 'Conferir estoque do balcão',
  assigned_to: 'vendedora-1',
  comprovacao_em: '2026-09-01T12:00:00Z',
  comprovacao_url: null,
  comprovacao_leitura: 42,
  leitura_unidade: 'un',
  leitura_min: null,
  leitura_max: null,
  requer_auditoria: true,
};

const VAZIO = 'Nenhuma prova aguardando auditoria';

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ProvasParaAuditar />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  respostas = { commercial_roles: { data: [], error: null } };
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('ProvasParaAuditar — a fila vazia e a leitura falha têm cara própria', () => {
  it('HÁ provas → a tela lista a fila, sem aviso', async () => {
    respostas.v_tarefas_estado = { data: [PROVA], error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(/1 prova aguardando/)).toBeInTheDocument());
    expect(screen.queryByText(VAZIO)).toBeNull();
    expect(screen.queryByTestId('aviso-provas-auditar')).toBeNull();
  });

  it('a fila está VAZIA de verdade → o empty state legítimo, sem aviso', async () => {
    respostas.v_tarefas_estado = { data: [], error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(VAZIO)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-provas-auditar')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso, e NUNCA "Nenhuma prova aguardando auditoria"', async () => {
    respostas.v_tarefas_estado = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-provas-auditar');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(VAZIO)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA o empty state', async () => {
    // `networkMode:'online'` sem rede deixa a query em pending+paused: `isLoading` é FALSE,
    // `data` é `undefined` e `error` é `null`. O default `= []` transformava isso em "não há".
    respostas.v_tarefas_estado = { data: [PROVA], error: null };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-provas-auditar');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(VAZIO)).toBeNull();
  });
});
