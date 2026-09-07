import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Guard money-path — o sensor `carteira.positivacao_vista` tem de ROTULAR direito.
 *
 * O #1896 fez o sensor EMITIR em todo desfecho (antes ele só existia no ramo de sucesso). A
 * revisão independente retroativa (2026-08-23, `docs/historico/fase-sem-sinal.md`) mediu que ele
 * emite — e rotula errado em três eixos, cada um corrompendo a mesma série de adoção:
 *
 *   1. `is_hunter` FABRICADO. O host descartava o `isLoading` e `commercialRole === 'hunter'`
 *      virava `false` enquanto o papel não chegava. Offline as duas leituras pausam JUNTAS, então
 *      todo evento 'sem-rede' de hunter saía `is_hunter:false` — determinístico, não corrida.
 *   2. A dedup não resetava na troca de SUJEITO (lente "Ver como"): o ref sobrevive à mudança de
 *      `effectiveUserId` porque a rota não remonta, e o payload não dizia de quem era o número.
 *   3. `erro`/`sem-rede` COM cache iam como leitura FRESCA (`estadoDeLeitura` testa
 *      `status==='success'` antes do `fetchStatus`).
 *
 * ── POR QUE ESTE ARQUIVO EXISTE, e não mais asserções no teste de host:
 * o corolário que a revisão deixou é que **o mock SÍNCRONO apaga a dimensão que a dependência
 * introduz**. `useMyCommercialRole: () => ({data:null, isLoading:false})` torna o defeito 1
 * impossível de falhar, e um `useImpersonation` fixo faz o mesmo com o 2. Aqui os hooks reais
 * rodam (`useMyPositivacao`, `useMyCommercialRole`, `useImpersonatedAccessProfile`) e só o
 * supabase e a lente são dublês — o papel resolve TARDE por promessa controlada, e o sujeito
 * TROCA entre renders. É a única forma de as duas dimensões existirem no harness.
 *
 * A helper `eventos()` devolve TODAS as chamadas, não a última: contar é parte da asserção
 * (um segundo escritor do mesmo slug inflaria o denominador sem nenhum teste ficar vermelho —
 * outro achado da mesma revisão).
 */

const VENDEDOR = 'vendedor-real';
const ALVO = 'vendedor-alvo';
const ERRO_TIMEOUT = { message: 'canceling statement due to statement timeout' };

type Resposta = { data: unknown; error: { message: string } | null };

const POSITIVACAO = {
  mes: '2026-08-01',
  total_eligible: 40,
  positivados: 22,
  compradores_mtd: 22,
  receita_mtd: 90_000,
  contatados_mtd: 30,
  recencia_critica: 3,
  novos_clientes_positivados: 2,
  a_positivar: [],
};

let respostaPositivacao: Resposta = { data: POSITIVACAO, error: null };
/** Quando ligado, a RPC de positivação fica PENDENTE até o teste resolver — é a única forma de
 *  observar a janela `success` + `fetching` (cache velho na tela enquanto revalida). */
let resolverPositivacao: (r: Resposta) => void = () => {};
let positivacaoEmVoo = false;
function positivacaoPendente() {
  positivacaoEmVoo = true;
  return new Promise<Resposta>((r) => {
    resolverPositivacao = (v) => { positivacaoEmVoo = false; r(v); };
  });
}
let respostaPerfilAlvo: Resposta = { data: { commercial_role: 'farmer' }, error: null };

/** A leitura do papel comercial, controlada: resolve quando o TESTE mandar. */
let resolverPapel: (r: Resposta) => void = () => {};
let promessaPapel: Promise<Resposta> = Promise.resolve({ data: null, error: null });
let promessaPositivacao: Promise<Resposta> = Promise.resolve({ data: null, error: null });
function papelPendente() {
  promessaPapel = new Promise<Resposta>((r) => {
    resolverPapel = r;
  });
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'single']) c[m] = () => c;
      c.maybeSingle = () => promessaPapel;
      return c;
    },
    rpc: (fn: string) => {
      if (fn === 'get_user_access_profile_for') return Promise.resolve(respostaPerfilAlvo);
      if (positivacaoEmVoo) return promessaPositivacao;
      return Promise.resolve(respostaPositivacao);
    },
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: VENDEDOR }, isStaff: true, isMaster: true, loading: false }),
}));

