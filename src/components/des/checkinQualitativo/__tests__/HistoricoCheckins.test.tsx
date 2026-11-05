import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HistoricoCheckins } from "../HistoricoCheckins";
import type { LinhaHistoricoCheckin } from "../types";

function row(p: Partial<LinhaHistoricoCheckin>): LinhaHistoricoCheckin {
  return {
    checkin_id: 1, data_avaliacao: "2026-05-20", tipo: "projecao", avaliado_por: "joao",
    qualitativos_atingidos_perc: 2.5, desconto_total_projetado: 7.5,
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

  it("percentuais desconhecidos (sem faixa): '—', e o check-in segue listado", () => {
    render(
      <HistoricoCheckins
        loading={false}
        historico={[row({ qualitativos_atingidos_perc: null, desconto_total_projetado: null })]}
      />,
    );
    expect(screen.getByText("20/05/2026")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("leitura que falhou: não diz 'nenhum checkin'", () => {
    render(<HistoricoCheckins loading={false} historico={undefined} erro />);
    expect(screen.getByText("Não foi possível ler os check-ins deste trimestre.")).toBeTruthy();
    expect(screen.queryByText(/Nenhum checkin registrado/)).toBeNull();
  });
});
