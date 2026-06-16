import type { CronSaude, SyncSaude, CoverageSaude, SaudeStatus, SaudeNivel } from './types';

const FALHA = new Set(['failed', 'failure', 'error']);

/**
 * Status de um cron. `maxAgeHours` = idade máxima tolerada antes de alertar
 * (nightly = 48; mensal = null → não alerta por idade no dia-a-dia).
 */
export function statusCron(
  c: Pick<CronSaude, 'last_status' | 'age_hours'>,
  maxAgeHours: number | null,
): SaudeStatus {
  if (!c.last_status) return { nivel: 'yellow', acao: 'Nunca rodou — agendar/invocar no Lovable.' };
  if (FALHA.has(c.last_status.toLowerCase())) {
    return { nivel: 'red', acao: 'Última execução falhou — ver logs / reinvocar no Lovable.' };
  }
  if (maxAgeHours != null && c.age_hours != null && c.age_hours > maxAgeHours) {
    return { nivel: 'red', acao: `Atrasado — não roda há ${Math.round(c.age_hours)}h.` };
  }
  return { nivel: 'green', acao: 'OK.' };
}

export function statusSync(s: Pick<SyncSaude, 'age_hours' | 'stale_count'>): SaudeStatus {
  if (s.age_hours == null) return { nivel: 'yellow', acao: 'Sem sync registrado da carteira.' };
  if (s.age_hours > 48 || s.stale_count > 0) {
    return { nivel: 'red', acao: 'Sync da carteira velho (>48h) — rodar carteira-rebuild.' };
  }
  if (s.age_hours > 24) return { nivel: 'yellow', acao: 'Sync entre 24-48h — acompanhar.' };
  return { nivel: 'green', acao: 'OK.' };
}

export function statusCoverage(c: CoverageSaude): SaudeStatus {
  if (c.carteira === 0) return { nivel: 'yellow', acao: 'Carteira vazia — rodar carteira-rebuild.' };
  if (c.fcs_clientes !== c.carteira || c.cvs_clientes !== c.carteira) {
    return { nivel: 'red', acao: 'Cobertura de score incompleta — rodar calculate-scores + drain do visit.' };
  }
  return { nivel: 'green', acao: 'OK.' };
}

/** Pior nível entre os checks, pro indicador agregado do topo. */
export function nivelAgregado(niveis: SaudeNivel[]): SaudeNivel {
  if (niveis.includes('red')) return 'red';
  if (niveis.includes('yellow')) return 'yellow';
  return 'green';
}
