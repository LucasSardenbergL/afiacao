import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DollarSign } from "lucide-react";
import { MetricCard, ScoreItem } from "../cards";

describe("adminCustomers/cards", () => {
  it("MetricCard renderiza label e valor", () => {
    render(<MetricCard icon={DollarSign} label="Gasto mensal" value="R$ 1.000,00" />);
    expect(screen.getByText("Gasto mensal")).toBeTruthy();
    expect(screen.getByText("R$ 1.000,00")).toBeTruthy();
  });

  it("ScoreItem renderiza label e valor", () => {
    render(<ScoreItem label="Prioridade" value="5.2" />);
    expect(screen.getByText("Prioridade")).toBeTruthy();
    expect(screen.getByText("5.2")).toBeTruthy();
  });
});
