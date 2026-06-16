import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FornecedorCadeiaCard } from "../FornecedorCadeiaCard";
import type { Etapa, Fornecedor } from "../types";

const forn: Fornecedor = { empresa: "OBEN", fornecedor_nome: "ACME" };

function etapa(partial: Partial<Etapa>): Etapa {
  return {
    id: 1,
    empresa: "OBEN",
    fornecedor_nome: "ACME",
    ordem: 1,
    etapa_codigo: "E1",
    descricao: "Frete marítimo",
    lt_dias: 10,
    lt_unidade: "uteis",
    parceiro_nome: "Maersk",
    parceiro_tipo: "transportadora_terceira",
    parceiro_contato: "contato@maersk.com",
    ativo: true,
    valido_desde: "2026-01-01",
    valido_ate: null,
    observacoes: null,
    ...partial,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof FornecedorCadeiaCard>> = {}) {
  const props: React.ComponentProps<typeof FornecedorCadeiaCard> = {
    fornecedor: forn,
    lista: [etapa({})],
    isOpen: true,
    podeEditar: true,
    onToggle: vi.fn(),
    onNovaEtapa: vi.fn(),
    onEditar: vi.fn(),
    onTrocar: vi.fn(),
    onDesativar: vi.fn(),
    onReordenar: vi.fn(),
    ...overrides,
  };
  render(<FornecedorCadeiaCard {...props} />);
  return props;
}

afterEach(() => vi.restoreAllMocks());

describe("FornecedorCadeiaCard", () => {
  it("mostra nome, LT total e contagem de etapas", () => {
    setup();
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText("10d totais")).toBeTruthy();
    expect(screen.getByText("1 etapa")).toBeTruthy();
  });

  it("renderiza a etapa (descrição, parceiro, LT) quando aberto", () => {
    setup();
    expect(screen.getByText("Frete marítimo")).toBeTruthy();
    // "Maersk" aparece 2x: no resumo da cadeia (header) e na célula da tabela
    expect(screen.getAllByText("Maersk").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Transportadora terceira")).toBeTruthy();
    expect(screen.getByText("contato@maersk.com")).toBeTruthy();
  });

  it("dispara onNovaEtapa ao clicar em Adicionar etapa", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar etapa/ }));
    expect(props.onNovaEtapa).toHaveBeenCalledTimes(1);
  });

  it("desabilita Adicionar etapa quando !podeEditar e esconde as ações de linha", () => {
    setup({ podeEditar: false });
    expect(screen.getByRole("button", { name: /Adicionar etapa/ })).toHaveProperty("disabled", true);
    expect(screen.queryByTitle("Editar")).toBeNull();
  });

  it("dispara onEditar e onTrocar", () => {
    const props = setup();
    fireEvent.click(screen.getByTitle("Editar"));
    fireEvent.click(screen.getByTitle("Trocar parceiro"));
    expect(props.onEditar).toHaveBeenCalledTimes(1);
    expect(props.onTrocar).toHaveBeenCalledTimes(1);
  });

  it("desativa só após confirmação", () => {
    const props = setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByTitle("Desativar"));
    expect(props.onDesativar).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTitle("Desativar"));
    expect(props.onDesativar).toHaveBeenCalledTimes(1);
  });

  it("mostra estado vazio quando não há etapas", () => {
    setup({ lista: [] });
    expect(screen.getByText("Nenhuma etapa cadastrada.")).toBeTruthy();
  });
});
