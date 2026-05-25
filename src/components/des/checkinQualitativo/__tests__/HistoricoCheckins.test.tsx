import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HistoricoCheckins } from "../HistoricoCheckins";
import type { DescontoCheckin } from "../types";

function row(p: Partial<DescontoCheckin>): DescontoCheckin {
  return {
    checkin_id: 1, data_avaliacao: "2026-05-20", tipo: "projecao",
    faixa_numero: 2, estrelas: 3, desconto_padrao: 5,
    qualitativos_atingidos_perc: 2.5, bonus_atingido_perc: 0,
    desconto_total_projetado: 7.5, desconto_total_maximo: 10, avaliado_por: "joao",
    ...p,
  };
}

describe("HistoricoCheckins", () => {
  it("mostra mensagem vazia", () => {
    render(<HistoricoCheckins loading={false} historico={[]} />);
    expect(screen.getByText(/Nenhum checkin registrado/)).toBeTruthy();
  });

  it("renderiza linha de projeção com data e percentuais", () => {
    render(<HistoricoCheckins loading={false} historico={[row({})]} />);
    expect(screen.getByText("20/05/2026")).toBeTruthy();
    expect(screen.getByText("Projeção")).toBeTruthy();
    expect(screen.getByText("joao")).toBeTruthy();
    expect(screen.getByText("7,50%")).toBeTruthy();
  });

  it("rotula confirmacao_andre como Confirmação", () => {
    render(<HistoricoCheckins loading={false} historico={[row({ tipo: "confirmacao_andre" })]} />);
    expect(screen.getByText("Confirmação")).toBeTruthy();
  });
});
