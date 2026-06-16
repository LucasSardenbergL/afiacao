import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapeamentoFiltros } from "../MapeamentoFiltros";

function setup(overrides: Partial<React.ComponentProps<typeof MapeamentoFiltros>> = {}) {
  const props: React.ComponentProps<typeof MapeamentoFiltros> = {
    filtroEmpresa: "__all__",
    onFiltroEmpresaChange: vi.fn(),
    filtroFornecedor: "__all__",
    onFiltroFornecedorChange: vi.fn(),
    filtroAtivo: "__all__",
    onFiltroAtivoChange: vi.fn(),
    busca: "",
    onBuscaChange: vi.fn(),
    empresas: ["OBEN"],
    fornecedores: ["RENNER SAYERLACK S/A"],
    ...overrides,
  };
  render(<MapeamentoFiltros {...props} />);
  return props;
}

describe("MapeamentoFiltros", () => {
  it("renderiza o card e o campo de busca", () => {
    setup();
    expect(screen.getByText("Filtros")).toBeTruthy();
    expect(screen.getByPlaceholderText("Buscar SKU ou descrição")).toBeTruthy();
  });

  it("dispara onBuscaChange ao digitar", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText("Buscar SKU ou descrição"), { target: { value: "verniz" } });
    expect(props.onBuscaChange).toHaveBeenCalledWith("verniz");
  });
});
