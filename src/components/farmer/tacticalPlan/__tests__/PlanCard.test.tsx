import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanCard } from "../PlanCard";
import type { TacticalPlan } from "@/hooks/useTacticalPlan";

// PlanCard → RecordResultDialog lê useImpersonation pra desabilitar o registro na lente
// "Ver como". Fora da lente (isImpersonating=false) o botão segue habilitado — testado aqui.
vi.mock("@/contexts/ImpersonationContext", () => ({ useImpersonation: vi.fn(() => ({ isImpersonating: false })) }));

function makePlan(overrides: Partial<TacticalPlan> = {}): TacticalPlan {
  return {
    id: "p1",
    customerId: "c1",
    customerName: "Marcenaria Alfa",
    planType: "essencial",
    healthScore: 72,
    churnRisk: 18,
    mixGap: 3,
    currentMarginPct: 12.5,
    clusterAvgMarginPct: 15,
    expansionPotential: 40,
    strategicObjective: "recuperacao",
    customerProfile: "misto",
    approachStrategy: "",
    approachStrategyB: "",
    topBundle: {},
    secondBundle: {},
    bundleLie: 0,
    bundleProbability: 0,
    bundleIncrementalMargin: 0,
    bestIndividualLie: 0,
    diagnosticQuestions: [],
    implicationQuestion: "",
    offerTransition: "",
    probableObjections: [],
    ltvProjection: null,
    expectedResult: null,
    operationalRisks: [],
    estimatedProfitPerHour: 0,
    status: "ativo",
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof PlanCard>> = {}) {
  const props: React.ComponentProps<typeof PlanCard> = {
    plan: makePlan(),
    expanded: false,
    onToggle: vi.fn(),
    onCopy: vi.fn(),
    copiedText: null,
    onRecordResult: vi.fn(async () => {}),
    ...overrides,
  };
  render(<PlanCard {...props} />);
  return props;
}

describe("PlanCard", () => {
  it("mostra nome do cliente, objetivo, tipo e health", () => {
    setup();
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("🔴 Recuperação")).toBeTruthy();
    expect(screen.getByText("📋 Essencial")).toBeTruthy();
    expect(screen.getByText("72")).toBeTruthy();
  });

  it("dispara onToggle ao clicar no cabeçalho", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Marcenaria Alfa"));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it("ao expandir mostra diagnóstico e o botão de registrar resultado", () => {
    setup({ expanded: true });
    expect(screen.getByText("Diagnóstico Resumido")).toBeTruthy();
    expect(screen.getByText("Registrar Resultado")).toBeTruthy();
  });

  it("quando concluído oculta registrar resultado e exibe o resumo", () => {
    setup({
      expanded: true,
      plan: makePlan({ status: "concluido", planFollowed: true, callResult: "venda_realizada" }),
    });
    expect(screen.queryByText("Registrar Resultado")).toBeNull();
    expect(screen.getByText("Resultado registrado")).toBeTruthy();
  });
});
