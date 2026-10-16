import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { extrairBuildId, resolverBuildId } from '@/lib/build-id';

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
 * Sem import de `virtual:pwa-register`: este módulo serve aos DOIS caminhos de
 * registro do main.tsx (workbox-window via pwa-update.ts, e o fallback nativo).
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
  ultimaVerificacaoEm: number | null;
}

/** id fixo → o Sonner deduplica: reabrir NÃO empilha, apenas atualiza o mesmo toast. */
export const UPDATE_TOAST_ID = 'pwa-update-available';
export const INTERVALO_CHECAGEM_MS = 30 * 60_000;
/** Throttle das checagens AUTOMÁTICAS (voltar pro app várias vezes seguidas). */
export const MIN_ENTRE_CHECAGENS_MS = 5 * 60_000;

type Ouvinte = () => void;

let estado: EstadoAtualizacao = {
  fase: 'inativo',
  buildId: resolverBuildId(),
  buildServidor: null,
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
export function mostrarAvisoAtualizacao(nav: Navigator | undefined = globalThis.navigator): void {
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
export function marcarAtualizacaoPronta(aplicar: () => void, nav?: Navigator): void {
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
  const buildServidor = await lerBuildDoServidor();
  if (buildServidor) definir({ buildServidor });
  return verificador ? verificador(true) : estado.fase;
}

/**
 * Lê o entry que o SERVIDOR entrega agora. O query param único tira o pedido do
 * precache do SW (o precache casaria `/` → index.html velho) e `no-store` do HTTP
 * cache. Falha = null (ausência de dado, nunca "igual").
 */
export async function lerBuildDoServidor(f: typeof fetch = globalThis.fetch): Promise<string | null> {
  try {
    const r = await f(`/?versao=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const id = extrairBuildId([await r.text()]);
    return id.startsWith('index-') ? id : null;
  } catch {
    return null;
  }
}

/** Dependências injetáveis — o teste roda sem browser. */
export interface DepsAcompanhamento {
  /** Ação de aplicar a versão pronta (workbox: `updateSW(true)`; nativo: SKIP_WAITING). */
  aplicar: () => void;
  agora?: () => number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>;
  nav?: Navigator;
  intervaloMs?: number;
  minEntreChecagensMs?: number;
}

/**
 * Acompanha um registro de SW: deriva a fase dos workers, detecta install que
 * morreu, e ARMA a checagem ativa de update (voltar pro app, 'online', intervalo
 * enquanto visível). Devolve a função que desarma tudo.
 */
export function acompanharRegistro(reg: ServiceWorkerRegistration, deps: DepsAcompanhamento): () => void {
  const agora = deps.agora ?? Date.now;
  const doc = deps.doc ?? globalThis.document;
  const win = deps.win ?? globalThis.window;
  const nav = deps.nav ?? globalThis.navigator;
  const intervaloMs = deps.intervaloMs ?? INTERVALO_CHECAGEM_MS;
  const minEntre = deps.minEntreChecagensMs ?? MIN_ENTRE_CHECAGENS_MS;
  aplicador = deps.aplicar;
  let ultimaChecagem = agora();
  let emVoo: Promise<FaseAtualizacao> | null = null;

  const derivar = (): FaseAtualizacao => {
    if (reg.waiting && reg.active) return 'pronta';
    if (reg.installing && reg.active) return 'baixando';
    return 'em_dia';
  };
  const aplicarDerivada = () => {
    const fase = derivar();
    if (fase === 'pronta') marcarAtualizacaoPronta(deps.aplicar, nav);
    else definir({ fase });
  };

  const acompanharInstalando = (sw: ServiceWorker | null) => {
    if (!sw) return;
    let instalou = false;
    // Primeira instalação (sem SW ativo) não é "atualização": não vira 'baixando'.
    if (reg.active) definir({ fase: 'baixando' });
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed') {
        instalou = true;
        aplicarDerivada();
      } else if (sw.state === 'redundant' && !instalou) {
        // O install morreu (asset 404 após um Publish no meio, app suspenso, quota).
        // Se ainda há uma versão anterior em waiting, ela continua valendo.
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
        () => aplicarDerivada(),
        () => {
          // `update()` rejeita se o /sw.js não veio (rede) — ausência de dado:
          // volta à fase derivada, sem inventar "em dia" nem "falhou".
          aplicarDerivada();
        },
      )
      .then(() => {
        definir({ ultimaVerificacaoEm: agora() });
        return estado.fase;
      })
      .finally(() => {
        emVoo = null;
      });
    return emVoo;
  };
  verificador = verificar;

  const aoVoltar = () => {
    if (doc?.visibilityState !== 'visible') return;
    void verificar(false);
    mostrarAvisoAtualizacao(nav);
  };
  const aoFicarOnline = () => {
    void verificar(true);
    mostrarAvisoAtualizacao(nav);
  };
  const aoAcharUpdate = () => acompanharInstalando(reg.installing);

  reg.addEventListener('updatefound', aoAcharUpdate);
  doc?.addEventListener('visibilitychange', aoVoltar);
  win?.addEventListener('online', aoFicarOnline);
  const timer = win?.setInterval(() => {
    if (doc?.visibilityState === 'visible') void verificar(false);
  }, intervaloMs);

  // Estado inicial: um SW pode já estar em waiting (instalou em sessão anterior)
  // ou instalando (o soft update desta navegação).
  if (reg.installing) acompanharInstalando(reg.installing);
  aplicarDerivada();

  return () => {
    reg.removeEventListener('updatefound', aoAcharUpdate);
    doc?.removeEventListener('visibilitychange', aoVoltar);
    win?.removeEventListener('online', aoFicarOnline);
    if (timer !== undefined) win?.clearInterval(timer);
    if (verificador === verificar) verificador = null;
  };
}

/**
 * Aplicar no caminho NATIVO (fallback do main.tsx, sem workbox-window): pede ao SW
 * em waiting que pule a espera e recarrega quando ele assumir. O SW gerado pelo
 * Workbox escuta exatamente `{type: 'SKIP_WAITING'}`.
 */
export function aplicadorNativo(
  reg: ServiceWorkerRegistration,
  sw: ServiceWorkerContainer = globalThis.navigator.serviceWorker,
  recarregar: () => void = () => globalThis.location.reload(),
): () => void {
  return () => {
    const waiting = reg.waiting;
    if (!waiting) return;
    sw.addEventListener('controllerchange', () => recarregar(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };
}

/** Só para teste: volta o singleton ao estado inicial. */
export function __resetEstadoAtualizacao(buildId = resolverBuildId()): void {
  estado = { fase: 'inativo', buildId, buildServidor: null, ultimaVerificacaoEm: null };
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
