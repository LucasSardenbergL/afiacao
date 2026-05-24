import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AplicadosTab } from "../AplicadosTab";
import type { FilaItem } from "../types";

function item(p: Partial<FilaItem>): FilaItem {
  return {
    id: 1, empresa: "OBEN", sku_codigo_omie: "555", sku_descricao: "Verniz",
    estoque_minimo_novo: 10, ponto_pedido_novo: 20, estoque_maximo_novo: 40,
    estoque_minimo_omie_atual: null, ponto_pedido_omie_atual: null, estoque_maximo_omie_atual: null,
    status_validacao: "pronto", mensagem_bloqueio: null, delta_max_perc: null,
    aplicado_em: "2026-05-20T13:45:00Z", resposta_omie: null, erro_omie: null, criado_em: "2026-05-20T00:00:00Z",
    ...p,
  };
}

describe("AplicadosTab", () => {
  it("mostra estado vazio", () => {
    render(<AplicadosTab filteredItens={[]} />);
    expect(screen.getByText(/Sem aplicações nos últimos 30 dias/)).toBeTruthy();
  });

  it("renderiza linha com SKU e badge OK quando sem erro", () => {
    render(<AplicadosTab filteredItens={[item({})]} />);
    expect(screen.getByText("555")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("mostra badge de Erro quando erro_omie presente", () => {
    render(<AplicadosTab filteredItens={[item({ erro_omie: "falha 500" })]} />);
    expect(screen.getByText("Erro")).toBeTruthy();
  });
});
