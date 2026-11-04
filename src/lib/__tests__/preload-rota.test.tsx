import { Component, Suspense, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, createRoutesFromElements } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATRASO_INTENCAO_MS,
  __resetarPreloadRota,
  lazyRota,
  prefetchRota,
  registrarRotas,
  tratarFalhaDeChunk,
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

/** Imita o `__vitePreload`: dispara `vite:preloadError` dentro da cadeia e rejeita. */
const falhaComoVite = () =>
  Promise.resolve().then(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    throw new TypeError('Failed to fetch dynamically imported module');
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
  const instalar = () => {
    const recarregar = vi.fn();
    const ouvinte = () => tratarFalhaDeChunk(recarregar);
    window.addEventListener('vite:preloadError', ouvinte);
    return { recarregar, remover: () => window.removeEventListener('vite:preloadError', ouvinte) };
  };

  it('prefetch que rejeita NÃO recarrega; a navegação real com o mesmo chunk recarrega 1×', async () => {
    const { recarregar, remover } = instalar();
    const carregar = vi.fn(falhaComoVite);
    const Pagina = lazyRota(carregar);
    registrarRotas(createRoutesFromElements(<Route path="/x" element={<Pagina />} />));

    prefetchRota('/x');
    await esvaziar();
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(recarregar).not.toHaveBeenCalled();

    // controle na mesma invocação: o caminho real ainda recarrega
    const erroReact = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Fronteira><Suspense fallback={null}><Pagina /></Suspense></Fronteira>);
    expect(await screen.findByText('quebrou')).toBeTruthy();
    expect(carregar).toHaveBeenCalledTimes(2);
    expect(recarregar).toHaveBeenCalledTimes(1);
    erroReact.mockRestore();
    remover();
  });

  it('a guarda anti-loop segue valendo para a navegação real', () => {
    const recarregar = vi.fn();
    tratarFalhaDeChunk(recarregar);
    tratarFalhaDeChunk(recarregar);
    expect(recarregar).toHaveBeenCalledTimes(1);
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
