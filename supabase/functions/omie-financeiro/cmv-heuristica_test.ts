// Confiança do CMV na DRE (edge v1.14, entrega 3 do Placar do CEO).
//
// O que este teste prova:
//   1. pelo HANDLER (`calcular_dre`, PostgREST falso): o upsert em `fin_dre_snapshots` grava
//      `cmv_heuristica` = só o CMV que veio pela heurística (categoria sem mapa E lançamento sem código),
//      nunca o CMV mapeado nem despesa heurística de outra linha; `cmv_heuristica_pct` = essa fração;
//   2. CMV 0 no mês → percentual NULL (sem base), nunca 0%; tudo mapeado → 0 medido (≠ NULL);
//   3. as colunas do upsert casam EXATO com a lista esperada, e o contrato carimba `cmv_heuristica`
//      (é o que o gatilho do banco usa para anular colunas que um bundle velho não reescreveu);
//   4. o helper puro: faixa e coerência validadas DEPOIS do arredondamento (espelha o CHECK).
// Linha de base: 1 e 3 ficam VERMELHOS no código de antes (o upsert não nomeava as colunas); o CONTROLE
// VERDE é "a coluna `cmv` (total) do upsert = soma de todo o CMV", que já valia.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-financeiro/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { colunasCmvHeuristica } from "./cmv-heuristica.ts";

const h = instalarHarness();
// Import COMPUTADO (ver harness): o type-check do index.ts é do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

type Linha = Record<string, unknown>;
const cr = (n: number, cod: string, desc: string, valor: number): Linha => ({
  id: `cr-${n}`, valor_documento: valor, valor_recebido: 0, data_recebimento: null, data_vencimento: "2026-10-20",
  categoria_codigo: cod, categoria_descricao: desc,
});
const cp = (n: number, cod: string, desc: string, valor: number): Linha => ({
  id: `cp-${n}`, valor_documento: valor, valor_pago: 0, data_pagamento: null, data_vencimento: "2026-10-20",
  categoria_codigo: cod, categoria_descricao: desc,
});

const MAPEAMENTO = [
  { omie_codigo: "1.01.01", dre_linha: "receita_bruta", company: "oben" },
  { omie_codigo: "2.01.01", dre_linha: "cmv", company: "oben" },
];
const VENDA = cr(1, "1.01.01", "Venda de mercadorias", 2000);
const CMV_MAPEADO = cp(1, "2.01.01", "Compra de mercadorias", 600);
const CMV_HEURISTICO = cp(2, "2.09.99", "CMV ajuste de inventario", 300);
const CMV_SEM_CODIGO = cp(3, "", "CUSTO MERCADORIA avulso", 100);
const ALUGUEL_HEURISTICO = cp(4, "2.05.01", "Aluguel da loja", 50);

/** Monta o PostgREST falso para um mês e devolve os upserts capturados em `fin_dre_snapshots`. */
function cenario(receitas: Linha[], despesas: Linha[]): Linha[] {
  const upserts: Linha[] = [];
  h.responderForaDoGate(async (r) => {
    const url = new URL(r.url);
    const tabela = url.pathname.replace("/rest/v1/", "");
    const objeto = (r.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (r.method === "GET") {
      // Keyset por `id`: a 2ª página (id=gt.<cursor>) vem vazia.
      const paginaSeguinte = url.searchParams.has("id");
      if (tabela === "fin_contas_receber") return json(paginaSeguinte ? [] : receitas);
      if (tabela === "fin_contas_pagar") return json(paginaSeguinte ? [] : despesas);
      if (tabela === "fin_categoria_dre_mapping") return json(MAPEAMENTO);
      if (tabela === "fin_config_cashflow") return json(objeto ? { dre_tributario: null } : [{ dre_tributario: null }]);
      if (tabela === "fin_dre_snapshots") return json([]);
      return json([]);
    }
    if (r.method === "POST" && tabela === "fin_dre_snapshots") {
      const corpo = await r.json();
      for (const l of Array.isArray(corpo) ? corpo : [corpo]) upserts.push(l);
      return new Response(null, { status: 201 });
    }
    if (r.method === "POST" && tabela === "fin_sync_log") return json(objeto ? { id: "log-1" } : [{ id: "log-1" }], 201);
    return json(objeto ? null : []);
  });
  return upserts;
}

async function calcular(): Promise<void> {
  const r = await handler(new Request(`${ENV_TESTE.SUPABASE_URL}/functions/v1/omie-financeiro`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": ENV_TESTE.CRON_SECRET },
    body: JSON.stringify({ action: "calcular_dre", company: "oben", ano: 2026, mes: 10, regime: "competencia" }),
  }));
  const corpo = await r.text();
  if (r.status !== 200) throw new Error(`calcular_dre devolveu ${r.status}: ${corpo.slice(0, 400)}`);
}

const COLUNAS_UPSERT = [
  "company", "ano", "mes", "regime", "receita_bruta", "deducoes", "receita_liquida", "cmv", "lucro_bruto",
  "despesas_operacionais", "despesas_administrativas", "despesas_comerciais", "despesas_financeiras",
  "receitas_financeiras", "resultado_operacional", "outras_receitas", "outras_despesas",
  "resultado_antes_impostos", "impostos", "resultado_liquido", "fora_dre", "resultado_provisorio",
  "qtd_categorias_sem_mapeamento", "cmv_heuristica", "cmv_heuristica_pct", "detalhamento", "calculated_at",
].sort();

