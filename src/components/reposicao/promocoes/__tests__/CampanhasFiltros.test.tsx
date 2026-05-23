import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CampanhasFiltros } from "../CampanhasFiltros";

function noop() { /* */ }

describe("CampanhasFiltros", () => {
  it("renderiza a busca e os fornecedores fornecidos", () => {
    render(
      <CampanhasFiltros
        filtroEstado="__all__" setFiltroEstado={noop}
        filtroFornecedor="__all__" setFiltroFornecedor={noop}
        busca="" setBusca={noop}
        fornecedores={["ACME", "RENNER SAYERLACK S/A"]}
      />
    );
    expect(screen.getByPlaceholderText("Buscar por nome…")).toBeTruthy();
  });

  it("digitar na busca chama setBusca", () => {
    const setBusca = vi.fn();
    render(
      <CampanhasFiltros
        filtroEstado="__all__" setFiltroEstado={noop}
        filtroFornecedor="__all__" setFiltroFornecedor={noop}
        busca="" setBusca={setBusca}
        fornecedores={[]}
      />
    );
    fireEvent.change(screen.getByPlaceholderText("Buscar por nome…"), { target: { value: "promo" } });
    expect(setBusca).toHaveBeenCalledWith("promo");
  });
});
