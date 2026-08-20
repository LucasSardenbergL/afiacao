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
  bestIndividual: { status: "nenhum" },
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

  // ── Os TRÊS estados da comparação individual ────────────────────────────────────────────
  //
  // O card renderizava `data.bestIndividual?.productName ?? '—'`, e o tipo era
  // `IndividualComparison | null`: "li e não existe" e "não consegui ler" davam o MESMO traço.
  // Um traço não fabrica número, mas — somado ao filtro que omitia da lista o cliente sem
  // bundle próprio — fabricava a AFIRMAÇÃO "não há rota individual para este cliente". É o §2
  // do money-path (ausente ≠ zero) na forma de rótulo. O tipo agora discrimina, e a tela tem
  // de mostrar a diferença: se os dois estados renderizassem igual, a união seria decorativa.
  const comData = (bestIndividual: unknown) =>
    setup({ data: { ...data, bestIndividual } as unknown as CustomerBundles, expanded: true });

  it("expandido, `encontrado` mostra o nome do produto", () => {
    comData({
      status: "encontrado",
      value: { productId: "p1", productName: "Verniz PU 900", affinity: 0.42, type: "cross_sell" },
    });
    expect(screen.getByText("Verniz PU 900")).toBeTruthy();
    expect(screen.queryByText("Comparação indisponível")).toBeNull();
  });

  it("expandido, `nenhum` mostra o traço — a leitura ACONTECEU e não há oferta", () => {
    comData({ status: "nenhum" });
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("Comparação indisponível")).toBeNull();
  });

  it("expandido, `indisponivel` diz que não sabe — e NÃO usa o mesmo traço do `nenhum`", () => {
    comData({ status: "indisponivel", motivo: "leitura_falhou" });
    expect(screen.getByText("Comparação indisponível")).toBeTruthy();
    // O discriminador: se o traço aparecesse aqui também, a falha de leitura seguiria
    // indistinguível da ausência verificada — que é exatamente o defeito corrigido.
    expect(screen.queryByText("—")).toBeNull();
  });

  // ── O zero fabricado que a própria correção tornou comum (achado 4 do challenge Codex) ────
  //
  // `melhorProbabilidade = data.bundles[0]?.pBundle ?? 0` fazia "não há bundle" virar
  // "0,0% de conversão" — em VERDE de sucesso. Era raro porque o cliente sem bundle costumava
  // ser OMITIDO da lista; deixou de ser: com a comparação `indisponivel` esses clientes
  // passam a entrar de propósito, e na maior carteira isso são milhares de cartões anunciando
  // uma taxa que ninguém calculou. É `Number(null) === 0` na forma de rótulo.
  it("sem bundle NÃO vira `0,0% de conversão` — nem colapsado, nem expandido", () => {
    comData({ status: "nenhum" });
    expect(screen.queryByText(/0\.0% de conversão/)).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.getAllByText(/[Ss]em bundle/).length).toBeGreaterThan(0);
  });

  it("CONTRAPROVA: COM bundle, a porcentagem real continua aparecendo", () => {
    // Sem esta, trocar a renderização por um literal fixo passaria no teste acima.
    // Colapsado de propósito: expandir renderiza `BundleCardFull`, que usa `useNavigate` e
    // exigiria um Router — o cabeçalho já carrega a porcentagem, que é o que está sob teste.
    setup({
      expanded: false,
      data: {
        ...data,
        bundles: [{ pBundle: 42.5 } as unknown as CustomerBundles["bundles"][number]],
      } as unknown as CustomerBundles,
    });
    expect(screen.getByText(/42\.5% de conversão/)).toBeTruthy();
    expect(screen.queryByText(/[Ss]em bundle/)).toBeNull();
  });

  it("colapsado, `indisponivel` já se anuncia — sem precisar expandir cartão por cartão", () => {
    setup({
      expanded: false,
      data: { ...data, bestIndividual: { status: "indisponivel", motivo: "leitura_falhou" } } as unknown as CustomerBundles,
    });
    expect(screen.getByText("comparação indisponível")).toBeTruthy();
  });
});
