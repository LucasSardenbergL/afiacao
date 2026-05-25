import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComplianceCardsGrid } from "../ComplianceCardsGrid";
import type { ForCompliance } from "../types";

function makeFor(o: Partial<ForCompliance> = {}): ForCompliance {
  return {
    empresa: "colacor",
    fornecedor_nome: "Forn A",
    skus_total: 10,
    skus_cumprindo: 6,
    skus_limite: 2,
    skus_violando: 1,
    skus_criticos: 1,
    perc_sla_compliance: 85,
    lt_teorico_agregado: 10,
    lt_medio_observado_agregado: 12,
    ...o,
  };
}

describe("ComplianceCardsGrid", () => {
  it("renderiza card de fornecedor com compliance e badges", () => {
    render(<ComplianceCardsGrid fornecedores={[makeFor()]} loading={false} />);
    expect(screen.getByText("Forn A")).toBeTruthy();
    expect(screen.getByText("10 SKUs")).toBeTruthy();
    expect(screen.getByText("85%")).toBeTruthy();
    expect(screen.getByText("6 ok")).toBeTruthy();
    expect(screen.getByText("1 crít.")).toBeTruthy();
  });

  it("mostra empty state sem fornecedores", () => {
    render(<ComplianceCardsGrid fornecedores={[]} loading={false} />);
    expect(screen.getByText("Nenhum fornecedor com dados de SLA disponíveis ainda.")).toBeTruthy();
  });

  it("mostra 3 skeletons em loading", () => {
    const { container } = render(<ComplianceCardsGrid fornecedores={undefined} loading={true} />);
    expect(container.querySelectorAll(".animate-shimmer")).toHaveLength(3);
  });
});
