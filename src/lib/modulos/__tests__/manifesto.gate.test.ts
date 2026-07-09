import { describe, expect, it } from "vitest";
import { listarArquivosSrc } from "../arvore";
import { MODULOS, NAO_CLASSIFICADOS } from "../manifesto";
import { validarManifesto } from "../resolver";

describe("GATE: manifesto de módulos espelha a árvore real de src/", () => {
  it("ids de módulo são únicos", () => {
    const ids = MODULOS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("todo arquivo tem exatamente 1 dono ou está em NAO_CLASSIFICADOS (sem órfão silencioso, sem glob morto)", () => {
    const problemas = validarManifesto(listarArquivosSrc(), MODULOS, NAO_CLASSIFICADOS);
    const resumo = problemas
      .slice(0, 40)
      .map((p) => `[${p.tipo}] ${p.detalhe}`)
      .join("\n");
    expect(problemas, `\n${problemas.length} problema(s) no manifesto:\n${resumo}`).toEqual([]);
  });
});
