import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DecisionCard } from "../DecisionCard";
import type { AIDecision } from "../types";

function makeDecision(o: Partial<AIDecision> = {}): AIDecision {
  return {
    id: "d1",
    decision_type: "churn",
    customer_user_id: "c1",
    farmer_id: null,
    score_final: 87.4,
    confidence: "alta",
    confidence_value: 0.9,
    suggested_action: "ligar",
    primary_reason: "Cliente em risco de churn",
    evidences: [
      { label: "Atraso", value: "15 dias", type: "critical" },
      { label: "Queda", value: "30%", type: "warning" },
    ],
    explanation: "x",
    customer_metrics: { pedidos_90d: 5, faturamento_90d: 12000, ticket_medio_90d: 2400, intervalo_medio_dias: 22 },
    status: "pending",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...o,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof DecisionCard>> = {}) {
  const props: React.ComponentProps<typeof DecisionCard> = {
    decision: makeDecision(),
    customerName: "Marcenaria Alfa",
    customerPhone: "11999",
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<DecisionCard {...props} />);
  return props;
}

describe("DecisionCard", () => {
  it("renderiza nome, score, motivo, confiança e ação", () => {
    setup();
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("87")).toBeTruthy(); // score_final.toFixed(0)
    expect(screen.getByText("Cliente em risco de churn")).toBeTruthy();
    expect(screen.getByText("Alta")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ligar/ })).toBeTruthy();
  });

  it("dispara onAccept e onDismiss", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Ligar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Dispensar/ }));
    expect(props.onAccept).toHaveBeenCalledTimes(1);
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mostra badge Aceito e desabilita ação quando accepted", () => {
    setup({ decision: makeDecision({ status: "accepted" }) });
    expect(screen.getByText("Aceito")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ligar/ })).toHaveProperty("disabled", true);
  });

  it("expande para mostrar métricas", () => {
    setup();
    expect(screen.queryByText("Pedidos 90d")).toBeNull();
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]); // chevron toggle
    expect(screen.getByText("Pedidos 90d")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });
});
