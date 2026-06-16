import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuarterCardItem } from "../QuarterCardItem";
import type { QuarterCard } from "../types";

function makeCard(overrides: Partial<QuarterCard> = {}): QuarterCard {
  return {
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
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof QuarterCardItem>> = {}) {
  const props: React.ComponentProps<typeof QuarterCardItem> = {
    card: makeCard(),
    onVerDetalhes: vi.fn(),
    ...overrides,
  };
  render(<QuarterCardItem {...props} />);
  return props;
}

describe("QuarterCardItem", () => {
  it("mostra título e badge de meta atingida (encerrado, acima da meta)", () => {
    setup();
    expect(screen.getByText("T2 2026")).toBeTruthy();
    expect(screen.getByText("Meta atingida")).toBeTruthy();
  });

  it("badge de meta não atingida (encerrado, abaixo da meta)", () => {
    setup({ card: makeCard({ faturado: 50000 }) });
    expect(screen.getByText("Meta não atingida")).toBeTruthy();
  });

  it("badge em andamento + progresso quando trimestre atual", () => {
    setup({ card: makeCard({ isAtual: true, faturado: 50000 }) });
    expect(screen.getByText("Em andamento")).toBeTruthy();
    expect(screen.getByText("50,0% da meta")).toBeTruthy();
  });

  it("dispara onVerDetalhes ao clicar em Ver detalhes", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Ver detalhes"));
    expect(props.onVerDetalhes).toHaveBeenCalledWith(props.card);
  });
});
