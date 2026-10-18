/**
 * Service worker do Colacor — "ponte" entre a versão do SW e a versão do APP.
 * Modelo e porquê: cabeçalho de `./releases.ts`. Resumo das invariantes:
 *
 *  1. `install` não baixa nada e chama `skipWaiting()`; `activate` faz
 *     `clients.claim()`. Um SW novo SEMPRE assume — inclusive num aparelho preso
 *     num build antigo cujo código não temos mais como mudar.
 *  2. Nunca recarrega página: não há `client.navigate()` nem reload aqui. A página
 *     aberta segue no build dela, servida do cache que já está no aparelho.
 *  3. Navegação = HTML da release PROMOVIDA (cache-first). Release nova só é
 *     promovida com TODOS os arquivos do manifesto no cache — offline-first.
 *  4. Preparo em segundo plano, retomável, reaproveitando arquivos com hash já
 *     presentes em qualquer cache do aparelho.
 *
 * Bundle: vite-plugin-pwa `injectManifest` (rollup iife) → publicado como `/sw.js`,
 * o MESMO URL do SW antigo do Workbox (é o que faz o soft update do cliente velho
 * achá-lo). Imports RELATIVOS (o build do SW não usa o alias `@/`).
 */
import { Route, Router } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  CACHE_ASSETS_PROGRESSIVO,
  CACHE_META,
  CHAVE_META_ESTADO,
  ESTADO_INICIAL,
  avaliarResposta,
  buildIdDoManifesto,
  cachesDescartaveis,
  estadoComLegado,
  faltantes,
  htmlEhDaRelease,
  navegacaoSoRede,
  normalizarEstado,
  nomeCachePrecacheWorkbox,
  nomeCacheRelease,
  promover,
  reaproveitavel,
  respostaServivel,
  urlDaEntrada,
  type EntradaManifesto,
  type EstadoPublicado,
  type EstadoReleases,
} from './releases';

/* ─── Tipos mínimos do escopo do SW (o tsconfig do app usa a lib DOM, não webworker) ─── */
interface EventoEstendivel extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface EventoFetch extends EventoEstendivel {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface EventoMensagem extends EventoEstendivel {
  data: unknown;
  source: { postMessage(m: unknown): void } | null;
  ports: readonly MessagePort[];
}
interface ClienteJanela {
  postMessage(m: unknown): void;
}
interface EscopoSW {
  __WB_MANIFEST: EntradaManifesto[];
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(o?: { type?: string; includeUncontrolled?: boolean }): Promise<ClienteJanela[]> };
  addEventListener(tipo: 'install' | 'activate', fn: (e: EventoEstendivel) => void): void;
  addEventListener(tipo: 'fetch', fn: (e: EventoFetch) => void): void;
  addEventListener(tipo: 'message', fn: (e: EventoMensagem) => void): void;
}
declare const self: EscopoSW;
declare function importScripts(...urls: string[]): void;

// Handlers de Web Push (public/push-sw.js) — mesmo arquivo de antes.
importScripts('push-sw.js');

const MANIFESTO: EntradaManifesto[] = self.__WB_MANIFEST;
const SCOPE = self.registration.scope;
const BUILD = buildIdDoManifesto(MANIFESTO);
const CACHE_RELEASE = BUILD ? nomeCacheRelease(BUILD) : null;
const CACHE_LEGADO = nomeCachePrecacheWorkbox(SCOPE);
const CONCORRENCIA = 4;

/* ─── Estado persistido ─── */
async function lerEstado(): Promise<EstadoReleases> {
  try {
    const r = await (await caches.open(CACHE_META)).match(CHAVE_META_ESTADO);
    if (!r) return ESTADO_INICIAL;
    return normalizarEstado(await r.json());
  } catch {
    return ESTADO_INICIAL;
  }
}
async function gravarEstado(e: EstadoReleases): Promise<void> {
  const meta = await caches.open(CACHE_META);
  await meta.put(CHAVE_META_ESTADO, new Response(JSON.stringify(e), { headers: { 'content-type': 'application/json' } }));
}
async function estadoEfetivo(): Promise<EstadoReleases> {
  const legado = (await caches.has(CACHE_LEGADO)) ? CACHE_LEGADO : null;
  return estadoComLegado(await lerEstado(), legado);
}

/* ─── Publicação de estado às páginas ─── */
let progresso: EstadoPublicado['progresso'] = null;
let problema: EstadoPublicado['problema'] = null;

async function estadoPublicado(): Promise<EstadoPublicado> {
  const e = await estadoEfetivo();
  return { type: 'RELEASE_ESTADO', promovida: e.promovida?.buildId ?? null, release: BUILD, progresso, problema };
}
async function anunciar(): Promise<void> {
  const msg = await estadoPublicado();
  const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  janelas.forEach((c) => c.postMessage(msg));
}

/* ─── Preparo da release deste SW ─── */
let preparo: Promise<void> | null = null;
/** Atalho em memória: depois de promovida, nenhum gatilho precisa reler o meta. */
let promovidaNesteSW = false;

