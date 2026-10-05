import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { mapearItensRecebimento, type OmieRecebimentoItem } from "./itens.ts";
import { mapearCabecalho } from "./cabecalho.ts";
import { avaliarDetalhePorChave, classificarConsultaPorChave, normalizarChaveAcesso } from "./chave.ts";
import { corpoDeFalhaOmie } from "./listagem.ts";
import { type DepsRodada, type ResumoConta, rodadaDaConta } from "./rodada.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ── Local interfaces (Edge Functions bundle independently — no shared types) ──

interface OmieCallParams {
  nPagina?: number;
  nRegistrosPorPagina?: number;
  dtEmissaoDe?: string;
  nIdReceb?: number | string;
  [key: string]: unknown;
}

interface OmieRecebimentoCabec {
  nIdReceb?: number | string;
  nIdNfe?: number | string;
  cNumeroNFe?: number | string;
  cSerieNFe?: string | null;
  cCNPJ_CPF?: string;
  cRazaoSocial?: string | null;
  cNome?: string | null;
  dEmissaoNFe?: string | null;
  nValorNFe?: number | string | null;
  cChaveNFe?: string | null;
  cChaveNfe?: string | null;
}

interface OmieRecebimentoInfoCadastro {
  cCancelada?: string;
  cRecebido?: string;
}

interface OmieConsultarRecebimentoResponse {
  cabec?: OmieRecebimentoCabec;
  itensRecebimento?: OmieRecebimentoItem[];
  infoCadastro?: OmieRecebimentoInfoCadastro;
}

interface WarehouseRow {
  id: string;
}

function jsonResponse(body: Record<string, unknown>, status = 200, headersExtra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...headersExtra, "Content-Type": "application/json" },
  });
}

interface OmieCredentials {
  appKey: string;
  appSecret: string;
  warehouseCode: string;
}

function getCredentials(): OmieCredentials[] {
  const creds: OmieCredentials[] = [];
  const obenKey = Deno.env.get("OMIE_OBEN_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (obenKey && obenSecret) {
    creds.push({ appKey: obenKey, appSecret: obenSecret, warehouseCode: "OB" });
  }
  // CC = Colacor SC (afiação)
  const colacorScKey = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const colacorScSecret = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");
  if (colacorScKey && colacorScSecret) {
    creds.push({ appKey: colacorScKey, appSecret: colacorScSecret, warehouseCode: "CC" });
  }
  return creds;
}

