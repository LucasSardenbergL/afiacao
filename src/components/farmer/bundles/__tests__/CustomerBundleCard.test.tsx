import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomerBundleCard } from "../CustomerBundleCard";
import type { CustomerBundles } from "@/hooks/useBundleEngine";
import type { useDiagnosticQuestions } from "@/hooks/useDiagnosticQuestions";

const data = {
  customerId: "c1",
  customerName: "Cliente X",
  healthScore: 70,
  avgMonthlySpend: 1000,
  grossMarginPct: 30,
  categoryCount: 5,
  daysSinceLastPurchase: 10,
  cnae: null,
  customerType: null,
  recentProducts: null,
  bundles: [],
  bestIndividual: null,
} as unknown as CustomerBundles;

const diagHook = {
  questions: {},
  generating: {},
  generateQuestions: vi.fn(),
  setResponse: vi.fn(),
  toggleAlt: vi.fn(),
  saveQuestionsToDb: vi.fn(),
} as unknown as ReturnType<typeof useDiagnosticQuestions>;

function setup(overrides: Partial<React.ComponentProps<typeof CustomerBundleCard>> = {}) {
  const props: React.ComponentProps<typeof CustomerBundleCard> = {
    data,
    expanded: false,
    onToggle: vi.fn(),
    bundleArgs: {},
    argGenerating: {},
    onGenerateArgument: vi.fn(),
    diagHook,
    ...overrides,
  };
  render(<CustomerBundleCard {...props} />);
  return props;
}

describe("CustomerBundleCard", () => {
  it("mostra cabeçalho com nome, health score e contagem de bundles", () => {
    setup();
    expect(screen.getByText("Cliente X")).toBeTruthy();
    expect(screen.getByText("HS 70")).toBeTruthy();
    expect(screen.getByText("0 bundles")).toBeTruthy();
  });

  it("dispara onToggle ao clicar no cabeçalho", () => {
    const props = setup();
    fireEvent.click(screen.getByText("Cliente X"));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it("não renderiza a comparação quando colapsado", () => {
    setup();
    expect(screen.queryByText("📊 Comparação Inteligente")).toBeNull();
  });
});
