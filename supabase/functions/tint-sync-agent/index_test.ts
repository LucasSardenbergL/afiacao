// index_test.ts — o HANDLER de `/catalogs` e `/keys-snapshot`, EXECUTADO com o PostgREST simulado.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/tint-sync-agent/
//
// Por que existe (2ª opinião do Codex no lote 6 do scanner, 2026-11-17): o builder é provado em
// `catalogo-staging_test.ts`, mas quem decide o que o CONECTOR recebe é o index.ts. O teste de forma
// (vitest, lê a edge como texto) deixava passar `if (montado.recusados > 0)` trocado por `< 0`: item
// recusado, resposta 200 com `error_count: 0`, e o conector confirmava o lote. Texto não vê isso.
// Aqui o request entra pelo handler de verdade e o que se confere é a RESPOSTA e as ESCRITAS.
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";

const TOKEN = "token-de-teste-da-loja";
const URL_DA_EDGE = "https://ref-de-teste.supabase.co/functions/v1/tint-sync-agent";

const h = instalarHarness({ ...ENV_TESTE, SUPABASE_ANON_KEY: "anon-de-teste" });
// Import COMPUTADO de propósito (ver harness-handler_test.ts): o type-check do index.ts é do
// gate `edges:typecheck`; em runtime o módulo carrega igual.
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

interface Escrita {
  metodo: string;
  tabela: string;
  corpo: unknown;
  colunas: string | null;
}
let escritas: Escrita[] = [];
let falharRegistroDeErro = false;

function json(corpo: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...headers } });
}

// PostgREST simulado: devolve a loja para o token, um id de run, e guarda TODA escrita que chega.
h.responderForaDoGate(async (r) => {
  const url = new URL(r.url);
  const tabela = url.pathname.replace("/rest/v1/", "");
  if (r.method === "GET" && tabela === "tint_integration_settings") {
    return json({
      id: "setting-de-teste",
      account: "oben",
      store_code: "M01",
      sync_enabled: true,
      integration_mode: "automatic_primary",
      sync_token: TOKEN,
    });
  }
  if (r.method === "HEAD" && tabela === "tint_keys_snapshots") {
    // 1ª contagem: chunks recebidos do snapshot (1 de 1). 2ª: linhas ainda sem estado (0).
    const semEstado = url.search.includes("aplicacao_status=is.null");
    return new Response(null, { status: 200, headers: { "content-range": semEstado ? "*/0" : "0-0/1" } });
  }
  if (r.method === "POST" || r.method === "PATCH") {
    const corpo = await r.clone().json().catch(() => null);
    escritas.push({ metodo: r.method, tabela, corpo, colunas: url.searchParams.get("columns") });
    if (tabela === "tint_sync_errors" && falharRegistroDeErro) {
      return json({ code: "XX000", message: "falha simulada do registro" }, 500);
    }
    if (r.method === "POST" && tabela === "tint_sync_runs") return json({ id: "run-de-teste" }, 201);
    if (r.method === "PATCH" && tabela === "tint_sync_runs") return json([{ id: "run-de-teste" }], 200);
    return new Response(null, { status: r.method === "POST" ? 201 : 204 });
  }
  return json({ message: `request não simulado: ${r.method} ${tabela}` }, 500);
});

