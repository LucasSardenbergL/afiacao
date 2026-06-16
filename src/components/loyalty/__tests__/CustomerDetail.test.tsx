import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomerDetail } from "../CustomerDetail";
import type { CustomerPoints, PointRecord } from "../types";

const customer: CustomerPoints = {
  user_id: "u1",
  name: "Cliente X",
  total_earned: 600,
  total_redeemed: 100,
  balance: 500,
};

const history: PointRecord[] = [
  {
    id: "p1",
    user_id: "u1",
    points: 100,
    type: "earn",
    description: "Bônus de boas-vindas",
    created_at: "2026-03-01T10:00:00Z",
    order_id: null,
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof CustomerDetail>> = {}) {
  const props: React.ComponentProps<typeof CustomerDetail> = {
    customer,
    history,
    onAddPoints: vi.fn(),
    onRedeem: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  render(<CustomerDetail {...props} />);
  return props;
}

describe("CustomerDetail", () => {
  it("mostra saldo, tier e totais", () => {
    setup();
    expect(screen.getByText("500 pts")).toBeTruthy();
    expect(screen.getByText("Ouro")).toBeTruthy();
    expect(screen.getByText("600")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("renderiza o histórico com badge", () => {
    setup();
    expect(screen.getByText("Bônus de boas-vindas")).toBeTruthy();
    expect(screen.getByText("+100 pts")).toBeTruthy();
  });

  it("empty state de histórico", () => {
    setup({ history: [] });
    expect(screen.getByText("Sem histórico")).toBeTruthy();
  });

  it("dispara onAddPoints/onRedeem/onBack", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar Pontos/ }));
    fireEvent.click(screen.getByRole("button", { name: /Resgatar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Voltar à lista/ }));
    expect(props.onAddPoints).toHaveBeenCalledTimes(1);
    expect(props.onRedeem).toHaveBeenCalledTimes(1);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
