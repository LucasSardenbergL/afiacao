import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard da aba "Dados faltantes" — o sítio de dano MÁXIMO da classe "erro colapsado em vazio".
 *
 * O componente escrevia `if (!data || data.length === 0)` e devolvia um ✓ VERDE com a frase
 * "Todas as fichas aprovadas estão completas nos dados importantes". `useCompletude` faz
 * `if (error) throw error`, então na falha `data` é `undefined` — a MESMA condição do vazio.
 * Medido em prod (2026-09-06): 119 fichas aprovadas, 116 com campo faltando. O estado normal
 * desta tela são 116 pendências de trabalho, e a queda de leitura as trocava por um check de
 * sucesso para as 3 pessoas que a enxergam
 * (docs/historico/o-check-verde-que-a-falha-acende.md, achado 1).
 *
 * O HOOK roda de verdade; só o `supabase` é mockado. Mockar o hook provaria apenas um estado
 * montado à mão — e o defeito mora justamente na tradução "PostgREST falhou" → `data`
 * `undefined` → tela do ✓ verde.
 */

const VERDE = /Todas as fichas aprovadas estão completas/i;

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(tabela: string) {
  const resolver = () => Promise.resolve(respostas[tabela] ?? { data: [], error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    is: () => chain,
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

import { CompletudeSection } from '../CompletudeSection';

/** Nenhum campo importante preenchido → 10 faltantes → aparece na lista. */
const INCOMPLETA = {
  product_code: 'SL-777',
  product_name: 'Verniz PU Sayerlack XPTO',
  document_id: 'doc-1',
  approved_at: '2026-01-01T00:00:00Z',
};

/** Todos os `CAMPOS_IMPORTANTES` preenchidos → 0 faltantes → o filtro do hook a remove. */
const COMPLETA = {
  ...INCOMPLETA,
  product_code: 'SL-888',
  product_name: 'Fundo PU Sayerlack Completo',
  rendimento_m2_por_litro: 10,
  catalisador_codigo: 'CAT-1',
  catalisador_proporcao_pct: 20,
  demaos_recomendadas: 2,
  validade_dias: 365,
  pot_life_horas: 4,
  diluente_codigo: 'DIL-1',
  substrato: 'madeira',
  solidos_pct: 35,
  dureza: 'alta',
  extraction_gaps: [],
};

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CompletudeSection />
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

describe('CompletudeSection — o ✓ verde só aparece quando a leitura ACONTECEU', () => {
  it('há pendências → a lista, sem ✓ verde nem aviso', async () => {
    respostas = { kb_product_specs: { data: [INCOMPLETA], error: null } };
    renderizar();
    await waitFor(() =>
      expect(screen.getByText(/Verniz PU Sayerlack XPTO/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(VERDE)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('ZERO pendências (leitura OK) → o ✓ verde é VERDADE, e fica', async () => {
    respostas = { kb_product_specs: { data: [COMPLETA], error: null } };
    renderizar();
    await waitFor(() => expect(screen.getByText(VERDE)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso de erro, e NUNCA o ✓ verde', async () => {
    respostas = {
      kb_product_specs: { data: null, error: { code: '42501', message: 'permission denied' } },
    };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(VERDE)).toBeNull();
  });

  // O 4º estado: `pending` + `paused`, com `isLoading` FALSE, `data` `undefined` e `error`
  // `null`. Passa reto por qualquer guard de `isLoading`/`error` — é o que obriga o ramo da
  // falha a vir ANTES do loading.
  it('SEM REDE (pending+paused) → aviso de sem-rede, e NUNCA o ✓ verde', async () => {
    respostas = { kb_product_specs: { data: [INCOMPLETA], error: null } };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(VERDE)).toBeNull();
  });
});
