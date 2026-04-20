// Edge function: omie-sync-estoque
// Sincroniza estoque físico de SKUs habilitados para reposição automática
// usando o endpoint Omie ListarPosicaoEstoque (1 chamada paginada vs N consultas).
//
// Invocação:
//  - Cron diário 06:00 BRT (09:00 UTC) — agendado via pg_cron
//  - Manual: POST { empresa: "OBEN" }

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/estoque/consulta/";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;

type Empresa = "OBEN" | "COLACOR";

interface OmieEstoqueItem {
  cCodigo?: string;
  codigo_produto?: number | string;
  fisico?: number;
  reservado?: number;
  pedidoCompra?: number;
  [k: string]: unknown;
}

interface OmieEstoqueResponse {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotalRegistros?: number;
  produtos?: OmieEstoqueItem[];
  produto_servico_resumido?: OmieEstoqueItem[];
  faultcode?: string;
  faultstring?: string;
}

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function callOmie(
  appKey: string,
  appSecret: string,
  page: number,
  dataPosicao: string,
): Promise<OmieEstoqueResponse> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OMIE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call: "ListarPosicaoEstoque",
          app_key: appKey,
          app_secret: appSecret,
          param: [
            {
              nPagina: page,
              nRegPorPagina: PAGE_SIZE,
              dDataPosicao: dataPosicao,
              cExibeTodos: "S",
            },
          ],
        }),
      });

      if (res.status === 429) {
        console.warn(`[omie-sync-estoque] 429 rate limit page=${page}, sleeping 60s`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        throw new Error(`AUTH_ERROR ${res.status}: ${body}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as OmieEstoqueResponse;
      if (json.faultcode) {
        throw new Error(`Omie fault ${json.faultcode}: ${json.faultstring}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("AUTH_ERROR")) throw err; // não retry auth
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(
        `[omie-sync-estoque] attempt ${attempt}/${MAX_RETRIES} failed page=${page}: ${msg}. retry em ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("Falha desconhecida ao chamar Omie");
}

function getOmieCredentials(empresa: Empresa) {
  if (empresa === "OBEN") {
    return {
      appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
    };
  }
  return {
    appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startedAt = new Date();
  const t0 = performance.now();

  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};
    const empresa: Empresa = (body?.empresa ?? "OBEN") as Empresa;
    if (empresa !== "OBEN" && empresa !== "COLACOR") {
      return new Response(
        JSON.stringify({ error: "empresa inválida. Use OBEN ou COLACOR." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { appKey, appSecret } = getOmieCredentials(empresa);
    if (!appKey || !appSecret) {
      throw new Error(`Credenciais Omie ausentes para ${empresa}`);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // 1) SKUs habilitados
    const { data: habilitadosRows, error: habErr } = await supabase
      .from("sku_parametros")
      .select("sku_codigo_omie, sku_descricao")
      .eq("empresa", empresa)
      .eq("habilitado_reposicao_automatica", true);

    if (habErr) throw new Error(`Erro lendo sku_parametros: ${habErr.message}`);

    const habilitados = (habilitadosRows ?? []) as Array<{
      sku_codigo_omie: number | string;
      sku_descricao: string | null;
    }>;
    const habilitadoMap = new Map<string, string | null>();
    for (const r of habilitados) {
      habilitadoMap.set(String(r.sku_codigo_omie), r.sku_descricao ?? null);
    }
    const totalEsperado = habilitadoMap.size;
    console.log(
      `[omie-sync-estoque] ${empresa}: ${totalEsperado} SKUs habilitados para reposição.`,
    );

    if (totalEsperado === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          empresa,
          total_skus_esperados: 0,
          mensagem: "Nenhum SKU habilitado, nada a sincronizar.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2-3) Paginar Omie
    const dataPosicao = ddmmyyyy(new Date());
    const encontrados = new Map<string, OmieEstoqueItem>();

    let page = 1;
    let totalPaginas = 1;
    let totalRegistros = 0;

    do {
      const resp = await callOmie(appKey, appSecret, page, dataPosicao);
      totalPaginas = resp.nTotPaginas ?? 1;
      totalRegistros = resp.nTotalRegistros ?? totalRegistros;
      const lista = resp.produtos ?? resp.produto_servico_resumido ?? [];
      for (const item of lista) {
        const codigo = String(
          item.codigo_produto ?? item.cCodigo ?? "",
        ).trim();
        if (!codigo) continue;
        if (habilitadoMap.has(codigo)) {
          encontrados.set(codigo, item);
        }
      }
      console.log(
        `[omie-sync-estoque] página ${page}/${totalPaginas} — ${lista.length} itens, ${encontrados.size}/${totalEsperado} casados.`,
      );
      page++;
    } while (page <= totalPaginas);

    console.log(
      `[omie-sync-estoque] varredura concluída: ${totalRegistros} produtos no Omie, ${encontrados.size}/${totalEsperado} habilitados encontrados.`,
    );

    // 4) UPSERT em sku_estoque_atual
    const upsertRows = Array.from(encontrados.entries()).map(([codigo, item]) => {
      const fisico = Number(item.fisico ?? 0);
      const reservado = Number(item.reservado ?? 0);
      const pedidoCompra = Number(item.pedidoCompra ?? 0);
      return {
        empresa,
        sku_codigo_omie: codigo,
        estoque_fisico: fisico,
        estoque_disponivel: fisico - reservado,
        estoque_pendente_entrada: pedidoCompra,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sync: "ListarPosicaoEstoque",
      };
    });

    let sincronizados = 0;
    const errosUpsert: Array<{ sku: string; erro: string }> = [];
    // Upsert em chunks para evitar payload gigante
    const CHUNK = 200;
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const slice = upsertRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("sku_estoque_atual")
        .upsert(slice, { onConflict: "empresa,sku_codigo_omie" });
      if (error) {
        // Fallback: tentar individualmente para isolar SKU problemático
        console.error(
          `[omie-sync-estoque] erro upsert chunk ${i}-${i + slice.length}: ${error.message}. Tentando individual.`,
        );
        for (const row of slice) {
          const { error: e2 } = await supabase
            .from("sku_estoque_atual")
            .upsert(row, { onConflict: "empresa,sku_codigo_omie" });
          if (e2) {
            errosUpsert.push({ sku: row.sku_codigo_omie, erro: e2.message });
          } else {
            sincronizados++;
          }
        }
      } else {
        sincronizados += slice.length;
      }
    }

    // 5) SKUs habilitados que não apareceram → marca inativo + alerta
    const naoEncontrados: string[] = [];
    for (const codigo of habilitadoMap.keys()) {
      if (!encontrados.has(codigo)) naoEncontrados.push(codigo);
    }

    let alertasNovos = 0;
    if (naoEncontrados.length > 0) {
      console.warn(
        `[omie-sync-estoque] ${naoEncontrados.length} SKUs habilitados não vieram do Omie:`,
        naoEncontrados,
      );

      const statusRows = naoEncontrados.map((codigo) => ({
        empresa,
        sku_codigo_omie: codigo,
        sku_descricao: habilitadoMap.get(codigo) ?? null,
        ativo_no_omie: false,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sincronizacao: "nao_apareceu_em_ListarPosicaoEstoque",
      }));

      // Para preservar data_inativacao existente usamos fetch + upsert seletivo
      const { data: existentes } = await supabase
        .from("sku_status_omie")
        .select("sku_codigo_omie, data_inativacao")
        .eq("empresa", empresa)
        .in("sku_codigo_omie", naoEncontrados);

      const existentesMap = new Map(
        (existentes ?? []).map((r) => [r.sku_codigo_omie, r.data_inativacao]),
      );

      const nowIso = new Date().toISOString();
      const enrichedStatus = statusRows.map((r) => ({
        ...r,
        data_inativacao: existentesMap.get(r.sku_codigo_omie) ?? nowIso,
      }));

      const { error: statusErr } = await supabase
        .from("sku_status_omie")
        .upsert(enrichedStatus, { onConflict: "empresa,sku_codigo_omie" });
      if (statusErr) {
        console.error(
          `[omie-sync-estoque] erro upsert sku_status_omie: ${statusErr.message}`,
        );
      }

      // Eventos pendentes existentes para evitar duplicar
      const { data: eventosExistentes } = await supabase
        .from("eventos_outlier")
        .select("sku_codigo_omie")
        .eq("empresa", empresa)
        .eq("tipo", "sku_inativado_omie")
        .eq("status", "pendente")
        .in("sku_codigo_omie", naoEncontrados);

      const jaTemEvento = new Set(
        (eventosExistentes ?? []).map((e) => e.sku_codigo_omie),
      );

      const novosEventos = naoEncontrados
        .filter((c) => !jaTemEvento.has(c))
        .map((codigo) => ({
          empresa,
          sku_codigo_omie: codigo,
          sku_descricao: habilitadoMap.get(codigo) ?? null,
          tipo: "sku_inativado_omie",
          severidade: "atencao",
          data_evento: new Date().toISOString().slice(0, 10),
          detalhes: {
            mensagem:
              "SKU foi inativado no Omie. Decidir: (1) merge histórico com outro SKU, (2) descadastrar do módulo de reposição, (3) reativar manualmente no Omie.",
            detectado_em: new Date().toISOString(),
            fonte: "omie-sync-estoque",
          },
        }));

      if (novosEventos.length > 0) {
        const { error: evErr } = await supabase
          .from("eventos_outlier")
          .insert(novosEventos);
        if (evErr) {
          console.error(
            `[omie-sync-estoque] erro inserindo eventos_outlier: ${evErr.message}`,
          );
        } else {
          alertasNovos = novosEventos.length;
        }
      }
    }

    const finishedAt = new Date();
    const duracaoMs = Math.round(performance.now() - t0);

    const summary = {
      ok: true,
      empresa,
      sync_iniciado_em: startedAt.toISOString(),
      sync_concluido_em: finishedAt.toISOString(),
      duracao_ms: duracaoMs,
      total_skus_esperados: totalEsperado,
      sincronizados,
      nao_encontrados: naoEncontrados.length,
      erros_upsert: errosUpsert.length,
      alertas_novos: alertasNovos,
      paginas_omie: totalPaginas,
      total_produtos_omie: totalRegistros,
      lista_nao_encontrados: naoEncontrados,
      lista_erros: errosUpsert,
    };

    console.log("[omie-sync-estoque] resumo:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.startsWith("AUTH_ERROR");
    console.error(
      `[omie-sync-estoque] ${isAuth ? "CRÍTICO AUTH" : "ERRO"}: ${msg}`,
    );
    return new Response(
      JSON.stringify({
        ok: false,
        error: msg,
        critical: isAuth,
        duracao_ms: Math.round(performance.now() - t0),
      }),
      {
        status: isAuth ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
