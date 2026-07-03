// Paridade TS ↔ SQL do vocabulário de títulos em aberto (achado Codex P2 da
// Fase 2): o gate venda_gate_credito hardcoda a lista no SQL — este teste
// trava o drift entre OPEN_TITLE_STATUSES e a migration que define a versão
// VIGENTE da função (20260703140000 redefine a de 20260702233000 — P1 do
// review: exceção casa pelo par company+codigo). Redefinição futura da
// função → apontar este path para ela.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPEN_TITLE_STATUSES } from '../titulo-status';

const MIGRATION = 'supabase/migrations/20260703140000_trava_credito_gate_excecao_por_par.sql';

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
