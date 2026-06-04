import { describe, it, expect } from "vitest";
import { normalizeTipoProduto } from "@/lib/reposicao/tipo-produto";

describe("normalizeTipoProduto", () => {
  it("normaliza dígito único pra 2 dígitos", () => {
    expect(normalizeTipoProduto("4")).toBe("04");
    expect(normalizeTipoProduto("0")).toBe("00");
    expect(normalizeTipoProduto(4)).toBe("04");
  });

  it("preserva 2 dígitos válidos", () => {
    expect(normalizeTipoProduto("04")).toBe("04");
    expect(normalizeTipoProduto("00")).toBe("00");
    expect(normalizeTipoProduto("13")).toBe("13");
  });

  it("rejeita Kit e não-numérico → null (não confundir com tipo fiscal)", () => {
    expect(normalizeTipoProduto("K")).toBeNull();
    expect(normalizeTipoProduto("abc")).toBeNull();
    expect(normalizeTipoProduto("4A")).toBeNull();
  });

  it("ausência/ruído → null (= não escrever a coluna)", () => {
    expect(normalizeTipoProduto(null)).toBeNull();
    expect(normalizeTipoProduto(undefined)).toBeNull();
    expect(normalizeTipoProduto("")).toBeNull();
    expect(normalizeTipoProduto("   ")).toBeNull();
    expect(normalizeTipoProduto("100")).toBeNull(); // >2 dígitos: fora do padrão Omie
  });
});
