// Inferência de confiança de um pedido sugerido (pura).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import type { PedidoItem } from "@/types/reposicao";
import type { ConfLevel } from "./types";

export function inferConfianca(r: PedidoItem): { level: ConfLevel; reason: string } {
  const s = (r.status ?? "").toLowerCase();
  if (s.includes("pendente_aprovacao")) {
    return { level: "alta", reason: "Pedido pendente gerado pelos guardrails do ciclo." };
  }
  if (s.includes("disparado") || s.includes("aprovado")) {
    return { level: "alta", reason: "Pedido já aprovado/disparado." };
  }
  if (s.includes("cancel")) {
    return { level: "baixa", reason: "Pedido cancelado — comprar geraria sobrestoque." };
  }
  if (s.includes("bloque")) {
    return { level: "baixa", reason: "Bloqueado por guardrail." };
  }
  return {
    level: "media",
    reason: "Sem dados de cobertura no registro; confiança média por padrão (status pendente).",
  };
}