async function omieCall(
  appKey: string,
  appSecret: string,
  endpoint: string,
  method: string,
  params: OmieCallParams,
): Promise<unknown> {
  const res = await fetch(`https://app.omie.com.br/api/v1/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call: method,
      app_key: appKey,
      app_secret: appSecret,
      param: [params],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    // O corpo decide antes do status: o Omie manda "não existem registros" e outras falhas de negócio
    // com HTTP 500 (CC, 2026-10-05). Com `faultstring`, o corpo volta e o chamador classifica
    // (interpretarPaginaListagem / falhaNoCorpo); sem ela, é falha de transporte.
    const corpoDeFalha = corpoDeFalhaOmie(txt);
    if (corpoDeFalha !== null) return corpoDeFalha;
    throw new Error(`Omie ${method} HTTP ${res.status}: ${redigirSegredo(txt.slice(0, 300))}`);
  }
  return await res.json();
}

/** Lote de chaves por `.in()`: 44 dígitos cada — as ~150 de uma rodada numa URL só passariam do seguro. */
const LOTE_CHAVES = 50;

/** O Omie e o banco REAIS da rodada de uma conta (ver rodada.ts). */
function depsDaConta(supabase: SupabaseClient, cred: OmieCredentials, warehouseId: string): DepsRodada {
  return {
    listar: (params) => omieCall(cred.appKey, cred.appSecret, "produtos/recebimentonfe/", "ListarRecebimentos", params),
    consultar: (nIdReceb) =>
      omieCall(cred.appKey, cred.appSecret, "produtos/recebimentonfe/", "ConsultarRecebimento", { nIdReceb }),
    jaImportados: async (ids, chaves) => {
      const idsJa = new Set<number>();
      const chavesJa = new Set<string>();
      if (ids.length > 0) {
        const { data, error } = await supabase
          .from("nfe_recebimentos")
          .select("omie_id_receb")
          .eq("warehouse_id", warehouseId)
          .in("omie_id_receb", ids);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as { omie_id_receb: number | string | null }[]) {
          if (r.omie_id_receb !== null) idsJa.add(Number(r.omie_id_receb));
        }
      }
      for (let i = 0; i < chaves.length; i += LOTE_CHAVES) {
        const { data, error } = await supabase
          .from("nfe_recebimentos")
          .select("chave_acesso")
          .in("chave_acesso", chaves.slice(i, i + LOTE_CHAVES));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as { chave_acesso: string | null }[]) {
          if (r.chave_acesso) chavesJa.add(r.chave_acesso);
        }
      }
      return { ids: idsJa, chaves: chavesJa };
    },
    inserirCabecalho: async (row) => {
      const { data, error } = await supabase.from("nfe_recebimentos").insert(row).select("id").single();
      if (error || !data) return { erro: error?.message ?? "o insert do cabeçalho não devolveu o id" };
      return { id: (data as { id: string }).id };
    },
    inserirItens: (itens, nfeRecebimentoId) => inserirItens(supabase, itens, nfeRecebimentoId),
  };
}

/** Teto da consulta por chave: quem espera é o operador, com o diálogo aberto. */
const OMIE_TIMEOUT_POR_CHAVE_MS = 25_000;

/**
 * Grava os itens de UMA NF-e. Devolve a mensagem do erro, ou `null`. O que fazer com o cabeçalho
 * quando os itens falham é decisão do CHAMADOR, e ela difere entre os dois caminhos — ver o laço
 * do cron e `importarPorChave`.
 */
async function inserirItens(
  supabase: SupabaseClient,
  rawItems: OmieRecebimentoItem[],
  nfeRecebimentoId: string,
): Promise<string | null> {
  if (rawItems.length === 0) return null;
  const { error } = await supabase
    .from("nfe_recebimento_itens")
    .insert(mapearItensRecebimento(rawItems, nfeRecebimentoId));
  return error ? error.message : null;
}

type NfePorChave =
  | { tipo: "existe"; id: string; itens: number }
  | { tipo: "nenhuma" }
  | { tipo: "erro"; mensagem: string };

/** A NF-e já gravada com esta chave e quantos itens ela tem. Contagem ilegível é ERRO, não zero. */
async function buscarPorChave(supabase: SupabaseClient, chave: string): Promise<NfePorChave> {
  const { data, error } = await supabase
    .from("nfe_recebimentos")
    .select("id, nfe_recebimento_itens(count)")
    .eq("chave_acesso", chave)
    .maybeSingle();
  if (error) return { tipo: "erro", mensagem: `ler nfe_recebimentos: ${error.message}` };
  if (!data) return { tipo: "nenhuma" };
  const linha = data as { id: string; nfe_recebimento_itens?: Array<{ count?: unknown }> };
  const itens = linha.nfe_recebimento_itens?.[0]?.count;
  if (typeof itens !== "number") return { tipo: "erro", mensagem: "contagem de itens da NF-e indisponível" };
  return { tipo: "existe", id: linha.id, itens };
}

/**
 * Importa UMA NF-e pela chave de acesso — o botão "Importar NF-e" de /recebimento.
 *
 * O botão chamava `omie-nfe-webhook`, que exige o segredo do webhook do Omie: 401 sempre no
 * browser, que não tem (nem deve ter) esse segredo; e com só a chave aquela edge não teria o que
 * gravar. Aqui o gate é o do topo do handler (`authorizeCronOrStaff`: staff ou cron) e a NF-e vem
 * do Omie, por `ConsultarRecebimento({ cChaveNFe })` na conta do armazém escolhido. Cada desfecho
 * responde `status` + `error` legível; o front lê em `src/lib/recebimento/importacao-resposta.ts`.
 */
async function importarPorChave(supabase: SupabaseClient, corpo: Record<string, unknown>): Promise<Response> {
  const responder = (body: Record<string, unknown>, status: number, headersExtra: Record<string, string> = {}) =>
    jsonResponse({ ...body, versao: VERSAO }, status, headersExtra);

  const chave = normalizarChaveAcesso(corpo.chave_acesso);
  if (!chave) return responder({ status: "entrada_invalida", error: "chave de acesso inválida — são 44 dígitos" }, 400);
  const warehouseId = typeof corpo.warehouse_id === "string" && corpo.warehouse_id ? corpo.warehouse_id : null;
  if (!warehouseId) return responder({ status: "entrada_invalida", error: "armazém (warehouse_id) não informado" }, 400);

  // Dedupe ANTES de gastar a consulta ao Omie (e de arriscar o "consumo redundante" dele).
  const existente = await buscarPorChave(supabase, chave);
  if (existente.tipo === "erro") return responder({ status: "erro_gravacao", error: existente.mensagem }, 500);
  if (existente.tipo === "existe") {
    return responder({ status: "ja_importada", nfe_recebimento_id: existente.id, itens: existente.itens }, 200);
  }

  const { data: wh, error: whErr } = await supabase
    .from("warehouses")
    .select("id, code")
    .eq("id", warehouseId)
    .maybeSingle();
  if (whErr) return responder({ status: "erro_gravacao", error: `ler warehouses: ${whErr.message}` }, 500);
  if (!wh) return responder({ status: "entrada_invalida", error: "armazém não encontrado" }, 400);
  const cred = getCredentials().find((c) => c.warehouseCode === wh.code);
  if (!cred) {
    return responder({ status: "sem_credencial", error: `sem credencial Omie configurada para o armazém ${wh.code}` }, 500);
  }

  let httpStatus: number;
  let corpoOmie: unknown;
  try {
    const res = await fetch("https://app.omie.com.br/api/v1/produtos/recebimentonfe/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: "ConsultarRecebimento",
        app_key: cred.appKey,
        app_secret: cred.appSecret,
        param: [{ cChaveNFe: chave }],
      }),
      signal: AbortSignal.timeout(OMIE_TIMEOUT_POR_CHAVE_MS),
    });
    httpStatus = res.status;
    const texto = await res.text();
    try {
      corpoOmie = JSON.parse(texto);
    } catch {
      corpoOmie = texto;
    }
  } catch (e) {
    const motivo = redigirSegredo(mensagemDeErro(e) ?? "falha de rede sem mensagem");
    return responder({ status: "erro_omie", error: `não consegui consultar o Omie: ${motivo}` }, 502);
  }

  const consulta = classificarConsultaPorChave(httpStatus, corpoOmie);
  if (consulta.tipo === "aguardar") {
    const espera = consulta.segundos ? ` ${consulta.segundos} s` : "";
    return responder(
      { status: "omie_ocupado", error: `O Omie pediu para aguardar${espera} antes de consultar esta NF-e de novo.` },
      429,
      consulta.segundos ? { "Retry-After": String(consulta.segundos) } : {},
    );
  }
  if (consulta.tipo === "recusada") {
    return responder({
      status: "omie_recusou",
      error: `O Omie recusou a consulta (${consulta.mensagem}) — confira a chave e o armazém selecionado.`,
    }, 409);
  }
  if (consulta.tipo === "erro") return responder({ status: "erro_omie", error: consulta.mensagem }, 502);

  const avaliacao = avaliarDetalhePorChave(consulta.detalhe, chave);
  if (avaliacao.tipo === "recusada") {
    const anomalia = avaliacao.status === "chave_divergente" || avaliacao.status === "sem_id_recebimento";
    return responder({ status: avaliacao.status, error: avaliacao.mensagem }, anomalia ? 502 : 409);
  }

  const detalhe = consulta.detalhe as OmieConsultarRecebimentoResponse;
  const { data: nova, error: insErr } = await supabase
    .from("nfe_recebimentos")
    .insert(mapearCabecalho(detalhe.cabec ?? {}, wh.id, chave, avaliacao.nIdReceb))
    .select("id")
    .single();
  if (insErr?.code === "23505") {
    // Outro escritor (o cron, ou um 2º clique) gravou esta chave entre o dedupe e o insert.
    const vencedora = await buscarPorChave(supabase, chave);
    if (vencedora.tipo === "existe") {
      return responder({ status: "ja_importada", nfe_recebimento_id: vencedora.id, itens: vencedora.itens }, 200);
    }
    return responder({ status: "erro_gravacao", error: "outro processo gravou esta NF-e agora, e não consegui relê-la" }, 500);
  }
  if (insErr || !nova) {
    return responder({ status: "erro_gravacao", error: `cabeçalho não gravado: ${insErr?.message ?? "insert sem id"}` }, 500);
  }

  const rawItems: OmieRecebimentoItem[] = detalhe.itensRecebimento ?? [];
  const erroItens = await inserirItens(supabase, rawItems, nova.id);
  if (erroItens) {
    // Caminho MANUAL: não há fila para travar (é UMA NF-e, pedida por alguém), então o cabeçalho é
    // desfeito — de pé, ele faria o dedupe acima responder "já importada" a toda nova tentativa,
    // com a NF-e pela metade. (O cron mantém o cabeçalho por outro motivo; ver o laço.)
    const { error: delErr } = await supabase.from("nfe_recebimentos").delete().eq("id", nova.id);
    const sobra = delErr ? ` — e o cabeçalho ${nova.id} FICOU gravado (${delErr.message})` : " — nada ficou gravado";
    return responder({ status: "erro_gravacao", error: `itens não gravados (${erroItens})${sobra}` }, 500);
  }

  return responder({ status: "importada", nfe_recebimento_id: nova.id, itens: rawItems.length }, 200);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  {
    const __auth = await authorizeCronOrStaff(req);
    if (!__auth.ok) return __auth.response;
  }

  // ⚠️ SONDA DE VERSÃO ({"probe":true}) — ANTES do createClient, para seguir sendo o único caminho
  // sem custo. O `authorizeCronOrStaff` acima aceita o `x-cron-secret` do SQL Editor ⇒ sem gate
  // próprio. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // ⚠️ Esta edge NÃO lia o corpo: no bundle pré-sensor, `{"probe":true}` caía direto no laço de
  // sync de todas as credenciais. A leitura abaixo é ADITIVA (nenhum outro ponto do handler
  // consome `req`), e o `.catch(() => ({}))` com o guard de método preserva o caminho do cron, que
  // chama sem corpo. Daqui pra frente a edge insere `nfe_recebimentos` e, em escrita SEPARADA,
  // `nfe_recebimento_itens` — e a retentativa PULA a NF que ficou só com cabeçalho.
  const corpoBruto: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return jsonResponse(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonResponse({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Importação de UMA NF-e pela chave (botão "Importar NF-e"): mesmo gate do topo, outro fluxo.
  if (corpoBruto !== null && typeof corpoBruto === "object" && !Array.isArray(corpoBruto) && "chave_acesso" in corpoBruto) {
    return await importarPorChave(supabase, corpoBruto as Record<string, unknown>);
  }

  const allCreds = getCredentials();
  if (allCreds.length === 0) {
    return jsonResponse({ error: "Nenhuma credencial Omie configurada" }, 500);
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const errors: string[] = [];
  // O sensor do cron: o `net._http_response` guarda esta resposta, e é por ela que se vê, conta a
  // conta, o que a listagem trouxe e por que cada NF-e não virou importação.
  const porArmazem: Record<string, ResumoConta> = {};
  // A vez do rodízio da consulta (rodada.ts, `escolherNaVez`): a hora corrente — o cron é horário,
  // então cada rodada avança uma candidata e nenhuma prende a consulta para sempre.
  const vez = Math.floor(Date.now() / 3_600_000);

  for (const cred of allCreds) {
    try {
      console.log(`[sync] Buscando recebimentos no Omie para warehouse ${cred.warehouseCode}...`);

      const { data: warehouseData } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", cred.warehouseCode)
        .maybeSingle();

      const warehouse = warehouseData as unknown as WarehouseRow | null;
      if (!warehouse) {
        // Credencial configurada sem armazém: a conta inteira some da rodada — vai em errors[],
        // não só no log (era o último caminho que zerava uma conta com success:true).
        console.log(`[sync] Warehouse ${cred.warehouseCode} não encontrado, pulando`);
        errors.push(`${cred.warehouseCode}: armazém não encontrado em warehouses — a conta não foi sincronizada`);
        continue;
      }

      // Filter last 30 days to get recent NF-es with cChaveNfe
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const dtDe = `${String(thirtyDaysAgo.getDate()).padStart(2,'0')}/${String(thirtyDaysAgo.getMonth()+1).padStart(2,'0')}/${thirtyDaysAgo.getFullYear()}`;

      // A rodada (listagem → triagem → a única consulta → gravação) mora em rodada.ts, com o Omie e o
      // banco injetados, para o laço REAL ser testado no Deno (rodada_test.ts).
      const rodada = await rodadaDaConta(depsDaConta(supabase, cred, warehouse.id), cred.warehouseCode, warehouse.id, dtDe, vez);
      porArmazem[cred.warehouseCode] = rodada.resumo;
      errors.push(...rodada.erros);
      totalImported += rodada.importadas;
      totalSkipped += rodada.puladas;
      console.log(`[sync] ${cred.warehouseCode}: ${JSON.stringify(rodada.resumo)}`);
    } catch (credErr) {
      const msg = credErr instanceof Error ? credErr.message : String(credErr);
      console.error(`[sync] Erro na conta ${cred.warehouseCode}:`, credErr);
      errors.push(`${cred.warehouseCode}: ${msg}`);
    }
  }

  console.log(`[sync] Concluído: ${totalImported} importadas, ${totalSkipped} já existentes, ${errors.length} erros`);

  // success reflete o que ACONTECEU, não o fato de a função ter chegado ao fim: com página
  // perdida ou detalhe que falhou, "sucesso" esconderia NF-e faltando no painel de conferência.
  // (O HTTP segue 200: o run é retomável pelo cron horário, não é erro de infra.)
  return jsonResponse({
    success: errors.length === 0,
    imported: totalImported,
    skipped: totalSkipped,
    errors: errors.length > 0 ? errors : undefined,
    por_armazem: porArmazem,
  });
});
