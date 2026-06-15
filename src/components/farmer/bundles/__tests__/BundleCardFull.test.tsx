import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { BundleCardFull } from "../BundleCardFull";
import type { BundleRecommendation } from "@/hooks/useBundleEngine";
import type { CustomerProfile } from "@/hooks/useBundleArguments";
import type { CustomerCtx } from "../types";

// BundleCardFull lê useImpersonation() direto (leaf) pra desabilitar os botões de
// gerar/salvar na lente "Ver como". Mock dinâmico: default fora da lente.
const impMock = vi.fn();
vi.mock("@/contexts/ImpersonationContext", () => ({ useImpersonation: () => impMock() }));

beforeEach(() => { impMock.mockReturnValue({ isImpersonating: false }); });

const bundle = {
  id: "b1",
  products: [
    { name: "Produto A", margin: 100 },
    { name: "Produto B", margin: 50 },
  ],
  lieBundle: 150,
  support: 0.25,
  confidence: 0.5,
  lift: 1.8,
  pBundle: 42,
} as unknown as BundleRecommendation;

const customerCtx: CustomerCtx = {
  name: "Cliente X",
  healthScore: 70,
  avgMonthlySpend: 1000,
  categoryCount: 5,
  daysSinceLastPurchase: 10,
  cnae: null,
  customerType: null,
  recentProducts: null,
};

const profile = "misto" as unknown as CustomerProfile;

function setup(overrides: Partial<React.ComponentProps<typeof BundleCardFull>> = {}) {
  const props: React.ComponentProps<typeof BundleCardFull> = {
    bundle,
    rank: 1,
    bundleKey: "c1_0",
    customerId: "c1",
    customerCtx,
    profile,
    argument: undefined,
    isArgGenerating: false,
    onGenerateArg: vi.fn(),
    questions: [],
    isQuestionsGenerating: false,
    onGenerateQuestions: vi.fn(),
    onSetResponse: vi.fn(),
    onToggleAlt: vi.fn(),
    onSaveQuestions: vi.fn(),
    ...overrides,
  };
  render(
    <MemoryRouter>
      <BundleCardFull {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("BundleCardFull", () => {
  it("renderiza produtos e métricas", () => {
    setup();
    expect(screen.getByText("Produto A")).toBeTruthy();
    expect(screen.getByText("Produto B")).toBeTruthy();
    expect(screen.getByText("25.0%")).toBeTruthy(); // support
    expect(screen.getByText("1.80")).toBeTruthy(); // lift
    expect(screen.getByText("Bundle #1")).toBeTruthy();
    expect(screen.getByText("Montar pedido com este bundle")).toBeTruthy();
  });

  it("gera perguntas SPIN ao abrir a seção sem perguntas", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Perguntas SPIN/ }));
    expect(props.onGenerateQuestions).toHaveBeenCalledTimes(1);
  });

  it("gera argumentação ao abrir a seção sem argumento", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Argumentação/ }));
    expect(props.onGenerateArg).toHaveBeenCalledTimes(1);
  });

  it("na lente: os botões de gerar (Perguntas SPIN / Argumentação) ficam disabled", () => {
    impMock.mockReturnValue({ isImpersonating: true });
    setup();
    expect(screen.getByRole("button", { name: /Perguntas SPIN/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Argumentação/ })).toBeDisabled();
  });
});
