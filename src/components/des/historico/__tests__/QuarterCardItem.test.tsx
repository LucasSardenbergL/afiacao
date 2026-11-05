import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuarterCardItem } from "../QuarterCardItem";
import type { QuarterCard } from "../types";

function makeCard(overrides: Partial<QuarterCard> = {}): QuarterCard {
  return {
    ano: 2026,
    trimestre: 2,
    isAtual: false,
    isFuturo: false,
    meta: 100000,
    faturado: 120000,
    faturadoOrigem: "snapshot",
    faturadoReferencia: "2026-06-30",
    fechado: true,
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

  it("passado com meta mas SEM faturado → 'Sem dado', nunca 'Meta não atingida' nem R$ 0,00", () => {
    setup({ card: makeCard({ faturado: null }) });
    expect(screen.getByText("Sem dado")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
    expect(screen.queryByText("Meta atingida")).toBeNull();
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it("passado SEM meta → 'Sem dado' e meta '—'", () => {
    setup({ card: makeCard({ meta: null, faturado: 50000 }) });
    expect(screen.getByText("Sem dado")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
    expect(screen.queryByText("Meta atingida")).toBeNull();
  });

  it("sem faixa de estrelas mostra '—', não '0★'", () => {
    setup({ card: makeCard({ faixaEstrelas: null }) });
    expect(screen.queryByText("0★")).toBeNull();
  });

  it("atual sem faturado não mostra barra de progresso", () => {
    setup({ card: makeCard({ isAtual: true, faturado: null }) });
    expect(screen.queryByText(/% da meta/)).toBeNull();
  });

  it("snapshot parcial abaixo da meta → 'Sem fechamento' e 'Faturado até', nunca 'Meta não atingida'", () => {
    setup({ card: makeCard({ faturado: 50000, fechado: false, faturadoReferencia: "2026-04-18" }) });
    expect(screen.getByText("Sem fechamento")).toBeTruthy();
    expect(screen.getByText("Faturado até 18/04/2026")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
    expect(screen.queryByText("Faturado final")).toBeNull();
  });

  it("futuro → 'Planejado', sem julgamento", () => {
    setup({ card: makeCard({ isFuturo: true, faturado: null, faturadoOrigem: null, fechado: false }) });
    expect(screen.getByText("Planejado")).toBeTruthy();
    expect(screen.queryByText("Meta não atingida")).toBeNull();
  });

  it("dispara onVerDetalhes ao clicar em Ver detalhes", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Ver detalhes"));
    expect(props.onVerDetalhes).toHaveBeenCalledWith(props.card);
  });
});