/** Lente MUTÁVEL — o sujeito troca sem a rota remontar, que é o cenário do defeito 2. */
let lente: {
  realUserId: string;
  target: { id: string } | null;
  effectiveUserId: string;
  isImpersonating: boolean;
} = { realUserId: VENDEDOR, target: null, effectiveUserId: VENDEDOR, isImpersonating: false };

vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => lente,
}));

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => track(...a),
  captureException: vi.fn(),
}));

import { useSinalPositivacao } from '@/hooks/useSinalPositivacao';

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function montar() {
  return renderHook(() => useSinalPositivacao(), { wrapper });
}

/** TODOS os payloads do slug, na ordem — contar é parte da asserção. */
function eventos(): Record<string, unknown>[] {
  return track.mock.calls
    .filter((c) => c[0] === 'carteira.positivacao_vista')
    .map((c) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  respostaPositivacao = { data: POSITIVACAO, error: null };
  respostaPerfilAlvo = { data: { commercial_role: 'farmer' }, error: null };
  lente = { realUserId: VENDEDOR, target: null, effectiveUserId: VENDEDOR, isImpersonating: false };
  papelPendente();
  positivacaoEmVoo = false;
  track.mockClear();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('defeito 1 — is_hunter não pode ser FABRICADO', () => {
  it('OFFLINE: o papel também está pausado, então o rótulo vai NULL — nunca false', async () => {
    // O caso medido: sem rede as DUAS queries pausam juntas. `false` aqui não é "não é hunter",
    // é "não sei" disfarçado de fato — e §2 do money-path (ausente ≠ zero) vale igual para
    // rótulo booleano. Nota: gatear por `isLoading` NÃO resolveria: com `networkMode:'online'`
    // a query pausada tem `isLoading === false` (v5: `isPending && isFetching`).
    onlineManager.setOnline(false);

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    const [payload] = eventos();
    expect(payload.estado).toBe('sem-rede');
    expect(payload.is_hunter, 'rótulo fabricado: offline afirmou "não é hunter" sem ter lido o papel').toBeNull();
  });

  it('papel que resolve TARDE: emite JÁ com null e CORRIGE quando o papel chega', async () => {
    // SEGURAR o evento até o papel resolver foi a 1ª tentativa, e o /codex a derrubou: a leitura do
    // papel não tem garantia de TÉRMINO (captive portal/rede parcial deixa a promise pendente sem
    // disparar retry, porque o navegador segue `online`), então segurar perde a linha de forma
    // SISTEMÁTICA — e o sensor IRMÃO, que não espera papel nenhum, emite na mesma visita: os dois
    // passariam a discordar sobre o vendedor ter visto a tela. Perder linha é o pior defeito
    // possível num sensor que existe para dar DENOMINADOR.
    // O certo é emitir com `null` (honesto: "ainda não sei") e pôr o rótulo na CHAVE, para que a
    // correção nunca seja engolida. Duas linhas distinguíveis > uma linha ausente ou mentirosa.
    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].is_hunter, 'rotulou sem ter lido o papel').toBeNull();

    await act(async () => {
      resolverPapel({ data: { commercial_role: 'hunter' }, error: null });
      await promessaPapel;
    });

    await waitFor(() => expect(eventos()).toHaveLength(2));
    expect(eventos()[1].is_hunter, 'o papel chegou como hunter e a série não soube').toBe(true);
  });

  it('a leitura do papel FALHA: o rótulo vai null — erro do PostgREST não é "não é hunter"', async () => {
    // Achado do /codex SOBRE O PRÓPRIO FIX: `useMyCommercialRole` fazia
    // `const { data } = await supabase…` e DESCARTAVA o `error` — assinatura literal da classe
    // "silêncio afirmativo" documentada neste repo. Com timeout/RLS/500 a query resolve com
    // SUCESSO e `null`, então o gate `estado === 'pronta'` tratava isso como FATO e A1 seguia vivo
    // por outro caminho: todo hunter atingido por falha nessa consulta era rotulado não-hunter.
    resolverPapel({ data: null, error: { message: 'canceling statement due to statement timeout' } });

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].is_hunter, 'erro de leitura do papel virou "não é hunter"').toBeNull();
  });

  it('papel que MUDA no meio da montagem: a série aprende o rótulo NOVO', async () => {
    // O papel tem `staleTime` de 60s e o cache dura `gcTime` de 15min: remontar serve o papel
    // VELHO como `status:'success'` (logo, "fato") enquanto revalida. Sem o rótulo na chave de
    // dedup, o `is_hunter` antigo ficava gravado para sempre e a correção era descartada.
    resolverPapel({ data: { commercial_role: 'hunter' }, error: null });

    montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].is_hunter).toBe(true);

    promessaPapel = Promise.resolve({ data: { commercial_role: 'farmer' }, error: null });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['my-commercial-role', VENDEDOR] });
    });

    await waitFor(() => expect(eventos().some((e) => e.is_hunter === false)).toBe(true));
  });

  it('papel resolvido como farmer: o rótulo false é FATO e sai false', async () => {
    // O controle que dá sentido ao null: quando a leitura do papel ACONTECE, `false` é
    // informação, não fabricação. Sem este caso, "sempre null" passaria verde.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].is_hunter).toBe(false);
  });
});

