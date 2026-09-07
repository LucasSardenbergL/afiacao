import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" no resumo 360 do cliente — variante do IRMÃO
 * (ausente degradado para vazio): `aggregateCustomerProfile(data ?? [])` + `if
 * (profile.totalCalls === 0) return null`, com `useCustomerCalls` LANÇANDO quando o SELECT
 * falha. Numa ficha de cliente a ausência é cara por AFIRMAÇÃO: quem abre o 360 e não vê o
 * resumo conclui que nunca se falou com aquele cliente — e decide a abordagem por aí.
 */
const CLIENTE = 'cliente-1';
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'gte']) b[m] = () => b;
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

import { CustomerProfile360Summary } from '../CustomerProfile360Summary';

const chamada = (over: Record<string, unknown> = {}) => ({
  id: 'c1', farmer_id: 'f1', customer_user_id: CLIENTE, phone_dialed: '11999',
  call_backend: 'webrtc', started_at: new Date().toISOString(), ended_at: null,
  duration_seconds: 120, call_result: 'atendida', call_type: 'ativa',
  revenue_generated: 500, margin_generated: 100, notes: null,
  transcript: [{ t: 'oi' }], analyses: null, entities_extracted: null, ...over,
});
const AVISO = /não quer dizer que está tudo certo/i;
const RESUMO = /Chamadas/i;

let qc: QueryClient;
function renderResumo() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><CustomerProfile360Summary customerId={CLIENTE} /></QueryClientProvider>);
}

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('CustomerProfile360Summary — erro NÃO pode virar "nunca falamos"', () => {
  it('com chamadas: o resumo', async () => {
    resposta = { data: [chamada()], error: null };
    renderResumo();
    expect(await screen.findByText(RESUMO)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('cliente SEM chamada: silêncio — o único silêncio legítimo', async () => {
    resposta = { data: [], error: null };
    const { container } = renderResumo();
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'permission denied for table farmer_calls' } };
    renderResumo();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [chamada()], error: null };
    renderResumo();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('refetch falha COM o resumo no cache: o resumo FICA e o aviso vem JUNTO', async () => {
    resposta = { data: [chamada()], error: null };
    renderResumo();
    expect(await screen.findByText(RESUMO)).toBeTruthy();

    resposta = { data: null, error: { message: 'connection failure' } };
    await qc.refetchQueries();

    await waitFor(() => expect(screen.queryByText(AVISO)).toBeTruthy());
    expect(
      screen.queryByText(RESUMO),
      'o resumo sumiu quando o refetch falhou — o erro não pode ter precedência sobre o dado em mãos',
    ).toBeTruthy();
  });
});
