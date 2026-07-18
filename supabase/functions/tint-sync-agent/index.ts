import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token, x-store-code, x-idempotency-key",
};

// ─── Type definitions ───

/** Item bruto enviado pelo agente (catalogo: produtos, bases, embalagens, skus, corantes) */
interface TintCatalogItem {
  id?: string;
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  id_base_sayersystem?: string;
  id_embalagem_sayersystem?: string;
  id_corante_sayersystem?: string;
  descricao?: string;
  volume_ml?: number;
  preco_litro?: number;
  /** Custo do corante (de PRECO_CORANTE) */
  custo?: number;
  [k: string]: unknown;
}

/** Preço de base por embalagem (de PRECO_BASEEMB) */
interface TintPrecosBaseItem {
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  custo?: number;
  imposto_pct?: number;
  margem_pct?: number;
  [k: string]: unknown;
}

/** Item de fórmula (corante + ordem + qtd) */
interface TintFormulaItem {
  id_corante?: string;
  ordem?: number;
  qtd_ml?: number;
}

/** Fórmula bruta enviada pelo agente */
interface TintFormulaPayload {
  cor_id?: string;
  nome_cor?: string;
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  subcolecao?: string | null;
  volume_final_ml?: number;
  preco_final?: number;
  personalizada?: boolean;
  itens?: TintFormulaItem[];
}

/** Preparação (mistura de tinta concreta) bruta enviada pelo agente */
interface TintPreparacaoPayload {
  preparacao_id?: string;
  cor_id?: string;
  nome_cor?: string;
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  volume_ml?: number;
  preco?: number;
  cliente?: string;
  data_preparacao?: string;
  personalizada?: boolean;
  itens?: TintFormulaItem[];
}

/** Linha resultante do join tint_formulas + tint_produtos/bases/embalagens (modo simulate/real_data) */
interface TintFormulaJoinRow {
  cor_id: string;
  nome_cor: string | null;
  volume_final_ml: number | null;
  preco_final_sayersystem: number | null;
  produto_id: string;
  base_id: string;
  embalagem_id: string;
  tint_produtos?: { cod_produto?: string } | null;
  tint_bases?: { id_base_sayersystem?: string } | null;
  tint_embalagens?: { id_embalagem_sayersystem?: string } | null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Max items per batch per entity type */
const MAX_BATCH_ITEMS = 1000;
/** Max total payload size (5 MB) */
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop() || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  async function authorizeStaff(): Promise<{ ok: true } | { ok: false; resp: Response }> {
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
    if (!authHeader) return { ok: false, resp: json({ ok: false, error: "Unauthorized" }, 401) };
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return { ok: false, resp: json({ ok: false, error: "Unauthorized" }, 401) };
    const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", userData.user.id);
    const allowed = new Set(["employee", "master"]);
    if (!roles?.some((r: { role: string }) => allowed.has(r.role))) {
      return { ok: false, resp: json({ ok: false, error: "Forbidden" }, 403) };
    }
    return { ok: true };
  }

  const syncToken = req.headers.get("x-sync-token");
  const storeCode = req.headers.get("x-store-code");
  const idempotencyKey = req.headers.get("x-idempotency-key");

  // ─── helpers ───

  function timingSafeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ─── Change 1: validateAgent now returns integrationMode ───
  async function validateAgent(): Promise<{ settingId: string; account: string; storeCode: string; integrationMode: string } | null> {
    if (!syncToken || !storeCode) return null;
    const { data } = await sb.from("tint_integration_settings")
      .select("id, account, store_code, sync_enabled, integration_mode, sync_token")
      .eq("store_code", storeCode)
      .single();
    if (!data || !data.sync_enabled) return null;
    if (!data.sync_token || !timingSafeEq(String(data.sync_token), syncToken)) return null;
    return {
      settingId: data.id,
      account: data.account,
      storeCode: data.store_code,
      integrationMode: data.integration_mode as string,
    };
  }