describe('defeito 2 — a dedup e o payload precisam conhecer o SUJEITO', () => {
  it('sem lente, o payload marca sob_lente:false', async () => {
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].sob_lente, 'sem o marcador, staff impersonando conta como vendedor real').toBe(false);
  });

  it('troca de sujeito na lente "Ver como": emite DE NOVO, mesmo com o estado igual', async () => {
    // `ImpersonationProvider` é Context e a rota NÃO remonta: o ref de dedup sobrevive à troca.
    // Alvo diferente com o mesmo estado ('pronta' → 'pronta') não emitia nada — a adoção do
    // ALVO desaparecia da série e a do staff ficava contada como vendedor real.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    const { rerender } = montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));

    lente = { realUserId: VENDEDOR, target: { id: ALVO }, effectiveUserId: ALVO, isImpersonating: true };
    rerender();

    await waitFor(() => expect(eventos()).toHaveLength(2));
    const segundo = eventos()[1];
    expect(segundo.estado, 'o estado é o MESMO — é o sujeito que mudou').toBe('pronta');
    expect(segundo.sob_lente, 'o segundo evento é do ALVO, sob a lente, e o payload tem de dizer').toBe(true);
  });
});

describe('defeito 3 — número velho não pode ir como fresco', () => {
  it('cache quente + OFFLINE: o evento sai marcado desatualizado, não como leitura fresca', async () => {
    // O medido: `{"estado":"pronta","pct":55,"positivados":22}` com a rede desligada,
    // indistinguível de uma leitura de verdade. `estadoDeLeitura` testa `status==='success'`
    // ANTES do `fetchStatus`, então cache quente + sem sinal devolve 'pronta'. O irmão
    // (#1892, MixGapCard) já resolvia isto com `desatualizado` no payload; este sensor não herdou.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].desatualizado, 'a 1ª leitura é fresca de verdade').toBeNull();

    onlineManager.setOnline(false);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['my-positivacao', VENDEDOR] });
    });

    await waitFor(() => expect(eventos()).toHaveLength(2));
    const segundo = eventos()[1];
    // `estado` descreve o DADO em mãos, `desatualizado` descreve o FRESCOR — a mesma repartição
    // do irmão (lá `com_gap`/`zero` ganham de `erro` quando há lista). Colapsar os dois num
    // `estado:'sem-rede'` jogaria fora o número que o vendedor está OLHANDO.
    expect(segundo.estado).toBe('pronta');
    expect(segundo.desatualizado, 'número velho foi para a série como fresco').toBe('sem_rede');
    expect(segundo.positivados, 'o número em MÃOS é real e continua indo — o que muda é o rótulo').toBe(22);
  });

  it('cache quente + ERRO no refetch: marca "erro" e mantém o número que está na tela', async () => {
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));

    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['my-positivacao', VENDEDOR] });
    });

    await waitFor(() => expect(eventos()).toHaveLength(2));
    const segundo = eventos()[1];
    expect(segundo.estado).toBe('pronta');
    expect(segundo.desatualizado).toBe('erro');
    expect(segundo.positivados).toBe(22);
  });

  it('SEM cache + erro: os números vão NULL, como o comentário do sensor sempre prometeu', async () => {
    // O contra-caso que impede a correção do defeito 3 de virar "manda o cache sempre":
    // sem dado em mãos não há número honesto nenhum, e 0 fabricaria carteira parada.
    respostaPositivacao = { data: null, error: ERRO_TIMEOUT };
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    const [payload] = eventos();
    expect(payload.estado).toBe('erro');
    expect(payload.desatualizado, 'sem dado em mãos não há o que estar desatualizado').toBeNull();
    for (const campo of ['pct', 'positivados', 'total_eligible', 'a_positivar']) {
      expect(payload[campo], `\`${campo}\` foi fabricado em vez de ir null`).toBeNull();
    }
  });
});

