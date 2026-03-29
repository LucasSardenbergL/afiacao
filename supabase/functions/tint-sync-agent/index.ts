import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token, x-store-code",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop() || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  // Auth: token-based for agent, JWT for frontend reads
  const syncToken = req.headers.get("x-sync-token");
  const storeCode = req.headers.get("x-store-code");

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

  async function createSyncRun(agent: { settingId: string; account: string; storeCode: string }, syncType: string) {
    const { data } = await sb.from("tint_sync_runs").insert({
      setting_id: agent.settingId,
      account: agent.account,
      store_code: agent.storeCode,
      sync_type: syncType,
      source: "agent",
      status: "running",
    }).select("id").single();
    return data?.id;
  }

  async function completeSyncRun(runId: string, stats: Record<string, number>, status = "complete") {
    await sb.from("tint_sync_runs").update({
      status,
      completed_at: new Date().toISOString(),
      duration_ms: stats.duration_ms || 0,
      total_records: stats.total || 0,
      inserts: stats.inserts || 0,
      updates: stats.updates || 0,
      errors: stats.errors || 0,
    }).eq("id", runId);
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

  try {
    // ============ HEARTBEAT ============
    if (path === "heartbeat" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ error: "Invalid token or store" }, 401);
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
      if (!agent) return json({ error: "Invalid token or store" }, 401);
      return json({ ok: true, account: agent.account, store_code: agent.storeCode });
    }

    // ============ SYNC CATALOGS (produtos, bases, embalagens, skus, corantes) ============
    if (path === "catalogs" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ error: "Invalid token or store" }, 401);
      const start = Date.now();
      const body = await req.json();
      const runId = await createSyncRun(agent, "catalogs");
      if (!runId) return json({ error: "Failed to create sync run" }, 500);

      let inserts = 0, updates = 0, errors = 0;

      const stagingTables: Record<string, { table: string; keyField: string }> = {
        produtos: { table: "tint_staging_produtos", keyField: "cod_produto" },
        bases: { table: "tint_staging_bases", keyField: "id_base_sayersystem" },
        embalagens: { table: "tint_staging_embalagens", keyField: "id_embalagem_sayersystem" },
        skus: { table: "tint_staging_skus", keyField: "cod_produto" },
        corantes: { table: "tint_staging_corantes", keyField: "id_corante_sayersystem" },
      };

      for (const [entityType, config] of Object.entries(stagingTables)) {
        const items = body[entityType] || [];
        for (const item of items) {
          try {
            const row: Record<string, unknown> = {
              sync_run_id: runId,
              account: agent.account,
              store_code: agent.storeCode,
              raw_data: item,
              staging_status: "pending",
            };
            // Map known fields
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
              await logError(runId, entityType, item[config.keyField], error.message, error, item);
            } else {
              inserts++;
            }
          } catch (e) {
            errors++;
            await logError(runId, entityType, null, e.message, null, item);
          }
        }
      }

      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: inserts + updates, inserts, updates, errors });
      return json({ ok: true, run_id: runId, inserts, updates, errors });
    }

    // ============ SYNC FORMULAS ============
    if (path === "formulas" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ error: "Invalid token or store" }, 401);
      const start = Date.now();
      const body = await req.json();
      const runId = await createSyncRun(agent, "formulas");
      if (!runId) return json({ error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const formulas = body.formulas || [];

      for (const f of formulas) {
        try {
          const { data: formulaRow, error: fErr } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId,
            account: agent.account,
            store_code: agent.storeCode,
            cor_id: f.cor_id || "",
            nome_cor: f.nome_cor,
            cod_produto: f.cod_produto,
            id_base: f.id_base,
            id_embalagem: f.id_embalagem,
            subcolecao: f.subcolecao,
            volume_final_ml: f.volume_final_ml,
            preco_final: f.preco_final,
            personalizada: f.personalizada || false,
            raw_data: f,
            staging_status: "pending",
          }).select("id").single();

          if (fErr) { errors++; await logError(runId, "formula", f.cor_id, fErr.message, fErr, f); continue; }

          // Insert formula items
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
        } catch (e) {
          errors++;
          await logError(runId, "formula", f.cor_id, e.message, null, f);
        }
      }

      // Colors catalog/personalized
      for (const type of ["cores_catalogo", "cores_personalizadas"] as const) {
        const table = type === "cores_catalogo" ? "tint_staging_cores_catalogo" : "tint_staging_cores_personalizadas";
        const items = body[type] || [];
        for (const c of items) {
          try {
            await sb.from(table).insert({
              sync_run_id: runId,
              account: agent.account,
              store_code: agent.storeCode,
              cor_id: c.cor_id || "",
              nome_cor: c.nome_cor,
              ...(type === "cores_catalogo" ? { colecao: c.colecao, subcolecao: c.subcolecao } : { cliente: c.cliente }),
              raw_data: c,
              staging_status: "pending",
            });
            inserts++;
          } catch (e) {
            errors++;
          }
        }
      }

      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: inserts, inserts, updates: 0, errors });
      return json({ ok: true, run_id: runId, inserts, errors });
    }

    // ============ SYNC PREPARATIONS ============
    if (path === "preparations" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ error: "Invalid token or store" }, 401);
      const start = Date.now();
      const body = await req.json();
      const runId = await createSyncRun(agent, "preparations");
      if (!runId) return json({ error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const preps = body.preparacoes || [];

      for (const p of preps) {
        try {
          const { data: prepRow, error: pErr } = await sb.from("tint_staging_preparacoes").insert({
            sync_run_id: runId,
            account: agent.account,
            store_code: agent.storeCode,
            preparacao_id: p.preparacao_id || "",
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

          if (pErr) { errors++; await logError(runId, "preparacao", p.preparacao_id, pErr.message, pErr, p); continue; }

          const itens = p.itens || [];
          for (const item of itens) {
            await sb.from("tint_staging_preparacao_itens").insert({
              sync_run_id: runId,
              staging_preparacao_id: prepRow?.id,
              id_corante: item.id_corante || "",
              ordem: item.ordem,
              qtd_ml: item.qtd_ml,
            });
          }
          inserts++;
        } catch (e) {
          errors++;
          await logError(runId, "preparacao", p.preparacao_id, e.message, null, p);
        }
      }

      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: inserts, inserts, updates: 0, errors });
      return json({ ok: true, run_id: runId, inserts, errors });
    }

    // ============ BATCH (all-in-one) ============
    if (path === "batch" && req.method === "POST") {
      const agent = await validateAgent();
      if (!agent) return json({ error: "Invalid token or store" }, 401);
      const start = Date.now();
      const body = await req.json();
      const runId = await createSyncRun(agent, "batch");
      if (!runId) return json({ error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;

      // Process each entity type
      const entityMappings: Record<string, string> = {
        produtos: "tint_staging_produtos",
        bases: "tint_staging_bases",
        embalagens: "tint_staging_embalagens",
        skus: "tint_staging_skus",
        corantes: "tint_staging_corantes",
        cores_catalogo: "tint_staging_cores_catalogo",
        cores_personalizadas: "tint_staging_cores_personalizadas",
      };

      for (const [key, table] of Object.entries(entityMappings)) {
        const items = body[key] || [];
        for (const item of items) {
          try {
            const row: Record<string, unknown> = {
              sync_run_id: runId,
              account: agent.account,
              store_code: agent.storeCode,
              raw_data: item,
              staging_status: "pending",
              ...item,
            };
            delete row.id; // prevent PK conflict
            const { error } = await sb.from(table).insert(row);
            if (error) { errors++; } else { inserts++; }
          } catch { errors++; }
        }
      }

      // Formulas
      for (const f of (body.formulas || [])) {
        try {
          const { data: fRow, error: fErr } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId, account: agent.account, store_code: agent.storeCode,
            cor_id: f.cor_id || "", nome_cor: f.nome_cor, cod_produto: f.cod_produto,
            id_base: f.id_base, id_embalagem: f.id_embalagem, subcolecao: f.subcolecao,
            volume_final_ml: f.volume_final_ml, preco_final: f.preco_final,
            personalizada: f.personalizada || false, raw_data: f, staging_status: "pending",
          }).select("id").single();
          if (fErr) { errors++; continue; }
          for (const it of (f.itens || [])) {
            await sb.from("tint_staging_formula_itens").insert({
              sync_run_id: runId, staging_formula_id: fRow?.id,
              id_corante: it.id_corante || "", ordem: it.ordem, qtd_ml: it.qtd_ml,
            });
          }
          inserts++;
        } catch { errors++; }
      }

      // Preparations
      for (const p of (body.preparacoes || [])) {
        try {
          const { data: pRow, error: pErr } = await sb.from("tint_staging_preparacoes").insert({
            sync_run_id: runId, account: agent.account, store_code: agent.storeCode,
            preparacao_id: p.preparacao_id || "", cor_id: p.cor_id, nome_cor: p.nome_cor,
            cod_produto: p.cod_produto, id_base: p.id_base, id_embalagem: p.id_embalagem,
            volume_ml: p.volume_ml, preco: p.preco, cliente: p.cliente,
            data_preparacao: p.data_preparacao, personalizada: p.personalizada || false,
            raw_data: p, staging_status: "pending",
          }).select("id").single();
          if (pErr) { errors++; continue; }
          for (const it of (p.itens || [])) {
            await sb.from("tint_staging_preparacao_itens").insert({
              sync_run_id: runId, staging_preparacao_id: pRow?.id,
              id_corante: it.id_corante || "", ordem: it.ordem, qtd_ml: it.qtd_ml,
            });
          }
          inserts++;
        } catch { errors++; }
      }

      await completeSyncRun(runId, { duration_ms: Date.now() - start, total: inserts, inserts, updates: 0, errors });
      return json({ ok: true, run_id: runId, inserts, errors });
    }

    return json({ error: `Unknown endpoint: ${path}` }, 404);
  } catch (e) {
    console.error("tint-sync-agent error:", e);
    return json({ error: e.message || "Internal error" }, 500);
  }
});
