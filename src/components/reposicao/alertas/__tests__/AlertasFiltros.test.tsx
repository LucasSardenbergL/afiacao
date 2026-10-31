import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlertasFiltros } from "../AlertasFiltros";

function baseProps(over: Partial<React.ComponentProps<typeof AlertasFiltros>> = {}): React.ComponentProps<typeof AlertasFiltros> {
  const noop = () => { /* */ };
  return {
    visao: "fila",
    busca: "",
    setBusca: noop,
    filtroTipo: "__all__",
    setFiltroTipo: noop,
    filtroSev: "__all__",
    setFiltroSev: noop,
    filtroStatus: "pendente",
    setFiltroStatus: noop,
    selecionadosCount: 0,
    onAceitarLote: noop,
    onLimparSelecao: noop,
    ...over,
  };
}

describe("AlertasFiltros", () => {
  it("renderiza busca e labels; sem barra de lote quando count=0", () => {
    render(<AlertasFiltros {...baseProps()} />);
    expect(screen.getByPlaceholderText("Código ou descrição")).toBeTruthy();
    expect(screen.getByText("Buscar SKU")).toBeTruthy();
    expect(screen.queryByText(/selecionado\(s\)/)).toBeNull();
  });

  // A volta à página 1 é do setter (uma escrita só na URL), não de um setPage separado.
  it("digitar na busca chama setBusca uma vez com o termo", () => {
    const setBusca = vi.fn();
    render(<AlertasFiltros {...baseProps({ setBusca })} />);
    fireEvent.change(screen.getByPlaceholderText("Código ou descrição"), { target: { value: "abc" } });
    expect(setBusca).toHaveBeenCalledTimes(1);
    expect(setBusca).toHaveBeenCalledWith("abc");
  });

  it("barra de lote aparece com count>0 e botões disparam callbacks", () => {
    const onAceitarLote = vi.fn();
    const onLimparSelecao = vi.fn();
    render(<AlertasFiltros {...baseProps({ selecionadosCount: 3, onAceitarLote, onLimparSelecao })} />);
    expect(screen.getByText("3 selecionado(s)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Marcar como revisados/ }));
    expect(onAceitarLote).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Limpar seleção/ }));
    expect(onLimparSelecao).toHaveBeenCalled();
  });

  // Guarda de regressão: o excluir-em-lote foi RETIRADO (spec 2026-07-16).
  it("não oferece excluir em lote", () => {
    render(<AlertasFiltros {...baseProps({ selecionadosCount: 3 })} />);
    expect(screen.queryByRole("button", { name: /Excluir selecionados/ })).toBeNull();
  });
});
