import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard das duas abas de histórico do cliente (chamadas · visitas) — "nunca aconteceu" não
 * pode ser o que a falha de leitura diz.
 *
 * `farmer_calls` e `route_visits` (para este recorte) têm 0 linhas hoje: é por isso que o
 * fix é barato agora — não há comportamento observável a regredir, e quando as tabelas
 * encherem o defeito já não existe (docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * As duas escreviam `if (!data || data.length === 0)` — o colapso digitado À MÃO, com `||`:
 * ambos os hooks lançam no erro (`throw error` / `throw new Error`), então `data` é
 * `undefined` na falha e `[]` no vazio de verdade, e o `||` juntava os dois.
 *
 * Os HOOKS rodam de verdade; só o `supabase` é mockado — o defeito mora na tradução
 * "PostgREST falhou" → `data === undefined` → tela do "não há".
 */

const CLIENTE = 'cliente-1';

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: [], error: null });
  // Todo método devolve a própria chain, e a chain é THENABLE: o `await` funciona em
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
  supabase: { from: (tabela: string) => encadear(tabela) },
}));

import { CustomerCallsTab } from '../CustomerCallsTab';
import { CustomerVisitsTab } from '../CustomerVisitsTab';

const CHAMADA = {
  id: 'call-1', farmer_id: 'f-1', customer_user_id: CLIENTE, phone_dialed: '11999990000',
  call_backend: 'webrtc', started_at: '2026-09-01T12:00:00Z', ended_at: '2026-09-01T12:09:00Z',
  duration_seconds: 540, call_result: 'pedido_fechado', call_type: 'ativa',
  revenue_generated: 1200, margin_generated: 300, notes: null,
  transcript: [{ role: 'user', text: 'oi' }], analyses: null, entities_extracted: null,
};

const VISITA = {
  id: 'visit-1', visited_by: 'vend-1', visit_date: '2026-09-01', check_in_at: '2026-09-01T10:00:00Z',
  check_out_at: '2026-09-01T10:40:00Z', result: 'pedido_fechado', notes: 'Levou catálogo novo.',
  revenue_generated: 980, order_created: true,
};

function renderizar(Tela: React.ComponentType<{ customerId: string }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <Tela customerId={CLIENTE} />
    </QueryClientProvider>,
  );
}

/** o que cada aba lê, o texto do "não há" e a âncora do seu próprio aviso */
const ABAS = [
  {
    nome: 'CustomerCallsTab',
    Tela: CustomerCallsTab,
    tabela: 'farmer_calls',
    linha: CHAMADA,
    vazioRe: /Nenhuma chamada com transcript ainda/i,
    // CallSessionRow renderiza `{durationMin}min · {backend} · {call_result}` num só div.
    comDadoRe: /pedido_fechado/,
    testId: 'aviso-chamadas',
  },
  {
    nome: 'CustomerVisitsTab',
    Tela: CustomerVisitsTab,
    tabela: 'route_visits',
    linha: VISITA,
    vazioRe: /Nenhuma visita registrada/i,
    comDadoRe: /Levou catálogo novo/i,
    testId: 'aviso-visitas',
  },
] as const;

beforeEach(() => {
  respostas = { profiles: { data: [{ user_id: 'vend-1', name: 'Ana' }], error: null } };
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe.each(ABAS)('$nome — o vazio e a falha têm cara própria', ({ Tela, tabela, linha, vazioRe, comDadoRe, testId }) => {
  it('HÁ registros → a aba lista, sem aviso', async () => {
    respostas[tabela] = { data: [linha], error: null };
    renderizar(Tela);
    await waitFor(() => expect(screen.getByText(comDadoRe)).toBeInTheDocument());
    expect(screen.queryByText(vazioRe)).toBeNull();
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  it('VAZIO de verdade → o empty state legítimo, sem aviso', async () => {
    respostas[tabela] = { data: [], error: null };
    renderizar(Tela);
    await waitFor(() => expect(screen.getByText(vazioRe)).toBeInTheDocument());
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  it('a LEITURA FALHOU → aviso, e NUNCA o empty state', async () => {
    respostas[tabela] = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    renderizar(Tela);
    const aviso = await screen.findByTestId(testId);
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(vazioRe)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA o empty state', async () => {
    // Sem rede a query fica pending+paused: `isLoading` é FALSE, `data` é `undefined` e
    // `error` é `null`. O `!data ||` mandava esse estado direto para o "não há".
    respostas[tabela] = { data: [linha], error: null };
    onlineManager.setOnline(false);
    renderizar(Tela);
    const aviso = await screen.findByTestId(testId);
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(vazioRe)).toBeNull();
  });
});
