// Testa o CÓDIGO REAL de o-que-vai-ao-omie.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/o-que-vai-ao-omie_test.ts
import {
  infoAdicionalItem,
  infoAdicionalItemAninhada,
  previsaoEntregaOmie,
  previsaoOrdemProducao,
  rotuloCorItem,
} from "./o-que-vai-ao-omie.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}

const TINTA = { tint_cor_id: "RAL9010", tint_nome_cor: "Branco Puro", descricao: "PU BRILHANTE GL" };

// ── cor + OC ──────────────────────────────────────────────────────────────

Deno.test("tinta COM OC: a cor NÃO some — NF leva as duas, OC inteira, observação com a cor", () => {
  igual(infoAdicionalItem(TINTA, "OC-4471"), {
    dados_adicionais_item: "Cor: RAL9010 - Branco Puro - GL | OC: OC-4471",
    numero_pedido_compra: "OC-4471",
    obs_item: "Cor: RAL9010 - Branco Puro - GL",
  }, "cor+oc");
});

Deno.test("só OC (item sem cor): mesmo formato de antes — OC crua na NF e no nº do pedido de compra", () => {
  igual(infoAdicionalItem({ descricao: "LIXA 120" }, "4471"), {
    dados_adicionais_item: "4471",
    numero_pedido_compra: "4471",
  }, "so-oc");
});

Deno.test("só cor (sem OC): mesmo formato de antes — cor na NF e na observação", () => {
  igual(infoAdicionalItem(TINTA, undefined), {
    dados_adicionais_item: "Cor: RAL9010 - Branco Puro - GL",
    obs_item: "Cor: RAL9010 - Branco Puro - GL",
  }, "so-cor");
});

Deno.test("nem cor nem OC (e OC só de espaços): nada", () => {
  igual(infoAdicionalItem({ descricao: "LIXA" }, "   "), {}, "nada");
  igual(infoAdicionalItemAninhada({ descricao: "LIXA" }, null), {}, "nada-aninhada");
});

Deno.test("aninhada (IncluirPedido): inf_adic + observacao", () => {
  igual(infoAdicionalItemAninhada(TINTA, "OC-1"), {
    inf_adic: { dados_adicionais_item: "Cor: RAL9010 - Branco Puro - GL | OC: OC-1", numero_pedido_compra: "OC-1" },
    observacao: { obs_item: "Cor: RAL9010 - Branco Puro - GL" },
  }, "aninhada");
});

Deno.test("rótulo: nome que já traz o código não repete; embalagem em ML; cor sem nome = sem cor", () => {
  igual(rotuloCorItem({ tint_cor_id: "N-12", tint_nome_cor: "n-12 cinza", descricao: "VERNIZ 405ML" }), "Cor: n-12 cinza - 405ML", "ja-tem-codigo");
  igual(rotuloCorItem({ tint_cor_id: "X1", tint_nome_cor: "Azul", descricao: "BASE 3,6 ML" }), "Cor: X1 - Azul - 3.6ML", "ml-virgula");
  igual(rotuloCorItem({ tint_cor_id: "X1", tint_nome_cor: "" }), null, "sem-nome");
  igual(rotuloCorItem({ tint_cor_id: "", tint_nome_cor: "Azul" }), null, "sem-id");
});

// ── data prometida ────────────────────────────────────────────────────────

const HOJE = "2026-11-24";

Deno.test("data prometida futura → DD/MM/AAAA", () => {
  igual(previsaoEntregaOmie("2026-11-27", HOJE), "27/11/2026", "futura");
});

Deno.test("data prometida = hoje → vai (entrega no dia)", () => {
  igual(previsaoEntregaOmie("2026-11-24", HOJE), "24/11/2026", "hoje");
});

Deno.test("ausente ≠ hoje: null/''/undefined NÃO viram previsão de entrega", () => {
  igual(previsaoEntregaOmie(null, HOJE), null, "null");
  igual(previsaoEntregaOmie("", HOJE), null, "vazio");
  igual(previsaoEntregaOmie(undefined, HOJE), null, "undefined");
});

Deno.test("data no passado (pedido antigo reeditado) NÃO vai", () => {
  igual(previsaoEntregaOmie("2026-11-23", HOJE), null, "ontem");
});

Deno.test("data ilegível NÃO vai (não existe no calendário, formato frouxo, com hora)", () => {
  igual(previsaoEntregaOmie("2026-02-30", HOJE), null, "30-fev");
  igual(previsaoEntregaOmie("2026-13-01", HOJE), null, "mes-13");
  igual(previsaoEntregaOmie("2026-12-1", HOJE), null, "frouxo");
  igual(previsaoEntregaOmie("2026-12-01T00:00:00Z", HOJE), null, "com-hora");
  igual(previsaoEntregaOmie(20261201, HOJE), null, "numero");
});

Deno.test("OP: prometida quando vale, senão HOJE (campo obrigatório)", () => {
  igual(previsaoOrdemProducao("2026-12-02", HOJE), "02/12/2026", "op-prometida");
  igual(previsaoOrdemProducao(null, HOJE), "24/11/2026", "op-sem-data");
  igual(previsaoOrdemProducao("2026-11-01", HOJE), "24/11/2026", "op-vencida");
});
