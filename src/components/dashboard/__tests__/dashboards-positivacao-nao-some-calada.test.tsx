import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard money-path — o placar do "Meu dia" NÃO PODE sumir calado nos dois dashboards.
 *
 * A CLASSE (docs/historico/fase-sem-sinal.md; #1859, #1886 e a revisão retroativa do #1896):
 * a leitura que falha deixa `data === undefined`, que é a MESMA condição do vazio. Um host que
 * faz `{positivacao && <PositivacaoHero …/>}` sem ler o ESTADO da query apaga o placar inteiro —
 * e numa tela que é o NORTE da farmer, a ausência AFIRMA que está tudo bem.
 *
 * O defeito vivia em dois hosts ao mesmo tempo:
 *
 *     FarmerDashboardV2.tsx:57   {positivacao && <PositivacaoHero kpis={positivacao} isHunter={false} />}
 *     HunterDashboard.tsx:38     {positivacao && <PositivacaoHero kpis={positivacao} isHunter={true} />}
 *
 * enquanto `FarmerCalls` — MESMO hero, MESMO hook, 20 linhas de código ao lado — já montava o
 * <AvisoLeituraFalhou> desde o #1886. A correção existia; faltava em dois lugares.
 *
 * POR QUE O HOST REAL, e não `<PositivacaoHero>` isolado: a lição do #1896 é que o defeito mora na
 * COMPOSIÇÃO. Um teste do componente é verde num contexto que não existe em produção, e a asserção
 * NEGATIVA ("a tela não afirma o contrário") sobrevive intacta a um host emudecido — ela passa
 * exatamente quando a tela some. Por isso aqui só há asserção POSITIVA: o aviso TEM de estar na
 * tela, com a frase que desarma o "está tudo bem".
 *
 * Os hooks rodam de verdade (`useMyPositivacao`, `useSinalPositivacao`, `estadoDeLeitura`); só o
 * supabase e os IRMÃOS do placar (fila, caça, tarefas, agenda) são dublês — eles são outra
 * subárvore, e a cadeia que precisa ser provada é "RPC falha → hook lança → `data` undefined →
 * gate fecha → o host fala mesmo assim".
 */

const VENDEDOR = 'vendedor-a';
const ERRO_TIMEOUT = { message: 'canceling statement due to statement timeout' };

type Resposta = { data: unknown; error: { message: string } | null };

/** Payload cru da `get_minha_positivacao` (snake_case), como o PostgREST devolve. */
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

let respostaPositivacao: Resposta = { data: POSITIVACAO, error: null };

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

/** Realtime inerte — o `SlaCardMeuDia` assina `whatsapp_messages` no mount (useWhatsappSla.ts:56). */
function canal(): Record<string, unknown> {
  const ch: Record<string, unknown> = {};
  ch.on = () => ch;
  ch.subscribe = () => ch;
  ch.unsubscribe = () => Promise.resolve('ok');
  return ch;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => chain(),
    channel: () => canal(),
    removeChannel: () => Promise.resolve('ok'),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: (fn: string) => {
      const r: Resposta = fn === 'get_minha_positivacao' ? respostaPositivacao : { data: null, error: null };
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
  useAuth: () => ({ user: { id: VENDEDOR }, isStaff: true, isMaster: false, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: VENDEDOR }),
}));

// Irmãos do placar — outra subárvore, nenhum deles participa do defeito. Dublês triviais mantêm o
// teste preso à COMPOSIÇÃO do host (que é real) em vez da rede inteira do dashboard.
//
// Só os do PRÓPRIO módulo (`farmer-inteligencia`): `vi.mock` é lido como ARESTA de import pelo
// fiscal de fronteiras (src/lib/modulos/imports.ts), então dublar tarefas/whatsapp/push/caça
// abriria 4 vazamentos de fronteira para baselinar. Esses quatro montam de verdade contra o
// mesmo dublê de supabase — custam um pouco de tempo e não custam uma exceção arquitetural.
vi.mock('@/components/fila/FilaDoDia', () => ({ FilaDoDia: () => <div /> }));
vi.mock('@/components/dashboard/KpisToday', () => ({ KpisToday: () => <div /> }));
vi.mock('@/components/dashboard/AgendaTodayList', () => ({ AgendaTodayList: () => <div /> }));
vi.mock('@/components/farmer/ChamadasPendentesNudge', () => ({ ChamadasPendentesNudge: () => <div /> }));

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => track(...a),
  captureException: vi.fn(),
}));

