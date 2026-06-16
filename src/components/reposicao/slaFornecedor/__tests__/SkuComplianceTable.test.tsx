import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkuComplianceTable } from "../SkuComplianceTable";
import type { SkuCompliance } from "../types";

function makeSku(o: Partial<SkuCompliance> = {}): SkuCompliance {
  return {
    empresa: "colacor",
    sku_codigo_omie: "111",
    sku_descricao: "Verniz",
    fornecedor_nome: "Forn A",
    grupo_codigo: "G1",
    lt_teorico: 10,
    lt_observado_medio: 12,
    lt_recente_medio: 13,
    n_observacoes: 5,
    ultimo_recebimento: "2026-03-01",
    desvio_perc: 12,
    status_sla: "violando",
    tendencia: "piorando",
    ...o,
  };
}

describe("SkuComplianceTable", () => {
  it("mostra empty state sem SKUs", () => {
    render(<SkuComplianceTable skus={[]} loading={false} onSelectSku={vi.fn()} />);
    expect(screen.getByText("Nenhum SKU encontrado com os filtros atuais.")).toBeTruthy();
  });

  it("seleciona SKU clicável (n_observacoes >= 3)", () => {
    const onSelect = vi.fn();
    render(<SkuComplianceTable skus={[makeSku()]} loading={false} onSelectSku={onSelect} />);
    fireEvent.click(screen.getByText("Verniz"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku_codigo_omie: "111" }));
  });

  it("não seleciona SKU com poucas observações", () => {
    const onSelect = vi.fn();
    render(<SkuComplianceTable skus={[makeSku({ n_observacoes: 2 })]} loading={false} onSelectSku={onSelect} />);
    fireEvent.click(screen.getByText("Verniz"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("formata desvio com sinal", () => {
    render(
      <SkuComplianceTable
        skus={[
          makeSku({ desvio_perc: 12 }),
          makeSku({ sku_codigo_omie: "222", sku_descricao: "Cola", desvio_perc: -5 }),
        ]}
        loading={false}
        onSelectSku={vi.fn()}
      />,
    );
    expect(screen.getByText("+12%")).toBeTruthy();
    expect(screen.getByText("-5%")).toBeTruthy();
  });
});
