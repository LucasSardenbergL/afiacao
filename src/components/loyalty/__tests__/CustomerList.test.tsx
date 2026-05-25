import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomerList } from "../CustomerList";
import type { CustomerPoints } from "../types";

const customer: CustomerPoints = {
  user_id: "u1",
  name: "Cliente X",
  total_earned: 600,
  total_redeemed: 100,
  balance: 500,
};

function setup(overrides: Partial<React.ComponentProps<typeof CustomerList>> = {}) {
  const props: React.ComponentProps<typeof CustomerList> = {
    search: "",
    onSearchChange: vi.fn(),
    filtered: [customer],
    onView: vi.fn(),
    onQuickEarn: vi.fn(),
    onQuickRedeem: vi.fn(),
    ...overrides,
  };
  render(<CustomerList {...props} />);
  return props;
}

describe("CustomerList", () => {
  it("empty state sem busca", () => {
    setup({ filtered: [] });
    expect(screen.getByText("Nenhum cliente com pontos ainda")).toBeTruthy();
  });

  it("empty state com busca", () => {
    setup({ filtered: [], search: "abc" });
    expect(screen.getByText("Nenhum cliente encontrado")).toBeTruthy();
  });

  it("renderiza cliente com tier e saldo", () => {
    setup();
    expect(screen.getByText("Cliente X")).toBeTruthy();
    expect(screen.getByText("Ouro · 500 pontos")).toBeTruthy();
  });

  it("dispara onView ao clicar no card", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Cliente X"));
    expect(props.onView).toHaveBeenCalledWith(customer);
  });

  it("quick earn/redeem param o propagation e disparam callbacks", () => {
    const props = setup();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(props.onQuickEarn).toHaveBeenCalledWith("u1");
    expect(props.onQuickRedeem).toHaveBeenCalledWith("u1");
    expect(props.onView).not.toHaveBeenCalled();
  });
});
