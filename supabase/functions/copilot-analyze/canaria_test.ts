// Testa o CÓDIGO REAL da canária no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/copilot-analyze/
//
// O que estas asserções existem para matar (cada uma casa a marca de UM ramo, nunca "lançou algo"):
//   · canária que responde verde com o helper adulterado — o alvo da falsificação da entrega;
//   · canária cujas fixtures NÃO se falsificam mutuamente (um helper sempre-`null` passando);
//   · `contrato` ausente ou renomeado sem que ninguém perceba;
//   · resposta não-determinística, que tornaria "antes × depois do deploy" incomparável.
import { CONTRATO_CANARIA, executarCanaria } from "./canaria.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

Deno.test("canária: os TRÊS campos que docs/agent/deploy.md exige", () => {
  const r = executarCanaria({ contrato: CONTRATO_CANARIA });
  assertEquals(r.canary, true, "campo `canary` — sem ele a resposta se confunde com o fluxo real");
  assertEquals(r.contrato, "tudo-ou-nada-normalizar-v1", "campo `contrato` (VERSION MARKER)");
  assertEquals(r.ok, true, "campo `ok` — helper divergiu do contrato no bundle local");
});

Deno.test("canária: o contrato exportado é o mesmo que a resposta serve", () => {
  assertEquals(executarCanaria({ contrato: CONTRATO_CANARIA }).contrato, CONTRATO_CANARIA);
});

Deno.test("canária: TODO caso passa, e a falha nomeia QUAL", () => {
  const r = executarCanaria({ contrato: CONTRATO_CANARIA });
  const falhos = Object.entries(r.casos).filter(([, c]) => !c.ok).map(([n]) => n);
  assertEquals(falhos, [], "casos divergentes");
});

Deno.test("canária: cada caso individualmente — completa", () => {
  const c = executarCanaria({ contrato: CONTRATO_CANARIA }).casos.completa;
  assert(c !== undefined, "caso `completa` sumiu da canária");
  assertEquals(c.ok, true, "caso `completa` divergiu");
  assertEquals(
    (c.obtido as { confidence: number } | null)?.confidence,
    78,
    "caso `completa`: confiança",
  );
});

Deno.test("canária: cada caso individualmente — os que TÊM de recusar", () => {
  const { casos } = executarCanaria({ contrato: CONTRATO_CANARIA });
  for (const nome of ["sem_tipo_de_sugestao", "confianca_fora_de_faixa", "enum_invalido"]) {
    assert(casos[nome] !== undefined, `caso \`${nome}\` sumiu da canária`);
    assertEquals(casos[nome].esperado, null, `caso \`${nome}\`: o contrato é recusar`);
    assertEquals(casos[nome].obtido, null, `caso \`${nome}\`: o helper NÃO recusou`);
  }
});

Deno.test("canária: cada caso individualmente — os que TÊM de aceitar degradando", () => {
  const { casos } = executarCanaria({ contrato: CONTRATO_CANARIA });
  assertEquals(
    (casos.confianca_em_texto.obtido as { confidence: number } | null)?.confidence,
    78,
    "caso `confianca_em_texto`: string numérica tem de virar 78",
  );
  assertEquals(
    (casos.motivos_com_lixo.obtido as { direction_reasons: string[] } | null)?.direction_reasons,
    ["preço citado", "prazo"],
    "caso `motivos_com_lixo`: só as strings úteis sobrevivem",
  );
});

// ⚠️ TESTE META — sem ele a canária pode ficar VERDE por cegueira. Se todo caso esperasse `null`,
// um helper sempre-`null` (a sabotagem mais barata que existe) passaria em 100% deles. Exigir as
// DUAS direções é o que torna as fixtures mutuamente falsificáveis.
Deno.test("canária: as fixtures se falsificam mutuamente (as duas direções presentes)", () => {
  const casos = Object.values(executarCanaria({ contrato: CONTRATO_CANARIA }).casos);
  const recusas = casos.filter((c) => c.esperado === null).length;
  const aceites = casos.filter((c) => c.esperado !== null).length;
  assert(recusas >= 1, `nenhum caso espera recusa — helper sempre-null passaria (${recusas})`);
  assert(aceites >= 1, `nenhum caso espera aceite — helper sempre-null passaria (${aceites})`);
});

Deno.test("canária: resposta determinística (antes × depois do deploy é comparável)", () => {
  assertEquals(
    JSON.stringify(executarCanaria({ contrato: CONTRATO_CANARIA })),
    JSON.stringify(executarCanaria({ contrato: CONTRATO_CANARIA })),
    "duas chamadas divergiram — há relógio, acaso ou ambiente no caminho",
  );
});
