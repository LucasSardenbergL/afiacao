import { describe, expect, it } from "vitest";
import { casaPadrao } from "../padrao";

describe("casaPadrao — gramática restrita de globs do manifesto", () => {
  it("dir/** casa qualquer profundidade sob o dir", () => {
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro/dre.ts")).toBe(true);
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro/__tests__/dre.test.ts")).toBe(true);
  });

  it("dir/** NÃO casa o próprio dir nem vizinho com prefixo comum", () => {
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro")).toBe(false);
    expect(casaPadrao("src/lib/fin/**", "src/lib/financeiro/dre.ts")).toBe(false);
  });

  it("* casa dentro de um único segmento (não atravessa /)", () => {
    expect(casaPadrao("src/pages/Financeiro*.tsx", "src/pages/FinanceiroDashboard.tsx")).toBe(true);
    expect(casaPadrao("src/pages/Financeiro*.tsx", "src/pages/sub/FinanceiroX.tsx")).toBe(false);
  });

  it("* aceita vazio (prefixo exato também casa)", () => {
    expect(casaPadrao("src/pages/Tint*.tsx", "src/pages/Tint.tsx")).toBe(true);
  });

  it("caminho exato casa só ele mesmo", () => {
    expect(casaPadrao("src/lib/reposicao.ts", "src/lib/reposicao.ts")).toBe(true);
    expect(casaPadrao("src/lib/reposicao.ts", "src/lib/reposicao/motor.ts")).toBe(false);
  });

  it("escapa caracteres de regex no padrão (. não vira curinga)", () => {
    expect(casaPadrao("src/lib/a.ts", "src/lib/aXts")).toBe(false);
  });
});
