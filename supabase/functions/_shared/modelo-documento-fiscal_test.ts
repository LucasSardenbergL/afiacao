// Testa o CÓDIGO REAL de modelo-documento-fiscal.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/modelo-documento-fiscal_test.ts
//
// O que este módulo decide (OBEN, medido em 2026-10-05): a lista do `ListarRecebimentos` traz NF-e e
// CT-e juntos, e o `omie-sync-nfes-recebidas` gravava o CT-e como linha órfã do rastreio (135 linhas,
// nenhuma com leadtime). A fonte passa a pular o documento quando DOIS sinais independentes dizem 57:
// a chave de acesso CRUA (posições 21–22) e o `cabec.cModeloNFe`.
//
// As falsificações que importam, em ordem de custo:
//   (a) UM sinal só não basta: chave 57 com cabeçalho 55 (ou o inverso) é `divergente`, nunca CT-e.
//       Um mutante com `||` no lugar do `&&` pularia NF-e real — e o pedido dela ficaria sem nota;
//   (b) a chave lida é a CRUA, sem a normalização do writer (`replace(/\D/g,"").slice(0,44)`): uma
//       chave de CT-e formatada com espaço NÃO é evidência de CT-e. Normalizar transforma entrada
//       malformada em evidência positiva de exclusão (o mesmo achado do Codex na parte A);
//   (c) cabeçalho ESTRITO: só string de 2 dígitos. Número, espaço e zero à esquerda caem em
//       `ausente` — o documento segue o fluxo de hoje E fica visível no contador, em vez de a regra
//       ficar inerte em silêncio se a Omie mudar o tipo do campo;
//   (d) a POSIÇÃO do 57 na chave: "57" no número da nota não é o modelo.
import {
  classificarModeloRecebimento,
  ehCte,
  MODELO_CTE,
  modeloDaChave,
  modeloDoCabecalho,
} from "./modelo-documento-fiscal.ts";
import * as escopoSkuItems from "../omie-sync-sku-items/escopo.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

/** Chave de acesso no layout SEFAZ (44 dígitos), com o modelo nas posições 21–22. */
function chave(modelo: string, numero = "000123456"): string {
  // cUF(2) + AAMM(4) + CNPJ(14) + modelo(2) + série(3) + nNF(9) + tpEmis(1) + cNF(8) + DV(1)
  const c = `35` + `2610` + `61142865000691` + modelo + `001` + numero + `1` + `12345678` + `9`;
  if (c.length !== 44) throw new Error(`fixture quebrada: chave com ${c.length} dígitos`);
  return c;
}

Deno.test("CT-e só quando a chave E o cabeçalho dizem 57", () => {
  assertEquals(classificarModeloRecebimento({ cChaveNFe: chave("57"), cModeloNFe: "57" }), { tipo: "cte" });
});

Deno.test("concordância em outro modelo segue o fluxo de hoje (55, 65 e o 67 fora do contrato)", () => {
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55"), cModeloNFe: "55" }),
    { tipo: "outro", modelo: "55" },
  );
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("65"), cModeloNFe: "65" }),
    { tipo: "outro", modelo: "65" },
  );
  // CT-e OS (67) também não tem produto, mas não existe na população medida: estender é contrato
  // novo, com teste próprio (a mesma decisão da parte A).
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("67"), cModeloNFe: "67" }),
    { tipo: "outro", modelo: "67" },
  );
});

Deno.test("divergente: os dois sinais legíveis e diferentes nunca viram CT-e", () => {
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("57"), cModeloNFe: "55" }),
    { tipo: "divergente", daChave: "57", doCabecalho: "55" },
  );
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55"), cModeloNFe: "57" }),
    { tipo: "divergente", daChave: "55", doCabecalho: "57" },
  );
  // "57" FORA das posições 21–22 (aqui no nNF) não é o modelo: com o cabeçalho dizendo 57, a chave
  // ainda diz 55. Um mutante `chave.includes("57")` classificaria esta NF-e como CT-e.
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55", "000005757"), cModeloNFe: "57" }),
    { tipo: "divergente", daChave: "55", doCabecalho: "57" },
  );
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55", "000005757"), cModeloNFe: "55" }),
    { tipo: "outro", modelo: "55" },
  );
});

