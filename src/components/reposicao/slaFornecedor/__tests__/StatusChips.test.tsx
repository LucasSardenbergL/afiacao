import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusChips } from "../StatusChips";
import type { SlaStatus } from "../types";

const ativos: SlaStatus[] = ["cumprindo", "limite", "violando", "critico"];

describe("StatusChips", () => {
  it("renderiza os 6 chips de status", () => {
    render(<StatusChips filtroStatus={ativos} onToggle={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByText("Cumprindo")).toBeTruthy();
    expect(screen.getByText("Poucos dados")).toBeTruthy();
  });

  it("dispara onToggle com o status clicado", () => {
    const onToggle = vi.fn();
    render(<StatusChips filtroStatus={ativos} onToggle={onToggle} />);
    fireEvent.click(screen.getByText("Crítico"));
    expect(onToggle).toHaveBeenCalledWith("critico");
  });

  it("aplica estilo ativo nos chips selecionados", () => {
    render(<StatusChips filtroStatus={["cumprindo"]} onToggle={vi.fn()} />);
    expect(screen.getByText("Cumprindo").className).toContain("bg-primary");
    expect(screen.getByText("Violando").className).not.toContain("bg-primary");
  });
});
