import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { DashboardHero } from "../DashboardHero";

function setup(overrides: Partial<React.ComponentProps<typeof DashboardHero>> = {}) {
  const navigate = vi.fn();
  const props: React.ComponentProps<typeof DashboardHero> = {
    getGreeting: () => "Bom dia",
    displayName: "Lucas",
    customerType: "industrial",
    pendingOrdersCount: 2,
    userToolsCount: 5,
    gamScoreTotal: 30,
    navigate: navigate as unknown as NavigateFunction,
    ...overrides,
  };
  render(<DashboardHero {...props} />);
  return { navigate };
}

describe("DashboardHero", () => {
  it("renderiza saudação, nome, badge industrial e stats", () => {
    setup();
    expect(screen.getByText("Bom dia,")).toBeTruthy();
    expect(screen.getByText("Lucas")).toBeTruthy();
    expect(screen.getByText("Industrial")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
  });

  it("mostra Doméstico quando não industrial", () => {
    setup({ customerType: "domestico" });
    expect(screen.getByText("Doméstico")).toBeTruthy();
  });

  it("navega ao clicar na stat de pedidos", () => {
    const { navigate } = setup();
    fireEvent.click(screen.getByText("Pedidos"));
    expect(navigate).toHaveBeenCalledWith("/orders");
  });
});