Deno.test("ausente: qualquer sinal ilegível ou faltando — inclusive com o outro dizendo 55", () => {
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("57") }),
    { tipo: "ausente", daChave: "57", doCabecalho: null },
  );
  assertEquals(
    classificarModeloRecebimento({ cModeloNFe: "57" }),
    { tipo: "ausente", daChave: null, doCabecalho: "57" },
  );
  // Com a chave dizendo 55 e o cabeçalho faltando o documento não é CT-e de jeito nenhum, mas a
  // verificação dupla não rodou — e é esse contador que denuncia a Omie parando de mandar o campo.
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55") }),
    { tipo: "ausente", daChave: "55", doCabecalho: null },
  );
  const semCabecalho: unknown[] = [{}, undefined, null, "texto", [], 42];
  for (const c of semCabecalho) {
    assertEquals(
      classificarModeloRecebimento(c),
      { tipo: "ausente", daChave: null, doCabecalho: null },
      `classificarModeloRecebimento(${JSON.stringify(c)})`,
    );
  }
});

Deno.test("cabeçalho estrito: só string de 2 dígitos ASCII", () => {
  assertEquals(modeloDoCabecalho("57"), "57");
  assertEquals(modeloDoCabecalho("55"), "55");
  const ilegiveis: unknown[] = [57, 55, " 57", "57 ", "057", "5", "", "5a", "５７", null, undefined, ["57"], { m: "57" }];
  for (const v of ilegiveis) {
    assertEquals(modeloDoCabecalho(v), null, `modeloDoCabecalho(${JSON.stringify(v)})`);
  }
  // Número no lugar da string: a regra NÃO pula o CT-e — fica visível como `ausente`.
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("57"), cModeloNFe: 57 }),
    { tipo: "ausente", daChave: "57", doCabecalho: null },
  );
});

Deno.test("a chave lida é a CRUA: chave formatada ou com letra não vira CT-e por normalização", () => {
  const c = chave("57");
  const naoEstritas = [
    `${c.slice(0, 4)} ${c.slice(4, 8)} ${c.slice(8)}`, // agrupada com espaço (o writer limparia)
    `${c.slice(0, 2)}.${c.slice(2)}`, // com ponto
    ` ${c}`, // espaço antes
    `${c}\n`, // quebra de linha depois
    `${c.slice(0, 6)}A${c.slice(7)}`, // letra no campo do CNPJ (CNPJ alfanumérico)
    c.slice(1), // 43 dígitos
    `${c}0`, // 45 dígitos
  ];
  for (const v of naoEstritas) {
    assertEquals(
      classificarModeloRecebimento({ cChaveNFe: v, cModeloNFe: "57" }),
      { tipo: "ausente", daChave: null, doCabecalho: "57" },
      `chave ${JSON.stringify(v)}`,
    );
  }
});

Deno.test("variante cChaveNfe: lida só na falta de cChaveNFe, a mesma escolha do writer", () => {
  assertEquals(classificarModeloRecebimento({ cChaveNfe: chave("57"), cModeloNFe: "57" }), { tipo: "cte" });
  assertEquals(
    classificarModeloRecebimento({ cChaveNFe: chave("55"), cChaveNfe: chave("57"), cModeloNFe: "57" }),
    { tipo: "divergente", daChave: "55", doCabecalho: "57" },
  );
});

Deno.test("a decisão da chave segue a da parte A (denylist do 57 pela posição 21–22)", () => {
  assertEquals(MODELO_CTE, "57");
  assertEquals(modeloDaChave(chave("57")), "57");
  assertEquals(ehCte(chave("57")), true);
  assertEquals(ehCte(chave("55", "000005757")), false);
  assertEquals(ehCte(` ${chave("57")}`), false);
});

Deno.test("PARIDADE com a cópia da parte A (escopo.ts do sku-items): mesmos veredictos no mesmo corpus", () => {
  // As duas cópias têm de decidir IGUAL até a convergência para reexport (depois do #2801). Se uma
  // delas mudar sozinha, a fila do leadtime tira um conjunto de CT-e e o rastreio, outro.
  const c57 = chave("57");
  const corpus: unknown[] = [
    chave("55"), c57, chave("58"), chave("59"), chave("65"), chave("66"), chave("67"),
    chave("55", "000005757"), chave("57", "000005555"),
    c57.slice(1), `${c57}0`, ` ${c57}`, `${c57} `, `${c57}\n`, `${c57.slice(0, 20)}.${c57.slice(21)}`,
    `${c57.slice(0, 6)}A${c57.slice(7)}`, "", "57", null, undefined,
    Number(c57.slice(0, 15)), { chave: c57 }, [c57],
  ];
  for (const x of corpus) {
    assertEquals(modeloDaChave(x), escopoSkuItems.modeloDaChave(x), `modeloDaChave(${JSON.stringify(x)}) divergiu entre as cópias`);
    assertEquals(ehCte(x), escopoSkuItems.ehCte(x), `ehCte(${JSON.stringify(x)}) divergiu entre as cópias`);
  }
  assertEquals(MODELO_CTE, escopoSkuItems.MODELO_CTE);
});
