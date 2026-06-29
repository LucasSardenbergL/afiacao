// ─────────────────────────────────────────────────────────────────────────────
// cmc-snapshot-backfill — Fase 2b (defasagem por cliente).
//
// Popula public.cmc_snapshot com o CMC histórico do Omie (ListarPosEstoque por
// dDataPosicao). Uma RPC Postgres não chama o Omie → este edge é a ponte: lê o
// Omie e ESCREVE no banco (SERVICE_ROLE_KEY + upsert idempotente).
//
// DOIS modos (body.modo):
//  (a) "exato"  — { account, itens:[{ omie_codigo_produto, data_posicao }] }
//      Pra cada item, chama ListarPosEstoque com dDataPosicao = a data EXATA da
//      âncora e grava o nCMC daquele produto naquela data. É a defesa contra o
//      falso-positivo crítico (Codex #1): a grade mensal poderia ver o CMC de uma
//      data distante e fabricar alta-fantasma; o exato-por-âncora elimina isso.
//  (b) "grade"  — { account, dataInicio, dataFim }
//      Pra cada mês no range, pega o CMC de TODOS os produtos numa data-âncora do
//      mês (dia 15) e grava. Cobertura barata de fallback (paginado, bulk).
//
// Espelha cmc-snapshot-smoke (callOmie serializado+retry pro lock do Omie,
// getCredentials, normalizaDataPosicao, auth) + o write do omie-analytics-sync.
// Idempotente: upsert on conflict (account, omie_codigo_produto, data_posicao).
//
// Invocar (exemplos):
//   POST /functions/v1/cmc-snapshot-backfill
//   Authorization: Bearer <JWT staff ou SERVICE_ROLE_KEY>   (ou x-cron-secret)
//   { "modo":"exato", "account":"colacor_vendas",
//     "itens":[{"omie_codigo_produto":1234567890,"data_posicao":"2026-03-20"}] }
//   { "modo":"grade", "account":"vendas", "dataInicio":"2025-01-01", "dataFim":"2026-06-01" }
//   (datas aceitam ISO YYYY-MM-DD ou DD/MM/YYYY; o Omie recebe DD/MM/YYYY)
//
// ── Cron mensal (colar no SQL Editor do Lovable — migration custom NÃO auto-aplica) ──
// Roda dia 1 de cada mês 04:00 UTC, grade do mês anterior nas 3 contas. O
// timeout_milliseconds EXPLÍCITO é OBRIGATÓRIO (default 5s mata o backfill silencioso;
// cron.job_run_details=succeeded só prova o ENQUEUE — a verdade HTTP está em net._http_response).
//
//   SELECT cron.schedule(
//     'cmc-snapshot-backfill-grade-mensal',
//     '0 4 1 * *',
//     $cron$
//     SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/cmc-snapshot-backfill',
//       headers := jsonb_build_object(
//         'Content-Type','application/json',
//         'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
//       ),
//       body := jsonb_build_object(
//         'modo','grade','account','vendas',
//         'dataInicio', to_char(date_trunc('month', now() - interval '1 month'),'YYYY-MM-DD'),
//         'dataFim',    to_char(date_trunc('month', now() - interval '1 month'),'YYYY-MM-DD')
//       ),
//       timeout_milliseconds := 600000
//     );
//     $cron$
//   );
//   -- repetir o bloco trocando account p/ 'colacor_vendas' e 'servicos' (nomes de job distintos).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type OmieAccount = "vendas" | "servicos" | "colacor_vendas";
const CONTAS_VALIDAS: OmieAccount[] = ["vendas", "servicos", "colacor_vendas"];

interface OmieEstoqueProduto {
  nCodProd?: number;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}
interface OmieListarPosEstoqueResponse {
  produtos?: OmieEstoqueProduto[];
  nTotPaginas?: number;
  faultstring?: string;
}

// Mesmas credenciais por conta que o omie-analytics-sync / cmc-snapshot-smoke
// (vendas=Oben, colacor_vendas=Colacor, servicos=Colacor SC).
function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return { key: Deno.env.get("OMIE_OBEN_APP_KEY"), secret: Deno.env.get("OMIE_OBEN_APP_SECRET") };
  }
  if (account === "colacor_vendas") {
    return { key: Deno.env.get("OMIE_COLACOR_APP_KEY"), secret: Deno.env.get("OMIE_COLACOR_APP_SECRET") };
  }
  return { key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"), secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") };
}

