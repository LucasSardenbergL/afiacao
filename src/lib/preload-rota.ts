/**
 * Loader único das rotas lazy (plano v5, lote 6: F1 + F5).
 *
 * `lazyRota(carregar)` é o `React.lazy` das páginas do `App.tsx`. O MESMO `carregar` serve
 * ao prefetch: a árvore `<Route>` do `App.tsx` é registrada aqui (`registrarRotas`) e é o
 * mapa rota→import. Nenhum caminho de import é repetido fora do `lazyRota(() => import(…))`.
 *
 * - F1: o `main.tsx` chama `prefetchRota(location.pathname)` no boot, então o chunk da rota
 *   baixa EM PARALELO à checagem de auth. Só o JS baixa. O render continua atrás do
 *   `ProtectedRoute` (gate e fail-closed do `useAuth()` intactos).
 * - F5: a sidebar chama `usePrefetchRota(path)` ao apontar (com atraso de intenção) ou focar.
 *
 * Prefetch é especulativo: se o chunk sumiu (deploy novo, SW velho), o Vite dispara
 * `vite:preloadError` e o handler global do `main.tsx` recarregaria a página. O
 * `tratarFalhaDeChunk` só recarrega quando há um carregamento REAL (o do `lazy`) em voo.
 * Falha só de prefetch é silenciosa. A navegação real que vier depois falha de novo e
 * aí, sim, recarrega.
 */
import { isValidElement, lazy, useEffect, useMemo, useRef, Children, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { matchRoutes, type RouteObject } from 'react-router-dom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mesmo contrato do React.lazy
type Pagina = ComponentType<any>;
type Carregador = () => Promise<{ default: Pagina }>;

const carregadores = new WeakMap<object, Carregador>();
const jaPedidos = new Set<Carregador>();
let rotas: RouteObject[] = [];
let reaisEmVoo = 0;
let especulativosEmVoo = 0;

/** Atraso de intenção do ponteiro: passar o mouse por cima da sidebar não baixa tudo. */
export const ATRASO_INTENCAO_MS = 80;

export function lazyRota<T extends Pagina>(carregar: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  const Componente = lazy(() => {
    reaisEmVoo++;
    return carregar().finally(() => {
      reaisEmVoo--;
    });
  });
  carregadores.set(Componente, carregar);
  return Componente;
}

export function registrarRotas(arvore: RouteObject[]): void {
  rotas = arvore;
}

/** Carregadores `lazyRota` do elemento e dos filhos (ex.: `<RequireX><Pagina /></RequireX>`). */
function carregadoresDoElemento(no: ReactNode, saida: Carregador[] = []): Carregador[] {
  if (!isValidElement(no)) return saida;
  const carregar = carregadores.get(no.type as object);
  if (carregar) saida.push(carregar);
  Children.forEach((no.props as { children?: ReactNode }).children, (filho) => {
    carregadoresDoElemento(filho, saida);
  });
  return saida;
}

function semRede(): boolean {
  if (typeof navigator === 'undefined') return true;
  const conexao = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return navigator.onLine === false || conexao?.saveData === true;
}

/** Baixa o chunk da rota de `caminho` sem renderizar nada. Nunca lança e nunca recarrega. */
export function prefetchRota(caminho: string): void {
  if (semRede()) return;
  const pathname = caminho.split(/[?#]/)[0];
  for (const { route } of matchRoutes(rotas, pathname) ?? []) {
    for (const carregar of carregadoresDoElemento(route.element)) {
      if (jaPedidos.has(carregar)) continue;
      jaPedidos.add(carregar);
      especulativosEmVoo++;
      carregar()
        .catch(() => {
          // silencioso de propósito: quem decide recarregar é a navegação real
        })
        .finally(() => {
          especulativosEmVoo--;
        });
    }
  }
}

/** Handlers de intenção para um item de navegação: apontar (com atraso) ou focar. */
export function usePrefetchRota(caminho: string) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return useMemo(
    () => ({
      onPointerEnter: () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => prefetchRota(caminho), ATRASO_INTENCAO_MS);
      },
      onPointerLeave: () => clearTimeout(timer.current),
      onFocus: () => prefetchRota(caminho),
    }),
    [caminho],
  );
}

/**
 * Handler de `vite:preloadError` (chunk ausente pós-deploy): recarrega 1× para buscar os
 * chunks novos (guarda anti-loop em sessionStorage), EXCETO quando só há prefetch em voo.
 */
export function tratarFalhaDeChunk(recarregar: () => void = () => window.location.reload()): void {
  if (especulativosEmVoo > 0 && reaisEmVoo === 0) return;
  try {
    if (sessionStorage.getItem('__preload_error_reloaded__')) return;
    sessionStorage.setItem('__preload_error_reloaded__', '1');
  } catch {
    // sessionStorage indisponível: ainda assim recarrega (sem guarda).
  }
  recarregar();
}

/** Só para testes: zera o estado do módulo entre casos. */
export function __resetarPreloadRota(): void {
  jaPedidos.clear();
  rotas = [];
  reaisEmVoo = 0;
  especulativosEmVoo = 0;
}