function prepararRelease(): Promise<void> {
  if (promovidaNesteSW) return Promise.resolve();
  if (preparo) return preparo;
  preparo = executarPreparo().finally(() => {
    preparo = null;
  });
  return preparo;
}

class FimDoPreparo extends Error {
  constructor(readonly motivo: NonNullable<EstadoPublicado['problema']>) {
    super(motivo);
  }
}

const servivel = (url: string, r: Response) =>
  respostaServivel(url, { status: r.status, type: r.type, contentType: r.headers.get('content-type') });
const ehIndexHtml = (url: string) => new URL(url).pathname === new URL('index.html', SCOPE).pathname;

async function obterEntrada(cache: Cache, e: EntradaManifesto): Promise<void> {
  const url = urlDaEntrada(e, SCOPE);
  if (reaproveitavel(e)) {
    // Arquivo com hash: o MESMO URL em qualquer cache do aparelho é o mesmo conteúdo.
    const local = await caches.match(url);
    if (local && servivel(url, local)) {
      await cache.put(url, local);
      return;
    }
  }
  const r = await fetch(url, { cache: reaproveitavel(e) ? 'default' : 'no-cache', credentials: 'same-origin' });
  const v = avaliarResposta(url, { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') });
  if (v === 'ausente') throw new FimDoPreparo('obsoleta');
  if (v === 'invalida') throw new FimDoPreparo('invalida');
  if (v === 'transitoria' || !servivel(url, r)) throw new Error(`transitória ${r.status} ${url}`);
  if (BUILD && ehIndexHtml(url)) {
    // P1 (Codex): Publish no meio do preparo = a rede já entrega o HTML de OUTRO
    // build sob o mesmo URL. Só entra o HTML que carrega o entry DESTA release.
    const html = await r.text();
    if (!htmlEhDaRelease(html, BUILD)) throw new FimDoPreparo('obsoleta');
    await cache.put(url, new Response(html, { status: 200, headers: r.headers }));
    return;
  }
  await cache.put(url, r);
}

async function executarPreparo(): Promise<void> {
  if (!BUILD || !CACHE_RELEASE) return;
  const estado = await estadoEfetivo();
  const cache = await caches.open(CACHE_RELEASE);
  const presentes = new Set((await cache.keys()).map((r) => r.url));
  const pendentes = faltantes(MANIFESTO, presentes, SCOPE);
  // Já promovida E completa → nada a fazer. Promovida com arquivos FALTANDO (o
  // navegador evictou o cache e o meta sobreviveu — P2 do Codex) → rebaixa o que
  // falta; a navegação cai na rede enquanto isso.
  if (estado.promovida?.buildId === BUILD && pendentes.length === 0) {
    progresso = null;
    promovidaNesteSW = true;
    return;
  }
  const total = MANIFESTO.length;
  let feitos = total - pendentes.length;
  progresso = { feitos, total };
  await anunciar();

  let i = 0;
  const trabalhador = async () => {
    while (i < pendentes.length) {
      const e = pendentes[i++];
      await obterEntrada(cache, e);
      feitos++;
      progresso = { feitos, total };
      if (feitos % 25 === 0) void anunciar();
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCORRENCIA }, trabalhador));
  } catch (err) {
    if (err instanceof FimDoPreparo) problema = err.motivo;
    else if (err instanceof DOMException && err.name === 'QuotaExceededError') problema = 'quota';
    // Rede/5xx: sem marcar problema — o próximo gatilho retoma de onde parou.
    await anunciar();
    return;
  }

  // Conjunto COMPLETO conferido de novo pelas chaves gravadas (não pelo contador).
  const gravadas = new Set((await cache.keys()).map((r) => r.url));
  if (faltantes(MANIFESTO, gravadas, SCOPE).length > 0) return;

  const novo = promover(await estadoEfetivo(), { buildId: BUILD, cache: CACHE_RELEASE });
  await gravarEstado(novo);
  promovidaNesteSW = true;
  problema = null;
  progresso = null;
  const nomes = await caches.keys();
  await Promise.allSettled(cachesDescartaveis(nomes, novo, CACHE_RELEASE).map((n) => caches.delete(n)));
  await anunciar();
}

/* ─── Ciclo de vida ─── */
self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
  // Sem waitUntil de propósito: segurar o activate atrasaria TODOS os fetches da
  // página. O preparo é retomado por cada navegação/mensagem (abaixo).
  void prepararRelease().catch(() => undefined);
});

self.addEventListener('message', (e) => {
  const tipo = (e.data as { type?: string } | null)?.type;
  if (tipo === 'ESTADO') {
    // Responde JÁ (o estado de agora) e segue preparando; o fim do preparo é anunciado.
    e.waitUntil(estadoPublicado().then((m) => (e.ports[0] ?? e.source)?.postMessage(m)));
    e.waitUntil(prepararRelease().catch(() => undefined));
  }
  // SKIP_WAITING (páginas de builds antigos): este SW já pula a espera no install.
});

