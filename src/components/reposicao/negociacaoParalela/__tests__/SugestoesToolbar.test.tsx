import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SugestoesToolbar } from "../SugestoesToolbar";

describe("SugestoesToolbar", () => {
  it("mostra contagens de status e categoria selecionados nos botões", () => {
    render(
      <SugestoesToolbar
        statusFiltro={new Set(["nova", "visualizada", "acao_tomada"])}
        onToggleStatus={vi.fn()}
        categoriaFiltro={new Set(["prioritario", "forte"])}
        onToggleCategoria={vi.fn()}
        ordenacao="score"
        onOrdenacaoChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Status \(3\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Categoria \(2\)/ })).toBeTruthy();
  });
});
