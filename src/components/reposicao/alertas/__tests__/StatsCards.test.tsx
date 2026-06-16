import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCards } from "../StatsCards";

describe("StatsCards", () => {
  it("renderiza rótulos e zeros quando sem stats", () => {
    render(<StatsCards />);
    expect(screen.getByText("Total pendentes")).toBeTruthy();
    expect(screen.getByText("Críticos")).toBeTruthy();
    expect(screen.getByText("Excluídos hoje")).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(6);
  });

  it("renderiza os valores fornecidos", () => {
    render(<StatsCards stats={{ pendentes: 12, criticos: 3, atencao: 5, info: 4, aceitosHoje: 7, excluidosHoje: 2 }} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });
});
