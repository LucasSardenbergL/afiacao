// Testa a lógica PURA do reprocessInventory em LOTE (sync-reprocess) no runtime real (Deno).
// Roda com: deno test supabase/functions/sync-reprocess/inventory-lote_test.ts
//
// Contexto (2026-07-16): o reprocessInventory N+1 (até 5 round-trips PostgREST POR produto,
// ~3.000+ requests/invocação p/ ~785 produtos OBEN) estourava o worker budget da edge →
// HTTP 546 WORKER_RESOURCE_LIMIT em ~86-100% dos ciclos do cron sync-reprocess-operational,
// órfã `running` em sync_reprocess_log e cauda do catálogo stale. Este módulo isola a DECISÃO
// (normalização, guard de paginação, divergência, partição de custos) do I/O, no padrão do
// syncInventory do omie-analytics-sync (a MESMA operação, já em lote) + paginacao.ts do
// omie-sync-status-produtos (lógica pura + teste Deno).
//
// Money-path (inventory_position oben → fin-valor-cockpit; product_costs.cmc → EOQ/reposição):
// as invariantes finas aqui são (a) divergência com comparação ESTRITA fiel ao comportamento
// N+1 (existing.estoque !== saldo, null incluso), (b) ambíguo degrada para null e NÃO escreve
// estoque/custo no produto errado (precisão > recall), (c) update de custo com payload MÍNIMO
// (não sobrescreve cost_price/cost_source/cost_confidence — proveniência é do computeCosts).
import type { PosicaoEstoque } from "../_shared/pos-estoque.ts";
import {
  chunked,
  particionarCustos,
  planejarEscritaInventario,
} from "./inventory-lote.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const NOW = "2026-07-16T12:00:00.000Z";

// ════════ chunked ════════

