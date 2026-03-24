import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function parseBrDecimal(value: string | undefined | null): number {
  if (!value || value.trim() === "") return 0;
  return parseFloat(value.trim().replace(",", ".")) || 0;
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCsv(content: string): string[][] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.map((line) => line.split(";").map((c) => c.trim()));
}

type Supabase = ReturnType<typeof createClient>;

const isFormulaImportType = (tipo: string) =>
  tipo === "formulas_padrao" || tipo === "formulas_personalizadas";

// ─── Caches for lookups within a single chunk ───
const produtoCache = new Map<string, string>();
const baseCache = new Map<string, string>();
const embalagemCache = new Map<string, string>();
const coranteCache = new Map<string, string>();
const subcolecaoCache = new Map<string, string>();
const skuCache = new Map<string, string>();

function clearCaches() {
  produtoCache.clear();
  baseCache.clear();
  embalagemCache.clear();
  coranteCache.clear();
  subcolecaoCache.clear();
  skuCache.clear();
}

// ─── Pre-warm all caches with a single query per table ───
async function preWarmCaches(supabase: Supabase, account: string) {
  console.log("[tint-import] Pre-warming caches...");
  const t0 = Date.now();

  const [produtos, bases, embalagens, corantes, subcolecoes, skus] = await Promise.all([
    supabase.from("tint_produtos").select("id, cod_produto").eq("account", account).limit(5000),
    supabase.from("tint_bases").select("id, id_base_sayersystem").eq("account", account).limit(5000),
    supabase.from("tint_embalagens").select("id, id_embalagem_sayersystem").eq("account", account).limit(5000),
    supabase.from("tint_corantes").select("id, id_corante_sayersystem").eq("account", account).limit(5000),
    supabase.from("tint_subcolecoes").select("id, id_subcolecao_sayersystem").eq("account", account).limit(5000),
    supabase.from("tint_skus").select("id, produto_id, base_id, embalagem_id").eq("account", account).limit(10000),
  ]);

  for (const r of produtos.data ?? []) produtoCache.set(`${account}:${r.cod_produto}`, r.id);
  for (const r of bases.data ?? []) baseCache.set(`${account}:${r.id_base_sayersystem}`, r.id);
  for (const r of embalagens.data ?? []) embalagemCache.set(`${account}:${r.id_embalagem_sayersystem}`, r.id);
  for (const r of corantes.data ?? []) coranteCache.set(`${account}:${r.id_corante_sayersystem}`, r.id);
  for (const r of subcolecoes.data ?? []) subcolecaoCache.set(`${account}:${r.id_subcolecao_sayersystem}`, r.id);
  for (const r of skus.data ?? []) skuCache.set(`${account}:${r.produto_id}:${r.base_id}:${r.embalagem_id}`, r.id);

  console.log(`[tint-import] Caches warmed in ${Date.now() - t0}ms: ${produtoCache.size} produtos, ${baseCache.size} bases, ${embalagemCache.size} embalagens, ${coranteCache.size} corantes, ${subcolecaoCache.size} subcolecoes, ${skuCache.size} skus`);
}