/* ─── Rotas de runtime (Supabase) — as mesmas do SW antigo ─── */
const router = new Router();
const rota = (casa: (url: URL) => boolean, h: NetworkFirst | NetworkOnly) =>
  router.registerRoute(new Route(({ url }: { url: URL }) => casa(url), h));
const supa = (re: string) => new RegExp(`^https://.*\\.supabase\\.co/rest/v1/${re}`, 'i');
const nf = (cacheName: string, maxEntries: number, maxAgeSeconds: number, timeout?: number) =>
  new NetworkFirst({ cacheName, networkTimeoutSeconds: timeout, plugins: [new ExpirationPlugin({ maxEntries, maxAgeSeconds })] });
rota((url) => supa('(tool_categories|default_prices|company_config|category_mappings)').test(url.href), nf('supabase-catalog-cache', 30, 60 * 60));
rota((url) => supa('(picking_tasks|picking_units|picking_lotes)').test(url.href), nf('supabase-picking-cache', 200, 5 * 60, 3));
rota((url) => supa('(nfe_recebimentos|nfe_recebimento_itens|cte_associados)').test(url.href), nf('supabase-recebimento-cache', 200, 60, 3));
rota((url) => supa('(orders|sales_orders|order_items|order_messages)').test(url.href), nf('supabase-orders-cache', 500, 30, 3));
rota((url) => supa('(profiles|user_tools)').test(url.href), nf('supabase-profiles-cache', 200, 5 * 60, 3));
rota((url) => supa('(tint_|farmer_)').test(url.href), nf('supabase-analytics-cache', 300, 2 * 60, 3));
rota((url) => /^https:\/\/.*\.supabase\.co\/(auth|realtime)/i.test(url.href), new NetworkOnly());

/* ─── Mesma origem: navegação e arquivos estáticos ─── */
async function htmlPromovido(): Promise<Response | undefined> {
  const e = await estadoEfetivo();
  if (!e.promovida) return undefined;
  const cache = await caches.open(e.promovida.cache);
  const index = new URL('index.html', SCOPE).href;
  // Precache do Workbox guarda o HTML como `index.html?__WB_REVISION__=…`.
  return (await cache.match(index)) ?? (await cache.match(index, { ignoreSearch: true }));
}

async function responderNavegacao(req: Request): Promise<Response> {
  const cacheado = await htmlPromovido();
  if (cacheado) return cacheado;
  return fetch(req);
}

async function responderEstatico(req: Request, e: EventoFetch): Promise<Response> {
  const exato = await caches.match(req);
  // Validado também na LEITURA: entrada ruim gravada antes (HTML-200 num .js) não sai.
  if (exato && servivel(req.url, exato)) return exato;
  const url = new URL(req.url);
  // Arquivos SEM hash do precache legado (ícones, manifest) têm `?__WB_REVISION__`
  // na chave: só nesse cache, e só para a mesma origem, ignora a query.
  if (!url.pathname.startsWith('/assets/') && (await caches.has(CACHE_LEGADO))) {
    const legado = await (await caches.open(CACHE_LEGADO)).match(req, { ignoreSearch: true });
    if (legado) return legado;
  }
  const r = await fetch(req);
  if (/^\/assets\/.*\.(?:js|css)$/i.test(url.pathname) && servivel(req.url, r)) {
    const copia = r.clone();
    e.waitUntil(caches.open(CACHE_ASSETS_PROGRESSIVO).then((c) => c.put(req, copia)));
  }
  return r;
}

/**
 * TODO fetch retoma o preparo e o mantém vivo (`waitUntil`). Medido na prova E2E
 * (2026-10-18, cenário "SW antigo em waiting"): disparado só pelo `activate` — que
 * NÃO pode segurar `waitUntil`, ou trava todos os fetches da página —, o SW foi
 * encerrado por ociosidade com os 362 arquivos baixados e a promoção nunca rodou.
 * No iOS, que mata SW sem cerimônia, seria a regra. Uma página de build ANTIGO não
 * manda mensagem nenhuma a este SW, mas faz requisições o tempo todo (Supabase,
 * chunks): cada uma vira um gatilho. Single-flight + atalho pós-promoção = custo ~0.
 */
function manterPreparo(e: EventoFetch): void {
  if (!promovidaNesteSW) e.waitUntil(prepararRelease().catch(() => undefined));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') {
      if (navegacaoSoRede(url.pathname)) return;
      e.respondWith(responderNavegacao(req));
      manterPreparo(e);
      return;
    }
    if (url.pathname === '/sw.js' || url.pathname === '/push-sw.js') return;
    e.respondWith(responderEstatico(req, e));
    manterPreparo(e);
    return;
  }
  const resposta = router.handleRequest({ request: req, event: e as never });
  if (resposta) e.respondWith(resposta);
  manterPreparo(e);
});
