// Paridade TS ↔ SQL do vocabulário de títulos em aberto (achado Codex P2 da
// Fase 2): o gate venda_gate_credito hardcoda a lista no SQL — este teste
// trava o drift entre OPEN_TITLE_STATUSES e a migration.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPEN_TITLE_STATUSES } from '../titulo-status';

const MIGRATION = 'supabase/migrations/20260702233000_trava_credito_fase2.sql';

describe('paridade do vocabulário de status (gate de crédito)', () => {
  it('o IN(...) do gate SQL tem EXATAMENTE os OPEN_TITLE_STATUSES', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const m = sql.match(/status_titulo IN \(([^)]+)\)/);
    expect(m, 'filtro status_titulo IN (...) não encontrado na migration').toBeTruthy();
    const doSql = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(doSql).toEqual([...OPEN_TITLE_STATUSES].sort());
  });
});
