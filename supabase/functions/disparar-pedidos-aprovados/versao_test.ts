// Testa o CÓDIGO REAL de versao.ts no runtime real (Deno), sem import remoto (test:edges roda com
// --no-remote). Roda com: deno test supabase/functions/disparar-pedidos-aprovados/versao_test.ts
//
// O que este núcleo sustenta: esta edge NÃO TEM caminho sem efeito colateral. `dry_run` chama
// `IncluirPedCompra` incondicionalmente (index.ts §e) — só troca cObs/cObsInt/status —, e mesmo com
// ZERO aprovados o fluxo expira oportunidades e grava sync_reprocess_log. Logo "qual versão está no
// ar?" não tinha resposta barata: a única prova era esperar um pedido ser disparado DE VERDADE.
// A sonda `probe` é o único caminho que responde ANTES de qualquer IO — e por isso o classificador
// dela é money-path: um erro aqui não devolve resposta errada, ele CRIA PEDIDO DE COMPRA NO OMIE.
//
// Assimetria que dita o desenho (sync.md §"o default de um classificador cai no lado CARO"):
//   sonda lida como disparo  → PO real e irreversível no ERP   ← caro
//   disparo lido como sonda  → o tick não dispara (visível, retentável)
// Por isso `probe` presente mas NÃO reconhecido é AMBÍGUO (400), nunca disparo por omissão.

import { classificarSonda, respostaSonda, VERSAO } from "./versao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A versão em si
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("VERSAO: string não-vazia no formato vN.N-slug", () => {
  assertEquals(typeof VERSAO, "string");
  if (!/^v\d+\.\d+-[a-z0-9-]+$/.test(VERSAO)) {
    throw new Error(`VERSAO fora do formato vN.N-slug: ${JSON.stringify(VERSAO)}`);
  }
});

Deno.test("respostaSonda: carrega a versão + o eco `probe` que prova qual RAMO respondeu", () => {
  // O eco `probe:true` não é enfeite: um bundle ANTERIOR à sonda ignora o parâmetro e cai no
  // FLUXO REAL (docs/agent/deploy.md §Canárias, armadilha 1). Sem o eco, a resposta do fluxo real
  // seria confundida com "sonda respondeu". Ausência de `probe:true` = bundle velho.
  assertEquals(respostaSonda(), { ok: true, probe: true, versao: VERSAO });
});

// ─────────────────────────────────────────────────────────────────────────────
// Classificador — o corpo do cron NUNCA pode virar sonda
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("corpo do cron (sem a chave `probe`) → disparo", () => {
  assertEquals(classificarSonda({ empresa: "OBEN", data_ciclo: "2026-08-14" }).tipo, "disparo");
  assertEquals(classificarSonda({}).tipo, "disparo");
});

Deno.test("corpo não-objeto → disparo (body malformado não vira sonda silenciosa)", () => {
  for (const body of [null, undefined, "probe", 42, [], ["probe"]]) {
    assertEquals(classificarSonda(body).tipo, "disparo", `body=${JSON.stringify(body)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sonda — grafias que um humano digita no SQL Editor não podem cair no disparo real
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("probe verdadeiro (booleano, string, numérico) → sonda", () => {
  // `{"probe":"true"}` é o caso que MATA: no SQL Editor o valor sai de jsonb_build_object e vira
  // string com facilidade. Um `=== true` cru mandaria isso para o disparo REAL.
  for (const v of [true, "true", "TRUE", " true ", 1, "1"]) {
    assertEquals(classificarSonda({ probe: v }).tipo, "sonda", `probe=${JSON.stringify(v)}`);
  }
});

Deno.test("probe falso explícito → disparo", () => {
  for (const v of [false, "false", "FALSE", 0, "0"]) {
    assertEquals(classificarSonda({ probe: v }).tipo, "disparo", `probe=${JSON.stringify(v)}`);
  }
});

Deno.test("probe vence os demais campos (sonda não dispara nem com empresa/pedido_id)", () => {
  const d = classificarSonda({ empresa: "OBEN", pedido_id: 281, ignorar_minimo: true, probe: true });
  assertEquals(d.tipo, "sonda");
});

// ─────────────────────────────────────────────────────────────────────────────
// O default cai no lado CARO
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("probe presente mas não reconhecido → ambíguo, NUNCA disparo", () => {
  for (const v of [null, "talvez", "sim", 2, {}, [], "yes"]) {
    const d = classificarSonda({ probe: v });
    assertEquals(d.tipo, "ambiguo", `probe=${JSON.stringify(v)}`);
    if (d.tipo === "ambiguo") assertEquals(typeof d.valor, "string");
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

Deno.test("CALIBRAÇÃO: a forma ingênua mandaria `probe:\"true\"` para o DISPARO REAL", () => {
  // Se algum dia isto passar a concordar com classificarSonda, o teste de cima virou teatro.
  assertEquals(classificarSondaIngenua({ probe: "true" }), "disparo");
  assertEquals(classificarSonda({ probe: "true" }).tipo, "sonda");
});

Deno.test("CALIBRAÇÃO: a forma ingênua dispararia com `probe` ambíguo em vez de recusar", () => {
  assertEquals(classificarSondaIngenua({ probe: "talvez" }), "disparo");
  assertEquals(classificarSonda({ probe: "talvez" }).tipo, "ambiguo");
});

Deno.test("CALIBRAÇÃO: nos casos SEGUROS as duas concordam (o teste não é vacuamente verde)", () => {
  // Controle positivo: se as duas divergissem em TUDO, o assert de divergência não significaria
  // nada — provaria só que são funções diferentes.
  assertEquals(classificarSondaIngenua({ probe: true }), "sonda");
  assertEquals(classificarSonda({ probe: true }).tipo, "sonda");
  assertEquals(classificarSondaIngenua({ empresa: "OBEN" }), "disparo");
  assertEquals(classificarSonda({ empresa: "OBEN" }).tipo, "disparo");
});
