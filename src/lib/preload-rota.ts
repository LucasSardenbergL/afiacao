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
 * `vite:preloadError` e o reload global recarregaria a página. A recuperação
 * (`instalarRecuperacaoDeChunk`) atribui a falha pelo objeto de erro (`payload` do evento, o
 * mesmo que rejeita a promise) e só a ignora quando ele veio SÓ de prefetch. Falha real
 * (página, import não-rota) segue recarregando 1×. A navegação real de uma rota cujo prefetch
 * falhou recarrega antes de carregar: o Vite marca a dependência CSS como vista antes de
 * baixá-la, então a 2ª tentativa renderizaria sem CSS e sem novo evento. Pelo mesmo motivo a
 * navegação real espera o prefetch em voo da mesma rota terminar.
 *
 * Limite aceito: um import NÃO-rota que rejeite com o MESMO objeto de erro de um prefetch (erro
 * de AVALIAÇÃO de módulo compartilhado) é tratado como especulativo. Recarregar não conserta
 * erro de avaliação (o código é o mesmo); a rejeição continua chegando a quem importou.
 */
import { isValidElement, lazy, useEffect, useMemo, useRef, Children, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Navigate, matchRoutes, type RouteObject } from 'react-router-dom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mesmo contrato do React.lazy
type Pagina = ComponentType<any>;
type Carregador = () => Promise<{ default: Pagina }>;

const carregadores = new WeakMap<object, Carregador>();
const jaPedidos = new Set<Carregador>();
const falhouNoPrefetch = new Set<Carregador>();
const prefetchEmVoo = new Map<Carregador, Promise<void>>();

/** Erros vistos por origem. `payload` costuma ser objeto (WeakSet); primitivo (`throw 'x'`) vai no Set. */
type Erros = { objetos: WeakSet<object>; primitivos: Set<unknown> };
const novosErros = (): Erros => ({ objetos: new WeakSet(), primitivos: new Set() });
let errosEspeculativos = novosErros();
let errosReais = novosErros();
let rotas: RouteObject[] = [];
let recarregar: () => void = () => window.location.reload();

/** Atraso de intenção do ponteiro: passar o mouse por cima da sidebar não baixa tudo. */
export const ATRASO_INTENCAO_MS = 80;
/** Teto de redirects estáticos (`<Navigate to>`) seguidos pelo prefetch; corta ciclo. */
const MAX_REDIRECTS = 3;

const ehObjeto = (erro: unknown): erro is object => erro !== null && (typeof erro === 'object' || typeof erro === 'function');
const marcar = (erros: Erros, erro: unknown) => {
  if (ehObjeto(erro)) erros.objetos.add(erro);
  else erros.primitivos.add(erro);
};
const contem = (erros: Erros, erro: unknown) => (ehObjeto(erro) ? erros.objetos.has(erro) : erros.primitivos.has(erro));

/** Recarrega 1× por sessão (guarda anti-loop). Devolve se recarregou. */
function recarregarUmaVez(): boolean {
  try {
    if (sessionStorage.getItem('__preload_error_reloaded__')) return false;
    sessionStorage.setItem('__preload_error_reloaded__', '1');
  } catch {
    // sessionStorage indisponível: ainda assim recarrega (sem guarda).
  }
  recarregar();
  return true;
}

/**
 * `prefetchJunto` (lote 6b): quem pré-carrega esta rota também pré-carrega o carregador que a
 * função devolver (ex.: o dashboard que a home renderizou da última vez). O carregador devolvido
 * deve ser o MESMO do `lazyRota` que o renderiza. Roda 1× por documento, junto do 1º prefetch da
 * rota; exceção nele é engolida (é especulativo e não pode derrubar o boot).
 */
type OpcoesRota = { prefetchJunto?: () => Carregador | null };
const prefetchJuntoDe = new WeakMap<Carregador, () => Carregador | null>();

export function lazyRota<T extends Pagina>(
  carregar: () => Promise<{ default: T }>,
  opcoes: OpcoesRota = {},
): LazyExoticComponent<T> {
  if (opcoes.prefetchJunto) prefetchJuntoDe.set(carregar, opcoes.prefetchJunto);
  const Componente = lazy(async () => {
    // Prefetch em voo: espera o desfecho dele. O Vite já marcou o CSS como visto, então
    // carregar agora resolveria sem esperar o CSS (e sem recuperação se ele falhar).
    await prefetchEmVoo.get(carregar);
    if (falhouNoPrefetch.has(carregar) && recarregarUmaVez()) {
      return new Promise<{ default: T }>(() => {}); // a página está recarregando
    }
    return carregar().catch((erro: unknown) => {
      marcar(errosReais, erro);
      throw erro;
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

function prefetchCarregador(carregar: Carregador): void {
  if (jaPedidos.has(carregar)) return;
  jaPedidos.add(carregar);
  const emVoo = carregar().then(
    () => {
      prefetchEmVoo.delete(carregar);
    },
    (erro: unknown) => {
      // silencioso de propósito: quem decide recarregar é a navegação real
      marcar(errosEspeculativos, erro);
      falhouNoPrefetch.add(carregar);
      prefetchEmVoo.delete(carregar);
    },
  );
  prefetchEmVoo.set(carregar, emVoo);
  const junto = prefetchJuntoDe.get(carregar);
  if (!junto) return;
  let outro: Carregador | null = null;
  try {
    outro = junto();
  } catch {
    // especulativo: sem o "junto", a navegação real carrega sob demanda
  }
  if (outro) prefetchCarregador(outro);
}

/** Baixa o chunk da rota de `caminho` sem renderizar nada. Nunca lança e nunca recarrega. */
export function prefetchRota(caminho: string, redirects = 0): void {
  if (semRede()) return;
  const pathname = caminho.split(/[?#]/)[0];
  for (const { route } of matchRoutes(rotas, pathname) ?? []) {
    const elemento = route.element;
    if (isValidElement(elemento) && elemento.type === Navigate) {
      const destino = (elemento.props as { to?: unknown }).to;
      if (typeof destino === 'string' && destino.startsWith('/') && redirects < MAX_REDIRECTS) {
        prefetchRota(destino, redirects + 1);
      }
      continue;
    }
    carregadoresDoElemento(elemento).forEach(prefetchCarregador);
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
 * Ouve `vite:preloadError` (chunk ausente pós-deploy) e recarrega 1× para buscar os chunks
 * novos, EXCETO quando o erro veio só de prefetch. A decisão espera um macrotask: a promise
 * que rejeitou com o mesmo `payload` já passou pelos `.catch` acima e foi classificada.
 */
export function instalarRecuperacaoDeChunk(recarregarPagina?: () => void): () => void {
  if (recarregarPagina) recarregar = recarregarPagina;
  const ouvinte = (evento: Event) => {
    const erro = (evento as Event & { payload?: unknown }).payload;
    setTimeout(() => {
      if (contem(errosEspeculativos, erro) && !contem(errosReais, erro)) return;
      recarregarUmaVez();
    }, 0);
  };
  window.addEventListener('vite:preloadError', ouvinte);
  return () => window.removeEventListener('vite:preloadError', ouvinte);
}

/** Só para testes: zera o estado do módulo entre casos. */
export function __resetarPreloadRota(): void {
  jaPedidos.clear();
  falhouNoPrefetch.clear();
  prefetchEmVoo.clear();
  errosEspeculativos = novosErros();
  errosReais = novosErros();
  rotas = [];
  recarregar = () => window.location.reload();
}
