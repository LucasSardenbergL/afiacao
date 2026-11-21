/**
 * Risco de churn GRAVADO de um cliente, dado o status de histórico de vendas — regra pura de `calculate-scores`.
 *
 * Por que existe: `churn_risk = 100 − health_score` dava 100 cravado para TODOS os 15.766 clientes
 * `sem_historico` (prod, psql-ro, 2026-11-21). Quem nunca comprou não tem o que perder: "risco de perda 100%"
 * é número fabricado (money-path.md: ausente ≠ zero, e ausente ≠ 100). O valor certo é NULL ("não se aplica —
 * sem histórico"), o mesmo veredito que o priority_score já recebe (_shared/prioridade-historico.ts, #4032/#4036).
 *
 * Só o valor GRAVADO muda. O componente de churn da PRIORIDADE continua sendo o cálculo (número) — para
 * ativo/stale o priority_score sai idêntico, e para sem_historico ele já é NULL.
 *
 * Mora em `_shared` (e não inline no index.ts) porque o index importa `npm:@supabase/supabase-js` e o
 * `test:edges` roda com `--no-remote`: inline, a regra seria inalcançável por teste de comportamento.
 */

import type { StatusHistorico } from "./prioridade-historico.ts";

/** Run SAUDÁVEL (a RPC de vendas respondeu): o status foi derivado agora, e decide. */
export function churnPorStatus(status: StatusHistorico, calculado: number): number | null {
  return status === "sem_historico" ? null : calculado;
}

/**
 * Run com `salesRefreshFatal` (a RPC de vendas FALHOU): o payload manda `sales_history_status: null` e a RPC
 * preserva o do banco (COALESCE). O churn obedece ao status PERSISTIDO, que é o que continua valendo:
 *   - `sem_historico` → NULL (o mesmo veredito do run saudável; não ressuscita o 100);
 *   - `ativo`/`stale` → o cálculo deste run (recompute nos insumos congelados, comportamento anterior);
 *   - status NULL/desconhecido no banco → PRESERVA o churn anterior. Sem saber se o cliente já comprou,
 *     nem NULL (apagaria o risco de um comprador) nem o cálculo (poderia ser o 100 de quem nunca comprou)
 *     se sustentam; regravar o valor lido é o no-op honesto.
 */
export function churnNoRefreshFatal(
  statusPersistido: unknown,
  calculado: number,
  persistido: number | null,
): number | null {
  if (statusPersistido === "sem_historico") return null;
  if (statusPersistido === "ativo" || statusPersistido === "stale") return calculado;
  return persistido;
}
