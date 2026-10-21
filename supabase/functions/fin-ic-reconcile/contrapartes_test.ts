// Testa o CÓDIGO REAL de contrapartes.ts (código Omie → empresa do grupo), com o Omie falso.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-ic-reconcile/
import { lerResposta, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { type Chamar, consultarCodigos } from "./contrapartes.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
// Rejeição com a MARCA do ramo (não "lançou algo"): docs/historico/tothrow-pelado.md.
async function assertRejeitaCom(p: Promise<unknown>, marca: string) {
  try {
    await p;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!m.includes(marca)) throw new Error(`rejeitou com outra mensagem: ${m}`);
    return;
  }
  throw new Error(`não rejeitou (esperava ${marca})`);
}

const OBEN = "51027034000100";
const C = { empresa: "colacor", alvo: "oben", cnpjAlvo: OBEN };

function omie(paginas: RespostaOmie[]): { chamar: Chamar; params: unknown[] } {
  const params: unknown[] = [];
  let i = 0;
  return {
    params,
    chamar: (_m, p) => {
      params.push(p);
      const r = paginas[i++];
      if (!r) throw new Error("chamada a mais");
      return Promise.resolve(r);
    },
  };
}
// Página n de `total`, com o `total_de_registros` que o Omie declara (default: a própria lista).
const pagina = (cadastros: unknown[], total = 1, n = 1, registros = cadastros.length) =>
  lerResposta(200, JSON.stringify({ pagina: n, total_de_paginas: total, total_de_registros: registros, clientes_cadastro: cadastros }));
const EOF = lerResposta(500, JSON.stringify({ faultstring: "ERROR: Não existem registros para a página [1]!", faultcode: "SOAP-ENV:Client-5113" }));

Deno.test("só entra cadastro com o MESMO documento (com ou sem máscara); o resto é descartado", async () => {
  const o = omie([pagina([
    { codigo_cliente_omie: 4826152900, cnpj_cpf: "51.027.034/0001-00" },
    { codigo_cliente_omie: 4826152901, cnpj_cpf: "51027034000100" },
    { codigo_cliente_omie: 777, cnpj_cpf: "51.027.034/0002-91" }, // filial: OUTRO CNPJ
    { codigo_cliente_omie: 778, cnpj_cpf: "" },
  ])]);
  const r = await consultarCodigos(o.chamar, C);
  assertEquals([r.codigos, r.descartados], [[4826152900, 4826152901], 2]);
  assertEquals((o.params[0] as { clientesFiltro: unknown }).clientesFiltro, { cnpj_cpf: OBEN });
});

Deno.test("EOF na 1ª página = nenhum cadastro com esse CNPJ (legítimo, sem erro)", async () => {
  const r = await consultarCodigos(omie([EOF]).chamar, C);
  assertEquals([r.codigos, r.descartados], [[], 0]);
});

Deno.test("pagina até o total declarado", async () => {
  const o = omie([pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 2, 1, 2), pagina([{ codigo_cliente_omie: 2, cnpj_cpf: OBEN }], 2, 2, 2)]);
  assertEquals((await consultarCodigos(o.chamar, C)).codigos, [1, 2]);
  assertEquals(o.params.length, 2);
});

Deno.test("EOF ANTES do total declarado → lança (retrato parcial não vira mapa)", async () => {
  await assertRejeitaCom(consultarCodigos(omie([pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 3), EOF]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("total de páginas AUSENTE com registros declarados a mais → lança (a 2ª página nunca foi pedida)", async () => {
  const semTotal = lerResposta(200, JSON.stringify({ pagina: 1, total_de_registros: 2, clientes_cadastro: [{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }] }));
  await assertRejeitaCom(consultarCodigos(omie([semTotal]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("página REPETIDA não completa a contagem (cadastros distintos < declarados) → lança", async () => {
  const p1 = pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 2, 1, 2);
  const p2 = pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 2, 2, 2);
  await assertRejeitaCom(consultarCodigos(omie([p1, p2]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("eco de OUTRA página (pedi a 2, veio a 1) → lança", async () => {
  const p1 = pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 2, 1, 2);
  await assertRejeitaCom(consultarCodigos(omie([p1, p1]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("sem total_de_registros → lança (completude não provada)", async () => {
  const r = lerResposta(200, JSON.stringify({ pagina: 1, total_de_paginas: 1, clientes_cadastro: [{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }] }));
  await assertRejeitaCom(consultarCodigos(omie([r]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("página VAZIA antes do total declarado → lança (não é fim da lista)", async () => {
  await assertRejeitaCom(consultarCodigos(omie([pagina([{ codigo_cliente_omie: 1, cnpj_cpf: OBEN }], 3, 1, 3), pagina([], 3, 2, 3)]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});

Deno.test("fault de negócio / HTTP de erro / corpo sem lista → lança, nunca 'zero cadastros'", async () => {
  const bloqueio = lerResposta(500, JSON.stringify({ faultstring: "Consumo redundante detectado", faultcode: "SOAP-ENV:Client-6" }));
  await assertRejeitaCom(consultarCodigos(omie([bloqueio]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
  await assertRejeitaCom(consultarCodigos(omie([lerResposta(200, "{}")]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
  await assertRejeitaCom(consultarCodigos(omie([lerResposta(200, "<html>")]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
  await assertRejeitaCom(consultarCodigos(omie([lerResposta(403, JSON.stringify({ clientes_cadastro: [] }))]).chamar, C), "OMIE_CONTRAPARTE_FALHOU");
});
