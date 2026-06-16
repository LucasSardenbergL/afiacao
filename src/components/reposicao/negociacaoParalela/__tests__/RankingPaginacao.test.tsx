import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RankingPaginacao } from "../RankingPaginacao";

describe("RankingPaginacao", () => {
  it("mostra intervalo, total e indicador de página", () => {
    render(
      <RankingPaginacao
        paginaAtual={1}
        totalPaginas={3}
        pageSize={20}
        totalFiltrado={45}
        onAnterior={() => {}}
        onProxima={() => {}}
      />,
    );
    expect(screen.getByText(/Mostrando 1–20 de 45 SKUs ranqueados/)).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("desabilita Anterior na primeira página e Próxima na última", () => {
    const { rerender } = render(
      <RankingPaginacao
        paginaAtual={1}
        totalPaginas={3}
        pageSize={20}
        totalFiltrado={45}
        onAnterior={() => {}}
        onProxima={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Anterior" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Próxima" })).toHaveProperty("disabled", false);

    rerender(
      <RankingPaginacao
        paginaAtual={3}
        totalPaginas={3}
        pageSize={20}
        totalFiltrado={45}
        onAnterior={() => {}}
        onProxima={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Próxima" })).toHaveProperty("disabled", true);
  });

  it("dispara callbacks ao clicar", () => {
    const onAnterior = vi.fn();
    const onProxima = vi.fn();
    render(
      <RankingPaginacao
        paginaAtual={2}
        totalPaginas={3}
        pageSize={20}
        totalFiltrado={45}
        onAnterior={onAnterior}
        onProxima={onProxima}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(onAnterior).toHaveBeenCalledTimes(1);
    expect(onProxima).toHaveBeenCalledTimes(1);
  });

  it("trata lista vazia (0–0 de 0)", () => {
    render(
      <RankingPaginacao
        paginaAtual={1}
        totalPaginas={1}
        pageSize={20}
        totalFiltrado={0}
        onAnterior={() => {}}
        onProxima={() => {}}
      />,
    );
    expect(screen.getByText(/Mostrando 0–0 de 0 SKUs ranqueados/)).toBeTruthy();
  });
});
