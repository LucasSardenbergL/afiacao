// Edge Function: omie-aplicar-parametros
// Aplica parâmetros (estoque mínimo, ponto de pedido, máximo) da fila no Omie.
// Body: { empresa: 'OBEN', ids: number[] } — IDs de fila_aplicacao_omie a aplicar.
// Para cada ID: revalida prontidão, chama Omie AlterarProduto, grava resposta.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OMIE_URL = "https://app.omie.com.br/api/v1/geral/produtos/";
const RATE_LIMIT_DELAY_MS = 1100; // 60 req/min

async function omieAlterarProduto(
  appKey: string,
  appSecret: string,
  codigoProduto: string,
  estoqueMinimo: number,
  pontoPedido: number,
  attempt = 1
): Promise<any> {
  try {
    const res = await fetch(OMIE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: "AlterarProduto",
        app_key: appKey,
        app_secret: appSecret,
        param: [
          {
            codigo_produto: Number(codigoProduto),
            // No Omie: "estoque_minimo" = mínimo; "estoque_maximo" do cadastro = ponto de pedido
            estoque_minimo: Number(estoqueMinimo),
            estoque_maximo: Number(pontoPedido),
          },
        ],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`AUTH_ERROR: Omie retornou ${res.status}`);
    }

    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!res.ok || json?.faultstring) {
      const msg = json?.faultstring || `HTTP ${res.status}: ${text.slice(0, 200)}`;
      if (attempt < 3 && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
        return omieAlterarProduto(
          appKey,
          appSecret,
          codigoProduto,
          estoqueMinimo,
          pontoPedido,
          attempt + 1
        );
      }
      return { __error: true, mensagem: msg, raw: json };
    }

    return { __ok: true, raw: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("AUTH_ERROR")) throw err;
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      return omieAlterarProduto(
        appKey,
        appSecret,
        codigoProduto,
        estoqueMinimo,
        pontoPedido,
        attempt + 1
      );
    }
    return { __error: true, mensagem: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let empresa = "OBEN";
  let ids: number[] = [];
  try {
    const body = await req.json();
    if (body?.empresa) empresa = String(body.empresa).toUpperCase();
    if (Array.isArray(body?.ids)) ids = body.ids.map((x: any) => Number(x)).filter(Boolean);
  } catch (_) {}

  if (ids.length === 0) {
    return new Response(JSON.stringify({ error: "ids vazio" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const appKey = Deno.env.get(`OMIE_${empresa}_APP_KEY`);
  const appSecret = Deno.env.get(`OMIE_${empresa}_APP_SECRET`);
  if (!appKey || !appSecret) {
    return new Response(
      JSON.stringify({ error: `Secrets OMIE_${empresa}_APP_KEY/SECRET ausentes` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Carrega itens da fila — apenas prontos e não aplicados
  const { data: itens, error: filaErr } = await supabase
    .from("fila_aplicacao_omie")
    .select("*")
    .eq("empresa", empresa)
    .in("id", ids)
    .eq("status_validacao", "pronto")
    .is("aplicado_em", null);

  if (filaErr) {
    return new Response(JSON.stringify({ error: filaErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: any[] = [];
  let sucessos = 0;
  let falhas = 0;

  for (const item of itens ?? []) {
    const resp = await omieAlterarProduto(
      appKey,
      appSecret,
      String(item.sku_codigo_omie),
      Number(item.estoque_minimo_novo ?? 0),
      Number(item.ponto_pedido_novo ?? 0)
    );

    const isErr = !!resp?.__error;
    const updateRow: any = {
      aplicado_em: isErr ? null : new Date().toISOString(),
      resposta_omie: resp,
      erro_omie: isErr ? String(resp.mensagem ?? "Erro desconhecido").slice(0, 1000) : null,
    };

    await supabase.from("fila_aplicacao_omie").update(updateRow).eq("id", item.id);

    // Se sucesso, sincroniza o sku_status_omie localmente para refletir aplicação
    if (!isErr) {
      sucessos++;
      await supabase
        .from("sku_status_omie")
        .upsert(
          {
            empresa,
            sku_codigo_omie: String(item.sku_codigo_omie),
            estoque_minimo_omie: item.estoque_minimo_novo,
            ponto_pedido_omie: item.ponto_pedido_novo,
            ultima_sincronizacao: new Date().toISOString(),
            fonte_sincronizacao: "AlterarProduto",
          },
          { onConflict: "empresa,sku_codigo_omie" }
        );
    } else {
      falhas++;
    }

    results.push({
      id: item.id,
      sku: item.sku_codigo_omie,
      ok: !isErr,
      mensagem: isErr ? resp.mensagem : "aplicado",
    });

    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  return new Response(
    JSON.stringify({ ok: true, empresa, total: results.length, sucessos, falhas, results }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
