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
let respostaPerfilAlvo: Resposta = { data: { commercial_role: 'farmer' }, error: null };

/** A leitura do papel comercial, controlada: resolve quando o TESTE mandar. */
let resolverPapel: (r: Resposta) => void = () => {};
let promessaPapel: Promise<Resposta> = Promise.resolve({ data: null, error: null });
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

  it('papel que resolve TARDE: UM evento só, e com o rótulo VERDADEIRO', async () => {
    // A positivação chega primeiro; o papel demora. Emitir agora rotularia errado e a dedup
    // impediria a correção; emitir duas vezes inflaria o denominador. O certo é segurar
    // enquanto a leitura do papel é `carregando` — ausência transitória e auto-resolvida.
    montar();

    await waitFor(() => expect(qc.getQueryData(['my-positivacao', VENDEDOR])).toBeTruthy());
    expect(eventos(), 'emitiu antes de saber o papel — o rótulo só pode ser chute').toHaveLength(0);

    await act(async () => {
      resolverPapel({ data: { commercial_role: 'hunter' }, error: null });
      await promessaPapel;
    });

    await waitFor(() => expect(eventos()).toHaveLength(1));
    expect(eventos()[0].is_hunter, 'o papel chegou como hunter e o evento não soube').toBe(true);
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
