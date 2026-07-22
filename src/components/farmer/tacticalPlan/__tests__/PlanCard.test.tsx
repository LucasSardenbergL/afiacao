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

  // A margem gravada no plano é nullable desde que o servidor passou a distinguir "sem custo
  // cadastrado" de "margem zero". O card é o último ponto do caminho: se ele coagir, todo o
  // trabalho de propagar o null (RPC → coluna → parsePlan) morre no `.toFixed()` final.
  describe("margem atual — ausência não pode virar 0,0%", () => {
    it("margem desconhecida exibe travessão, não 0,0%", () => {
      setup({ expanded: true, plan: makePlan({ currentMarginPct: null }) });
      expect(screen.getByText("—")).toBeTruthy();
      expect(screen.queryByText("0.0%")).toBeNull();
      expect(screen.queryByText("0%")).toBeNull();
    });

    it("margem ZERO medida continua sendo 0% — é veredito, não ausência", () => {
      setup({ expanded: true, plan: makePlan({ currentMarginPct: 0 }) });
      expect(screen.getByText("0%")).toBeTruthy();
    });

    it("margem conhecida é exibida na escala 0–100 que o servidor grava", () => {
      // 53,47 é a média real medida em prod. O assert mira a ESCALA: se alguém voltar a tratar
      // a coluna como fração (o bug histórico), sairia "5347.0%".
      setup({ expanded: true, plan: makePlan({ currentMarginPct: 53.47 }) });
      expect(screen.getByText("53.5%")).toBeTruthy();
    });
  });
});
