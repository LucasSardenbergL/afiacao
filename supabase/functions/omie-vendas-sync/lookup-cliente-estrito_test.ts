// Sem rede (`--no-remote` do test:edges): assert inline, como os demais _test.ts desta edge.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
/** Negativo casando a MARCA do ramo (nunca "lançou algo"). */
async function assertRejeitaCom(p: Promise<unknown>, marca: string) {
  let erro: unknown = null;
  try {
    await p;
  } catch (e) {
    erro = e;
  }
  if (!(erro instanceof Error)) throw new Error(`esperado erro ${marca}, mas resolveu`);
  if (!erro.message.startsWith(`${marca} (`)) throw new Error(`esperado ${marca}, veio: ${erro.message}`);
}
import { buscarClienteEstrito, type ListarPagina } from "./lookup-cliente-estrito.ts";

const DOC = "12345678000195";
const cli = (codigo: unknown, doc: unknown = "12.345.678/0001-95", extra: Record<string, unknown> = {}) => ({
  codigo_cliente_omie: codigo, cnpj_cpf: doc, razao_social: "ACME", ...extra,
});
/** Fake do ListarClientes: `paginas[i]` é a resposta da página i+1; além delas, `null` (fault "Não existem registros"). */
function omie(paginas: unknown[]): { listar: ListarPagina; chamadas: number[] } {
  const chamadas: number[] = [];
  return {
    chamadas,
    listar: (pagina) => {
      chamadas.push(pagina);
      return Promise.resolve(pagina <= paginas.length ? paginas[pagina - 1] : null);
    },
  };
}
const pg = (pagina: number, ...clientes: unknown[]) => ({ pagina, clientes_cadastro: clientes });

Deno.test("vazio VÁLIDO na 1ª página → null (ausência provada), por fault ou por array vazio", async () => {
  const porFault = omie([]);
  assertEquals(await buscarClienteEstrito(DOC, "oben", porFault.listar), null);
  assertEquals(porFault.chamadas, [1]);
  const porArray = omie([pg(1)]);
  assertEquals(await buscarClienteEstrito(DOC, "oben", porArray.listar), null);
  assertEquals(porArray.chamadas, [1]);
});

Deno.test("exatamente 1 cliente → esse, e só depois da página vazia", async () => {
  const o = omie([pg(1, cli(777, DOC, { recomendacoes: { codigo_vendedor: 9 } }))]);
  assertEquals(await buscarClienteEstrito(DOC, "oben", o.listar), {
    codigo_cliente: 777, razao_social: "ACME", codigo_vendedor: 9, cnpj_cpf: DOC,
  });
  assertEquals(o.chamadas, [1, 2]);
});

Deno.test("mesmo código repetido entre páginas = o MESMO cliente, não ambíguo", async () => {
  const o = omie([pg(1, cli(777)), pg(2, cli(777))]);
  assertEquals((await buscarClienteEstrito(DOC, "oben", o.listar))?.codigo_cliente, 777);
});

Deno.test("AMBÍGUO: 2 códigos para o documento (mesma página ou páginas diferentes)", async () => {
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([pg(1, cli(777), cli(778))]).listar), "OMIE_LOOKUP_AMBIGUO");
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([pg(1, cli(777)), pg(2, cli(778))]).listar), "OMIE_LOOKUP_AMBIGUO");
});

Deno.test("DIVERGENTE: registro com OUTRO documento, mesmo atrás do certo", async () => {
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([pg(1, cli(777, "98765432000110"))]).listar), "OMIE_LOOKUP_DIVERGENTE");
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([pg(1, cli(777), cli(778, "98765432000110"))]).listar), "OMIE_LOOKUP_DIVERGENTE");
});

Deno.test("MALFORMADO → INDETERMINADO, nunca 'não existe'", async () => {
  const malformadas: Array<[string, unknown]> = [
    ["não-objeto", "ok"],
    ["array na raiz", []],
    ["sem clientes_cadastro", { pagina: 1, total_de_registros: 0 }],
    ["clientes_cadastro não-array", { pagina: 1, clientes_cadastro: { codigo_cliente_omie: 777 } }],
    ["registro não-objeto", pg(1, 777)],
    ["sem código", pg(1, cli(undefined))],
    ["código string", pg(1, cli("777"))],
    ["código zero", pg(1, cli(0))],
    ["código fracionário", pg(1, cli(7.5))],
    ["código além de 2^53", pg(1, cli(Number.MAX_SAFE_INTEGER + 1))],
    ["sem cnpj_cpf", pg(1, { codigo_cliente_omie: 777, razao_social: "ACME" })],
    ["cnpj_cpf não-string", pg(1, cli(777, 12345678000195))],
    ["eco de página errado", pg(2, cli(777))],
  ];
  for (const [nome, resp] of malformadas) {
    await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([resp]).listar), "OMIE_LOOKUP_INDETERMINADO").catch((e) => {
      throw new Error(`${nome}: ${(e as Error).message}`);
    });
  }
});

Deno.test("guard: paginação que nunca esvazia → INDETERMINADO (não confia em total_de_paginas)", async () => {
  const sempreCheia: ListarPagina = (pagina) => Promise.resolve(pg(pagina, cli(777)));
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", sempreCheia, { maxPaginas: 3 }), "OMIE_LOOKUP_INDETERMINADO");
});

Deno.test("transitório do Omie (throw do fetch) propaga — não vira ausência", async () => {
  const caiu: ListarPagina = () => Promise.reject(new Error("OMIE_TRANSIENT (oben): rate limit persistiu"));
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", caiu), "OMIE_TRANSIENT");
});
