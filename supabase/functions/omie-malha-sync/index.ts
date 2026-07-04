// omie-malha-sync — espelha a ESTRUTURA de produtos (malha) do Omie Colacor para pcp_malha_staging.
// Ações: {action:"probe"} → shape da página 1 (não escreve nada); {action:"sync"} → pagina até vazio + upsert.
// Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camada 0 item 2)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const REG_POR_PAGINA = 50;
const MAX_PAGINAS = 400; // guarda dura: 400×50 = 20k estruturas >> ~1.9k produtos fabricados

function omieCreds() {
  const key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!key || !secret) throw new Error("OMIE_COLACOR_APP_KEY/SECRET ausentes no ambiente");
  return { key, secret };
}

async function omieCall(call: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const creds = omieCreds();
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  let lastErr = "";
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const resp = await fetch(`${OMIE_API_URL}/geral/malha/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (resp.ok) return JSON.parse(text) as Record<string, unknown>;
    lastErr = `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    // 5xx/429 transitórios: backoff simples; 4xx de negócio não adianta repetir
    if (resp.status < 500 && resp.status !== 429) break;
    await new Promise((r) => setTimeout(r, 800 * tentativa));
  }
  throw new Error(`Omie ${call} falhou: ${lastErr}`);
}

// A lista de estruturas pode vir sob nomes diferentes conforme a versão da API — candidatos conhecidos.
// O probe existe para TRAVAR qual é o real antes do sync completo.
function extractLista(resp: Record<string, unknown>): unknown[] | null {
  for (const k of ["listaEstruturas", "estruturas", "malhaCadastro", "cadastros", "estruturasEncontradas"]) {
    const v = resp[k];
    if (Array.isArray(v)) return v;
  }
  // fallback: primeiro valor array do objeto
  for (const v of Object.values(resp)) if (Array.isArray(v)) return v as unknown[];
  return null;
}

// Código do produto-pai: cadeia de candidatos; NaN ⇒ shape_err (nunca inventar id).
function extractPaiCodigo(item: unknown): number {
  const it = item as Record<string, unknown> | null;
  const ident = (it?.ident ?? {}) as Record<string, unknown>;
  const cand = ident.idProduto ?? ident.intCodigo ?? ident.nCodProduto ?? it?.idProduto ?? it?.codigo_produto;
  const n = Number(cand);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // AuthResult da casa (_shared/auth.ts): no erro já traz uma Response 401 pronta (com CORS) — reusar.
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = (body.action as string) ?? "probe";

  try {
    if (action === "probe") {
      const resp = await omieCall("ListarEstruturas", { nPagina: 1, nRegPorPagina: 2 });
      const lista = extractLista(resp);
      const first = (lista?.[0] ?? null) as Record<string, unknown> | null;
      return new Response(JSON.stringify({
        topKeys: Object.keys(resp),
        listaDetectada: lista ? lista.length : null,
        itemKeys: first ? Object.keys(first) : null,
        identKeys: first?.ident ? Object.keys(first.ident as Record<string, unknown>) : null,
        sampleItem: first, // página de 2 itens: pequeno o bastante p/ inspeção
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action !== "sync") throw new Error(`action desconhecida: ${String(action)}`);
    // desde_pagina (painel Gemini): retomar um sync que estourou o tempo do edge
    // (estimativa real ~40 páginas ≈ 30-40s; o resume é o seguro, não o caminho normal).
    const desdePagina = Number(body.desde_pagina) || 1;

    const { data: run, error: runErr } = await supabase
      .from("pcp_run_logs")
      .insert({ funcao: "omie-malha-sync", status: "rodando" })
      .select("id").single();
    if (runErr) throw new Error(`pcp_run_logs insert: ${runErr.message}`);

    let paginas = 0, registros = 0, shapeErr = 0;
    let sampleErr: unknown = null;
    const syncedAt = new Date().toISOString();

    for (let pagina = desdePagina; pagina <= MAX_PAGINAS; pagina++) {
      const resp = await omieCall("ListarEstruturas", { nPagina: pagina, nRegPorPagina: REG_POR_PAGINA });
      const lista = extractLista(resp);
      if (!lista || lista.length === 0) break; // até página VAZIA — nunca confiar em total_de_paginas
      paginas++;

      // dedupe DENTRO da página: upsert com PK repetida no MESMO statement quebra
      // ("cannot affect row a second time"); entre páginas o upsert resolve.
      const byCod = new Map<number, Record<string, unknown>>();
      for (const item of lista) {
        const cod = extractPaiCodigo(item);
        if (Number.isNaN(cod)) { shapeErr++; sampleErr ??= item; continue; }
        byCod.set(cod, { omie_codigo_produto: cod, payload: item, sync_run_id: run.id, synced_at: syncedAt });
      }
      const rows = [...byCod.values()];
      if (rows.length > 0) {
        const { error } = await supabase.from("pcp_malha_staging")
          .upsert(rows, { onConflict: "omie_codigo_produto" });
        if (error) throw new Error(`upsert staging p.${pagina}: ${error.message}`);
        registros += rows.length;
      }
      if (lista.length < REG_POR_PAGINA) break; // página incompleta = última
    }

    // Limpeza de órfãos (painel Codex P1: estrutura removida no Omie ficaria eterna no staging)
    // com guarda de plausibilidade (painel Gemini: página vazia prematura = truncamento silencioso —
    // NUNCA limpar se este run veio anormalmente menor que o último ok).
    let limpos = 0, limpezaPulada = false;
    if (shapeErr === 0 && desdePagina === 1) {
      const { data: ultimoOk } = await supabase.from("pcp_run_logs")
        .select("registros").eq("funcao", "omie-malha-sync").eq("status", "ok")
        .not("registros", "is", null).order("id", { ascending: false }).limit(1).maybeSingle();
      const plausivel = !ultimoOk?.registros || registros >= 0.9 * ultimoOk.registros;
      if (plausivel) {
        const { count, error: delErr } = await supabase.from("pcp_malha_staging")
          .delete({ count: "exact" }).neq("sync_run_id", run.id);
        if (delErr) throw new Error(`limpeza de órfãos: ${delErr.message}`);
        limpos = count ?? 0;
      } else {
        limpezaPulada = true; // run muito menor que o histórico: manter órfãos e ACUSAR
      }
    }

    const status = shapeErr > 0 ? "erro" : "ok";
    await supabase.from("pcp_run_logs").update({
      finished_at: new Date().toISOString(), status, paginas, registros,
      detalhe: { shape_err: shapeErr, sample_err: sampleErr, orfaos_limpos: limpos, limpeza_pulada: limpezaPulada },
    }).eq("id", run.id);

    return new Response(JSON.stringify({
      ok: status === "ok", paginas, registros, shape_err: shapeErr,
      orfaos_limpos: limpos, limpeza_pulada: limpezaPulada,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
