import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — a agenda do dia não pode mandar "Recalcular" quando não leu os SCORES.
 *
 * O irmão do guard de cobertura (AgendaTodayList.cobertura.test.tsx), na dimensão que ficou
 * de fora do #1908: `useMyCarteiraScores` LANÇA quando o SELECT em `farmer_client_scores`
 * falha, então `data` fica `undefined` — a MESMA condição de "a carteira não tem cliente
 * nenhum". O `data ? … : []` do hook colapsava as duas, e a tela mandava *"Sem clientes na
 * agenda. Vá em /farmer antigo e clique Recalcular"*: uma INSTRUÇÃO de ação sobre um vazio
 * que pode não existir. Em prod a tabela tem 6.633 linhas nos 3 vendedores (psql-ro,
 * 2026-08-23), então esse vazio é FALSO em todos os casos vivos hoje.
 *
 * Os HOOKS rodam de verdade (useMyAgendaToday → useMyCarteiraScores); só o supabase é
 * mockado, e POR TABELA — mockar o hook provaria apenas que o componente renderiza um estado
 * montado à mão. É a mockagem por tabela que separa a falha dos SCORES da falha da COBERTURA:
 * aqui `carteira_coverage` responde OK em todos os casos, menos no offline (que é global).
 */
const EU = 'vendedor-1';
const CLIENTE = 'cliente-1';
type Resposta = { data: unknown; error: { message: string } | null };
let porTabela: Record<string, Resposta> = {};

function respostaDaTabela(t: string): Resposta {
  return porTabela[t] ?? { data: [], error: null };
}

const LINHA_SCORE = {
  customer_user_id: CLIENTE,
  farmer_id: EU,
  health_score: 42,
  health_class: 'atencao',
  priority_score: 88,
  churn_risk: 70,
  expansion_score: null,
  recover_score: null,
  revenue_potential: null,
  days_since_last_purchase: 30,
  avg_monthly_spend_180d: 1000,
  signal_modifiers: null,
  sales_history_status: 'com_historico',
  last_signal_recalc_at: null,
};
const PERFIL = { user_id: CLIENTE, name: 'Cliente Um', razao_social: null, phone: '+5511999998888' };

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
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgendaTodayList />
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

const MANDA_RECALCULAR = /Sem clientes na agenda/i;
/** O <AvisoLeituraFalhou> tem role="status"; o texto quebra em vários nós, então lemos o textContent. */
async function textoDoAviso(): Promise<string> {
  return (await screen.findByRole('status')).textContent ?? '';
}

beforeEach(() => { porTabela = {}; onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('AgendaTodayList — scores ilegíveis não podem virar "clique em Recalcular"', () => {
  it('VAZIO legítimo: a leitura ACONTECEU e disse vazio — a instrução é honesta aqui', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [], error: null },
    };
    renderLista();
    expect(await screen.findByText(MANDA_RECALCULAR)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ERRO nos scores: avisa E NÃO manda recalcular — o defeito da classe', async () => {
    porTabela = {
      // A cobertura responde OK: se a tela falasse por causa DELA, este caso seria verde
      // por acidente. O que muda a tela aqui é só a falha de `farmer_client_scores`.
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: null, error: { message: 'permission denied' } },
    };
    renderLista();
    expect(await textoDoAviso()).toMatch(/não foi possível carregar a sua agenda do dia/i);
    // A asserção que carrega o peso: mandar agir sobre um vazio não-lido é pior que sumir.
    expect(screen.queryByText(MANDA_RECALCULAR)).toBeNull();
  });

  it('OFFLINE: pending+paused não é agenda vazia (e `isLoading` ali é FALSE)', async () => {
    onlineManager.setOnline(false);
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [LINHA_SCORE], error: null },
    };
    renderLista();
    expect(await textoDoAviso()).toMatch(/sem conexão/i);
    await waitFor(() => expect(screen.queryByText(MANDA_RECALCULAR)).toBeNull());
  });

  it('CAMINHO FELIZ: com linha lida, a agenda renderiza e ninguém avisa nada', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [LINHA_SCORE], error: null },
      profiles: { data: [PERFIL], error: null },
    };
    renderLista();
    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.queryByText(MANDA_RECALCULAR)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('RELEITURA falha COM lista em mãos: mostra os DOIS — apagar seria trocar de defeito', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      farmer_client_scores: { data: [LINHA_SCORE], error: null },
      profiles: { data: [PERFIL], error: null },
    };
    const { qc } = renderLista();
    expect(await screen.findByText('Cliente Um')).toBeTruthy();

    porTabela.farmer_client_scores = { data: null, error: { message: 'timeout' } };
    await qc.invalidateQueries({ queryKey: ['my-carteira-scores'] });

    await waitFor(async () => expect(await textoDoAviso()).toMatch(/a sua agenda do dia/i));
    // O cache continua na tela: o vendedor em campo não pode perder o que já tinha.
    expect(screen.getByText('Cliente Um')).toBeTruthy();
  });
});
