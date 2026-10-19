// Chave de acesso da NF-e (44 dígitos) — compartilhada entre `omie-nfe-recebimento-sync` (chave.ts) e
// `omie-nfe-webhook`. Em `_shared/` pelo mesmo motivo de `ncm.ts`: o empacotador do Lovable não leva
// import de outra pasta de função.

/** 44 dígitos, espaços fora; qualquer outra forma é `null` (nunca uma chave "consertada"). */
export function normalizarChaveAcesso(bruta: unknown): string | null {
  if (typeof bruta !== "string") return null;
  const semEspaco = bruta.replace(/\s/g, "");
  return /^\d{44}$/.test(semEspaco) ? semEspaco : null;
}
