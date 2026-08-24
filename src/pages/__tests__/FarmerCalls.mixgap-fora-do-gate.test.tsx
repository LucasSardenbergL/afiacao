import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
 *
 * ⚠️ A revisão independente RETROATIVA do #1896 achou DOIS falsos verdes NESTE arquivo, os dois
 * medidos (`docs/historico/fase-sem-sinal.md`):
 *
 *   1. montar o host prova ALCANCE, não FALA. A asserção do caso de erro era só NEGATIVA
 *      (`queryByText(/já comprou/) === null`) com o MixGap de âncora, e a suíte dava `6 passed`
 *      COM e SEM o `<AvisoLeituraFalhou>` no host. Agora o caso afirma POSITIVAMENTE que o aviso
 *      existe, ancorado em `data-testid` — a copy é desenho do #1886 e pode mudar, a âncora não.
 *   2. nenhuma asserção CONTAVA emissões. `evento()` devolvia só a ÚLTIMA chamada, então um
 *      segundo escritor do mesmo slug passava verde: payload duplicado é IDÊNTICO, nenhum
 *      `toMatchObject` reprova, e o denominador da série de adoção dobra. Agora todo desfecho
 *      exige exatamente UMA emissão (`umaEmissao`).
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

/** TODOS os payloads de um evento, na ordem em que saíram — a contagem é o que guarda o slug. */
function eventos(nome: string): Record<string, unknown>[] {
  return track.mock.calls
    .filter((c) => c[0] === nome)
    .map((c) => c[1] as Record<string, unknown>);
}

/** Último payload de um evento, ou undefined se ele nunca saiu. */
function evento(nome: string): Record<string, unknown> | undefined {
  const todos = eventos(nome);
  return todos[todos.length - 1];
}

/**
 * Espera o desfecho SAIR e o React ASSENTAR — nesta ordem, e antes de qualquer contagem.
 *
 * `waitFor` sozinho para na PRIMEIRA emissão: uma segunda, vinda do commit seguinte, chegaria
 * depois da contagem e `umaEmissao` leria 1. Seria uma corrida a favor do verde — exatamente o
 * modo de falhar que este arquivo existe para matar.
 */
async function aguardarDesfecho(nome: string): Promise<void> {
  await waitFor(() => expect(eventos(nome).length).toBeGreaterThan(0));
  // dois flushes de effects: um emissor irmão que só monta no commit seguinte já emitiu aqui.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * UM desfecho = UMA emissão — "1 escritor por slug" (CLAUDE.md §Design System / ação global).
 *
 * `toMatchObject` é CEGO a isto. Um segundo `useSinalPositivacao(isHunter)` no host — ou o
 * `track()` de volta para dentro do `PositivacaoHero`, de onde o #1896 o tirou — emite o payload
 * IDÊNTICO: toda asserção de FORMA continua verde e só o denominador muda. E denominador inflado
 * não é ruído, é a série afirmando que a tela é menos usada do que é (money-path §denominador).
 */
function umaEmissao(nome: string): void {
  expect(
    eventos(nome).map((p) => p.estado),
    `\`${nome}\` saiu mais de uma vez no MESMO desfecho — dois escritores do mesmo slug`,
  ).toHaveLength(1);
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
    await aguardarDesfecho('carteira.mixgap_visto');
    await aguardarDesfecho('carteira.positivacao_vista');
    expect(evento('carteira.mixgap_visto')).toMatchObject({ estado: 'com_gap', total_com_gap: 2 });
    expect(evento('carteira.positivacao_vista')).toMatchObject({ estado: 'pronta', total_eligible: 40 });
    umaEmissao('carteira.mixgap_visto');
    umaEmissao('carteira.positivacao_vista');
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
    await aguardarDesfecho('carteira.mixgap_visto');
    expect(
      evento('carteira.mixgap_visto'),
      'sem o evento a adoção do MixGap fica sem denominador justamente no dia ruim',
    ).toMatchObject({ estado: 'com_gap', total_com_gap: 2 });
    umaEmissao('carteira.mixgap_visto');
    // a leitura que FALHOU também tem um só escritor: o dia ruim é o dia em que o denominador
    // mais importa, e é onde duplicar dói mais.
    await aguardarDesfecho('carteira.positivacao_vista');
    umaEmissao('carteira.positivacao_vista');
  });

  it('mixgap FALHA e positivação OK: o hero continua na tela (a independência vale nos dois sentidos)', async () => {
    respostaMixGap = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    expect(await screen.findByText('Positivação MTD')).toBeTruthy();
    expect(await screen.findByText('Não consegui carregar as oportunidades')).toBeTruthy();
    await aguardarDesfecho('carteira.mixgap_visto');
    expect(evento('carteira.mixgap_visto')).toMatchObject({ estado: 'erro', total_com_gap: null });
    umaEmissao('carteira.mixgap_visto');
  });
});

