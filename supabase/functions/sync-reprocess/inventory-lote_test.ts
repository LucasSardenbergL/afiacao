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
import {
  acumularPosicoesDaPagina,
  avaliarPagina,
  chunked,
  particionarCustos,
  planejarEscritaInventario,
  proximoTotalPaginas,
  validarTotalPaginas,
  type PosicaoEstoque,
} from "./inventory-lote.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const NOW = "2026-07-16T12:00:00.000Z";

// ════════ acumularPosicoesDaPagina — normalização do ListarPosEstoque ════════

Deno.test("acumular — posição válida entra normalizada; retorna quantos válidos", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 10, nSaldo: 5, nCMC: 2.5, nPrecoMedio: 3 },
  ]);
  assertEquals(n, 1);
  assertEquals(pos.get(10), { saldo: 5, cmc: 2.5, precoMedio: 3 });
});

Deno.test("acumular — nCodProd string numérica normaliza para chave number", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: "77", nSaldo: 1, nCMC: 1, nPrecoMedio: 1 }]);
  assertEquals(pos.has(77), true);
  assertEquals(pos.size, 1);
});

Deno.test("acumular — código inválido (0/negativo/fracional/não-numérico/ausente) é descartado", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 0, nSaldo: 1 },
    { nCodProd: -2, nSaldo: 1 },
    { nCodProd: 1.5, nSaldo: 1 },
    { nCodProd: "abc", nSaldo: 1 },
    { nSaldo: 1 },
  ]);
  assertEquals(n, 0);
  assertEquals(pos.size, 0); // Number(undefined)=NaN / Number("")=0 nunca viram entrada
});

// ⚠️ Fabricação CONSCIENTE (não é violação do "ausente ≠ zero"): o N+1 atual já faz
// nSaldo/nCMC/nPrecoMedio `?? 0` — no ListarPosEstoque a posição VEIO na resposta; campo
// ausente = posição zerada no Omie, não "dado indisponível". O gate money-path real está
// adiante: cmc<=0 NÃO vira candidato a product_costs (nunca fabrica custo zero).
Deno.test("acumular — campos ausentes viram 0 (comportamento preservado do N+1, deliberado)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: 5 }]);
  assertEquals(pos.get(5), { saldo: 0, cmc: 0, precoMedio: 0 });
});

Deno.test("acumular — mesmo código em páginas sucessivas: last-wins (dedupe p/ upsert em lote)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: 9, nSaldo: 1, nCMC: 1, nPrecoMedio: 1 }]);
  acumularPosicoesDaPagina(pos, [{ nCodProd: 9, nSaldo: 4, nCMC: 2, nPrecoMedio: 2 }]);
  assertEquals(pos.get(9), { saldo: 4, cmc: 2, precoMedio: 2 });
  assertEquals(pos.size, 1); // duplicata no MESMO statement de upsert quebraria (21000)
});

// Drift de contrato (Codex P2): um único valor não-numérico (NaN/±Inf/lixo) derrubaria o
// chunk INTEIRO de 500 no Postgres; no N+1 o dano era restrito àquele produto. Descarta o
// ITEM (fiel em efeito: produto não atualizado neste ciclo), nunca fabrica 0 de lixo.
Deno.test("acumular — nSaldo/nCMC/nPrecoMedio não-finito descarta o ITEM, não o lote", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 1, nSaldo: Number.NaN },
    { nCodProd: 2, nCMC: Number.POSITIVE_INFINITY },
    { nCodProd: 3, nSaldo: "lixo" as unknown as number },
    { nCodProd: 4, nSaldo: "5.5" as unknown as number }, // string numérica coage normal
  ]);
  assertEquals(n, 1);
  assertEquals(pos.has(1), false);
  assertEquals(pos.has(2), false);
  assertEquals(pos.has(3), false);
  assertEquals(pos.get(4), { saldo: 5.5, cmc: 0, precoMedio: 0 });
});

