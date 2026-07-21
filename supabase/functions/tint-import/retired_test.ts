// retired_test.ts — fixa o contrato de APOSENTADORIA do tint-import (Fase 1b/1d, money-path).
//
// O endpoint responde 410 TINT_IMPORT_RETIRED desde 2026-07-17: o writer antigo era fail-open
// (gravava receita PARCIAL em silêncio) e foi removido com 0 chamadores medidos em prod. Este
// teste TRAVA o estado aposentado — quem remover o 410 ou ressuscitar um writer aqui quebra o
// CI e é obrigado a passar pela revisão money-path (fail-closed por-linha ANTES de reabrir;
// ver docs/agent/tintometrico.md §Import de fórmulas).
//
// Teste TEXTUAL (readTextFileSync, padrão edge-parse-parity): o index.ts tem serve() no
// top-level — importá-lo subiria o servidor. O contrato aqui é sobre o ARQUIVO deployado.
const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

Deno.test("tint-import segue aposentado: 410 + TINT_IMPORT_RETIRED presentes", () => {
  if (!src.includes("TINT_IMPORT_RETIRED")) {
    throw new Error("code TINT_IMPORT_RETIRED sumiu do tint-import — o 410 foi removido?");
  }
  if (!src.includes("status: 410")) {
    throw new Error("status 410 sumiu do tint-import — o endpoint deixou de ser Gone");
  }
});

Deno.test("tint-import sem writer ressuscitado (nenhuma escrita em tabela tint_*)", () => {
  // O corpo do writer foi REMOVIDO (#1437-fu). Qualquer .from("tint_...") de volta neste
  // arquivo é um writer renascendo por baixo do 410 — a revisão money-path é obrigatória.
  // (Padrões de CÓDIGO, não prosa: o cabeçalho do 410 cita `processFormulas` como história.)
  if (/\.from\(\s*["']tint_/.test(src)) {
    throw new Error("tint-import voltou a tocar tabela tint_* — writer ressuscitado sob o 410");
  }
  for (const marca of ["processFormulas", "handleFileMode", "handleChunkMode"]) {
    const definicaoOuChamada = new RegExp(
      `(function\\s+${marca}\\b|const\\s+${marca}\\s*=|${marca}\\s*\\()`,
    );
    if (definicaoOuChamada.test(src)) {
      throw new Error(`tint-import contém ${marca} como código — o writer aposentado foi ressuscitado`);
    }
  }
});

Deno.test("tint-import preserva o espelho parseDecimalBR (edge-parse-parity depende dele)", () => {
  // O bloco MIRROR fica no arquivo MESMO sem uso local — src/lib/tint/__tests__/
  // edge-parse-parity.test.ts (vitest) lê este arquivo e compara textualmente.
  if (!src.includes("MIRROR-START tint parse-decimal-br") || !src.includes("MIRROR-END")) {
    throw new Error("bloco MIRROR parseDecimalBR sumiu — edge-parse-parity.test.ts vai quebrar");
  }
});
