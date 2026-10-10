import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — as DUAS leituras que a página de Ligações ignorava.
 *
 * Classe #1565→#1579→#1697→#2894→#2905→#2907 ("o hook expõe a falha e o consumidor não a lê"),
 * e esta tela tinha dois sítios no mesmo arquivo:
 *
 * 1. `useFarmerScoring` — `{ agenda, clientScores, loading }` sem o `erro`. Sob falha de leitura
 *    `agenda === []`, `loading` já é false, e o `AgendaQueueCard` renderiza o empty state de
 *    SUCESSO: um check verde com **"Nenhuma ligação pendente na agenda. Bom trabalho!"**. É o
 *    pior caso da classe — não só um zero fabricado, uma PARABENIZAÇÃO fabricada por falha de
 *    transporte, na tela cujo propósito É a fila de ligações.
 * 2. `useMyCommercialRole` — `{ data }` sem o `estado`. O próprio hook documenta que só
 *    `'pronta'` autoriza tratar `data` como fato; com a leitura falha (ou PAUSADA, offline)
 *    `commercialRole` é `null` e `=== 'hunter'` dá `false` FABRICADO. A tela então afirma "você
 *    é farmer" e mostra ao hunter um placar de 7 KPIs de retenção/penetração que a spec decidiu
 *    NÃO mostrar a ele (os cards que "vazam de farmer", decisão Codex registrada no
 *    PositivacaoHero). Persona fabricada por uma leitura que não aconteceu.
 *
 * Contrato (§7 do money-path.md): falha → retry → último dado bom + aviso de stale; sem cache
 * → "indisponível" com o motivo. Nunca zero fabricado — e nunca um "bom trabalho" fabricado.
 *
 * Os hooks rodam de VERDADE (só o supabase é dublê) — ao contrário do
 * `FarmerCalls.mixgap-fora-do-gate.test.tsx`, que mocka estes dois justamente porque mede outra
 * coisa. A cadeia leitura→scoring→fila é o que precisa ser honesto aqui.
 */

const FARMER = 'farmer-a';
const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharAgenda = false;
let falharPapel = false;
let carteiraVazia = false;
let papel: string | null = null;

const POSITIVACAO = {
  mes: '2026-08-01', total_eligible: 40, positivados: 10, compradores_mtd: 10,
  receita_mtd: 50_000, contatados_mtd: 20, recencia_critica: 3,
  novos_clientes_positivados: 2, a_positivar: [],
};

const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Marcenaria Alfa', phone: '31999990000' }];
const FAIXAS = [{ customer_user_id: 'c1', faixa: 'verde', motivo: 'saudavel', g: 0.8, margem_pct: null }];
const CARTEIRA = [{ customer_user_id: 'c1' }];
const SLA = [{
  customer_user_id: 'c1', farmer_id: FARMER, health_class: 'atencao', churn_risk: 70,
  last_contact_at: null, dias_sem_contato: 30, sla_dias: 7, vencido: true, priority_score: 9,
}];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharAgenda) return { data: null, error: ERRO_TIMEOUT };
    return { data: carteiraVazia ? [] : PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: carteiraVazia ? [] : PERFIS, error: null };
  if (table === 'carteira_assignments') return { data: carteiraVazia ? [] : CARTEIRA, error: null };
  if (table === 'v_carteira_sla') return { data: carteiraVazia ? [] : SLA, error: null };
  if (table === 'commercial_roles') {
    if (falharPapel) return { data: null, error: ERRO_TIMEOUT };
    return { data: papel == null ? null : { commercial_role: papel }, error: null };
  }
  return { data: [], error: null, count: 0 };
}