  // ─── Change 2: checkIdempotency returns 409 for incomplete/running runs ───
  /** Check if a sync_run with this idempotency_key already exists. Returns its saved response or null. */
  async function checkIdempotency(agent: { settingId: string }, syncType: string): Promise<Response | null> {
    if (!idempotencyKey) return null;
    const { data } = await sb.from("tint_sync_runs")
      .select("id, status, total_records, inserts, updates, errors, idempotency_response")
      .eq("setting_id", agent.settingId)
      .eq("idempotency_key", idempotencyKey)
      .eq("sync_type", syncType)
      .maybeSingle();
    if (!data) return null;
    // Fix (S5/codex P1-3): if the previous attempt was incomplete (running), FAILED (error), or has
    // no stored response → 409 retry. An error run with a stored success response would otherwise
    // replay fake success and the connector would advance its high-water mark past the failed batch.
    if (data.status === "running" || data.status === "error" || data.idempotency_response == null) {
      return json({ ok: false, error: "previous attempt incomplete, retry later", retry: true }, 409);
    }
    // Return the stored response deterministically
    const stored = data.idempotency_response as Record<string, unknown>;
    return json({
      ok: true,
      sync_run_id: data.id,
      idempotent_replay: true,
      batch_id: idempotencyKey,
      received_count: data.total_records || 0,
      inserted_count: data.inserts || 0,
      updated_count: data.updates || 0,
      ignored_count: 0,
      error_count: data.errors || 0,
      errors: [],
      ...stored,
    });
  }

  async function createSyncRun(agent: { settingId: string; account: string; storeCode: string }, syncType: string) {
    const row: Record<string, unknown> = {
      setting_id: agent.settingId,
      account: agent.account,
      store_code: agent.storeCode,
      sync_type: syncType,
      source: "agent",
      status: "running",
    };
    if (idempotencyKey) row.idempotency_key = idempotencyKey;
    const { data } = await sb.from("tint_sync_runs").insert(row).select("id").single();
    return data?.id;
  }

  async function completeSyncRun(runId: string, stats: Record<string, number>, status = "complete", responseObj?: unknown) {
    const upd: Record<string, unknown> = {
      status,
      completed_at: new Date().toISOString(),
      duration_ms: stats.duration_ms || 0,
      total_records: stats.total || 0,
      inserts: stats.inserts || 0,
      updates: stats.updates || 0,
      errors: stats.errors || 0,
    };
    if (responseObj) upd.idempotency_response = responseObj;
    await sb.from("tint_sync_runs").update(upd).eq("id", runId);
  }

  async function logError(runId: string, entityType: string, entityId: string | null, msg: string, details?: unknown, raw?: unknown) {
    await sb.from("tint_sync_errors").insert({
      sync_run_id: runId,
      entity_type: entityType,
      entity_id: entityId,
      error_message: msg,
      error_details: details ? JSON.parse(JSON.stringify(details)) : null,
      raw_data: raw ? JSON.parse(JSON.stringify(raw)) : null,
    });
  }

  function buildResponse(runId: string, stats: { received: number; inserts: number; updates: number; ignored: number; errors: number; errorDetails: { entity_type: string; entity_id: string | null; message: string }[] }) {
    return {
      ok: true,
      sync_run_id: runId,
      batch_id: idempotencyKey || null,
      idempotent_replay: false,
      received_count: stats.received,
      inserted_count: stats.inserts,
      updated_count: stats.updates,
      ignored_count: stats.ignored,
      error_count: stats.errors,
      errors: stats.errorDetails.slice(0, 50), // cap at 50
    };
  }

