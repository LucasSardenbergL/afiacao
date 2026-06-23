// Testa o CÓDIGO REAL de pagination.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-vendas-sync/pagination_test.ts
//
// Cobre a discriminação money-path do spec (defeito #1: null ambíguo): a página do
// loop de sync_pedidos deve distinguir FIM REAL (null/vazio → completa) de TRANSITÓRIO
// (throw → pausa, não completa), e converter as datas do cursor sem ambiguidade.
import { omieDateToIso, classifyOmieTransient, classifyPedidosPage, gerarJanelasMensais } from "./pagination.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ── omieDateToIso: DD/MM/YYYY (Omie) → ISO (PK date do cursor) ──
Deno.test("omieDateToIso: converte DD/MM/YYYY → YYYY-MM-DD", () => {
  assertEquals(omieDateToIso("17/06/2026"), "2026-06-17");
  assertEquals(omieDateToIso("01/01/2025"), "2025-01-01");
  assertEquals(omieDateToIso("31/12/2024"), "2024-12-31");
});

// ── gerarJanelasMensais: janelas mensais p/ a sonda de counts (Fase 2b colacor) ──
Deno.test("gerarJanelasMensais: meses inclusive, DD/MM/YYYY, último dia certo (bissexto)", () => {
  const j = gerarJanelasMensais("2024-01-15", "2024-03-01");
  assertEquals(j.map((x) => x.mes), ["2024-01", "2024-02", "2024-03"]);
  assertEquals(j[0], { mes: "2024-01", de: "01/01/2024", ate: "31/01/2024" });
  assertEquals(j[1].ate, "29/02/2024", "fev 2024 bissexto");
  assertEquals(j[2], { mes: "2024-03", de: "01/03/2024", ate: "31/03/2024" });
});

Deno.test("gerarJanelasMensais: vira o ano + fev não-bissexto", () => {
  const j = gerarJanelasMensais("2024-11-01", "2025-02-28");
  assertEquals(j.map((x) => x.mes), ["2024-11", "2024-12", "2025-01", "2025-02"]);
  assertEquals(j[3].ate, "28/02/2025", "fev 2025 não-bissexto");
});

Deno.test("gerarJanelasMensais: janela invertida → vazio (guard)", () => {
  assertEquals(gerarJanelasMensais("2025-06-01", "2024-01-01"), []);
});

Deno.test("omieDateToIso: tolera espaços nas bordas", () => {
  assertEquals(omieDateToIso("  05/03/2025  "), "2025-03-05");
});

Deno.test("omieDateToIso: formato inválido → null (caller rejeita a invocação)", () => {
  assertEquals(omieDateToIso("2026-06-17"), null);   // já-ISO não casa
  assertEquals(omieDateToIso("17/6/2026"), null);    // sem zero à esquerda
  assertEquals(omieDateToIso("xx/yy/zzzz"), null);
  assertEquals(omieDateToIso(""), null);
});

Deno.test("omieDateToIso: data de calendário IMPOSSÍVEL → null (Codex: guard de borda)", () => {
  assertEquals(omieDateToIso("31/02/2025"), null);   // fev não tem 31
  assertEquals(omieDateToIso("00/01/2025"), null);   // dia 0
  assertEquals(omieDateToIso("01/13/2025"), null);   // mês 13
  assertEquals(omieDateToIso("31/04/2025"), null);   // abr não tem 31
  assertEquals(omieDateToIso("29/02/2024"), "2024-02-29"); // bissexto válido
});

// ── classifyOmieTransient: tipo do transitório p/ o last_error_kind ──
Deno.test("classifyOmieTransient: rate-limit vs transitório genérico", () => {
  // mensagens EXATAS que callOmieVendasApi emite no throw OMIE_TRANSIENT
  assertEquals(classifyOmieTransient("OMIE_TRANSIENT (oben): rate limit persistiu após 3 tentativas — não dá pra afirmar ausência"), "rate_limit");
  assertEquals(classifyOmieTransient("OMIE_TRANSIENT (colacor): erro transitório persistiu após 3 tentativas — não dá pra afirmar ausência"), "transient");
});

// ── classifyPedidosPage: a decisão de completude (3 vias) ──
Deno.test("classifyPedidosPage: null = fim real (Não existem registros)", () => {
  assertEquals(classifyPedidosPage(null, 3), "end");
});

Deno.test("classifyPedidosPage: página com pedidos = data (processa)", () => {
  assertEquals(classifyPedidosPage({ pedido_venda_produto: [{ cabecalho: { codigo_pedido: 1 } }] }, 1), "data");
  // total_de_paginas NÃO decide fim: com dados, é 'data' mesmo com total=1
  assertEquals(classifyPedidosPage({ total_de_paginas: 1, pedido_venda_produto: [{ x: 1 }, { x: 2 }] }, 1), "data");
});

Deno.test("classifyPedidosPage: vazia coerente com total = fim", () => {
  // vazia sem total → fim
  assertEquals(classifyPedidosPage({ pedido_venda_produto: [] }, 5), "end");
  assertEquals(classifyPedidosPage({}, 9), "end");
  // vazia E pagina >= total (passou do fim) → fim legítimo
  assertEquals(classifyPedidosPage({ total_de_paginas: 5, pedido_venda_produto: [] }, 5), "end");
  assertEquals(classifyPedidosPage({ total_de_paginas: 5, pedido_venda_produto: [] }, 6), "end");
});

// #6 (Codex): vazia CONTRADIZENDO total → anomalia → PAUSA, nunca falsa-completude
Deno.test("classifyPedidosPage: vazia no MEIO (pagina < total) = anomaly (não completa)", () => {
  assertEquals(classifyPedidosPage({ total_de_paginas: 8, pedido_venda_produto: [] }, 5), "anomaly");
  assertEquals(classifyPedidosPage({ total_de_paginas: 2, pedido_venda_produto: [] }, 1), "anomaly");
});

// ── Cenário do spec §8: rate-limit (throw=pausa) vs página-vazia (null=fim) ──
Deno.test("cenário: o fim-real completa, mas o transitório NÃO (caminhos distintos)", () => {
  assertEquals(classifyPedidosPage(null, 4), "end");           // fim real → completa
  assertEquals(classifyPedidosPage({ pedido_venda_produto: [{ x: 1 }] }, 4), "data"); // dados → processa
  // o kind do transitório (que vem por throw, nunca por esta função) é classificado p/ o cursor
  assertEquals(classifyOmieTransient("OMIE_TRANSIENT (oben): rate limit ..."), "rate_limit");
});
