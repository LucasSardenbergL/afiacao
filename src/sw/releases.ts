/**
 * Lógica PURA do service worker "ponte" (`src/sw/sw.ts`) — sem `self`, sem
 * CacheStorage: tudo o que decide vive aqui para ser testado em vitest.
 *
 * O MODELO (por que existe — 2026-10-18): até aqui o SW era o gerado pelo Workbox em
 * modo `prompt`: um SW novo só ficava utilizável depois de baixar o precache INTEIRO
 * (~366 arquivos, ~6 MB) dentro do `install`, e só trocava com um clique. No iPhone
 * do founder isso nunca fechava — preso 9+ dias em `index-92kmkUxx`, com o código
 * velho congelado no próprio aparelho, fora do alcance de qualquer correção nossa.
 *
 * Agora a VERSÃO DO SW e a VERSÃO DO APP são coisas separadas:
 *   - o SW instala sem baixar nada e assume o controle na hora (`skipWaiting` +
 *     `clients.claim`) — é isso que alcança um cliente velho sem ação humana;
 *   - a página aberta NÃO recarrega: o SW continua servindo a ela, do cache que já
 *     existe no aparelho, os mesmos arquivos do build que ela executa;
 *   - o build novo ("release") é baixado em SEGUNDO PLANO, num cache próprio,
 *     retomável entre aberturas, reaproveitando arquivos idênticos já no aparelho;
 *   - só com o conjunto COMPLETO (offline-first de picking/recebimento incluído) a
 *     release é PROMOVIDA: a próxima navegação (abrir o app do zero, ou o clique em
 *     "Atualizar") passa a receber o HTML novo.
 */

/** Entrada do manifesto injetado pelo vite-plugin-pwa (`self.__WB_MANIFEST`). */
export interface EntradaManifesto {
  url: string;
  revision: string | null;
}

export interface ReleaseRef {
  buildId: string;
  cache: string;
}

/** O que o SW persiste (no cache de meta) sobre as releases. */
export interface EstadoReleases {
  promovida: ReleaseRef | null;
  /**
   * Releases promovidas ANTES da atual (mais recente primeiro, no máximo
   * `RELEASES_RETIDAS`) — retidas para páginas ainda abertas nelas. Uma só não
   * bastava (Codex, 2026-10-18): uma aba que atravessa DUAS promoções perdia os
   * chunks lazy do build que executa.
   */
  anteriores: ReleaseRef[];
}

const RELEASES_RETIDAS = 2;
export const ESTADO_INICIAL: EstadoReleases = { promovida: null, anteriores: [] };

/** Lê o estado persistido tolerando a forma antiga (`anterior` único) e lixo. */
export function normalizarEstado(bruto: unknown): EstadoReleases {
  const e = (bruto ?? {}) as { promovida?: ReleaseRef | null; anteriores?: ReleaseRef[]; anterior?: ReleaseRef | null };
  const anteriores = Array.isArray(e.anteriores) ? e.anteriores : e.anterior ? [e.anterior] : [];
  return { promovida: e.promovida ?? null, anteriores: anteriores.slice(0, RELEASES_RETIDAS) };
}

const PREFIXO_CACHE_RELEASE = 'afiacao-release-';
export const CACHE_META = 'afiacao-sw-meta';
export const CHAVE_META_ESTADO = '/__sw/estado-releases';
/** Cache de runtime dos chunks fora do precache (mesmo nome do SW do Workbox — preservado). */
export const CACHE_ASSETS_PROGRESSIVO = 'app-assets-progressive';
/**
 * Release "legada" = o precache do SW antigo do Workbox, que já está no aparelho com
 * o build que o cliente velho executa. Não tem buildId conhecido a priori.
 */
export const BUILD_LEGADO = 'legado';

/** Nome do cache do precache do Workbox (`workbox-core` cacheNames: prefix-precache-v2-scope). */
export function nomeCachePrecacheWorkbox(scope: string): string {
  return `workbox-precache-v2-${scope}`;
}

export function nomeCacheRelease(buildId: string): string {
  return `${PREFIXO_CACHE_RELEASE}${buildId}`;
}

const RE_ENTRY = /^\/?assets\/(index-[A-Za-z0-9_-]+)\.js$/;
/** Gêmeo do regex de `src/lib/build-id.ts` (o entry no index.html). */
const RE_ENTRY_NO_HTML = /\/assets\/(index-[A-Za-z0-9_-]+)\.js/;

/**
 * O build de uma release = o hash do chunk do entry — o MESMO eixo do `build_id`
 * da página (`src/lib/build-id.ts`) e do `telemetria_probes`. É a PRIMEIRA entrada
 * do manifesto: o build garante isso com `entryPrimeiro` (há vários `index-*.js` no
 * bundle — chunks compartilhados que o Rollup também nomeia `index`; só o do
 * index.html é o entry). Primeira entrada fora do padrão → `null` (o SW não promove).
 */
export function buildIdDoManifesto(manifesto: readonly EntradaManifesto[]): string | null {
  const m = manifesto[0] ? RE_ENTRY.exec(manifesto[0].url) : null;
  return m?.[1] ?? null;
}