async function chamar(
  rota: string,
  corpo: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  escritas = [];
  const resp = await handler(
    new Request(`${URL_DA_EDGE}/${rota}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-token": TOKEN, "x-store-code": "M01", ...headers },
      body: JSON.stringify(corpo),
    }),
  );
  return { status: resp.status, corpo: await resp.json() };
}

const tabelasEscritas = () => escritas.map((e) => `${e.metodo} ${e.tabela}`);
const linhasDe = (tabela: string) =>
  escritas.filter((e) => e.metodo === "POST" && e.tabela === tabela).flatMap((e) => e.corpo as Record<string, unknown>[]);

/** As cinco colunas que o servidor põe em toda linha de staging do catálogo. */
const DO_SERVIDOR = { sync_run_id: "run-de-teste", account: "oben", store_code: "M01", staging_status: "pending" };

Deno.test("/catalogs — lote honesto: 200 sem erro, e as linhas que o conector sempre gravou", async () => {
  const r = await chamar("catalogs", {
    produtos: [{ cod_produto: "FO10.6554", descricao: "POLIURETANO FOSCO" }],
    corantes: [{ id_corante_sayersystem: "AX", descricao: "AMARELO OXIDO", volume_ml: 1000 }],
  });
  igual(r.status, 200, "status");
  igual(
    [r.corpo.ok, r.corpo.sync_run_id, r.corpo.received_count, r.corpo.inserted_count, r.corpo.error_count, r.corpo.errors],
    [true, "run-de-teste", 2, 2, 0, []],
    "resposta que o conector confirma",
  );
  igual(
    tabelasEscritas(),
    ["POST tint_sync_runs", "POST tint_staging_produtos", "POST tint_staging_corantes", "PATCH tint_sync_runs"],
    "escritas, na ordem — nenhuma a mais",
  );
  igual(linhasDe("tint_staging_produtos").map(ordenar), [ordenar({
    ...DO_SERVIDOR,
    raw_data: { cod_produto: "FO10.6554", descricao: "POLIURETANO FOSCO" },
    cod_produto: "FO10.6554",
    descricao: "POLIURETANO FOSCO",
  })], "linha de produto");
  igual(linhasDe("tint_staging_corantes").map(ordenar), [ordenar({
    ...DO_SERVIDOR,
    raw_data: { id_corante_sayersystem: "AX", descricao: "AMARELO OXIDO", volume_ml: 1000 },
    id_corante_sayersystem: "AX",
    descricao: "AMARELO OXIDO",
    volume_ml: 1000,
  })], "linha de corante");
  igual(escritas.filter((e) => e.tabela === "tint_sync_errors").length, 0, "lote honesto não registra erro");
});

/** Chaves em ordem: a comparação é de conteúdo. */
function ordenar(l: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(l).sort()) o[k] = l[k];
  return o;
}

Deno.test("/catalogs — O FURO: item com created_at é recusado, CONTA COMO ERRO na resposta e não vira linha", async () => {
  const r = await chamar("catalogs", {
    corantes: [
      { id_corante_sayersystem: "AX", custo: 0.01, volume_ml: 1000, created_at: "2099-01-01T00:00:00Z" },
      { id_corante_sayersystem: "VM", descricao: "VERMELHO", volume_ml: 1000 },
    ],
  });
  igual(r.status, 200, "status");
  // É por estes três campos que o conector decide confirmar o lote (ok && error_count == 0 && errors vazio).
  igual([r.corpo.ok, r.corpo.error_count, r.corpo.received_count, r.corpo.inserted_count], [true, 1, 2, 1], "contadores");
  igual(r.corpo.errors, [{
    entity_type: "corantes",
    entity_id: null,
    message: "1 item(ns) recusado(s): campo fora do contrato do catálogo (created_at)",
  }], "errors[] nomeia a entidade e o campo");

  const corantes = linhasDe("tint_staging_corantes");
  igual(corantes.map((l) => l.id_corante_sayersystem), ["VM"], "só o item honesto vira linha");
  for (const e of escritas.filter((x) => x.tabela.startsWith("tint_staging_"))) {
    if ((e.colunas ?? "").includes("created_at") || JSON.stringify(e.corpo).includes("2099")) {
      throw new Error(`created_at forjado chegou ao staging: columns=${e.colunas} corpo=${JSON.stringify(e.corpo)}`);
    }
  }

  const registro = escritas.filter((e) => e.tabela === "tint_sync_errors");
  igual(registro.length, 1, "uma linha em tint_sync_errors");
  const reg = registro[0].corpo as Record<string, unknown>;
  igual(
    [reg.sync_run_id, reg.entity_type, reg.entity_id, reg.raw_data, reg.error_message],
    ["run-de-teste", "corantes", null, null, "1 item(ns) recusado(s): campo fora do contrato do catálogo (created_at)"],
    "o registro da recusa",
  );
  igual((reg.error_details as Record<string, unknown>).campos_fora, ["created_at"], "detalhe com o nome do campo");
  if (JSON.stringify(reg).includes("2099") || JSON.stringify(reg).includes("0.01")) {
    throw new Error("o VALOR do item recusado foi para o registro");
  }
});

Deno.test("/catalogs — lote todo recusado: erro por item, nenhuma linha de staging", async () => {
  const r = await chamar("catalogs", {
    produtos: [{ cod_produto: "A", id: "11111111-1111-1111-1111-111111111111" }, { cod_produto: "B", matched_id: "x" }],
  });
  igual([r.status, r.corpo.error_count, r.corpo.inserted_count, r.corpo.received_count], [200, 2, 0, 2], "contadores");
  igual(linhasDe("tint_staging_produtos"), [], "nada no staging");
  igual(
    tabelasEscritas(),
    ["POST tint_sync_runs", "POST tint_sync_errors", "PATCH tint_sync_runs"],
    "run, registro da recusa e fecho — nenhum insert de staging",
  );
});

Deno.test("/catalogs — conta, loja e run vêm do SERVIDOR, mesmo com os nomes no corpo", async () => {
  const r = await chamar("catalogs", {
    account: "outra-conta",
    store_code: "X99",
    sync_run_id: "run-forjado",
    produtos: [{ cod_produto: "A", descricao: "produto" }],
  });
  igual([r.status, r.corpo.error_count], [200, 0], "aceito");
  const [linha] = linhasDe("tint_staging_produtos");
  igual([linha.account, linha.store_code, linha.sync_run_id], ["oben", "M01", "run-de-teste"], "contexto da linha");
  const run = escritas.find((e) => e.metodo === "POST" && e.tabela === "tint_sync_runs")!.corpo as Record<string, unknown>;
  igual([run.account, run.store_code, run.setting_id], ["oben", "M01", "setting-de-teste"], "contexto do run");
});

Deno.test("/catalogs — um produto: os escritores são EXATAMENTE run, staging e fecho", async () => {
  await chamar("catalogs", { produtos: [{ cod_produto: "A" }] });
  igual(tabelasEscritas(), ["POST tint_sync_runs", "POST tint_staging_produtos", "PATCH tint_sync_runs"], "escritas");
  igual(escritas[1].colunas?.split(",").map((c) => c.replace(/"/g, "")).sort(), [
    "account", "cod_produto", "raw_data", "staging_status", "store_code", "sync_run_id",
  ], "columns= do insert: só servidor + catálogo");
});

Deno.test("/catalogs — entidade que não é lista: 400 e ZERO escrita, sozinha no lote ou ao lado de outra", async () => {
  const sozinha = await chamar("catalogs", { corantes: { id_corante_sayersystem: "AX" } });
  igual([sozinha.status, sozinha.corpo], [400, { ok: false, error: "corantes: must be an array" }], "sozinha");
  igual(escritas, [], "sozinha: nada gravado");

  const acompanhada = await chamar("catalogs", { produtos: [{ cod_produto: "A" }], skus: "texto" });
  igual([acompanhada.status, acompanhada.corpo], [400, { ok: false, error: "skus: must be an array" }], "acompanhada");
  igual(escritas, [], "acompanhada: nada gravado, nem o produto válido");

  const lista = await chamar("catalogs", [{ produtos: [] }]);
  igual([lista.status, lista.corpo], [400, { ok: false, error: "body must be a JSON object" }], "corpo que é lista");
  igual(escritas, [], "corpo que é lista: nada gravado");
});

Deno.test("/catalogs — lote só com entidade que a rota não grava: mesmo ack de antes, sem run", async () => {
  const r = await chamar("catalogs", { padracores: [{ id: 1 }], colecoes: [{ id: 2 }] });
  igual([r.status, r.corpo.ok, r.corpo.sync_run_id, r.corpo.error_count, r.corpo.errors], [200, true, null, 0, []], "ack sem run");
  igual(escritas, [], "nada gravado");
  const nulo = await chamar("catalogs", { produtos: null });
  igual([nulo.status, nulo.corpo.ok, nulo.corpo.sync_run_id], [200, true, null], "null é ausência da entidade");
});

Deno.test("/catalogs — precos_base segue campo a campo", async () => {
  const r = await chamar("catalogs", {
    precos_base: [{ cod_produto: "A", id_base: "B", id_embalagem: "E", custo: 10, imposto_pct: 2, margem_pct: 3, created_at: "2099-01-01" }],
  });
  igual([r.status, r.corpo.error_count, r.corpo.inserted_count], [200, 0, 1], "aceito");
  const [linha] = linhasDe("tint_staging_precos_base");
  igual(Object.keys(linha).sort(), [
    "account", "cod_produto", "custo", "id_base", "id_embalagem", "imposto_pct", "margem_pct", "raw_data",
    "staging_status", "store_code", "sync_run_id",
  ], "colunas da linha de precos_base: created_at do item não entra");
});

Deno.test("/catalogs — registro da recusa falhou: a recusa segue na resposta e o console avisa", async () => {
  const avisos: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { avisos.push(args.map(String).join(" ")); };
  falharRegistroDeErro = true;
  try {
    const r = await chamar("catalogs", { bases: [{ id_base_sayersystem: "BS", created_at: "2099-01-01" }] });
    igual([r.status, r.corpo.error_count, (r.corpo.errors as unknown[]).length], [200, 1, 1], "a recusa não depende do registro");
    igual(
      avisos.filter((a) => a.includes("recusa de catálogo (bases) não registrada em tint_sync_errors")).length,
      1,
      `um aviso no console (vieram: ${JSON.stringify(avisos)})`,
    );
  } finally {
    falharRegistroDeErro = false;
    console.error = original;
  }
});

Deno.test("/catalogs — token errado: 401 e nenhuma escrita", async () => {
  const r = await chamar("catalogs", { produtos: [{ cod_produto: "A" }] }, { "x-sync-token": "outro-token" });
  igual([r.status, r.corpo], [401, { ok: false, error: "Invalid token or store" }], "401");
  igual(escritas, [], "nada gravado");
});

/** RFC 3339 com segundo cheio, como o conector manda (`time.RFC3339`). */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
const SNAPSHOT = { entity: "formulas", snapshot_id: "22222222-2222-2222-2222-222222222222", total_chunks: 1, chunk_index: 0, keys: ["a|b|c"] };

Deno.test("/keys-snapshot — O FURO: generated_at no futuro é 400 e não grava nada", async () => {
  for (const futuro of ["2099-01-01T00:00:00Z", rfc3339(Date.now() + 2 * 24 * 3600_000), rfc3339(Date.now() + 11 * 60_000)]) {
    const r = await chamar("keys-snapshot", { ...SNAPSHOT, generated_at: futuro });
    igual([r.status, r.corpo], [400, { ok: false, error: "generated_at is in the future" }], futuro);
    igual(escritas, [], `${futuro}: nada gravado`);
  }
});

Deno.test("/keys-snapshot — o que o Postgres leria como data e não é RFC 3339 com fuso: 400, nada gravado", async () => {
  for (const torto of ["infinity", "now", "2026-11-17 03:03:41", 4070908800000]) {
    const r = await chamar("keys-snapshot", { ...SNAPSHOT, generated_at: torto });
    igual([r.status, r.corpo.ok], [400, false], JSON.stringify(torto));
    igual(escritas, [], `${JSON.stringify(torto)}: nada gravado`);
  }
  const ausente = await chamar("keys-snapshot", { ...SNAPSHOT });
  igual([ausente.status, ausente.corpo], [400, { ok: false, error: "generated_at required" }], "ausente");
});

Deno.test("/keys-snapshot — snapshot honesto (4 min atrás, como na PROD): grava o MESMO texto e enfileira", async () => {
  const geradoEm = rfc3339(Date.now() - 4 * 60_000);
  const r = await chamar("keys-snapshot", { ...SNAPSHOT, generated_at: geradoEm });
  igual([r.status, r.corpo], [200, { ok: true, complete: true, applied: false, aplicacao: "pendente" }], "resposta");
  igual(tabelasEscritas(), ["POST tint_keys_snapshots", "PATCH tint_keys_snapshots"], "escritas");
  const linha = escritas[0].corpo as Record<string, unknown>;
  igual(
    [linha.generated_at, linha.account, linha.store_code, linha.setting_id, linha.snapshot_id, linha.keys],
    [geradoEm, "oben", "M01", "setting-de-teste", SNAPSHOT.snapshot_id, ["a|b|c"]],
    "linha do snapshot: o generated_at é o texto recebido",
  );
  // adiantado DENTRO da tolerância (relógio da loja 5 min à frente) também passa
  const adiantado = await chamar("keys-snapshot", { ...SNAPSHOT, generated_at: rfc3339(Date.now() + 5 * 60_000) });
  igual(adiantado.status, 200, "5 min adiantado passa");
});
