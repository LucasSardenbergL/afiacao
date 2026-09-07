import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard das 3 telas de FERRAMENTA — "não encontrada" não pode ser o que a falha diz.
 *
 * As três escreviam `if (!tool) return <p>Ferramenta não encontrada</p>` sobre um hook
 * `.maybeSingle()` que PRESERVA a diferença (`null` = não existe · `undefined` = loading
 * ou erro). O componente descartava o que o hook sabia — achado 3 de
 * docs/historico/o-check-verde-que-a-falha-acende.md.
 *
 * `ToolPublicHistory` é o pior texto dos três: acrescentava uma CAUSA INVENTADA ("O QR
 * code pode estar desatualizado") a um estado que pode ser queda de rede. O cliente com o
 * QR na mão joga a etiqueta fora por causa de um timeout.
 *
 * Os HOOKS rodam de verdade; só o `supabase` é mockado. Mockar `useUserToolDetail`
 * provaria apenas que a tela renderiza um estado montado por mim — e o defeito mora
 * exatamente na tradução "PostgREST falhou" → `data === undefined` → tela do não-achado.
 */

const TOOL_ID = 'ferramenta-1';

type Resposta = { data: unknown; error: unknown };
/** resposta por tabela (ou 'rpc' para a RPC pública do QR) */
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: null, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => resolver(),
    maybeSingle: () => resolver(),
    single: () => resolver(),
    then: (ok: unknown, falha: unknown) =>
      resolver().then(ok as never, falha as never),
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => encadear(tabela),
    rpc: () => Promise.resolve(respostas.rpc ?? { data: null, error: null }),
  },
}));

import ToolHistory from '../ToolHistory';
import ToolReports from '../ToolReports';
import ToolPublicHistory from '../ToolPublicHistory';

const FERRAMENTA = {
  id: TOOL_ID,
  tool_category_id: 'cat-1',
  custom_name: 'Serra 300mm',
  generated_name: null,
  internal_code: 'FER-001',
  quantity: 1,
  specifications: null,
  sharpening_interval_days: 90,
  last_sharpened_at: null,
  next_sharpening_due: null,
  created_at: '2026-01-01T00:00:00Z',
  tool_categories: { id: 'cat-1', name: 'Serra', description: null, icon: null, suggested_interval_days: 90 },
};

function renderizar(Tela: React.ComponentType) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/x/${TOOL_ID}`]}>
        <Routes>
          <Route path="/x/:toolId" element={<Tela />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** o que cada tela lê, e onde o "não existe" mora na resposta de sucesso */
const TELAS = [
  {
    nome: 'ToolHistory',
    Tela: ToolHistory,
    achou: { user_tools: { data: FERRAMENTA, error: null }, tool_events: { data: [], error: null } },
    vazio: { user_tools: { data: null, error: null }, tool_events: { data: [], error: null } },
    falhou: { user_tools: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }, tool_events: { data: [], error: null } },
  },
  {
    nome: 'ToolReports',
    Tela: ToolReports,
    achou: { user_tools: { data: FERRAMENTA, error: null }, tool_events: { data: [], error: null }, order_price_history: { data: [], error: null } },
    vazio: { user_tools: { data: null, error: null }, tool_events: { data: [], error: null }, order_price_history: { data: [], error: null } },
    falhou: { user_tools: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }, tool_events: { data: [], error: null }, order_price_history: { data: [], error: null } },
  },
  {
    nome: 'ToolPublicHistory',
    Tela: ToolPublicHistory,
    achou: { rpc: { data: { tool: FERRAMENTA, events: [] }, error: null } },
    vazio: { rpc: { data: { tool: null, events: [] }, error: null } },
    falhou: { rpc: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } },
  },
] as const;

beforeEach(() => {
  respostas = {};
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe.each(TELAS)('$nome — os três estados têm cara própria', ({ Tela, achou, vazio, falhou }) => {
  it('a ferramenta EXISTE → a tela mostra a ferramenta, sem aviso', async () => {
    respostas = { ...achou };
    renderizar(Tela);
    await waitFor(() => expect(screen.getAllByText(/Serra/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/não encontrada/i)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a ferramenta NÃO EXISTE (maybeSingle devolveu null) → "não encontrada", sem aviso', async () => {
    respostas = { ...vazio };
    renderizar(Tela);
    await waitFor(() => expect(screen.getByText(/não encontrada/i)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso de falha, e NUNCA "não encontrada"', async () => {
    respostas = { ...falhou };
    renderizar(Tela);
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(/não encontrada/i)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA "não encontrada"', async () => {
    // `networkMode:'online'` sem rede deixa a query em pending+paused: `isLoading` é FALSE
    // e `data` é `undefined`. Quem ramifica só por `isLoading`/`error` cai no não-achado.
    respostas = { ...achou };
    onlineManager.setOnline(false);
    renderizar(Tela);
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(/não encontrada/i)).toBeNull();
  });
});

describe('ToolPublicHistory — a causa INVENTADA só pode aparecer quando é verdade', () => {
  const QR_DESATUALIZADO = /QR code pode estar desatualizado/i;

  it('não existe → a hipótese do QR é legítima', async () => {
    respostas = { rpc: { data: { tool: null, events: [] }, error: null } };
    renderizar(ToolPublicHistory);
    await waitFor(() => expect(screen.getByText(QR_DESATUALIZADO)).toBeInTheDocument());
  });

  it('a leitura falhou → a tela NÃO manda jogar a etiqueta fora', async () => {
    respostas = { rpc: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } };
    renderizar(ToolPublicHistory);
    await screen.findByTestId('aviso-leitura-falhou');
    expect(screen.queryByText(QR_DESATUALIZADO)).toBeNull();
  });
});