/**
 * Transform do manifesto no BUILD (vite.config.ts → `manifestTransforms`): põe o
 * entry REAL — o `<script>` do index.html — em primeiro lugar. Fail-closed: entry
 * ausente do HTML ou do manifesto LANÇA, e o build falha em vez de publicar um SW
 * que compararia builds pelo chunk errado (a página veria "versão nova" para sempre).
 */
export function entryPrimeiro<T extends EntradaManifesto>(entradas: readonly T[], indexHtml: string): T[] {
  const id = RE_ENTRY_NO_HTML.exec(indexHtml)?.[1];
  if (!id) throw new Error('SW ponte: entry /assets/index-*.js não encontrado no index.html');
  const url = `assets/${id}.js`;
  const i = entradas.findIndex((e) => e.url === url || e.url === `/${url}`);
  if (i < 0) throw new Error(`SW ponte: entry ${url} fora do manifesto do precache`);
  return [entradas[i], ...entradas.slice(0, i), ...entradas.slice(i + 1)];
}

/** URL absoluta (sem revisão) de uma entrada — a chave no cache da release. */
export function urlDaEntrada(e: EntradaManifesto, scope: string): string {
  return new URL(e.url, scope).href;
}

/**
 * Arquivo com hash no nome (revision null) é imutável: o MESMO URL em qualquer cache
 * do aparelho tem o MESMO conteúdo — pode ser copiado em vez de baixado. Com revisão
 * (index.html, ícones, manifest), o conteúdo pode diferir sob o mesmo URL: rebaixa.
 */
export function reaproveitavel(e: EntradaManifesto): boolean {
  return e.revision === null;
}

/**
 * Opções do `fetch` de uma entrada no PREPARO. `credentials: 'omit'` é a correção do
 * incidente de 2026-10-19 (`docs/historico/sw-cookie-dpl-deploy-pinado.md`): o host do
 * Lovable PINA o browser num deployment pelo cookie `__dpl` — todo pedido COM cookie
 * recebe o HTML e os assets DAQUELE deployment (`cache-control: private, no-store`) —
 * mas serve `/sw.js` sempre do deployment mais novo. O SW novo pedia os assets do build
 * novo com cookie → caía no deployment velho → entry 404 → `obsoleta` → release nunca
 * promovida; e como a navegação vem do cache, o cookie nunca se renovava (deadlock até
 * desregistrar o SW). Sem cookie, o pedido cai no deployment atual — o mesmo que
 * entregou o `sw.js`. O modo de cache segue por tipo: arquivo com hash pode vir do HTTP
 * cache; com revisão (index.html, ícones) revalida.
 */
export function opcoesDeBusca(e: EntradaManifesto): { cache: RequestCache; credentials: RequestCredentials } {
  return { cache: reaproveitavel(e) ? 'default' : 'no-cache', credentials: 'omit' };
}

/** Entradas que ainda faltam na release (dado o conjunto de URLs já presentes). */
export function faltantes(
  manifesto: readonly EntradaManifesto[],
  presentes: ReadonlySet<string>,
  scope: string,
): EntradaManifesto[] {
  return manifesto.filter((e) => !presentes.has(urlDaEntrada(e, scope)));
}

export type VeredictoResposta = 'ok' | 'ausente' | 'invalida' | 'transitoria';

/**
 * Valida a resposta de um asset antes de gravar na release.
 *  - 404/410 → `ausente`: o host apaga os assets de builds anteriores; esta release
 *    ficou OBSOLETA (há build mais novo no ar; um SW mais novo vai chegar).
 *  - 2xx com HTML num `.js`/`.css` → `invalida`: fallback de SPA respondendo 200 —
 *    gravar isso quebraria o boot do build novo (Codex, 2026-10-18).
 *  - 5xx/0/429 → `transitoria`: tenta de novo depois.
 */
export function avaliarResposta(
  url: string,
  r: { ok: boolean; status: number; type?: string; contentType: string | null },
): VeredictoResposta {
  if (r.status === 404 || r.status === 410) return 'ausente';
  if (!r.ok) return 'transitoria';
  const caminho = new URL(url).pathname;
  const ehCodigo = /\.(?:js|css)$/i.test(caminho);
  const ct = (r.contentType ?? '').toLowerCase();
  if (ehCodigo && ct.includes('text/html')) return 'invalida';
  return 'ok';
}

/**
 * Promoção: a release nova vira a servida; a promovida até aqui vira `anterior`
 * (retida para páginas ainda abertas nela). Promover a mesma release é no-op.
 */
export function promover(estado: EstadoReleases, nova: ReleaseRef): EstadoReleases {
  if (estado.promovida?.buildId === nova.buildId) return estado;
  const anteriores = [estado.promovida, ...estado.anteriores]
    .filter((r): r is ReleaseRef => r !== null && r.buildId !== nova.buildId)
    .slice(0, RELEASES_RETIDAS);
  return { promovida: nova, anteriores };
}

