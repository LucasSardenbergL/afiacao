import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Brain } from "lucide-react";
import { DecisionList } from "../DecisionList";
import type { AIDecision, CustomerProfileLite } from "../types";

function makeDecision(o: Partial<AIDecision> = {}): AIDecision {
  return {
    id: "d1",
    decision_type: "churn",
    customer_user_id: "c1",
    farmer_id: null,
    score_final: 80,
    confidence: "alta",
    confidence_value: 0.9,
    suggested_action: "ligar",
    primary_reason: "motivo",
    evidences: [],
    explanation: "x",
    customer_metrics: {},
    status: "pending",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...o,
  };
}

const profileMap = new Map<string, CustomerProfileLite>([
  ["c1", { user_id: "c1", name: "Marcenaria Alfa", document: null, phone: "11999", email: null, customer_type: null }],
]);

describe("DecisionList", () => {
  it("mostra empty state com ícone e mensagem", () => {
    render(
      <DecisionList decisions={[]} profileMap={profileMap} emptyIcon={Brain} emptyMessage="Nada aqui." onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText("Nada aqui.")).toBeTruthy();
  });

  it("renderiza cards e resolve nome via profileMap; onAccept recebe o id", () => {
    const onAccept = vi.fn();
    render(
      <DecisionList
        decisions={[makeDecision()]}
        profileMap={profileMap}
        emptyIcon={Brain}
        emptyMessage="Nada aqui."
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ligar/ }));
    expect(onAccept).toHaveBeenCalledWith("d1");
  });

  it("usa fallback de nome quando não há perfil", () => {
    render(
      <DecisionList
        decisions={[makeDecision({ customer_user_id: "desconhecido" })]}
        profileMap={profileMap}
        emptyIcon={Brain}
        emptyMessage="Nada aqui."
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Cliente desconhecido")).toBeTruthy();
  });
});
