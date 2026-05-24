import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProntosTab } from "../ProntosTab";
import type { FilaItem } from "../types";

function item(p: Partial<FilaItem>): FilaItem {
  return {
    id: 1, empresa: "OBEN", sku_codigo_omie: "555", sku_descricao: "Verniz",
    estoque_minimo_novo: 10, ponto_pedido_novo: 20, estoque_maximo_novo: 40,
    estoque_minimo_omie_atual: 8, ponto_pedido_omie_atual: 15, estoque_maximo_omie_atual: 30,
    status_validacao: "pronto", mensagem_bloqueio: null, delta_max_perc: 12,
    aplicado_em: null, resposta_omie: null, erro_omie: null, criado_em: "2026-05-20T00:00:00Z",
    ...p,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof ProntosTab>> = {}) {
  const props: React.ComponentProps<typeof ProntosTab> = {
    filteredItens: [item({})],
    isLoading: false,
    search: "",
    setSearch: vi.fn(),
    deltaFilter: "all",
    setDeltaFilter: vi.fn(),
    selected: new Set<number>(),
    setSelected: vi.fn(),
    toggleAll: vi.fn(),
    hasBloqueados: false,
    aplicarPending: false,
    onAplicarLote: vi.fn(),
    onConfirmIndividual: vi.fn(),
    ...overrides,
  };
  render(<ProntosTab {...props} />);
  return props;
}

describe("ProntosTab", () => {
  it("renderiza a linha do SKU e o delta", () => {
    setup();
    expect(screen.getByText("555")).toBeTruthy();
    expect(screen.getByText("Verniz")).toBeTruthy();
    expect(screen.getByText("12%")).toBeTruthy();
  });

  it("desabilita 'Aplicar selecionados' sem seleção", () => {
    setup();
    expect(screen.getByRole("button", { name: /Aplicar selecionados \(0\)/ })).toHaveProperty("disabled", true);
  });

  it("aplica lote com a seleção atual", () => {
    const props = setup({ selected: new Set([1]) });
    fireEvent.click(screen.getByRole("button", { name: /Aplicar selecionados \(1\)/ }));
    expect(props.onAplicarLote).toHaveBeenCalledWith([1]);
  });

  it("dispara onConfirmIndividual no botão da linha", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Aplicar$/ }));
    expect(props.onConfirmIndividual).toHaveBeenCalledTimes(1);
  });

  it("mostra aviso quando há bloqueados", () => {
    setup({ hasBloqueados: true });
    expect(screen.getByText(/Aplicação em lote desabilitada/)).toBeTruthy();
  });

  it("mostra estado vazio", () => {
    setup({ filteredItens: [] });
    expect(screen.getByText(/Nenhum SKU pronto/)).toBeTruthy();
  });
});
