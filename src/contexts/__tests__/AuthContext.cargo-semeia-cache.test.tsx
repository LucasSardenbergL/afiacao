import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Plano v5, lote 6c. O AuthContext já lê `commercial_roles` no boot; o `useMyCommercialRole` relia
// a mesma linha depois que o Index montava, e esse 2º REST era o passo serial dominante da home de
// staff. Agora o auth semeia o cache — mas SÓ com leitura sem erro: semear `null` de uma leitura que
// falhou seria fabricar "consultei e este user não tem cargo".

type Callback = (event: string, session: unknown) => void;
type Resposta = { data: unknown; error: unknown };
const s = vi.hoisted(() => ({
  aoMudarAuth: null as ((event: string, session: unknown) => void) | null,
  pedidos: {} as Record<string, number>,
  respostas: {} as Record<string, Resposta[]>,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb: Callback) => {
        s.aoMudarAuth = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(() => Promise.resolve({ data: { session: { user: { id: 'u-1' } } }, error: null })),
      signOut: vi.fn(),
    },
    from: vi.fn((tabela: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            s.pedidos[tabela] = (s.pedidos[tabela] ?? 0) + 1;
            const fila = s.respostas[tabela] ?? [];
            return Promise.resolve(fila.length > 1 ? fila.shift()! : fila[0]);
          },
        }),
      }),
    })),
  },
}));
vi.mock('@/lib/push/device', () => ({ limparPushDoDevice: vi.fn(() => Promise.resolve()) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({
  useImpersonatedAccessProfile: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@/hooks/useAuthzContract', () => ({ useAuthzContract: () => ({ matrizAtiva: true, loading: false }) }));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';

const visto: {
  cargo?: ReturnType<typeof useMyCommercialRole>;
  legado?: ReturnType<typeof useCommercialRole>;
  auth?: ReturnType<typeof useAuth>;
} = {};

/** Os dois leitores do cargo do user real: o do Index e o legado (via `useDisplayAccess`). */
function Cargo() {
  visto.cargo = useMyCommercialRole();
  visto.legado = useCommercialRole();
  return null;
}
/** Como o Index: o hook do cargo só monta depois que o auth resolveu. */
function Sonda() {
  visto.auth = useAuth();
  return visto.auth.loading ? null : <Cargo />;
}

function montar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

async function bootar() {
  const queryClient = montar();
  await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
  act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
  await waitFor(() => expect(visto.cargo).toBeDefined());
  return queryClient;
}

function adiada() {
  let soltar: (r: Resposta) => void = () => {};
  const promessa = new Promise<Resposta>((ok) => {
    soltar = ok;
  });
  return { promessa, soltar };
}
const CHAVE = ['my-commercial-role', 'u-1'];
const esvaziar = () => act(() => new Promise((r) => setTimeout(r, 20)));

const ok = (data: unknown): Resposta => ({ data, error: null });

beforeEach(() => {
  s.aoMudarAuth = null;
  s.pedidos = {};
  visto.cargo = undefined;
  visto.legado = undefined;
  visto.auth = undefined;
  s.respostas = {
    user_roles: [ok({ role: 'master' })],
    profiles: [ok({ is_approved: true })],
    commercial_roles: [ok({ commercial_role: 'farmer' })],
  };
});

describe('AuthContext semeia o cargo comercial do useMyCommercialRole', () => {
  it('leitura com cargo: o hook já nasce pronto com o cargo, sem 2º REST', async () => {
    await bootar();
    expect(visto.cargo).toMatchObject({ data: 'farmer', isLoading: false, estado: 'pronta' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.pedidos.commercial_roles).toBe(1);
  });

  it('o useCommercialRole legado também lê do cache semeado: nasce com o cargo e sem REST próprio', async () => {
    s.respostas.commercial_roles = [ok({ commercial_role: 'gerencial' })];
    await bootar();
    expect(visto.legado).toMatchObject({ commercialRole: 'gerencial', isGerencial: true, canViewManagerial: true, loading: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.pedidos.commercial_roles).toBe(1);
  });

  it('legado com leitura do boot COM erro: nega (null) e só concede depois que a própria consulta acha o cargo', async () => {
    const propria = adiada();
    s.respostas.commercial_roles = [
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
      propria.promessa as unknown as Resposta,
    ];
    await bootar();
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(2));
    expect(visto.legado).toMatchObject({ commercialRole: null, canViewStrategic: false, loading: true });
    await act(async () => propria.soltar(ok({ commercial_role: 'estrategico' })));
    await waitFor(() => expect(visto.legado).toMatchObject({ commercialRole: 'estrategico', canViewStrategic: true }));
    expect(s.pedidos.commercial_roles).toBe(2); // os dois hooks dividem UMA consulta
  });

  it('leitura sem linha (sem erro): o hook nasce pronto com null, sem 2º REST', async () => {
    s.respostas.commercial_roles = [ok(null)];
    await bootar();
    expect(visto.cargo).toMatchObject({ data: null, isLoading: false, estado: 'pronta' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.pedidos.commercial_roles).toBe(1);
  });

  it('leitura com ERRO não semeia null: o hook consulta sozinho e acha o cargo real', async () => {
    s.respostas.commercial_roles = [
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
      ok({ commercial_role: 'hunter' }),
    ];
    await bootar();
    await waitFor(() => expect(visto.cargo?.data).toBe('hunter'));
    expect(s.pedidos.commercial_roles).toBe(2);
  });

  it('retry descartado não semeia: a tentativa que venceu leu o cargo COM erro, então o hook consulta', async () => {
    // cliente: a 1ª tentativa lê o cargo (null, sem erro) mas repete por timeout de profiles; a 2ª
    // resolve profiles e falha no cargo. Semear a 1ª deixaria um null "fresco" de tentativa descartada.
    s.respostas = {
      user_roles: [ok({ role: 'customer' })],
      profiles: [{ data: null, error: { message: 'Failed to fetch' } }, ok({ is_approved: true })],
      commercial_roles: [ok(null), { data: null, error: { message: 'statement timeout' } }, ok({ commercial_role: 'hunter' })],
    };
    await bootar();
    await waitFor(() => expect(visto.cargo?.data).toBe('hunter'), { timeout: 3000 });
    expect(s.pedidos.commercial_roles).toBe(3);
  });

  it('SIGNED_OUT com o fetch do auth em voo: a leitura atrasada NÃO volta ao cache de quem saiu', async () => {
    const cargo = adiada();
    s.respostas.commercial_roles = [cargo.promessa as unknown as Resposta];
    const queryClient = montar();
    await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
    act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(1));

    act(() => s.aoMudarAuth?.('SIGNED_OUT', null));
    await act(async () => cargo.soltar(ok({ commercial_role: 'farmer' })));
    await esvaziar();
    expect(queryClient.getQueryData(CHAVE)).toBeUndefined();
  });

  it('refresh mais novo vence: a leitura do evento anterior que chega depois não sobrescreve', async () => {
    const velha = adiada();
    s.respostas.commercial_roles = [velha.promessa as unknown as Resposta, ok({ commercial_role: 'hunter' })];
    const queryClient = montar();
    await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
    act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(1));
    act(() => s.aoMudarAuth?.('TOKEN_REFRESHED', { user: { id: 'u-1' } }));
    await waitFor(() => expect(queryClient.getQueryData(CHAVE)).toBe('hunter'));

    await act(async () => velha.soltar(ok({ commercial_role: 'farmer' })));
    await esvaziar();
    expect(queryClient.getQueryData(CHAVE)).toBe('hunter');
  });
});

// O mesmo defeito, anterior ao 6c, nos SETTERS do AuthContext: um fetch em voo que resolvia depois
// de um evento mais novo escrevia papel/aprovação/cargo de outra época no estado do auth.
describe('AuthContext: leitura de geração vencida não escreve no estado do auth', () => {
  it('SIGNED_OUT com o fetch em voo: o papel de quem saiu NÃO volta (user null, role null)', async () => {
    const cargo = adiada();
    s.respostas.commercial_roles = [cargo.promessa as unknown as Resposta];
    montar();
    await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
    act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(1));

    act(() => s.aoMudarAuth?.('SIGNED_OUT', null));
    await act(async () => cargo.soltar(ok({ commercial_role: 'farmer' })));
    await esvaziar();
    expect(visto.auth).toMatchObject({ user: null, role: null, isApproved: false, isMaster: false, isStaff: false });
  });

  it('evento mais novo vence: o papel lido pelo evento anterior, que chega depois, não sobrescreve', async () => {
    const velha = adiada();
    s.respostas = {
      user_roles: [ok({ role: 'master' }), ok({ role: 'employee' })],
      profiles: [ok({ is_approved: true })],
      commercial_roles: [velha.promessa as unknown as Resposta, ok({ commercial_role: 'hunter' })],
    };
    montar();
    await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
    act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(1));
    act(() => s.aoMudarAuth?.('USER_UPDATED', { user: { id: 'u-1' } }));
    await waitFor(() => expect(visto.auth?.role).toBe('employee'));

    await act(async () => velha.soltar(ok({ commercial_role: 'farmer' })));
    await esvaziar();
    expect(visto.auth).toMatchObject({ role: 'employee', isMaster: false, commercialRole: 'hunter' });
  });

  it('leitura vencida não termina o loading: a tela só libera quando a geração vigente escreveu o papel', async () => {
    const velha = adiada();
    const nova = adiada();
    s.respostas.commercial_roles = [velha.promessa as unknown as Resposta, nova.promessa as unknown as Resposta];
    montar();
    await waitFor(() => expect(s.aoMudarAuth).not.toBeNull());
    act(() => s.aoMudarAuth?.('INITIAL_SESSION', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(1));
    act(() => s.aoMudarAuth?.('TOKEN_REFRESHED', { user: { id: 'u-1' } }));
    await waitFor(() => expect(s.pedidos.commercial_roles).toBe(2));

    await act(async () => velha.soltar(ok({ commercial_role: 'farmer' })));
    await esvaziar();
    expect(visto.auth).toMatchObject({ loading: true, role: null });

    await act(async () => nova.soltar(ok({ commercial_role: 'farmer' })));
    await waitFor(() => expect(visto.auth).toMatchObject({ loading: false, role: 'master' }));
  });
});
