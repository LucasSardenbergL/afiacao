import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — a correção dos três estados do MixGap tem de EXISTIR na tela.
 *
 * O #1859 separou `com_gap`/`zero`/`erro` dentro do `MixGapCard` e pôs um
 * `carteira.mixgap_visto` em cada um. Mas o card tem UM ÚNICO ponto de montagem no app, e
 * ele estava atrás do gate de OUTRA leitura:
 *
 *     const { data: positivacao } = useMyPositivacao();   // `error` nem era desestruturado
 *     {positivacao && (<><PositivacaoHero …/><ClientesAPositivarCard …/><MixGapCard /></>)}
 *
 * `get_minha_positivacao` e `get_meu_mixgap` saem pelo MESMO PostgREST, então a falha
 * CORRELACIONADA é o caso comum, não o raro. Quando ela acontece, `positivacao` fica
 * `undefined`, o bloco não monta, o `MixGapCard` nem chega a existir — nenhuma tela, nenhum
 * evento. A correção ficava inacessível exatamente na situação que a motivou.
 *
 * Os 6 testes de `MixGapCard.estados.test.tsx` montam o card DIRETO: são verdes num contexto
 * que não existe em produção. Por isso este teste monta o HOST REAL (`FarmerCalls`) e só
 * mocka a borda — o defeito mora na COMPOSIÇÃO, e nenhum teste de componente isolado o vê.
 *
 * Os hooks rodam de verdade (só o supabase é dublê): a cadeia "RPC falha → hook lança →
 * `data` undefined → gate fecha" é justamente o que precisa ser provado.
 */

const FARMER = 'farmer-a';
const ERRO_TIMEOUT = { message: 'canceling statement due to statement timeout' };

type Resposta = { data: unknown; error: { message: string } | null };

const POSITIVACAO = {
  mes: '2026-08-01',
  total_eligible: 40,
  positivados: 10,
  compradores_mtd: 10,
  receita_mtd: 50_000,
  contatados_mtd: 20,
  recencia_critica: 3,
  novos_clientes_positivados: 2,
  a_positivar: [
    {
      customer_user_id: 'c9', nome: 'Marcenaria Ômega', revenue_potential: 1000,
      churn_risk: 70, recover_score: 0.5, days_since_last_purchase: 45, priority_score: 9,
    },
  ],
};

const MIXGAP = {
  total_com_gap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'Marcenaria Alfa', familia_faltante: 'VERNIZ', confidence: 0.4, lift: 3.1, evidence_count: 2 },
    { customer_user_id: 'c2', nome: 'Marcenaria Beta', familia_faltante: 'SELADOR', confidence: 0.3, lift: 2.2, evidence_count: 1 },
  ],
};

let respostaPositivacao: Resposta = { data: POSITIVACAO, error: null };
let respostaMixGap: Resposta = { data: MIXGAP, error: null };

function respostaRpc(fn: string): Resposta {
  if (fn === 'get_minha_positivacao') return respostaPositivacao;
  if (fn === 'get_meu_mixgap') return respostaMixGap;
  return { data: null, error: null };
}

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => chain(),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: (fn: string) => {
      const r = respostaRpc(fn);
      const c: Record<string, unknown> = {
        order: () => c,
        range: () => c,
        then: (resolve: (v: unknown) => void) => resolve(r),
      };
      return c;
    },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER }, isStaff: true, isMaster: false, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/hooks/useFarmerScoring', () => ({
  useFarmerScoring: () => ({ agenda: [], clientScores: {}, loading: false }),
}));
vi.mock('@/hooks/useMyCommercialRole', () => ({
  useMyCommercialRole: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/useMarkMixGapFeedback', () => ({
  useMarkMixGapFeedback: () => ({ mutate: vi.fn() }),
}));

const backendIdle = {
  backend: 'nvoip' as const,
  callState: 'idle',
  callDuration: 0,
  isActive: false,
  isConnecting: false,
  isRinging: false,
  isEstablished: false,
  isFinished: false,
  error: null,
  audioLink: null,
  makeCall: vi.fn(),
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  isMuted: false,
  remoteStream: null,
};
vi.mock('@/hooks/useCallBackend', () => ({ useCallBackend: () => backendIdle }));
vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => ({
    callState: 'idle',
    transcriptionStatus: 'idle',
    transcriptionTurns: [],
    transcriptionError: null,
    spinAnalysisStatus: 'idle',
    spinAnalysis: null,
    spinAnalysisError: null,
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => track(...a),
  captureException: vi.fn(),
}));

