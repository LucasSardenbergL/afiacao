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
    // Tri-estado (money-path — ausente ≠ zero). `null` = não havia bundle prioritário na
    // geração do plano: o estado de 339/339 planos em prod (psql-ro, 2026-07-31).
    bundleLie: null,
    bundleProbability: null,
    bundleIncrementalMargin: null,
    bestIndividualLie: null,
    diagnosticQuestions: [],
    implicationQuestion: "",
    offerTransition: "",
    probableObjections: [],
    ltvProjection: null,
    expectedResult: null,
    operationalRisks: [],
    estimatedProfitPerHour: null,
    status: "ativo",
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Valor renderizado na MetricRow de um rótulo. Buscar `getByText("—")` solto no card
 * ficou ambíguo quando os números do bundle viraram tri-estado (a caixinha "LIE" do topo
 * também passa a mostrar "—"): a asserção casava por acaso e deixaria de discriminar QUAL
 * campo degradou. `<span>{label}</span><span>{value}</span>` — o valor é o irmão seguinte.
 */
function valorDaMetrica(label: string): string | null {
  const el = screen.getByText(label);
  const txt = el.nextElementSibling?.textContent;
  // `toLocaleString('pt-BR', { style: 'currency' })` separa "R$" do número com NBSP
  // (U+00A0) — comparar `textContent` cru falharia com duas strings visualmente iguais.
  return txt == null ? null : txt.replace(/\s+/g, ' ').trim();
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
      expect(valorDaMetrica("Margem atual")).toBe("—");
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

  // Mesmo raciocínio da margem, no campo irmão que ficou para trás. `expansion_score` não tem
  // writer: é NULL em 6.633/6.633 linhas de farmer_client_scores (psql-ro, 2026-07-29), então
  // "0%" aqui não seria um caso de borda — era o que a vendedora via para TODO cliente, lido
  // como "não há espaço para crescer nesta conta".
  describe("potencial de expansão — ausência não pode virar 0%", () => {
    // O prefixo ASCII é âncora de falsificação: o harness casa "[POT-CARD]" com `grep -F`, e o
    // nome acentuado não serve para isso (o `grep` deste shell é shim para ugrep, que dobra
    // acento em todo locale — money-path.md manda ancorar em trecho ASCII, caixa fixa). A
    // primeira rodada da falsificação reportou "vermelho no lugar errado" só por causa disso.
    it("[POT-CARD] potencial não medido exibe travessão, não 0%", () => {
      setup({ expanded: true, plan: makePlan({ expansionPotential: null }) });
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
      expect(screen.queryByText("0%")).toBeNull();
    });

    it("potencial ZERO medido continua sendo 0% — é veredito, não ausência", () => {
      // O par que impede a correção de virar "esconde tudo": no dia em que um produtor
      // apurar potencial nulo, esse fato tem de chegar à tela.
      setup({ expanded: true, plan: makePlan({ expansionPotential: 0 }) });
      expect(screen.getByText("0%")).toBeTruthy();
    });

    it("potencial medido é exibido como percentual", () => {
      setup({ expanded: true, plan: makePlan({ expansionPotential: 60 }) });
      expect(screen.getByText("60%")).toBeTruthy();
    });
  });

  // LTV/cenários são blocos PARCIALMENTE mensuráveis: a edge grava número no campo que a
  // IA apurou e null no que ela não apurou. Os guards do card (`plan.ltvProjection && …`)
  // só testam o OBJETO — com um campo null lá dentro, o `fmt()` antigo executava
  // `null.toLocaleString()` e o ErrorBoundary global trocava o app inteiro por "Algo deu
  // errado". Achado do /codex no PR da migração para a Anthropic.
  describe("blocos parcialmente medidos não derrubam a tela", () => {
    it("LTV com campos não medidos renderiza travessão em vez de quebrar", () => {
      setup({
        expanded: true,
        plan: makePlan({
          planType: "estrategico",
          ltvProjection: { current_annual: 120000, projected_annual: null, growth_pct: null },
        }),
      });
      expect(screen.getByText("Projeção de LTV")).toBeTruthy();
      expect(screen.getByText("R$ 120.000,00")).toBeTruthy();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });

    it("cenários de margem não medidos renderizam travessão", () => {
      setup({
        expanded: true,
        plan: makePlan({
          planType: "estrategico",
          expectedResult: { best_case_margin: null, likely_margin: 22, worst_case_margin: null },
        }),
      });
      expect(screen.getByText("R$ 22,00")).toBeTruthy();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });

    it("objeção sem probabilidade estimada não exibe badge de 0%", () => {
      // A edge OMITE `probability` quando a IA não soube estimar. Exibir "0%" afirmaria
      // que o cliente não vai levantar a objeção — algo que ninguém mediu.
      setup({
        expanded: true,
        plan: makePlan({
          probableObjections: [
            { objection: "Preço alto", technical_response: "t", economic_response: "e" },
          ],
        }),
      });
      expect(screen.getByText("⚠ Preço alto")).toBeTruthy();
      expect(screen.queryByText("0%")).toBeNull();
      expect(screen.queryByText("undefined%")).toBeNull();
    });

    it("sem bundle: a métrica LIE do topo mostra travessão, não R$ 0,00", () => {
      // O card SEMPRE exibe a caixinha "LIE" — e para 339/339 planos em prod ela dizia
      // "R$ 0,00". "Não há bundle" ≠ "o bundle não vale nada".
      setup({ plan: makePlan({ bundleLie: null }) });
      expect(screen.getByText("LIE")).toBeTruthy();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
      expect(screen.queryByText("R$ 0,00")).toBeNull();
    });

    it("sem LIE não afirma lucro estimado por hora", () => {
      // `estimatedProfitPerHour` deriva do LIE: sem LIE é INDECIDÍVEL, não "R$ 0,00/h".
      setup({ plan: makePlan({ bundleLie: null, estimatedProfitPerHour: null }) });
      expect(screen.queryByText(/Lucro estimado/)).toBeNull();
    });

    it("seção do bundle some quando não há LIE medido", () => {
      setup({ expanded: true, plan: makePlan({ bundleLie: null }) });
      expect(screen.queryByText("Bundle Prioritário")).toBeNull();
    });

    it("bundle com LIE medido mas probabilidade/margem ausentes renderiza travessão", () => {
      // p_bundle/m_bundle são nullable na origem — "0,0%" de chance de fechar é veredito
      // sobre o bundle que ninguém calculou.
      setup({
        expanded: true,
        plan: makePlan({
          bundleLie: 1250.5,
          bundleProbability: null,
          bundleIncrementalMargin: null,
          bestIndividualLie: null,
        }),
      });
      expect(screen.getByText("Bundle Prioritário")).toBeTruthy();
      expect(valorDaMetrica("LIE Bundle")).toBe("R$ 1.250,50");
      expect(valorDaMetrica("Probabilidade")).toBe("—");
      expect(valorDaMetrica("Margem incremental")).toBe("—");
      expect(screen.queryByText("0,0%")).toBeNull();
      expect(screen.queryByText("Melhor individual")).toBeNull();
    });

    it("bundle inteiramente medido continua exibindo os números", () => {
      setup({
        expanded: true,
        plan: makePlan({
          bundleLie: 800,
          bundleProbability: 62.5,
          bundleIncrementalMargin: 310,
          bestIndividualLie: 120,
        }),
      });
      expect(valorDaMetrica("Probabilidade")).toBe("62.5%");
      expect(valorDaMetrica("Margem incremental")).toBe("R$ 310,00");
      expect(valorDaMetrica("Melhor individual")).toBe("R$ 120,00");
    });
  });
});
