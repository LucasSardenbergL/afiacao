import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token, x-store-code, x-idempotency-key",
};

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

  const syncToken = req.headers.get("x-sync-token");
  const storeCode = req.headers.get("x-store-code");
  const idempotencyKey = req.headers.get("x-idempotency-key");

  // ─── helpers ───

  async function validateAgent(): Promise<{ settingId: string; account: string; storeCode: string } | null> {
    if (!syncToken || !storeCode) return null;
    const { data } = await sb.from("tint_integration_settings")
      .select("id, account, store_code, sync_enabled, integration_mode")
      .eq("sync_token", syncToken)
      .eq("store_code", storeCode)
      .single();
    if (!data || !data.sync_enabled) return null;
    return { settingId: data.id, account: data.account, storeCode: data.store_code };
  }

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
    // Return the stored response deterministically
    const stored = data.idempotency_response as Record<string, unknown> | null;
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
      ...(stored || {}),
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

  try {
    // ============ HEARTBEAT ============
    if (path === "heartbeat" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ ok: false, error: "Invalid token or store" }, 401);
      const body = await req.json().catch(() => ({}));
      await sb.from("tint_integration_settings").update({
        last_heartbeat_at: new Date().toISOString(),
        agent_version: body.agent_version || null,
        agent_hostname: body.hostname || null,
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

      // Validate batch sizes
      const batchErr = validateBatchSize(body, ["produtos", "bases", "embalagens", "skus", "corantes"]);
      if (batchErr) return json({ ok: false, error: batchErr }, 400);

      const runId = await createSyncRun(agent, "catalogs");
      if (!runId) return json({ ok: false, error: "Failed to create sync run" }, 500);

      let inserts = 0, updates = 0, ignored = 0, errors = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];

      const stagingTables: Record<string, { table: string; keyField: string }> = {
        produtos: { table: "tint_staging_produtos", keyField: "cod_produto" },
        bases: { table: "tint_staging_bases", keyField: "id_base_sayersystem" },
        embalagens: { table: "tint_staging_embalagens", keyField: "id_embalagem_sayersystem" },
        skus: { table: "tint_staging_skus", keyField: "cod_produto" },
        corantes: { table: "tint_staging_corantes", keyField: "id_corante_sayersystem" },
      };

      let received = 0;
      for (const [entityType, config] of Object.entries(stagingTables)) {
        const items = body[entityType] || [];
        received += items.length;
        for (const item of items) {
          try {
            const row: Record<string, unknown> = {
              sync_run_id: runId,
              account: agent.account,
              store_code: agent.storeCode,
              raw_data: item,
              staging_status: "pending",
            };
            for (const [k, v] of Object.entries(item)) {
              if (k in row) continue;
              row[k] = v;
            }
            row[config.keyField] = item[config.keyField] || item.id || "";
            if (item.descricao) row.descricao = item.descricao;
            if (item.volume_ml !== undefined) row.volume_ml = item.volume_ml;
            if (item.preco_litro !== undefined) row.preco_litro = item.preco_litro;
            if (item.id_base) row.id_base = item.id_base;
            if (item.id_embalagem) row.id_embalagem = item.id_embalagem;

            const { error } = await sb.from(config.table).insert(row);
            if (error) {
              errors++;
              errorDetails.push({ entity_type: entityType, entity_id: item[config.keyField], message: error.message });
              await logError(runId, entityType, item[config.keyField], error.message, error, item);
            } else {
              inserts++;
            }
          } catch (e: any) {
            errors++;
            errorDetails.push({ entity_type: entityType, entity_id: null, message: e.message });
            await logError(runId, entityType, null, e.message, null, item);
          }
        }
      }

      const resp = buildResponse(runId, { received, inserts, updates, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates, errors }, "complete", resp);
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

      let inserts = 0, errors = 0, ignored = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];
      const formulas = body.formulas || [];
      const received = formulas.length;

      for (const f of formulas) {
        try {
          // Validate required fields
          if (!f.cor_id || !f.cod_produto || !f.id_base || !f.id_embalagem) {
            errors++;
            errorDetails.push({ entity_type: "formula", entity_id: f.cor_id || null, message: "Missing required field: cor_id, cod_produto, id_base, id_embalagem" });
            await logError(runId, "formula", f.cor_id, "Missing required fields", null, f);
            continue;
          }

          const { data: formulaRow, error: fErr } = await sb.from("tint_staging_formulas").insert({
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
          }).select("id").single();

          if (fErr) {
            errors++;
            errorDetails.push({ entity_type: "formula", entity_id: f.cor_id, message: fErr.message });
            await logError(runId, "formula", f.cor_id, fErr.message, fErr, f);
            continue;
          }

          const itens = f.itens || [];
          for (const item of itens) {
            await sb.from("tint_staging_formula_itens").insert({
              sync_run_id: runId,
              staging_formula_id: formulaRow?.id,
              id_corante: item.id_corante || "",
              ordem: item.ordem,
              qtd_ml: item.qtd_ml,
            });
          }
          inserts++;
        } catch (e: any) {
          errors++;
          errorDetails.push({ entity_type: "formula", entity_id: f.cor_id, message: e.message });
          await logError(runId, "formula", f.cor_id, e.message, null, f);
        }
      }

      const resp = buildResponse(runId, { received, inserts, updates: 0, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates: 0, errors }, "complete", resp);
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

      let inserts = 0, errors = 0, ignored = 0;
      const errorDetails: { entity_type: string; entity_id: string | null; message: string }[] = [];
      const preps = body.preparacoes || [];
      const received = preps.length;

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

          const itens = p.itens || [];
          for (const item of itens) {
            await sb.from("tint_staging_preparacao_itens").insert({
              sync_run_id: runId,
              staging_preparacao_id: prepRow?.id,
              id_corante: item.id_corante || "",
              ordem: item.ordem || 0,
              qtd_ml: item.qtd_ml,
            });
          }
          inserts++;
        } catch (e: any) {
          errors++;
          errorDetails.push({ entity_type: "preparacao", entity_id: p.preparacao_id, message: e.message });
          await logError(runId, "preparacao", p.preparacao_id, e.message, null, p);
        }
      }

      const resp = buildResponse(runId, { received, inserts, updates: 0, ignored, errors, errorDetails });
      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: received, inserts, updates: 0, errors }, "complete", resp);
      return json(resp);
    }

    // ============ SIMULATE (admin - JWT auth) ============
    if (path === "simulate" && req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return json({ ok: false, error: "Auth required" }, 401);

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
          error ? errors++ : inserts++;
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

        const formulaRows = realFormulas || [];
        for (let i = 0; i < formulaRows.length; i++) {
          const f = formulaRows[i] as any;
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
          fErr ? errors++ : inserts++;
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
          error ? errors++ : inserts++;
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
          error ? errors++ : inserts++;
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
          error ? errors++ : inserts++;
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
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return json({ ok: false, error: "Auth required" }, 401);

      const body = await req.json();
      const syncRunId = body.sync_run_id;
      if (!syncRunId) return json({ ok: false, error: "sync_run_id required" }, 400);

      const { data: result, error } = await sb.rpc("tint_run_reconciliation", { p_sync_run_id: syncRunId });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, ...result });
    }

    return json({ ok: false, error: `Unknown endpoint: ${path}` }, 404);
  } catch (e: any) {
    console.error("tint-sync-agent error:", e);
    return json({ ok: false, error: e.message || "Internal error" }, 500);
  }
});
