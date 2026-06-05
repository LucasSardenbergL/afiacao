import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkuRow } from "../SkuRow";
import type { RowWithPrice } from "@/lib/reposicao/sku-param";

function row(p: Partial<RowWithPrice>): RowWithPrice {
  return {
    id: "row-1",
    empresa: "OBEN",
    sku_codigo_omie: 12345,
    sku_descricao: "TINTA BASE BRANCA",
    fornecedor_nome: "Sayerlack",
    classe_consolidada: "AX",
    classe_abc: "A", classe_xyz: "X",
    demanda_media_diaria: 3, demanda_desvio_padrao: 1, demanda_coef_variacao: 0.3,
    demanda_dias_com_movimento: 40, demanda_total_90d: 270, valor_vendido_90d: 9000,
    lt_medio_dias_uteis: 7, lt_desvio_padrao_dias: 2, lt_p95_dias: 12, lt_n_observacoes: 8,
    fonte_leadtime: "historico", estoque_minimo: 10, ponto_pedido: 20, estoque_maximo: 40,
    estoque_seguranca: 5, minimo_forcado_manual: null, z_score: 1.65, cobertura_alvo_dias: 30, aplicar_no_omie: false,
    aprovado_em: null, aprovado_por: null, justificativa_aprovacao: null, ultima_atualizacao_calculo: null,
    preco_compra_real: 18.5, preco_venda_medio: 30, fonte_preco: "omie", read_only: false,
    ...p,
  };
}

function renderRow(r: RowWithPrice, overrides: Partial<React.ComponentProps<typeof SkuRow>> = {}) {
  const props: React.ComponentProps<typeof SkuRow> = {
    row: r, checked: false, onToggleSelect: vi.fn(), onOpenDetail: vi.fn(), ...overrides,
  };
  render(<table><tbody><SkuRow {...props} /></tbody></table>);
  return props;
}

describe("SkuRow", () => {
  it("renderiza código, descrição, classe e status Pendente", () => {
    renderRow(row({}));
    expect(screen.getByText("12345")).toBeTruthy();
    expect(screen.getByText("TINTA BASE BRANCA")).toBeTruthy();
    expect(screen.getByText("AX")).toBeTruthy();
    expect(screen.getByText("Pendente")).toBeTruthy();
  });

  it("checkbox dispara onToggleSelect com o id", () => {
    const props = renderRow(row({}));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(props.onToggleSelect).toHaveBeenCalledWith("row-1", true);
  });

  it("status Aprovado quando aprovado_em presente", () => {
    renderRow(row({ aprovado_em: "2026-05-20T00:00:00Z" }));
    expect(screen.getByText("Aprovado")).toBeTruthy();
  });

  it("read_only: sem checkbox, badge de fornecedor e status Aguardando", () => {
    renderRow(row({ read_only: true }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Sayerlack/)).toBeTruthy();
    expect(screen.getByText("Aguardando fornecedor")).toBeTruthy();
  });

  it("Detalhes dispara onOpenDetail com a linha", () => {
    const r = row({});
    const props = renderRow(r);
    fireEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    expect(props.onOpenDetail).toHaveBeenCalledWith(r);
  });
});
