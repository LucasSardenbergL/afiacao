import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AumentosFiltros } from "../AumentosFiltros";

function setup(overrides: Partial<React.ComponentProps<typeof AumentosFiltros>> = {}) {
  const props: React.ComponentProps<typeof AumentosFiltros> = {
    filtroFornecedor: "__all__",
    onFiltroFornecedorChange: vi.fn(),
    filtroEstado: "__all__",
    onFiltroEstadoChange: vi.fn(),
    busca: "",
    onBuscaChange: vi.fn(),
    fornecedores: ["RENNER SAYERLACK S/A", "Outro Forn"],
    ...overrides,
  };
  render(<AumentosFiltros {...props} />);
  return props;
}

describe("AumentosFiltros", () => {
  it("renderiza o campo de busca", () => {
    setup();
    expect(screen.getByPlaceholderText("Buscar por nome…")).toBeTruthy();
  });

  it("dispara onBuscaChange ao digitar", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText("Buscar por nome…"), { target: { value: "verniz" } });
    expect(props.onBuscaChange).toHaveBeenCalledWith("verniz");
  });
});