  function validateBatchSize(body: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
      const arr = body[k];
      if (Array.isArray(arr) && arr.length > MAX_BATCH_ITEMS) {
        return `${k}: max ${MAX_BATCH_ITEMS} items per batch, received ${arr.length}`;
      }
    }
    return null;
  }

  /** Bulk insert helper: splits rows into chunks and inserts each chunk. */
  async function bulkInsert(
    table: string,
    rows: Record<string, unknown>[],
    chunkSize: number,
    onError: (chunk: Record<string, unknown>[], err: { message: string }) => void,
  ): Promise<{ insertedCount: number }> {
    let insertedCount = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await sb.from(table).insert(chunk);
      if (error) {
        onError(chunk, error);
      } else {
        insertedCount += chunk.length;
      }
    }
    return { insertedCount };
  }

  try {
    // ============ HEARTBEAT ============
    if (path === "heartbeat" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);
      const body = await req.json().catch(() => ({}));
      // Change 6: also persist schema_fingerprint and schema_mismatch
      await sb.from("tint_integration_settings").update({
        last_heartbeat_at: new Date().toISOString(),
        agent_version: body.agent_version || null,
        agent_hostname: body.hostname || null,
        schema_fingerprint: body.schema_fingerprint ?? null,
        schema_mismatch: body.schema_mismatch ?? null,
      }).eq("id", agent.settingId);
      return json({ ok: true, server_time: new Date().toISOString() });
    }

    // ============ TEST CONNECTION ============
    if (path === "test" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);
      return json({ ok: true, account: agent.account, store_code: agent.storeCode });
    }

    // ============ SYNC CATALOGS ============
    if (path === "catalogs" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);

      // Idempotency check
      const cached = await checkIdempotency(agent, "catalogs");
      if (cached) return cached;

      const start = Date.now();
      const body = await req.json();

      // Change 3+4: also validate precos_base batch size
      const batchErr = validateBatchSize(body, ["produtos", "bases", "embalagens", "skus", "corantes", "precos_base"]);
      if (batchErr) return json({ ok: false, error: batchErr }, 400);

      const runId = await createSyncRun(agent, "catalogs");
      if (!runId) return json({ ok: false, error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const updates = 0, ignored = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];

      const stagingTables: Record<string, { table: string; keyField: string }> = {
        produtos: { table: "tint_staging_produtos", keyField: "cod_produto" },
        bases: { table: "tint_staging_bases", keyField: "id_base_sayersystem" },
        embalagens: { table: "tint_staging_embalagens", keyField: "id_embalagem_sayersystem" },
        skus: { table: "tint_staging_skus", keyField: "cod_produto" },
        corantes: { table: "tint_staging_corantes", keyField: "id_corante_sayersystem" },
      };

      let received = 0;

      // Change 3: bulk insert for catalog entities (chunks of 500)
      for (const [entityType, config] of Object.entries(stagingTables)) {
        const items: TintCatalogItem[] = (body[entityType] as TintCatalogItem[] | undefined) || [];
        received += items.length;

        const rows: Record<string, unknown>[] = items.map((item) => {
          const entityKey = (item[config.keyField] as string | undefined) || item.id || "";
          const row: Record<string, unknown> = {
            sync_run_id: runId,
            account: agent.account,
            store_code: agent.storeCode,
            raw_data: item,
            staging_status: "pending",
          };
          // Copy all item fields, excluding those already set
          for (const [k, v] of Object.entries(item)) {
            if (k in row) continue;
            row[k] = v;
          }
          row[config.keyField] = entityKey;
          if (item.descricao) row.descricao = item.descricao;
          if (item.volume_ml !== undefined) row.volume_ml = item.volume_ml;
          if (item.preco_litro !== undefined) row.preco_litro = item.preco_litro;
          // Change 3+4: passthrough custo and volume_ml for corantes
          if (item.custo !== undefined) row.custo = item.custo;
          if (item.id_base) row.id_base = item.id_base;
          if (item.id_embalagem) row.id_embalagem = item.id_embalagem;
          return row;
        });

        const { insertedCount } = await bulkInsert(config.table, rows, 500, (chunk, err) => {
          errors += chunk.length;
          errorDetails.push({ entity_type: entityType, entity_id: null, message: err.message });
          // fire-and-forget logError for the chunk
          logError(runId, entityType, null, err.message, err, { chunk_size: chunk.length }).catch(() => {});
        });
        inserts += insertedCount;
      }

      // Change 4: handle precos_base entity → tint_staging_precos_base
      const precosBaseItems: TintPrecosBaseItem[] = (body.precos_base as TintPrecosBaseItem[] | undefined) || [];
      received += precosBaseItems.length;
      if (precosBaseItems.length > 0) {
        const precosRows: Record<string, unknown>[] = precosBaseItems.map((item) => ({
          sync_run_id: runId,
          account: agent.account,
          store_code: agent.storeCode,
          cod_produto: item.cod_produto ?? null,
          id_base: item.id_base ?? null,
          id_embalagem: item.id_embalagem ?? null,
          custo: item.custo ?? null,
          imposto_pct: item.imposto_pct ?? null,
          margem_pct: item.margem_pct ?? null,
          raw_data: item,
          staging_status: "pending",
        }));

        const { insertedCount: precosInserted } = await bulkInsert("tint_staging_precos_base", precosRows, 500, (chunk, err) => {
          errors += chunk.length;
          errorDetails.push({ entity_type: "precos_base", entity_id: null, message: err.message });
          logError(runId, "precos_base", null, err.message, err, { chunk_size: chunk.length }).catch(() => {});
        });
        inserts += precosInserted;
      }

      const resp = buildResponse(runId, { received, inserts, updates, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates, errors }, "complete", resp);

      // Change 5: promotion gate — run promotion if automatic_primary
      if (agent.integrationMode === "automatic_primary") {
        const { data: promo, error: promoErr } = await sb.rpc("tint_promote_sync_run", { p_sync_run_id: runId });
        if (promoErr) {
          await sb.from("tint_sync_runs").update({ status: "error" }).eq("id", runId);
          await logError(runId, "promotion", null, promoErr.message, promoErr);
          return json({ ...resp, ok: false, promotion_error: promoErr.message }, 500);
        }
        (resp as Record<string, unknown>).promotion = promo;
      }

      return json(resp);
    }

    // ============ SYNC FORMULAS ============
    if (path === "formulas" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);

      const cached = await checkIdempotency(agent, "formulas");
      if (cached) return cached;

      const start = Date.now();
      const body = await req.json();

      const batchErr = validateBatchSize(body, ["formulas"]);
      if (batchErr) return json({ ok: false, error: batchErr }, 400);

      const runId = await createSyncRun(agent, "formulas");
      if (!runId) return json({ ok: false, error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const ignored = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];
      const formulas: TintFormulaPayload[] = (body.formulas as TintFormulaPayload[] | undefined) || [];
      const received = formulas.length;

      // Change 3: bulk insert formulas — validate first, then bulk insert valid ones

      // Separate valid from invalid
      const validFormulas: TintFormulaPayload[] = [];
      for (const f of formulas) {
        if (!f.cor_id || !f.cod_produto || !f.id_base || !f.id_embalagem) {
          errors++;
          errorDetails.push({ entity_type: "formula", entity_id: f.cor_id || null, message: "Missing required field: cor_id, cod_produto, id_base, id_embalagem" });
          await logError(runId, "formula", f.cor_id ?? null, "Missing required fields", null, f);
        } else {
          validFormulas.push(f);
        }
      }

      // Bulk insert valid formulas. Fase 1c (Codex P2): o id do header é PRÉ-GERADO aqui — a
      // associação header→itens deixa de depender da ORDEM do retorno de .insert().select("id")
      // (IDs fora de ordem ligariam a receita de A ao header de B com COUNT=expected batendo nos dois).
      const formulaRows: Record<string, unknown>[] = validFormulas.map((f) => ({
        id: crypto.randomUUID(),
        sync_run_id: runId,
        account: agent.account,
        store_code: agent.storeCode,
        cor_id: f.cor_id,
        nome_cor: f.nome_cor,
        cod_produto: f.cod_produto,
        id_base: f.id_base,
        id_embalagem: f.id_embalagem,
        subcolecao: f.subcolecao || null,
        volume_final_ml: f.volume_final_ml,
        preco_final: f.preco_final,
        personalizada: f.personalizada || false,
        raw_data: f,
        staging_status: "pending",
        // Fase 1c — protocolo de staging como UNIDADE: declara quantas linhas de item a edge
        // RECEBEU e vai inserir p/ este header. A promoção (tint_promote_sync_run v4) só aceita a
        // fórmula quando o COUNT bruto ingerido bate (fecha subconjunto por fronteira de chunk +
        // corrida de ingestão×promoção). ⚠️ Codex P1: `itens` AUSENTE (regressão de serialização)
        // NUNCA vira 0 — grava NULL (protocolo ambíguo → a promoção barra fail-closed); 0 declarado
        // também NÃO autoriza limpeza de receita (o conector filtra inválidos antes do POST — sinal
        // semântico de base pura é a Fase 1d). Simulação/sintéticos não declaram (NULL).
        // ⚠️ Deploy: a migration 20260718170000 (cria a coluna) vai ANTES desta edge.
        expected_item_count: Array.isArray(f.itens) ? f.itens.length : null,
      }));

      // Insert in chunks of 500, collecting returned IDs
      const FORMULA_CHUNK = 500;
      const ITEM_CHUNK = 1000;
      const insertedFormulaIds: (string | null)[] = [];

      for (let i = 0; i < formulaRows.length; i += FORMULA_CHUNK) {
        const chunk = formulaRows.slice(i, i + FORMULA_CHUNK);
        const { error: chunkErr } = await sb.from("tint_staging_formulas")
          .insert(chunk);
        if (chunkErr) {
          // All formulas in this chunk fail — count as errors
          const chunkFormulas = validFormulas.slice(i, i + FORMULA_CHUNK);
          for (const f of chunkFormulas) {
            errors++;
            errorDetails.push({ entity_type: "formula", entity_id: f.cor_id ?? null, message: chunkErr.message });
            await logError(runId, "formula", f.cor_id ?? null, chunkErr.message, chunkErr, f);
          }
          // Push nulls so index alignment is preserved for item insertion
          for (let j = 0; j < chunk.length; j++) insertedFormulaIds.push(null);
        } else {
          inserts += chunk.length;
          // Fase 1c (Codex P2): ids pré-gerados na edge — o alinhamento é com o array LOCAL,
          // não com a ordem que o servidor devolveria.
          for (const row of chunk) insertedFormulaIds.push(row.id as string);
        }
      }

      // Build all item rows (only for successfully inserted formulas)
      const allItemRows: Array<{ row: Record<string, unknown>; formulaId: string; idx: number }> = [];
      for (let fi = 0; fi < validFormulas.length; fi++) {
        const formulaId = insertedFormulaIds[fi];
        if (!formulaId) continue; // formula insert failed, skip items
        const f = validFormulas[fi];
        const itens: TintFormulaItem[] = f.itens || [];
        for (const item of itens) {
          allItemRows.push({
            formulaId,
            idx: fi,
            row: {
              sync_run_id: runId,
              staging_formula_id: formulaId,
              id_corante: item.id_corante || "",
              ordem: item.ordem,
              qtd_ml: item.qtd_ml,
            },
          });
        }
      }

      // Bulk insert items in chunks of 1000 — on failure: delete staging formulas for that chunk
      for (let i = 0; i < allItemRows.length; i += ITEM_CHUNK) {
        const chunk = allItemRows.slice(i, i + ITEM_CHUNK);
        const itemRows = chunk.map((x) => x.row);
        const { error: itemErr } = await sb.from("tint_staging_formula_itens").insert(itemRows);
        if (itemErr) {
          // Collect unique formula IDs affected by this chunk
          const affectedIds = [...new Set(chunk.map((x) => x.formulaId))];
          // Delete their staging formula rows and decrement inserts
          await sb.from("tint_staging_formulas").delete().in("id", affectedIds);
          for (const formulaId of affectedIds) {
            errors++;
            inserts = Math.max(0, inserts - 1);
            // Find the original formula for error context
            const fi = insertedFormulaIds.indexOf(formulaId);
            const f = fi >= 0 ? validFormulas[fi] : null;
            const corId = f?.cor_id ?? null;
            errorDetails.push({ entity_type: "formula_item", entity_id: corId, message: itemErr.message });
            await logError(runId, "formula_item", corId, itemErr.message, itemErr, { formula_id: formulaId });
          }
        }
      }

      const resp = buildResponse(runId, { received, inserts, updates: 0, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates: 0, errors }, "complete", resp);

      // Change 5: promotion gate — run promotion if automatic_primary
      if (agent.integrationMode === "automatic_primary") {
        const { data: promo, error: promoErr } = await sb.rpc("tint_promote_sync_run", { p_sync_run_id: runId });
        if (promoErr) {
          await sb.from("tint_sync_runs").update({ status: "error" }).eq("id", runId);
          await logError(runId, "promotion", null, promoErr.message, promoErr);
          return json({ ...resp, ok: false, promotion_error: promoErr.message }, 500);
        }
        (resp as Record<string, unknown>).promotion = promo;
      }

      return json(resp);
    }

    // ============ SYNC PREPARATIONS ============
    if (path === "preparations" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);

      const cached = await checkIdempotency(agent, "preparations");
      if (cached) return cached;

      const start = Date.now();
      const body = await req.json();

      const batchErr = validateBatchSize(body, ["preparacoes"]);
      if (batchErr) return json({ ok: false, error: batchErr }, 400);

      const runId = await createSyncRun(agent, "preparations");
      if (!runId) return json({ ok: false, error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const ignored = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];
      const preps: TintPreparacaoPayload[] = (body.preparacoes as TintPreparacaoPayload[] | undefined) || [];
      const received = preps.length;

      // /preparations kept as row-by-row (v2 per spec) but item errors are now surfaced
      for (const p of preps) {
        try {
          if (!p.preparacao_id) {
            errors++;
            errorDetails.push({ entity_type: "preparacao", entity_id: null, message: "Missing required field: preparacao_id" });
            await logError(runId, "preparacao", null, "Missing preparacao_id", null, p);
            continue;
          }

          const { data: prepRow, error: pErr } = await sb.from("tint_staging_preparacoes").insert({
            sync_run_id: runId,
            account: agent.account,
            store_code: agent.storeCode,
            preparacao_id: p.preparacao_id,
            cor_id: p.cor_id,
            nome_cor: p.nome_cor,
            cod_produto: p.cod_produto,
            id_base: p.id_base,
            id_embalagem: p.id_embalagem,
            volume_ml: p.volume_ml,
            preco: p.preco,
            cliente: p.cliente,
            data_preparacao: p.data_preparacao,
            personalizada: p.personalizada || false,
            raw_data: p,
            staging_status: "pending",
          }).select("id").single();

          if (pErr) {
            errors++;
            errorDetails.push({ entity_type: "preparacao", entity_id: p.preparacao_id, message: pErr.message });
            await logError(runId, "preparacao", p.preparacao_id, pErr.message, pErr, p);
            continue;
          }

          const itens: TintFormulaItem[] = p.itens || [];
          for (const item of itens) {
            // Fix §3.1.3 applied to /preparations as well: surface item errors
            const { error: itemErr } = await sb.from("tint_staging_preparacao_itens").insert({
              sync_run_id: runId,
              staging_preparacao_id: prepRow?.id,
              id_corante: item.id_corante || "",
              ordem: item.ordem || 0,
              qtd_ml: item.qtd_ml,
            });
            if (itemErr) {
              errors++;
              errorDetails.push({ entity_type: "preparacao_item", entity_id: p.preparacao_id, message: itemErr.message });
              await logError(runId, "preparacao_item", p.preparacao_id, itemErr.message, itemErr, item);
            }
          }
          inserts++;
        } catch (e) {
          errors++;
          const msg = e instanceof Error ? e.message : String(e);
          errorDetails.push({ entity_type: "preparacao", entity_id: p.preparacao_id ?? null, message: msg });
          await logError(runId, "preparacao", p.preparacao_id ?? null, msg, null, p);
        }
      }

      const resp = buildResponse(runId, { received, inserts, updates: 0, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates: 0, errors }, "complete", resp);
      return json(resp);
    }

    // ============ KEYS SNAPSHOT (Change 4 — new endpoint) ============
    if (path === "keys-snapshot" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);

      const body = await req.json().catch(() => null);
      if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

      const { entity, snapshot_id, generated_at, total_chunks, chunk_index, keys } = body as Record<string, unknown>;

      // Validate
      if (entity !== "formulas") {
        return json({ ok: false, error: "entity must be 'formulas' (v1)" }, 400);
      }
      if (!snapshot_id || typeof snapshot_id !== "string") {
        return json({ ok: false, error: "snapshot_id required" }, 400);
      }
      if (!generated_at) {
        return json({ ok: false, error: "generated_at required" }, 400);
      }
      if (!Number.isInteger(total_chunks) || !Number.isInteger(chunk_index)) {
        return json({ ok: false, error: "total_chunks and chunk_index must be integers" }, 400);
      }
      if ((total_chunks as number) < 1) {
        return json({ ok: false, error: "total_chunks must be >= 1" }, 400);
      }
      if ((chunk_index as number) < 0 || (chunk_index as number) >= (total_chunks as number)) {
        return json({ ok: false, error: "chunk_index must be in [0, total_chunks)" }, 400);
      }
      if (!Array.isArray(keys)) {
        return json({ ok: false, error: "keys must be an array" }, 400);
      }
      if ((keys as unknown[]).length > 50000) {
        return json({ ok: false, error: "keys.length must be <= 50000" }, 400);
      }
      if (!(keys as unknown[]).every((k) => typeof k === "string")) {
        return json({ ok: false, error: "every key must be a string" }, 400);
      }

      // Insert into tint_keys_snapshots (unique-violation = duplicate chunk replay → ok)
      const { error: insertErr } = await sb.from("tint_keys_snapshots").insert({
        setting_id: agent.settingId,
        account: agent.account,
        store_code: agent.storeCode,
        snapshot_id,
        entity,
        generated_at,
        total_chunks,
        chunk_index,
        keys,
      });

      if (insertErr && insertErr.code !== "23505") {
        return json({ ok: false, error: insertErr.message }, 500);
      }
      // duplicate chunk (23505) treated as ok

      // Count received chunks for this snapshot
      const { count } = await sb.from("tint_keys_snapshots")
        .select("chunk_index", { count: "exact", head: true })
        .eq("snapshot_id", snapshot_id)
        .eq("entity", entity);

      const allChunksReceived = count === (total_chunks as number);

      // If complete and automatic_primary mode → apply snapshot (desativation logic)
      if (allChunksReceived && agent.integrationMode === "automatic_primary") {
        const { data: applyData, error: applyErr } = await sb.rpc("tint_apply_keys_snapshot", {
          p_snapshot_id: snapshot_id,
        });
        return json({
          ok: true,
          complete: true,
          applied: !applyErr,
          result: applyData ?? null,
          ...(applyErr ? { apply_error: applyErr.message } : {}),
        });
      }

      return json({
        ok: true,
        complete: allChunksReceived,
        applied: false,
        awaiting_chunks: (total_chunks as number) - (count ?? 0),
      });
    }

    // ============ SIMULATE (admin - JWT auth) ============
    if (path === "simulate" && req.method === "POST") {
      const authResult = await authorizeStaff();
      if (!authResult.ok) return authResult.resp;

      const body = await req.json();
      const settingId = body.setting_id;
      const simulateMode = body.mode || "real_data";
      if (!settingId) return json({ ok: false, error: "setting_id required" }, 400);

      const { data: setting } = await sb.from("tint_integration_settings")
        .select("id, account, store_code")
        .eq("id", settingId)
        .single();
      if (!setting) return json({ ok: false, error: "Setting not found" }, 404);

      const start = Date.now();

      const { data: runData } = await sb.from("tint_sync_runs").insert({
        setting_id: setting.id,
        account: setting.account,
        store_code: setting.store_code,
        sync_type: "simulation",
        source: "simulation",
        status: "running",
      }).select("id").single();
      const runId = runData?.id;
      if (!runId) return json({ ok: false, error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const debugLog: string[] = [];

      if (simulateMode === "real_data") {
        debugLog.push("Mode: real_data — sampling from official CSV-imported tables");

        const { data: realCorantes } = await sb.from("tint_corantes")
          .select("id_corante_sayersystem, descricao, preco_litro")
          .eq("account", setting.account);
        debugLog.push(`Found ${realCorantes?.length || 0} corantes in official table`);

        for (const c of (realCorantes || [])) {
          const { error } = await sb.from("tint_staging_corantes").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            id_corante_sayersystem: c.id_corante_sayersystem,
            descricao: c.descricao, preco_litro: c.preco_litro,
            raw_data: c, staging_status: "pending",
          });
          if (error) { errors++; } else { inserts++; }
        }

        const { data: realFormulas } = await sb.from("tint_formulas")
          .select(`cor_id, nome_cor, volume_final_ml, preco_final_sayersystem,
            produto_id, base_id, embalagem_id,
            tint_produtos!inner(cod_produto),
            tint_bases!inner(id_base_sayersystem),
            tint_embalagens!inner(id_embalagem_sayersystem)`)
          .eq("account", setting.account)
          .limit(20);

        debugLog.push(`Sampled ${realFormulas?.length || 0} formulas from official table`);

        const formulaRows = (realFormulas || []) as unknown as TintFormulaJoinRow[];
        for (let i = 0; i < formulaRows.length; i++) {
          const f = formulaRows[i];
          const codProduto = f.tint_produtos?.cod_produto;
          const idBase = f.tint_bases?.id_base_sayersystem;
          const idEmbalagem = f.tint_embalagens?.id_embalagem_sayersystem;

          let preco = f.preco_final_sayersystem;
          if (i >= 15 && i < 18) {
            preco = preco != null ? Number((preco * 1.05).toFixed(4)) : 10.0;
            debugLog.push(`Formula ${f.cor_id}: price modified ${f.preco_final_sayersystem} → ${preco} (divergence test)`);
          }

          const key = `${f.cor_id}|${codProduto}|${idBase}|${idEmbalagem}`;
          debugLog.push(`Staging formula key: ${key}`);

          const { error: fErr } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            cor_id: f.cor_id, nome_cor: f.nome_cor, cod_produto: codProduto,
            id_base: idBase, id_embalagem: idEmbalagem,
            volume_final_ml: f.volume_final_ml, preco_final: preco,
            personalizada: false, raw_data: { ...f, _sim_index: i },
            staging_status: "pending",
          }).select("id").single();
          if (fErr) { errors++; } else { inserts++; }
          if (fErr) debugLog.push(`ERROR staging formula ${f.cor_id}: ${fErr.message}`);
        }

        for (const synth of [
          { cor_id: "SIM-NEW-001", nome_cor: "Cor Sintética Teste 1", cod_produto: "SIM-PROD-X", id_base: "SIM-BASE-X", id_embalagem: "SIM-EMB-X", volume_final_ml: 900, preco_final: 99.99 },
          { cor_id: "SIM-NEW-002", nome_cor: "Cor Sintética Teste 2", cod_produto: "SIM-PROD-Y", id_base: "SIM-BASE-Y", id_embalagem: "SIM-EMB-Y", volume_final_ml: 3600, preco_final: 299.99 },
        ]) {
          const { error } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            cor_id: synth.cor_id, nome_cor: synth.nome_cor, cod_produto: synth.cod_produto,
            id_base: synth.id_base, id_embalagem: synth.id_embalagem,
            volume_final_ml: synth.volume_final_ml, preco_final: synth.preco_final,
            personalizada: false, raw_data: synth, staging_status: "pending",
          });
          if (error) { errors++; } else { inserts++; }
          debugLog.push(`Synthetic formula ${synth.cor_id}: only_sync test`);
        }

      } else {
        debugLog.push("Mode: synthetic — using hardcoded seed data");
        const seedCorantes = [
          { id_corante_sayersystem: "COR-AX", descricao: "Amarelo Óxido", preco_litro: 42.50 },
          { id_corante_sayersystem: "COR-VM", descricao: "Vermelho Médio", preco_litro: 68.90 },
          { id_corante_sayersystem: "COR-AZ", descricao: "Azul Ftalo", preco_litro: 55.30 },
        ];
        for (const c of seedCorantes) {
          const { error } = await sb.from("tint_staging_corantes").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            id_corante_sayersystem: c.id_corante_sayersystem, descricao: c.descricao,
            preco_litro: c.preco_litro, raw_data: c, staging_status: "pending",
          });
          if (error) { errors++; } else { inserts++; }
        }
        const seedFormulas = [
          { cor_id: "SIM-COR-001", nome_cor: "Amarelo Sol", cod_produto: "SIM-CORAL", id_base: "BASE-A", id_embalagem: "EMB-900", volume_final_ml: 900, preco_final: 89.90, personalizada: false },
          { cor_id: "SIM-COR-002", nome_cor: "Azul Horizonte", cod_produto: "SIM-SUVINIL", id_base: "BASE-B", id_embalagem: "EMB-3600", volume_final_ml: 3600, preco_final: 245.00, personalizada: false },
        ];
        for (const f of seedFormulas) {
          const { error } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            cor_id: f.cor_id, nome_cor: f.nome_cor, cod_produto: f.cod_produto,
            id_base: f.id_base, id_embalagem: f.id_embalagem,
            volume_final_ml: f.volume_final_ml, preco_final: f.preco_final,
            personalizada: f.personalizada, raw_data: f, staging_status: "pending",
          }).select("id").single();
          if (error) { errors++; } else { inserts++; }
        }
      }

      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: inserts, inserts, updates: 0, errors });

      const { data: reconResult, error: reconErr } = await sb.rpc("tint_run_reconciliation", { p_sync_run_id: runId });

      return json({
        ok: true,
        sync_run_id: runId,
        mode: simulateMode,
        inserts,
        errors,
        reconciliation: reconResult,
        debug_log: debugLog,
        ...(reconErr ? { reconciliation_error: reconErr.message } : {}),
      });
    }

    // ============ RECONCILE (admin - JWT auth) ============
    if (path === "reconcile" && req.method === "POST") {
      const authResult = await authorizeStaff();
      if (!authResult.ok) return authResult.resp;

      const body = await req.json();
      const syncRunId = body.sync_run_id;
      if (!syncRunId) return json({ ok: false, error: "sync_run_id required" }, 400);

      const { data: result, error } = await sb.rpc("tint_run_reconciliation", { p_sync_run_id: syncRunId });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, ...result });
    }

    return json({ ok: false, error: `Unknown endpoint: ${path}` }, 404);
  } catch (e) {
    console.error("tint-sync-agent error:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: msg || "Internal error" }, 500);
  }
});
