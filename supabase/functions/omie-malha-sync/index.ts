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

// O Omie sinaliza ERRO de negócio E fim-de-paginação pelo MESMO canal: HTTP 200 + `faultstring`
// (nunca por status HTTP). Checar só `resp.ok` deixaria uma faultstring do meio virar "página vazia"
// → sync para cedo e marca "ok" com malha TRUNCADA (o pior modo de falha da F1A).
// FIM_PAGINACAO = faultstrings que significam "acabou" (não é erro) → para o loop.
// TRANSITORIO = flakiness do servidor Omie/rede → re-tenta com backoff (idem omie-analytics-sync).
// Fail-safe: faultstring NÃO reconhecida como fim nem transitório → THROW (run vira "erro" VISÍVEL,
// nunca "ok" silencioso). ListarEstruturas é não-confirmado — CONFIRMAR/AJUSTAR estes marcadores no probe.
const FIM_PAGINACAO = ["não existem registros", "nao existem registros", "nenhum registro",
  "não foram encontrados", "nao foram encontrados", "consulta não retornou", "consulta nao retornou",
  "página informada", "pagina informada"];
const TRANSITORIO = ["broken response", "soap-error", "timeout", "timed out", "network",
  "connection", "fetch failed", "500", "502", "503", "504", "429", "too many", "rate limit"];

function omieCreds() {
  const key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!key || !secret) throw new Error("OMIE_COLACOR_APP_KEY/SECRET ausentes no ambiente");
  return { key, secret };
}

// Retorna o objeto da malha, OU null quando o Omie sinaliza FIM de paginação (não é erro).
async function omieCall(call: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const creds = omieCreds();
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  const MAX = 4;
  let lastErr: Error | null = null;
  for (let tentativa = 1; tentativa <= MAX; tentativa++) {
    try {
      const resp = await fetch(`${OMIE_API_URL}/geral/malha/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const fault = typeof parsed.faultstring === "string" ? parsed.faultstring : "";
      if (fault) {
        const f = fault.toLowerCase();
        if (FIM_PAGINACAO.some((m) => f.includes(m))) return null; // fim normal — NÃO é erro
        throw new Error(`Omie ${call}: ${fault}`);                 // erro de negócio (classificado no catch)
      }
      if (!resp.ok) throw new Error(`Omie ${call} HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return parsed;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const m = lastErr.message.toLowerCase();
      // transitório (inclui JSON malformado/resposta cortada) re-tenta; permanente (credencial/validação) falha já
      const transitorio = TRANSITORIO.some((t) => m.includes(t)) || m.includes("json") || m.includes("unexpected");
      if (transitorio && tentativa < MAX) {
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, tentativa - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie ${call}: falha após ${MAX} tentativas`);
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

  let runId: number | null = null;
  try {
    if (action === "probe") {
      const resp = await omieCall("ListarEstruturas", { nPagina: 1, nRegPorPagina: 2 });
      if (resp === null) {
        return new Response(JSON.stringify({ aviso: "Omie sinalizou fim/vazio já na página 1 (catálogo sem estruturas?)" },
          null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
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
    runId = run.id; // eleva p/ o catch fechar o run se algo lançar (não deixar 'rodando' órfão)

    let paginas = 0, registros = 0, shapeErr = 0;
    let sampleErr: unknown = null;
    const syncedAt = new Date().toISOString();

    for (let pagina = desdePagina; pagina <= MAX_PAGINAS; pagina++) {
      const resp = await omieCall("ListarEstruturas", { nPagina: pagina, nRegPorPagina: REG_POR_PAGINA });
      if (resp === null) break;                  // Omie sinalizou FIM via faultstring (não é erro)
      const lista = extractLista(resp);
      if (!lista || lista.length === 0) break;   // página vazia — nunca confiar em total_de_paginas
      paginas++;

      // dedupe DENTRO da página: upsert com PK repetida no MESMO statement quebra
      // ("cannot affect row a second time"); entre páginas o upsert resolve.
      const byCod = new Map<number, Record<string, unknown>>();
      for (const item of lista) {
        const cod = extractPaiCodigo(item);
        if (Number.isNaN(cod)) { shapeErr++; sampleErr ??= item; continue; }
        byCod.set(cod, { omie_codigo_produto: cod, payload: item, sync_run_id: runId, synced_at: syncedAt });
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
    // LIMITAÇÃO CONHECIDA (painel, Important #3): a limpeza de órfãos só roda no caminho normal
    // (desde_pagina === 1). Um sync que precisou de RESUME (raro: ~40 páginas cabem em 1 execução)
    // não limpa — estruturas removidas no Omie sobrevivem até o próximo sync completo sem resume.
    // Não corrompe (só deixa órfão a mais); a reconciliação da Fase 2 (cron + frescor) fecha isso.
    let limpos = 0, limpezaPulada = false;
    if (shapeErr === 0 && desdePagina === 1) {
      const { data: ultimoOk } = await supabase.from("pcp_run_logs")
        .select("registros").eq("funcao", "omie-malha-sync").eq("status", "ok")
        .not("registros", "is", null).order("id", { ascending: false }).limit(1).maybeSingle();
      const plausivel = !ultimoOk?.registros || registros >= 0.9 * ultimoOk.registros;
      if (plausivel) {
        // sync_run_id é NOT NULL (M1) → .neq apaga TODOS os outros runs sem furo NULL-blind.
        const { count, error: delErr } = await supabase.from("pcp_malha_staging")
          .delete({ count: "exact" }).neq("sync_run_id", runId);
        if (delErr) throw new Error(`limpeza de órfãos: ${delErr.message}`);
        limpos = count ?? 0;
      } else {
        limpezaPulada = true; // run muito menor que o histórico: manter órfãos e ACUSAR
      }
    }

    const status = shapeErr > 0 ? "erro" : "ok";
    await supabase.from("pcp_run_logs").update({
      finished_at: new Date().toISOString(), status, paginas, registros,
      // itens_vistos ≠ registros quando há shape_err: separa "volume gravado" de "volume processado"
      detalhe: { shape_err: shapeErr, sample_err: sampleErr, itens_vistos: registros + shapeErr,
        orfaos_limpos: limpos, limpeza_pulada: limpezaPulada },
    }).eq("id", runId);

    return new Response(JSON.stringify({
      ok: status === "ok", paginas, registros, shape_err: shapeErr,
      orfaos_limpos: limpos, limpeza_pulada: limpezaPulada,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // fecha o run como 'erro' (best-effort) — sem isso ele fica 'rodando' órfão e o Sentinela lê "motor travado"
    if (runId !== null) {
      await supabase.from("pcp_run_logs")
        .update({ finished_at: new Date().toISOString(), status: "erro", detalhe: { erro: msg } })
        .eq("id", runId).then(() => {}, () => {});
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
