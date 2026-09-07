import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" — variante do IRMÃO (ausente degradado para
 * vazio). O card fazia `agruparVisitasPorResultado(data ?? [])` + `if (resumo.total === 0)
 * return null`: como `useMinhasVisitasResultado` LANÇA quando o SELECT falha, o `?? []`
 * transformava a ausência em zero e o zero apagava o card — a falha de leitura chegava ao
 * vendedor como "nenhuma visita nos últimos 90 dias".
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

import { MinhasVisitasResultadoCard } from '../MinhasVisitasResultadoCard';

const visita = (over: Record<string, unknown> = {}) => ({ result: 'pedido_fechado', revenue_generated: 900, ...over });
const AVISO = /não quer dizer que está tudo certo/i;
const CARD = /Resultado das suas visitas/i;

let qc: QueryClient;
function renderCard() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><MinhasVisitasResultadoCard /></QueryClientProvider>);
}

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('MinhasVisitasResultadoCard — erro NÃO pode virar "nenhuma visita"', () => {
  it('com visitas: o breakdown', async () => {
    resposta = { data: [visita()], error: null };
    renderCard();
    expect(await screen.findByText(CARD)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('janela SEM visita: silêncio — o único silêncio legítimo', async () => {
    resposta = { data: [], error: null };
    const { container } = renderCard();
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'permission denied for table route_visits' } };
    renderCard();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [visita()], error: null };
    renderCard();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('refetch falha COM o breakdown no cache: o card FICA e o aviso vem JUNTO', async () => {
    resposta = { data: [visita()], error: null };
    renderCard();
    expect(await screen.findByText(CARD)).toBeTruthy();

    resposta = { data: null, error: { message: 'connection failure' } };
    await qc.refetchQueries();

    await waitFor(() => expect(screen.queryByText(AVISO)).toBeTruthy());
    expect(
      screen.queryByText(CARD),
      'o card sumiu quando o refetch falhou — o erro não pode ter precedência sobre o dado em mãos',
    ).toBeTruthy();
  });
});