async function ensureProduto(supabase: Supabase, account: string, codProduto: string, descricao: string): Promise<string> {
  const key = `${account}:${codProduto}`;
  if (produtoCache.has(key)) return produtoCache.get(key)!;
  const { data: inserted, error } = await supabase.from("tint_produtos").upsert({ account, cod_produto: codProduto, descricao }, { onConflict: "account,cod_produto" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_produtos: ${error.message}`);
  produtoCache.set(key, inserted.id);
  return inserted.id;
}

async function ensureBase(supabase: Supabase, account: string, idBaseSayer: string, descricao: string): Promise<string> {
  const key = `${account}:${idBaseSayer}`;
  if (baseCache.has(key)) return baseCache.get(key)!;
  const { data: inserted, error } = await supabase.from("tint_bases").upsert({ account, id_base_sayersystem: idBaseSayer, descricao }, { onConflict: "account,id_base_sayersystem" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_bases: ${error.message}`);
  baseCache.set(key, inserted.id);
  return inserted.id;
}

async function ensureEmbalagem(supabase: Supabase, account: string, idEmbSayer: string, volumeMl: number, descricao?: string): Promise<string> {
  const key = `${account}:${idEmbSayer}`;
  if (embalagemCache.has(key)) return embalagemCache.get(key)!;
  const { data: inserted, error } = await supabase.from("tint_embalagens").upsert({ account, id_embalagem_sayersystem: idEmbSayer, volume_ml: volumeMl, descricao: descricao || null }, { onConflict: "account,id_embalagem_sayersystem" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_embalagens: ${error.message}`);
  embalagemCache.set(key, inserted.id);
  return inserted.id;
}

async function ensureCorante(supabase: Supabase, account: string, idCoranteSayer: string, descricao: string, volumeMl?: number, pesoEsp?: number, codBarras?: string): Promise<string> {
  const key = `${account}:${idCoranteSayer}`;
  if (coranteCache.has(key)) return coranteCache.get(key)!;
  const row: Record<string, unknown> = { account, id_corante_sayersystem: idCoranteSayer, descricao, volume_total_ml: volumeMl ?? 1000 };
  if (pesoEsp != null) row.peso_especifico = pesoEsp;
  if (codBarras) row.codigo_barras = codBarras;
  const { data: inserted, error } = await supabase.from("tint_corantes").upsert(row, { onConflict: "account,id_corante_sayersystem" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_corantes: ${error.message}`);
  coranteCache.set(key, inserted.id);
  return inserted.id;
}

async function ensureSubcolecao(supabase: Supabase, account: string, idSub: string, descricao: string): Promise<string> {
  const key = `${account}:${idSub}`;
  if (subcolecaoCache.has(key)) return subcolecaoCache.get(key)!;
  const { data: inserted, error } = await supabase.from("tint_subcolecoes").upsert({ account, id_subcolecao_sayersystem: idSub, descricao }, { onConflict: "account,id_subcolecao_sayersystem" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_subcolecoes: ${error.message}`);
  subcolecaoCache.set(key, inserted.id);
  return inserted.id;
}

async function ensureSku(supabase: Supabase, account: string, produtoId: string, baseId: string, embalagemId: string): Promise<string> {
  const key = `${account}:${produtoId}:${baseId}:${embalagemId}`;
  if (skuCache.has(key)) return skuCache.get(key)!;
  const { data: inserted, error } = await supabase.from("tint_skus").upsert({ account, produto_id: produtoId, base_id: baseId, embalagem_id: embalagemId }, { onConflict: "account,produto_id,base_id,embalagem_id" }).select("id").single();
  if (error) throw new Error(`Erro upsert tint_skus: ${error.message}`);
  skuCache.set(key, inserted.id);
  return inserted.id;
}

// ─── Process dados_corantes ───
async function processDadosCorantes(supabase: Supabase, rows: string[][], account: string) {
  let imported = 0, updated = 0, errors = 0;
  const errosDetalhe: Array<{ linha: number; motivo: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const [codigo, descricao, volumeMl, pesoEspecifico, codigoBarras] = rows[i];
      if (!codigo || !descricao) { errors++; errosDetalhe.push({ linha: i + 2, motivo: "codigo ou descricao vazio" }); continue; }
      const existing = coranteCache.has(`${account}:${codigo}`);
      const row: Record<string, unknown> = { account, id_corante_sayersystem: codigo, descricao, volume_total_ml: parseBrDecimal(volumeMl) || 1000, peso_especifico: parseBrDecimal(pesoEspecifico) || null, codigo_barras: codigoBarras || null };
      const { error } = await supabase.from("tint_corantes").upsert(row, { onConflict: "account,id_corante_sayersystem" });
      if (error) { errors++; errosDetalhe.push({ linha: i + 2, motivo: error.message }); }
      else if (existing) { updated++; } else { imported++; }
    } catch (e) { errors++; errosDetalhe.push({ linha: i + 2, motivo: e.message }); }
  }
  return { imported, updated, errors, errosDetalhe };
}

// ─── Process dados_produto_base_embalagem ───
async function processDadosProdutoBaseEmbalagem(supabase: Supabase, rows: string[][], account: string) {
  let imported = 0, updated = 0, errors = 0;
  const errosDetalhe: Array<{ linha: number; motivo: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const [produto, base, embalagem, embalagemConteudoMl] = rows[i];
      if (!produto || !base) { errors++; errosDetalhe.push({ linha: i + 2, motivo: "produto ou base vazio" }); continue; }
      const produtoId = await ensureProduto(supabase, account, produto, produto);
      const idBaseSayer = base.replace(/\s+/g, "_").substring(0, 100);
      const baseId = await ensureBase(supabase, account, idBaseSayer, base);
      const volumeMl = parseBrDecimal(embalagemConteudoMl) || 0;
      const idEmbSayer = embalagem || `EMB_${volumeMl}`;
      const embalagemId = await ensureEmbalagem(supabase, account, idEmbSayer, volumeMl, embalagem);
      await ensureSku(supabase, account, produtoId, baseId, embalagemId);
      imported++;
    } catch (e) { errors++; errosDetalhe.push({ linha: i + 2, motivo: e.message }); }
  }
  return { imported, updated, errors, errosDetalhe };
}

// ─── Process formulas ───
async function processFormulas(supabase: Supabase, rows: string[][], account: string, personalizada: boolean, importacaoId: string) {
  let imported = 0, updated = 0, errors = 0;
  const errosDetalhe: Array<{ linha: number; motivo: string }> = [];
  const offset = personalizada ? 0 : 2;

  for (let i = 0; i < rows.length; i++) {
    try {
      const cols = rows[i];
      const idSeq = parseInt(cols[0]) || null;
      const corId = cols[1];
      const nomeCor = cols[2];
      const idBase = cols[3];
      const baseDesc = cols[4];
      const idEmbalagem = cols[5];
      const embalagemDesc = cols[6];
      const codProduto = cols[7];
      const produtoDesc = cols[8];

      if (!corId || !nomeCor) { errors++; errosDetalhe.push({ linha: i + 2, motivo: "cor_id ou nome_cor vazio" }); continue; }

      let subcolecaoId: string | null = null;
      if (!personalizada) {
        const subcolecaoCode = cols[9] || "";
        const subcolecaoDesc = cols[10] || "";
        if (subcolecaoCode && subcolecaoDesc) {
          subcolecaoId = await ensureSubcolecao(supabase, account, subcolecaoCode, subcolecaoDesc);
        }
      }

      const coranteStart = 9 + offset;
      const corantes: string[] = [];
      for (let c = 0; c < 6; c++) corantes.push(cols[coranteStart + c] || "");
      const qtdStart = coranteStart + 6;
      const qtds: number[] = [];
      for (let c = 0; c < 6; c++) qtds.push(parseBrDecimal(cols[qtdStart + c]));
      const volumeFinalMl = parseBrDecimal(cols[qtdStart + 6]);
      const precoFinal = parseBrDecimal(cols[qtdStart + 7]);
      const dataGeracao = cols[qtdStart + 8] || null;

      // These will be cache hits after pre-warming
      const produtoId = await ensureProduto(supabase, account, codProduto, produtoDesc);
      const baseId = await ensureBase(supabase, account, idBase, baseDesc);
      const embalagemId = await ensureEmbalagem(supabase, account, idEmbalagem, volumeFinalMl, embalagemDesc);
      const skuId = await ensureSku(supabase, account, produtoId, baseId, embalagemId);

      const coranteIds: Array<{ id: string; qtd: number; ordem: number }> = [];
      for (let c = 0; c < 6; c++) {
        if (corantes[c] && qtds[c] > 0) {
          const coranteId = await ensureCorante(supabase, account, corantes[c], corantes[c]);
          coranteIds.push({ id: coranteId, qtd: qtds[c], ordem: c + 1 });
        }
      }

      const formulaRow: Record<string, unknown> = {
        account, cor_id: corId, nome_cor: nomeCor, produto_id: produtoId, base_id: baseId,
        embalagem_id: embalagemId, sku_id: skuId, subcolecao_id: subcolecaoId, id_seq: idSeq,
        volume_final_ml: volumeFinalMl || null, preco_final_sayersystem: precoFinal || null,
        data_geracao: dataGeracao, personalizada, importacao_id: importacaoId,
        updated_at: new Date().toISOString(),
      };

      const { data: existingFormula } = await supabase.from("tint_formulas").select("id")
        .eq("account", account).eq("cor_id", corId).eq("produto_id", produtoId)
        .eq("base_id", baseId).eq("embalagem_id", embalagemId)
        .is("subcolecao_id", subcolecaoId ? undefined : null).maybeSingle();

      let formulaId: string;
      if (existingFormula) {
        const { error } = await supabase.from("tint_formulas").update(formulaRow).eq("id", existingFormula.id);
        if (error) throw new Error(`Erro update formula: ${error.message}`);
        formulaId = existingFormula.id;
        updated++;
      } else {
        const { data: ins, error } = await supabase.from("tint_formulas").insert(formulaRow).select("id").single();
        if (error) throw new Error(`Erro insert formula: ${error.message}`);
        formulaId = ins.id;
        imported++;
      }

      await supabase.from("tint_formula_itens").delete().eq("formula_id", formulaId);
      if (coranteIds.length > 0) {
        const itemRows = coranteIds.map((c) => ({ formula_id: formulaId, corante_id: c.id, qtd_ml: c.qtd, ordem: c.ordem }));
        const { error: itemError } = await supabase.from("tint_formula_itens").insert(itemRows);
        if (itemError) console.error(`[tint-import] Erro inserindo itens formula ${formulaId}:`, itemError);
      }
    } catch (e) { errors++; errosDetalhe.push({ linha: i + 2, motivo: e.message }); }
  }
  return { imported, updated, errors, errosDetalhe };
}

// ─── Legacy file mode handler ───
async function handleFileMode(supabase: Supabase, req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const tipo = formData.get("tipo") as string;
  const account = (formData.get("account") as string) || "oben";

  if (!file || !tipo) {
    return new Response(JSON.stringify({ error: "Campos 'file' e 'tipo' obrigatórios" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const content = await file.text();
  const hash = await sha256(content);

  const { data: existingImport } = await supabase.from("tint_importacoes").select("id, status, created_at")
    .eq("account", account).eq("arquivo_hash", hash).maybeSingle();

  let importacaoId: string;

  if (existingImport) {
    if (isFormulaImportType(tipo)) {
      const { error: resetError } = await supabase.from("tint_importacoes").update({
        status: "processando",
        total_registros: 0,
        registros_importados: 0,
        registros_atualizados: 0,
        registros_erro: 0,
        erros_detalhe: null,
      }).eq("id", existingImport.id);
      if (resetError) throw new Error(`Erro ao reprocessar importação: ${resetError.message}`);
      importacaoId = existingImport.id;
    } else {
      return new Response(JSON.stringify({ status: "duplicado", message: "Este arquivo já foi importado anteriormente", importacao_id: existingImport.id, importado_em: existingImport.created_at }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } else {
    const { data: importacao, error: impError } = await supabase.from("tint_importacoes").insert({ account, tipo, arquivo_nome: file.name, arquivo_hash: hash, status: "processando" }).select("id").single();
    if (impError) throw new Error(`Erro ao criar importação: ${impError.message}`);
    importacaoId = importacao.id;
  }

  const allRows = parseCsv(content);
  if (allRows.length < 2) {
    await supabase.from("tint_importacoes").update({ status: "erro", erros_detalhe: [{ linha: 0, motivo: "CSV vazio ou sem dados" }] }).eq("id", importacaoId);
    return new Response(JSON.stringify({ status: "erro", message: "CSV vazio", importacao_id: importacaoId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const dataRows = allRows.slice(1);
  const totalRegistros = dataRows.length;
  clearCaches();
  await preWarmCaches(supabase, account);

  let result: { imported: number; updated: number; errors: number; errosDetalhe: Array<{ linha: number; motivo: string }> };
  switch (tipo) {
    case "dados_corantes": result = await processDadosCorantes(supabase, dataRows, account); break;
    case "dados_produto_base_embalagem": result = await processDadosProdutoBaseEmbalagem(supabase, dataRows, account); break;
    case "formulas_padrao": result = await processFormulas(supabase, dataRows, account, false, importacaoId); break;
    case "formulas_personalizadas": result = await processFormulas(supabase, dataRows, account, true, importacaoId); break;
    default: throw new Error(`Tipo inválido: ${tipo}`);
  }

  const finalStatus = result.errors > 0 && result.imported === 0 && result.updated === 0 ? "erro" : result.errors > 0 ? "parcial" : "concluido";
  await supabase.from("tint_importacoes").update({ status: finalStatus, total_registros: totalRegistros, registros_importados: result.imported, registros_atualizados: result.updated, registros_erro: result.errors, erros_detalhe: result.errosDetalhe.length > 0 ? result.errosDetalhe.slice(0, 100) : null }).eq("id", importacaoId);

  return new Response(JSON.stringify({ status: finalStatus, importacao_id: importacaoId, total_registros: totalRegistros, registros_importados: result.imported, registros_atualizados: result.updated, registros_erro: result.errors }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Create import record (lightweight, no data processing) ───
async function handleCreateImport(supabase: Supabase, body: Record<string, unknown>) {
  const { tipo, account: rawAccount, arquivo_hash, arquivo_nome, total_rows } = body as {
    tipo: string; account: string; arquivo_hash?: string; arquivo_nome?: string; total_rows?: number;
  };
  const account = rawAccount || "oben";

  if (!tipo) {
    return new Response(JSON.stringify({ error: "Campo 'tipo' obrigatório" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (arquivo_hash) {
    const { data: existingImport } = await supabase.from("tint_importacoes").select("id, status, created_at")
      .eq("account", account).eq("arquivo_hash", arquivo_hash).maybeSingle();
    if (existingImport) {
      if (isFormulaImportType(tipo)) {
        const { error: resetError } = await supabase.from("tint_importacoes").update({
          status: "processando",
          total_registros: total_rows || 0,
          registros_importados: 0,
          registros_atualizados: 0,
          registros_erro: 0,
          erros_detalhe: null,
        }).eq("id", existingImport.id);
        if (resetError) throw new Error(`Erro ao reprocessar importação: ${resetError.message}`);
        return new Response(JSON.stringify({ status: "reprocessando", importacao_id: existingImport.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ status: "duplicado", message: "Este arquivo já foi importado anteriormente", importacao_id: existingImport.id, importado_em: existingImport.created_at }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  const { data: importacao, error: impError } = await supabase.from("tint_importacoes").insert({
    account, tipo, arquivo_nome: arquivo_nome || "chunked_import", arquivo_hash: arquivo_hash || `manual-${crypto.randomUUID()}`,
    status: "processando", total_registros: total_rows || 0,
  }).select("id").single();
  if (impError) throw new Error(`Erro ao criar importação: ${impError.message}`);

  return new Response(JSON.stringify({ status: "criado", importacao_id: importacao.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Finalize import (called by frontend after all chunks) ───
async function handleFinalizeImport(supabase: Supabase, body: Record<string, unknown>) {
  const { importacao_id, failed_chunks } = body as {
    importacao_id: string; registros_importados?: number; registros_atualizados?: number;
    registros_erro?: number; failed_chunks?: number;
  };

  if (!importacao_id) {
    return new Response(JSON.stringify({ error: "importacao_id obrigatório" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: rec } = await supabase.from("tint_importacoes")
    .select("registros_importados, registros_atualizados, registros_erro")
    .eq("id", importacao_id).single();

  const accImported = rec?.registros_importados || 0;
  const accUpdated = rec?.registros_atualizados || 0;
  const accErrors = rec?.registros_erro || 0;

  let status: string;
  if (accImported === 0 && accUpdated === 0) {
    status = "erro";
  } else if ((failed_chunks ?? 0) > 0 || accErrors > 0) {
    status = "concluido_parcial";
  } else {
    status = "concluido";
  }

  await supabase.from("tint_importacoes").update({ status }).eq("id", importacao_id);

  return new Response(JSON.stringify({ status, importacao_id }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Chunk mode handler ───
async function handleChunkMode(supabase: Supabase, body: Record<string, unknown>) {
  const { tipo, account: rawAccount, chunk_index, total_chunks, total_rows, rows, importacao_id } = body as {
    tipo: string; account: string; chunk_index: number; total_chunks: number; total_rows: number;
    rows: string[][]; importacao_id: string;
  };

  const account = rawAccount || "oben";

  if (!tipo || rows == null || chunk_index == null) {
    return new Response(JSON.stringify({ error: "Campos 'tipo', 'chunk_index' e 'rows' obrigatórios" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!importacao_id) {
    return new Response(JSON.stringify({ error: "importacao_id é obrigatório" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(`[tint-import] Processing chunk ${chunk_index + 1}/${total_chunks} (${rows.length} rows) for import ${importacao_id}`);

  clearCaches();
  await preWarmCaches(supabase, account);

  let result: { imported: number; updated: number; errors: number; errosDetalhe: Array<{ linha: number; motivo: string }> };
  switch (tipo) {
    case "dados_corantes": result = await processDadosCorantes(supabase, rows, account); break;
    case "dados_produto_base_embalagem": result = await processDadosProdutoBaseEmbalagem(supabase, rows, account); break;
    case "formulas_padrao": result = await processFormulas(supabase, rows, account, false, importacao_id); break;
    case "formulas_personalizadas": result = await processFormulas(supabase, rows, account, true, importacao_id); break;
    default: throw new Error(`Tipo inválido: ${tipo}`);
  }

  console.log(`[tint-import] Chunk ${chunk_index + 1}/${total_chunks} done: ${result.imported} imported, ${result.updated} updated, ${result.errors} errors`);

  // Accumulate counters on the import record
  const { data: currentRec } = await supabase.from("tint_importacoes").select("registros_importados, registros_atualizados, registros_erro, erros_detalhe").eq("id", importacao_id).single();

  const accImported = (currentRec?.registros_importados || 0) + result.imported;
  const accUpdated = (currentRec?.registros_atualizados || 0) + result.updated;
  const accErrors = (currentRec?.registros_erro || 0) + result.errors;
  const existingErros = (currentRec?.erros_detalhe as Array<{ linha: number; motivo: string }>) || [];
  const accErrosDetalhe = [...existingErros, ...result.errosDetalhe].slice(0, 100);

  await supabase.from("tint_importacoes").update({
    registros_importados: accImported,
    registros_atualizados: accUpdated,
    registros_erro: accErrors,
    erros_detalhe: accErrosDetalhe.length > 0 ? accErrosDetalhe : null,
  }).eq("id", importacao_id);

  return new Response(JSON.stringify({
    status: "processando",
    importacao_id,
    chunk_index,
    registros_importados: result.imported,
    registros_atualizados: result.updated,
    registros_erro: result.errors,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      return await handleFileMode(supabase, req);
    } else {
      const body = await req.json();
      if (body.action === "create_import") {
        return await handleCreateImport(supabase, body);
      }
      if (body.action === "finalize_import") {
        return await handleFinalizeImport(supabase, body);
      }
      return await handleChunkMode(supabase, body);
    }
  } catch (error) {
    console.error("[tint-import] Erro:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
