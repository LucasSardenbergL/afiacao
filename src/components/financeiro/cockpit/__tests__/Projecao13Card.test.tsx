import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Projecao13Card } from "../Projecao13Card";
import type { SemanaConsolidada } from "@/lib/financeiro/cockpit-consolida-helpers";

function makeWeek(o: Partial<SemanaConsolidada> = {}): SemanaConsolidada {
  return {
    inicio: "2026-05-26",
    semana_label: "S1",
    entradas_previstas: 1000,
    saidas_previstas: 500,
    saldo_projetado: 500,
    por_empresa: [{ company: "oben", saldo_final: 500 }],
    completa: true,
    ...o,
  };
}

const baseProps = { dataReferencia: "2026-05-27", parcial: false, empresasPresentes: ["oben", "colacor", "colacor_sc"], empresasAusentes: [], empresasStale: [], caixaInicialProjecao: 1000, saldoAtualBanco: 1200, cohorteCompleta: true };

describe("Projecao13Card", () => {
  it("renderiza semanas", () => {
    render(<Projecao13Card projecao13={[makeWeek(), makeWeek({ semana_label: "S2" })]} {...baseProps} />);
    expect(screen.getByText("S1")).toBeTruthy();
    expect(screen.getByText("S2")).toBeTruthy();
  });

  it("mostra alerta quando há saldo negativo", () => {
    render(
      <Projecao13Card
        projecao13={[makeWeek({ semana_label: "S3", saldo_projetado: -500 })]}
        {...baseProps}
      />,
    );
    expect(screen.getByText(/saldo negativo em 1 semana/)).toBeTruthy();
  });

  it("mostra banner de parcialidade quando parcial", () => {
    render(
      <Projecao13Card
        {...baseProps}
        projecao13={[makeWeek({ completa: false })]}
        parcial
        empresasPresentes={["oben", "colacor"]}
        empresasAusentes={["colacor_sc"]}
        cohorteCompleta={false}
      />,
    );
    expect(screen.getByText(/Parcial/)).toBeTruthy();
  });

  it("mostra caixa inicial da projeção vs saldo atual quando coorte completa", () => {
    render(<Projecao13Card projecao13={[makeWeek()]} {...baseProps} caixaInicialProjecao={1000} saldoAtualBanco={1200} cohorteCompleta />);
    expect(screen.getByText(/Caixa inicial da projeção/)).toBeTruthy();
  });
});
