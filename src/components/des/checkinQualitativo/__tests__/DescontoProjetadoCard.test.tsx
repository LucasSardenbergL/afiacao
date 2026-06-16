import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DescontoProjetadoCard } from "../DescontoProjetadoCard";
import type { DescontoCheckin } from "../types";

const desconto = {
  checkin_id: 1, data_avaliacao: "2026-05-20", tipo: "projecao", faixa_numero: 2, estrelas: 3,
  desconto_padrao: 5, qualitativos_atingidos_perc: 2.5, bonus_atingido_perc: 0,
  desconto_total_projetado: 7.5, desconto_total_maximo: 10,
} as DescontoCheckin;

describe("DescontoProjetadoCard", () => {
  it("mostra o total projetado e o máximo da faixa", () => {
    render(
      <DescontoProjetadoCard
        desconto={desconto}
        max={10}
        total={7.5}
        cardColor="bg-amber-500/5 border-amber-500/30"
        totalColor="text-amber-700"
        saving={false}
        isLoading={false}
        onSalvarProjecao={vi.fn()}
        onSalvarConfirmacao={vi.fn()}
      />,
    );
    expect(screen.getByText(/Se confirmar os critérios, será 7,50%/)).toBeTruthy();
    expect(screen.getByText(/Máximo possível desta faixa: 10,00%/)).toBeTruthy();
  });

  it("desabilita o botão Salvar quando saving", () => {
    render(
      <DescontoProjetadoCard
        desconto={desconto} max={10} total={7.5}
        cardColor="" totalColor="" saving isLoading={false}
        onSalvarProjecao={vi.fn()} onSalvarConfirmacao={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Salvar/ })).toHaveProperty("disabled", true);
  });
});
