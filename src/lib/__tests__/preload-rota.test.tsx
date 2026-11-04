import { Component, Suspense, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Outlet, Route, Routes, createRoutesFromElements } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATRASO_INTENCAO_MS,
  __resetarPreloadRota,
  lazyRota,
  prefetchRota,
  registrarRotas,
  instalarRecuperacaoDeChunk,
  usePrefetchRota,
} from '@/lib/preload-rota';
import { ProtectedRoute } from '@/components/ProtectedRoute';

const auth = vi.hoisted(() => ({
  estado: { user: null as { id: string } | null, loading: true, isApproved: false, refetchRole: () => {} },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.estado }));
vi.mock('@/components/shell/SaidaComFilaPendente', () => ({
  useSaidaComFilaPendente: () => ({ pedirSaida: () => {}, dialogoSaida: null }),
}));

const pagina = (texto: string) => () => Promise.resolve({ default: () => <p>{texto}</p> });

/** Imita o `__vitePreload` (5.4): dispara `vite:preloadError` com o erro em `payload`
 *  DENTRO da cadeia e rejeita com o MESMO objeto. */
const falhaComoVite = () =>
  Promise.resolve().then(() => {
    const erro = new TypeError('Failed to fetch dynamically imported module');
    window.dispatchEvent(Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: erro }));
    throw erro;
  });

const esvaziar = () => act(() => new Promise((r) => setTimeout(r, 0)));

class Fronteira extends Component<{ children: ReactNode }, { erro: boolean }> {
  state = { erro: false };
  static getDerivedStateFromError() {
    return { erro: true };
  }
  render() {
    return this.state.erro ? <p>quebrou</p> : this.props.children;
  }
}

beforeEach(() => {
  __resetarPreloadRota();
  sessionStorage.clear();
  auth.estado = { user: null, loading: true, isApproved: false, refetchRole: () => {} };
});
afterEach(() => vi.useRealTimers());

