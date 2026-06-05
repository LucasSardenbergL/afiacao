import posthog from 'posthog-js';
import { logger } from '@/lib/logger';

/**
 * Wrapper de telemetria sobre PostHog. Centraliza:
 *  - inicialização condicional (só roda em production OU quando VITE_POSTHOG_KEY existe)
 *  - track de eventos com convenção de nomes `<area>.<action>` (ex: `cmdk.opened`)
 *  - identify quando o usuário loga (associa userId + properties)
 *  - reset quando o usuário desloga
 *  - groups por empresa ativa (multi-tenant analytics)
 *
 * Convenção de nomes de eventos (importante pra dashboards consistentes):
 *   <area>.<action>          ex: pedido.criado, cmdk.opened, picking.scanned
 *   <area>.<action>_<noun>   ex: shortcut.triggered, theme.changed
 *
 * Sempre lowercase, snake_case interno, ponto separa namespace.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

let initialized = false;

export function initAnalytics(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  if (!KEY) {
    // Sem token = telemetria desligada. Útil em dev sem .env configurado.
    logger.info('Analytics desativado (VITE_POSTHOG_KEY ausente)');
    return;
  }

  try {
    posthog.init(KEY, {
      api_host: HOST,
      // Capture page views automaticamente quando rota muda
      capture_pageview: false,            // gerenciamos manualmente via PageViewTracker
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
      loaded: (ph) => {
        if (import.meta.env.DEV) {
          ph.opt_out_capturing();
        }
      },
    });
    initialized = true;
  } catch (e) {
    logger.error('Falha ao inicializar PostHog', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Track de evento. Convenção: `<area>.<action>`.
 * Properties devem ser primitivos serializáveis (string/number/boolean).
 *
 *   track('cmdk.opened');
 *   track('pedido.criado', { valor: 1234.5, num_itens: 3, empresa: 'oben' });
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.capture(event, properties);
  } catch (e) {
    logger.warn('Falha ao enviar evento', { event, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Captura uma exceção no PostHog Error Tracking. No-op se telemetria desligada
 * (DEV opt-out / sem token). Use no ErrorBoundary e em catch-blocks relevantes.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.captureException(error, context);
  } catch (e) {
    logger.warn('Falha ao capturar exceção no analytics', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Identify após login. Properties ficam no perfil persistente (`$set` semantics).
 */
export function identify(
  userId: string,
  properties?: { email?: string | null; role?: string | null; commercial_role?: string | null; name?: string | null },
): void {
  if (!initialized) return;
  try {
    posthog.identify(userId, properties as Record<string, unknown>);
  } catch (e) {
    logger.warn('Falha ao identificar usuário no analytics', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Group por empresa ativa — permite analytics multi-tenant
 * (filtrar dashboards por empresa, comparar Oben vs Colacor vs SC).
 */
export function setActiveCompany(companyId: string): void {
  if (!initialized) return;
  try {
    posthog.group('company', companyId);
  } catch (e) {
    logger.warn('Falha ao setar grupo da empresa', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Page view — chamar a cada route change (PageViewTracker faz automaticamente).
 */
export function pageview(path: string): void {
  if (!initialized) return;
  try {
    posthog.capture('$pageview', { $current_url: path });
  } catch (e) {
    logger.warn('Falha ao enviar pageview', { path, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Reset ao deslogar (limpa session, cria distinct_id novo).
 */
export function resetAnalytics(): void {
  if (!initialized) return;
  try {
    posthog.reset();
  } catch (e) {
    logger.warn('Falha ao resetar analytics', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Útil em casos onde você precisa do client raw (feature flags, etc.) */
export function getPosthog() {
  return initialized ? posthog : null;
}
