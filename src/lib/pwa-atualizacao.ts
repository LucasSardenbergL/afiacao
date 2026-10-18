import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { extrairBuildEm, extrairBuildId, resolverBuildEm, resolverBuildId } from '@/lib/build-id';
import { faseDaPagina, type EstadoPublicado } from '@/sw/releases';

/**
 * Estado e CHECAGEM da atualização do PWA — o miolo testável do modo `prompt`.
 *
 * POR QUE ISTO EXISTE (medido 2026-10-16, `telemetria_probes`): o iPhone do founder
 * (`fa401591…`) trocou de build 10 vezes em 47 dias — uma a cada 3–7 dias, sempre —
 * enquanto o desktop acompanhava os ~12 Publish/dia. Desde 09/10 20:12 ficou em
 * `index-92kmkUxx` por 16 boots. Não é defeito do build: é o desenho anterior.
 *   1. Só o NAVEGADOR procurava o SW novo (soft update na navegação). Ninguém
 *      chamava `registration.update()`; e no iOS standalone, voltar ao app é
 *      RESUMO de página suspensa, não navegação — não reconsulta o `/sw.js`.
 *   2. Quando acha, o SW novo precisa baixar o precache inteiro do build novo
 *      ANTES do próximo Publish: o host serve SÓ os assets do build atual (medido:
 *      `index-DYF3GvHG.js`, o build da manhã, já respondia 404 uma hora depois). No
 *      4G, em sessão curta, o install não fecha a tempo, um asset dá 404 e o
 *      install vira `redundant` em SILÊNCIO — nenhum SW em waiting, logo nenhum
 *      toast, e nenhum sinal em lugar nenhum.
 *   3. O toast dispensado só voltava no evento 'online' — nunca ao reabrir o app.
 *
 * O que muda (o modo `prompt` fica — ver vite.config.ts: nunca recarregar no meio
 * do turno): checagem ativa ao voltar pro app e a cada 30 min visível; o aviso
 * reaparece ao voltar pro app enquanto houver versão pronta; e o estado (build em
 * execução + fase) fica visível no menu do usuário, com "Verificar agora".
 *
 * Serve aos DOIS caminhos de registro do main.tsx (pwa-update.ts e o fallback),
 * ambos pela API nativa. Desde 2026-10-18 a fase vem do estado que o SW ponte
 * PUBLICA (`src/sw/releases.ts`), não mais de um SW em waiting.
 */

export type FaseAtualizacao =
  /** Sem service worker neste ambiente (dev, preview, browser sem suporte). */
  | 'inativo'
  | 'em_dia'
  | 'verificando'
  /** Um SW novo está instalando (baixando o precache do build novo). */
  | 'baixando'
  /** SW novo em waiting — o operador pode atualizar. */
  | 'pronta'
  /** O install do SW novo morreu (`redundant` antes de `installed`). */
  | 'falhou';

export interface EstadoAtualizacao {
  fase: FaseAtualizacao;
  /** Build que ESTE documento executa (`index-<hash>`), mesmo eixo do `build_id`. */
  buildId: string;
  /** Build que o servidor entrega — só conhecido após uma checagem manual. */
  buildServidor: string | null;
  /** Carimbo ordenável (`app-build-em`) do build em execução — para o build mínimo. */
  buildEm: string | null;
  /** Carimbo do build que o servidor entrega — junto do `buildServidor`. */
  buildServidorEm: string | null;
  ultimaVerificacaoEm: number | null;
}

/** id fixo → o Sonner deduplica: reabrir NÃO empilha, apenas atualiza o mesmo toast. */
export const UPDATE_TOAST_ID = 'pwa-update-available';
const INTERVALO_CHECAGEM_MS = 30 * 60_000;
/** Throttle das checagens AUTOMÁTICAS (voltar pro app várias vezes seguidas). */
const MIN_ENTRE_CHECAGENS_MS = 5 * 60_000;

type Ouvinte = () => void;

let estado: EstadoAtualizacao = {
  fase: 'inativo',
  buildId: resolverBuildId(),
  buildServidor: null,
  buildEm: resolverBuildEm(),
  buildServidorEm: null,
  ultimaVerificacaoEm: null,
};
const ouvintes = new Set<Ouvinte>();
let aplicador: (() => void) | null = null;
let verificador: ((forcar: boolean) => Promise<FaseAtualizacao>) | null = null;