import FarmerCalls from '../FarmerCalls';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <FarmerCalls />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Último payload de um evento, ou undefined se ele nunca saiu. */
function evento(nome: string): Record<string, unknown> | undefined {
  const c = [...track.mock.calls].reverse().find((c) => c[0] === nome);
  return c?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  respostaPositivacao = { data: POSITIVACAO, error: null };
  respostaMixGap = { data: MIXGAP, error: null };
  track.mockClear();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('FarmerCalls — o MixGap não depende da leitura da positivação', () => {
  it('DETECTOR: com as duas leituras OK, hero e MixGap montam e os dois eventos saem', async () => {
    // Sem este caso, "não achei o card" e "a página nem montou" seriam indistinguíveis —
    // o teste passaria verde por cegueira, que é exatamente como o defeito nasceu.
    renderPagina();

    expect(await screen.findByText('Oportunidades de cross-sell')).toBeTruthy();
    expect(screen.getByText('Positivação MTD')).toBeTruthy();
    await waitFor(() => expect(evento('carteira.mixgap_visto')).toBeTruthy());
    expect(evento('carteira.mixgap_visto')).toMatchObject({ estado: 'com_gap', total_com_gap: 2 });
    expect(evento('carteira.positivacao_vista')).toMatchObject({ estado: 'pronta', total_eligible: 40 });
  });

  it('positivação FALHA e mixgap OK: o card de cross-sell continua na tela e instrumentado', async () => {
    // A regressão que o #1859 não cobria: as duas RPCs saem pelo MESMO PostgREST, então a
    // falha correlacionada é o caso comum. Sob o gate `{positivacao && …}` o card sumia.
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    expect(
      await screen.findByText('Oportunidades de cross-sell'),
      'o MixGapCard sumiu porque a OUTRA leitura falhou — a correção do #1859 é inalcançável',
    ).toBeTruthy();
    expect(screen.getByText('Marcenaria Alfa')).toBeTruthy();
    await waitFor(() => expect(evento('carteira.mixgap_visto')).toBeTruthy());
    expect(
      evento('carteira.mixgap_visto'),
      'sem o evento a adoção do MixGap fica sem denominador justamente no dia ruim',
    ).toMatchObject({ estado: 'com_gap', total_com_gap: 2 });
  });

  it('mixgap FALHA e positivação OK: o hero continua na tela (a independência vale nos dois sentidos)', async () => {
    respostaMixGap = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    expect(await screen.findByText('Positivação MTD')).toBeTruthy();
    expect(await screen.findByText('Não consegui carregar as oportunidades')).toBeTruthy();
    await waitFor(() => expect(evento('carteira.mixgap_visto')).toBeTruthy());
    expect(evento('carteira.mixgap_visto')).toMatchObject({ estado: 'erro', total_com_gap: null });
  });
});

describe('FarmerCalls — a positivação que falha também tem estado explícito', () => {
  it('erro: a tela não AFIRMA "carteira já positivada" onde a verdade é falha de leitura', async () => {
    // Asserção deliberadamente ancorada em COMPORTAMENTO, não em copy: o desenho do aviso de
    // erro é do #1886 (`AvisoLeituraFalhou`), e casar a string dele aqui prenderia este guard a
    // uma implementação. O que NENHUMA implementação pode fazer é afirmar o contrário do que
    // sabe — e o empty state do "Clientes a positivar" diz exatamente isso.
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    // âncora positiva primeiro: prova que a página montou (senão o queryByText abaixo é vácuo).
    await screen.findByText('Oportunidades de cross-sell');
    expect(
      screen.queryByText(/Toda a carteira elegível já comprou/i),
      'afirmou carteira positivada onde a verdade é falha de leitura',
    ).toBeNull();
  });

  it('OFFLINE (pending+paused) não é "sem acesso": o sensor emite em vez de calar', async () => {
    // O quarto estado, e o que engana quem "já trata erro": com `networkMode: 'online'` (o
    // default, sem override no repo) a query offline fica `status:'pending'` +
    // `fetchStatus:'paused'` — `isLoading` é FALSE (v5: `isPending && isFetching`), `data` é
    // undefined e `error` é NULL. A guarda ingênua `!isLoading && !error && data == null` lê isso
    // como "a RPC disse que você não é staff" e não emite nada: some da série sem deixar rastro,
    // o MESMO colapso que este arquivo existe para matar. Num PWA de campo não é o caso raro.
    onlineManager.setOnline(false);

    renderPagina();

    await waitFor(() => expect(evento('carteira.positivacao_vista')).toBeTruthy());
    const payload = evento('carteira.positivacao_vista')!;
    // 'sem-rede' e NÃO 'erro': vendedor em campo sem sinal não é a RPC quebrada, e colapsar os
    // dois faria a série culpar o backend por cobertura de celular.
    expect(payload.estado, 'offline virou "sem acesso" e o sensor calou').toBe('sem-rede');
    expect(payload.total_eligible, 'offline fabricou número em vez de degradar para null').toBeNull();
  });

  it('erro: o evento sai com estado "erro" e números NULL — nunca zero fabricado', async () => {
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    await waitFor(() => expect(evento('carteira.positivacao_vista')).toBeTruthy());
    const payload = evento('carteira.positivacao_vista')!;
    expect(payload.estado, 'sem `estado` a série de adoção não separa falha de mês parado').toBe('erro');
    // §2 do money-path: ausente ≠ zero. Mandar 0 somaria falha de leitura como se fosse
    // carteira sem positivação — fabricando o número que o sensor existe pra medir.
    for (const campo of ['pct', 'positivados', 'total_eligible', 'a_positivar']) {
      expect(payload[campo], `\`${campo}\` foi fabricado em vez de ir null`).toBeNull();
    }
  });
});
