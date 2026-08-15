// Testa o CÓDIGO REAL de sonda-versao.ts no runtime real (Deno), sem import remoto (test:edges
// roda com --no-remote). Roda com: deno test supabase/functions/_shared/sonda-versao_test.ts
//
// Este classificador é money-path: um erro aqui não devolve resposta errada, ele EXECUTA o efeito
// caro da edge que o usa — PO no Omie (`disparar-pedidos-aprovados`, `conciliar-pedido-portal`) ou
// pedido submetido no portal do fornecedor (`enviar-pedido-portal-sayerlack`). Por isso o default
// cai no lado caro: `probe` presente mas não reconhecido é AMBÍGUO, nunca execução por omissão.

import { classificarSonda, erroSondaAmbigua, respostaSonda } from "./sonda-versao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

Deno.test("respostaSonda: eco `probe` + a versão que o chamador passou", () => {
  // O eco `probe:true` não é enfeite: um bundle ANTERIOR à sonda ignora o parâmetro e cai no
  // FLUXO REAL (docs/agent/deploy.md §Canárias, armadilha 1). Ausência do eco = bundle velho.
  assertEquals(respostaSonda("v1.0-x"), { ok: true, probe: true, versao: "v1.0-x" });
});

Deno.test("corpo de chamador legítimo (sem a chave `probe`) → fluxo real", () => {
  assertEquals(classificarSonda({ empresa: "OBEN", pedido_id: 281 }).tipo, "disparo");
  assertEquals(classificarSonda({}).tipo, "disparo");
});

Deno.test("corpo não-objeto → fluxo real (body malformado não vira sonda silenciosa)", () => {
  for (const body of [null, undefined, "probe", 42, [], ["probe"]]) {
    assertEquals(classificarSonda(body).tipo, "disparo", `body=${JSON.stringify(body)}`);
  }
});

Deno.test("probe verdadeiro (booleano, string, numérico) → sonda", () => {
  // `{"probe":"true"}` é o caso que MATA: no SQL Editor o valor vira string com facilidade, e um
  // `=== true` cru mandaria isso para o efeito irreversível.
  for (const v of [true, "true", "TRUE", " true ", 1, "1"]) {
    assertEquals(classificarSonda({ probe: v }).tipo, "sonda", `probe=${JSON.stringify(v)}`);
  }
});

Deno.test("probe falso explícito → fluxo real", () => {
  for (const v of [false, "false", "FALSE", 0, "0"]) {
    assertEquals(classificarSonda({ probe: v }).tipo, "disparo", `probe=${JSON.stringify(v)}`);
  }
});

Deno.test("probe vence os demais campos (sonda não executa nem com empresa/pedido_id)", () => {
  assertEquals(
    classificarSonda({ empresa: "OBEN", pedido_id: 281, ignorar_minimo: true, probe: true }).tipo,
    "sonda",
  );
});

Deno.test("probe presente mas não reconhecido → ambíguo, NUNCA fluxo real", () => {
  for (const v of [null, "talvez", "sim", 2, {}, [], "yes"]) {
    const d = classificarSonda({ probe: v });
    assertEquals(d.tipo, "ambiguo", `probe=${JSON.stringify(v)}`);
    if (d.tipo === "ambiguo") assertEquals(typeof d.valor, "string");
  }
});

Deno.test("erroSondaAmbigua: cita o valor recusado E o efeito caro daquela edge", () => {
  const msg = erroSondaAmbigua('"talvez"', "esta edge cria pedido de compra REAL no Omie");
  if (!msg.includes('"talvez"')) throw new Error(`mensagem não cita o valor: ${msg}`);
  if (!msg.includes("cria pedido de compra REAL no Omie")) {
    throw new Error(`mensagem não cita o efeito: ${msg}`);
  }
});

// ════════ CONTROLE DE CALIBRAÇÃO ════════
// "Canária que não discrimina é teatro verde" (docs/agent/deploy.md): é preciso PROVAR que sob a
// implementação INGÊNUA os asserts acima ficariam vermelhos. Sem este bloco, os testes provariam
// apenas que a função responde — não que a escolha dos inputs pega a saída errada.
//
// A forma ingênua é a que qualquer um escreveria primeiro:  body.probe === true

function classificarSondaIngenua(body: unknown): "sonda" | "disparo" {
  return (body as { probe?: unknown })?.probe === true ? "sonda" : "disparo";
}

Deno.test("CALIBRAÇÃO: a forma ingênua mandaria `probe:\"true\"` para o EFEITO IRREVERSÍVEL", () => {
  assertEquals(classificarSondaIngenua({ probe: "true" }), "disparo");
  assertEquals(classificarSonda({ probe: "true" }).tipo, "sonda");
});

Deno.test("CALIBRAÇÃO: a forma ingênua executaria com `probe` ambíguo em vez de recusar", () => {
  assertEquals(classificarSondaIngenua({ probe: "talvez" }), "disparo");
  assertEquals(classificarSonda({ probe: "talvez" }).tipo, "ambiguo");
});

Deno.test("CALIBRAÇÃO: nos casos SEGUROS as duas concordam (o teste não é vacuamente verde)", () => {
  // Controle positivo: se divergissem em TUDO, o assert de divergência não provaria nada —
  // provaria só que são funções diferentes.
  assertEquals(classificarSondaIngenua({ probe: true }), "sonda");
  assertEquals(classificarSonda({ probe: true }).tipo, "sonda");
  assertEquals(classificarSondaIngenua({ empresa: "OBEN" }), "disparo");
  assertEquals(classificarSonda({ empresa: "OBEN" }).tipo, "disparo");
});
