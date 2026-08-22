import { describe, expect, it } from "vitest";
import { casaPadrao, padraoParaRegex } from "../padrao";

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

describe("casaPadrao — compilação memoizada (o mesmo padrão não recompila)", () => {
  it("devolve a MESMA instância de RegExp para o mesmo padrão", () => {
    // Sem memoização o gate do manifesto recompila ~1,9M regex (26,64us cada = ~40s)
    // e estoura o testTimeout de 20s. O regex é função pura da string do padrão.
    expect(padraoParaRegex("src/lib/a/**")).toBe(padraoParaRegex("src/lib/a/**"));
  });

  it("padrões diferentes NÃO compartilham instância (a chave do cache é o padrão)", () => {
    expect(padraoParaRegex("src/lib/a/**")).not.toBe(padraoParaRegex("src/lib/b/**"));
  });

  it("chaves que colidem com Object.prototype não envenenam o cache", () => {
    expect(padraoParaRegex("constructor")).not.toBe(padraoParaRegex("__proto__"));
    expect(casaPadrao("constructor", "constructor")).toBe(true);
    expect(casaPadrao("__proto__", "constructor")).toBe(false);
  });

  it("regex reusado é STATELESS: chamadas repetidas dão o mesmo resultado", () => {
    // Sentinela: se algum dia padraoParaRegex ganhar flag /g ou /y, o lastIndex
    // compartilhado pelo cache faria o resultado alternar entre chamadas.
    const p = "src/pages/Financeiro*.tsx";
    const alvo = "src/pages/FinanceiroDashboard.tsx";
    expect([casaPadrao(p, alvo), casaPadrao(p, alvo), casaPadrao(p, alvo)]).toEqual([true, true, true]);
    expect(padraoParaRegex(p).lastIndex).toBe(0);
  });
});
