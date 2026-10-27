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
    // eco tipado (Codex): Number(true) === 1 e Number([1]) === 1 não podem passar por página 1
    ["eco de página booleano", { pagina: true, clientes_cadastro: [] }],
    ["eco de página array", { pagina: [1], clientes_cadastro: [] }],
    ["eco de página null", { pagina: null, clientes_cadastro: [] }],
    // vazio contraditório (Codex): a contagem da página desmente o array
    ["vazio com registros:1", { pagina: 1, registros: 1, clientes_cadastro: [] }],
    ["array mais curto que a contagem", { pagina: 1, registros: 2, clientes_cadastro: [cli(777)] }],
    ["contagem malformada", { pagina: 1, registros: "dois", clientes_cadastro: [] }],
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

Deno.test("campos de controle bem-formados passam: eco e contagem como string decimal", async () => {
  const o = omie([{ pagina: "1", registros: "1", clientes_cadastro: [cli(777)] }, { pagina: 2, registros: 0, clientes_cadastro: [] }]);
  assertEquals((await buscarClienteEstrito(DOC, "oben", o.listar))?.codigo_cliente, 777);
});

Deno.test("AMBÍGUO sai na hora: transitório na página seguinte não o rebaixa a retentável (Codex)", async () => {
  let chamadas = 0;
  const listar: ListarPagina = (pagina) => {
    chamadas++;
    return pagina === 1 ? Promise.resolve(pg(1, cli(777), cli(778))) : Promise.reject(new Error("OMIE_TRANSIENT (oben): caiu"));
  };
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", listar), "OMIE_LOOKUP_AMBIGUO");
  assertEquals(chamadas, 1);
});

Deno.test("documento devolvido com letra fora da gramática não casa pelos dígitos → DIVERGENTE (#3359)", async () => {
  await assertRejeitaCom(buscarClienteEstrito("12345678909", "oben", omie([pg(1, cli(777, "123ABC45678909"))]).listar), "OMIE_LOOKUP_DIVERGENTE");
});

Deno.test("orçamento total esgotado antes da próxima página → INDETERMINADO, sem usar o parcial", async () => {
  // A página 2 viria vazia (lookup resolvido em 777): só o orçamento, não o guard de páginas, pode barrar.
  let t = 0;
  const lento: ListarPagina = (pagina) => {
    t += 70_000;
    return Promise.resolve(pagina === 1 ? pg(1, cli(777)) : null);
  };
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", lento, { orcamentoMs: 60_000, agora: () => t }), "OMIE_LOOKUP_INDETERMINADO");
});

Deno.test("orçamento conferido DEPOIS de cada resposta: vazio que chegou tarde não prova nada (Codex, código)", async () => {
  // 1ª página vazia aos 70s → antes viraria null e seguiria ao IncluirCliente
  let t = 0;
  const vazioTarde: ListarPagina = () => {
    t += 70_000;
    return Promise.resolve(null);
  };
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", vazioTarde, { orcamentoMs: 60_000, agora: () => t }), "OMIE_LOOKUP_INDETERMINADO");
  // 777 aos 59s, página 2 vazia aos 198s → antes aceitava 777
  t = 0;
  const unicoTarde: ListarPagina = (pagina) => {
    t += pagina === 1 ? 59_000 : 139_000;
    return Promise.resolve(pagina === 1 ? pg(1, cli(777)) : null);
  };
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", unicoTarde, { orcamentoMs: 60_000, agora: () => t }), "OMIE_LOOKUP_INDETERMINADO");
});

Deno.test("ambiguidade provada vence registro malformado, divergente e relógio estourado (Codex, código)", async () => {
  const semCodigo = { cnpj_cpf: DOC, razao_social: "X" };
  const casos: Array<[string, unknown[]]> = [
    ["malformado depois", [pg(1, cli(777), cli(778), semCodigo)]],
    ["malformado antes", [pg(1, semCodigo, cli(777), cli(778))]],
    ["2º código na página 2 junto de malformado", [pg(1, cli(777)), pg(2, cli(778), semCodigo)]],
    ["divergente junto", [pg(1, cli(777), cli(778, "98765432000110"), cli(779))]],
    ["contagem contraditória junto", [{ pagina: 1, registros: 5, clientes_cadastro: [cli(777), cli(778)] }]],
  ];
  for (const [nome, paginas] of casos) {
    await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie(paginas).listar), "OMIE_LOOKUP_AMBIGUO").catch((e) => {
      throw new Error(`${nome}: ${(e as Error).message}`);
    });
  }
  let t = 0;
  const ambiguoTarde: ListarPagina = () => {
    t += 100_000;
    return Promise.resolve(pg(1, cli(777), cli(778)));
  };
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", ambiguoTarde, { orcamentoMs: 60_000, agora: () => t }), "OMIE_LOOKUP_AMBIGUO");
});

Deno.test("1 código válido + registro malformado na mesma página → INDETERMINADO (unicidade não provada)", async () => {
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", omie([pg(1, cli(777), { cnpj_cpf: DOC })]).listar), "OMIE_LOOKUP_INDETERMINADO");
});

Deno.test("transitório do Omie (throw do fetch) propaga — não vira ausência", async () => {
  const caiu: ListarPagina = () => Promise.reject(new Error("OMIE_TRANSIENT (oben): rate limit persistiu"));
  await assertRejeitaCom(buscarClienteEstrito(DOC, "oben", caiu), "OMIE_TRANSIENT");
});
