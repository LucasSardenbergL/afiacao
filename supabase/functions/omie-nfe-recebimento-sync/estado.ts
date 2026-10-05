// O estado de uma NF-e no Omie pelo `infoCadastro` — o MESMO critério na listagem do cron, no
// detalhe do cron e no detalhe da importação por chave.
//
// "Aberta" exige EVIDÊNCIA: `cRecebido` e `cCancelada` explícitos "N". Ausente, vazio ou outro valor
// é DESCONHECIDO, e desconhecido não vira pendência (precisão > recall): a revisão do Codex de
// 2026-10-05 achou `infoCadastro: {}` importando sem prova de nota aberta. Medido em prod no mesmo
// dia (purchase_orders_tracking.raw_data, que a omie-sync-nfes-recebidas lê do mesmo endpoint): os
// 210 registros com `infoCadastro` trazem os DOIS campos, com "S"/"N" — exigir o "N" não barra nota
// aberta real.

export type EstadoNoOmie = "cancelado" | "recebido_no_omie" | "aberta" | "desconhecido";

const valor = (v: unknown) => String(v ?? "").trim().toUpperCase();

/** Cancelada vence recebida; "aberta" só com os dois "N" explícitos. */
export function estadoNoOmie(
  info: { cCancelada?: unknown; cRecebido?: unknown } | null | undefined,
): EstadoNoOmie {
  if (!info) return "desconhecido";
  if (valor(info.cCancelada) === "S") return "cancelado";
  if (valor(info.cRecebido) === "S") return "recebido_no_omie";
  return valor(info.cCancelada) === "N" && valor(info.cRecebido) === "N" ? "aberta" : "desconhecido";
}
