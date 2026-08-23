import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — a agenda do dia não pode mandar "Recalcular" quando não conseguiu ler.
 *
 * O caso mais caro da leva, porque o vazio aqui não é passivo: a tela dizia *"Sem clientes na
 * agenda. Vá em /farmer antigo e clique Recalcular"* — uma INSTRUÇÃO de ação sobre um vazio
 * que pode não existir. A agenda sai de `farmer_client_scores` filtrado por [eu, ...cobertos];
 * com a cobertura ilegível, `ownerIds` encolhe para [eu] e a lista some junto, sem sinal algum.
 *
 * Os HOOKS rodam de verdade (useMyAgendaToday → useMyCarteiraScores → useCarteirasQueEuCubro);
 * só o supabase é mockado, e por tabela — é a única forma de provar que o que muda a tela é a
 * falha da COBERTURA, e não uma falha global que qualquer mock derrubaria junto.
 */
const EU = 'vendedor-1';
type Resposta = { data: unknown; error: { message: string } | null };
let porTabela: Record<string, Resposta> = {};

function respostaDaTabela(t: string): Resposta {
  return porTabela[t] ?? { data: [], error: null };
}

vi.mock('@/integrations/supabase/client', () => {
  const mk = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'gte', 'lte']) b[m] = () => b;
    b.then = (ok: (r: Resposta) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(respostaDaTabela(tabela)).then(ok, falha);
    return b;
  };
  return { supabase: { from: (t: string) => mk(t) } };
});
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: EU }, isStaff: true, isMaster: false, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }),
}));
vi.mock('@/contexts/webrtc-call-context', () => ({
  useWebRTCCallContext: () => ({ makeCall: vi.fn() }),
}));

import { AgendaTodayList } from '../AgendaTodayList';

function renderLista() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgendaTodayList />
    </QueryClientProvider>,
  );
}

const AVISO = /não quer dizer que está tudo certo/i;
const MANDA_RECALCULAR = /Sem clientes na agenda/i;

beforeEach(() => { porTabela = {}; onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('AgendaTodayList — cobertura ilegível não pode virar "clique em Recalcular"', () => {
  it('VAZIO legítimo: a instrução de recalcular é honesta aqui', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [], error: null },
    };
    renderLista();
    expect(await screen.findByText(MANDA_RECALCULAR)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO na cobertura: avisa E NÃO manda recalcular — o defeito da classe', async () => {
    porTabela = {
      carteira_coverage: { data: null, error: { message: 'permission denied' } },
      farmer_client_scores: { data: [], error: null },
    };
    renderLista();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    // A asserção que carrega o peso: mandar agir sobre um vazio não-lido é pior que sumir.
    expect(screen.queryByText(MANDA_RECALCULAR)).toBeNull();
  });

  it('OFFLINE: idem — pending+paused não é agenda vazia', async () => {
    onlineManager.setOnline(false);
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [], error: null },
    };
    renderLista();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(MANDA_RECALCULAR)).toBeNull());
  });
});
