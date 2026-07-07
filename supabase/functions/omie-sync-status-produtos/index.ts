// Edge Function: omie-sync-status-produtos
// Sincroniza status (ativo/inativo) e parâmetros atuais de estoque do Omie
// para a tabela sku_status_omie. Usa ListarProdutos paginado (500 por página).
// Aceita empresa OBEN, COLACOR ou ALL (processa todas as suportadas, em série).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { resolverEmpresas, type Empresa } from "../_shared/empresas.ts";
import { coletarProdutosAlvo, type OmieProduto } from "./paginacao.ts";

// Captura o tipo do client pela INFERÊNCIA da chamada (createClient(url,key) infere
// <any,"public",any>); `ReturnType<typeof createClient>` cru daria os defaults <unknown,never>.
function makeClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}
type DB = ReturnType<typeof makeClient>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const OMIE_URL = "https://app.omie.com.br/api/v1/geral/produtos/";
// ListarProdutos CAPA em ~100 registros/página (pedir 500 é IGNORADO — docs/agent/sync.md). O
// catálogo OBEN tem ~3,7k produtos ⇒ ~37 páginas. Antes: série + 700ms de delay proativo → 95–148s
// em prod, encostando no teto de 150s do edge runtime (IDLE_TIMEOUT intermitente, incidente
// 2026-07-06). Agora: POOL concorrente sem delay proativo (freio reativo a 429), paginando até vazio.
const PAGE_SIZE = 100;
// Concorrência 3 (não 4): a MESMA conta Omie é batida pela irmã omie-sync-estoque em paralelo
// (o botão dispara as duas juntas) — 3 dá margem no rate limit compartilhado. ~3 req × ~2s ≈ 1,5 req/s.
const PAGE_CONCURRENCY = 3;
const MAX_PAGINAS = 500; // guard anti-loop (total_de_paginas é PISO, não teto — paginamos até vazio)
const MAX_DURACAO_MS = 120_000; // guard de tempo: aborta honesto ANTES do kill de 150s (sem log órfão)
const MAX_RETRIES = 3;
const RATE_LIMIT_COOLDOWN_MS = 20_000; // recuo REATIVO em 429 (padrão da irmã omie-sync-estoque)
const FETCH_TIMEOUT_MS = 25_000; // bound de CADA request ao Omie (um fetch pendurado não pendura o run)
const FLUSH_THRESHOLD = 100; // persistência sequencial em lotes de 100 SKUs

interface SyncSummary {
  empresa: string;
  total_alvo: number;
  encontrados_na_listagem?: number;
  nao_encontrados?: number;
  sucessos?: number;
  falhas?: number;
  alertas_resolvidos_auto?: number;
  paginas_processadas?: number;
  duration_ms: number;
  mensagem?: string;
  error?: string;
}

async function omieCall(
  appKey: string,
  appSecret: string,
  call: string,
  param: Record<string, unknown>,
  deadline: number, // timestamp absoluto: NUNCA dormir/re-tentar além dele (mantém o run < kill de 150s)
  attempt = 1,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(OMIE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call,
        app_key: appKey,
        app_secret: appSecret,
        param: [param],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`AUTH_ERROR: Omie retornou ${res.status} (verifique secrets)`);
    }

    // 429 = rate limit do Omie. Como paginamos em POOL (sem delay proativo), este é o freio
    // reativo: recua ~20s (com JITTER) e re-tenta. O jitter desincroniza os N workers do pool —
    // sem ele, todos recuam o mesmo tempo e voltam a martelar o Omie juntos (retry herd).
    if (res.status === 429) {
      const jitter = RATE_LIMIT_COOLDOWN_MS * (0.5 + Math.random());
      // Não dormir ALÉM do deadline do run (senão o sleep+retry cruza o kill de 150s → log órfão).
      if (attempt >= MAX_RETRIES || Date.now() + jitter >= deadline) {
        throw new Error("Omie 429: rate limit excedido (retries/deadline)");
      }
      await new Promise((r) => setTimeout(r, jitter));
      return omieCall(appKey, appSecret, call, param, deadline, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text();
      // 404/425 etc — produto inexistente em ConsultarProduto
      if (res.status === 500 && text.includes("SOAP-ENV:Client")) {
        return { __not_found: true, raw: text };
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as Record<string, unknown> & {
      faultstring?: string;
      faultcode?: string;
    };
    // Omie sinaliza erro de aplicação com HTTP 200 + faultcode/faultstring (NÃO !res.ok). A irmã
    // omie-sync-estoque já rejeita isto; sem rejeitar, um fault transiente viraria
    // `produto_servico_cadastro` ausente → [] → "página vazia" → paginação para cedo (money-path P1).
    if (json.faultstring || json.faultcode) {
      throw new Error(
        `Omie fault ${json.faultcode ?? ""}: ${String(json.faultstring ?? "").slice(0, 200)}`,
      );
    }
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("AUTH_ERROR")) throw err;
    const backoff = 500 * Math.pow(2, attempt);
    // Idem 429: não re-tentar/dormir além do deadline do run.
    if (attempt >= MAX_RETRIES || Date.now() + backoff >= deadline) throw err;
    await new Promise((r) => setTimeout(r, backoff));
    return omieCall(appKey, appSecret, call, param, deadline, attempt + 1);
  }
}

