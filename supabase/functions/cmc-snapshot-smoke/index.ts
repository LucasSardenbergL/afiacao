// ─────────────────────────────────────────────────────────────────────────────
// cmc-snapshot-smoke — GATE 1 da Fase 2b (defasagem por cliente).
//
// PROVA (ou refuta) a premissa-pivô da 2b: que `ListarPosEstoque` parametrizado
// por `dDataPosicao` devolve o CMC **como estava naquela data** (histórico), e
// não o CMC atual com um rótulo de data.
//
// Método (Codex pediu prova de 2 datas, não 1 chamada): pagina o catálogo em
// DUAS datas distintas, cruza por nCodProd, e mostra quantos SKUs têm nCMC
// DIFERENTE entre as datas. Se vários diferem → dDataPosicao é histórico-real.
// Se ZERO diferem sobre datas bem separadas → SUSPEITO (Omie pode estar
// ignorando o parâmetro) e o backfill da 2b NÃO deve ser construído.
//
// É um edge de DIAGNÓSTICO: só LÊ o Omie, não escreve no banco. Staff-gated.
// Pode ser apagado depois que o gate fechar.
//
// Invocar (exemplo):
//   POST /functions/v1/cmc-snapshot-smoke
//   Authorization: Bearer <JWT staff ou SERVICE_ROLE_KEY>
//   { "account": "colacor_vendas", "dataA": "2026-01-15", "dataB": "2026-06-15",
//     "maxPaginas": 10, "codProdAlvo": 1234567890 }
//   (datas aceitam ISO YYYY-MM-DD ou DD/MM/YYYY; o Omie recebe DD/MM/YYYY)
// ─────────────────────────────────────────────────────────────────────────────
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

// Mesmas credenciais por conta que o omie-analytics-sync (vendas=Oben,
// colacor_vendas=Colacor, servicos=Colacor SC).
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
// que o analytics-sync trata: "broken response"/SOAP/timeout/5xx).
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
        // Lock de concorrência do Omie: recusa 2 chamadas simultâneas do mesmo método.
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

// Pagina ListarPosEstoque numa data e devolve mapa nCodProd -> nCMC (só com CMC > 0).
async function cmcPorData(
  account: OmieAccount,
  dDataPosicao: string,
  maxPaginas: number,
  codAlvo: number | null,
): Promise<{ mapa: Map<number, number>; paginasLidas: number; totalPaginas: number; alvoVisto: boolean }> {
  const mapa = new Map<number, number>();
  let pagina = 1;
  let totalPaginas = 1;
  let alvoVisto = false;

  while (pagina <= totalPaginas && pagina <= maxPaginas) {
    const result = await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
      nPagina: pagina,
      nRegPorPagina: 100,
      dDataPosicao,
    });
    totalPaginas = result.nTotPaginas || 1;
    for (const prod of result.produtos || []) {
      const cod = prod.nCodProd;
      if (!cod) continue;
      if (cod === codAlvo) alvoVisto = true;
      // Só guardamos CMC presente e > 0 — "ausente ≠ zero" (não fabricar custo).
      if (typeof prod.nCMC === "number" && prod.nCMC > 0) mapa.set(cod, prod.nCMC);
    }
    pagina++;
  }
  return { mapa, paginasLidas: pagina - 1, totalPaginas, alvoVisto };
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
    const body = await req.json().catch(() => ({}));
    const account = body.account as OmieAccount;
    const maxPaginas = Math.min(Math.max(Number(body.maxPaginas) || 10, 1), 200);
    const codProdAlvo = body.codProdAlvo != null ? Number(body.codProdAlvo) : null;

    if (!CONTAS_VALIDAS.includes(account)) {
      return json({ ok: false, erro: `account inválida — use uma de ${CONTAS_VALIDAS.join(", ")}` }, 400);
    }
    if (!body.dataA || !body.dataB) {
      return json({ ok: false, erro: "informe dataA e dataB (YYYY-MM-DD ou DD/MM/YYYY)" }, 400);
    }
    const dA = normalizaDataPosicao(String(body.dataA));
    const dB = normalizaDataPosicao(String(body.dataB));

    // Serializado de propósito: o Omie recusa 2 chamadas simultâneas do mesmo
    // método/app_key ("Já existe uma requisição desse método sendo executada").
    const a = await cmcPorData(account, dA, maxPaginas, codProdAlvo);
    const b = await cmcPorData(account, dB, maxPaginas, codProdAlvo);

    // Cruza só SKUs presentes (com CMC>0) nas DUAS datas.
    const EPS = 0.005;
    const exemplos: Array<{ cod: number; cmcA: number; cmcB: number; deltaPerc: number }> = [];
    let comparados = 0;
    let mudaram = 0;
    for (const [cod, cmcA] of a.mapa) {
      const cmcB = b.mapa.get(cod);
      if (cmcB == null) continue;
      comparados++;
      if (Math.abs(cmcB - cmcA) > EPS) {
        mudaram++;
        exemplos.push({ cod, cmcA, cmcB, deltaPerc: Math.round(((cmcB - cmcA) / cmcA) * 1000) / 10 });
      }
    }
    exemplos.sort((x, y) => Math.abs(y.deltaPerc) - Math.abs(x.deltaPerc));

    const alvo = codProdAlvo != null
      ? {
          cod: codProdAlvo,
          cmcA: a.mapa.get(codProdAlvo) ?? null,
          cmcB: b.mapa.get(codProdAlvo) ?? null,
          encontrado: a.alvoVisto || b.alvoVisto,
        }
      : null;

    // Veredito do gate.
    let veredito: string;
    let provado = false;
    if (comparados === 0) {
      veredito =
        "INCONCLUSIVO — nenhum SKU com CMC>0 nas duas datas (aumente maxPaginas, ou as datas/contas não têm catálogo comum).";
    } else if (mudaram > 0) {
      provado = true;
      veredito =
        `PROVADO — ${mudaram}/${comparados} SKUs têm CMC diferente entre ${dA} e ${dB}. dDataPosicao devolve histórico-real → backfill da 2b é viável.`;
    } else {
      veredito =
        `SUSPEITO — 0/${comparados} SKUs mudaram entre ${dA} e ${dB}. Sobre datas bem separadas isso indica que o Omie pode estar IGNORANDO dDataPosicao (devolvendo o atual). NÃO construir o backfill sem investigar.`;
    }

    return json({
      ok: true,
      gate: "GATE-1 dDataPosicao (Fase 2b)",
      account,
      datas: { A: dA, B: dB },
      paginas: { A: `${a.paginasLidas}/${a.totalPaginas}`, B: `${b.paginasLidas}/${b.totalPaginas}`, maxPaginas },
      skusComCmc: { A: a.mapa.size, B: b.mapa.size },
      comparados,
      mudaram,
      provado,
      veredito,
      exemplos: exemplos.slice(0, 12),
      alvo,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, erro: msg }, 500);
  }
});
