import type { DataHealthCheck, HealthDomain, HealthLevel, HealthStatus } from './types';

const STATUS_RANK: Record<HealthStatus, number> = { ok: 0, stale: 1, unknown: 2, broken: 3 };

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Nível do badge. SEM VERDE SILENCIOSO: vazio ou qualquer unknown/broken => red. */
export function badgeLevel(checks: DataHealthCheck[]): HealthLevel {
  if (checks.length === 0) return 'red';
  if (checks.some(c => c.status === 'broken' || c.status === 'unknown')) return 'red';
  if (checks.some(c => c.status === 'stale')) return 'amber';
  return 'green';
}

export function isHealthy(checks: DataHealthCheck[]): boolean {
  return checks.length > 0 && checks.every(c => c.status === 'ok');
}

/**
 * Diagnóstico (último erro, causa provável, como resolver) só vale para check
 * NÃO-ok. Um check saudável não pode exibir falha transitória já recuperada — ex:
 * a órfã `orphaned_running_timeout` que o fin-sync-watchdog marca e que o `last_error`
 * da RPC carrega indefinidamente — como se fosse problema atual.
 */
export function shouldShowDiagnostics(check: DataHealthCheck): boolean {
  return check.status !== 'ok';
}

export interface DomainRollup { domain: HealthDomain; status: HealthStatus; checks: DataHealthCheck[]; }

export function rollupDomain(checks: DataHealthCheck[]): DomainRollup[] {
  const byDomain = new Map<HealthDomain, DataHealthCheck[]>();
  for (const c of checks) {
    const arr = byDomain.get(c.domain) ?? [];
    arr.push(c);
    byDomain.set(c.domain, arr);
  }
  return [...byDomain.entries()].map(([domain, list]) => ({
    domain,
    status: list.reduce<HealthStatus>((acc, c) => worst(acc, c.status), 'ok'),
    checks: list,
  }));
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return 'desconhecido';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return `há ${Math.round(seconds / 86400)} dias`;
}
