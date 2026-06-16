import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HistoricoFiltros } from "../HistoricoFiltros";

function setup(overrides: Partial<React.ComponentProps<typeof HistoricoFiltros>> = {}) {
  const props: React.ComponentProps<typeof HistoricoFiltros> = {
    filtroAno: "__todos__",
    onFiltroAnoChange: vi.fn(),
    filtroStatus: "todos",
    onFiltroStatusChange: vi.fn(),
    anosDisponiveis: [2026, 2025],
    ...overrides,
  };
  render(<HistoricoFiltros {...props} />);
  return props;
}

describe("HistoricoFiltros", () => {
  it("renderiza o rótulo de ano e os toggles de status", () => {
    setup();
    expect(screen.getByText("Ano:")).toBeTruthy();
    expect(screen.getByText("Em andamento")).toBeTruthy();
    expect(screen.getByText("Encerrados")).toBeTruthy();
  });

  it("dispara onFiltroStatusChange ao selecionar um status", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Em andamento"));
    expect(props.onFiltroStatusChange).toHaveBeenCalledWith("andamento");
  });
});
