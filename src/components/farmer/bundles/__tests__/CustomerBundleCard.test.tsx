import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomerBundleCard } from "../CustomerBundleCard";
import type { CustomerBundles, IndividuaisDoCliente } from "@/hooks/useBundleEngine";
import type { CelulaIndividual } from "@/lib/farmer/melhor-individual";
import type { useDiagnosticQuestions } from "@/hooks/useDiagnosticQuestions";

const NENHUM: CelulaIndividual = { status: "nenhum" };
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
  individuais: { cross_sell: NENHUM, up_sell: NENHUM },
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

/** Expande o cartão com as células dadas — o resto do cliente fica igual em todos os casos. */
const comCelulas = (individuais: Partial<IndividuaisDoCliente>) =>
  setup({
    data: {
      ...data,
      individuais: { cross_sell: NENHUM, up_sell: NENHUM, ...individuais },
    } as unknown as CustomerBundles,
    expanded: true,
  });

const ELEITO: CelulaIndividual = {
  status: "encontrado", situacao: "eleito", nomes: ["Verniz PU 900"], produtos: 1, candidatos: 3,
};

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
    expect(screen.queryByText("Melhor complementar")).toBeNull();
  });

  // ── As DUAS rotas, rotuladas ─────────────────────────────────────────────────────────────
  //
  // Havia UMA célula "Melhor individual", e o que ela mostrava saía de comparar
  // `affinity_score` entre dois motores cujas escalas não são comensuráveis: up_sell venceu
  // 186 de 186 pares medidos em prod (07/09/2026), uma precedência de tipo que ninguém decidiu.
  // Duas células entregam as duas ofertas e devolvem a escolha a quem conhece o cliente.
  it("expandido, mostra as duas rotas com rótulos distintos", () => {
    comCelulas({});
    expect(screen.getByText("Melhor complementar")).toBeTruthy();
    expect(screen.getByText("Melhor upgrade")).toBeTruthy();
  });

  it("cada rota mostra a SUA oferta — uma não vaza para a outra", () => {
    // O discriminador da chave de Map por `(cliente, tipo)`: com a chave antiga uma das duas
    // linhas sobrescrevia a outra, e a rota perdida virava `nenhum` — um veredicto.
    comCelulas({
      cross_sell: ELEITO,
      up_sell: { status: "encontrado", situacao: "unico_registrado", nomes: ["Selador 500"], produtos: 1, candidatos: 1 },
    });
    expect(screen.getByText("Verniz PU 900")).toBeTruthy();
    expect(screen.getByText("Selador 500")).toBeTruthy();
    expect(screen.getByText("Única registrada")).toBeTruthy();
    // `eleito` é o ÚNICO estado sem qualificador — ali houve eleição de verdade.
    expect(screen.queryByText("Igualmente indicados")).toBeNull();
  });

  // ── Os estados: o RÓTULO é quem afirma prioridade, não a lista de nomes ──────────────────
  it.each([
    ["empatado", "Igualmente indicados"],
    ["unico_registrado", "Única registrada"],
    ["ordem_indisponivel", "Ordenação indisponível"],
    ["referencia_ambigua", "Sem ordem confiável"],
  ] as const)("estado `%s` nomeia os produtos E declara o que sabe (%s)", (situacao, qualificador) => {
    const doisNomes = situacao === "unico_registrado" ? ["Fundo PU"] : ["Fundo PU", "Massa 700"];
    comCelulas({
      cross_sell: {
        status: "encontrado", situacao, nomes: doisNomes,
        produtos: doisNomes.length, candidatos: Math.max(doisNomes.length, 1),
      },
    });
    expect(screen.getByText(qualificador)).toBeTruthy();
    // Nomear em TODO estado é o que evita trocar uma mentira por uma omissão: sem os nomes, os
    // 52 clientes cross-only — onde nenhuma eleição é recuperável — ficariam com uma célula
    // que só avisa indisponibilidade permanente, sem nada acionável.
    expect(screen.getByText(new RegExp("Fundo PU"))).toBeTruthy();
  });

  it("`empatado` que perdeu um nome segue empatado — o sobrevivente NÃO vira vencedor", () => {
    // Esconder o participante que o catálogo não soube nomear converteria falha de catálogo em
    // eleição — a fabricação exata que esta tela existe para não cometer (achado R3/3).
    comCelulas({
      cross_sell: { status: "encontrado", situacao: "empatado", nomes: ["Fundo PU"], produtos: 2, candidatos: 2 },
    });
    expect(screen.getByText("Igualmente indicados")).toBeTruthy();
    expect(screen.getByText("1 de 2 sem nome")).toBeTruthy();
  });

  it("`empatado` cujo topo é menor que o grupo declara os dois números", () => {
    comCelulas({
      cross_sell: { status: "encontrado", situacao: "empatado", nomes: ["Fundo PU", "Massa 700"], produtos: 2, candidatos: 5 },
    });
    expect(screen.getByText("empate entre 2 de 5")).toBeTruthy();
  });

  it("`eleito` NÃO declara os candidatos que perderam — eles não estão escondidos", () => {
    // `candidatos: 3` com 1 nome é o normal do estado eleito: os outros dois foram VENCIDOS.
    // Um rodapé "1 de 3" ali sugeriria informação sonegada onde houve decisão.
    comCelulas({ cross_sell: ELEITO });
    expect(screen.getByText("Verniz PU 900")).toBeTruthy();
    expect(screen.queryByText(/de 3/)).toBeNull();
    expect(screen.queryByText(/sem nome/)).toBeNull();
  });

  // ── As TRÊS ausências, que não podem renderizar igual ────────────────────────────────────
  //
  // O card renderizava `bestIndividual?.productName ?? '—'`: "li e não existe" e "não consegui
  // ler" davam o MESMO traço. Um traço não fabrica número, mas — somado ao filtro que omitia
  // da lista o cliente sem bundle próprio — fabricava a AFIRMAÇÃO "não há rota individual para
  // este cliente". É o §2 do money-path (ausente ≠ zero) na forma de rótulo.
  it("`nenhum` mostra o traço — a leitura ACONTECEU e não há oferta", () => {
    comCelulas({});
    expect(screen.getAllByText("—").length).toBe(2);
    expect(screen.queryByText("Indisponível")).toBeNull();
  });

  it("`indisponivel` diz que não sabe — e NÃO usa o mesmo traço do `nenhum`", () => {
    comCelulas({
      cross_sell: { status: "indisponivel", motivo: "leitura_falhou" },
      up_sell: { status: "indisponivel", motivo: "produto_nao_resolve" },
    });
    expect(screen.getAllByText("Indisponível").length).toBe(2);
    // O discriminador: se o traço aparecesse aqui também, a falha de leitura seguiria
    // indistinguível da ausência verificada — que é exatamente o defeito corrigido.
    expect(screen.queryByText("—")).toBeNull();
  });

  it("os dois motivos de `indisponivel` explicam coisas DIFERENTES", () => {
    // Mesmo rótulo, `title` distinto: "não consegui ler" pede recálculo, "o SKU sumiu do
    // catálogo" não. Fundir os textos apagaria a única pista de o que fazer a seguir.
    comCelulas({
      cross_sell: { status: "indisponivel", motivo: "leitura_falhou" },
      up_sell: { status: "indisponivel", motivo: "produto_nao_resolve" },
    });
    const titulos = screen.getAllByText("Indisponível").map((e) => e.getAttribute("title") ?? "");
    expect(titulos.some((t) => t.includes("falhou nesta execução"))).toBe(true);
    expect(titulos.some((t) => t.includes("identificar nenhum produto"))).toBe(true);
  });

  // ── O zero fabricado que a própria correção tornou comum (achado 4 do challenge Codex) ────
  //
  // `melhorProbabilidade = data.bundles[0]?.pBundle ?? 0` fazia "não há bundle" virar
  // "0,0% de conversão" — em VERDE de sucesso. Era raro porque o cliente sem bundle costumava
  // ser OMITIDO da lista; deixou de ser: com a comparação `indisponivel` esses clientes
  // passam a entrar de propósito, e na maior carteira isso são milhares de cartões anunciando
  // uma taxa que ninguém calculou. É `Number(null) === 0` na forma de rótulo.
  it("sem bundle NÃO vira `0,0% de conversão` — nem colapsado, nem expandido", () => {
    comCelulas({});
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

  // ── O aviso do cartão RECOLHIDO ──────────────────────────────────────────────────────────
  //
  // Sem ele, o cliente que só entrou na lista por causa da falha se apresenta como um cartão
  // comum, e o operador teria de expandir um a um para descobrir que não sabemos nada dele.
  it("colapsado, as DUAS rotas indisponíveis anunciam a comparação inteira", () => {
    setup({
      expanded: false,
      data: {
        ...data,
        individuais: {
          cross_sell: { status: "indisponivel", motivo: "leitura_falhou" },
          up_sell: { status: "indisponivel", motivo: "leitura_falhou" },
        },
      } as unknown as CustomerBundles,
    });
    expect(screen.getByText("comparação indisponível")).toBeTruthy();
  });

  it("colapsado, UMA rota indisponível não é apresentada como a comparação toda", () => {
    // A célula que sobrou tem informação acionável. Dizer "comparação indisponível" com uma
    // oferta legível na tela exageraria a falha — e exagerar também é descrever errado.
    setup({
      expanded: false,
      data: {
        ...data,
        individuais: { cross_sell: ELEITO, up_sell: { status: "indisponivel", motivo: "produto_nao_resolve" } },
      } as unknown as CustomerBundles,
    });
    expect(screen.getByText("1 rota indisponível")).toBeTruthy();
    expect(screen.queryByText("comparação indisponível")).toBeNull();
  });

  it("colapsado e tudo íntegro: nenhum aviso — senão o operador aprende a ignorá-lo", () => {
    setup({ expanded: false, data: { ...data, individuais: { cross_sell: ELEITO, up_sell: NENHUM } } as unknown as CustomerBundles });
    expect(screen.queryByText(/indisponível/)).toBeNull();
  });
});