// Chamada Omie com retry curto p/ flakiness transitória (mesma família de erros
// que o analytics-sync trata) — INCLUI o lock de concorrência do Omie ("Já existe
// uma requisição desse método sendo executada"). Por isso TODAS as chamadas deste
// edge são serializadas (await sequencial), nunca Promise.all.
async function callOmie(
  account: OmieAccount,
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
): Promise<OmieListarPosEstoqueResponse> {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie (${account}) não configuradas`);
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };

  const maxAttempts = 5;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as OmieListarPosEstoqueResponse;
      if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message.toLowerCase();
      const transient = msg.includes("broken response") || msg.includes("soap-error") ||
        msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
        msg.includes("connection") || msg.includes("fetch failed") ||
        msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500") ||
        msg.includes("já existe uma requisição") || msg.includes("sendo executada") ||
        msg.includes("tente novamente");
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie (${account}): falha após ${maxAttempts} tentativas`);
}

// Aceita ISO (YYYY-MM-DD) ou pt-BR (DD/MM/YYYY) e devolve o que o Omie espera (DD/MM/YYYY).
function normalizaDataPosicao(s: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  throw new Error(`Data inválida "${s}" — use YYYY-MM-DD ou DD/MM/YYYY`);
}

// DD/MM/YYYY → "YYYY-MM-DD" (a coluna data_posicao é date; o upsert grava ISO).
function brParaIso(ddmmyyyy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m) throw new Error(`Data BR inválida "${ddmmyyyy}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Pagina ListarPosEstoque numa data e devolve mapa nCodProd -> nCMC (só CMC > 0).
// Para até a página vazia OU até maxPaginas (guard anti-loop; não confiar só em
// nTotPaginas — armadilha do projeto com a paginação do Omie).
async function cmcPorData(
  account: OmieAccount,
  dDataPosicao: string,
  maxPaginas: number,
  exibeTodos: "S" | "N" = "N",
): Promise<{ mapa: Map<number, number>; paginasLidas: number; totalPaginas: number }> {
  const mapa = new Map<number, number>();
  let pagina = 1;
  let totalPaginas = 1;

  while (pagina <= maxPaginas) {
    const result = await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
      nPagina: pagina,
      nRegPorPagina: 100,
      // "N" (default) = só produtos COM SALDO na data ≈ os que têm CMC atual, que são os
      // ÚNICOS que a RPC usa (sem C_now ela dá neutro). "S" = catálogo inteiro (5-6× mais
      // páginas). Parametrizável pra equilibrar cobertura × tempo de execução da edge.
      cExibeTodos: exibeTodos,
      dDataPosicao,
    });
    totalPaginas = result.nTotPaginas || 1;
    const produtos = result.produtos || [];
    if (produtos.length === 0) break; // página vazia → fim (guard além do nTotPaginas)
    for (const prod of produtos) {
      const cod = Number(prod.nCodProd);
      if (!Number.isSafeInteger(cod) || cod <= 0) continue;
      // "Ausente ≠ zero": só guardamos CMC presente e > 0.
      if (typeof prod.nCMC === "number" && prod.nCMC > 0) mapa.set(cod, prod.nCMC);
    }
    if (pagina >= totalPaginas) break;
    pagina++;
  }
  return { mapa, paginasLidas: Math.min(pagina, maxPaginas), totalPaginas };
}

// Upsert em lote no cmc_snapshot (idempotente: on conflict do update do cmc/synced_at).
async function upsertSnapshot(
  // O client Deno não carrega os tipos do Database (sem geração de types no edge),
  // então `db` é any de propósito — tipar com SupabaseClient estrito quebra o `.upsert`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  rows: Array<{ account: string; omie_codigo_produto: number; data_posicao: string; cmc: number }>,
): Promise<number> {
  let gravados = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error } = await db
      .from("cmc_snapshot")
      .upsert(slice.map((r) => ({ ...r, synced_at: new Date().toISOString() })), {
        onConflict: "account,omie_codigo_produto,data_posicao",
      });
    if (error) {
      console.error("[cmc-snapshot-backfill] upsert:", error);
      throw new Error(`upsert cmc_snapshot falhou: ${error.message ?? error}`);
    }
    gravados += slice.length;
  }
  return gravados;
}

// Datas-âncora mensais (dia 15) entre dataInicio e dataFim (inclusive), em DD/MM/YYYY.
function datasMensais(dataInicioIso: string, dataFimIso: string): string[] {
  const ini = new Date(`${dataInicioIso.slice(0, 7)}-01T00:00:00Z`);
  const fim = new Date(`${dataFimIso.slice(0, 7)}-01T00:00:00Z`);
  if (isNaN(ini.getTime()) || isNaN(fim.getTime()) || ini > fim) {
    throw new Error("dataInicio/dataFim inválidas ou invertidas");
  }
  const out: string[] = [];
  const cur = new Date(ini);
  let guard = 0;
  while (cur <= fim && guard < 60) { // guard: no máx 60 meses (5 anos)
    const dd = "15";
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = cur.getUTCFullYear();
    out.push(`${dd}/${mm}/${yyyy}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
    guard++;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const modo = body.modo as string;
    const account = body.account as OmieAccount;
    const maxPaginas = Math.min(Math.max(Number(body.maxPaginas) || 200, 1), 500);
    // cExibeTodos: "N" (default) = só produtos com saldo (≈ os que têm CMC atual, os
    // únicos que a RPC usa); "S" = catálogo inteiro. Default "N" pra caber mais meses/invoke.
    const exibeTodos: "S" | "N" = body.cExibeTodos === "S" ? "S" : "N";

    if (!CONTAS_VALIDAS.includes(account)) {
      return json({ ok: false, erro: `account inválida — use uma de ${CONTAS_VALIDAS.join(", ")}` }, 400);
    }

    // ── Modo EXATO: CMC as-of a data REAL de cada âncora ──
    if (modo === "exato") {
      const itens = Array.isArray(body.itens) ? body.itens : [];
      if (itens.length === 0) {
        return json({ ok: false, erro: "modo exato requer itens:[{omie_codigo_produto, data_posicao}]" }, 400);
      }
      // Agrupa por data (1 chamada Omie por data distinta cobre todos os produtos dela).
      const codsPorData = new Map<string, Set<number>>(); // dDataPosicao(BR) -> set de cods
      for (const it of itens) {
        const cod = Number(it.omie_codigo_produto);
        if (!Number.isSafeInteger(cod) || cod <= 0) continue;
        const dBR = normalizaDataPosicao(String(it.data_posicao));
        if (!codsPorData.has(dBR)) codsPorData.set(dBR, new Set());
        codsPorData.get(dBR)!.add(cod);
      }
      const rows: Array<{ account: string; omie_codigo_produto: number; data_posicao: string; cmc: number }> = [];
      const porData: Array<{ data: string; pedidos: number; achados: number }> = [];
      // Serializado de propósito (lock do Omie).
      for (const [dBR, cods] of codsPorData) {
        const { mapa } = await cmcPorData(account, dBR, maxPaginas, exibeTodos);
        const dataIso = brParaIso(dBR);
        let achados = 0;
        for (const cod of cods) {
          const cmc = mapa.get(cod);
          if (typeof cmc === "number" && cmc > 0) {
            rows.push({ account, omie_codigo_produto: cod, data_posicao: dataIso, cmc });
            achados++;
          }
        }
        porData.push({ data: dBR, pedidos: cods.size, achados });
      }
      const gravados = rows.length > 0 ? await upsertSnapshot(db, rows) : 0;
      return json({
        ok: true,
        modo: "exato",
        account,
        datasDistintas: codsPorData.size,
        itensPedidos: itens.length,
        snapshotsGravados: gravados,
        porData,
      });
    }

    // ── Modo GRADE: CMC de todos os produtos numa data-âncora mensal (dia 15) ──
    if (modo === "grade") {
      if (!body.dataInicio || !body.dataFim) {
        return json({ ok: false, erro: "modo grade requer dataInicio e dataFim (YYYY-MM-DD ou DD/MM/YYYY)" }, 400);
      }
      const iniIso = brParaIso(normalizaDataPosicao(String(body.dataInicio)));
      const fimIso = brParaIso(normalizaDataPosicao(String(body.dataFim)));
      const datas = datasMensais(iniIso, fimIso);
      let gravadosTotal = 0;
      const porMes: Array<{ data: string; produtos: number; gravados: number; paginas: string }> = [];
      // Serializado (lock do Omie). 1 mês por vez, bulk upsert.
      for (const dBR of datas) {
        const { mapa, paginasLidas, totalPaginas } = await cmcPorData(account, dBR, maxPaginas, exibeTodos);
        const dataIso = brParaIso(dBR);
        const rows = [...mapa.entries()].map(([cod, cmc]) => ({
          account, omie_codigo_produto: cod, data_posicao: dataIso, cmc,
        }));
        const g = rows.length > 0 ? await upsertSnapshot(db, rows) : 0;
        gravadosTotal += g;
        porMes.push({ data: dBR, produtos: mapa.size, gravados: g, paginas: `${paginasLidas}/${totalPaginas}` });
      }
      return json({
        ok: true,
        modo: "grade",
        account,
        meses: datas.length,
        snapshotsGravados: gravadosTotal,
        porMes,
      });
    }

    return json({ ok: false, erro: 'modo inválido — use "exato" ou "grade"' }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, erro: msg }, 500);
  }
});
