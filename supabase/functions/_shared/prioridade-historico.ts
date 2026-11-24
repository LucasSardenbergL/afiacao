/**
 * Prioridade GRAVADA de um cliente, dado o status de histórico de vendas — regra pura de `calculate-scores`.
 *
 * Por que existe: quem NUNCA comprou (`sem_historico`, 15.765 linhas em prod em 2026-11-20) saía com
 * priority_score = 67 cravado, ACIMA do máximo dos ativos (60). O churn = 100 − health de quem não tem
 * compra nenhuma domina a média renormalizada, e "nunca comprou" virava "o mais urgente da carteira".
 * Isso é número fabricado (money-path.md: ausente ≠ zero, e ausente ≠ 67): a prioridade de recompra não se
 * aplica a quem não tem compra. O valor certo é NULL. A ativação continua existindo por outro caminho — a
 * agenda completa vagas com esses clientes (src/lib/scoring/agenda.ts).
 *
 * Mora em `_shared` (e não inline no index.ts) porque o index importa `npm:@supabase/supabase-js` e o
 * `test:edges` roda com `--no-remote`: inline, a regra seria inalcançável por teste de comportamento.
 */

export type StatusHistorico = "sem_historico" | "stale" | "ativo";

/** Run SAUDÁVEL (a RPC de vendas respondeu): o status foi derivado agora, e decide. */
// `calculada` null (v1.9) = insumo obrigatório da exposição ao atraso ausente: NULL atravessa, nunca 0.
export function prioridadePorStatus(status: StatusHistorico, calculada: number | null): number | null {
  return status === "sem_historico" ? null : calculada;
}

/**
 * Run com `salesRefreshFatal` (a RPC de vendas FALHOU): o status do run não existe — o payload manda
 * `sales_history_status: null` e a RPC preserva o do banco (COALESCE). Então a prioridade obedece ao
 * status PERSISTIDO, que é o que vai continuar valendo depois da escrita:
 *   - `sem_historico` → NULL (o mesmo veredito do run saudável; não ressuscita o 67);
 *   - `ativo`/`stale` → o cálculo deste run (comportamento anterior: recompute nos insumos congelados);
 *   - status NULL/desconhecido no banco → PRESERVA a prioridade anterior. Sem saber se o cliente já
 *     comprou, nem NULL (apagaria um comprador) nem o cálculo (poderia ser o 67 de quem nunca comprou)
 *     se sustentam; regravar o valor lido é o no-op honesto.
 */
export function prioridadeNoRefreshFatal(
  statusPersistido: unknown,
  calculada: number | null,
  persistida: number | null,
): number | null {
  if (statusPersistido === "sem_historico") return null;
  if (statusPersistido === "ativo" || statusPersistido === "stale") return calculada;
  return persistida;
}
