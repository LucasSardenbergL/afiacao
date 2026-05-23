import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OportunidadesFiltros } from "../OportunidadesFiltros";
import { CENARIOS } from "../shared";
import type { Cenario } from "../types";

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof OportunidadesFiltros>> = {}): React.ComponentProps<typeof OportunidadesFiltros> {
  return {
    cenariosSelecionados: new Set<Cenario>(CENARIOS.map((c) => c.value)),
    cenariosLabel: "Todos os cenários",
    toggleCenario: noop,
    filtroFornecedor: "__all__",
    setFiltroFornecedor: noop,
    fornecedoresUnicos: ["ACME", "SAYERLACK"],
    ordenacao: "economia",
    setOrdenacao: noop,
    apenasComEconomia: true,
    setApenasComEconomia: noop,
    ...over,
  };
}

describe("OportunidadesFiltros", () => {
  it("renderiza o label de cenários e o switch de economia", () => {
    render(<OportunidadesFiltros {...baseProps()} />);
    expect(screen.getByText("Todos os cenários")).toBeTruthy();
    expect(screen.getByText(/Apenas com economia/)).toBeTruthy();
  });

  it("alternar o switch dispara setApenasComEconomia", () => {
    const setApenasComEconomia = vi.fn();
    render(<OportunidadesFiltros {...baseProps({ setApenasComEconomia })} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(setApenasComEconomia).toHaveBeenCalled();
  });
});
