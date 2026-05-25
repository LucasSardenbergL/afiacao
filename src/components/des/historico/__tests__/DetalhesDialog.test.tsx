import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetalhesDialog } from "../DetalhesDialog";
import type { QuarterCard } from "../types";

const card: QuarterCard = {
  ano: 2026,
  trimestre: 2,
  isAtual: false,
  meta: 100000,
  faturado: 120000,
  faixaEstrelas: 4,
  inicio: "2026-04-01",
  fim: "2026-06-30",
  ultimoCheckin: null,
  snapshots: [],
};

describe("DetalhesDialog", () => {
  it("não renderiza conteúdo quando detalhes é null", () => {
    render(<DetalhesDialog detalhes={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByText(/Detalhes T/)).toBeNull();
  });

  it("renderiza o título e a faixa quando há trimestre selecionado", () => {
    render(<DetalhesDialog detalhes={card} onOpenChange={vi.fn()} />);
    expect(screen.getByText("Detalhes T2/2026")).toBeTruthy();
    expect(screen.getByText("4 estrelas")).toBeTruthy();
  });
});
