// Edge function: omie-sync-condicoes-pagamento
// Busca todas as condições de pagamento do Omie e popula omie_condicao_pagamento_catalogo.
// Cron: 1x por dia 04:00 BRT (07:00 UTC).
// Manual: POST {"empresa": "OBEN"}.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OMIE_URL = "https://app.omie.com.br/api/v1/geral/parcelas/";

function getOmieCreds(empresa: string): { app_key: string; app_secret: string } {
  const up = empresa.toUpperCase();
  const app_key = Deno.env.get(`OMIE_${up}_APP_KEY`);
  const app_secret = Deno.env.get(`OMIE_${up}_APP_SECRET`);
  if (!app_key || !app_secret) {
    throw new Error(`Credenciais Omie ausentes para empresa ${empresa}`);
  }
  return { app_key, app_secret };
}

async function omieCall(
  call: string,
  param: unknown,
  creds: { app_key: string; app_secret: string },
): Promise<any> {
  const r = await fetch(OMIE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call,
      app_key: creds.app_key,
      app_secret: creds.app_secret,
      param: [param],
    }),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Omie ${call}: não-JSON: ${text.slice(0,300)}`); }
  if (!r.ok || json?.faultstring) {
    throw new Error(`Omie ${call} [${r.status}]: ${json?.faultstring ?? text.slice(0,300)}`);
  }
  return json;
}

interface CondPag {
  codigo?: string;
  cCodCondPagto?: string;
  descricao?: string;
  cDescCondPagto?: string;
  nParcelas?: number;
  numero_parcelas?: number;
  cDiasParcelas?: string;
  dias_parcelas?: string;
  inativo?: string;
  cInativo?: string;
}

function normalize(c: CondPag) {
  const codigo = String(c.cCodCondPagto ?? c.codigo ?? "").trim();
  const descricao = String(c.cDescCondPagto ?? c.descricao ?? "").trim();
  const num_parcelas = Number(c.nParcelas ?? c.numero_parcelas ?? 0) || null;
  const dias_parcelas = String(c.cDiasParcelas ?? c.dias_parcelas ?? "").trim() || null;
  const inativoFlag = String(c.cInativo ?? c.inativo ?? "N").toUpperCase();
  return {
    codigo,
    descricao: descricao || codigo,
    num_parcelas,
    dias_parcelas,
    ativo: inativoFlag !== "S",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  let empresa = "OBEN";
  try {
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body?.empresa) empresa = String(body.empresa).toUpperCase();
      } catch { /* sem body, usa default */ }
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const creds = getOmieCreds(empresa);

    // Paginação
    let pagina = 1;
    let totalPaginas = 1;
    let upserts = 0;
    const errosPagina: string[] = [];

    do {
      try {
        const resp = await omieCall(
          "ListarCondicoesPagamento",
          { pagina, registros_por_pagina: 50, apenas_importado_api: "N" },
          creds,
        );
        totalPaginas = Number(resp?.total_de_paginas ?? 1);
        const lista: CondPag[] = resp?.condicoes_pagamento_cadastro ??
          resp?.cadastros ?? resp?.lista ?? [];

        if (lista.length === 0) {
          console.log(`[cond-pgto] página ${pagina}/${totalPaginas} vazia`);
          break;
        }

        const rows = lista
          .map((c) => normalize(c))
          .filter((r) => r.codigo)
          .map((r) => ({
            empresa,
            codigo: r.codigo,
            descricao: r.descricao,
            num_parcelas: r.num_parcelas,
            dias_parcelas: r.dias_parcelas,
            ativo: r.ativo,
            ultima_sincronizacao: new Date().toISOString(),
          }));

        if (rows.length > 0) {
          const { error } = await db
            .from("omie_condicao_pagamento_catalogo")
            .upsert(rows, { onConflict: "empresa,codigo" });
          if (error) throw new Error(`upsert: ${error.message}`);
          upserts += rows.length;
        }

        console.log(`[cond-pgto] página ${pagina}/${totalPaginas} -> ${rows.length} registros`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errosPagina.push(`p${pagina}: ${msg}`);
        console.error(`[cond-pgto] erro página ${pagina}:`, msg);
      }
      pagina++;
    } while (pagina <= totalPaginas);

    const duration = Date.now() - startedAt;
    await db.from("sync_reprocess_log").insert({
      entity_type: "omie_condicoes_pagamento",
      account: empresa,
      reprocess_type: "sync_full",
      window_start: new Date(startedAt).toISOString(),
      window_end: new Date().toISOString(),
      status: errosPagina.length > 0 ? "partial" : "ok",
      upserts_count: upserts,
      duration_ms: duration,
      metadata: { paginas: totalPaginas, erros: errosPagina },
    });

    return new Response(
      JSON.stringify({ ok: true, empresa, upserts, paginas: totalPaginas, erros: errosPagina, duration_ms: duration }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cond-pgto] ERRO FATAL:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