describe('FarmerCalls — a positivação que falha também tem estado explícito', () => {
  it('erro: o host DIZ que não conseguiu ler — e não afirma "carteira já positivada"', async () => {
    // As duas metades são asserções DIFERENTES, e a versão anterior só tinha a segunda:
    //   POSITIVA — a tela FALA (existe aviso de leitura que falhou);
    //   NEGATIVA — a tela não MENTE (não afirma carteira positivada).
    // Só a negativa passa verde numa tela que emudeceu: nada afirmar satisfaz "não afirmou o
    // contrário". Medido no #1896: `6 passed` com e SEM o `<AvisoLeituraFalhou>` no host.
    //
    // A âncora é `data-testid` e NÃO a copy: o desenho do aviso é do #1886 e pode mudar sem que
    // o contrato ("no erro esta tela fala") mude — prender o guard à string trocaria um falso
    // verde por um falso vermelho.
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    // âncora de MONTAGEM primeiro: separa "a página não subiu" de "subiu e emudeceu" — sem ela
    // as duas falhas ficariam indistinguíveis, que é como o defeito do #1859 nasceu.
    await screen.findByText('Oportunidades de cross-sell');

    const aviso = await screen.findByTestId('aviso-positivacao').catch(() => null);
    expect(
      aviso,
      'o host EMUDECEU na falha de leitura: sem o aviso a tela fica idêntica à do mês parado, e ' +
      'o vendedor decide por uma tela que não sabe de nada',
    ).not.toBeNull();
    expect(
      aviso!.getAttribute('data-estado'),
      'o aviso montou com o estado errado — `erro` e `sem-rede` doem diferente para quem lê',
    ).toBe('erro');

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

    await aguardarDesfecho('carteira.positivacao_vista');
    const payload = evento('carteira.positivacao_vista')!;
    // 'sem-rede' e NÃO 'erro': vendedor em campo sem sinal não é a RPC quebrada, e colapsar os
    // dois faria a série culpar o backend por cobertura de celular.
    expect(payload.estado, 'offline virou "sem acesso" e o sensor calou').toBe('sem-rede');
    expect(payload.total_eligible, 'offline fabricou número em vez de degradar para null').toBeNull();
    umaEmissao('carteira.positivacao_vista');
  });

  it('erro: o evento sai com estado "erro" e números NULL — nunca zero fabricado', async () => {
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderPagina();

    await aguardarDesfecho('carteira.positivacao_vista');
    umaEmissao('carteira.positivacao_vista');
    const payload = evento('carteira.positivacao_vista')!;
    expect(payload.estado, 'sem `estado` a série de adoção não separa falha de mês parado').toBe('erro');
    // §2 do money-path: ausente ≠ zero. Mandar 0 somaria falha de leitura como se fosse
    // carteira sem positivação — fabricando o número que o sensor existe pra medir.
    for (const campo of ['pct', 'positivados', 'total_eligible', 'a_positivar']) {
      expect(payload[campo], `\`${campo}\` foi fabricado em vez de ir null`).toBeNull();
    }
  });
});