Deno.test("chunked — particiona com resto", () => {
  assertEquals(chunked([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
});

Deno.test("chunked — vazio → sem chunks", () => {
  assertEquals(chunked([], 3), []);
});

// ════════ planejarEscritaInventario — divergência + rows por tabela ════════

function posicoesBase(): Map<number, PosicaoEstoque> {
  const pos = new Map<number, PosicaoEstoque>();
  pos.set(10, { saldo: 5, cmc: 2, precoMedio: 3 }); // local igual (estoque 5)
  pos.set(20, { saldo: 1, cmc: 0, precoMedio: 1 }); // local divergente (estoque 7); cmc 0
  pos.set(30, { saldo: 9, cmc: 4, precoMedio: 4 }); // sem linha local
  return pos;
}

const LOCAIS_BASE = [
  { id: "a", omie_codigo_produto: 10, estoque: 5, codigo: "SKU-A", descricao: "Produto A" },
  { id: "b", omie_codigo_produto: 20, estoque: 7, codigo: "SKU-B", descricao: "Produto B" },
];

Deno.test("planejar — divergência conta APENAS produto local com estoque !== saldo", () => {
  const plano = planejarEscritaInventario(posicoesBase(), LOCAIS_BASE, "oben", NOW);
  assertEquals(plano.divergences, 1); // só o cod 20 (7 !== 1); cod 30 sem linha NÃO conta
});

Deno.test("planejar — invRows cobre TODOS os códigos; sem linha local → product_id null", () => {
  const plano = planejarEscritaInventario(posicoesBase(), LOCAIS_BASE, "oben", NOW);
  assertEquals(plano.invRows, [
    { omie_codigo_produto: 10, product_id: "a", saldo: 5, cmc: 2, preco_medio: 3, account: "oben", synced_at: NOW },
    { omie_codigo_produto: 20, product_id: "b", saldo: 1, cmc: 0, preco_medio: 1, account: "oben", synced_at: NOW },
    { omie_codigo_produto: 30, product_id: null, saldo: 9, cmc: 4, preco_medio: 4, account: "oben", synced_at: NOW },
  ]);
});

Deno.test("planejar — stockRows só para produto local resolvido (espelha estoque mesmo sem divergência)", () => {
  const plano = planejarEscritaInventario(posicoesBase(), LOCAIS_BASE, "oben", NOW);
  // O N+1 atualizava omie_products.estoque INCONDICIONALMENTE quando a linha existia — preservado.
  // Shape do hotfix pós-prod (23502): o upsert de estoque conflita por (omie_codigo_produto,
  // account) — o payload TEM de carregar as colunas NOT NULL sem default (codigo, descricao)
  // lidas do próprio resolve, senão a tupla proposta do INSERT..ON CONFLICT viola NOT NULL
  // ANTES de o conflito ser arbitrado (foi o que derrubou os 2 chunks no ciclo 18:15 UTC).
  // Upsert pela PK id com payload completo seria pior: conflito DUPLO (PK + uniq) → 23505.
  assertEquals(plano.stockRows, [
    { omie_codigo_produto: 10, account: "oben", codigo: "SKU-A", descricao: "Produto A", estoque: 5, updated_at: NOW },
    { omie_codigo_produto: 20, account: "oben", codigo: "SKU-B", descricao: "Produto B", estoque: 1, updated_at: NOW },
  ]);
});

Deno.test("planejar — linha local sem codigo/descricao NÃO entra em stockRows (nunca propõe NULL em NOT NULL)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  pos.set(10, { saldo: 5, cmc: 2, precoMedio: 3 });
  const plano = planejarEscritaInventario(
    pos,
    [{ id: "a", omie_codigo_produto: 10, estoque: 5, codigo: null, descricao: "Produto A" }],
    "oben",
    NOW,
  );
  // Impossível pelo schema (NOT NULL), mas se o resolve devolver null: pular o item preserva
  // posição/custos e não derruba o chunk de estoque — nunca fabricar ""/placeholder.
  assertEquals(plano.stockRows, []);
  assertEquals(plano.invRows.length, 1);
  assertEquals(plano.custoCandidatos, [{ product_id: "a", cmc: 2 }]);
});

Deno.test("planejar — custoCandidatos exige product_id resolvido E cmc > 0 (nunca custo fabricado)", () => {
  const plano = planejarEscritaInventario(posicoesBase(), LOCAIS_BASE, "oben", NOW);
  assertEquals(plano.custoCandidatos, [{ product_id: "a", cmc: 2 }]); // 20 tem cmc 0; 30 não resolve
});

Deno.test("planejar — estoque local null vs saldo 0 DIVERGE (comparação estrita, fiel ao N+1)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  pos.set(10, { saldo: 0, cmc: 0, precoMedio: 0 });
  const plano = planejarEscritaInventario(pos, [{ id: "a", omie_codigo_produto: 10, estoque: null }], "oben", NOW);
  assertEquals(plano.divergences, 1); // null !== 0 — nada de coerção Number(null)===0
});

Deno.test("planejar — código AMBÍGUO (2 ids distintos) degrada: posição com product_id null, sem stock/custo, sem divergência", () => {
  const pos = new Map<number, PosicaoEstoque>();
  pos.set(10, { saldo: 5, cmc: 2, precoMedio: 3 });
  const plano = planejarEscritaInventario(
    pos,
    [
      { id: "a1", omie_codigo_produto: 10, estoque: 5 },
      { id: "a2", omie_codigo_produto: 10, estoque: 8 },
    ],
    "oben",
    NOW,
  );
  // Fiel ao N+1: maybeSingle com 2 linhas → erro PGRST116 → existing null (nem divergência,
  // nem estoque, nem custo). Precisão > recall: não escolhe uma das linhas p/ escrever.
  assertEquals(plano.invRows, [
    { omie_codigo_produto: 10, product_id: null, saldo: 5, cmc: 2, preco_medio: 3, account: "oben", synced_at: NOW },
  ]);
  assertEquals(plano.stockRows, []);
  assertEquals(plano.custoCandidatos, []);
  assertEquals(plano.divergences, 0);
});

// ════════ particionarCustos — update mínimo × insert completo ════════

Deno.test("particionar — existente vira UPDATE de payload MÍNIMO (cmc+updated_at; proveniência intocada)", () => {
  const r = particionarCustos(
    [{ product_id: "a", cmc: 2 }, { product_id: "b", cmc: 3 }],
    new Set(["a"]),
    NOW,
  );
  // Payload mínimo: upsert onConflict product_id que NÃO carrega cost_price/cost_source/
  // cost_confidence — sobrescrevê-los promoveria proveniência, autoridade do computeCosts.
  assertEquals(r.atualizar, [{ product_id: "a", cmc: 2, updated_at: NOW }]);
  assertEquals(Object.keys(r.atualizar[0]).includes("cost_price"), false);
});

Deno.test("particionar — novo vira INSERT completo (cost_price=cmc, source CMC, confidence 0.7)", () => {
  const r = particionarCustos([{ product_id: "b", cmc: 3 }], new Set(["a"]), NOW);
  assertEquals(r.inserir, [
    { product_id: "b", cost_price: 3, cmc: 3, cost_source: "CMC", cost_confidence: 0.7 },
  ]);
});
