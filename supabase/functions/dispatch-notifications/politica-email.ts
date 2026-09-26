// Quais alertas de `fornecedor_alerta` viram e-mail (Gmail) — e quais ficam só no app.
//
// PEDIDO DO FOUNDER (2026-09-25): o "[Afiação] Parâmetros de reposição — resumo do dia"
// (`param_auto_resumo`, gravado todo dia às 18:00 pelo wrapper do param_auto) não precisa mais chegar
// por e-mail — "já percebi que está tudo certo na compra". O conteúdo continua onde a decisão acontece:
// /admin/reposicao/mudancas-automaticas (lê o `param_auto_log`, não este alerta).
//
// O alerta silenciado NÃO pode ficar em `pendente_notificacao`: o check `alert_channel` do Sentinela
// conta pendente > 2h como "dispatch parou de drenar" (critical) e o badge do menu soma a fila. Ele vai
// para `ignorado` — terminal, já previsto no CHECK de status e sem nenhum outro escritor —, que não
// entra nem na fila nem no histórico de envios da tela de Notificações.
//
// Módulo PURO: a edge decide com ele e o `politica-email_test.ts` prova a régua.

/** Tipos de alerta que ficam só no app: nunca viram e-mail. Reverter = tirar o tipo daqui. */
export const TIPOS_SO_NO_APP: ReadonlySet<string> = new Set(["param_auto_resumo"]);

export function vaiPorEmail(tipo: string | null | undefined): boolean {
  return !TIPOS_SO_NO_APP.has(typeof tipo === "string" ? tipo.trim() : "");
}

/** Separa a fila pendente entre o que vai por e-mail e o que é encerrado como `ignorado`. */
export function separarPorCanal<T extends { tipo: string | null }>(
  alertas: readonly T[],
): { porEmail: T[]; soNoApp: T[] } {
  const porEmail: T[] = [];
  const soNoApp: T[] = [];
  for (const a of alertas) (vaiPorEmail(a.tipo) ? porEmail : soNoApp).push(a);
  return { porEmail, soNoApp };
}
