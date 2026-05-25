import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCards } from "../StatsCards";

describe("StatsCards", () => {
  it("renderiza os 3 KPIs com valores e rótulos", () => {
    render(<StatsCards prioridadesCount={7} oportunidadesCount={3} riscosCount={2} />);
    expect(screen.getByText("Prioridades")).toBeTruthy();
    expect(screen.getByText("Oportunidades")).toBeTruthy();
    expect(screen.getByText("Riscos")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});
