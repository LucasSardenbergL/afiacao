// Testa o CÓDIGO REAL de sonda-versao.ts no runtime real (Deno), sem import remoto (test:edges
// roda com --no-remote). Roda com: deno test supabase/functions/_shared/sonda-versao_test.ts
//
// Este classificador é money-path: um erro aqui não devolve resposta errada, ele EXECUTA o efeito
// caro da edge que o usa — PO no Omie (`disparar-pedidos-aprovados`, `conciliar-pedido-portal`) ou
// pedido submetido no portal do fornecedor (`enviar-pedido-portal-sayerlack`). Por isso o default
// cai no lado caro: `probe` presente mas não reconhecido é AMBÍGUO, nunca execução por omissão.

import { classificarFlag, classificarSonda, criarRespostaSonda, erroFlagAmbigua, erroSondaAmbigua } from "./sonda-versao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

Deno.test("respostaSonda: eco `probe` + a versão que o chamador passou + a EDGE que respondeu", () => {
  // O eco `probe:true` não é enfeite: um bundle ANTERIOR à sonda ignora o parâmetro e cai no
  // FLUXO REAL (docs/agent/deploy.md §Canárias, armadilha 1). Ausência do eco = bundle velho.
  //
  // O `edge` também não: `versao` nasce IGUAL em toda uma leva, então sem ele duas respostas de
  // edges diferentes são byte a byte idênticas e o veredito por edge se perde — aconteceu em
  // 2026-08-18 com 10 sondas respondidas (docs/historico/verificar-sonda-versao.md §7).
  //
  // O `fonte` entrou no #1996: fingerprint da FONTE da edge (fecho transitivo dos imports locais,
  // `_shared/` incluso). Ele responde a pergunta que o `versao` não alcança — mudança que chega
  // inteira por `_shared/` não muda o marcador humano, e o gate `sonda:bump` deixa `_shared/` de
  // fora por medição. Aqui a edge é fictícia, então cai no literal auto-denunciante do `??`.
  const respostaSonda = criarRespostaSonda("edge-x");
  assertEquals(respostaSonda("v1.0-x"), {
    ok: true,
    probe: true,
    versao: "v1.0-x",
    edge: "edge-x",
    fonte: "nao-mapeada",
  });
});

Deno.test("respostaSonda: edge REAL serve o fingerprint do mapa, não o literal do fallback", () => {
  // O teste acima usa edge fictícia e por isso exercita o ramo `??`. Sem este par, o `fonte` de
  // TODA edge real poderia ser "nao-mapeada" e a suíte seguiria verde — o gate mediria o fallback
  // e passaria por garantia que não dá.
  const resposta = criarRespostaSonda("omie-analytics-sync")("v1.1-mapa-codigo-sem-alias");
  if (!/^[0-9a-f]{64}$/.test(resposta.fonte)) {
    throw new Error(
      `omie-analytics-sync: fonte deveria ser SHA-256 do mapa, veio ${JSON.stringify(resposta.fonte)}. ` +
        `Rode \`bun run sonda:fingerprint -- --write\`.`,
    );
  }
});

