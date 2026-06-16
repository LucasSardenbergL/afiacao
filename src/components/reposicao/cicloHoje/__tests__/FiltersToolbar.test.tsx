import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FiltersToolbar } from "../FiltersToolbar";
import { ALL } from "../types";
import type { ColKey } from "@/types/reposicao";

const cols = {
  fornecedor: true, grupo: true, skus: true, valor: true,
  preco: true, confianca: true, status: true, qtdAprovada: true,
} as Record<ColKey, boolean>;

function setup(overrides: Partial<React.ComponentProps<typeof FiltersToolbar>> = {}) {
  const props: React.ComponentProps<typeof FiltersToolbar> = {
    filters: { search: "", fornecedor: ALL, status: ALL },
    setFilters: vi.fn(),
    fornecedores: ["ACME"],
    statuses: ["pendente_aprovacao"],
    eligibleAutoCount: 4,
    busy: false,
    onOpenAuto: vi.fn(),
    reviewMode: false,
    setReviewMode: vi.fn(),
    cols,
    onColChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  };
  render(<FiltersToolbar {...props} />);
  return props;
}

describe("FiltersToolbar", () => {
  it("mostra a contagem de elegíveis no botão", () => {
    setup();
    expect(screen.getByRole("button", { name: /Aprovar elegíveis \(4\)/ })).toBeTruthy();
  });

  it("dispara setFilters ao digitar na busca", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Buscar SKU/), { target: { value: "disco" } });
    expect(props.setFilters).toHaveBeenCalledWith({ search: "disco", fornecedor: ALL, status: ALL });
  });

  it("dispara onOpenAuto e onClearFilters", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Aprovar elegíveis/ }));
    fireEvent.click(screen.getByRole("button", { name: /Limpar filtros/ }));
    expect(props.onOpenAuto).toHaveBeenCalledTimes(1);
    expect(props.onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("desabilita 'Aprovar elegíveis' quando não há elegíveis", () => {
    setup({ eligibleAutoCount: 0 });
    expect(screen.getByRole("button", { name: /Aprovar elegíveis \(0\)/ })).toHaveProperty("disabled", true);
  });

  it("alterna o modo revisão", () => {
    const props = setup({ reviewMode: false });
    fireEvent.click(screen.getByRole("button", { name: /Modo revisão/ }));
    expect(props.setReviewMode).toHaveBeenCalledWith(true);
  });
});
