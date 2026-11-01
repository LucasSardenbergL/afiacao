import {
  deveInterromperPagina,
  INICIAR_PAGINA_ATE_MS,
  INTERROMPER_APOS_MS,
  podeIniciarPagina,
} from "./orcamento.ts";

function assertEquals(atual: unknown, esperado: unknown, msg: string) {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${String(esperado)}, veio ${String(atual)}`);
}

Deno.test("podeIniciarPagina: a 1ª página da invocação começa sempre, mesmo com setup lento", () => {
  assertEquals(podeIniciarPagina({ decorridoMs: 0, paginasConcluidas: 0, clientesImportados: 0 }), true, "t=0");
  assertEquals(podeIniciarPagina({ decorridoMs: 140_000, paginasConcluidas: 0, clientesImportados: 0 }), true, "setup lento");
});

Deno.test("podeIniciarPagina: depois da 1ª, só abre página nova antes do limite", () => {
  const base = { paginasConcluidas: 1, clientesImportados: 0 };
  assertEquals(podeIniciarPagina({ ...base, decorridoMs: INICIAR_PAGINA_ATE_MS - 1 }), true, "antes do limite");
  assertEquals(podeIniciarPagina({ ...base, decorridoMs: INICIAR_PAGINA_ATE_MS }), false, "no limite");
  assertEquals(podeIniciarPagina({ ...base, decorridoMs: 120_000 }), false, "bem depois");
});

Deno.test("deveInterromperPagina: só corta depois do limite", () => {
  const base = { paginasConcluidas: 1, clientesImportados: 10 };
  assertEquals(deveInterromperPagina({ ...base, decorridoMs: INTERROMPER_APOS_MS - 1 }), false, "antes");
  assertEquals(deveInterromperPagina({ ...base, decorridoMs: INTERROMPER_APOS_MS }), true, "no limite");
});

Deno.test("deveInterromperPagina: nunca corta sem progresso nesta invocação (cursor não pode parar)", () => {
  const tarde = INTERROMPER_APOS_MS + 30_000;
  assertEquals(deveInterromperPagina({ decorridoMs: tarde, paginasConcluidas: 0, clientesImportados: 0 }), false, "sem progresso");
  assertEquals(deveInterromperPagina({ decorridoMs: tarde, paginasConcluidas: 0, clientesImportados: 1 }), true, "1 inserido");
  assertEquals(deveInterromperPagina({ decorridoMs: tarde, paginasConcluidas: 1, clientesImportados: 0 }), true, "1 página");
});

Deno.test("os limites cabem no corte de 150 s do gateway, com a página inteira entre eles", () => {
  assertEquals(INICIAR_PAGINA_ATE_MS < INTERROMPER_APOS_MS, true, "iniciar < interromper");
  assertEquals(INTERROMPER_APOS_MS <= 120_000, true, "folga de 30 s para o cliente em voo e a resposta");
});