function definir(parcial: Partial<EstadoAtualizacao>): void {
  const anterior = estado.fase;
  estado = { ...estado, ...parcial };
  if (parcial.fase && parcial.fase !== anterior && FASES_RASTREADAS.has(parcial.fase)) {
    // Sensor do incidente de 2026-10-16: sem ele, `falhou` e "nunca procurou" são o
    // mesmo silêncio. `build_id` (o build EXECUTANDO) já vai como super property.
    track('pwa.atualizacao', { fase: parcial.fase });
  }
  ouvintes.forEach((o) => o());
}
const FASES_RASTREADAS = new Set<FaseAtualizacao>(['baixando', 'pronta', 'falhou']);

export function obterEstadoAtualizacao(): EstadoAtualizacao {
  return estado;
}

export function assinarEstadoAtualizacao(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

function online(nav: Navigator | undefined): boolean {
  return !nav || nav.onLine !== false;
}

/**
 * Mostra o toast "Nova versão disponível". Offline não mostra (o reload só
 * re-serviria o cache velho) — reabre no 'online' ou ao voltar pro app.
 */
function mostrarAvisoAtualizacao(nav: Navigator | undefined = globalThis.navigator): void {
  if (estado.fase !== 'pronta' || !aplicador || !online(nav)) return;
  const aplicar = aplicador;
  toast('Nova versão disponível', {
    id: UPDATE_TOAST_ID,
    description: 'Atualize quando terminar a tarefa atual.',
    duration: Infinity,
    action: { label: 'Atualizar', onClick: () => aplicarAtualizacao(aplicar) },
  });
}

/** Marca versão pronta e avisa. Idempotente (o caminho workbox e o nativo podem chamar os dois). */
function marcarAtualizacaoPronta(aplicar: () => void, nav?: Navigator): void {
  aplicador = aplicar;
  if (estado.fase !== 'pronta') definir({ fase: 'pronta' });
  mostrarAvisoAtualizacao(nav);
}

/** Clique em "Atualizar": o SW em waiting assume e a página recarrega. */
export function aplicarAtualizacao(aplicar: (() => void) | null = aplicador): void {
  if (!aplicar) return;
  track('pwa.atualizacao', { fase: 'aceita' });
  aplicar();
}

/**
 * Checagem MANUAL (menu "Verificar agora"): ignora o throttle e lê também o build
 * que o servidor entrega, pra o operador ver "você: X · servidor: Y".
 */
export async function verificarAtualizacaoAgora(): Promise<FaseAtualizacao> {
  const servidor = await lerCarimbosDoServidor();
  if (servidor) definir({ buildServidor: servidor.buildId, buildServidorEm: servidor.buildEm });
  return verificador ? verificador(true) : estado.fase;
}

/**
 * Lê o index.html que o SERVIDOR entrega agora: o entry (`build_id`) e o carimbo
 * (`app-build-em`). O query param único tira o pedido do precache do SW (o precache
 * casaria `/` → index.html velho) e `no-store` do HTTP cache. Falha ou HTML sem entry =
 * null (ausência de dado, nunca "igual"); carimbo ausente vem `null` à parte.
 */
export async function lerCarimbosDoServidor(
  f: typeof fetch = globalThis.fetch,
): Promise<{ buildId: string; buildEm: string | null } | null> {
  try {
    const r = await f(`/?versao=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const html = await r.text();
    const id = extrairBuildId([html]);
    return id.startsWith('index-') ? { buildId: id, buildEm: extrairBuildEm(html) } : null;
  } catch {
    return null;
  }
}

/** Só o entry do servidor — a leitura original, mantida para quem só quer o `build_id`. */
export async function lerBuildDoServidor(f: typeof fetch = globalThis.fetch): Promise<string | null> {
  return (await lerCarimbosDoServidor(f))?.buildId ?? null;
}

/**
 * Momento SEGURO para aplicar sozinho (sem clique): o app voltou do segundo plano
 * depois de ficar oculto por este tempo E a fila offline está vazia E nenhum campo
 * da tela está preenchido (`semCamposPreenchidos`). Visível o tempo todo = nunca
 * recarrega sozinho — o motivo do modo `prompt` segue de pé.
 */
const AUTO_APLICAR_APOS_OCULTO_MS = 30 * 60_000;

/**
 * Nenhum campo preenchido na tela? P2 do Codex (2026-10-18): fila vazia + 30 min
 * oculto NÃO bastam — o conferente digita lote/validade, bloqueia o celular e volta;
 * a fila está vazia porque ele ainda não confirmou, e o reload perderia os campos
 * (estado React, fora do localStorage). Conservador por desenho: QUALQUER campo
 * de texto/número/data/select com valor (inclusive uma busca) segura o reload —
 * aí o operador vê o toast e decide.
 */
export function semCamposPreenchidos(doc: Pick<Document, 'querySelectorAll'> | undefined = globalThis.document): boolean {
  if (!doc) return false;
  const campos = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  for (const c of Array.from(campos)) {
    const tipo = (c as HTMLInputElement).type ?? '';
    if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(tipo)) continue;
    if ((c as HTMLInputElement).readOnly || c.disabled) continue;
    if (typeof c.value === 'string' && c.value.trim() !== '') return false;
  }
  return true;
}

/** Fila offline vazia? Import dinâmico: a fila não precisa entrar no entry. */
async function filaOfflineVazia(): Promise<boolean> {
  try {
    const m = await import('@/lib/offline-queue');
    return (await m.getOfflineQueueDepth()) === 0;
  } catch {
    return false; // sem leitura = não arrisca
  }
}

/** Dependências injetáveis — o teste roda sem browser. */
export interface DepsAcompanhamento {
  /** Aplicar a versão pronta (ver `aplicadorPadrao`). */
  aplicar: () => void;
  agora?: () => number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>;
  nav?: Navigator;
  /** Onde chegam as mensagens do SW (`RELEASE_ESTADO`). */
  container?: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener' | 'controller'>;
  filaVazia?: () => Promise<boolean>;
  /** Nenhum campo preenchido na tela (ver `semCamposPreenchidos`). */
  telaLimpa?: () => boolean;
  intervaloMs?: number;
  minEntreChecagensMs?: number;
  autoAplicarAposOcultoMs?: number;
}

function ehEstadoPublicado(d: unknown): d is EstadoPublicado {
  return typeof d === 'object' && d !== null && (d as { type?: unknown }).type === 'RELEASE_ESTADO';
}

/**
 * Acompanha um registro de SW: deriva a fase do estado que o SW PUBLICA (release
 * promovida/preparando — `src/sw/releases.ts`), detecta install que morreu, ARMA a
 * checagem ativa de update (voltar pro app, 'online', intervalo enquanto visível) e
 * aplica sozinho só no momento seguro. Devolve a função que desarma tudo.
 */
export function acompanharRegistro(reg: ServiceWorkerRegistration, deps: DepsAcompanhamento): () => void {
  const agora = deps.agora ?? Date.now;
  const doc = deps.doc ?? globalThis.document;
  const win = deps.win ?? globalThis.window;
  const nav = deps.nav ?? globalThis.navigator;
  const container = deps.container ?? nav?.serviceWorker;
  const filaVazia = deps.filaVazia ?? filaOfflineVazia;
  const telaLimpa = deps.telaLimpa ?? (() => semCamposPreenchidos());
  const intervaloMs = deps.intervaloMs ?? INTERVALO_CHECAGEM_MS;
  const minEntre = deps.minEntreChecagensMs ?? MIN_ENTRE_CHECAGENS_MS;
  const autoAposMs = deps.autoAplicarAposOcultoMs ?? AUTO_APLICAR_APOS_OCULTO_MS;
  aplicador = deps.aplicar;
  let ultimaChecagem = agora();
  let emVoo: Promise<FaseAtualizacao> | null = null;
  let estadoSW: EstadoPublicado | null = null;
  let ocultoDesde: number | null = doc?.visibilityState === 'hidden' ? agora() : null;

  const derivar = (): FaseAtualizacao => {
    // SW à moda antiga em waiting (ex.: rollback para o SW do Workbox): ainda vale.
    if (reg.waiting && reg.active) return 'pronta';
    if (estadoSW) return faseDaPagina(estado.buildId, estadoSW);
    if (reg.installing && reg.active) return 'baixando';
    return 'em_dia';
  };
  const aplicarDerivada = () => {
    const fase = derivar();
    if (fase === 'pronta') marcarAtualizacaoPronta(deps.aplicar, nav);
    else definir({ fase });
  };
  const pedirEstado = () => {
    const alvo = reg.active ?? container?.controller ?? null;
    alvo?.postMessage({ type: 'ESTADO' });
  };
  const aoMensagem = (ev: Event) => {
    const dado = (ev as MessageEvent).data;
    if (!ehEstadoPublicado(dado)) return;
    estadoSW = dado;
    aplicarDerivada();
  };

  const acompanharInstalando = (sw: ServiceWorker | null) => {
    if (!sw) return;
    let instalou = false;
    aplicarDerivada(); // SW novo instalando com um ativo no controle → 'baixando'
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') {
        instalou = true;
        pedirEstado();
        aplicarDerivada();
      } else if (sw.state === 'redundant' && !instalou) {
        // O install do próprio SW morreu (raro: o SW ponte instala sem baixar nada).
        definir({ fase: reg.waiting && reg.active ? 'pronta' : 'falhou' });
      }
    });
  };

  const verificar = (forcar: boolean): Promise<FaseAtualizacao> => {
    if (emVoo) return emVoo;
    if (!online(nav)) return Promise.resolve(estado.fase);
    if (!forcar && agora() - ultimaChecagem < minEntre) return Promise.resolve(estado.fase);
    ultimaChecagem = agora();
    const faseAntes = estado.fase;
    if (faseAntes !== 'baixando' && faseAntes !== 'pronta') definir({ fase: 'verificando' });
    emVoo = Promise.resolve()
      .then(() => reg.update())
      .then(
        () => undefined,
        // `update()` rejeita se o /sw.js não veio (rede) — ausência de dado:
        // volta à fase derivada, sem inventar "em dia" nem "falhou".
        () => undefined,
      )
      .then(() => {
        pedirEstado();
        aplicarDerivada();
        definir({ ultimaVerificacaoEm: agora() });
        return estado.fase;
      })
      .finally(() => {
        emVoo = null;
      });
    return emVoo;
  };
  verificador = verificar;

  const aoMudarVisibilidade = () => {
    if (doc?.visibilityState === 'hidden') {
      ocultoDesde = agora();
      return;
    }
    if (doc?.visibilityState !== 'visible') return;
    const tempoOculto = ocultoDesde === null ? 0 : agora() - ocultoDesde;
    ocultoDesde = null;
    void verificar(false);
    if (estado.fase === 'pronta' && tempoOculto >= autoAposMs && online(nav)) {
      void filaVazia().then((vazia) => {
        if (vazia && telaLimpa() && estado.fase === 'pronta' && aplicador) {
          track('pwa.atualizacao', { fase: 'auto' });
          aplicador();
        } else {
          mostrarAvisoAtualizacao(nav);
        }
      });
      return;
    }
    mostrarAvisoAtualizacao(nav);
  };
  const aoFicarOnline = () => {
    void verificar(true);
    mostrarAvisoAtualizacao(nav);
  };
  const aoAcharUpdate = () => acompanharInstalando(reg.installing);
  const aoTrocarControlador = () => pedirEstado();

  reg.addEventListener('updatefound', aoAcharUpdate);
  container?.addEventListener('message', aoMensagem);
  container?.addEventListener('controllerchange', aoTrocarControlador);
  doc?.addEventListener('visibilitychange', aoMudarVisibilidade);
  win?.addEventListener('online', aoFicarOnline);
  const timer = win?.setInterval(() => {
    if (doc?.visibilityState === 'visible') void verificar(false);
  }, intervaloMs);

  if (reg.installing) acompanharInstalando(reg.installing);
  aplicarDerivada();
  pedirEstado();

  return () => {
    reg.removeEventListener('updatefound', aoAcharUpdate);
    container?.removeEventListener('message', aoMensagem);
    container?.removeEventListener('controllerchange', aoTrocarControlador);
    doc?.removeEventListener('visibilitychange', aoMudarVisibilidade);
    win?.removeEventListener('online', aoFicarOnline);
    if (timer !== undefined) win?.clearInterval(timer);
    if (verificador === verificar) verificador = null;
  };
}

/**
 * Aplicar a versão pronta. Com o SW ponte, o build novo já está PROMOVIDO: basta
 * uma navegação (reload) para receber o HTML novo. Se houver um SW à moda antiga em
 * waiting (rollback para o SW do Workbox), pede SKIP_WAITING e recarrega quando ele
 * assumir — o SW antigo escuta exatamente `{type: 'SKIP_WAITING'}`.
 */
export function aplicadorPadrao(
  reg: ServiceWorkerRegistration,
  sw: Pick<ServiceWorkerContainer, 'addEventListener'> | undefined = globalThis.navigator?.serviceWorker,
  recarregar: () => void = () => globalThis.location.reload(),
): () => void {
  return () => {
    const waiting = reg.waiting;
    if (waiting && sw) {
      sw.addEventListener('controllerchange', () => recarregar(), { once: true });
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    recarregar();
  };
}

/** Só para teste: volta o singleton ao estado inicial. */
export function __resetEstadoAtualizacao(buildId = resolverBuildId(), buildEm = resolverBuildEm()): void {
  estado = { fase: 'inativo', buildId, buildServidor: null, buildEm, buildServidorEm: null, ultimaVerificacaoEm: null };
  aplicador = null;
  verificador = null;
  ouvintes.clear();
}

const ROTULO_FASE: Record<FaseAtualizacao, string> = {
  inativo: 'sem atualização automática',
  em_dia: 'em dia',
  verificando: 'verificando…',
  baixando: 'baixando nova versão…',
  pronta: 'nova versão pronta',
  falhou: 'falha ao baixar a nova versão',
};

/**
 * Texto do menu do usuário — puro, pra o staff dizer "em que build estou" sem
 * DevTools. `build` é o hash curto (sem `index-`), o mesmo que aparece no
 * `build_id` do PostHog e no `telemetria_probes`. Quando uma checagem manual
 * leu o servidor e ele difere do que roda aqui, diz isso explicitamente — é o
 * único caso em que "em dia" seria mentira.
 */
export function descreverEstadoAtualizacao(e: EstadoAtualizacao): { build: string; situacao: string } {
  const curto = (id: string) => id.replace(/^index-/, '');
  const build = curto(e.buildId);
  const defasado = e.buildServidor !== null && e.buildServidor !== e.buildId;
  if (defasado && (e.fase === 'em_dia' || e.fase === 'falhou' || e.fase === 'inativo')) {
    return { build, situacao: `desatualizado (servidor: ${curto(e.buildServidor as string)})` };
  }
  return { build, situacao: ROTULO_FASE[e.fase] };
}

/**
 * Indicador do topbar: aparece SÓ quando há algo a comunicar (o padrão do
 * `NetworkStatusIndicator` — some no estado normal). `baixando` e `pronta` são as
 * fases em que o operador ganha algo olhando; o resto (em dia, verificando, inativo)
 * é ruído, e `falhou` tem o seu lugar no menu ("Reparar app").
 */
export function faseDoIndicador(fase: FaseAtualizacao): 'baixando' | 'pronta' | null {
  return fase === 'baixando' || fase === 'pronta' ? fase : null;
}

/**
 * "Reparar app" só quando o install do build novo MORREU e há rede. Offline, apagar o
 * SW e os caches deixaria o app sem nada para abrir — o reparo precisa baixar tudo de
 * novo pela rede logo em seguida.
 */
export function podeReparar(fase: FaseAtualizacao, nav: Navigator | undefined = globalThis.navigator): boolean {
  return fase === 'falhou' && online(nav);
}

export interface DepsReparo {
  sw?: Pick<ServiceWorkerContainer, 'getRegistrations'>;
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  nav?: Navigator;
  recarregar?: () => void;
}

/**
 * Reparo do app preso num install que não fecha: desregistra o SW, apaga os caches
 * (precache do Workbox + runtime) e recarrega PELA REDE — sem SW no controle, a
 * navegação vai ao servidor e o build atual se instala do zero. É um clique explícito
 * do operador (o modo `prompt` não é violado).
 *
 * NÃO toca localStorage/IndexedDB: a fila offline (`offline-queue.ts`, localStorage)
 * sobrevive ao reparo, como sobrevive a qualquer reload.
 *
 * Devolve `false` sem fazer nada quando o reparo não se aplica (ver `podeReparar`).
 */
export async function repararApp(deps: DepsReparo = {}): Promise<boolean> {
  const nav = deps.nav ?? globalThis.navigator;
  if (!podeReparar(estado.fase, nav)) return false;
  const sw = deps.sw ?? nav?.serviceWorker;
  const cs = deps.caches ?? globalThis.caches;
  const recarregar = deps.recarregar ?? (() => globalThis.location.reload());
  track('pwa.atualizacao', { fase: 'reparo' });
  // allSettled: um registro/cache que não sai não pode impedir o resto nem o reload —
  // no pior caso o reload cai no mesmo estado de antes, nunca num pior.
  const regs = sw ? await sw.getRegistrations().catch(() => [] as readonly ServiceWorkerRegistration[]) : [];
  await Promise.allSettled(regs.map((r) => r.unregister()));
  if (cs) {
    const nomes = await cs.keys().catch(() => [] as string[]);
    await Promise.allSettled(nomes.map((n) => cs.delete(n)));
  }
  recarregar();
  return true;
}
