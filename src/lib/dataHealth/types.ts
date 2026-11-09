export type HealthStatus = 'ok' | 'stale' | 'broken' | 'unknown';
/** `fora_do_vocabulario`: sentinela da borda (borda.ts) para linha que o app não sabe ler — nunca vem do banco. */
export type HealthDomain = 'financeiro' | 'omie_sync' | 'carteira' | 'estoque' | 'vendas' | 'alertas' | 'analytics' | 'fora_do_vocabulario';
export type HealthLevel = 'green' | 'amber' | 'red';

/** Um check individual retornado pela RPC get_data_health. */
export interface DataHealthCheck {
  source: string;
  domain: HealthDomain;
  status: HealthStatus;
  age_seconds: number | null;
  expected_max_age_seconds: number | null;
  freshness_basis: string | null;
  message: string;            // sempre presente (banner-safe)
  last_error: string | null;       // só audiência full
  probable_cause: string | null;   // só audiência full
  how_to_fix: string | null;       // só audiência full
  severity: 'critical' | 'warning' | 'info';
}
