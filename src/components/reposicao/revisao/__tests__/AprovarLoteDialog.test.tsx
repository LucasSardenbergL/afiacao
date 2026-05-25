import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AprovarLoteDialog } from "../AprovarLoteDialog";
import type { RowWithPrice } from "@/lib/reposicao/sku-param";

const selectedRows = [
  { id: "r1", sku_codigo_omie: 111, sku_descricao: "Verniz", classe_consolidada: "AX", estoque_maximo: 40 } as unknown as RowWithPrice,
];

function setup(overrides: Partial<React.ComponentProps<typeof AprovarLoteDialog>> = {}) {
  const props: React.ComponentProps<typeof AprovarLoteDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    aggregateImpact: { count: 1, capUnits: 40 },
    selectedRows,
    batchJustificativa: "",
    setBatchJustificativa: vi.fn(),
    onConfirm: vi.fn(),
    isApproving: false,
    ...overrides,
  };
  render(<AprovarLoteDialog {...props} />);
  return props;
}

describe("AprovarLoteDialog", () => {
  it("mostra contagem e os SKUs selecionados", () => {
    setup();
    expect(screen.getByText("Aprovar 1 SKU(s)")).toBeTruthy();
    expect(screen.getByText("111")).toBeTruthy();
    expect(screen.getByText("Verniz")).toBeTruthy();
  });

  it("dispara setBatchJustificativa ao digitar", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Revisão trimestral/), { target: { value: "ok" } });
    expect(props.setBatchJustificativa).toHaveBeenCalledWith("ok");
  });

  it("confirma e cancela", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar aprovação/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("desabilita Confirmar quando isApproving", () => {
    setup({ isApproving: true });
    expect(screen.getByRole("button", { name: /Confirmar aprovação/ })).toHaveProperty("disabled", true);
  });
});