function respostaRpc(fn: string): unknown {
  if (fn === 'get_minha_positivacao') return { data: POSITIVACAO, error: null };
  if (fn === 'get_meu_mixgap') return { data: { total_com_gap: 0, lista: [] }, error: null };
  if (fn === 'get_carteira_margem_faixa') {
    if (falharAgenda) return { data: null, error: ERRO_TIMEOUT };
    return { data: carteiraVazia ? [] : FAIXAS, error: null };
  }
  return { data: null, error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: (fn: string) => {
      const r = respostaRpc(fn);
      // A leitura de faixas é PAGINADA (`fetchAllPages`) e o builder de `.rpc()` expõe
      // `.order()`/`.range()` como o de `.from()` — o dublê precisa expor também.
      const c: Record<string, unknown> = {
        order: () => c,
        range: () => c,
        then: (resolve: (v: unknown) => void) => resolve(r),
      };
      return c;
    },
  },
}));
// `user` nasce DENTRO da factory: `vi.mock` é içado, então um const de fora cairia na TDZ. E
// precisa ser o MESMO objeto entre renders — identidade nova a cada chamada já custou um teste
// que TRAVAVA em loop de render (lição do #1697).
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'farmer-a' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'farmer-a' }),
}));
vi.mock('@/hooks/useMarkMixGapFeedback', () => ({
  useMarkMixGapFeedback: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/useCallBackend', () => ({
  useCallBackend: () => ({
    backend: 'nvoip' as const, callState: 'idle', callDuration: 0, isActive: false,
    isConnecting: false, isRinging: false, isEstablished: false, isFinished: false,
    error: null, audioLink: null, makeCall: vi.fn(), endCall: vi.fn(),
    toggleMute: vi.fn(), isMuted: false, remoteStream: null,
  }),
}));
vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => ({
    callState: 'idle', transcriptionStatus: 'idle', transcriptionTurns: [],
    transcriptionError: null, spinAnalysisStatus: 'idle', spinAnalysis: null,
    spinAnalysisError: null,
  }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import FarmerCalls from '../FarmerCalls';
import { TooltipProvider } from '@/components/ui/tooltip';

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <FarmerCalls />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
};

/** O empty state de SUCESSO da fila — o "bom trabalho" que não pode nascer de falha. */
const parabenizacao = () => screen.queryByText(/Nenhuma ligação pendente/i);

beforeEach(() => {
  falharAgenda = false;
  falharPapel = false;
  carteiraVazia = false;
  papel = null;
  vi.clearAllMocks();
});

describe('FarmerCalls — a fila não parabeniza por uma leitura que falhou', () => {
  it('DETECTOR: com agenda lida, a fila mostra o cliente e não parabeniza', async () => {
    montar();

    expect(await screen.findByText('Marcenaria Alfa')).toBeTruthy();
    expect(parabenizacao()).toBeNull();
    expect(screen.queryByTestId('aviso-agenda')).toBeNull();
  });

  it('DETECTOR: carteira legitimamente VAZIA (leitura OK) parabeniza — e deve', async () => {
    // O par que mantém o seletor VIVO e separa "não há" de "não consegui": zero LIDO é zero de
    // verdade, e aí o "bom trabalho" é honesto. Sem este teste, `parabenizacao() === null` no
    // caso de erro passaria com um seletor morto (armadilha do #1585) — e um fix que nunca
    // parabenizasse também passaria.
    carteiraVazia = true;

    montar();

    expect(await screen.findByText(/Nenhuma ligação pendente/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-agenda')).toBeNull();
  });

  it('sob falha: aviso com motivo e retry, e NENHUM "bom trabalho"', async () => {
    falharAgenda = true;

    montar();

    const aviso = await screen.findByTestId('aviso-agenda');
    expect(aviso.textContent, 'o aviso não diz que a leitura falhou').toMatch(
      /não foi possível|não consegui|indispon/i,
    );
    expect(
      parabenizacao(),
      'parabenizou o vendedor por uma agenda que NÃO foi lida',
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o vendedor fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → fila aparece', async () => {
    falharAgenda = true;

    montar();
    await screen.findByTestId('aviso-agenda');

    falharAgenda = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Marcenaria Alfa')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByTestId('aviso-agenda')).toBeNull(); });
  });
});

describe('FarmerCalls — o placar não afirma a persona que não leu', () => {
  it('DETECTOR: papel lido como hunter → placar de aquisição', async () => {
    papel = 'hunter';

    montar();

    expect(await screen.findByText(/Participação de novos/i)).toBeTruthy();
    expect(screen.queryByText(/Positivação MTD/i), 'vazou KPI de farmer no placar do hunter').toBeNull();
    expect(screen.queryByTestId('aviso-papel')).toBeNull();
  });

  it('DETECTOR: papel lido como SEM papel → placar de farmer, sem aviso', async () => {
    // Zero LIDO: a leitura aconteceu e respondeu "este user não tem papel comercial". O placar
    // de farmer é o certo e o aviso NÃO pode acender (precisão > recall).
    montar();

    expect(await screen.findByText(/Positivação MTD/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-papel')).toBeNull();
  });

  it('sob falha do papel: a tela DIZ que não leu a persona', async () => {
    falharPapel = true;

    montar();

    const aviso = await screen.findByTestId('aviso-papel');
    expect(aviso.textContent).toMatch(/papel|persona/i);
    expect(aviso.textContent).toMatch(/não foi possível|não consegui|sem conexão/i);
  });
});
