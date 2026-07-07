/**
 * Pure, side-effect-free classifier for purchase suggestion items.
 * Decides whether an item can be auto-approved or needs manual review.
 *
 * Kept in its own module so it can be unit-tested without React/Supabase.
 */

type ApprovalMode = "auto" | "review";

export type ApprovalSuggestion = {
  mode: ApprovalMode;
  reasons: string[];
};

export type ApprovalInput = {
  num_skus: number | null | undefined;
  valor_total: number | null | undefined;
  pedido_anterior_valor: number | null | undefined;
  status: string | null | undefined;
  aprovado_em: string | null | undefined;
  cancelado_em: string | null | undefined;
};

/** Threshold above which the value variation vs. previous cycle requires review. */
const VALUE_DELTA_REVIEW_THRESHOLD = 0.3;

export function calcApprovalSuggestion(item: ApprovalInput): ApprovalSuggestion {
  const reasons: string[] = [];
  const status = (item.status ?? "").toLowerCase();
  const qtd = Number(item.num_skus ?? 0);
  const valorAtual = Number(item.valor_total ?? 0);
  const valorAnterior = Number(item.pedido_anterior_valor ?? 0);

  if (!Number.isFinite(qtd) || qtd <= 0) {
    reasons.push("Quantidade sugerida inválida");
  }
  if (item.aprovado_em || item.cancelado_em || !status.includes("pendente_aprovacao")) {
    reasons.push("Confiança baixa/média — verificar status");
  }
  if (!Number.isFinite(valorAnterior) || valorAnterior <= 0) {
    reasons.push("Primeiro pedido — sem referência histórica");
  } else {
    const delta = Math.abs(valorAtual - valorAnterior) / valorAnterior;
    if (delta > VALUE_DELTA_REVIEW_THRESHOLD) {
      reasons.push(`Valor varia ${(delta * 100).toFixed(1)}% vs. ciclo anterior`);
    }
  }

  return reasons.length === 0
    ? { mode: "auto", reasons: [] }
    : { mode: "review", reasons };
}
