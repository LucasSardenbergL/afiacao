import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Projecao13Card } from "../Projecao13Card";
import type { FinProjecaoSemana } from "../types";

function makeWeek(o: Partial<FinProjecaoSemana> = {}): FinProjecaoSemana {
  return {
    semana_label: "S1",
    entradas_previstas: 1000,
    saidas_previstas: 500,
    fluxo_liquido: 500,
    saldo_projetado: 500,
    ...o,
  } as unknown as FinProjecaoSemana;
}

describe("Projecao13Card", () => {
  it("renderiza semanas", () => {
    render(<Projecao13Card projecao13={[makeWeek(), makeWeek({ semana_label: "S2" })]} />);
    expect(screen.getByText("S1")).toBeTruthy();
    expect(screen.getByText("S2")).toBeTruthy();
  });

  it("mostra alerta quando há saldo negativo", () => {
    render(
      <Projecao13Card
        projecao13={[makeWeek({ semana_label: "S3", fluxo_liquido: -1000, saldo_projetado: -500 })]}
      />,
    );
    expect(screen.getByText(/saldo negativo em 1 semana/)).toBeTruthy();
  });
});
