import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listarArquivosSrc } from "../arvore";
import { coletarArestasCross, validarContraBaseline } from "../fronteiras";
import { FRONTEIRAS_BASELINE } from "../fronteiras-baseline";
import { COMPOSICAO_RAIZ, MODULOS } from "../manifesto";

describe("GATE: fronteiras entre módulos (ratchet sobre a árvore real)", () => {
  const coleta = coletarArestasCross(listarArquivosSrc(), MODULOS, COMPOSICAO_RAIZ, (p) =>
    readFileSync(p, "utf8"),
  );

  it("nenhum vazamento NOVO e nenhuma aresta da baseline sem burn-down", () => {
    const problemas = validarContraBaseline(coleta.arestas, FRONTEIRAS_BASELINE);
    const resumo = problemas
      .slice(0, 25)
      .map((p) => `[${p.tipo}] ${p.detalhe}`)
      .join("\n");
    expect(
      problemas,
      [
        `\n${problemas.length} problema(s) de fronteira:`,
        resumo,
        "",
        "vazamento-novo   → mova o código pro módulo dono, extraia pra plataforma, ou (consciente)",
        "                   rode `bun scripts/fronteiras-modulos.ts gerar-baseline` — a aresta nova fica visível no diff do PR.",
        "baseline-resolvida → parabéns, você queimou dívida: rode `gerar-baseline` pra remover a entrada.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("imports internos não-resolvidos não explodiram (fotografia exposta, não silêncio)", () => {
    // 8 conhecidos na medição de 2026-07-08; margem p/ flutuação pequena sem deixar
    // uma regressão de resolução (ex.: convenção nova de alias) passar despercebida.
    expect(coleta.naoResolvidos).toBeLessThanOrEqual(16);
  });

  it("imports dinâmicos não-analisáveis continuam raros (hoje: 0 conhecidos)", () => {
    expect(coleta.naoAnalisaveis).toBeLessThanOrEqual(8);
  });
});