Deno.test("criarRespostaSonda: fábricas de edges distintas NÃO colidem", () => {
  // A propriedade que o desenho antigo não tinha, no menor caso possível: mesmo marcador, corpos
  // distinguíveis.
  const a = criarRespostaSonda("edge-a")("v1.0-igual");
  const b = criarRespostaSonda("edge-b")("v1.0-igual");
  if (JSON.stringify(a) === JSON.stringify(b)) {
    throw new Error("duas edges com o mesmo marcador produziram respostas idênticas");
  }
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

// ════════ `classificarFlag` — o MESMO classificador sobre um campo de nome diferente ════════
// A `analyze-unified-order` decide a canária pelo campo `canary`, não `probe`, e decidia por
// `canary === true` CRU. O founder invoca a canária pelo SQL Editor, onde
// `jsonb_build_object('canary', true)` vira a STRING "true" com facilidade — e ali o lado caro não
// é um PO no ERP, é uma análise de pedido com LLM (token gasto) cuja resposta fica INDISTINGUÍVEL
// de "bundle velho ignorou o parâmetro". Mesmas duas regras, outro campo: por isso a lógica é
// extraída em vez de reescrita — um classificador money-path com duas cópias vira duas verdades.

Deno.test("classificarFlag: o campo é parâmetro — `canary` classifica igual a `probe`", () => {
  assertEquals(classificarFlag({ canary: true }, "canary").tipo, "sonda");
  assertEquals(classificarFlag({ canary: "true" }, "canary").tipo, "sonda");
  assertEquals(classificarFlag({ canary: "1" }, "canary").tipo, "sonda");
  assertEquals(classificarFlag({ canary: 1 }, "canary").tipo, "sonda");
  assertEquals(classificarFlag({ canary: "  TRUE  " }, "canary").tipo, "sonda");
  assertEquals(classificarFlag({ canary: false }, "canary").tipo, "disparo");
  assertEquals(classificarFlag({ canary: "0" }, "canary").tipo, "disparo");
});

Deno.test("classificarFlag: campo AUSENTE é o fluxo real (a análise de pedido de verdade)", () => {
  // O chamador legítimo do analyze-unified-order não manda `canary` nenhum. Se ausência virasse
  // canária, a edge pararia de analisar pedido — quebra visível, mas quebra.
  assertEquals(classificarFlag({ text: "2x tinta branca" }, "canary").tipo, "disparo");
  assertEquals(classificarFlag({}, "canary").tipo, "disparo");
});

Deno.test("classificarFlag: `canary` presente e não reconhecido → AMBÍGUO (não gasta LLM)", () => {
  const d = classificarFlag({ canary: "sim" }, "canary");
  assertEquals(d.tipo, "ambiguo");
  assertEquals(d.tipo === "ambiguo" ? d.valor : null, '"sim"');
});

Deno.test("classificarFlag: o campo NÃO vaza — `probe` não liga a canária nem vice-versa", () => {
  // Um classificador que ignorasse o parâmetro e olhasse sempre `probe` passaria nos testes acima
  // por acidente (os corpos só têm um campo cada). Este caso separa os dois.
  assertEquals(classificarFlag({ probe: true }, "canary").tipo, "disparo");
  assertEquals(classificarFlag({ canary: true }, "probe").tipo, "disparo");
});

Deno.test("classificarSonda é `classificarFlag(body,'probe')` — uma lógica, não duas", () => {
  for (const corpo of [{ probe: true }, { probe: "true" }, { probe: "talvez" }, { probe: false }, {}]) {
    assertEquals(classificarSonda(corpo), classificarFlag(corpo, "probe"), `divergiu em ${JSON.stringify(corpo)}`);
  }
});

Deno.test("CALIBRAÇÃO: a forma `canary === true` CRUA manda a string do SQL Editor para o LLM", () => {
  // É a forma que estava deployada na analyze-unified-order. Sob ela, o founder que colasse
  // `jsonb_build_object('canary', true)` e recebesse a string "true" pagaria uma análise de pedido
  // com LLM e leria a resposta como "bundle velho" — o diagnóstico errado, pelo custo errado.
  const canariaCrua = (body: unknown) => ((body as { canary?: unknown })?.canary === true ? "canaria" : "fluxo_real");
  assertEquals(canariaCrua({ canary: "true" }), "fluxo_real");
  assertEquals(classificarFlag({ canary: "true" }, "canary").tipo, "sonda");
  // e o valor não reconhecido: a crua EXECUTA, a robusta RECUSA
  assertEquals(canariaCrua({ canary: "sim" }), "fluxo_real");
  assertEquals(classificarFlag({ canary: "sim" }, "canary").tipo, "ambiguo");
  // Controle positivo: nos casos seguros as duas concordam (senão o assert de divergência só
  // provaria que são funções diferentes).
  assertEquals(canariaCrua({ canary: true }), "canaria");
  assertEquals(classificarFlag({ canary: true }, "canary").tipo, "sonda");
  assertEquals(canariaCrua({ text: "2x tinta" }), "fluxo_real");
  assertEquals(classificarFlag({ text: "2x tinta" }, "canary").tipo, "disparo");
});

Deno.test("erroFlagAmbigua: a recusa NOMEIA o campo — dizer 'probe' na canária manda corrigir o campo errado", () => {
  const msg = erroFlagAmbigua("canary", '"sim"', "esta edge analisa o pedido com LLM (token gasto)");
  if (!msg.includes("'canary'")) throw new Error(`recusa não cita o campo 'canary': ${msg}`);
  if (msg.includes("'probe'")) throw new Error(`recusa cita 'probe' numa canária de campo 'canary': ${msg}`);
  if (!msg.includes('"sim"')) throw new Error(`recusa não cita o valor: ${msg}`);
  if (!msg.includes("analisa o pedido com LLM")) throw new Error(`recusa não cita o efeito: ${msg}`);
});

Deno.test("erroSondaAmbigua é `erroFlagAmbigua('probe', …)` — o texto das 18 sondas não muda", () => {
  assertEquals(
    erroSondaAmbigua('"talvez"', "cria PO no Omie"),
    erroFlagAmbigua("probe", '"talvez"', "cria PO no Omie"),
  );
});
