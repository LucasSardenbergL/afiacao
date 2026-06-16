import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkuFilters } from "../SkuFilters";
import type { Grupo } from "../types";

const grupo: Grupo = {
  id: 1, empresa: "OBEN", fornecedor_nome: "ACME", grupo_codigo: "g_rapido",
  descricao: null, lt_producao_dias: 5, lt_producao_unidade: "uteis",
  horario_corte: null, observacoes: null,
};

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof SkuFilters>> = {}): React.ComponentProps<typeof SkuFilters> {
  return {
    filtroFornecedor: "__all__",
    setFiltroFornecedor: noop,
    filtroGrupo: "__all__",
    setFiltroGrupo: noop,
    busca: "",
    setBusca: noop,
    setPage: noop,
    fornecedoresDisponiveis: ["ACME"],
    grupos: [grupo],
    selecionadosCount: 0,
    bulkGrupo: "",
    setBulkGrupo: noop,
    onAplicarLote: noop,
    onLimparSelecao: noop,
    moverLotePending: false,
    ...over,
  };
}

describe("SkuFilters", () => {
  it("renderiza busca; sem barra de lote quando count=0", () => {
    render(<SkuFilters {...baseProps()} />);
    expect(screen.getByPlaceholderText(/Buscar por SKU/)).toBeTruthy();
    expect(screen.queryByText(/selecionado\(s\)/)).toBeNull();
  });

  it("digitar busca chama setBusca e reseta page", () => {
    const setBusca = vi.fn();
    const setPage = vi.fn();
    render(<SkuFilters {...baseProps({ setBusca, setPage })} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar por SKU/), { target: { value: "999" } });
    expect(setBusca).toHaveBeenCalledWith("999");
    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("barra de lote com count>0 → Aplicar/Cancelar disparam callbacks", () => {
    const onAplicarLote = vi.fn();
    const onLimparSelecao = vi.fn();
    render(<SkuFilters {...baseProps({ selecionadosCount: 3, bulkGrupo: "g_rapido", onAplicarLote, onLimparSelecao })} />);
    expect(screen.getByText("3 selecionado(s)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Aplicar/ }));
    expect(onAplicarLote).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(onLimparSelecao).toHaveBeenCalled();
  });
});
