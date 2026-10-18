import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { chamarOmie, enviarOmie } from "../_shared/omie-cliente.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  type ClienteRpc,
  importarViaRpc,
  registrarFalhaImportacao,
  registravel,
  SELECT_TRIAGEM,
  TENTATIVAS_PARA_ESTACIONAR,
  triarCabecalho,
} from "../_shared/nfe-importacao.ts";
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

// Núcleo compartilhado (_shared/omie-cliente.ts, M-48): teto de relógio por chamada (o fetch
// antigo não tinha nenhum) e uma tentativa só, como antes — a rodada decide o que repetir.
async function chamadaOmie(
  cred: OmieCredentials,
  endpoint: string,
  method: string,
  params: OmieCallParams,
): Promise<unknown> {
  const res = await chamarOmie(
    {
      url: `https://app.omie.com.br/api/v1/${endpoint}`,
      metodo: method,
      param: params,
      credenciais: { appKey: cred.appKey, appSecret: cred.appSecret },
    },
    { conta: cred.warehouseCode, maxTentativas: 1 },
  );
  if (!res.ok) {
    // O corpo decide antes do status: o Omie manda "não existem registros" e outras falhas de negócio
    // com HTTP 500 (CC, 2026-10-05). Com `faultstring`, o corpo volta e o chamador classifica
    // (interpretarPaginaListagem / falhaNoCorpo); sem ela, é falha de transporte.
    const corpoDeFalha = corpoDeFalhaOmie(res.texto);
    if (corpoDeFalha !== null) return corpoDeFalha;
    throw new Error(`Omie ${method} HTTP ${res.status}: ${redigirSegredo(res.texto.slice(0, 300))}`);
  }
  // 2xx ilegível lançava no `res.json()` — continua lançando, nunca vira corpo vazio.
  if (res.corpo === null) throw new Error(`Omie ${method} HTTP ${res.status}: resposta não-JSON`);
  return res.corpo;
}

/** Lote de chaves por `.in()`: 44 dígitos cada — as ~150 de uma rodada numa URL só passariam do seguro. */
const LOTE_CHAVES = 50;

