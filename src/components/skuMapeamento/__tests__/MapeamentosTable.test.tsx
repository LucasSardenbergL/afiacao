import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapeamentosTable } from "../MapeamentosTable";
import type { Mapeamento } from "../types";

function makeMap(o: Partial<Mapeamento> = {}): Mapeamento {
  return {
    id: 1,
    empresa: "OBEN",
    fornecedor_nome: "RENNER SAYERLACK S/A",
    sku_omie: "111",
    sku_portal: "ABC123",
    unidade_portal: "UN",
    fator_conversao: 1,
    ativo: true,
    observacoes: null,
    criado_em: "",
    atualizado_em: "",
    ...o,
  };
}

const descricoes = new Map<string, string>([["111", "Verniz"]]);

describe("MapeamentosTable", () => {
  it("mostra loader durante carregamento", () => {
    const { container } = render(
      <MapeamentosTable isLoading filtrados={[]} totalCount={0} descricoes={descricoes} onEdit={vi.fn()} />,
    );
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renderiza linha com descrição e dispara onEdit", () => {
    const onEdit = vi.fn();
    render(
      <MapeamentosTable isLoading={false} filtrados={[makeMap()]} totalCount={5} descricoes={descricoes} onEdit={onEdit} />,
    );
    expect(screen.getByText("111")).toBeTruthy();
    expect(screen.getByText("Verniz")).toBeTruthy();
    expect(screen.getByText("ABC123")).toBeTruthy();
    expect(screen.getAllByText("Ativo").length).toBeGreaterThanOrEqual(2); // header da coluna + badge da linha
    expect(screen.getByText("1 de 5 registros")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("mostra badge vazio quando sku_portal é null", () => {
    render(
      <MapeamentosTable isLoading={false} filtrados={[makeMap({ sku_portal: null })]} totalCount={1} descricoes={descricoes} onEdit={vi.fn()} />,
    );
    expect(screen.getByText("vazio")).toBeTruthy();
  });

  it("mostra empty state sem mapeamentos", () => {
    render(
      <MapeamentosTable isLoading={false} filtrados={[]} totalCount={0} descricoes={descricoes} onEdit={vi.fn()} />,
    );
    expect(screen.getByText("Nenhum mapeamento encontrado.")).toBeTruthy();
  });
});
