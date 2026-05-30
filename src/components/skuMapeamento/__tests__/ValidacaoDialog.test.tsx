import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ValidacaoDialog } from "../ValidacaoDialog";
import type { ValidacaoResult } from "../types";

describe("ValidacaoDialog", () => {
  it("mostra loader enquanto valida", () => {
    // O conteúdo do Dialog (Radix) é renderizado em portal no document.body.
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando validacao={null} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
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
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
    expect(screen.getByText("1 SKU(s) sem mapeamento")).toBeTruthy();
    expect(screen.getByText(/999 — Cola/)).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("mostra sucesso quando não há faltantes", () => {
    const validacao: ValidacaoResult = { faltantes: [], suspeitos: [], total: 5, automaticos: 5, manuais: 0 };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
    expect(screen.getByText("Todos os SKUs do histórico estão mapeados")).toBeTruthy();
  });

  it("auto-preenchimento: mostra seguros + gate e dispara gravarSeguros no clique", () => {
    const gravar = vi.fn();
    const seguros = [{ sku_omie: "8689775154", descricao: "POLIULACK BRILHANTE SB.2300.00GL", sku_portal: "SB.2300.00GL", sufixo: "GL" }];
    const validacao: ValidacaoResult = {
      faltantes: [{ empresa: "OBEN", fornecedor_nome: "RENNER", sku_codigo_omie: "8689775154", sku_descricao: "POLIULACK BRILHANTE SB.2300.00GL" }],
      suspeitos: [],
      total: 1,
      automaticos: 0,
      manuais: 1,
      gabarito: { batem: 1, divergem: [], naoValidavel: 0, total: 1 },
      sugestoes: { seguros, semCodigo: [], multiplos: [] },
    };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={gravar} gravandoSeguros={false} />);
    expect(screen.getAllByText(/SB\.2300\.00GL/).length).toBeGreaterThan(0);
    const btn = screen.getByRole("button", { name: /Gravar 1 automaticamente/ });
    fireEvent.click(btn);
    expect(gravar).toHaveBeenCalledWith(seguros);
  });
});