// Sincroniza UMA empresa. Cria seu próprio log em sync_reprocess_log (granularidade por
// empresa) e devolve um SyncSummary — nunca lança: erros viram { ...error } para não
// abortar as demais empresas num run "ALL".
async function sincronizarEmpresa(supabase: DB, empresa: Empresa): Promise<SyncSummary> {
  const startedAt = Date.now();

  // Inicia log
  const { data: logRow } = await supabase
    .from("sync_reprocess_log")
    .insert({
      entity_type: "sku_status_omie",
      account: empresa.toLowerCase(),
      reprocess_type: "status_produtos",
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      status: "running",
      metadata: { empresa },
    })
    .select("id")
    .single();
  const logId = logRow?.id as string | undefined;

  const appKey = Deno.env.get(`OMIE_${empresa}_APP_KEY`);
  const appSecret = Deno.env.get(`OMIE_${empresa}_APP_SECRET`);
  if (!appKey || !appSecret) {
    const msg = `Secrets OMIE_${empresa}_APP_KEY/SECRET não configurados`;
    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({ status: "failed", error_message: msg, duration_ms: Date.now() - startedAt })
        .eq("id", logId);
    }
    return { empresa, total_alvo: 0, duration_ms: Date.now() - startedAt, error: msg };
  }

  try {
    // 1) Lista de SKUs alvo: aqueles cujo fornecedor está habilitado para essa empresa.
    // Leituras paginadas (.range() + .order estável): o PostgREST capa em 1000 linhas
    // silencioso e estes conjuntos crescem com o catálogo de reposição. Ver _shared/paginate.ts.
    const fornecedoresHab = await fetchAll<{ fornecedor_nome: string }>(
      (f, t) =>
        supabase
          .from("fornecedor_habilitado_reposicao")
          .select("fornecedor_nome")
          .eq("empresa", empresa)
          .eq("habilitado", true)
          .order("fornecedor_nome", { ascending: true })
          .range(f, t),
      "fornecedor_habilitado_reposicao",
    );
    const fornecNomes = fornecedoresHab.map((r) => r.fornecedor_nome);

    const skus = await fetchAll<{ sku_codigo_omie: string | number }>(
      (f, t) => {
        let q = supabase
          .from("sku_parametros")
          .select("sku_codigo_omie, sku_descricao, fornecedor_nome")
          .eq("empresa", empresa);
        if (fornecNomes.length > 0) q = q.in("fornecedor_nome", fornecNomes);
        return q.order("sku_codigo_omie", { ascending: true }).range(f, t);
      },
      "sku_parametros",
    );

    const alvoSet = new Set<string>(skus.map((s) => String(s.sku_codigo_omie)));
    const totalAlvo = alvoSet.size;

    if (totalAlvo === 0) {
      if (logId) {
        await supabase
          .from("sync_reprocess_log")
          .update({
            status: "complete",
            duration_ms: Date.now() - startedAt,
            metadata: { empresa, total_alvo: 0, mensagem: "Nenhum SKU com fornecedor habilitado" },
          })
          .eq("id", logId);
      }
      return {
        empresa,
        total_alvo: 0,
        duration_ms: Date.now() - startedAt,
        mensagem: "Nenhum SKU alvo",
      };
    }

    // 2) Coleta concorrente do ListarProdutos (POOL + paginate-até-vazio — ver ./paginacao.ts).
    // A coleta (I/O do Omie, concorrente) é SEPARADA da persistência (upsert sequencial): não há
    // escrita concorrente. Antes: série + 700ms/página → 95–148s (timeout intermitente); agora ~25–40s.
    let sucessos = 0;
    let falhas = 0;
    const deadline = startedAt + MAX_DURACAO_MS; // teto absoluto do run (compartilhado pool + omieCall)
    const { produtos, encontrados, paginasProcessadas } = await coletarProdutosAlvo(
      async (pagina) => {
        const resp = await omieCall(appKey, appSecret, "ListarProdutos", {
          pagina,
          registros_por_pagina: PAGE_SIZE,
          apenas_importado_api: "N",
          filtrar_apenas_omiepdv: "N",
        }, deadline);
        return {
          produtos:
            (resp as { produto_servico_cadastro?: OmieProduto[] }).produto_servico_cadastro ?? [],
          totalPaginas: Number((resp as { total_de_paginas?: number }).total_de_paginas ?? 1),
        };
      },
      alvoSet,
      { concurrency: PAGE_CONCURRENCY, maxPaginas: MAX_PAGINAS, maxDuracaoMs: MAX_DURACAO_MS },
    );
    const encontradosNaListagem = encontrados.size;

    // Chegamos aqui SÓ com alvos > 0 (early-return acima). Se o Omie devolveu a 1ª página vazia,
    // é anomalia (o catálogo OBEN tem ~3,7k produtos) — NÃO marcar os alvos como nao_existe_omie
    // (null LIBERA no gate de compra). Fail-closed: falha a sync e re-tenta.
    if (paginasProcessadas === 0) {
      throw new Error("ListarProdutos devolveu catálogo vazio com alvos pendentes — abort (money-path)");
    }

    // Monta os upserts a partir dos produtos alvo coletados (1 timestamp por run, consistente).
    const agora = new Date().toISOString();
    const upserts: Record<string, unknown>[] = produtos.map((p) => {
      const inativo = (p.inativo ?? "N").toUpperCase() === "S";
      return {
        empresa,
        sku_codigo_omie: String(p.codigo_produto ?? ""),
        sku_descricao: p.descricao ?? null,
        ativo_no_omie: !inativo,
        data_inativacao: inativo ? agora : null,
        estoque_minimo_omie: p.estoque_minimo ?? p.dadosArmazenamento?.estoque_minimo ?? null,
        // No Omie, "estoque_maximo" do cadastro funciona como ponto de pedido
        ponto_pedido_omie: p.estoque_maximo ?? p.dadosArmazenamento?.estoque_maximo ?? null,
        estoque_maximo_omie: null, // Omie não distingue máximo separado
        ultima_sincronizacao: agora,
        fonte_sincronizacao: "ListarProdutos",
      };
    });

    // Persiste em lotes sequenciais (a coleta já terminou — zero escrita concorrente).
    for (let i = 0; i < upserts.length; i += FLUSH_THRESHOLD) {
      const lote = upserts.slice(i, i + FLUSH_THRESHOLD);
      const { error: upErr } = await supabase
        .from("sku_status_omie")
        .upsert(lote, { onConflict: "empresa,sku_codigo_omie" });
      if (upErr) {
        falhas += lote.length;
        console.error("Upsert lote falhou:", upErr.message);
      } else {
        sucessos += lote.length;
      }
    }

    // Fail-closed money-path (Codex challenge 2026-07-06, P1): se a persistência do STATUS falhou em
    // algum lote, o snapshot está PARCIAL. Abortar ANTES dos efeitos colaterais que LEEM esse snapshot
    // (espelho omie_products + auto-resolução de alertas) — senão eles agiriam sobre dados incompletos
    // (ex.: fechar um alerta de SKU inativado por ler ativos parciais). Cai no catch → log 'failed' →
    // ok:false (o chamador não recalcula). Falha SÓ no nao_existe (abaixo) é pega no fail-closed final.
    if (falhas > 0) {
      throw new Error(`${falhas} upserts de status falharam — snapshot parcial (money-path)`);
    }

    // 2.5) Espelhar status ativo/inativo na tabela omie_products (catálogo).
    // Várias funções/RPCs (ex.: gerar_pedidos_sugeridos_ciclo) consultam omie_products.ativo,
    // então mantemos os dois em sincronia para evitar SKUs inativos entrando em pedidos.
    try {
      const account = empresa.toLowerCase();
      // Paginado: este espelho governa o gate de `ativo` no catálogo de venda. Truncar em
      // 1000 deixaria a cauda stale nos DOIS sentidos (inativo→vendável / reativado→bloqueado).
      const encontradosStatus = await fetchAll<{ sku_codigo_omie: string | number; ativo_no_omie: boolean | null }>(
        (f, t) =>
          supabase
            .from("sku_status_omie")
            .select("sku_codigo_omie, ativo_no_omie")
            .eq("empresa", empresa)
            .in("fonte_sincronizacao", ["ListarProdutos"])
            .not("ativo_no_omie", "is", null)
            .order("sku_codigo_omie", { ascending: true })
            .range(f, t),
        "sku_status_omie:espelho",
      );

      const inativos = encontradosStatus
        .filter((r) => r.ativo_no_omie === false)
        .map((r) => Number(r.sku_codigo_omie))
        .filter((n) => Number.isFinite(n));
      const ativos = encontradosStatus
        .filter((r) => r.ativo_no_omie === true)
        .map((r) => Number(r.sku_codigo_omie))
        .filter((n) => Number.isFinite(n));

      if (inativos.length > 0) {
        const { error: opErr } = await supabase
          .from("omie_products")
          .update({ ativo: false })
          .eq("account", account)
          .in("omie_codigo_produto", inativos);
        if (opErr) console.error("Espelhar inativos em omie_products falhou:", opErr.message);
      }
      if (ativos.length > 0) {
        // Reativa apenas os que estão marcados ativos no Omie (em lotes para não estourar payload)
        const CHUNK = 500;
        for (let i = 0; i < ativos.length; i += CHUNK) {
          const slice = ativos.slice(i, i + CHUNK);
          const { error: opErr2 } = await supabase
            .from("omie_products")
            .update({ ativo: true })
            .eq("account", account)
            .in("omie_codigo_produto", slice);
          if (opErr2) console.error("Reativar em omie_products falhou:", opErr2.message);
        }
      }
    } catch (e) {
      console.error(
        "[omie-sync-status-produtos] espelhamento omie_products falhou:",
        e instanceof Error ? e.message : String(e),
      );
    }

    // 3) SKUs alvo que NÃO foram encontrados na listagem → marcar como nao_existe_omie
    const naoEncontrados: string[] = [];
    for (const cod of alvoSet) {
      if (!encontrados.has(cod)) naoEncontrados.push(cod);
    }

    if (naoEncontrados.length > 0) {
      const upsertsNE = naoEncontrados.map((cod) => ({
        empresa,
        sku_codigo_omie: cod,
        ativo_no_omie: null,
        data_inativacao: null,
        estoque_minimo_omie: null,
        ponto_pedido_omie: null,
        estoque_maximo_omie: null,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sincronizacao: "nao_existe_omie",
      }));
      const { error: neErr } = await supabase
        .from("sku_status_omie")
        .upsert(upsertsNE, { onConflict: "empresa,sku_codigo_omie" });
      if (neErr) {
        falhas += naoEncontrados.length;
        console.error("Upsert nao_existe_omie falhou:", neErr.message);
      }
    }

    // 4) Auto-resolver alertas de SKU inativado quando o SKU voltou a ficar ativo no Omie.
    // Critério: para todos os SKUs desta empresa que aparecem ativos em sku_status_omie,
    // marca como 'resolvido_auto' qualquer evento_outlier pendente de tipo 'sku_inativado_omie'.
    let alertasResolvidosAuto = 0;
    try {
      const ativosAtuais = await fetchAll<{ sku_codigo_omie: string | number }>(
        (f, t) =>
          supabase
            .from("sku_status_omie")
            .select("sku_codigo_omie")
            .eq("empresa", empresa)
            .eq("ativo_no_omie", true)
            .order("sku_codigo_omie", { ascending: true })
            .range(f, t),
        "sku_status_omie:ativos",
      );

      const ativosSet = new Set(
        ativosAtuais.map((r) => String(r.sku_codigo_omie)),
      );

      if (ativosSet.size > 0) {
        const pendentes = await fetchAll<{ id: string; sku_codigo_omie: string | number }>(
          (f, t) =>
            supabase
              .from("eventos_outlier")
              .select("id, sku_codigo_omie")
              .eq("empresa", empresa)
              .eq("tipo", "sku_inativado_omie")
              .eq("status", "pendente")
              .order("id", { ascending: true })
              .range(f, t),
          "eventos_outlier:pendentes",
        );

        const idsParaFechar = pendentes
          .filter((e) => ativosSet.has(String(e.sku_codigo_omie)))
          .map((e) => e.id);

        if (idsParaFechar.length > 0) {
          const { error: resErr } = await supabase
            .from("eventos_outlier")
            .update({
              status: "resolvido_auto",
              decidido_em: new Date().toISOString(),
              decidido_por: "omie-sync-status-produtos",
              justificativa_decisao:
                "SKU voltou a ficar ativo no Omie — alerta resolvido automaticamente.",
            })
            .in("id", idsParaFechar);
          if (resErr) {
            console.error(
              `[omie-sync-status-produtos] erro resolvendo alertas: ${resErr.message}`,
            );
          } else {
            alertasResolvidosAuto = idsParaFechar.length;
          }
        }
      }
    } catch (e) {
      console.error(
        "[omie-sync-status-produtos] auto-resolução de alertas falhou:",
        e instanceof Error ? e.message : String(e),
      );
    }

    const duration = Date.now() - startedAt;
    const summary: SyncSummary = {
      empresa,
      total_alvo: totalAlvo,
      encontrados_na_listagem: encontradosNaListagem,
      nao_encontrados: naoEncontrados.length,
      sucessos,
      falhas,
      alertas_resolvidos_auto: alertasResolvidosAuto,
      paginas_processadas: paginasProcessadas,
      duration_ms: duration,
    };

    // Fail-closed money-path: se QUALQUER upsert de status falhou, o snapshot está PARCIAL. Não
    // deixar o chamador tratar como sucesso (senão recalcula o ciclo com status incompleto → pode
    // liberar SKU cujo `false` não chegou a ser gravado). Log 'failed' + error no retorno (ok:false).
    const erroParcial =
      falhas > 0 ? `${falhas} upserts de status falharam — snapshot parcial (money-path)` : null;

    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({
          status: erroParcial ? "failed" : "complete",
          upserts_count: sucessos,
          duration_ms: duration,
          error_message: erroParcial,
          metadata: {
            ...summary,
            nao_encontrados_lista: naoEncontrados.slice(0, 100),
          },
        })
        .eq("id", logId);
    }

    return erroParcial ? { ...summary, error: erroParcial } : summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`omie-sync-status-produtos (${empresa}) falhou:`, msg);
    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({
          status: "failed",
          error_message: msg.slice(0, 1000),
          duration_ms: Date.now() - startedAt,
        })
        .eq("id", logId);
    }
    return { empresa, total_alvo: 0, duration_ms: Date.now() - startedAt, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = makeClient();

  // Resolve o parâmetro `empresa` (query ou body). Aceita OBEN, COLACOR ou ALL.
  let empresaInput: string | null = null;
  try {
    const url = new URL(req.url);
    empresaInput = url.searchParams.get("empresa");
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.empresa) empresaInput = String(body.empresa);
    }
  } catch (_) { /* parse de body opcional */ }

  const empresas = resolverEmpresas(empresaInput);
  if (!empresas) {
    return new Response(
      JSON.stringify({ error: `Empresa inválida: ${empresaInput}. Use OBEN, COLACOR ou ALL.` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Em série: cada empresa pagina o Omie (~25–40s com o pool concorrente); rodar as empresas em
  // paralelo concorreria no rate limit do Omie. Hoje só OBEN tem alvos (COLACOR sai no early-return).
  const resultados: SyncSummary[] = [];
  for (const emp of empresas) {
    resultados.push(await sincronizarEmpresa(supabase, emp));
  }

  const okGeral = resultados.every((r) => !r.error);
  return new Response(JSON.stringify({ ok: okGeral, empresas, resultados }), {
    status: okGeral ? 200 : 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