describe('loader único (F1): prefetch e lazy usam o MESMO carregador', () => {
  it('prefetch da rota chama o carregador do lazy e o render reusa o mesmo', async () => {
    const carregar = vi.fn(pagina('home'));
    const Home = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/" element={<Home />} />));

    prefetchRota('/?aba=1');
    prefetchRota('/');
    expect(carregar).toHaveBeenCalledTimes(1);

    render(<Suspense fallback={null}><Home /></Suspense>);
    expect(await screen.findByText('home')).toBeTruthy();
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it('a árvore no formato do App.tsx (layout, guard, wrapper) acha só o carregador da folha', () => {
    const home = vi.fn(pagina('home'));
    const caca = vi.fn(pagina('caca'));
    const naoAchada = vi.fn(pagina('404'));
    const login = vi.fn(pagina('login'));
    const [Home, Caca, NaoAchada, Login] = [home, caca, naoAchada, login].map((c) => lazyRota(c));
    const Gate = ({ children }: { children?: ReactNode }) => <>{children ?? <Outlet />}</>;
    registrarRotas(
      createRoutesFromElements(
        <>
          <Route path="/auth" element={<Login />} />
          <Route element={<Gate><Outlet /></Gate>}>
            <Route element={<Gate />}>
              <Route index element={<Home />} />
              <Route path="caca" element={<Gate><Caca /></Gate>} />
            </Route>
          </Route>
          <Route path="*" element={<NaoAchada />} />
        </>,
      ),
    );

    prefetchRota('/');
    prefetchRota('/caca');
    expect(home).toHaveBeenCalledTimes(1);
    expect(caca).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(naoAchada).not.toHaveBeenCalled();
  });

  it('o App.tsx declara cada import de página uma vez só, dentro de lazyRota (sem mapa paralelo)', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    const imports = [...app.matchAll(/import\("(\.\/pages\/[^"]+)"\)/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(100);
    expect(new Set(imports).size).toBe(imports.length);
    expect([...app.matchAll(/lazyRota\(\(\) => import\("\.\/pages\//g)].length).toBe(imports.length);
    expect(app).not.toMatch(/\blazy\(/);
    expect(app).toMatch(/registrarRotas\(createRoutesFromElements\(arvoreDeRotas\)\)/);
    expect(app).toMatch(/<Routes>\{arvoreDeRotas\}<\/Routes>/);
  });
});

describe('falha de chunk: prefetch é silencioso, navegação real recarrega', () => {
  let recarregar: ReturnType<typeof vi.fn>;
  let remover: () => void;
  beforeEach(() => {
    recarregar = vi.fn();
    remover = instalarRecuperacaoDeChunk(recarregar);
  });
  afterEach(() => remover());

  const comFronteira = (no: ReactNode) => render(<Fronteira><Suspense fallback={<p>carregando</p>}>{no}</Suspense></Fronteira>);

  it('prefetch que rejeita NÃO recarrega; a navegação real dessa rota recarrega 1× antes de carregar', async () => {
    const carregar = vi.fn(falhaComoVite);
    const Pagina = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/x" element={<Pagina />} />));

    prefetchRota('/x');
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(recarregar).not.toHaveBeenCalled();

    // controle na mesma invocação: o caminho real recarrega (o CSS visto pelo Vite não
    // geraria novo evento, então a recuperação não pode depender dele)
    comFronteira(<Pagina />);
    await esvaziar();
    expect(recarregar).toHaveBeenCalledTimes(1);
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(screen.getByText('carregando')).toBeTruthy();
  });

  it('navegação que começa com o prefetch ainda em voo espera o desfecho dele (CSS pendente)', async () => {
    let falhar: () => void = () => {};
    const carregar = vi.fn(
      () =>
        new Promise<{ default: () => JSX.Element }>((_, rejeitar) => {
          falhar = () => {
            const erro = new Error('Unable to preload CSS for /assets/x.css');
            window.dispatchEvent(Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: erro }));
            rejeitar(erro);
          };
        }),
    );
    const Pagina = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/x" element={<Pagina />} />));

    prefetchRota('/x');
    comFronteira(<Pagina />);
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(1); // o real não disparou 2º carregamento por cima

    await act(async () => falhar());
    await esvaziar();
    expect(recarregar).toHaveBeenCalledTimes(1);
    expect(carregar).toHaveBeenCalledTimes(1);
  });

  it('prefetch que rejeita com payload primitivo também é silencioso', async () => {
    const carregar = vi.fn(() =>
      Promise.resolve().then(() => {
        window.dispatchEvent(Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: 'falhou' }));
        throw 'falhou';
      }),
    );
    const Pagina = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/x" element={<Pagina />} />));
    prefetchRota('/x');
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(recarregar).not.toHaveBeenCalled();
  });

  it('navegação real que falha sem prefetch recarrega 1× pelo evento', async () => {
    const Pagina = lazyRota(vi.fn(falhaComoVite));
    const erroReact = vi.spyOn(console, 'error').mockImplementation(() => {});
    comFronteira(<Pagina />);
    expect(await screen.findByText('quebrou')).toBeTruthy();
    await esvaziar();
    expect(recarregar).toHaveBeenCalledTimes(1);
    erroReact.mockRestore();
  });

  it('prefetch de A falha com a navegação real de B saudável em voo: não recarrega', async () => {
    let liberarB: (m: { default: () => JSX.Element }) => void = () => {};
    const a = vi.fn(falhaComoVite);
    const b = vi.fn(() => new Promise<{ default: () => JSX.Element }>((r) => { liberarB = r; }));
    const [A, B] = [a, b].map((c) => lazyRota(c));
    registrarRotas(createRoutesFromElements(<Route path="/a" element={<A />} />));

    comFronteira(<B />);
    prefetchRota('/a');
    await esvaziar();
    expect(recarregar).not.toHaveBeenCalled();
    await act(async () => liberarB({ default: () => <p>pagina-b</p> }));
    expect(await screen.findByText('pagina-b')).toBeTruthy();
    expect(recarregar).not.toHaveBeenCalled();
  });

  it('import NÃO-rota falha com prefetch em voo: a recuperação recarrega', async () => {
    const a = vi.fn(() => new Promise<{ default: () => JSX.Element }>(() => {}));
    const A = lazyRota(a);
    registrarRotas(createRoutesFromElements(<Route path="/a" element={<A />} />));
    prefetchRota('/a');

    const evento = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new TypeError('outro') });
    window.dispatchEvent(evento);
    await esvaziar();
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it('a guarda anti-loop segue valendo: 2ª falha real não recarrega e a rota tenta carregar', async () => {
    sessionStorage.setItem('__preload_error_reloaded__', '1');
    const carregar = vi.fn(falhaComoVite);
    const Pagina = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/x" element={<Pagina />} />));
    prefetchRota('/x');
    await esvaziar();

    const erroReact = vi.spyOn(console, 'error').mockImplementation(() => {});
    comFronteira(<Pagina />);
    expect(await screen.findByText('quebrou')).toBeTruthy();
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(2);
    expect(recarregar).not.toHaveBeenCalled();
    erroReact.mockRestore();
  });
});

describe('redirects estáticos (F1): entrada por <Navigate> pré-carrega o destino', () => {
  it('segue o `to` absoluto (com query) e corta ciclo', () => {
    const novo = vi.fn(pagina('novo'));
    const Novo = lazyRota(novo);
    registrarRotas(
      createRoutesFromElements(
        <>
          <Route path="/velho" element={<Navigate to="/meio" replace />} />
          <Route path="/meio" element={<Navigate to="/novo?tab=x" replace />} />
          <Route path="/novo" element={<Novo />} />
          <Route path="/ciclo-a" element={<Navigate to="/ciclo-b" replace />} />
          <Route path="/ciclo-b" element={<Navigate to="/ciclo-a" replace />} />
        </>,
      ),
    );
    prefetchRota('/velho');
    expect(novo).toHaveBeenCalledTimes(1);
    expect(() => prefetchRota('/ciclo-a')).not.toThrow();
  });

  it('o teto de saltos vale: 3 redirects pré-carregam, 4 não', () => {
    // O ciclo sozinho não prova o teto: o decodePath do react-router engole o RangeError
    // do estouro de pilha. Quem prova é o alvo além do teto ficar sem prefetch.
    const tres = vi.fn(pagina('tres'));
    const quatro = vi.fn(pagina('quatro'));
    const [Tres, Quatro] = [tres, quatro].map((c) => lazyRota(c));
    registrarRotas(
      createRoutesFromElements(
        <>
          <Route path="/s1" element={<Navigate to="/s2" />} />
          <Route path="/s2" element={<Navigate to="/s3" />} />
          <Route path="/s3" element={<Navigate to="/alvo-tres" />} />
          <Route path="/alvo-tres" element={<Tres />} />
          <Route path="/q1" element={<Navigate to="/q2" />} />
          <Route path="/q2" element={<Navigate to="/q3" />} />
          <Route path="/q3" element={<Navigate to="/q4" />} />
          <Route path="/q4" element={<Navigate to="/alvo-quatro" />} />
          <Route path="/alvo-quatro" element={<Quatro />} />
        </>,
      ),
    );
    prefetchRota('/s1');
    prefetchRota('/q1');
    expect(tres).toHaveBeenCalledTimes(1);
    expect(quatro).not.toHaveBeenCalled();
  });
});

describe('autorização intacta (F1): baixar antes do auth sim, renderizar não', () => {
  it('a rota protegida não renderiza a página enquanto o auth carrega, mesmo com o chunk pronto', async () => {
    const carregar = vi.fn(pagina('conteudo-protegido'));
    const Home = lazyRota(carregar);
    const arvore = (
      <Route element={<ProtectedRoute><Outlet /></ProtectedRoute>}>
        <Route index element={<Home />} />
      </Route>
    );
    registrarRotas(createRoutesFromElements(arvore));
    prefetchRota('/');
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(1);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Suspense fallback={null}><Routes>{arvore}</Routes></Suspense>
      </MemoryRouter>,
    );
    await esvaziar();
    expect(screen.queryByText('conteudo-protegido')).toBeNull();
    expect(carregar).toHaveBeenCalledTimes(1);
  });

  it('com auth resolvido e aprovado, a página renderiza', async () => {
    const Home = lazyRota(pagina('conteudo-protegido'));
    auth.estado = { ...auth.estado, loading: false, user: { id: 'u' }, isApproved: true };
    render(
      <MemoryRouter initialEntries={['/']}>
        <Suspense fallback={null}>
          <Routes>
            <Route element={<ProtectedRoute><Outlet /></ProtectedRoute>}>
              <Route index element={<Home />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );
    expect(await screen.findByText('conteudo-protegido')).toBeTruthy();
  });
});

describe('usePrefetchRota (F5): intenção de ponteiro e foco', () => {
  function Item({ caminho }: { caminho: string }) {
    return <button {...usePrefetchRota(caminho)}>ir</button>;
  }

  it('apontar e sair antes do atraso não baixa; ficar baixa; focar baixa na hora', () => {
    vi.useFakeTimers();
    const a = vi.fn(pagina('a'));
    const b = vi.fn(pagina('b'));
    const [A, B] = [a, b].map((c) => lazyRota(c));
    registrarRotas(createRoutesFromElements(<><Route path="/a" element={<A />} /><Route path="/b" element={<B />} /></>));
    render(<><Item caminho="/a" /><Item caminho="/b" /></>);
    const [botaoA, botaoB] = screen.getAllByRole('button');

    fireEvent.pointerEnter(botaoA);
    vi.advanceTimersByTime(ATRASO_INTENCAO_MS - 1);
    fireEvent.pointerLeave(botaoA);
    vi.advanceTimersByTime(ATRASO_INTENCAO_MS);
    expect(a).not.toHaveBeenCalled();

    fireEvent.pointerEnter(botaoA);
    vi.advanceTimersByTime(ATRASO_INTENCAO_MS);
    expect(a).toHaveBeenCalledTimes(1);

    fireEvent.focus(botaoB);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('offline não dispara prefetch (falha de rede não envenena a navegação real)', () => {
    const carregar = vi.fn(pagina('a'));
    const A = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/a" element={<A />} />));
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    prefetchRota('/a');
    expect(carregar).not.toHaveBeenCalled();
    onLine.mockRestore();
    prefetchRota('/a');
    expect(carregar).toHaveBeenCalledTimes(1);
  });
});
