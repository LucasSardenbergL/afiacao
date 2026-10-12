import { describe, expect, it } from "vitest";
import { micro, quantidadeRepresentavel } from "../decimal";

describe("decimal do picking", () => {
  it("soma exata em milionésimos", () => {
    expect(micro(0.1) + micro(0.2)).toBe(micro(0.3));
  });

  it("quantidade manual: até 6 casas passa; 7ª casa, zero, negativo e NaN não", () => {
    expect([0.1, 0.3, 1, 2.5, 0.000001, 12.345678].map(quantidadeRepresentavel)).toEqual([true, true, true, true, true, true]);
    // 0,9999996 seria aceito pelo `numeric` do servidor e arredondado a 1 na tela (Codex r2).
    expect([0.9999996, 1.0000000001, 1e-7, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(quantidadeRepresentavel)).toEqual([
      false, false, false, false, false, false, false,
    ]);
  });
});