Deno.test("CONTROLE — handler: a coluna cmv do upsert soma TODO o CMV (mapeado + heurística + sem código)", async () => {
  const upserts = cenario([VENDA], [CMV_MAPEADO, CMV_HEURISTICO, CMV_SEM_CODIGO, ALUGUEL_HEURISTICO]);
  await calcular();
  igual(upserts.length, 1, "um upsert por (empresa, mês, regime)");
  igual(upserts[0].cmv, 1000, "cmv total");
});

Deno.test("handler: cmv_heuristica = heurística + sem código (nem o mapeado, nem o aluguel heurístico); pct = 0,4", async () => {
  const upserts = cenario([VENDA], [CMV_MAPEADO, CMV_HEURISTICO, CMV_SEM_CODIGO, ALUGUEL_HEURISTICO]);
  await calcular();
  igual(upserts[0].cmv_heuristica, 400, "R$ do CMV via heurística");
  igual(upserts[0].cmv_heuristica_pct, 0.4, "fração do CMV via heurística");
});

Deno.test("handler: as colunas do upsert casam EXATO e o contrato carimba cmv_heuristica", async () => {
  const upserts = cenario([VENDA], [CMV_MAPEADO, CMV_HEURISTICO]);
  await calcular();
  igual(Object.keys(upserts[0]).sort(), COLUNAS_UPSERT, "colunas do upsert");
  const contrato = (upserts[0].detalhamento as { contrato: Record<string, unknown> }).contrato;
  igual(contrato.cmv_heuristica, "v1", "marca do contrato que o gatilho do banco exige");
  igual(contrato.versao, "dre-fora-dre-v1", "a marca da fase 2 continua (o outro gatilho a exige)");
});

Deno.test("handler: mês sem CMV → cmv_heuristica 0 medido e pct NULL (sem base), nunca 0%", async () => {
  const upserts = cenario([VENDA], [ALUGUEL_HEURISTICO]);
  await calcular();
  igual(upserts[0].cmv, 0, "cmv");
  igual(upserts[0].cmv_heuristica, 0, "valor medido");
  igual(upserts[0].cmv_heuristica_pct, null, "pct sem base");
});

Deno.test("handler: CMV todo mapeado → 0% MEDIDO (≠ NULL)", async () => {
  const upserts = cenario([VENDA], [CMV_MAPEADO]);
  await calcular();
  igual(upserts[0].cmv_heuristica, 0, "valor");
  igual(upserts[0].cmv_heuristica_pct, 0, "pct");
});

Deno.test("helper: arredonda e valida a faixa DEPOIS do arredondamento", () => {
  igual(colunasCmvHeuristica({ cmvTotal: 1000, cmvHeuristica: 400 }), { cmv_heuristica: 400, cmv_heuristica_pct: 0.4 }, "base");
  igual(colunasCmvHeuristica({ cmvTotal: 3, cmvHeuristica: 1 }), { cmv_heuristica: 1, cmv_heuristica_pct: 0.3333 }, "4 casas");
  // Tudo heurístico com ruído de float: 1,000001 arredonda para 1 → aceito (o banco aceita 1).
  igual(colunasCmvHeuristica({ cmvTotal: 0.1 + 0.2, cmvHeuristica: 0.3 }), { cmv_heuristica: 0.3, cmv_heuristica_pct: 1 }, "fronteira 1");
  // Codex P2: o caso acima tem razão 0,9999…98 e passa mesmo com a faixa checada ANTES de arredondar. Este
  // não: 0,7 + 0,1 → valor gravado 0,8 sobre CMV bruto 0,7999…99 = razão 1,0000…02 → só arredondando dá 1.
  igual(colunasCmvHeuristica({ cmvTotal: 0.7 + 0.1, cmvHeuristica: 0.7 + 0.1 }), { cmv_heuristica: 0.8, cmv_heuristica_pct: 1 }, "fronteira 1 acima");
  igual(colunasCmvHeuristica({ cmvTotal: 0, cmvHeuristica: 0 }), { cmv_heuristica: 0, cmv_heuristica_pct: null }, "cmv 0");
  igual(colunasCmvHeuristica({ cmvTotal: -10, cmvHeuristica: 5 }), { cmv_heuristica: 5, cmv_heuristica_pct: null }, "cmv negativo");
  // Isola a guarda `cmv ≤ 0`: razão 0,5 "válida" com os dois negativos — o CHECK recusaria (cmv > 0).
  igual(colunasCmvHeuristica({ cmvTotal: -10, cmvHeuristica: -5 }), { cmv_heuristica: -5, cmv_heuristica_pct: null }, "ambos negativos");
  igual(colunasCmvHeuristica({ cmvTotal: 100, cmvHeuristica: 150 }), { cmv_heuristica: 150, cmv_heuristica_pct: null }, "acima de 100%");
  igual(colunasCmvHeuristica({ cmvTotal: 100, cmvHeuristica: -5 }), { cmv_heuristica: -5, cmv_heuristica_pct: null }, "negativo");
  igual(colunasCmvHeuristica({ cmvTotal: 100, cmvHeuristica: NaN }), { cmv_heuristica: null, cmv_heuristica_pct: null }, "NaN");
  igual(colunasCmvHeuristica({ cmvTotal: NaN, cmvHeuristica: 5 }), { cmv_heuristica: 5, cmv_heuristica_pct: null }, "cmv NaN");
  igual(colunasCmvHeuristica({ cmvTotal: 1e11, cmvHeuristica: 9_999_999_999.996 }), { cmv_heuristica: null, cmv_heuristica_pct: null }, "teto após arredondar");
});