// ════════ validarTotalPaginas — teto fail-FAST (Codex P1: falhar na página 501 é tarde) ════════
// nTotPaginas=100000 na página 1 faria 500 chamadas Omie (~90s+) antes do guard antigo
// disparar — reproduzindo o próprio 546. O teto tem de rejeitar a DECLARAÇÃO, não a página.

Deno.test("validarTotalPaginas — declarado dentro do teto passa", () => {
  assertEquals(validarTotalPaginas(9, 500), 9);
  assertEquals(validarTotalPaginas(500, 500), 500);
});

Deno.test("validarTotalPaginas — ausente/0/negativo/fracional/NaN degrada para 1 (fiel ao `|| 1`)", () => {
  assertEquals(validarTotalPaginas(undefined, 500), 1);
  assertEquals(validarTotalPaginas(0, 500), 1);
  assertEquals(validarTotalPaginas(-5, 500), 1);
  assertEquals(validarTotalPaginas(3.7, 500), 1);
  assertEquals(validarTotalPaginas(Number.NaN, 500), 1);
});

Deno.test("validarTotalPaginas — acima do teto LANÇA imediatamente (fail-fast anti-runaway)", () => {
  let lancou = false;
  try {
    validarTotalPaginas(100000, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

Deno.test("validarTotalPaginas — string numérica do Omie coage antes de validar", () => {
  assertEquals(validarTotalPaginas("9" as unknown as number, 500), 9);
  let lancou = false;
  try {
    validarTotalPaginas("100000" as unknown as number, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

// ════════ proximoTotalPaginas — piso MONOTÔNICO entre respostas (Codex P1 do #1353) ════════
// O total declarado é PISO da run inteira, não só de cada resposta: uma página intermediária
// SEM total_de_paginas (degrada p/ 1) encolhia o teto e o loop completava retrato PARCIAL
// como 'complete' (ex.: p1 declara 5, p2 vem sem total → run terminava em 2/5 páginas).
// O maior total já declarado vence — declaração nova só pode MANTER ou CRESCER o teto.

Deno.test("proximoTotalPaginas — declaração maior cresce o teto", () => {
  assertEquals(proximoTotalPaginas(1, 5, 500), 5);
  assertEquals(proximoTotalPaginas(5, 9, 500), 9);
});

Deno.test("proximoTotalPaginas — declaração ausente/lixo NÃO encolhe o teto já declarado", () => {
  assertEquals(proximoTotalPaginas(5, undefined, 500), 5); // degradaria p/ 1 sem o piso
  assertEquals(proximoTotalPaginas(5, 0, 500), 5);
  assertEquals(proximoTotalPaginas(5, 3, 500), 5); // declaração MENOR também não encolhe
});

Deno.test("proximoTotalPaginas — acima do teto anti-runaway LANÇA (herda o fail-fast)", () => {
  let lancou = false;
  try {
    proximoTotalPaginas(5, 100000, 500);
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
});

// ════════ avaliarPagina — guard de paginação (nTotPaginas é PISO, não verdade) ════════

Deno.test("página com itens → processar", () => {
  assertEquals(avaliarPagina(10, 1, 5), "processar");
});

Deno.test("página vazia ANTES do fim declarado → anomalia (fail-closed, não completa parcial)", () => {
  // Lição omie-sync-status-produtos: fault transiente/rate-limit vira 'página vazia' se o
  // caller não tratar — completar aqui deixaria a cauda stale com status 'complete' mentindo.
  assertEquals(avaliarPagina(0, 3, 5), "anomalia");
});

Deno.test("página vazia NA última declarada → fim (inofensivo, nada a processar)", () => {
  assertEquals(avaliarPagina(0, 5, 5), "fim");
});

Deno.test("catálogo vazio (1/1 vazia) → fim", () => {
  assertEquals(avaliarPagina(0, 1, 1), "fim");
});

Deno.test("página vazia ALÉM do declarado → fim (semântica segura p/ loop futuro)", () => {
  assertEquals(avaliarPagina(0, 6, 5), "fim");
});

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
