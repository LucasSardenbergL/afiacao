// Paridade TS ↔ SQL do vocabulário de títulos em aberto (achado Codex P2 da
// Fase 2): o gate venda_gate_credito hardcoda a lista no SQL — este teste
// trava o drift entre OPEN_TITLE_STATUSES e a migration que define a versão
// VIGENTE da função (20260703140000 redefine a de 20260702233000 — P1 do
// review: exceção casa pelo par company+codigo). Redefinição futura da
// função → apontar este path para ela.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPEN_NOT_OVERDUE_TITLE_STATUSES, OPEN_TITLE_STATUSES } from '../titulo-status';

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

// Frente B (PR1, 2026-10-31): a RPC venda_prazo_aviso lê fin_contas_receber com o MESMO vocabulário
// aberto (o pré-filtro) e, dentro dele, a regra `vencida_aberta` da view do Ciclo. Drift aqui faria o
// aviso do pedido e a fila de cobrança falarem de universos diferentes.
const MIGRATION_PRAZO = 'supabase/migrations/20261031200000_venda_prazo_decisao.sql';

describe('paridade do vocabulário de status (aviso de prazo no pedido)', () => {
  const sql = readFileSync(MIGRATION_PRAZO, 'utf8');

  it('o pré-filtro status_titulo IN (...) da RPC tem EXATAMENTE os OPEN_TITLE_STATUSES', () => {
    const m = sql.match(/AND r\.status_titulo IN \(([^)]+)\)/);
    expect(m, 'filtro r.status_titulo IN (...) não encontrado na migration').toBeTruthy();
    const doSql = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
    expect(doSql).toEqual([...OPEN_TITLE_STATUSES].sort());
  });

  it('o fallback do ingest (ABERTO/VENCIDO/PARCIAL) é só CONTADO como ambíguo, nunca somado', () => {
    expect(sql).toContain("(r.status_titulo IN ('ABERTO', 'VENCIDO', 'PARCIAL')) AS ambiguo");
    // a soma do vencido exige status NATIVO (ATRASADO, ou A VENCER/VENCE HOJE já passado) — a regra da view
    expect(sql).toContain("(r.status_titulo = 'ATRASADO'");
    expect(sql).toContain("OR (r.status_titulo IN ('A VENCER', 'VENCE HOJE') AND r.data_vencimento < v_hoje))");
  });
});

// M-08: o fin-funding filtrava `.eq("status_titulo", "ABERTO")` — valor que o Omie nunca manda —
// e devolvia 0 título antecipável em prod. O espelho Deno tem de ser o conjunto aberto-e-não-vencido,
// e o filtro tem de usá-lo (não um literal solto).
const FUNDING = 'supabase/functions/fin-funding/index.ts';

describe('paridade do vocabulário de status (fin-funding)', () => {
  const src = readFileSync(FUNDING, 'utf8');

  it('STATUS_ANTECIPAVEIS tem EXATAMENTE os OPEN_NOT_OVERDUE_TITLE_STATUSES', () => {
    const m = src.match(/const STATUS_ANTECIPAVEIS = \[([^\]]+)\] as const;/);
    expect(m, 'const STATUS_ANTECIPAVEIS não encontrada no fin-funding').toBeTruthy();
    const doDeno = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .sort();
    expect(doDeno).toEqual([...OPEN_NOT_OVERDUE_TITLE_STATUSES].sort());
  });

  it('a leitura de títulos filtra pelo conjunto, sem status literal no .eq', () => {
    expect(src).toContain('.in("status_titulo", [...STATUS_ANTECIPAVEIS])');
    expect(src).not.toMatch(/\.eq\(\s*["']status_titulo["']/);
  });
});
