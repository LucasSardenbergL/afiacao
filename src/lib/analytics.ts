import type { PostHog } from 'posthog-js';
import { logger } from '@/lib/logger';

/**
 * Wrapper de telemetria sobre PostHog. Centraliza:
 *  - inicialização condicional (só roda em production OU quando VITE_POSTHOG_KEY existe)
 *  - track de eventos com convenção de nomes `<area>.<action>` (ex: `cmdk.opened`)
 *  - identify quando o usuário loga (associa userId + properties)
 *  - reset quando o usuário desloga
 *  - groups por empresa ativa (multi-tenant analytics)
 *
 * O posthog-js (~60KB gzip) é carregado via dynamic import DEPOIS do primeiro
 * paint (initAnalytics é chamado num useEffect do App) pra ficar fora do
 * caminho crítico do boot. Eventos disparados antes do SDK terminar de
 * carregar entram numa fila curta e são drenados no load — o primeiro
 * pageview não se perde.
 *
 * Trade-off consciente do lazy: um crash no BOOT antes do SDK carregar só
 * enfileira o captureException — se o usuário recarregar antes do load
 * completar, esse evento se perde (o logger ainda registra no console).
 *
 * Convenção de nomes de eventos (importante pra dashboards consistentes):
 *   <area>.<action>          ex: pedido.criado, cmdk.opened, picking.scanned
 *   <area>.<action>_<noun>   ex: shortcut.triggered, theme.changed
 *
 * Sempre lowercase, snake_case interno, ponto separa namespace.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

let ph: PostHog | null = null;
let initStarted = false;
let queueOverflowWarned = false;

/** Fila de eventos pré-init (cap pra não acumular sem limite se o load falhar). */
const preInitQueue: Array<(p: PostHog) => void> = [];
const PRE_INIT_QUEUE_MAX = 50;

/** Executa agora se o SDK já carregou; senão enfileira (só quando há KEY — sem
 *  token a telemetria está desligada e enfileirar seria vazamento de memória). */
function withPosthog(fn: (p: PostHog) => void, label: string): void {
  if (ph) {
    try {
      fn(ph);
    } catch (e) {
      logger.warn(`Falha no analytics (${label})`, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (!KEY || typeof window === 'undefined') return;
  if (preInitQueue.length < PRE_INIT_QUEUE_MAX) {
    preInitQueue.push(fn);
  } else if (!queueOverflowWarned) {
    queueOverflowWarned = true;
    logger.warn('Fila pré-init do analytics cheia — eventos novos descartados até o SDK carregar', {
      label,
    });
  }
}

export function initAnalytics(): void {
  if (initStarted) return;
  if (typeof window === 'undefined') return;
  if (!KEY) {
    // Sem token = telemetria desligada. Útil em dev sem .env configurado.
    logger.info('Analytics desativado (VITE_POSTHOG_KEY ausente)');
    return;
  }
  initStarted = true;

  import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: HOST,
        // Capture page views automaticamente quando rota muda
        capture_pageview: false, // gerenciamos manualmente via PageViewTracker
        capture_pageleave: true,
        // Session Replay (vem com o plano free; mascarar inputs por padrão pra privacidade)
        session_recording: {
          maskAllInputs: true,
          maskInputOptions: {
            password: true,
            email: false,
          },
        },
        autocapture: {
          // Capturar clicks em botões e links automaticamente (sem precisar instrumentar tudo)
          dom_event_allowlist: ['click', 'submit', 'change'],
          // NÃO capturar texto livre — privacidade
          css_selector_allowlist: ['button', 'a', 'select', 'input[type="checkbox"]', '[role="button"]'],
        },
        // Identificar usuários só após login (não criar perfil pra anônimo)
        person_profiles: 'identified_only',
        // Não enviar em desenvolvimento por padrão (opt-out explícito em DEV pra evitar
        // poluir dashboard de produção). Pra testar local, comente o opt_out abaixo.
        loaded: (instance) => {
          if (import.meta.env.DEV) {
            instance.opt_out_capturing();
          }
        },
      });
      ph = posthog;
      // Drena os eventos que chegaram enquanto o SDK baixava (1º pageview etc.)
      const queued = preInitQueue.splice(0);
      for (const fn of queued) {
        try {
          fn(posthog);
        } catch {
          // evento pré-init com erro não pode derrubar o drain dos demais
        }
      }
    })
    .catch((e) => {
      initStarted = false;
      logger.error('Falha ao carregar/inicializar PostHog', {
        error: e instanceof Error ? e.message : String(e),
      });
      // Wi-Fi instável é o cotidiano do vendedor externo: re-tenta quando a
      // rede voltar — sem isso a telemetria morreria pra sessão inteira (o
      // único caller é o useEffect de mount do App) e a fila pré-init ficaria
      // retida sem nunca drenar.
      window.addEventListener('online', () => initAnalytics(), { once: true });
    });
}

/**
 * Track de evento. Convenção: `<area>.<action>`.
 * Properties devem ser primitivos serializáveis (string/number/boolean).
 *
 *   track('cmdk.opened');
 *   track('pedido.criado', { valor: 1234.5, num_itens: 3, empresa: 'oben' });
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  withPosthog((p) => p.capture(event, properties), `track:${event}`);
}

/**
 * Captura uma exceção no PostHog Error Tracking. No-op se telemetria desligada
 * (DEV opt-out / sem token). Use no ErrorBoundary e em catch-blocks relevantes.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  withPosthog((p) => p.captureException(error, context), 'captureException');
}

/**
 * Identify após login. Properties ficam no perfil persistente (`$set` semantics).
 */
export function identify(
  userId: string,
  properties?: { email?: string | null; role?: string | null; commercial_role?: string | null; name?: string | null },
): void {
  withPosthog((p) => p.identify(userId, properties as Record<string, unknown>), 'identify');
}

/**
 * Group por empresa ativa — permite analytics multi-tenant
 * (filtrar dashboards por empresa, comparar Oben vs Colacor vs SC).
 */
export function setActiveCompany(companyId: string): void {
  withPosthog((p) => p.group('company', companyId), 'setActiveCompany');
}

/**
 * Page view — chamar a cada route change (PageViewTracker faz automaticamente).
 */
export function pageview(path: string): void {
  withPosthog((p) => p.capture('$pageview', { $current_url: path }), 'pageview');
}

/**
 * Reset ao deslogar (limpa session, cria distinct_id novo).
 */
export function resetAnalytics(): void {
  withPosthog((p) => p.reset(), 'reset');
}

