import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { avaliarPagina, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { mapearItensRecebimento, type OmieRecebimentoItem } from "./itens.ts";
import { mapearCabecalho } from "./cabecalho.ts";
import { avaliarDetalhePorChave, classificarConsultaPorChave, normalizarChaveAcesso } from "./chave.ts";

// Teto anti-runaway do total DECLARADO pelo Omie (o teto de LEITURA por rodada continua
// maxPages=3, deliberado: cron horário com MAX_DETAIL_CALLS=1 — amostra retomável, não truncagem).
const MAX_PAGINAS_RECEBIMENTOS = 500;

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

interface OmieRecebimentoListItem {
  cabec?: OmieRecebimentoCabec;
  nIdReceb?: number | string;
  infoCadastro?: OmieRecebimentoInfoCadastro;
}

interface OmieListarRecebimentosResponse {
  recebimentos?: OmieRecebimentoListItem[];
  nTotalPaginas?: number;
}

interface OmieConsultarRecebimentoResponse {
  cabec?: OmieRecebimentoCabec;
  itensRecebimento?: OmieRecebimentoItem[];
  infoCadastro?: OmieRecebimentoInfoCadastro;
}

interface WarehouseRow {
  id: string;
}

interface NfeRecebimentoExistingRow {
  omie_id_receb: number | null;
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
    throw new Error(`Omie ${method} HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return await res.json();
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
        console.log(`[sync] Warehouse ${cred.warehouseCode} não encontrado, pulando`);
        continue;
      }

      // Get existing omie_id_recebs to skip quickly
      const { data: existingRecebimentos } = await supabase
        .from("nfe_recebimentos")
        .select("omie_id_receb")
        .eq("warehouse_id", warehouse.id)
        .not("omie_id_receb", "is", null);

      const existingRecebRows = (existingRecebimentos ?? []) as unknown as NfeRecebimentoExistingRow[];
      // Normaliza pra number: o Omie pode devolver nIdReceb como string na listagem — sem
      // isso o has() nunca casa e as MAX_DETAIL_CALLS se esgotam re-consultando NFs já
      // importadas (starvation: NF nova nunca chega a ser vista). (Codex P2)
      const existingIds = new Set(
        existingRecebRows.map((r) => Number(r.omie_id_receb))
      );

      // Filter last 30 days to get recent NF-es with cChaveNfe
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const dtDe = `${String(thirtyDaysAgo.getDate()).padStart(2,'0')}/${String(thirtyDaysAgo.getMonth()+1).padStart(2,'0')}/${thirtyDaysAgo.getFullYear()}`;

      const allRecebimentos: OmieRecebimentoListItem[] = [];
      let page = 1;
      const maxPages = 3;
      let totalPages = 1; // piso monotônico do total declarado (guards de _shared/omie-paginacao.ts)
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        try {
          const pageResult = (await omieCall(
            cred.appKey,
            cred.appSecret,
            "produtos/recebimentonfe/",
            "ListarRecebimentos",
            {
              nPagina: page,
              nRegistrosPorPagina: 50,
              dtEmissaoDe: dtDe,
            },
          )) as unknown as OmieListarRecebimentosResponse;
          totalPages = proximoTotalPaginas(totalPages, pageResult.nTotalPaginas, MAX_PAGINAS_RECEBIMENTOS);
          const recs = pageResult.recebimentos ?? [];
          const veredicto = avaliarPagina(recs.length, page, totalPages);
          if (veredicto === "anomalia") {
            throw new Error(`página ${page}/${totalPages} veio vazia antes do fim declarado — acumulado parcial`);
          }
          if (veredicto === "fim") break;
          allRecebimentos.push(...recs);
          console.log(`[sync] Página ${page}/${totalPages}, ${recs.length} registros`);
          hasMore = page < totalPages;
          page++;
        } catch (pgErr) {
          const msg = pgErr instanceof Error ? pgErr.message : String(pgErr);
          // REGISTRA em errors[] (surfaça no response) — o console.warn sozinho deixava o
          // acumulado parcial seguir adiante com success:true e ninguém sabia da página perdida.
          errors.push(`${cred.warehouseCode} ListarRecebimentos página ${page}: ${msg}`);
          console.warn(`[sync] Erro na página ${page}: ${msg}`);
          break;
        }
      }

      console.log(`[sync] ${allRecebimentos.length} registros recentes (últimos 30 dias)`);

      let detailCalls = 0;
      // 1 por conta/rodada: ConsultarRecebimento tem trava anti-redundância POR MÉTODO
      // (~60s) no Omie — rajada de detalhes = "1 passa, resto REDUNDANT" (visto em prod
      // 2026-07-16). Com o cron horário, 1/rodada importa 13/dia por conta — dá conta do
      // fluxo. Follow-up no GOAL: migrar pra ListarRecebimentos(cExibirDetalhes:'S').
      const MAX_DETAIL_CALLS = 1;

      for (const rec of allRecebimentos) {
        if (detailCalls >= MAX_DETAIL_CALLS) break;

        const cabec = rec.cabec ?? rec;
        const nIdReceb = cabec.nIdReceb;
        if (!nIdReceb) continue;

        // Quick skip if already imported (normalizado pra number, como o Set)
        if (existingIds.has(Number(nIdReceb))) {
          totalSkipped++;
          continue;
        }

        // Skip cancelled/faturado
        const infoCad = rec.infoCadastro ?? {};
        if (infoCad.cCancelada === "S") {
          continue;
        }

        // Need to fetch detail for chave_acesso and items
        detailCalls++;
        let detail: OmieConsultarRecebimentoResponse;
        try {
          detail = (await omieCall(
            cred.appKey,
            cred.appSecret,
            "produtos/recebimentonfe/",
            "ConsultarRecebimento",
            { nIdReceb },
          )) as unknown as OmieConsultarRecebimentoResponse;
        } catch (detErr) {
          const msg = detErr instanceof Error ? detErr.message : String(detErr);
          // REGISTRA: com MAX_DETAIL_CALLS=1, a MESMA NF falhando toda hora starva a fila
          // inteira atrás dela com success:true — errors[] é o único sinal visível disso.
          errors.push(`${cred.warehouseCode} ConsultarRecebimento ${nIdReceb}: ${msg}`);
          console.warn(`[sync] Erro ao consultar recebimento ${nIdReceb}: ${msg}`);
          continue;
        }

        const detCabec = detail.cabec ?? {};
        // Log first detail to understand structure
        if (detailCalls <= 2) {
          console.log(`[sync] Detail cabec keys for ${nIdReceb}: ${JSON.stringify(Object.keys(detCabec))}`);
          console.log(`[sync] Detail cabec sample: ${JSON.stringify(detCabec).slice(0, 500)}`);
        }

        // NF que o Omie JÁ recebeu (cRecebido=S) não nasce 'pendente' no app — a entrada
        // foi feita lá (humano); importá-la só criaria pendência fantasma no painel de
        // conferência (a varredura omie-nfe-reconcile teria que baixá-la em seguida).
        if (detail.infoCadastro?.cRecebido === "S") {
          totalSkipped++;
          console.log(`[sync] Recebimento ${nIdReceb} já recebido no Omie (cRecebido=S), pulando`);
          continue;
        }

        const chaveAcesso = detCabec.cChaveNFe || detCabec.cChaveNfe || null;
        if (!chaveAcesso || chaveAcesso.length < 44) {
          console.log(`[sync] Recebimento ${nIdReceb} sem chave de acesso no detalhe, pulando`);
          continue;
        }

        // Double check by chave_acesso
        const { data: existByChave } = await supabase
          .from("nfe_recebimentos")
          .select("id")
          .eq("chave_acesso", chaveAcesso)
          .maybeSingle();

        if (existByChave) {
          totalSkipped++;
          continue;
        }

        const numeroNfe = String(detCabec.cNumeroNFe ?? "");

        const { data: newNfe, error: insErr } = await supabase
          .from("nfe_recebimentos")
          .insert(mapearCabecalho(detCabec, warehouse.id, chaveAcesso, nIdReceb))
          .select("id")
          .single();

        if (insErr || !newNfe) {
          console.error(`[sync] Erro ao inserir NF-e ${chaveAcesso}:`, insErr);
          errors.push(`NF-e ${numeroNfe}: ${insErr?.message}`);
          continue;
        }

        // Parse items from itensRecebimento
        const rawItems: OmieRecebimentoItem[] = detail.itensRecebimento ?? [];
        const erroItens = await inserirItens(supabase, rawItems, newNfe.id);
        if (erroItens) {
          // A NF-e ficou SÓ com o cabeçalho e a retentativa a pula (`existingIds`): o erro tem de
          // sair em errors[] — com o console.error sozinho ela contava como importada e a run
          // dizia success:true (foi assim que o NCM pontuado zerou os itens de prod em silêncio).
          // O cabeçalho NÃO é apagado: com MAX_DETAIL_CALLS=1, uma falha determinística re-tentada
          // a cada run travaria a fila inteira atrás dela.
          console.error(`[sync] Erro ao inserir itens da NF-e ${numeroNfe}: ${erroItens}`);
          errors.push(`NF-e ${numeroNfe}: cabeçalho gravado SEM itens — ${erroItens}`);
          continue;
        }

        totalImported++;
        console.log(`[sync] NF-e ${numeroNfe} importada (${rawItems.length} itens)`);
      }

      if (detailCalls >= MAX_DETAIL_CALLS) {
        console.log(`[sync] Limite de ${MAX_DETAIL_CALLS} consultas de detalhe atingido para ${cred.warehouseCode}. Execute novamente para mais.`);
      }
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
  });
});
