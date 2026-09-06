import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" no placar MTD do closer.
 *
 * `if (isLoading || !k || k.totalVisitas === 0) return null` é a linha do defeito
 * ORIGINAL da classe (docs/historico/fase-sem-sinal.md): como `useKpisVisitaMtd` LANÇA
 * quando o SELECT em `route_visits` falha, `data` fica `undefined` no erro, no offline e
 * na 1ª carga — e o placar sumia do dashboard exatamente como se o vendedor não tivesse
 * registrado visita nenhuma no mês.
 *
 * O HOOK roda de verdade; só o supabase e os contextos são mockados — o defeito mora na
 * tradução "SELECT falhou" → "data undefined" → "tela idêntica à do mês sem visita".
 */
const UID = 'vendedor-1';
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'not', 'order', 'limit']) b[m] = () => b;
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: UID }),
}));

import { ClosersMtdHero } from '../ClosersMtdHero';

const visita = (over: Record<string, unknown> = {}) => ({ result: 'pedido_fechado', revenue_generated: 1500, ...over });
const AVISO = /não quer dizer que está tudo certo/i;
const PLACAR = /Visitas registradas/i;

let qc: QueryClient;
function renderHero() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><ClosersMtdHero /></QueryClientProvider>);
}

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('ClosersMtdHero — erro NÃO pode virar "mês sem visita"', () => {
  it('com visitas: o placar do mês', async () => {
    resposta = { data: [visita()], error: null };
    renderHero();
    expect(await screen.findByText(PLACAR)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('mês SEM visita: silêncio — o único silêncio legítimo', async () => {
    resposta = { data: [], error: null };
    const { container } = renderHero();
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'permission denied for table route_visits' } };
    renderHero();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [visita()], error: null };
    renderHero();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('refetch falha COM o placar no cache: os números FICAM e o aviso vem JUNTO', async () => {
    resposta = { data: [visita()], error: null };
    renderHero();
    expect(await screen.findByText(PLACAR)).toBeTruthy();

    resposta = { data: null, error: { message: 'connection failure' } };
    await qc.refetchQueries();

    await waitFor(() => expect(screen.queryByText(AVISO)).toBeTruthy());
    expect(
      screen.queryByText(PLACAR),
      'o placar sumiu quando o refetch falhou — o erro não pode ter precedência sobre o dado em mãos',
    ).toBeTruthy();
  });

  it('erro e mês-vazio NÃO produzem a mesma tela (o colapso, medido)', async () => {
    resposta = { data: [], error: null };
    const vazio = renderHero();
    await waitFor(() => expect(vazio.container.textContent).toBe(''));
    vazio.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderHero();
    await waitFor(() => expect(erro.container.textContent).not.toBe(''));
  });
});