/**
 * Estado efetivo no arranque do SW: sem release promovida mas com o precache do
 * Workbox no aparelho, o LEGADO é a release servida (é o build que o cliente velho
 * executa). Representá-lo como release faz a promoção guardá-lo como `anterior` —
 * e a retenção abaixo protegê-lo enquanto houver página aberta nele.
 */
export function estadoComLegado(estado: EstadoReleases, cacheLegado: string | null): EstadoReleases {
  if (estado.promovida || !cacheLegado) return estado;
  return { promovida: { buildId: BUILD_LEGADO, cache: cacheLegado }, anteriores: estado.anteriores };
}

/**
 * Caches que podem ser apagados após uma promoção. Retém: a promovida, as
 * `RELEASES_RETIDAS` anteriores (páginas ainda abertas nelas — inclusive o precache
 * LEGADO do Workbox), a release que este SW prepara, o runtime de assets e tudo que
 * não é release nem precache do Workbox (supabase-*, meta).
 */
export function cachesDescartaveis(
  nomes: readonly string[],
  estado: EstadoReleases,
  preparando: string | null,
): string[] {
  const reter = new Set<string>([CACHE_META, CACHE_ASSETS_PROGRESSIVO]);
  if (estado.promovida) reter.add(estado.promovida.cache);
  estado.anteriores.forEach((r) => reter.add(r.cache));
  if (preparando) reter.add(preparando);
  return nomes.filter((n) => {
    if (reter.has(n)) return false;
    if (n.startsWith(PREFIXO_CACHE_RELEASE)) return true;
    return n.startsWith('workbox-precache-');
  });
}

/** O entry que um index.html carrega (gêmeo de `src/lib/build-id.ts`); null se não houver. */
function buildDoHtml(html: string): string | null {
  return RE_ENTRY_NO_HTML.exec(html)?.[1] ?? null;
}

/**
 * P1 do Codex (2026-10-18): o index.html tem revisão, não hash — se um Publish
 * acontece no meio do preparo, a rede entrega o HTML do build NOVO sob o mesmo URL,
 * e a release "completa" seria promovida com o HTML de outro build (offline, falta o
 * entry dele: o app não abre). O HTML só entra na release se carregar o entry DELA.
 */
export function htmlEhDaRelease(html: string, buildRelease: string): boolean {
  return buildDoHtml(html) === buildRelease;
}

/**
 * Resposta que pode ser SERVIDA ou GRAVADA como asset: 200 exato (206 parcial e
 * opaca fora) e não-HTML em `.js`/`.css`. Vale na leitura também: uma entrada ruim
 * gravada antes desta regra (fallback de SPA 200 num `.js`) não pode ser servida.
 */
export function respostaServivel(url: string, r: { status: number; type?: string; contentType: string | null }): boolean {
  if (r.status !== 200 || r.type === 'opaque') return false;
  return avaliarResposta(url, { ok: true, status: 200, contentType: r.contentType }) === 'ok';
}

/** Navegações que NUNCA vêm do cache (OAuth do Lovable, rotas internas). */
const NAVEGACAO_SO_REDE = [/^\/~oauth/, /^\/__/];

export function navegacaoSoRede(pathname: string): boolean {
  return NAVEGACAO_SO_REDE.some((re) => re.test(pathname));
}

/**
 * Estado que o SW publica para as páginas. A página decide a FASE comparando com o
 * build que ELA executa (`faseDaPagina`).
 */
export interface EstadoPublicado {
  type: 'RELEASE_ESTADO';
  /** Build servido nas próximas navegações (null = ainda o legado/rede). */
  promovida: string | null;
  /** Build que este SW traz no manifesto. */
  release: string | null;
  progresso: { feitos: number; total: number } | null;
  /** Último problema do preparo — nunca "falhou" por rede (só retoma depois). */
  problema: 'obsoleta' | 'quota' | 'invalida' | null;
}

export type FasePagina = 'em_dia' | 'baixando' | 'pronta' | 'falhou';

/**
 * Fase da atualização PARA ESTA PÁGINA.
 *  - `pronta`: o SW já serve outro build nas próximas navegações → recarregar troca.
 *  - `baixando`: o SW está preparando um build diferente do desta página.
 *  - `falhou`: preparo travado por quota ou resposta inválida — só "Reparar" resolve.
 *  - `obsoleta` NÃO é falha: há build mais novo no ar e o SW mais novo chega no
 *    próximo `registration.update()`; enquanto isso, conta como baixando.
 */
export function faseDaPagina(buildPagina: string, e: EstadoPublicado): FasePagina {
  // `legado` = ainda servindo o precache do Workbox: é o build de uma página VELHA;
  // para uma página nova, não é "versão nova pronta".
  if (e.promovida && e.promovida !== BUILD_LEGADO && e.promovida !== buildPagina) return 'pronta';
  if (e.release && e.release !== buildPagina && e.release !== e.promovida) {
    if (e.problema === 'quota' || e.problema === 'invalida') return 'falhou';
    return 'baixando';
  }
  return 'em_dia';
}
