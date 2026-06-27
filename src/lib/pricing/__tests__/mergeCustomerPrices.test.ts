import { describe, it, expect } from "vitest";
import { mergeCustomerPrices, isValidUnitPrice, type LocalPriceRow } from "../mergeCustomerPrices";

// MONEY-PATH. Este helper resolve o "último preço praticado por produto" que o edge
// `analyze-unified-order` injeta nas sugestões de pedido do vendedor. Regra:
//   - order_items (local) é a FONTE DE VERDADE → vence o Omie;
//   - o Omie só PREENCHE GAPS (produtos sem preço local);
//   - preço inválido (≤0, NaN, Infinity, não-numérico) é IGNORADO (ausente ≠ zero, money-path #2/#5).
// É espelhado VERBATIM no edge (Deno não importa de src/) — a paridade/uso é vigiada por
// src/__tests__/edge-money-path-invariants.test.ts, e a canária {canary:true} roda ESTE
// merge com o fixture 123/999 contra o código REALMENTE DEPLOYADO.

describe("mergeCustomerPrices — order_items vence, Omie preenche gap", () => {
  it("local vence o Omie quando ambos têm o produto (123 local × 999 Omie → 123)", () => {
    const local: LocalPriceRow[] = [{ product_id: "P1", unit_price: 123 }];
    expect(mergeCustomerPrices(local, { P1: 999 })).toEqual({ P1: 123 });
  });

  it("produto só no Omie → fallback para o preço do Omie", () => {
    expect(mergeCustomerPrices([], { P1: 999 })).toEqual({ P1: 999 });
  });

  it("produto só no local → usa o preço local", () => {
    expect(mergeCustomerPrices([{ product_id: "P1", unit_price: 123 }], {})).toEqual({ P1: 123 });
  });

  it("mistura: P1 em ambos (local vence) + P2 só no Omie (gap preenchido)", () => {
    const local: LocalPriceRow[] = [{ product_id: "P1", unit_price: 123 }];
    expect(mergeCustomerPrices(local, { P1: 999, P2: 50 })).toEqual({ P1: 123, P2: 50 });
  });

  it("múltiplos order_items do mesmo produto → first-wins (o mais recente; created_at DESC)", () => {
    const local: LocalPriceRow[] = [
      { product_id: "P1", unit_price: 200 }, // mais recente (chega primeiro)
      { product_id: "P1", unit_price: 180 }, // antigo — ignorado
    ];
    expect(mergeCustomerPrices(local, {})).toEqual({ P1: 200 });
  });

  it("preço local ≤ 0 é ignorado → cai no fallback do Omie", () => {
    expect(mergeCustomerPrices([{ product_id: "P1", unit_price: 0 }], { P1: 999 })).toEqual({ P1: 999 });
    expect(mergeCustomerPrices([{ product_id: "P1", unit_price: -5 }], { P1: 999 })).toEqual({ P1: 999 });
  });

  it("preço Omie ≤ 0 é ignorado → produto fica SEM preço (ausente ≠ zero)", () => {
    expect(mergeCustomerPrices([], { P1: 0, P2: -10 })).toEqual({});
  });

  it("NaN/Infinity são ignorados em ambos os lados (money-path #5)", () => {
    const local: LocalPriceRow[] = [
      { product_id: "P1", unit_price: NaN }, // inválido → cai no Omie
      { product_id: "P2", unit_price: Infinity }, // inválido, sem Omie → ausente
    ];
    expect(mergeCustomerPrices(local, { P1: 999, P3: Infinity })).toEqual({ P1: 999 });
  });

  it("product_id vazio/null no local é ignorado", () => {
    const local: LocalPriceRow[] = [
      { product_id: null, unit_price: 123 },
      { product_id: "", unit_price: 123 },
      { product_id: "P1", unit_price: 123 },
    ];
    expect(mergeCustomerPrices(local, {})).toEqual({ P1: 123 });
  });

  it("unit_price null/undefined no local é ignorado → fallback Omie", () => {
    expect(mergeCustomerPrices([{ product_id: "P1", unit_price: null }], { P1: 999 })).toEqual({ P1: 999 });
  });

  it("inputs vazios → objeto vazio", () => {
    expect(mergeCustomerPrices([], {})).toEqual({});
  });

  it("não muta os inputs", () => {
    const local: LocalPriceRow[] = [{ product_id: "P1", unit_price: 123 }];
    const omie = { P2: 50 };
    mergeCustomerPrices(local, omie);
    expect(local).toEqual([{ product_id: "P1", unit_price: 123 }]);
    expect(omie).toEqual({ P2: 50 });
  });
});

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
