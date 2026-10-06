// Testa o CÓDIGO REAL de candidatas.ts (não uma cópia) no runtime real (Deno), contra um banco
// FALSO que registra a consulta e devolve um roteiro. Roda com:
//   deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-ctes-recebidos/candidatas_test.ts
//
// O que este módulo fecha (OBEN, medido em 2026-10-05): a janela de candidatas do casamento de frete
// aceitava a linha órfã do PRÓPRIO CT-e, que o `omie-sync-nfes-recebidas` gravava no rastreio como
// se fosse NF-e. No CONECT (só data) ela vencia sempre — o t2 dela é a emissão do CT-e, distância
// zero. Resultado: 13 dos 82 vínculos caíram numa linha 57 (11 na própria, 2 em outro CT-e).
//
// As falsificações que importam:
//   (a) a coluna `nfe_chave_acesso` TEM de vir no select — sem ela o filtro lê `undefined`, que não
//       é CT-e, e deixa passar tudo em silêncio;
//   (b) DENYLIST: sai só o 57 legível. Chave ilegível e modelo desconhecido seguem candidatos, como
//       hoje — um mutante "só 55" tiraria candidata real do casamento;
//   (c) a ordem da consulta (t2 decrescente) chega intacta ao matcher: o CONECT desempata pela data
//       e o SP_MINAS ordena pelo desvio, mas um filtro que reordenasse mudaria o empate;
//   (d) falha de leitura LANÇA. Antes virava `[]`, o CT-e era contado como órfão e o run seguia com
//       cara de "não havia NF-e na janela".
import { buscarCandidatas, type BancoCandidatas, type ConsultaCandidatas } from "./candidatas.ts";
import { FalhaLeituraCritica, type RespostaLeitura } from "../_shared/leitura-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

/** Chave de acesso no layout SEFAZ (44 dígitos), com o modelo nas posições 21–22. */
function chave(modelo: string, numero: string): string {
  const c = `35` + `2609` + `61142865000691` + modelo + `001` + numero + `1` + `12345678` + `9`;
  if (c.length !== 44) throw new Error(`fixture quebrada: chave com ${c.length} dígitos`);
  return c;
}

type Chamada = unknown[];

/** Banco falso: registra CADA passo da consulta e responde o roteiro no `await`. */
function bancoFalso(resposta: RespostaLeitura<unknown[]>): { db: BancoCandidatas; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const consulta: ConsultaCandidatas = {
    select(colunas) { chamadas.push(["select", colunas]); return consulta; },
    eq(coluna, valor) { chamadas.push(["eq", coluna, valor]); return consulta; },
    not(coluna, operador, valor) { chamadas.push(["not", coluna, operador, valor]); return consulta; },
    is(coluna, valor) { chamadas.push(["is", coluna, valor]); return consulta; },
    gte(coluna, valor) { chamadas.push(["gte", coluna, valor]); return consulta; },
    lte(coluna, valor) { chamadas.push(["lte", coluna, valor]); return consulta; },
    order(coluna, opts) { chamadas.push(["order", coluna, opts]); return consulta; },
    then(aoCumprir, aoRejeitar) { return Promise.resolve(resposta).then(aoCumprir, aoRejeitar); },
  };
  const db: BancoCandidatas = {
    from(tabela) { chamadas.push(["from", tabela]); return consulta; },
  };
  return { db, chamadas };
}

const SAYERLACK = 8689681266;
// Emissão do CT-e como o `mapCte` a monta (dEmissaoNFe "01/10/2026" → meia-noite de Brasília).
const EMISSAO = new Date("2026-10-01T00:00:00-03:00");

Deno.test("a consulta é a de antes MAIS a chave de acesso no select", async () => {
  const { db, chamadas } = bancoFalso({ data: [], error: null });
  await buscarCandidatas(db, "OBEN", SAYERLACK, EMISSAO);
  assertEquals(chamadas, [
    ["from", "purchase_orders_tracking"],
    ["select", "id, numero_pedido, t2_data_faturamento, raw_data, nfe_chave_acesso"],
    ["eq", "empresa", "OBEN"],
    ["eq", "fornecedor_codigo_omie", SAYERLACK],
    ["not", "nfe_chave_acesso", "is", null],
    ["is", "t3_data_cte", null],
    // janela [emissão − 3 dias, emissão], em UTC
    ["gte", "t2_data_faturamento", "2026-09-28T03:00:00.000Z"],
    ["lte", "t2_data_faturamento", "2026-10-01T03:00:00.000Z"],
    ["order", "t2_data_faturamento", { ascending: false }],
  ]);
});