/** O Omie e o banco REAIS da rodada de uma conta (ver rodada.ts). */
function depsDaConta(supabase: SupabaseClient, cred: OmieCredentials, warehouseId: string): DepsRodada {
  return {
    listar: (params) => chamadaOmie(cred, "produtos/recebimentonfe/", "ListarRecebimentos", params),
    consultar: (nIdReceb) =>
      chamadaOmie(cred, "produtos/recebimentonfe/", "ConsultarRecebimento", { nIdReceb }),
    jaImportados: async (ids, chaves) => {
      // "Já importada" para a TRIAGEM = não precisa de consulta: tem itens, ou não é reparável, ou está
      // ESTACIONADA em nfe_importacao_falhas (tentativas ≥ 3). Cabeçalho `pendente` sem itens e sem
      // sinais de uso NÃO entra: a consulta desta rodada é o que o completa (RPC → reparada). Antes a
      // triagem o pulava pela simples existência, e o reparo era inalcançável (parecer Codex).
      const idsJa = new Set<number>();
      const chavesJa = new Set<string>();
      // `omie_id_receb` só vale DENTRO da conta: um id de OB nunca marca uma NF-e de CC como importada
      // (parecer adversarial). Linha de outro armazém só contribui com a CHAVE (que é global).
      const classificar = (linhas: unknown[]) => {
        for (const l of linhas) {
          const t = triarCabecalho(l);
          // Contagem ilegível é ERRO (nenhuma consulta é gasta nesta rodada), nunca "sem itens".
          if (t.tipo === "erro") throw new Error(`triagem de nfe_recebimentos: ${t.mensagem}`);
          if (t.tipo === "reparavel") continue;
          const r = l as { omie_id_receb: number | string | null; chave_acesso: string | null; warehouse_id: string | null };
          if (r.omie_id_receb !== null && r.warehouse_id === warehouseId) idsJa.add(Number(r.omie_id_receb));
          if (r.chave_acesso) chavesJa.add(r.chave_acesso);
        }
      };
      const estacionar = (linhas: unknown[]) => {
        for (const l of linhas as { omie_id_receb: number | string | null; chave_acesso: string }[]) {
          chavesJa.add(l.chave_acesso);
          if (l.omie_id_receb !== null) idsJa.add(Number(l.omie_id_receb));
        }
      };
      if (ids.length > 0) {
        const { data, error } = await supabase
          .from("nfe_recebimentos")
          .select(SELECT_TRIAGEM)
          .eq("warehouse_id", warehouseId)
          .in("omie_id_receb", ids);
        if (error) throw new Error(error.message);
        classificar(data ?? []);
        const { data: estacionadas, error: estacErr } = await supabase
          .from("nfe_importacao_falhas")
          .select("chave_acesso, omie_id_receb")
          .eq("warehouse_id", warehouseId)
          .in("omie_id_receb", ids)
          .gte("tentativas", TENTATIVAS_PARA_ESTACIONAR);
        if (estacErr) throw new Error(`nfe_importacao_falhas: ${estacErr.message}`);
        estacionar(estacionadas ?? []);
      }
      for (let i = 0; i < chaves.length; i += LOTE_CHAVES) {
        const lote = chaves.slice(i, i + LOTE_CHAVES);
        const { data, error } = await supabase
          .from("nfe_recebimentos")
          .select(SELECT_TRIAGEM)
          .in("chave_acesso", lote);
        if (error) throw new Error(error.message);
        classificar(data ?? []);
        const { data: estacionadas, error: estacErr } = await supabase
          .from("nfe_importacao_falhas")
          .select("chave_acesso, omie_id_receb")
          .in("chave_acesso", lote)
          .gte("tentativas", TENTATIVAS_PARA_ESTACIONAR);
        if (estacErr) throw new Error(`nfe_importacao_falhas: ${estacErr.message}`);
        estacionar(estacionadas ?? []);
      }
      return { ids: idsJa, chaves: chavesJa };
    },
    importar: (cabecalho, itens) =>
      importarViaRpc(supabase as unknown as ClienteRpc, {
        cabecalho: cabecalho as unknown as Record<string, unknown>,
        itens: itens as unknown as Record<string, unknown>[],
        origem: "sync",
      }),
    registrarFalha: (chave, code, mensagem, omieIdReceb) =>
      registrarFalhaImportacao(supabase as unknown as ClienteRpc, { chaveAcesso: chave, origem: "sync", code, mensagem, warehouseId, omieIdReceb }),
  };
}

