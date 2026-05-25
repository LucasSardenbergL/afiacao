import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkuHistoricoDialog } from "../SkuHistoricoDialog";
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

describe("SkuHistoricoDialog", () => {
  it("não renderiza conteúdo quando skuDetalhe é null", () => {
    render(<SkuHistoricoDialog skuDetalhe={null} onOpenChange={vi.fn()} historico={[]} loadingHist={false} />);
    expect(screen.queryByText("Verniz")).toBeNull();
  });

  it("renderiza título e badges (loadingHist evita o gráfico)", () => {
    render(<SkuHistoricoDialog skuDetalhe={makeSku()} onOpenChange={vi.fn()} historico={undefined} loadingHist={true} />);
    expect(screen.getByText("111")).toBeTruthy();
    expect(screen.getByText("Verniz")).toBeTruthy();
    expect(screen.getByText("Violando")).toBeTruthy();
    expect(screen.getByText("Forn A")).toBeTruthy();
  });
});
