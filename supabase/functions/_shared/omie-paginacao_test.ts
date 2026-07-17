// Testa o CÓDIGO REAL de omie-paginacao.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/omie-paginacao_test.ts
//
// Guards de paginação do ListarPosEstoque (nTotPaginas) compartilhados por sync-reprocess e
// omie-analytics-sync (syncInventory/syncInventoryFull). Movidos de sync-reprocess/
// inventory-lote.ts (testes idem) quando o canônico ganhou o mesmo piso monotônico — os casos
// abaixo vieram verbatim (#1341/#1353).
import {
  avaliarPagina,
  MAX_PAGINAS_POS_ESTOQUE,
  proximoTotalPaginas,
  validarTotalPaginas,
} from "./omie-paginacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ════════ validarTotalPaginas — teto fail-FAST (Codex P1: falhar na página 501 é tarde) ════════
// nTotPaginas=100000 na página 1 faria 500 chamadas Omie (~90s+) antes do guard antigo
// disparar — reproduzindo o próprio 546. O teto tem de rejeitar a DECLARAÇÃO, não a página.

Deno.test("validarTotalPaginas — declarado dentro do teto passa", () => {
  assertEquals(validarTotalPaginas(9, 500), 9);
  assertEquals(validarTotalPaginas(500, 500), 500);
});

Deno.test("validarTotalPaginas — ausente/0/negativo/fracional/NaN degrada para 1 (fiel ao `|| 1`)", () => {
  assertEquals(validarTotalPaginas(undefined, 500), 1);
  assertEquals(validarTotalPaginas(0, 500), 1);
  assertEquals(validarTotalPaginas(-5, 500), 1);
  assertEquals(validarTotalPaginas(3.7, 500), 1);
  assertEquals(validarTotalPaginas(Number.NaN, 500), 1);
});

Deno.test("validarTotalPaginas — acima do teto LANÇA imediatamente (fail-fast anti-runaway)", () => {
  let lancou = false;
  try {
    validarTotalPaginas(100000, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

Deno.test("validarTotalPaginas — string numérica do Omie coage antes de validar", () => {
  assertEquals(validarTotalPaginas("9" as unknown as number, 500), 9);
  let lancou = false;
  try {
    validarTotalPaginas("100000" as unknown as number, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

// ════════ proximoTotalPaginas — piso MONOTÔNICO entre respostas (Codex P1 do #1353) ════════
// O total declarado é PISO da run inteira, não só de cada resposta: uma página intermediária
// SEM total_de_paginas (degrada p/ 1) encolhia o teto e o loop completava retrato PARCIAL
// como 'complete' (ex.: p1 declara 5, p2 vem sem total → run terminava em 2/5 páginas).
// O maior total já declarado vence — declaração nova só pode MANTER ou CRESCER o teto.

Deno.test("proximoTotalPaginas — declaração maior cresce o teto", () => {
  assertEquals(proximoTotalPaginas(1, 5, 500), 5);
  assertEquals(proximoTotalPaginas(5, 9, 500), 9);
});

Deno.test("proximoTotalPaginas — declaração ausente/lixo NÃO encolhe o teto já declarado", () => {
  assertEquals(proximoTotalPaginas(5, undefined, 500), 5); // degradaria p/ 1 sem o piso
  assertEquals(proximoTotalPaginas(5, 0, 500), 5);
  assertEquals(proximoTotalPaginas(5, 3, 500), 5); // declaração MENOR também não encolhe
});

Deno.test("proximoTotalPaginas — acima do teto anti-runaway LANÇA (herda o fail-fast)", () => {
  let lancou = false;
  try {
    proximoTotalPaginas(5, 100000, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

// ════════ avaliarPagina — guard de paginação (nTotPaginas é PISO, não verdade) ════════

Deno.test("página com itens → processar", () => {
  assertEquals(avaliarPagina(10, 1, 5), "processar");
});

Deno.test("página vazia ANTES do fim declarado → anomalia (fail-closed, não completa parcial)", () => {
  // Lição omie-sync-status-produtos: fault transiente/rate-limit vira 'página vazia' se o
  // caller não tratar — completar aqui deixaria a cauda stale com status 'complete' mentindo.
  assertEquals(avaliarPagina(0, 3, 5), "anomalia");
});

Deno.test("página vazia NA última declarada → fim (inofensivo, nada a processar)", () => {
  assertEquals(avaliarPagina(0, 5, 5), "fim");
});

Deno.test("catálogo vazio (1/1 vazia) → fim", () => {
  assertEquals(avaliarPagina(0, 1, 1), "fim");
});

Deno.test("página vazia ALÉM do declarado → fim (semântica segura p/ loop futuro)", () => {
  assertEquals(avaliarPagina(0, 6, 5), "fim");
});

// ════════ teto compartilhado ════════

Deno.test("MAX_PAGINAS_POS_ESTOQUE preservado (500 — folga >10× sobre o maior uso atual)", () => {
  assertEquals(MAX_PAGINAS_POS_ESTOQUE, 500);
});
