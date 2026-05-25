export type SaudeNivel = 'green' | 'yellow' | 'red';

export interface SaudeStatus {
  nivel: SaudeNivel;
  acao: string;
}

export interface CronSaude {
  jobname: string;
  last_status: string | null;
  last_run_at: string | null;
  age_hours: number | null;
  last_error: string | null;
}

export interface SyncSaude {
  max_last_synced_at: string | null;
  age_hours: number | null;
  stale_count: number;
}

export interface CoverageSaude {
  carteira: number;
  fcs_clientes: number;
  cvs_clientes: number;
}

export interface CarteiraSaudeResumo {
  crons: CronSaude[];
  sync: SyncSaude;
  score_coverage: CoverageSaude;
}
