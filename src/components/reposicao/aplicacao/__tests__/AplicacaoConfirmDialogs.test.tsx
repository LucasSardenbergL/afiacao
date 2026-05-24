import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AplicacaoConfirmDialogs } from "../AplicacaoConfirmDialogs";
import type { FilaItem } from "../types";

const it1 = {
  id: 5, empresa: "OBEN", sku_codigo_omie: "999", sku_descricao: "Diluente",
  estoque_minimo_novo: 10, ponto_pedido_novo: 20, estoque_maximo_novo: 40,
  estoque_minimo_omie_atual: 8, ponto_pedido_omie_atual: 15, estoque_maximo_omie_atual: 30,
  status_validacao: "pronto", mensagem_bloqueio: null, delta_max_perc: 60,
  aplicado_em: null, resposta_omie: null, erro_omie: null, criado_em: "2026-05-20T00:00:00Z",
} as FilaItem;

describe("AplicacaoConfirmDialogs", () => {
  it("lote: mostra maxDelta e aplica os ids ao confirmar", () => {
    const onAplicar = vi.fn();
    const setConfirmLote = vi.fn();
    render(
      <AplicacaoConfirmDialogs
        confirmLote={{ ids: [1, 2], maxDelta: 60 }}
        setConfirmLote={setConfirmLote}
        confirmIndividual={null}
        setConfirmIndividual={vi.fn()}
        onAplicar={onAplicar}
      />,
    );
    expect(screen.getByText(/máximo: 60%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar aplicação/ }));
    expect(onAplicar).toHaveBeenCalledWith([1, 2]);
    expect(setConfirmLote).toHaveBeenCalledWith(null);
  });

  it("individual: mostra SKU e aplica o id único ao confirmar", () => {
    const onAplicar = vi.fn();
    render(
      <AplicacaoConfirmDialogs
        confirmLote={null}
        setConfirmLote={vi.fn()}
        confirmIndividual={it1}
        setConfirmIndividual={vi.fn()}
        onAplicar={onAplicar}
      />,
    );
    expect(screen.getByText("Aplicar parâmetros no Omie?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Aplicar agora/ }));
    expect(onAplicar).toHaveBeenCalledWith([5]);
  });
});
