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

    // ============ SYNC CATALOGS ============
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
            delete row.id;
            const { error } = await sb.from(table).insert(row);
            if (error) { errors++; } else { inserts++; }
          } catch { errors++; }
        }
      }

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

    // ============ SIMULATE (admin - JWT auth) ============
    if (path === "simulate" && req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return json({ error: "Auth required" }, 401);

      const body = await req.json();
      const settingId = body.setting_id;
      const simulateMode = body.mode || "real_data"; // "real_data" (default) or "synthetic"
      if (!settingId) return json({ error: "setting_id required" }, 400);

      const { data: setting } = await sb.from("tint_integration_settings")
        .select("id, account, store_code")
        .eq("id", settingId)
        .single();
      if (!setting) return json({ error: "Setting not found" }, 404);

      const start = Date.now();

      // Create sync run
      const { data: runData } = await sb.from("tint_sync_runs").insert({
        setting_id: setting.id,
        account: setting.account,
        store_code: setting.store_code,
        sync_type: "simulation",
        source: "simulation",
        status: "running",
      }).select("id").single();
      const runId = runData?.id;
      if (!runId) return json({ error: "Failed to create sync run" }, 500);

      let inserts = 0, errors = 0;
      const debugLog: string[] = [];

      if (simulateMode === "real_data") {
        // ===== REAL DATA MODE: sample from official tables =====
        debugLog.push("Mode: real_data — sampling from official CSV-imported tables");

        // 1) Sample corantes (all, they're few)
        const { data: realCorantes } = await sb.from("tint_corantes")
          .select("id_corante_sayersystem, descricao, preco_litro")
          .eq("account", setting.account);
        debugLog.push(`Found ${realCorantes?.length || 0} corantes in official table`);

        for (const c of (realCorantes || [])) {
          const { error } = await sb.from("tint_staging_corantes").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            id_corante_sayersystem: c.id_corante_sayersystem,
            descricao: c.descricao,
            preco_litro: c.preco_litro,
            raw_data: c, staging_status: "pending",
          });
          error ? errors++ : inserts++;
        }

        // 2) Sample formulas (take 20 with variety: 15 exact, 3 with price change, 2 new synthetic)
        const { data: realFormulas } = await sb.from("tint_formulas")
          .select(`
            cor_id, nome_cor, volume_final_ml, preco_final_sayersystem,
            produto_id, base_id, embalagem_id,
            tint_produtos!inner(cod_produto),
            tint_bases!inner(id_base_sayersystem),
            tint_embalagens!inner(id_embalagem_sayersystem)
          `)
          .eq("account", setting.account)
          .limit(20);

        debugLog.push(`Sampled ${realFormulas?.length || 0} formulas from official table`);

        const formulaRows = realFormulas || [];
        for (let i = 0; i < formulaRows.length; i++) {
          const f = formulaRows[i] as any;
          const codProduto = f.tint_produtos?.cod_produto;
          const idBase = f.tint_bases?.id_base_sayersystem;
          const idEmbalagem = f.tint_embalagens?.id_embalagem_sayersystem;

          // For items 15-17: introduce price divergence
          let preco = f.preco_final_sayersystem;
          let nome = f.nome_cor;
          if (i >= 15 && i < 18) {
            preco = preco != null ? Number((preco * 1.05).toFixed(4)) : 10.0; // 5% increase
            debugLog.push(`Formula ${f.cor_id}: price modified from ${f.preco_final_sayersystem} → ${preco} (divergence test)`);
          }

          const key = `${f.cor_id}|${codProduto}|${idBase}|${idEmbalagem}`;
          debugLog.push(`Staging formula key: ${key}`);

          const { data: fRow, error: fErr } = await sb.from("tint_staging_formulas").insert({
            sync_run_id: runId, account: setting.account, store_code: setting.store_code,
            cor_id: f.cor_id, nome_cor: nome, cod_produto: codProduto,
            id_base: idBase, id_embalagem: idEmbalagem,
            volume_final_ml: f.volume_final_ml, preco_final: preco,
            personalizada: false, raw_data: { ...f, _sim_index: i },
            staging_status: "pending",
          }).select("id").single();
          if (fErr) { errors++; debugLog.push(`ERROR staging formula ${f.cor_id}: ${fErr.message}`); }
          else { inserts++; }
        }

        // 3) Add 2 synthetic formulas that won't match (only_sync test)
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
        // ===== SYNTHETIC MODE (legacy) =====
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

      // Run reconciliation
      const { data: reconResult, error: reconErr } = await sb.rpc("tint_run_reconciliation", { p_sync_run_id: runId });

      return json({
        ok: true,
        run_id: runId,
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
      if (!authHeader) return json({ error: "Auth required" }, 401);

      const body = await req.json();
      const syncRunId = body.sync_run_id;
      if (!syncRunId) return json({ error: "sync_run_id required" }, 400);

      const { data: result, error } = await sb.rpc("tint_run_reconciliation", { p_sync_run_id: syncRunId });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, ...result });
    }

    return json({ error: `Unknown endpoint: ${path}` }, 404);
  } catch (e) {
    console.error("tint-sync-agent error:", e);
    return json({ error: e.message || "Internal error" }, 500);
  }
});
