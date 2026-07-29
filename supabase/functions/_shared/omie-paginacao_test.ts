// Testa o CÓDIGO REAL de omie-paginacao.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/omie-paginacao_test.ts
//
// Guards de paginação do ListarPosEstoque (nTotPaginas) compartilhados por sync-reprocess e
// omie-analytics-sync (syncInventory/syncInventoryFull). Movidos de sync-reprocess/
// inventory-lote.ts (testes idem) quando o canônico ganhou o mesmo piso monotônico — os casos
// abaixo vieram verbatim (#1341/#1353).
import {
  avaliarPagina,
  desfechoVarreduraReversa,
  fingerprintPagina,
  MAX_PAGINAS_POS_ESTOQUE,
  proximoTotalPaginas,
  validarTotalPaginas,
  varreduraTruncada,
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

// ════════ varreduraTruncada — o que o total-como-teto deixa passar (challenge Codex) ════════
// Os guards acima só disparam quando uma página vem VAZIA antes do fim declarado. Se o Omie
// sub-reporta o total (declara 37 quando o real é 43), o laço termina em 37 páginas CHEIAS,
// sem anomalia nenhuma — e "acabou" fica indistinguível de "truncou". A contagem declarada de
// registros é o segundo sinal que os separa (money-path §8).

Deno.test("varreduraTruncada — lidos MENOS que o declarado é truncamento (total sub-reportado)", () => {
  assertEquals(varreduraTruncada(3700, 4283), true);
});

Deno.test("varreduraTruncada — lidos == declarado NÃO é truncamento (fim legítimo)", () => {
  assertEquals(varreduraTruncada(4283, 4283), false);
});

Deno.test("varreduraTruncada — lidos ACIMA do declarado não é truncamento (declarado é piso)", () => {
  // O total declarado sub-reportar é o defeito conhecido: ler MAIS que ele é o caso são.
  assertEquals(varreduraTruncada(4300, 4283), false);
});

Deno.test("varreduraTruncada — sem o segundo sinal (ausente/0/lixo) NÃO afirma truncamento", () => {
  // Precisão > recall: sem contagem declarada não há como provar truncamento, e afirmar
  // aqui fabricaria o alerta (suspenderia inativação legítima para sempre).
  assertEquals(varreduraTruncada(0, undefined), false);
  assertEquals(varreduraTruncada(0, 0), false);
  assertEquals(varreduraTruncada(10, Number.NaN), false);
});

Deno.test("varreduraTruncada — catálogo real vazio (0 lidos, 0 declarados) não é truncamento", () => {
  assertEquals(varreduraTruncada(0, 0), false);
});

// ════════ desfechoVarreduraReversa — varredura reversa não completa com teto crescido ════════
// ListarMovimentos (omie-financeiro) varre da ÚLTIMA página declarada (dado mais recente)
// até a 1. O nTotPaginas do firstPage decide o ponto de PARTIDA: sub-reporte ali deixa as
// páginas mais recentes fora da varredura — e o `complete: pagina < 1` antigo carimbava o
// buraco como completo e zerava o cursor (chip das edges financeiras, 2026-07-23).

// ⚠️ A 1ª versão deste helper usava `retomada` para decidir se o crescimento do piso
// significava sub-reporte ou dado novo. O challenge do Codex (xhigh) derrubou a heurística
// com dois cenários: (a) se TODAS as respostas declararem 80 num universo de 300, o piso
// nunca cresce e a run completa com 81–300 nunca visitadas — para sempre; (b) sub-reporte
// EM ETAPAS (10→50→300) completa na retomada e descarta a cauda. Nenhuma inferência sobre o
// número DECLARADO resolve: o único fato que prova topo é PERGUNTAR a página acima dele.
// Daí `topoVerificadoVazio` — a sonda vive no caller (é I/O), a decisão fica aqui e testável.

Deno.test("varredura reversa — desceu até 1 E a sonda confirmou o topo vazio → complete", () => {
  assertEquals(
    desfechoVarreduraReversa({ paginaFinal: 0, inicioVarredura: 80, tetoDeclarado: 80, topoVerificadoVazio: true, paginaSonda: 81 }),
    { complete: true, nextPage: null },
  );
});

Deno.test("varredura reversa — desceu até 1 mas a sonda ACHOU dado acima do topo (sub-reporte) → NÃO completa; cursor na sonda", () => {
  assertEquals(
    desfechoVarreduraReversa({ paginaFinal: 0, inicioVarredura: 80, tetoDeclarado: 80, topoVerificadoVazio: false, paginaSonda: 81 }),
    { complete: false, nextPage: 81 },
  );
});

Deno.test("varredura reversa — sub-reporte CONSTANTE (nada cresce durante a run) também não completa: quem decide é a sonda, não a declaração", () => {
  // O caso que a heurística antiga dava como completo: 300 páginas reais, todas as
  // respostas declarando 80. Sem a sonda, 81–300 ficariam fora para sempre.
  assertEquals(
    desfechoVarreduraReversa({ paginaFinal: 0, inicioVarredura: 80, tetoDeclarado: 80, topoVerificadoVazio: false, paginaSonda: 81 }),
    { complete: false, nextPage: 81 },
  );
});

Deno.test("varredura reversa — interrompida no meio (budget/maxPages/streak) → cursor na página atual, nunca complete, sonda irrelevante", () => {
  assertEquals(
    desfechoVarreduraReversa({ paginaFinal: 37, inicioVarredura: 80, tetoDeclarado: 80, topoVerificadoVazio: true, paginaSonda: 81 }),
    { complete: false, nextPage: 37 },
  );
});

Deno.test("varredura reversa — sonda que FALHOU (não sabemos o topo) nunca completa: ausência de sinal não é aprovação", () => {
  assertEquals(
    desfechoVarreduraReversa({ paginaFinal: 0, inicioVarredura: 10, tetoDeclarado: 50, topoVerificadoVazio: false, paginaSonda: 51 }),
    { complete: false, nextPage: 51 },
  );
});

// ════════ fingerprintPagina — detectar página REPETIDA sem colidir ════════
// O fingerprint antigo era `${primeiroCodigo}:${count}` e colidia (achado Codex): duas
// páginas CHEIAS cujo 1º título não tenha `codigo_lancamento_omie` produzem ambas ":100".
// Com repetição passando a LANÇAR, colisão viraria sync travado — o fingerprint precisa
// distinguir páginas diferentes de verdade.

Deno.test("fingerprintPagina — páginas com códigos diferentes têm fingerprints diferentes", () => {
  const a = fingerprintPagina([101, 102, 103]);
  const b = fingerprintPagina([201, 202, 203]);
  assertEquals(a === b, false);
});

Deno.test("fingerprintPagina — a MESMA página dá o mesmo fingerprint (determinístico)", () => {
  assertEquals(fingerprintPagina([101, 102, 103]), fingerprintPagina([101, 102, 103]));
});

Deno.test("fingerprintPagina — duas páginas cheias SEM código no 1º item não colidem (o furo do fingerprint antigo)", () => {
  const p1 = fingerprintPagina([null, 102, 103]);
  const p2 = fingerprintPagina([null, 902, 903]);
  assertEquals(p1 === p2, false);
});

Deno.test("fingerprintPagina — ordem importa (mesma lista reordenada é outra página)", () => {
  assertEquals(fingerprintPagina([1, 2, 3]) === fingerprintPagina([3, 2, 1]), false);
});

Deno.test("fingerprintPagina — páginas de tamanhos diferentes não colidem", () => {
  assertEquals(fingerprintPagina([1, 2]) === fingerprintPagina([1, 2, 3]), false);
});

// ════════ teto compartilhado ════════

Deno.test("MAX_PAGINAS_POS_ESTOQUE preservado (500 — folga >10× sobre o maior uso atual)", () => {
  assertEquals(MAX_PAGINAS_POS_ESTOQUE, 500);
});
