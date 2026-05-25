import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValidacaoDialog } from "../ValidacaoDialog";
import type { ValidacaoResult } from "../types";

describe("ValidacaoDialog", () => {
  it("mostra loader enquanto valida", () => {
    // O conteúdo do Dialog (Radix) é renderizado em portal no document.body.
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando validacao={null} />);
    expect(document.querySelector(".animate-spin")).toBeTruthy();
  });

  it("mostra faltantes e KPIs", () => {
    const validacao: ValidacaoResult = {
      faltantes: [{ empresa: "OBEN", fornecedor_nome: "RENNER", sku_codigo_omie: "999", sku_descricao: "Cola" }],
      suspeitos: [],
      total: 5,
      automaticos: 2,
      manuais: 3,
    };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} />);
    expect(screen.getByText("1 SKU(s) sem mapeamento")).toBeTruthy();
    expect(screen.getByText(/999 — Cola/)).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("mostra sucesso quando não há faltantes", () => {
    const validacao: ValidacaoResult = { faltantes: [], suspeitos: [], total: 5, automaticos: 5, manuais: 0 };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} />);
    expect(screen.getByText("Todos os SKUs do histórico estão mapeados")).toBeTruthy();
  });
});