Deno.test("linha modelo 57 sai das candidatas; o resto fica, na ordem da consulta", async () => {
  const linhas = [
    { id: "nfe-a", numero_pedido: "2083548", t2_data_faturamento: "2026-10-01T03:00:00+00:00",
      nfe_chave_acesso: chave("55", "000000001"), raw_data: { cabec: { nValorNFe: 12000 } } },
    // a órfã do PRÓPRIO CT-e: t2 = emissão, distância zero — o CONECT a escolhia sempre
    { id: "cte-proprio", numero_pedido: null, t2_data_faturamento: "2026-10-01T03:00:00+00:00",
      nfe_chave_acesso: chave("57", "000000002"), raw_data: { cabec: { nValorNFe: 300 } } },
    { id: "nfe-b", numero_pedido: "2083549", t2_data_faturamento: "2026-09-30T03:00:00+00:00",
      nfe_chave_acesso: chave("55", "000000003"), raw_data: null },
    { id: "chave-ilegivel", numero_pedido: null, t2_data_faturamento: "2026-09-30T03:00:00+00:00",
      nfe_chave_acesso: ` ${chave("57", "000000004")}`, raw_data: { cabec: {} } },
    { id: "outro-cte", numero_pedido: null, t2_data_faturamento: "2026-09-29T03:00:00+00:00",
      nfe_chave_acesso: chave("57", "000000005"), raw_data: { cabec: { nValorNFe: 410 } } },
    { id: "modelo-65", numero_pedido: null, t2_data_faturamento: "2026-09-29T03:00:00+00:00",
      nfe_chave_acesso: chave("65", "000000006"), raw_data: { cabec: { nValorNFe: 99 } } },
    { id: "57-no-numero", numero_pedido: "2083550", t2_data_faturamento: "2026-09-28T03:00:00+00:00",
      nfe_chave_acesso: chave("55", "000005757"), raw_data: { cabec: { nValorNFe: 8000 } } },
  ];
  const { db } = bancoFalso({ data: linhas, error: null });
  const r = await buscarCandidatas(db, "OBEN", SAYERLACK, EMISSAO);
  assertEquals(r, {
    candidatas: [
      { id: "nfe-a", numero_pedido: "2083548", t2_data_faturamento: "2026-10-01T03:00:00+00:00", valor_nfe: 12000 },
      { id: "nfe-b", numero_pedido: "2083549", t2_data_faturamento: "2026-09-30T03:00:00+00:00", valor_nfe: 0 },
      { id: "chave-ilegivel", numero_pedido: null, t2_data_faturamento: "2026-09-30T03:00:00+00:00", valor_nfe: 0 },
      { id: "modelo-65", numero_pedido: null, t2_data_faturamento: "2026-09-29T03:00:00+00:00", valor_nfe: 99 },
      { id: "57-no-numero", numero_pedido: "2083550", t2_data_faturamento: "2026-09-28T03:00:00+00:00", valor_nfe: 8000 },
    ],
    ctesExcluidas: 2,
  });
});

Deno.test("janela sem linha e sem erro: nenhuma candidata, nada excluído", async () => {
  const { db } = bancoFalso({ data: [], error: null });
  assertEquals(await buscarCandidatas(db, "OBEN", SAYERLACK, EMISSAO), { candidatas: [], ctesExcluidas: 0 });
});

Deno.test("falha de leitura LANÇA — não vira 'nenhuma candidata' (que contava o CT-e como órfão)", async () => {
  const { db } = bancoFalso({ data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } });
  let capturado: unknown = null;
  try {
    await buscarCandidatas(db, "OBEN", SAYERLACK, EMISSAO);
  } catch (e) {
    capturado = e;
  }
  if (!(capturado instanceof FalhaLeituraCritica)) {
    throw new Error(`esperado FalhaLeituraCritica, veio ${capturado === null ? "NADA (a falha foi engolida)" : String(capturado)}`);
  }
  assertEquals(capturado.codigo, "57014", "o código do Postgres atravessa");
  assertEquals(capturado.fonte, "purchase_orders_tracking (candidatas ao frete)", "a fonte nomeia a leitura");
});
