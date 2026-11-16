// Sem rede (`--no-remote` do test:edges): assert inline.
import {
  codigoUnicoDoDocumento,
  conferirCodigoNaOmie,
  statusDaConferencia,
  traduzirErroAdmissao,
} from "./conferencia-vinculo.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}

const ok = (c: Record<string, unknown>) => () => Promise.resolve(c);

Deno.test("conferir: código e documento de volta → conferido com o documento DA OMIE", async () => {
  const r = await conferirCodigoNaOmie(ok({ codigo_cliente_omie: 500, cnpj_cpf: " 11.222.333/0001-81 " }), 500);
  assertEquals(r.tipo, "conferido");
  if (r.tipo === "conferido") assertEquals(r.documento, "11.222.333/0001-81");
});

Deno.test("conferir: falha de rede → falha (503), nunca conferido", async () => {
  const r = await conferirCodigoNaOmie(() => Promise.reject(new Error("timeout")), 500);
  assertEquals(r.tipo, "falha");
  if (r.tipo !== "conferido") assertEquals(statusDaConferencia(r), 503);
});

Deno.test("conferir: fault 'não cadastrado' → nao_cadastrado (422); fault desconhecida → falha", async () => {
  const a = await conferirCodigoNaOmie(ok({ faultstring: "ERROR: Cliente não cadastrado para o Código [500] !" }), 500);
  assertEquals(a.tipo, "nao_cadastrado");
  if (a.tipo !== "conferido") assertEquals(statusDaConferencia(a), 422);
  const b = await conferirCodigoNaOmie(ok({ faultstring: "Consumo redundante detectado" }), 500);
  assertEquals(b.tipo, "falha");
});

Deno.test("conferir: outro código de volta, sem documento, resposta vazia → nunca conferido", async () => {
  assertEquals((await conferirCodigoNaOmie(ok({ codigo_cliente_omie: 501, cnpj_cpf: "11222333000181" }), 500)).tipo, "invalido");
  assertEquals((await conferirCodigoNaOmie(ok({ codigo_cliente_omie: 500, cnpj_cpf: "  " }), 500)).tipo, "invalido");
  assertEquals((await conferirCodigoNaOmie(ok({ codigo_cliente_omie: 500 }), 500)).tipo, "invalido");
  assertEquals((await conferirCodigoNaOmie(() => Promise.resolve(null as unknown as Record<string, unknown>), 500)).tipo, "falha");
});

Deno.test("conferir: código inválido (string, zero, negativo, fração) → invalido sem consultar", async () => {
  let chamou = false;
  const espiao = () => { chamou = true; return Promise.resolve({}); };
  for (const c of ["500", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assertEquals((await conferirCodigoNaOmie(espiao, c)).tipo, "invalido", `código ${String(c)}`);
  }
  assertEquals(chamou, false);
});

Deno.test("documento: pagina ate a pagina VAZIA; código repetido é único; 2º código em OUTRA página é ambíguo", async () => {
  const paginas = (ps: Array<Record<string, unknown>>) => (n: number) => Promise.resolve(ps[n - 1] ?? { clientes_cadastro: [] });
  const u = await codigoUnicoDoDocumento(paginas([{ clientes_cadastro: [{ codigo_cliente_omie: 7 }, { codigo_cliente_omie: 7 }] }]));
  assertEquals(u.tipo, "unico");
  if (u.tipo === "unico") assertEquals(u.codigo, 7);
  // Codex P1: a 1ª página só com o 7 não prova nada — o 8 está na página 2.
  const amb = await codigoUnicoDoDocumento(paginas([
    { total_de_paginas: 1, clientes_cadastro: [{ codigo_cliente_omie: 7 }] },
    { clientes_cadastro: [{ codigo_cliente_omie: 8 }] },
  ]));
  assertEquals(amb.tipo, "ambiguo");
  assertEquals((await codigoUnicoDoDocumento(paginas([{ clientes_cadastro: [] }]))).tipo, "nenhum");
  assertEquals((await codigoUnicoDoDocumento(paginas([{ faultstring: "ERROR: Nenhum registro encontrado" }]))).tipo, "nenhum");
});

Deno.test("documento: fault desconhecida, contrato sem lista, código inválido, rede e teto → falha (nunca nenhum/único)", async () => {
  const uma = (r: unknown) => () => Promise.resolve(r as Record<string, unknown>);
  assertEquals((await codigoUnicoDoDocumento(uma({ faultstring: "Application key inválida" }))).tipo, "falha");
  assertEquals((await codigoUnicoDoDocumento(uma({}))).tipo, "falha");
  assertEquals((await codigoUnicoDoDocumento(uma(null))).tipo, "falha");
  assertEquals((await codigoUnicoDoDocumento(uma({ clientes_cadastro: [{}] }))).tipo, "falha");
  assertEquals((await codigoUnicoDoDocumento(() => Promise.reject(new Error("timeout")))).tipo, "falha");
  // Nunca termina (sempre o mesmo código, nunca página vazia): estoura o teto → falha.
  assertEquals((await codigoUnicoDoDocumento(uma({ clientes_cadastro: [{ codigo_cliente_omie: 7 }] }))).tipo, "falha");
});

Deno.test("traduzirErroAdmissao: cada SQLSTATE da migration tem motivo e status; o resto é 500", () => {
  assertEquals(traduzirErroAdmissao({ code: "VC001", message: "O código 500 pertence…" }).status, 422);
  assertEquals(traduzirErroAdmissao({ code: "VC001", message: "O código 500 pertence…" }).motivo, "O código 500 pertence…");
  assertEquals(traduzirErroAdmissao({ code: "VC002" }).status, 422);
  assertEquals(traduzirErroAdmissao({ code: "VC003" }).status, 422);
  assertEquals(traduzirErroAdmissao({ code: "23505" }).status, 409);
  assertEquals(traduzirErroAdmissao({ code: "42501" }).status, 409);
  assertEquals(traduzirErroAdmissao({ code: "XX000", message: "boom" }).status, 500);
});
