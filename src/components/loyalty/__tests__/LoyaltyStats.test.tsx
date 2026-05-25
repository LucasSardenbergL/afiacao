import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoyaltyStats } from "../LoyaltyStats";

describe("LoyaltyStats", () => {
  it("renderiza os três KPIs com rótulos", () => {
    render(<LoyaltyStats totalPointsCirculating={150} totalEarned={300} totalRedeemed={120} />);
    expect(screen.getByText("150")).toBeTruthy();
    expect(screen.getByText("300")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("Em circulação")).toBeTruthy();
    expect(screen.getByText("Total ganhos")).toBeTruthy();
    expect(screen.getByText("Resgatados")).toBeTruthy();
  });
});