describe('achados do /codex — o que o 1º fix ainda deixava corromper a série', () => {
  it('cache quente REVALIDANDO: o número corrigido chega à série, não é engolido pela dedup', async () => {
    // `gcTime` de 15min (App.tsx): voltar a uma tela já visitada entrega o cache VELHO como
    // `status:'success'` + `fetchStatus:'fetching'`. `estadoDeLeitura` chama isso de 'pronta' e
    // `desatualizado()` não olha `fetching` — então o número velho saía com `desatualizado:null`
    // (fresco!) e, quando a resposta nova chegava, a chave continuava a mesma e a correção morria.
    // A asserção é sobre o DESFECHO (a série aprende o número novo), não sobre o mecanismo.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].positivados).toBe(22);

    respostaPositivacao = { data: { ...POSITIVACAO, positivados: 30 }, error: null };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['my-positivacao', VENDEDOR] });
    });

    await waitFor(() => expect(eventos().some((e) => e.positivados === 30)).toBe(true));
  });

  it('cache velho AINDA EM REVALIDAÇÃO não se apresenta como leitura fresca', async () => {
    // A outra metade do mesmo achado: enquanto a RPC nova está em voo, o número na tela é o do
    // cache. Emitir isso com `desatualizado:null` é afirmar frescor que não se tem.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].revalidando, 'a 1ª leitura não estava revalidando nada').toBe(false);

    promessaPositivacao = positivacaoPendente();
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ['my-positivacao', VENDEDOR] });
    });

    await waitFor(() =>
      expect(
        eventos().some((e) => e.revalidando === true),
        'o cache velho foi para a série sem dizer que estava sendo revalidado',
      ).toBe(true),
    );
    resolverPositivacao({ data: POSITIVACAO, error: null });
  });

  it('A → B → A na lente: 2 linhas, não 3 — o ref de uma chave só inflava o denominador', async () => {
    // O ref guardava só a ÚLTIMA chave, então voltar ao alvo A reemitia. Com um SET por montagem,
    // cada asserção distinta sai uma vez e o ciclo não infla `count()`.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });
    respostaPerfilAlvo = { data: { commercial_role: 'farmer' }, error: null };

    const { rerender } = montar();
    await waitFor(() => expect(eventos()).toHaveLength(1));

    lente = { realUserId: VENDEDOR, target: { id: ALVO }, effectiveUserId: ALVO, isImpersonating: true };
    rerender();
    await waitFor(() => expect(eventos()).toHaveLength(2));

    lente = { realUserId: VENDEDOR, target: null, effectiveUserId: VENDEDOR, isImpersonating: false };
    rerender();

    // dá tempo de um 3º evento sair, se ele fosse sair
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(eventos(), 'o ciclo A→B→A inflou o denominador com uma exposição repetida').toHaveLength(2);
  });

  it('o payload leva o MÊS do dado — senão número velho de outro mês é indecidível', async () => {
    // A `queryKey` não inclui o mês, e com cache de 15min (ou offline) um número de agosto pode
    // chegar à série em setembro. Sem `mes` no payload, "viu a carteira do mês corrente" não é
    // uma pergunta respondível — e é ela que decide se a tela fica.
    resolverPapel({ data: { commercial_role: 'farmer' }, error: null });

    montar();

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].mes).toBe('2026-08-01');
  });
});
