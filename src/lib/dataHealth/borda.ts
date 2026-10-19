import type { Database } from '@/integrations/supabase/types';
import type { DataHealthCheck, HealthDomain, HealthStatus } from './types';

type LinhaRpc = Database['public']['Functions']['get_data_health']['Returns'][number];

// Espelham os literais da função SQL (última versão: migration 20261005150000_data_health_vendas_empurradas_v2).
const DOMINIOS: readonly HealthDomain[] = ['financeiro', 'omie_sync', 'carteira', 'estoque', 'vendas', 'alertas'];
const STATUS: readonly HealthStatus[] = ['ok', 'stale', 'broken', 'unknown'];
const SEVERIDADES: readonly DataHealthCheck['severity'][] = ['critical', 'warning', 'info'];

function umDe<T extends string>(lista: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (lista as readonly string[]).includes(v);
}

/**
 * Borda da RPC `get_data_health`: o `Returns` gerado tipa `domain`/`status`/`severity` como `string`
 * e é não-nulo demais (os campos "só audiência full" chegam NULL). Valor fora do vocabulário LANÇA
 * — o badge do topbar fica vermelho e a página mostra o erro — nunca vira check inventado.
 */
export function paraDataHealthCheck(l: LinhaRpc): DataHealthCheck {
  if (!umDe(DOMINIOS, l.domain)) {
    throw new Error(`get_data_health: domain "${String(l.domain)}" fora do vocabulário (source ${l.source})`);
  }
  if (!umDe(STATUS, l.status)) {
    throw new Error(`get_data_health: status "${String(l.status)}" fora do vocabulário (source ${l.source})`);
  }
  if (!umDe(SEVERIDADES, l.severity)) {
    throw new Error(`get_data_health: severity "${String(l.severity)}" fora do vocabulário (source ${l.source})`);
  }
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
