import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TransparencyBadge } from "../TransparencyBadge";
import type { FinConfiabilidadeRow } from "../types";

describe("TransparencyBadge", () => {
  it("mostra placeholder quando conf é null", () => {
    render(<TransparencyBadge conf={null} />);
    expect(screen.getByText("Sem dados de confiabilidade")).toBeTruthy();
  });

  it("calcula score e mostra mapeado/conciliado/fechamento", () => {
    const conf = {
      company: "oben",
      pct_valor_mapeado: 80,
      pct_mov_conciliado: 70,
      fechamento_status: "fechado",
      dre_categorias_heuristica: 0,
    } as unknown as FinConfiabilidadeRow;
    render(<TransparencyBadge conf={conf} />);
    // score = round(80*0.4 + 70*0.3 + 30) = 83
    expect(screen.getByText("83%")).toBeTruthy();
    expect(screen.getByText("80% mapeado")).toBeTruthy();
    expect(screen.getByText("70% conciliado")).toBeTruthy();
    expect(screen.getByText("Fechado")).toBeTruthy();
  });
});
