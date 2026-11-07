/**
 * Radar pacote F, achado 1: login perdia o destino no app inteiro. O ProtectedRoute gravava só `state.from` e o
 * /auth só lia `?next=` — quem abria o link do e-mail (`/radar?cnpj=…`) SEM sessão logava e caía na home.
 * Teste INTEGRADO: começa sem sessão numa rota protegida, passa pelo /auth de verdade e confere onde termina.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import Auth from '@/pages/Auth';
import { caminhoInternoSeguro, destinoPosLogin, rotaDeLogin } from '@/lib/destino-pos-login';

const sessao: { user: { id: string } | null } = { user: null };
const signIn = vi.fn(async () => {
  sessao.user = { id: 'u1' };
  return { error: null };
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: sessao.user, loading: false, isApproved: true, refetchRole: vi.fn(), signIn }),
}));
vi.mock('@/components/shell/SaidaComFilaPendente', () => ({
  useSaidaComFilaPendente: () => ({ pedirSaida: vi.fn(), dialogoSaida: null }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ order: async () => ({ data: [] }) }) }), auth: { signUp: vi.fn() } },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// O formulário real valida e-mail/senha; aqui só importa o que o /auth faz DEPOIS do signIn.
vi.mock('@/components/auth/LoginForm', () => ({
  LoginForm: ({ onSubmit }: { onSubmit: (e: string, s: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onSubmit('vendedor@colacor.com.br', 'x')}>ENTRAR</button>
  ),
}));
vi.mock('@/components/auth/SignupForm', () => ({ SignupForm: () => null }));

function Onde() {
  const l = useLocation();
  return <div data-testid="onde">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function montar(entrada: string) {
  return render(
    <MemoryRouter initialEntries={[entrada]}>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/.lovable/oauth/consent" element={<Onde />} />
        <Route path="/" element={<ProtectedRoute><div>HOME</div><Onde /></ProtectedRoute>} />
        <Route path="/radar" element={<ProtectedRoute><div>RADAR</div><Onde /></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('login honra o destino (integrado, começando SEM sessão)', () => {
  beforeEach(() => { sessao.user = null; signIn.mockClear(); });

  it('link do e-mail /radar?cnpj= sem sessão → /auth → login → volta para a ficha', async () => {
    montar('/radar?cnpj=12345678000199');
    fireEvent.click(await screen.findByText('ENTRAR'));
    await waitFor(() => expect(screen.getByText('RADAR')).toBeTruthy());
    expect(screen.getByTestId('onde').textContent).toBe('/radar?cnpj=12345678000199');
    expect(screen.queryByText('HOME')).toBeNull();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('ProtectedRoute grava o destino em ?next= (sobrevive a recarregar o /auth)', () => {
    render(
      <MemoryRouter initialEntries={['/radar?cnpj=1']}>
        <Routes>
          <Route path="/auth" element={<Onde />} />
          <Route path="/radar" element={<ProtectedRoute><div>RADAR</div></ProtectedRoute>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('onde').textContent).toBe('/auth?next=%2Fradar%3Fcnpj%3D1');
  });

  it('só state.from (sem ?next=, ex.: navegação antiga em memória) também leva ao destino', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/auth', state: { from: { pathname: '/radar', search: '?cnpj=9', hash: '' } } }]}>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/radar" element={<Onde />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText('ENTRAR'));
    await waitFor(() => expect(screen.getByTestId('onde').textContent).toBe('/radar?cnpj=9'));
  });

  it('consent OAuth (?next= com query) segue preservado', async () => {
    montar(`/auth?next=${encodeURIComponent('/.lovable/oauth/consent?authorization_id=abc')}`);
    fireEvent.click(await screen.findByText('ENTRAR'));
    await waitFor(() => expect(screen.getByTestId('onde').textContent).toBe('/.lovable/oauth/consent?authorization_id=abc'));
  });

  it.each([
    ['//evil.example/x'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
  ])('?next=%s (open redirect) → home', async (next) => {
    montar(`/auth?next=${encodeURIComponent(next)}`);
    fireEvent.click(await screen.findByText('ENTRAR'));
    await waitFor(() => expect(screen.getByText('HOME')).toBeTruthy());
    expect(screen.getByTestId('onde').textContent).toBe('/');
  });
});

describe('caminhoInternoSeguro / destinoPosLogin / rotaDeLogin', () => {
  it('aceita caminho interno com query e hash', () => {
    expect(caminhoInternoSeguro('/radar?cnpj=1&visao=meus#x')).toBe('/radar?cnpj=1&visao=meus#x');
  });
  it.each(['', 'radar', '//x.com', '/\\x.com', '/%0d%0a', ' /radar', '\t/radar', 'https://x.com', '/auth', '/auth?next=/x'])(
    'recusa %j', (v) => {
      // '/%0d%0a' é só texto percentual (o URL não decodifica): passa como caminho interno inofensivo.
      if (v === '/%0d%0a') expect(caminhoInternoSeguro(v)).toBe('/%0d%0a');
      else expect(caminhoInternoSeguro(v)).toBeNull();
    },
  );
  it('?next= vence o state; state vale quando não há next; nada → home', () => {
    const state = { from: { pathname: '/radar', search: '?cnpj=9', hash: '' } };
    expect(destinoPosLogin('/meu-dia', state)).toBe('/meu-dia');
    expect(destinoPosLogin(null, state)).toBe('/radar?cnpj=9');
    expect(destinoPosLogin('//evil', state)).toBe('/radar?cnpj=9');
    expect(destinoPosLogin(null, { from: { pathname: '//evil' } })).toBe('/');
    expect(destinoPosLogin(null, null)).toBe('/');
  });
  it('rotaDeLogin codifica o destino e omite a home', () => {
    expect(rotaDeLogin('/radar?cnpj=1&a=2')).toBe('/auth?next=%2Fradar%3Fcnpj%3D1%26a%3D2');
    expect(rotaDeLogin('/')).toBe('/auth');
    expect(rotaDeLogin('//evil')).toBe('/auth');
  });
});
