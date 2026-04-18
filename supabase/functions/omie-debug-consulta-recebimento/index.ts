// Edge Function: omie-debug-consulta-recebimento
// DESCARTÁVEL — para investigar shape do método ConsultarRecebimento da Omie
// e descobrir como vem o vínculo NFe ↔ Pedido de Compra (campos nIdPedido / nIdItPedido).
//
// Pública (verify_jwt = false). Body:
//   { "empresa": "OBEN" | "COLACOR", "nIdReceb": 123456 }
//
// Doc: https://app.omie.com.br/api/v1/produtos/recebimentonfe/#ConsultarRecebimento
// Endpoint: /api/v1/produtos/recebimentonfe/  método: ConsultarRecebimento
// Param obrigatório: { nIdReceb, cChaveNfe } (qualquer um dos dois identifica)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";

type Empresa = "OBEN" | "COLACOR";

function getCredentials(empresa: Empresa): { app_key: string; app_secret: string } {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) throw new Error("Credenciais OBEN ausentes");
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) throw new Error("Credenciais COLACOR ausentes");
  return { app_key, app_secret };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const empresa = (String(body?.empresa ?? "OBEN").toUpperCase()) as Empresa;
    const nIdReceb = Number(body?.nIdReceb ?? 0);
    const cChaveNfe = body?.cChaveNfe ? String(body.cChaveNfe) : undefined;

    if (!nIdReceb && !cChaveNfe) {
      return new Response(
        JSON.stringify({ ok: false, error: "Informe nIdReceb (number) ou cChaveNfe (string)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (empresa !== "OBEN" && empresa !== "COLACOR") {
      return new Response(
        JSON.stringify({ ok: false, error: "empresa deve ser OBEN ou COLACOR" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { app_key, app_secret } = getCredentials(empresa);

    const param: Record<string, unknown> = {};
    if (nIdReceb) param.nIdReceb = nIdReceb;
    if (cChaveNfe) param.cChaveNfe = cChaveNfe;

    const omieBody = {
      call: "ConsultarRecebimento",
      app_key,
      app_secret,
      param: [param],
    };

    console.log(`[debug-consulta] empresa=${empresa} param=${JSON.stringify(param)}`);

    const t0 = Date.now();
    const res = await fetch(OMIE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(omieBody),
    });
    const text = await res.text();
    const ms = Date.now() - t0;

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    // Log shape
    console.log(`[debug-consulta] HTTP ${res.status} em ${ms}ms`);
    console.log(`[debug-consulta] top-level keys=${JSON.stringify(Object.keys(json ?? {}))}`);

    // Procura recursiva por campos relacionados a pedido de compra
    const candidatos = [
      "nIdPedido", "nIdItPedido", "nCodPed", "nCodPedido",
      "cNumeroPedido", "numero_pedido", "pedidoCompra", "pedidosCompra",
      "listaPedidos", "pedidoReferenciado", "pedidosReferenciados",
    ];
    const achados: Array<{ path: string; value: unknown }> = [];

    function walk(node: unknown, path: string) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          const newPath = path ? `${path}.${k}` : k;
          if (candidatos.includes(k) && v !== null && v !== undefined && v !== "" && v !== 0) {
            achados.push({ path: newPath, value: v });
          }
          walk(v, newPath);
        }
      }
    }
    walk(json, "");

    console.log(`[debug-consulta] CAMPOS-PEDIDO encontrados: ${JSON.stringify(achados, null, 2)}`);

    // Detalha shape do primeiro item (se existir) — é onde, segundo a doc, fica nIdPedido
    const itens =
      json?.itensRecebimento ??
      json?.itens ??
      json?.detalhamento ??
      null;
    if (Array.isArray(itens) && itens.length > 0) {
      console.log(`[debug-consulta] PRIMEIRO ITEM keys=${JSON.stringify(Object.keys(itens[0]))}`);
      console.log(`[debug-consulta] PRIMEIRO ITEM=${JSON.stringify(itens[0], null, 2).slice(0, 4000)}`);
    } else {
      console.log(`[debug-consulta] sem array de itens em itensRecebimento/itens/detalhamento`);
    }

    return new Response(
      JSON.stringify({
        ok: res.ok,
        http_status: res.status,
        duracao_ms: ms,
        empresa,
        param_enviado: param,
        top_level_keys: Object.keys(json ?? {}),
        campos_pedido_encontrados: achados,
        primeiro_item_keys:
          Array.isArray(itens) && itens.length > 0 ? Object.keys(itens[0]) : null,
        payload_completo: json,
      }, null, 2),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[debug-consulta] erro:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
