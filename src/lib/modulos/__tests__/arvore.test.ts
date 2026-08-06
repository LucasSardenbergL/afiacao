import { describe, expect, it } from "vitest";
import { listarArquivosSrc } from "../arvore";

describe("listarArquivosSrc", () => {
  const arquivos = listarArquivosSrc();

  it("varre a árvore real e encontra volume plausível (>1000 arquivos)", () => {
    expect(arquivos.length).toBeGreaterThan(1000);
  });

  it("retorna paths POSIX relativos começando com src/", () => {
    expect(arquivos.every((a) => a.startsWith("src/") && !a.includes("\\"))).toBe(true);
  });

  it("inclui âncoras conhecidas (código, teste e não-.ts)", () => {
    expect(arquivos).toContain("src/App.tsx");
    expect(arquivos).toContain("src/index.css");
    expect(arquivos).toContain("src/lib/modulos/arvore.ts");
  });

  it("é ordenado e sem duplicatas", () => {
    const unica = [...new Set(arquivos)].sort();
    expect(arquivos).toEqual(unica);
  });
});
