import { describe, it, expect } from "vitest";
import {
  saldoAReceber,
  itemContaComoPendente,
  computePendenteEntradaPorSku,
  type PoItemOmie,
  type PendenteEntradaOpts,
} from "./pendente-entrada-po";

const APROVADO = "15"; // nesta conta Oben, etapa 15 = Aprovado (confirmado no PO 1054)
const EM_APROVACAO = "10";
const CANCELADO = "99";

function opts(over: Partial<PendenteEntradaOpts> = {}): PendenteEntradaOpts {
  return {
    etapasAbertas: new Set([APROVADO]),
    poNumerosEmTransito: new Set<string>(),
    ...over,
  };
}

function item(over: Partial<PoItemOmie> = {}): PoItemOmie {
  return { sku: "8689734299", poNumero: "1054", etapa: APROVADO, qtde: 3, recebido: 0, ...over };
}

describe("saldoAReceber", () => {
  it("qtde - recebido", () => expect(saldoAReceber(3, 0)).toBe(3));
  it("parcial", () => expect(saldoAReceber(4, 1)).toBe(3));
  it("nunca negativo (recebido > qtde = dado torto)", () => expect(saldoAReceber(3, 5)).toBe(0));
  it("recebido igual = 0", () => expect(saldoAReceber(3, 3)).toBe(0));
  it("guarda não-finito", () => {
    expect(saldoAReceber(NaN, 0)).toBe(0);
    expect(saldoAReceber(3, NaN)).toBe(3);
  });
});

describe("itemContaComoPendente", () => {
  it("PO manual aprovada-aberta com saldo CONTA", () => {
    expect(itemContaComoPendente(item(), opts())).toBe(true);
  });
  it("etapa em-aprovação NÃO conta (não comprometido)", () => {
    expect(itemContaComoPendente(item({ etapa: EM_APROVACAO }), opts())).toBe(false);
  });
  it("etapa cancelada NÃO conta", () => {
    expect(itemContaComoPendente(item({ etapa: CANCELADO }), opts())).toBe(false);
  });
  it("PO já contada pelo em_transito NÃO conta (de-dup, anti double-count)", () => {
    expect(
      itemContaComoPendente(item({ poNumero: "2000" }), opts({ poNumerosEmTransito: new Set(["2000"]) })),
    ).toBe(false);
  });
  it("totalmente recebida NÃO conta (já virou físico)", () => {
    expect(itemContaComoPendente(item({ qtde: 3, recebido: 3 }), opts())).toBe(false);
  });
});

describe("computePendenteEntradaPorSku", () => {
  it("caso FUNDO PU/1054: PO manual aprovada futura entra (era o bug)", () => {
    const m = computePendenteEntradaPorSku([item()], opts());
    expect(m.get("8689734299")).toBe(3);
  });

  it("soma múltiplas POs do mesmo SKU", () => {
    const items = [
      item({ poNumero: "1054", qtde: 3, recebido: 0 }),
      item({ poNumero: "1060", qtde: 2, recebido: 0 }),
    ];
    expect(computePendenteEntradaPorSku(items, opts()).get("8689734299")).toBe(5);
  });

  it("recebimento parcial: conta só o saldo a receber", () => {
    const m = computePendenteEntradaPorSku([item({ qtde: 4, recebido: 1 })], opts());
    expect(m.get("8689734299")).toBe(3);
  });

  it("de-dup exato: SKU numa PO do em_transito + numa PO manual -> conta SÓ a manual", () => {
    const items = [
      item({ poNumero: "9000", qtde: 5 }), // do app (em_transito conta)
      item({ poNumero: "1054", qtde: 3 }), // manual
    ];
    const m = computePendenteEntradaPorSku(items, opts({ poNumerosEmTransito: new Set(["9000"]) }));
    expect(m.get("8689734299")).toBe(3); // só a manual; a 9000 fica pro em_transito
  });

  it("PO antiga do app ainda ABERTA, FORA do em_transito (sem buraco de 7d) -> entra aqui", () => {
    // poNumerosEmTransito = só o que a CTE conta hoje; uma PO antiga do app aberta não está lá,
    // então ela DEVE ser contada por esta fonte (senão sumia de ambos = double-buy).
    const m = computePendenteEntradaPorSku(
      [item({ poNumero: "ANTIGA", qtde: 2 })],
      opts({ poNumerosEmTransito: new Set<string>() }),
    );
    expect(m.get("8689734299")).toBe(2);
  });

  it("não cria entrada pra saldo zero (tudo recebido)", () => {
    expect(computePendenteEntradaPorSku([item({ qtde: 3, recebido: 3 })], opts()).size).toBe(0);
  });

  it("entrada vazia -> mapa vazio", () => {
    expect(computePendenteEntradaPorSku([], opts()).size).toBe(0);
  });

  it("vários SKUs", () => {
    const items = [
      item({ sku: "A", poNumero: "1", qtde: 2 }),
      item({ sku: "B", poNumero: "2", qtde: 5, recebido: 1 }),
      item({ sku: "A", poNumero: "3", qtde: 1 }),
    ];
    const m = computePendenteEntradaPorSku(items, opts());
    expect(m.get("A")).toBe(3);
    expect(m.get("B")).toBe(4);
  });
});
