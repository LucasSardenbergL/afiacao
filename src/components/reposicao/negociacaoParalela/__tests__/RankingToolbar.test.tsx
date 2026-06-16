import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RankingToolbar } from "../RankingToolbar";

function setup(overrides: Partial<React.ComponentProps<typeof RankingToolbar>> = {}) {
  const props: React.ComponentProps<typeof RankingToolbar> = {
    rankingCategoriaFiltro: new Set(["prioritario", "forte", "moderado", "fraco"]),
    onToggleCategoria: vi.fn(),
    rankingComSugestao: "ambos",
    onComSugestaoChange: vi.fn(),
    rankingBusca: "",
    onBuscaChange: vi.fn(),
    ...overrides,
  };
  render(<RankingToolbar {...props} />);
  return props;
}

describe("RankingToolbar", () => {
  it("mostra a contagem de categorias selecionadas no botão", () => {
    setup();
    expect(screen.getByRole("button", { name: /Categoria \(4\)/ })).toBeTruthy();
  });

  it("renderiza o campo de busca com o valor controlado", () => {
    setup({ rankingBusca: "verniz" });
    const input = screen.getByPlaceholderText("Buscar por SKU ou descrição...") as HTMLInputElement;
    expect(input.value).toBe("verniz");
  });

  it("dispara onBuscaChange ao digitar", () => {
    const props = setup();
    const input = screen.getByPlaceholderText("Buscar por SKU ou descrição...");
    fireEvent.change(input, { target: { value: "tinta" } });
    expect(props.onBuscaChange).toHaveBeenCalledWith("tinta");
  });
});
