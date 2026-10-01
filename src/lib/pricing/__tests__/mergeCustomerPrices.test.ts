import { describe, it, expect } from "vitest";
import * as modulo from "../mergeCustomerPrices";
import { isValidUnitPrice } from "../mergeCustomerPrices";

// MONEY-PATH. `isValidUnitPrice` é o guard de preço unitário da proposta de cotação do WhatsApp:
// preço inválido (≤0, NaN, Infinity, não-numérico) não vira preço (ausente ≠ zero, money-path #2/#5).
//
// O `mergeCustomerPrices` que dava nome ao arquivo foi APOSENTADO em 2026-09-30, quando a edge
// `analyze-unified-order` deixou de precificar (a IA só identifica; o item nasce pelo `precoPartida`).
// Os testes dele — e a calibração da canária `praticado-vence-omie-v1` que rodava o merge — saíram
// junto: o que a canária atesta agora (`ia-nao-precifica-v1`) é provado em
// supabase/functions/analyze-unified-order/saida-ia_test.ts e src/lib/governanca/__tests__/canaria-preco.test.ts.

describe("isValidUnitPrice — guard money-path (finito e > 0)", () => {
  it("aceita número positivo finito", () => {
    expect(isValidUnitPrice(123)).toBe(true);
    expect(isValidUnitPrice(0.01)).toBe(true);
  });

  it("rejeita 0, negativo, NaN, ±Infinity", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(isValidUnitPrice(bad)).toBe(false);
    }
  });

  it("rejeita não-números (null, undefined, string)", () => {
    for (const bad of [null, undefined, "123"]) {
      expect(isValidUnitPrice(bad)).toBe(false);
    }
  });
});

describe("aposentadoria do merge: o módulo não exporta mais um 2º decisor de preço", () => {
  it("só `isValidUnitPrice` é exportado — religar `mergeCustomerPrices` exige reabrir a decisão", () => {
    expect(Object.keys(modulo).sort()).toEqual(["isValidUnitPrice"]);
  });
});
