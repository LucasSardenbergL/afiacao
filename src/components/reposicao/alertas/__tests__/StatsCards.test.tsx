import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StatsCards } from "../StatsCards";
import type { OutlierStats } from "../types";

const stats: OutlierStats = {
  semGrupo: 13, ltAtipico: 10, ltCriticos: 3, vendaAtipica: 132, inativadoOmie: 61, reativadoOmie: 22, decididosHoje: 4,
};

const renderCards = (over: Partial<React.ComponentProps<typeof StatsCards>> = {}) =>
  render(
    <MemoryRouter>
      <StatsCards visao="fila" onVisao={() => { /* */ }} {...over} />
    </MemoryRouter>,
  );

describe("StatsCards", () => {
  it("sem stats → '—' (ausente ≠ zero), nunca 0 inventado", () => {
    renderCards();
    expect(screen.getByText("Fila de ação")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getAllByText("—").length).toBe(5);
  });

  it("fila = sem grupo + LT atípico; registro e Omie separados", () => {
    renderCards({ stats });
    expect(screen.getByText("23")).toBeTruthy();
    expect(screen.getByText("13 sem grupo · 10 LT atípico")).toBeTruthy();
    expect(screen.getByText("132")).toBeTruthy();
    expect(screen.getByText("83")).toBeTruthy();
    expect(screen.getByRole("link", { name: "22 reativado(s) para religar" }).getAttribute("href"))
      .toBe("/admin/reposicao/sessao/parametros?tab=ajuste");
  });

  it("o card morto 'Excluídos hoje' saiu (excluir foi retirado na spec 2026-07-16)", () => {
    renderCards({ stats });
    expect(screen.queryByText("Excluídos hoje")).toBeNull();
  });

  it("clicar nos cards de fila/registro troca a visão", () => {
    const onVisao = vi.fn();
    renderCards({ stats, onVisao });
    fireEvent.click(screen.getByRole("button", { name: /Registro: venda atípica/ }));
    expect(onVisao).toHaveBeenCalledWith("registro");
    fireEvent.click(screen.getByRole("button", { name: /Fila de ação/ }));
    expect(onVisao).toHaveBeenCalledWith("fila");
  });
});
