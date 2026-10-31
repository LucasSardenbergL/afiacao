import type { Database } from '@/integrations/supabase/types';
import type { DataHealthCheck, HealthDomain, HealthStatus } from './types';

type LinhaRpc = Database['public']['Functions']['get_data_health']['Returns'][number];

// Espelham os literais de `_data_health_compute` em PROD (conferido via psql-ro em 2026-10-31:
// `analytics` vem dos sensores do outbox desde 20260829012000_analytics_outbox_perda_visivel).
const DOMINIOS: readonly HealthDomain[] = ['financeiro', 'omie_sync', 'carteira', 'estoque', 'vendas', 'alertas', 'analytics'];
const STATUS: readonly HealthStatus[] = ['ok', 'stale', 'broken', 'unknown'];
const SEVERIDADES: readonly DataHealthCheck['severity'][] = ['critical', 'warning', 'info'];

function umDe<T extends string>(lista: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (lista as readonly string[]).includes(v);
}

function foraDoVocabulario(l: LinhaRpc, campo: string, valor: unknown): DataHealthCheck {
  return {
    source: l.source,
    domain: 'fora_do_vocabulario',
    status: 'unknown',
    severity: 'critical',
    age_seconds: null,
    expected_max_age_seconds: null,
    freshness_basis: null,
    message: `Check "${l.source}" ilegível no app: ${campo} "${String(valor)}" fora do vocabulário (atualize src/lib/dataHealth/borda.ts)`,
    last_error: null,
    probable_cause: null,
    how_to_fix: null,
  };
}

/**
 * Borda da RPC `get_data_health`: o `Returns` gerado tipa `domain`/`status`/`severity` como `string`
 * e é não-nulo demais (os campos "só audiência full" chegam NULL).
 *
 * Valor fora do vocabulário degrada SÓ aquela linha para `unknown`/critical no domínio
 * `fora_do_vocabulario` — o badge fica vermelho e a página diz qual check e qual valor; nunca vira
 * check verde nem herda o status que o app não sabe ler. Antes ele LANÇAVA, e um único domínio novo
 * no banco (`analytics`) apagava a página, o badge e os banners de TODAS as fontes (desde o #3187).
 */
export function paraDataHealthCheck(l: LinhaRpc): DataHealthCheck {
  if (!umDe(DOMINIOS, l.domain)) return foraDoVocabulario(l, 'domain', l.domain);
  if (!umDe(STATUS, l.status)) return foraDoVocabulario(l, 'status', l.status);
  if (!umDe(SEVERIDADES, l.severity)) return foraDoVocabulario(l, 'severity', l.severity);
  // `?? null`: o tipo gerado diz `number`/`string`, o banco manda NULL nesses campos.
  return {
    source: l.source,
    domain: l.domain,
    status: l.status,
    severity: l.severity,
    age_seconds: l.age_seconds ?? null,
    expected_max_age_seconds: l.expected_max_age_seconds ?? null,
    freshness_basis: l.freshness_basis ?? null,
    message: l.message,
    last_error: l.last_error ?? null,
    probable_cause: l.probable_cause ?? null,
    how_to_fix: l.how_to_fix ?? null,
  };
}
