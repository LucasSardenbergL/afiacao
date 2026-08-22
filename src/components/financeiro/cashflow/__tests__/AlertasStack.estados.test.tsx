import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — a pilha de alertas de FLUXO DE CAIXA não pode sumir em silêncio.
 *
 * A guarda era `if (isLoading || !data || data.length === 0) return null`. Como o hook
 * lança quando o SELECT de `fin_alertas` falha, `data` fica `undefined` no erro — a MESMA
 * condição do zero. Numa tela de fluxo de caixa, "nenhum alerta" é uma AFIRMAÇÃO sobre o
 * caixa (docs/historico/fase-sem-sinal.md).
 *
 * Medido em prod (2026-08-22, psql-ro): `fin_alertas` tem 14 alertas vivos nas 3 empresas,
 * 2 deles CRÍTICOS. Uma falha de leitura apagava os 14 sem dizer nada.
 *
 * O HOOK roda de verdade; só o supabase é mockado — o defeito mora na tradução
 * "SELECT falhou" → "data undefined" → "tela idêntica à de caixa sem alerta".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const q = {
        select: () => q, eq: () => q, is: () => q,
        order: () => Promise.resolve(resposta),
      };
      return q;
    },
  },
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: 'colacor' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AlertasStack } from '../AlertasStack';
import type { Alerta } from '@/hooks/useCashflowAlertas';

// Fixture COLADA no tipo `Alerta` de useCashflowAlertas — o campo de texto é `mensagem`.
// (A 1ª versão inventou `titulo`/`detalhe`: o mock devolve `unknown`, então o TS não
// reclama e o teste falha só em runtime. Foi o CI que pegou.)
const alerta = (over: Record<string, unknown> = {}): Alerta => ({
  id: 'a1', company: 'colacor', tipo: 'saldo', severidade: 'critico',
  mensagem: 'Caixa projetado negativo em 12 dias',
  valor: -1234.5, threshold: 0, contexto: null,
  criado_em: '2026-08-20T10:00:00Z', dismissed_at: null, dismissed_until: null,
  acknowledged_at: null, resolvido_em: null, ...over,
});

function renderStack() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <AlertasStack />
    </QueryClientProvider>,
  );
}

const AVISO = /não quer dizer que está tudo certo/i;

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('AlertasStack — "sem alertas" tem de ser um FATO, não uma falha de leitura', () => {
  it('zero alertas: silêncio (o único silêncio legítimo)', async () => {
    resposta = { data: [], error: null };
    const { container } = renderStack();
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('com alertas: renderiza a pilha', async () => {
    resposta = { data: [alerta()], error: null };
    renderStack();
    expect(await screen.findByText(/Caixa projetado negativo em 12 dias/)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'permission denied for table fin_alertas' } };
    renderStack();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE: avisa também — isLoading é FALSE, data undefined, error null', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [alerta()], error: null };
    renderStack();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('erro e zero NÃO produzem a mesma tela (o colapso, medido)', async () => {
    resposta = { data: [], error: null };
    const vazio = renderStack();
    await waitFor(() => expect(vazio.container.textContent).toBe(''));
    vazio.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderStack();
    await waitFor(() => expect(erro.container.textContent).not.toBe(''));
    expect(erro.container.textContent).not.toBe('');
  });
});
