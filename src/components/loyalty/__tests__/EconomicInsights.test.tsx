import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EconomicInsights } from "../EconomicInsights";
import type { CustomerPoints } from "../types";

const topBalanceUsers: CustomerPoints[] = [
  { user_id: "u1", name: "Cliente Z", total_earned: 600, total_redeemed: 100, balance: 500 },
];

describe("EconomicInsights", () => {
  it("renderiza passivo, taxa de resgate, recompensas e saldos", () => {
    render(
      <EconomicInsights
        estimatedLiability={12.5}
        redemptionRate="40.0"
        topRewards={[["Brinde A", 3]]}
        topBalanceUsers={topBalanceUsers}
      />,
    );
    expect(screen.getByText("R$ 12.50")).toBeTruthy();
    expect(screen.getByText("40.0%")).toBeTruthy();
    expect(screen.getByText("Brinde A")).toBeTruthy();
    expect(screen.getByText("3x")).toBeTruthy();
    expect(screen.getByText("Cliente Z")).toBeTruthy();
    expect(screen.getByText("500 pts")).toBeTruthy();
  });

  it("oculta seções quando vazias", () => {
    render(
      <EconomicInsights estimatedLiability={0} redemptionRate="0" topRewards={[]} topBalanceUsers={[]} />,
    );
    expect(screen.queryByText("Recompensas mais resgatadas")).toBeNull();
    expect(screen.queryByText("Maiores saldos")).toBeNull();
  });
});
