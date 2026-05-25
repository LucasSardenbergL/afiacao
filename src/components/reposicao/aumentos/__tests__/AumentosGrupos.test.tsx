import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AumentosGrupos } from "../AumentosGrupos";
import type { GrupoMensal } from "@/lib/agruparPorMes";
import type { AumentoComAgg } from "../types";

function makeAumento(o: Partial<AumentoComAgg> = {}): AumentoComAgg {
  return {
    id: 1,
    nome: "Reajuste X",
    fornecedor_nome: "RENNER",
    data_vigencia: "2026-04-01",
    data_anuncio: "2026-03-01",
    estado: "vigente",
    extracao_confianca: null,
    criado_em: "2026-03-01",
    num_categorias: 5,
    perc_medio: 12.5,
    ...o,
  };
}

const grupoCheio: GrupoMensal<AumentoComAgg> = {
  chave: "2026-04",
  label: "Abril 2026",
  itens: [makeAumento()],
  vazio: false,
};

const grupoVazio: GrupoMensal<AumentoComAgg> = {
  chave: "2026-03",
  label: "Março 2026",
  itens: [],
  vazio: true,
};

function setup(overrides: Partial<React.ComponentProps<typeof AumentosGrupos>> = {}) {
  const props: React.ComponentProps<typeof AumentosGrupos> = {
    isLoading: false,
    grupos: [grupoCheio],
    isCollapsed: () => false,
    onToggleMes: vi.fn(),
    onUploadClick: vi.fn(),
    onRowClick: vi.fn(),
    ...overrides,
  };
  render(<AumentosGrupos {...props} />);
  return props;
}

describe("AumentosGrupos", () => {
  it("mostra loading", () => {
    setup({ isLoading: true });
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("mostra empty state sem grupos", () => {
    setup({ grupos: [] });
    expect(screen.getByText("Nenhum aumento cadastrado ainda.")).toBeTruthy();
  });

  it("renderiza linha do aumento e % médio formatado", () => {
    setup();
    expect(screen.getByText("Reajuste X")).toBeTruthy();
    expect(screen.getByText("12.50%")).toBeTruthy();
    expect(screen.getByText("Vigente")).toBeTruthy();
    expect(screen.getByText("1 aumento")).toBeTruthy();
  });

  it("dispara onRowClick ao clicar na linha", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Reajuste X"));
    expect(props.onRowClick).toHaveBeenCalledWith(1);
  });

  it("dispara onToggleMes ao clicar no header do mês", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Abril 2026"));
    expect(props.onToggleMes).toHaveBeenCalledWith("2026-04");
  });

  it("oculta a tabela quando o mês está colapsado", () => {
    setup({ isCollapsed: () => true });
    expect(screen.getByText("Abril 2026")).toBeTruthy();
    expect(screen.queryByText("Reajuste X")).toBeNull();
  });

  it("mês vazio mostra CTA de upload", () => {
    const props = setup({ grupos: [grupoVazio] });
    expect(screen.getByText("Nenhum aumento cadastrado neste mês.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Upload PDF/ }));
    expect(props.onUploadClick).toHaveBeenCalledTimes(1);
  });
});
