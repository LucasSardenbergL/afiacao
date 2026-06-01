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

  it("mostra o risco do motor (faltantesMotor) + KPIs e a nota do histórico", () => {
    const validacao: ValidacaoResult = {
      faltantes: [], // histórico vazio
      faltantesMotor: [{ empresa: "OBEN", fornecedor_nome: "RENNER", sku_codigo_omie: "999", sku_descricao: "Cola" }],
      suspeitos: [],
      total: 5,
      automaticos: 2,
      manuais: 3,
    };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
    expect(screen.getByText("1 SKU(s) que o motor pode pedir sem de-para no portal")).toBeTruthy();
    expect(screen.getByText(/999 — Cola/)).toBeTruthy();
    expect(screen.getByText(/também aparecem no histórico de pedidos/)).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("mostra sucesso quando o motor não tem faltantes", () => {
    const validacao: ValidacaoResult = { faltantes: [], faltantesMotor: [], suspeitos: [], total: 5, automaticos: 5, manuais: 0 };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
    expect(screen.getByText("Nenhum SKU comprável pelo motor está sem mapeamento")).toBeTruthy();
  });

  it("auto-preenchimento: mostra seguros + gate e dispara gravarSeguros no clique", () => {
    const gravar = vi.fn();
    const seguros = [{ sku_omie: "8689775154", descricao: "POLIULACK BRILHANTE SB.2300.00GL", sku_portal: "SB.2300.00GL", sufixo: "GL" }];
    const validacao: ValidacaoResult = {
      faltantes: [],
      faltantesMotor: [{ empresa: "OBEN", fornecedor_nome: "RENNER", sku_codigo_omie: "8689775154", sku_descricao: "POLIULACK BRILHANTE SB.2300.00GL" }],
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

  it("GATE: bloqueia auto-gravação quando o gabarito diverge (codex)", () => {
    const seguros = [{ sku_omie: "999", descricao: "X TEH 3505.00FG", sku_portal: "TEH.3505.00FG", sufixo: "FG" }];
    const validacao: ValidacaoResult = {
      faltantes: [],
      faltantesMotor: [{ empresa: "OBEN", fornecedor_nome: "RENNER", sku_codigo_omie: "999", sku_descricao: "X TEH 3505.00FG" }],
      suspeitos: [],
      total: 2,
      automaticos: 0,
      manuais: 2,
      gabarito: { batem: 1, divergem: [{ sku_omie: "A", salvo: "FC.6902L", extraido: "FC.6902L5" }], naoValidavel: 0, total: 2 },
      sugestoes: { seguros, semCodigo: [], multiplos: [] },
    };
    render(<ValidacaoDialog open onOpenChange={vi.fn()} validando={false} validacao={validacao} gravarSeguros={vi.fn()} gravandoSeguros={false} />);
    // botão de auto-gravar NÃO renderiza; aviso de bloqueio aparece.
    expect(screen.queryByRole("button", { name: /Gravar .* automaticamente/ })).toBeNull();
    expect(screen.getByText(/Auto-gravação bloqueada/)).toBeTruthy();
  });
});