import { FarmerDashboardV2 } from '../FarmerDashboardV2';
import { HunterDashboard } from '../HunterDashboard';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * O papel comercial vai SEMEADO no cache, e isso é fidelidade à produção — não conveniência.
 *
 * O `is_hunter` do evento deixou de ser literal passado pelo host (era fabricado: `false`/`true`
 * cravados no JSX valiam mesmo quando o papel não tinha sido lido) e passou a ser DERIVADO da
 * leitura de `useMyCommercialRole` dentro do próprio sensor. Só `estado === 'pronta'` vira fato;
 * fora dela o rótulo é `null` (§ revisão retroativa do #1896).
 *
 * Em produção estes dois hosts só montam DEPOIS de o `CommercialDashboard` ter lido o papel — é o
 * papel que escolhe qual dashboard renderizar. Semear o cache reproduz isso; não semear criaria um
 * contexto que não existe (host montado sem papel conhecido) e o teste passaria a medir o vazio.
 * Sem a semente, o caso OFFLINE fica impossível de passar: a query do papel também pausa.
 */
function renderHost(Host: () => JSX.Element, papel: 'farmer' | 'hunter') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(['my-commercial-role', VENDEDOR], papel);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <Host />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * O texto do <AvisoLeituraFalhou> nasce quebrado entre <span> e <strong>, então `findByText` de
 * string não casa. Ler pelo `role="status"` também é o que um leitor de tela faz.
 */
async function textoDosAvisos(): Promise<string> {
  const avisos = await screen.findAllByRole('status');
  return avisos.map((a) => a.textContent ?? '').join(' | ');
}

/** Versão síncrona, para o caso em que a ausência do aviso é o esperado. */
function textoDeStatus(): string {
  return screen.queryAllByRole('status').map((a) => a.textContent ?? '').join(' | ');
}

/** Último payload de um evento, ou undefined se ele nunca saiu. */
function evento(nome: string): Record<string, unknown> | undefined {
  const c = [...track.mock.calls].reverse().find((c) => c[0] === nome);
  return c?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  respostaPositivacao = { data: POSITIVACAO, error: null };
  track.mockClear();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

const HOSTS = [
  {
    nome: 'FarmerDashboardV2',
    Host: FarmerDashboardV2,
    kpiDoHero: 'Positivação MTD',
    oque: 'a positivação da sua carteira',
    isHunter: false,
  },
  {
    nome: 'HunterDashboard',
    Host: HunterDashboard,
    kpiDoHero: 'Novos na carteira (MTD)',
    oque: 'o seu placar de aquisição',
    isHunter: true,
  },
] as const;

describe.each(HOSTS)('$nome — o placar não some calado', ({ Host, kpiDoHero, oque, isHunter }) => {
  const papel = isHunter ? 'hunter' as const : 'farmer' as const;
  it('DETECTOR: leitura OK → o hero monta e NÃO há aviso', async () => {
    // Sem este caso, "o aviso não apareceu" e "o host nem montou" seriam indistinguíveis — que é
    // exatamente como um teste fica verde por cegueira.
    renderHost(Host, papel);

    expect(await screen.findByText(kpiDoHero)).toBeTruthy();
    // Casa a FRASE do aviso, não `role="status"` vazio: o `CacaConteudo` tem um banner de status
    // próprio (:109) e um "nenhum status na tela" reprovaria por motivo alheio ao que se mede.
    expect(
      textoDeStatus(),
      'aviso na leitura BOA é alarme fabricado (precisão > recall)',
    ).not.toContain('Isto não quer dizer que está tudo certo');
  });

  it('a RPC falha → o aviso aparece, dizendo que a informação não chegou', async () => {
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };

    renderHost(Host, papel);

    const texto = await textoDosAvisos();
    expect(
      texto,
      'o placar sumiu SEM avisar: numa tela que é o norte do vendedor, a ausência AFIRMA que está tudo bem',
    ).toContain(`Não foi possível carregar ${oque}`);
    expect(
      texto,
      'sem esta frase o usuário lê "deu erro num widget" e segue decidindo pela tela — o dano da classe',
    ).toContain('Isto não quer dizer que está tudo certo');

    // O host ESTÁ no estado de falha — o sensor do #1896 é a testemunha disso, e é ele que prova
    // em prod que este ramo acontece aqui (não é caso hipotético).
    expect(evento('carteira.positivacao_vista')).toMatchObject({
      estado: 'erro', pct: null, positivados: null, is_hunter: isHunter,
    });
  });

  it('sem rede → o aviso aparece, e fala de CONEXÃO (não culpa o backend)', async () => {
    // `networkMode: 'online'` (o default) deixa a query em pending+paused: `isLoading` é FALSE,
    // `data` é undefined e `error` é null. Quem trata só o erro cai no ramo do vazio — num PWA de
    // campo este é o caso comum, não o raro.
    onlineManager.setOnline(false);

    renderHost(Host, papel);

    const texto = await textoDosAvisos();
    expect(
      texto,
      'offline é o quarto estado: some calado justamente com o vendedor em campo',
    ).toContain(`Sem conexão — não foi possível verificar ${oque}`);

    expect(evento('carteira.positivacao_vista')).toMatchObject({
      // `sem_rede` (underscore) é o alfabeto da série; o `'sem-rede'` do helper fica na camada pura.
      estado: 'sem_rede', pct: null, is_hunter: isHunter,
    });
  });
});
