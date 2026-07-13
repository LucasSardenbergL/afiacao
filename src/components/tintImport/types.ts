// Constantes e tipos da tela Tintométrico (sync de produtos do Omie).
// A importação manual por CSV foi aposentada e removida em 2026-07-13 (Opção A →
// remoção total; ver docs/runbooks/tint-sync-corte-csv.md). Restou só o mínimo que
// o SyncCard e o queries.ts (useTintProductCounts) consomem.

export const ACCOUNT = 'oben';

export interface TintSyncResult {
  total_sincronizado?: number;
  totalSynced?: number;
  [k: string]: unknown;
}
