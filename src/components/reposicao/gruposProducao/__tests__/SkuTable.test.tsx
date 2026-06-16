import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkuTable } from "../SkuTable";
import type { SkuRow } from "../types";

const sku: SkuRow = {
  empresa: "OBEN", sku_codigo_omie: 999, sku_descricao: "Produto X",
  fornecedor_nome: "ACME", grupo_codigo: null,
};

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof SkuTable>> = {}): React.ComponentProps<typeof SkuTable> {
  return {
    skus: [sku],
    loadingSkus: false,
    selecionados: new Set<string>(),
    toggleSel: noop,
    toggleAll: noop,
    gruposParaSku: () => [],
    onMoverSku: noop,
    moverSkuPending: false,
    page: 0,
    setPage: noop,
    totalSkus: 1,
    ...over,
  };
}

describe("SkuTable", () => {
  it("loading → Carregando…", () => {
    render(<SkuTable {...baseProps({ skus: [], loadingSkus: true })} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("vazio → Nenhum SKU encontrado", () => {
    render(<SkuTable {...baseProps({ skus: [], totalSkus: 0 })} />);
    expect(screen.getByText("Nenhum SKU encontrado.")).toBeTruthy();
  });

  it("com SKU → código, descrição e contador de paginação; Anterior desabilitado na página 0", () => {
    render(<SkuTable {...baseProps()} />);
    expect(screen.getByText("999")).toBeTruthy();
    expect(screen.getByText("Produto X")).toBeTruthy();
    expect(screen.getByText("Mostrando 1 de 1 SKUs")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Anterior" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clique no checkbox da linha chama toggleSel", () => {
    const toggleSel = vi.fn();
    render(<SkuTable {...baseProps({ toggleSel })} />);
    // checkbox[0] = header (toggleAll), [1] = linha
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(toggleSel).toHaveBeenCalledWith(999);
  });
});