/** Teto da consulta por chave: quem espera é o operador, com o diálogo aberto. */
const OMIE_TIMEOUT_POR_CHAVE_MS = 25_000;

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

  // Dedupe ANTES de gastar a consulta ao Omie (e de arriscar o "consumo redundante" dele) — mas um
  // cabeçalho `pendente` SEM itens e sem sinais de uso (importação antiga que morreu no meio) NÃO é
  // "já importada": segue para o Omie, e a RPC o completa. O botão é o reprocessamento humano: ignora
  // o estacionamento de nfe_importacao_falhas (a RPC apaga o registro no sucesso).
  const { data: linha, error: lerErr } = await supabase
    .from("nfe_recebimentos")
    .select(SELECT_TRIAGEM)
    .eq("chave_acesso", chave)
    .maybeSingle();
  if (lerErr) return responder({ status: "erro_gravacao", error: `ler nfe_recebimentos: ${lerErr.message}` }, 500);
  if (linha) {
    const t = triarCabecalho(linha);
    if (t.tipo === "erro") return responder({ status: "erro_gravacao", error: t.mensagem }, 500);
    if (t.tipo === "completo" && t.itens > 0) {
      return responder({ status: "ja_importada", nfe_recebimento_id: (linha as { id: string }).id, itens: t.itens }, 200);
    }
    if (t.tipo === "completo") {
      // Sem itens e NÃO reparável (efetivado/em uso): "já importada" seria certificar o vazio.
      const l = linha as { id: string; status: string };
      return responder({
        status: "bloqueada",
        nfe_recebimento_id: l.id,
        itens: 0,
        error: `Esta NF-e já está no app SEM itens e não pode ser completada (status ${l.status}) — avise a equipe`,
      }, 409);
    }
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
    // Uma tentativa só (o botão é do operador; repetir é dele), com o teto de relógio do núcleo.
    const res = await enviarOmie(
      {
        url: "https://app.omie.com.br/api/v1/produtos/recebimentonfe/",
        metodo: "ConsultarRecebimento",
        param: { cChaveNFe: chave },
        credenciais: { appKey: cred.appKey, appSecret: cred.appSecret },
      },
      { conta: cred.warehouseCode, deadline: Date.now() + OMIE_TIMEOUT_POR_CHAVE_MS, tetoPorRequestMs: OMIE_TIMEOUT_POR_CHAVE_MS },
    );
    httpStatus = res.status;
    corpoOmie = res.corpo ?? res.texto;
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
    const anomalia = avaliacao.status === "chave_divergente" || avaliacao.status === "sem_id_recebimento" ||
      avaliacao.status === "estado_desconhecido";
    return responder({ status: avaliacao.status, error: avaliacao.mensagem }, anomalia ? 502 : 409);
  }

  const detalhe = consulta.detalhe as OmieConsultarRecebimentoResponse;
  const cliente = supabase as unknown as ClienteRpc;
  // UMA transação: cabeçalho + itens entram juntos ou nada entra — não há mais cabeçalho a desfazer
  // (o DELETE de compensação de antes podia, em cascata, apagar itens que outro writer acabara de
  // materializar). Os `status` continuam os que o front lê (src/lib/recebimento/importacao-resposta.ts).
  const d = await importarViaRpc(cliente, {
    cabecalho: mapearCabecalho(detalhe.cabec ?? {}, wh.id, chave, avaliacao.nIdReceb) as unknown as Record<string, unknown>,
    itens: mapearItensRecebimento(detalhe.itensRecebimento ?? []) as unknown as Record<string, unknown>[],
    origem: "importacao_chave",
  });
  // Impedimento (bloqueada/divergente) e erro de dado ficam no ledger durável — fora da transação.
  const registro = registravel(d);
  const tentativas = registro
    ? await registrarFalhaImportacao(cliente, {
      chaveAcesso: chave,
      origem: "importacao_chave",
      code: registro.code,
      mensagem: registro.mensagem,
      warehouseId: wh.id,
      omieIdReceb: Number(avaliacao.nIdReceb),
    })
    : null;
  switch (d.tipo) {
    case "importada":
    case "reparada":
      return responder({ status: "importada", nfe_recebimento_id: d.id, itens: d.itens, reparada: d.tipo === "reparada" }, 200);
    case "ja_importada":
      return responder({ status: "ja_importada", nfe_recebimento_id: d.id, itens: d.itens }, 200);
    case "bloqueada":
      return responder({
        status: "bloqueada",
        nfe_recebimento_id: d.id,
        itens: 0,
        error: `Esta NF-e já está no app SEM itens e não pode ser completada (${d.motivo}) — avise a equipe`,
      }, 409);
    case "divergente":
      return responder({
        status: "divergente",
        nfe_recebimento_id: d.id,
        itens: d.itens,
        error: `Esta NF-e já está no app com itens DIFERENTES do Omie (${d.motivo}: ${d.itens} no app, ${d.esperados} no Omie) — avise a equipe`,
      }, 409);
    case "erro": {
      if (d.classe === "dado") {
        return responder({
          status: "erro_gravacao",
          error: `o banco rejeitou a NF-e (${d.code}): ${d.mensagem} — registrada em nfe_importacao_falhas (tentativas: ${tentativas ?? "não registrou"})`,
        }, 422);
      }
      if (d.classe === "rpc_ausente") {
        return responder({
          status: "erro_gravacao",
          error: "RPC importar_nfe_recebimento indisponível — migration db/2026-10-18-importar-nfe-recebimento-rpc.sql não aplicada (ou cache do PostgREST não recarregado); nada gravado",
        }, 500);
      }
      return responder({ status: "erro_gravacao", error: `NF-e não gravada (${d.mensagem}) — nada ficou gravado, tente de novo` }, 500);
    }
  }
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
  // chama sem corpo. Daqui pra frente a edge materializa `nfe_recebimentos` + `nfe_recebimento_itens`
  // pela RPC transacional `importar_nfe_recebimento`.
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
  // A vez do sorteio da consulta (rodada.ts, `escolherNaVez`): o minuto corrente. O sorteio é por
  // hash de (vez, id) — sem a estrutura do relógio do cron (10–22h, seg–sáb) colidindo com o tamanho
  // da fila — e a execução manual na mesma hora sorteia de novo.
  const vez = Math.floor(Date.now() / 60_000);

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
