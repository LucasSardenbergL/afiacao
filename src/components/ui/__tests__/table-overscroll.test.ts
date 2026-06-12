import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guarda de regressão do scroll vertical sobre tabelas/scroll-containers.
 *
 * Bug (commit e913836a, 2026-05-16): pra bloquear o swipe-back HORIZONTAL do
 * navegador, foi aplicado `overscroll-behavior: contain` (o shorthand, 2 eixos)
 * numa regra GLOBAL do index.css + na classe Tailwind `overscroll-contain` do
 * wrapper do <Table>. O eixo Y do shorthand PRENDE o scroll vertical da página
 * quando o cursor está sobre uma tabela sem rolagem interna própria (a tabela
 * cresce até a altura toda → está sempre "no limite" em Y → a roda é consumida
 * e não propaga pra página). Sintoma: o usuário não conseguia rolar a página
 * passando o mouse sobre QUALQUER tabela do app.
 *
 * Fix: conter só o eixo X (`overscroll-behavior-x: contain`). O swipe-back é
 * horizontal, então X-only protege os dois objetivos sem prender o Y.
 *
 * Estes asserts falham se alguém reintroduzir o shorthand de 2 eixos.
 */
const root = resolve(__dirname, "../../../..");
// strip comentários CSS (/* ... */) — queremos assertar nas DECLARAÇÕES reais,
// não no texto do comentário que (de propósito) cita o shorthand proibido.
const indexCss = readFileSync(resolve(root, "src/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tableTsx = readFileSync(resolve(root, "src/components/ui/table.tsx"), "utf8");

describe("overscroll containment — só no eixo X (não prende scroll vertical da página)", () => {
  it("a regra global do index.css usa overscroll-behavior-x (longhand), não o shorthand de 2 eixos", () => {
    // escopa ao BLOCO da regra global (do 1º seletor até o primeiro `}`).
    // Sem escopo, o assert (a) passaria só porque `-x` aparece em outro
    // seletor qualquer e (b) proibiria um containment Y legítimo/localizado
    // em outro lugar (ex.: um modal específico). Aqui falha SE alguém reverter
    // ESTA regra pro shorthand de 2 eixos.
    const bloco = indexCss.match(/\[class\*="overflow-auto"\][\s\S]*?\}/)?.[0] ?? "";
    expect(bloco).not.toBe("");
    expect(bloco).toContain("overscroll-behavior-x: contain");
    // o shorthand (2 eixos) NESTE bloco reintroduziria o trap vertical
    expect(bloco).not.toMatch(/overscroll-behavior:\s*contain/);
  });

  it("o wrapper do <Table> não reaplica overscroll nos 2 eixos via classe Tailwind", () => {
    // `overscroll-contain` (Tailwind) = overscroll-behavior: contain (X e Y)
    expect(tableTsx).not.toContain("overscroll-contain");
    // segue como scroll-container (pra tabelas largas rolarem na horizontal)
    expect(tableTsx).toContain("overflow-auto");
  });
});
