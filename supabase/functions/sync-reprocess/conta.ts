// A conta do corpo do sync-reprocess escolhe as CREDENCIAIS Omie (`getVendasCredentials`: tudo que
// não é `colacor` cai na Oben) e o espelho que o zeramento confirmado zera. Um rótulo fora do tipo
// (`colacor_vendas`, `colacor_sc`) zerava o espelho Colacor com a resposta da Oben (Codex P1,
// 2026-11-21) — por isso a conta é validada ANTES de qualquer leitura/escrita. Testes: conta_test.ts.
export type Account = "oben" | "colacor";

export function contaReprocessValida(account: unknown): account is Account {
  return account === "oben" || account === "colacor";
}
