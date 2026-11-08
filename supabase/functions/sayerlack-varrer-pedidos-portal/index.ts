// Edge Function: sayerlack-varrer-pedidos-portal  [money-path]
//
// Cron 12:30 · 17:30 · 22:30 (SP). Palavra do founder (2026-10-16): "caso algum pedido esteja lançado no portal da
// Sayerlack e não exista no Omie, ele seja lançado no Omie". A edge:
//   0. portal fechado (sáb 12h → seg 6h) ⇒ não abre o navegador; pedido do app em voo/conciliação ⇒ não varre;
//   1. lê a Consulta Pedidos (Browserless; cliente OBEN, Exibir = Pedido, emissão dos últimos 7 dias, todas as páginas);
//   2. classifica em Deno (./varredura.ts): já no app · já no Omie · cancelado · fora da janela · situação fora da lista
//      fechada · candidato;
//   3. modo "importar": para cada candidato, RECONFERE o banco (bloqueio + protocolo) e chama a edge
//      `sayerlack-importar-pedido-portal` — o MESMO caminho do botão (relê o pedido, prova a leitura, RPC tudo-ou-nada
//      idempotente por protocolo, IP006 contra PO já no Omie, PO pelo disparo de sempre). Modo "listar" só relata.
//   4. falha de importação ⇒ `sayerlack_varredura_falha` + e-mail na 1ª vez do protocolo.
//   5. (v1.3) pedido do APP com PO fora do Omie cujo protocolo está "6 - Cancelado" no portal ⇒ encerrado pela porta
//      auditada `corrigir_cancelamento_pos_disparo` (é a pergunta que o card "PO a reconciliar" fazia ao founder).
//   6. (v1.9) COBERTURA: os pedidos com PO ainda não faturado (`sayerlack_cobertura_situacao_portal`) têm a situação
//      relida 1×/dia, com leitura estendida se a emissão é anterior aos 7 dias — o 6 deles abre o incidente da 5.4.
//
// ⚠️ LEITURA PURA NO PORTAL: o script do navegador só usa menu, filtros, "Filtrar" e a paginação da tabela; recusa todo
// diálogo nativo (dismiss — nunca confirma). Nada aqui grava no portal.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarPosLogin } from "../_shared/sayerlack-pos-login.ts";
import { ABRIR_CONSULTA_PEDIDOS } from "../_shared/sayerlack-portal-navegador.ts";
import {
  aplicarFiltrosConsultaDom,
  clicarFiltrarDom,
  clicarProximaPaginaDom,
  lerSituacoesDom,
  lerTabelaConsultaDom,
  lerTodasAsPaginas,
} from "../_shared/sayerlack-portal-dom.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { hojeSP } from "../_shared/hoje-sp.ts";
import { fetchAll } from "../_shared/paginate.ts";
import {
  classificar,
  ESTADOS_EM_VOO,
  inicioDaJanela,
  lerListaConsulta,
  type LinhaConsultaRaw,
  motivoBloqueio,
  aplicarCarencia,
  contratosDoTexto,
  portalSayerlackFechado,
  resumoImportacao,
  SITUACOES_IMPORTAVEIS,
  desfechoNoPortal,
  janelaDeLeitura,
  idDoPo,
  type MarcadorPo,
  marcadorFresco,
  type PedidoAReconciliar,
  type PedidoDisparadoLido,
  pedidosAReconciliar,
  provarLeitura,
  carenciaTravada,
  reconsultasForaDaJanela,
  observacoesDaLista,
  type ObservacaoSituacao,
  desfechoImportacao,
  carenciaRedisparo,
  maisRecente,
  entregaCobertaPeloSync,
  coberturaPendente,
  type PedidoACobrir,
} from "./varredura.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const SAYERLACK_PORTAL_CLIENTE_CODIGO = Deno.env.get("SAYERLACK_PORTAL_CLIENTE_CODIGO");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const ACAO_REGISTRO = "reposicao.varrer_portal_sayerlack";
/**
 * `modo=listar` grava em slug PRÓPRIO (revisão 2, B9): o vigia `sayerlack_varredura_portal` do data_health lê só
 * ACAO_REGISTRO — uma leitura manual de diagnóstico não pode passar por "a automação de importação rodou".
 */
const ACAO_REGISTRO_LISTAR = "reposicao.listar_portal_sayerlack";
const FROM_EMAIL = "Reposicao OBEN <onboarding@resend.dev>";
/** Só começa uma importação se ainda houver este tempo de folga até o teto da edge (cada uma leva ~1–3 min). */
const TETO_EDGE_MS = 380_000;
const FOLGA_POR_IMPORTACAO_MS = 200_000;

// Função JS que roda no Chrome remoto via Browserless v2 (/function, Puppeteer). Login, pós-login, menu e espera da
// tabela no MESMO molde da edge de importar (provados em prod no 1º uso, 2141068). Dentro deste template: sem crase,
// sem cifrão-chave, e regex com barra invertida dobrada.
const BROWSERLESS_FUNCTION = `
export default async ({ page, context }) => {
  const { user, pass, portalUrl, clienteCodigo, emissaoDesde } = context;
  const trace = [];
  const t0 = Date.now();
  const classificarPosLogin = ${classificarPosLogin.toString()};
  // Funções de PÁGINA (seletores) e o laço de paginação, testados contra HTML real: ../_shared/sayerlack-portal-dom.ts (8.2).
  const aplicarFiltrosConsultaDom = ${aplicarFiltrosConsultaDom.toString()};
  const clicarFiltrarDom = ${clicarFiltrarDom.toString()};
  const clicarProximaPaginaDom = ${clicarProximaPaginaDom.toString()};
  const lerSituacoesDom = ${lerSituacoesDom.toString()};
  const lerTabelaConsultaDom = ${lerTabelaConsultaDom.toString()};
  const lerTodasAsPaginas = ${lerTodasAsPaginas.toString()};

  const HARD_CEILING_MS = 150000;
  const RETURN_GUARD_MS = 2000;
  const deadline = t0 + HARD_CEILING_MS;
  const budgetFor = (label, idealMs) => {
    const allowed = Math.min(idealMs, Math.max(0, deadline - Date.now() - RETURN_GUARD_MS));
    if (allowed < 500) {
      const err = new Error('BUDGET_EXHAUSTED em "' + label + '"');
      err.code = 'BUDGET_EXHAUSTED';
      throw err;
    }
    return allowed;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const falha = async (erroTipo, erro, extra) => {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }).catch(() => null);
    return { data: Object.assign({ success: false, erroTipo, erro, trace }, extra || {}), type: 'application/json', screenshot };
  };
  const fillInput = async (selector, value) => {
    await page.click(selector);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, selector);
    await page.type(selector, String(value));
  };

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });
    page.on('dialog', function(d) {
      trace.push({ step: 'dialog_dismiss', tipo: d.type(), msg: String(d.message() || '').substring(0, 80), t: Date.now() - t0 });
      d.dismiss().catch(function() {});
    });

    // === Login ===
${ABRIR_CONSULTA_PEDIDOS}
    // As situações que o portal oferece (para a lista fechada de importáveis ser decidida com o dado real).
    const situacoes = await page.evaluate(lerSituacoesDom);

    // Filtros: cliente OBEN, só PEDIDO (não proposta), qualquer situação (o cancelado é LIDO e descartado em Deno),
    // nº do pedido em branco, emissão desde o início da janela, entrega desde 2020 (o default é só o último mês).
    const filtro = await page.evaluate(aplicarFiltrosConsultaDom, String(clienteCodigo), '', '', emissaoDesde);
    trace.push({ step: 'filtros', filtro, t: Date.now() - t0 });
    if (filtro.cliente !== String(clienteCodigo)) {
      return await falha('CLIENTE_INDISPONIVEL', 'Cliente ' + clienteCodigo + ' não está disponível no filtro da consulta', { filtro });
    }
    if (filtro.exibir !== '1') return await falha('FILTRO_NAO_APLICADO', 'Filtro Exibir = Pedido não ficou aplicado', { filtro });
    if (filtro.emissao !== emissaoDesde) return await falha('FILTRO_NAO_APLICADO', 'Data de emissão inicial não ficou no filtro', { filtro });
    if (filtro.ini) return await falha('FILTRO_NAO_APLICADO', 'Número do pedido inicial não ficou em branco', { filtro });
    await sleep(1500);

    const esperarConsulta = async (rotulo, acao) => {
      const resp = page.waitForResponse(
        (r) => r.url().indexOf('/order-viewer/form/list') !== -1 && r.request().method() === 'POST',
        { timeout: budgetFor('resposta-' + rotulo, 45000) },
      ).then(async (r) => {
        // Total ANUNCIADO pelo próprio portal (DataTables server-side: recordsFiltered/recordsTotal) — a prova de que a
        // lista veio inteira (Onda 3: 2 rodadas leram 0 linhas e deram sucesso). Corpo ilegível ⇒ só as chaves no trace.
        let total = null; let chaves = null;
        try {
          const j = await r.json();
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            chaves = Object.keys(j).slice(0, 20);
            // Só o FILTRADO: recordsTotal é o universo antes dos filtros (Codex P2) e daria erro permanente.
            const cand = [j.recordsFiltered, j.iTotalDisplayRecords];
            for (let k = 0; k < cand.length; k++) { if (cand[k] !== undefined && cand[k] !== null) { total = cand[k]; break; } }
          }
        } catch (e) { chaves = null; }
        return { ok: r.status() < 400, status: r.status(), total, chaves };
      }).catch((e) => ({ ok: false, erro: String((e && e.message) || e).substring(0, 120) }));
      await page.evaluate(acao);
      return await resp;
    };
    const clicarFiltrar = () => { const b = document.querySelector('#getFilterData'); if (b) b.click(); };
    let resp = await esperarConsulta('filtrar-1', clicarFiltrarDom);
    if (!resp.ok) resp = await esperarConsulta('filtrar-2', clicarFiltrarDom);
    trace.push({ step: 'consulta_resposta', resp, t: Date.now() - t0 });
    if (!resp.ok) return await falha('CONSULTA_SEM_RESPOSTA', 'O portal não respondeu à consulta (2 tentativas)');

    const lerPagina = () => page.evaluate(lerTabelaConsultaDom);
    const lerEstavel = async () => {
      let p = { ok: false, headers: [], linhas: [], processando: true, info: null, temProxima: false };
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        budgetFor('poll-pagina', 1000);
        p = await lerPagina().catch(() => p);
        if (p.ok && !p.processando) return p;
      }
      // Tabela ausente ou ainda processando depois de 10 s: a página NÃO foi lida — nunca vira "lista completa".
      return null;
    };

    const lida = await lerTodasAsPaginas(
      lerEstavel,
      (n) => esperarConsulta('pagina-' + n, clicarProximaPaginaDom),
      30,
    );
    if (!lida.ok && lida.erroTipo === 'CONSULTA_ILEGIVEL') return await falha('CONSULTA_ILEGIVEL', 'Tabela da consulta não estabilizou (ausente ou processando)');
    const linhas = lida.linhas;
    const paginas = lida.paginas;
    if (!lida.ok && lida.erroTipo === 'PAGINACAO_SEM_RESPOSTA') return await falha('PAGINACAO_SEM_RESPOSTA', 'O portal não respondeu à página ' + (paginas + 1), { paginas, n_linhas: linhas.length });
    if (!lida.ok && lida.erroTipo === 'PAGINACAO_ILEGIVEL') return await falha('PAGINACAO_ILEGIVEL', 'Página ' + (paginas + 1) + ' da consulta não estabilizou', { paginas, n_linhas: linhas.length });
    const headers = lida.primeira.headers;
    const infoInicial = lida.primeira.info;
    const dtTotalInicial = lida.primeira.dtTotal;
    trace.push({ step: 'consulta_lida', headers, paginas, n_linhas: linhas.length, info: infoInicial, resposta_total: resp.total, resposta_chaves: resp.chaves, dt_total: dtTotalInicial, t: Date.now() - t0 });
    if (!lida.ok) return await falha('PAGINACAO_INCOMPLETA', 'Mais de 30 páginas na consulta — lista não lida inteira', { paginas });

    return {
      data: { success: true, headers, linhas, info: infoInicial, resposta_total: resp.total, resposta_chaves: resp.chaves, dt_total: dtTotalInicial, paginas, situacoes, filtro, trace },
      type: 'application/json',
    };
  } catch (e) {
    const code = e && e.code ? e.code : 'EXCEPTION';
    return await falha(code, String((e && e.message) || e));
  }
};
`;

interface BrowserlessData {
  success?: boolean;
  erroTipo?: string;
  erro?: string;
  headers?: string[];
  linhas?: LinhaConsultaRaw[];
  info?: string | null;
  /** Total que o portal anunciou na resposta da consulta (recordsFiltered/recordsTotal). */
  resposta_total?: unknown;
  resposta_chaves?: string[] | null;
  /** page.info().recordsDisplay da instância DataTables da tabela lida. */
  dt_total?: unknown;
  paginas?: number;
  situacoes?: { valor: string; texto: string }[];
  trace?: unknown[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type Db = SupabaseClient;

/** Pedidos da OBEN que podem estar no portal SEM protocolo no banco. Sem filtro de fornecedor de propósito: só o
 *  portal Sayerlack usa esses estados, e um nome de fornecedor grafado diferente não pode abrir a trava.
 *  Erro de leitura LANÇA (fail-closed). */
async function pedidosEmVoo(db: Db): Promise<{ id: number; status_envio_portal: string | null }[]> {
  const { data, error } = await db.from("pedido_compra_sugerido")
    .select("id, status_envio_portal")
    .eq("empresa", "OBEN")
    .in("status_envio_portal", ESTADOS_EM_VOO as string[])
    .limit(50);
  if (error) throw new Error(`Leitura dos pedidos em voo: ${error.message}`);
  return (data ?? []) as { id: number; status_envio_portal: string | null }[];
}

/** Pedidos do portal com PO fora do último run válido do detector (mesmos filtros de `reposicao_pos_candidatos`, que
 *  é gateada por master e não atende service-role). `apenas` restringe a releitura de um pedido antes de encerrá-lo.
 *  Erro de leitura LANÇA (fail-closed: sem prova de ausência, nada se encerra). */
async function carregarAReconciliar(db: Db, apenas?: number): Promise<{ lista: PedidoAReconciliar[]; marcador: MarcadorPo | null }> {
  const { data: run, error: errRun } = await db.from("reposicao_pedidos_compra_run")
    .select("run_id, seq, finalizado_em")
    .eq("empresa", "OBEN").eq("status", "ok").eq("volume_ok", true)
    .order("seq", { ascending: false }).limit(1).maybeSingle();
  if (errRun) throw new Error(`Leitura do marcador de PO: ${errRun.message}`);
  const r = run as MarcadorPo | null;
  const marcador = r && r.run_id && r.finalizado_em && Number.isFinite(Number(r.seq)) ? { ...r, seq: Number(r.seq) } : null;
  if (!marcador) return { lista: [], marcador: null };
  const pedidos = await fetchAll<PedidoDisparadoLido>(
    (de, ate) => {
      let q = db.from("pedido_compra_sugerido")
        .select("id, status, canal_usado, data_ciclo, portal_protocolo, omie_pedido_compra_id, omie_po_inexistente_antes_de")
        .eq("empresa", "OBEN").eq("status", "disparado").eq("canal_usado", "portal_sayerlack");
      if (apenas !== undefined) q = q.eq("id", apenas);
      return q.order("id", { ascending: true }).range(de, ate);
    },
    "varrer-portal:a-reconciliar",
  );
  const poIds = [...new Set(pedidos.map((p) => idDoPo(p.omie_pedido_compra_id)).filter((s): s is string => s !== null))];
  // Visto no run do marcador OU num posterior (`visto_seq >= seq`), nunca `run_id = marcador`: um run novo publicado no
  // meio desta leitura sobrescreve o carimbo e faria um PO presente parecer ausente (Codex P1).
  const vistos = poIds.length === 0 ? [] : await fetchAll<{ omie_codigo_pedido: number | string; visto_seq: number | string }>(
    (de, ate) => db.from("reposicao_po_last_seen").select("omie_codigo_pedido, visto_seq")
      .eq("empresa", "OBEN").in("omie_codigo_pedido", poIds)
      .order("omie_codigo_pedido", { ascending: true }).range(de, ate),
    "varrer-portal:po-vistos",
  );
  const vistosDesde = new Set(vistos.filter((v) => Number(v.visto_seq) >= Number(marcador.seq))
    .map((v) => idDoPo(v.omie_codigo_pedido)).filter((s): s is string => s !== null));
  return { lista: pedidosAReconciliar(pedidos, marcador, vistosDesde), marcador };
}

/** Uma leitura da Consulta Pedidos (Browserless) a partir de `emissaoDesde`. Não lança por resposta ruim: devolve
 *  `success:false` com o tipo do erro (rede/abort lançam — quem chama decide). */
async function lerPortal(emissaoDesde: string): Promise<BrowserlessData> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 185_000);
  let envelope: BrowserlessData;
  try {
    const resp = await fetch(`https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=180000`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        code: BROWSERLESS_FUNCTION,
        context: {
          user: SAYERLACK_PORTAL_USER, pass: SAYERLACK_PORTAL_PASS, portalUrl: SAYERLACK_PORTAL_URL,
          clienteCodigo: SAYERLACK_PORTAL_CLIENTE_CODIGO, emissaoDesde,
        },
      }),
    });
    const txt = await resp.text();
    try {
      envelope = ((JSON.parse(txt) as { data?: BrowserlessData }).data) ?? {};
    } catch {
      envelope = { success: false, erroTipo: "RESPOSTA_INVALIDA", erro: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
    }
  } finally {
    clearTimeout(timeout);
  }
  return envelope;
}

/** Encerra pela porta auditada (`corrigir_cancelamento_pos_disparo`: trava de status sob lock + trilha em
 *  `reposicao_cancelamento_pos_disparo_audit`). Autor `sistema:*`, como `reposicao_encerrar_recusas_definitivas`. */
async function encerrarCanceladoNoPortal(
  db: Db, p: PedidoAReconciliar, situacao: string, marcador: MarcadorPo,
): Promise<{ ok: boolean; mensagem: string }> {
  const { error } = await db.rpc("corrigir_cancelamento_pos_disparo", {
    p_pedido_id: p.pedido_id,
    p_usuario: "sistema:varredura_portal",
    p_motivo: "cancelado_junto_ao_fornecedor",
    p_evidencia: `protocolo ${p.protocolo} — portal Sayerlack: "${situacao}"; PO ${p.omie_po_id} fora do Omie no run ${marcador.run_id} (fim ${marcador.finalizado_em})`,
    p_justificativa: "Encerrado pela varredura do portal: o fornecedor cancelou o pedido e o PO não existe mais no Omie.",
  });
  return error ? { ok: false, mensagem: error.message } : { ok: true, mensagem: "encerrado" };
}

interface PedidoNoApp { id: number; status: string | null; temPo: boolean; ultimaMudanca: string | null; dataEntrega: string | null }

/** Status em que o PO ainda pode ser (re)disparado pela importadora (mesma régua de STATUS_REDISPARAVEIS lá). */
const STATUS_REDISPARAVEIS = new Set(["aprovado_aguardando_disparo", "falha_envio"]);

/**
 * Pedidos do app por protocolo, COM o estado do PO (revisão Fable+Codex 2026-11, P1): estar no app não é estar
 * resolvido — gravado sem PO (Omie fora no disparo) precisa de re-disparo, não de "resolvido_em".
 */
async function pedidosNoApp(db: Db, protocolos: string[]): Promise<Map<string, PedidoNoApp>> {
  const m = new Map<string, PedidoNoApp>();
  if (protocolos.length === 0) return m;
  const linhas = await fetchAll<{ id: number; portal_protocolo: string | null; status: string | null; omie_pedido_compra_id: string | number | null; atualizado_em: string | null; enviado_portal_em: string | null; portal_data_entrega: string | null }>(
    (de, ate) => db.from("pedido_compra_sugerido").select("id, portal_protocolo, status, omie_pedido_compra_id, atualizado_em, enviado_portal_em, portal_data_entrega").in("portal_protocolo", protocolos)
      .order("id", { ascending: true }).range(de, ate),
    "varrer-portal:protocolos-no-app",
  );
  for (const r of linhas) {
    const prot = (r.portal_protocolo ?? "").trim();
    if (!prot) continue;
    const po = r.omie_pedido_compra_id == null ? "" : String(r.omie_pedido_compra_id).trim();
    // Última mudança do pedido (falha do disparo grava `atualizado_em`): base da carência do re-disparo (B5).
    m.set(prot, { id: r.id, status: r.status, temPo: po !== "" && po !== "0", ultimaMudanca: maisRecente(r.atualizado_em, r.enviado_portal_em), dataEntrega: r.portal_data_entrega });
  }
  return m;
}

async function contratosNoOmie(db: Db, protocolos: string[]): Promise<Set<string>> {
  if (protocolos.length === 0) return new Set();
  // O espelho guarda o contrato como foi digitado (a RPC compara com btrim): lê o universo OBEN com contrato e
  // normaliza aqui (paginado: o PostgREST capa em 1.000 silencioso).
  const linhas = await fetchAll<{ numero_contrato_fornecedor: string | null }>(
    (de, ate) => db.from("purchase_orders_tracking").select("id, numero_contrato_fornecedor")
      .eq("empresa", "OBEN").not("numero_contrato_fornecedor", "is", null)
      .order("id", { ascending: true }).range(de, ate),
    "varrer-portal:contratos-no-omie",
  );
  const alvo = new Set(protocolos);
  const achados = new Set<string>();
  for (const l of linhas) {
    for (const c of contratosDoTexto(l.numero_contrato_fornecedor)) if (alvo.has(c)) achados.add(c);
  }
  return achados;
}

async function emailFalha(db: Db, protocolo: string, mensagem: string): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  const { data: cfg } = await db.from("empresa_configuracao_custos").select("email_notificacoes").eq("empresa", "OBEN").maybeSingle();
  const para = (cfg as { email_notificacoes?: string | null } | null)?.email_notificacoes ?? "";
  if (!para) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [para],
      subject: `[Portal Sayerlack] Pedido ${protocolo} não entrou no Omie`,
      text: `A varredura automática achou o pedido ${protocolo} no portal Sayerlack, sem pedido de compra no Omie, ` +
        `e não conseguiu importá-lo:\n\n${mensagem}\n\nCorrija o motivo e use "Importar do portal" em Gerir pedidos ` +
        `(ou espere a próxima rodada: 12:30, 17:30, 22:30). Este aviso não se repete para o mesmo pedido.`,
    }),
  });
  await r.text();
  return r.ok;
}

/** Falha de importação: grava/atualiza a linha do protocolo e manda e-mail só na 1ª vez. Fail-open (observabilidade). */
async function registrarFalha(db: Db, protocolo: string, mensagem: string): Promise<{ notificado: boolean }> {
  try {
    const agora = new Date().toISOString();
    const { data: atual, error: errSel } = await db.from("sayerlack_varredura_falha")
      .select("protocolo, tentativas, notificado_em").eq("protocolo", protocolo).maybeSingle();
    if (errSel) throw new Error(errSel.message);
    const linha = atual as { tentativas: number; notificado_em: string | null } | null;
    if (!linha) {
      const { error } = await db.from("sayerlack_varredura_falha")
        .insert({ protocolo, mensagem, primeira_em: agora, ultima_em: agora, tentativas: 1 });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("sayerlack_varredura_falha")
        .update({ mensagem, ultima_em: agora, tentativas: (linha.tentativas ?? 0) + 1, resolvido_em: null })
        .eq("protocolo", protocolo);
      if (error) throw new Error(error.message);
    }
    if (linha?.notificado_em) return { notificado: false };
    const enviado = await emailFalha(db, protocolo, mensagem);
    if (enviado) await db.from("sayerlack_varredura_falha").update({ notificado_em: agora }).eq("protocolo", protocolo);
    return { notificado: enviado };
  } catch (e) {
    console.warn(`[varrer-portal] falha ao registrar a falha de ${protocolo} (fail-open): ${mensagemDeErro(e)}`);
    return { notificado: false };
  }
}

/**
 * "Não sei se entrou" vira trabalho DURÁVEL (revisão 2, B6): linha aberta em `sayerlack_varredura_falha` SEM e-mail e
 * sem afirmar falha — a próxima rodada (na janela) ou a reconsulta por número (fora dela, ≤ 1×/20 h) confere. Sem
 * isto, o indeterminado da última rodada em que o pedido cabia nos 7 dias saía da fila para sempre. false = não gravou.
 */
async function registrarIndeterminado(db: Db, protocolo: string, mensagem: string): Promise<boolean> {
  try {
    const agora = new Date().toISOString();
    const { data: atual, error: errSel } = await db.from("sayerlack_varredura_falha")
      .select("protocolo, tentativas").eq("protocolo", protocolo).maybeSingle();
    if (errSel) throw new Error(errSel.message);
    const linha = atual as { tentativas: number } | null;
    const { error } = linha
      ? await db.from("sayerlack_varredura_falha")
        .update({ mensagem, ultima_em: agora, tentativas: (linha.tentativas ?? 0) + 1, resolvido_em: null }).eq("protocolo", protocolo)
      : await db.from("sayerlack_varredura_falha").insert({ protocolo, mensagem, primeira_em: agora, ultima_em: agora, tentativas: 1 });
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn(`[varrer-portal] indeterminado de ${protocolo} NÃO registrado: ${mensagemDeErro(e)}`);
    return false;
  }
}

async function marcarResolvidos(db: Db, protocolos: string[]): Promise<void> {
  if (protocolos.length === 0) return;
  const { error } = await db.from("sayerlack_varredura_falha")
    .update({ resolvido_em: new Date().toISOString() }).in("protocolo", protocolos).is("resolvido_em", null);
  if (error) console.warn(`[varrer-portal] não marcou ${protocolos.length} protocolo(s) resolvido(s) (fail-open): ${error.message}`);
}

/** 1ª vista de cada protocolo (carência). Erro de leitura LANÇA: sem saber se já foi visto, ninguém importa. */
async function vistosAntes(db: Db, protocolos: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (protocolos.length === 0) return m;
  const linhas = await fetchAll<{ protocolo: string; primeira_vez_em: string }>(
    (de, ate) => db.from("sayerlack_varredura_visto").select("protocolo, primeira_vez_em").in("protocolo", protocolos)
      .order("protocolo", { ascending: true }).range(de, ate),
    "varrer-portal:vistos",
  );
  for (const l of linhas) m.set(l.protocolo, l.primeira_vez_em);
  return m;
}

/** Grava a 1ª vista (a que já existe não muda). Erro LANÇA: carência sem registro nunca venceria — e falharia calada. */
async function registrarVistos(db: Db, protocolos: string[]): Promise<void> {
  if (protocolos.length === 0) return;
  const { error } = await db.from("sayerlack_varredura_visto")
    .upsert(protocolos.map((protocolo) => ({ protocolo })), { onConflict: "protocolo", ignoreDuplicates: true });
  if (error) throw new Error(`Registro da 1ª vista: ${error.message}`);
}

/** Fim do último sync COMPLETE de pedidos de compra da OBEN (marcador 1-writer `sync_state`); outro status ⇒ null. */
async function syncPedidosCompletoEm(db: Db): Promise<string | null> {
  const { data, error } = await db.from("sync_state").select("status, last_sync_at")
    .eq("entity_type", "pedidos_compra").eq("account", "oben").maybeSingle();
  if (error) throw new Error(`Leitura do sync de pedidos de compra: ${error.message}`);
  const r = data as { status?: string | null; last_sync_at?: string | null } | null;
  return r?.status === "complete" && r.last_sync_at ? r.last_sync_at : null;
}

async function importar(protocolo: string, situacoes: string[], somenteSituacao = false): Promise<{ httpStatus: number; corpo: unknown }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/sayerlack-importar-pedido-portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      // A releitura da importadora tem de achar a MESMA situação que a varredura classificou (Codex P1, 2026-10-16/17):
      // um pedido que passou de Aberto para Atendido no meio da rodada escaparia da trava de NF.
      body: JSON.stringify(somenteSituacao ? { protocolo, situacoes_permitidas: situacoes, somente_situacao: true } : { protocolo, situacoes_permitidas: situacoes }),
      signal: ctrl.signal,
    });
    const txt = await resp.text();
    let corpo: unknown = txt.slice(0, 500);
    try { corpo = JSON.parse(txt); } catch { /* corpo fica o texto */ }
    return { httpStatus: resp.status, corpo };
  } finally {
    clearTimeout(timeout);
  }
}


// ── Registro da execução (Onda 3, item 3.6) ─────────────────────────────────────────────────────────────────────────
// Local, em vez de `comRegistro` (_shared, serve 10 edges): rodada que termina em erro guarda o RESUMO PARCIAL junto do
// erro — antes só `{erro}` sobrava e o "o que a rodada viu" sumia exatamente quando importava. Fail-open (observabilidade).
async function abrirExecucao(db: Db, auth: { via: string; userId?: string }, acao: string): Promise<string | null> {
  try {
    const manual = auth.via === "staff";
    const { data, error } = await db.from("acoes_execucoes")
      .insert({ acao, origem: manual ? "manual" : "automatica", executado_por: manual ? (auth.userId ?? null) : null })
      .select("id").single();
    if (error || !data) { console.warn(`[varrer-portal] registro não abriu (fail-open): ${error?.message ?? "sem id"}`); return null; }
    return (data as { id: string }).id;
  } catch (e) {
    console.warn(`[varrer-portal] registro não abriu (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
    return null;
  }
}

async function fecharExecucao(db: Db, id: string | null, status: "sucesso" | "erro", detalhes: Record<string, unknown>): Promise<void> {
  if (!id) return;
  try {
    const { error } = await db.from("acoes_execucoes").update({ status, finalizado_em: new Date().toISOString(), detalhes }).eq("id", id);
    if (error) console.warn(`[varrer-portal] registro não fechou (fail-open): ${error.message}`);
  } catch (e) {
    console.warn(`[varrer-portal] registro não fechou (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
  }
}

/** Falhas abertas da varredura (para reconsultar por número as que ficaram fora da janela lida). Erro LANÇA. */
async function falhasAbertas(db: Db): Promise<{ protocolo: string; primeira_em: string; ultima_em: string }[]> {
  const { data, error } = await db.from("sayerlack_varredura_falha").select("protocolo, primeira_em, ultima_em")
    .is("resolvido_em", null).order("ultima_em", { ascending: true }).limit(1000);
  if (error) throw new Error(`Leitura das falhas abertas: ${error.message}`);
  return (data ?? []) as { protocolo: string; primeira_em: string; ultima_em: string }[];
}

/** Pedidos do app com protocolo do portal e sem PO, re-disparáveis, gravados há mais de 1 h (o envio normal já teve a
 *  chance dele). Sem filtro de data de emissão: é o que a janela de 7 dias deixava para trás (item 3.7). Erro LANÇA. */
async function appSemPoAntigos(db: Db): Promise<{ protocolo: string; pedido_id: number }[]> {
  const limite = new Date(Date.now() - 3600_000).toISOString();
  // Paginado (o PostgREST capa em 1.000 em silêncio — um corte aqui viraria "não há mais pendência").
  const linhas = await fetchAll<{ id: number; portal_protocolo: string | null; omie_pedido_compra_id: string | null }>(
    (de, ate) => db.from("pedido_compra_sugerido").select("id, portal_protocolo, omie_pedido_compra_id")
      .eq("empresa", "OBEN").eq("status_envio_portal", "sucesso_portal").in("status", [...STATUS_REDISPARAVEIS])
      .not("portal_protocolo", "is", null).lt("enviado_portal_em", limite).order("id", { ascending: true }).range(de, ate),
    "varrer-portal:app-sem-po-antigos",
  );
  return linhas
    .filter((r) => { const po = (r.omie_pedido_compra_id ?? "").trim(); return po === "" || po === "0"; })
    .map((r) => ({ protocolo: (r.portal_protocolo ?? "").trim(), pedido_id: r.id }));
}

/**
 * RESERVA a tentativa de reconsulta antes de qualquer decisão sobre ela (`ultima_em` = agora), de forma CONDICIONAL no
 * banco: só reserva se a última tentativa foi há mais de 20 h (ou se não há linha — o INSERT falha por PK se outra
 * execução reservou primeiro). Duas execuções simultâneas nunca abrem o navegador para o mesmo protocolo, e todo item da
 * fila — inclusive o que só "continua" — gira para o fim (Codex P2, 2ª rodada). false = não reservou: pula.
 */
async function reservarTentativa(db: Db, protocolo: string, mensagem: string): Promise<"reservado" | "disputa" | "erro"> {
  const agora = new Date().toISOString();
  const limite = new Date(Date.now() - INTERVALO_RECONSULTA_MS).toISOString();
  const { data: atual, error } = await db.from("sayerlack_varredura_falha").select("protocolo").eq("protocolo", protocolo).maybeSingle();
  if (error) { console.warn(`[varrer-portal] reserva de ${protocolo} não lida: ${error.message}`); return "erro"; }
  if (atual) {
    const { data, error: e2 } = await db.from("sayerlack_varredura_falha").update({ ultima_em: agora, resolvido_em: null })
      .eq("protocolo", protocolo).lt("ultima_em", limite).select("protocolo").maybeSingle();  // PK: 0 ou 1 linha
    if (e2) { console.warn(`[varrer-portal] reserva de ${protocolo} não gravada: ${e2.message}`); return "erro"; }
    return data ? "reservado" : "disputa";
  }
  const { error: e3 } = await db.from("sayerlack_varredura_falha")
    .insert({ protocolo, mensagem, primeira_em: agora, ultima_em: agora, tentativas: 1 });  // CHECK tentativas >= 1
  // PK duplicada = outra execução reservou primeiro (disputa legítima); qualquer outro erro é OPERACIONAL (Codex P2).
  if (e3) return e3.code === "23505" ? "disputa" : (console.warn(`[varrer-portal] reserva de ${protocolo} não gravada: ${e3.message}`), "erro");
  return "reservado";
}

/** Re-disparo de pedido cuja entrega está fora da janela que o sync de pedidos de compra cobre (B5, Codex revisão 2). */
function mensagemForaDaCobertura(protocolo: string, pedidoId: number, entrega: string | null): string {
  return `Pedido ${protocolo} está no app (#${pedidoId}) sem pedido de compra, mas a entrega dele (${entrega ?? "sem data"}) ` +
    `está fora da janela que o sync de pedidos de compra do Omie confere: o espelho não prova que ninguém lançou o PO à ` +
    `mão. O cron não re-dispara — confira no Omie e use "Importar do portal".`;
}

/** Re-disparo esperando o sync do espelho há mais de 6 h (B5): pendência visível, como a carência presa (3.9). */
function mensagemRedisparoTravado(protocolo: string, pedidoId: number, desde: string | null): string {
  return `Pedido ${protocolo} está no app (#${pedidoId}) sem pedido de compra e o re-disparo automático espera o sync de ` +
    `pedidos de compra do Omie terminar "complete" depois da última tentativa (${desde ?? "data desconhecida"}), há mais de 6 h. ` +
    `Sem isso, um PO lançado à mão no Omie depois da falha não aparece no espelho e o re-disparo duplicaria. Confira o ` +
    `sync, ou o Omie, e use "Importar do portal".`;
}

/** Reconsulta por número a cada no máximo este intervalo (a falha aberta grava `ultima_em` a cada tentativa). */
const INTERVALO_RECONSULTA_MS = 20 * 3600_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: { modo?: unknown } = {};
  try {
    body = (await req.json()) as { modo?: unknown };
  } catch {
    return json({ ok: false, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial, antes de qualquer leitura/escrita ou do portal.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  if (body?.modo !== "listar" && body?.modo !== "importar") {
    return json({ ok: false, mensagem: 'Informe modo "listar" (só relata) ou "importar".' }, 400);
  }
  const modo = body.modo;
  const t0 = Date.now();
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  // O resumo vai sendo montado AQUI fora: se a rodada lançar no meio, o registro guarda o que ela já tinha visto (3.6).
  let resumoFinal: Record<string, unknown> = { modo, versao: VERSAO };
  const registro = await abrirExecucao(db, auth, modo === "listar" ? ACAO_REGISTRO_LISTAR : ACAO_REGISTRO);
  const falhasReconciliacao: { pedido_id: number; protocolo: string; mensagem: string }[] = [];
  const falhasSituacao: string[] = [];
  const falhasCobertura: string[] = [];
  // 4.3: sessões do Browserless (cota do plano) por rodada. Cada leitura da lista abre uma. A importação conta pelo que
  // a importadora DIZ (`sessao_browserless`): já com PO, recusa antes do portal e config ausente não abrem sessão.
  // Sem o campo (importadora antiga, corpo não-JSON, timeout) é INDETERMINADO — nunca zero, nunca um fabricado.
  const sessoes = { leitura_portal: 0, importacao: 0, importacao_sem_sessao: 0, importacao_indeterminada: 0 };
  const lerPortalContado = (desde: string) => { sessoes.leitura_portal += 1; return lerPortal(desde); };
  const importarContado = async (protocolo: string, situacoes: string[], somenteSituacao = false) => {
    let r: Awaited<ReturnType<typeof importar>>;
    try {
      r = await importar(protocolo, situacoes, somenteSituacao);
    } catch (e) {
      // Codex P2: rede/timeout LANÇA — a chamada saiu, então é indeterminada (nunca some da contagem).
      sessoes.importacao_indeterminada += 1;
      throw e;
    }
    const sessao = (r.corpo as { sessao_browserless?: unknown } | null)?.sessao_browserless;
    if (sessao === true) sessoes.importacao += 1;
    else if (sessao === false) sessoes.importacao_sem_sessao += 1;
    else sessoes.importacao_indeterminada += 1;
    // B3: situação lida pela importadora e não gravada é problema DA RODADA (vermelha), não só do e-mail.
    if ((r.corpo as { situacao_gravada?: unknown } | null)?.situacao_gravada === "erro") {
      falhasSituacao.push(`importadora não gravou a situação de ${protocolo}`);
    }
    return r;
  };
  const sessoesBrowserless = () => {
    const minimo = sessoes.leitura_portal + sessoes.importacao;
    const maximo = minimo + sessoes.importacao_indeterminada;
    // `total` só quando é sabido: com indeterminada, null + a faixa [total_minimo, total_maximo].
    return { ...sessoes, total: maximo === minimo ? minimo : null, total_minimo: minimo, total_maximo: maximo };
  };
  // 4.2: causa de falha ANTES do protocolo (sem leitura provada não há protocolo a avisar). O vigia do data_health
  // (`sayerlack_varredura_portal`) lê este campo do registro e manda 1 e-mail por causa.
  let causaPreProtocolo: string | null = null;

  try {
    const resumo = { ...(await rodada()), sessoes_browserless: sessoesBrowserless() };
    await fecharExecucao(db, registro, "sucesso", resumo);
    return json({ ok: true, ...resumo });
  } catch (e) {
    const mensagem = mensagemDeErro(e) ?? "erro inesperado";
    // Sem leitura provada, a falha é anterior ao protocolo: grava a causa (a exceção sem marca vira "excecao").
    const causa = resumoFinal.prova_leitura === "ok" ? {} : { causa_pre_protocolo: causaPreProtocolo ?? "excecao" };
    const detalhes = { ...resumoFinal, ...causa, sessoes_browserless: sessoesBrowserless(), erro: mensagem.slice(0, 600) };
    await fecharExecucao(db, registro, "erro", detalhes);
    return json({ ok: false, mensagem, ...resumoFinal, ...causa, sessoes_browserless: detalhes.sessoes_browserless }, 500);
  }

  /** Escritor único da situação (Onda 5A). Erro não some: vira problema da rodada (vermelha no fim). */
  async function gravarSituacoes(itens: ObservacaoSituacao[], de: string, ate: string): Promise<Record<string, unknown>> {
    if (itens.length === 0) return { enviadas: 0 };
    const chamar = () => db.rpc("sayerlack_registrar_situacao_portal", { p_lido_de: de, p_lido_ate: ate, p_itens: itens });
    let { data, error } = await chamar();
    // 1 nova tentativa (revisão 2, B3): o 6 lido e não gravado deixa a compra liberada pelo estado antigo.
    if (error) ({ data, error } = await chamar());
    if (error) {
      falhasSituacao.push(error.message.slice(0, 200));
      // Persistir o VETO é dinheiro, não telemetria: cada 6 não gravado vira pendência com e-mail (o vigia do
      // data_health ignora falha depois da prova de leitura — o aviso é por protocolo).
      const cancelados = itens.filter((i) => i.codigo === "6");
      for (const c of cancelados) {
        await registrarFalha(db, c.protocolo,
          `Pedido ${c.protocolo} está "${c.texto}" no portal, mas o bloqueio NÃO foi gravado no pedido do app ` +
            `(${error.message.slice(0, 120)}). Até a próxima leitura gravar, o disparo automático ainda pode criar o pedido ` +
            `de compra: confira o pedido em Gerir pedidos.`);
      }
      return { enviadas: itens.length, erro: error.message.slice(0, 200), cancelados_nao_gravados: cancelados.map((c) => c.protocolo) };
    }
    const r = (data ?? {}) as { aceitos?: { pedido_id: number; protocolo: string; codigo: string }[]; ignorados?: number; fora_de_ordem?: number };
    return {
      enviadas: itens.length, aceitas: r.aceitos?.length ?? 0, ignoradas: r.ignorados ?? 0, fora_de_ordem: r.fora_de_ordem ?? 0,
      canceladas: (r.aceitos ?? []).filter((a) => a.codigo === "6").map((a) => ({ pedido_id: a.pedido_id, protocolo: a.protocolo })),
    };
  }

  async function rodada(): Promise<Record<string, unknown>> {
    // 0a. Portal fora do ar: não abre o navegador.
    if (portalSayerlackFechado(new Date())) {
      return { modo, versao: VERSAO, pulado: "portal_fechado", mensagem: "Portal Sayerlack fora do ar (sábado 12h → segunda 6h): rodada pulada." };
    }
    // 0b. Pedido do app em voo/conciliação: pode ser ele o "pedido novo" do portal — a rodada NÃO IMPORTA nem
    //     re-dispara nada. Mas LÊ e grava as situações (revisão 2, B4): um pedido em conciliação não pode desligar a
    //     observação dos cancelamentos dos demais (o claim de disparo só recusa o 6 persistido).
    const bloqueio = motivoBloqueio(await pedidosEmVoo(db));

    const faltando = [
      ["SAYERLACK_PORTAL_USER", SAYERLACK_PORTAL_USER], ["SAYERLACK_PORTAL_PASS", SAYERLACK_PORTAL_PASS],
      ["SAYERLACK_PORTAL_URL", SAYERLACK_PORTAL_URL], ["SAYERLACK_PORTAL_CLIENTE_CODIGO", SAYERLACK_PORTAL_CLIENTE_CODIGO],
      ["BROWSERLESS_TOKEN", BROWSERLESS_TOKEN],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (faltando.length > 0) {
      causaPreProtocolo = "config_ausente";
      throw new Error(`Configuração ausente: ${faltando.join(", ")}`);
    }

    // 1. Lê a lista no portal.
    const hoje = hojeSP();
    const emissaoDesde = inicioDaJanela(hoje);
    // [lidoDe, lidoAte] = intervalo da OBSERVAÇÃO das situações (Onda 5A): o banco só deixa uma leitura substituir a
    // vigente se começou depois de ela terminar.
    const lidoDe = new Date().toISOString();
    const envelope = await lerPortalContado(emissaoDesde);
    const lidoAte = new Date().toISOString();
    console.log(`[varrer-portal] Browserless ${Date.now() - t0}ms tipo=${envelope.erroTipo ?? "-"} linhas=${envelope.linhas?.length ?? "-"}`);
    if (envelope.success !== true) {
      causaPreProtocolo = `leitura:${envelope.erroTipo ?? "desconhecido"}`;
      throw new Error(`Leitura do portal falhou (${envelope.erroTipo ?? "?"}): ${envelope.erro ?? "sem detalhe"}`);
    }

    // 1b. PROVA de leitura completa (Onda 3, 3.1–3.4): colunas certas, total anunciado = linhas lidas (0 só com "0 de
    //     0"), nenhuma linha ilegível ou repetida. Lista sem prova não decide nada — nem "não há pedido".
    const lista = lerListaConsulta(envelope.linhas ?? []);
    const prova = provarLeitura({
      headers: envelope.headers ?? [], linhasLidas: (envelope.linhas ?? []).length,
      respostaTotal: envelope.resposta_total, dtTotal: envelope.dt_total, info: envelope.info, ilegiveis: lista.ilegiveis, repetidos: lista.repetidos,
    });
    resumoFinal = {
      modo, versao: VERSAO, emissao_desde: emissaoDesde, paginas: envelope.paginas ?? null, info_portal: envelope.info ?? null,
      total_anunciado: prova.ok ? prova.total : (envelope.resposta_total ?? null), dt_total: envelope.dt_total ?? null, resposta_chaves: envelope.resposta_chaves ?? null,
      linhas_lidas: (envelope.linhas ?? []).length, lidos: lista.pedidos.length, ilegiveis: lista.ilegiveis, repetidos: lista.repetidos,
      cabecalhos: envelope.headers ?? [], ilegiveis_detalhe: lista.ilegiveis_detalhe.slice(0, 20),
      // Rodada bloqueada não é "efetiva": o vigia exige prova_leitura='ok' e ela NÃO importou — o nome é outro.
      prova_leitura: prova.ok ? (bloqueio ? "ok_bloqueado" : "ok") : prova.motivo,
    };
    if (!prova.ok) causaPreProtocolo = `prova:${prova.motivo}`;
    // Ilegível/repetido: a rodada segue para o resto (os legíveis são legíveis), mas termina VERMELHA no fim (3.4).
    // O resto das falhas de prova não deixa decidir nada: erro já.
    if (!prova.ok && prova.motivo !== "linhas_ilegiveis" && prova.motivo !== "protocolo_repetido") {
      throw new Error(`Leitura do portal sem prova (${prova.motivo}): ${prova.detalhe}`);
    }

    // 2. Classifica.
    const protocolos = lista.pedidos.map((p) => p.protocolo);
    // Observar situações só precisa dos pedidos do app (Codex revisão 2, B4): espelho/vistas/sync vêm DEPOIS, para
    // uma falha neles nunca impedir a gravação de um cancelamento já lido.
    const noApp = await pedidosNoApp(db, protocolos);
    if (bloqueio) {
      if (modo === "importar") {
        resumoFinal = {
          ...resumoFinal,
          situacoes: await gravarSituacoes(observacoesDaLista(lista.pedidos, new Set(noApp.keys()), { soCancelados: !prova.ok }), lidoDe, lidoAte),
        };
      }
      // A cobertura (5.4) é só OBSERVAÇÃO: roda também bloqueada — senão um pedido em conciliação deixaria os demais,
      // fora dos 7 dias, sem leitura e a rodada sairia verde (Codex 5.4 P1). Falha dela deixa a rodada vermelha.
      if (modo === "importar") {
        resumoFinal = { ...resumoFinal, cobertura: await cobrir(hoje, () => Date.now() - t0 + FOLGA_POR_IMPORTACAO_MS > TETO_EDGE_MS) };
      }
      if (falhasSituacao.length > 0) {
        causaPreProtocolo = "bloqueado:situacao_nao_gravada";
        throw new Error(`Rodada bloqueada (${bloqueio}) e a situação do portal não foi gravada: ${falhasSituacao.join(" · ")}`);
      }
      if (!prova.ok) {
        causaPreProtocolo = `prova:${prova.motivo}`;
        throw new Error(`Rodada bloqueada (${bloqueio}) e leitura incompleta (${prova.motivo}): ${prova.detalhe}`);
      }
      if (falhasCobertura.length > 0) {
        causaPreProtocolo = "bloqueado:cobertura";
        throw new Error(`Rodada bloqueada (${bloqueio}); cobertura da situação dos pedidos com compra em aberto: ${falhasCobertura.join(" · ")}`);
      }
      return { ...resumoFinal, pulado: "bloqueado", mensagem: `Rodada não importa: ${bloqueio}. Situações do portal lidas e gravadas.` };
    }
    // 2b. Onda 5A (ANTES do espelho/vistas/sync — Codex revisão 2, B4): a situação de cada pedido do app vai para o pedido (escritor único). Só com leitura PROVADA —
    //     ilegível/repetido seguem a rodada, mas não viram evidência. É o que faz o claim de disparo recusar o 6.
    //     Com linha ilegível/repetida (a rodada segue, vermelha no fim), só os 6 de linhas únicas entram: bloquear com
    //     leitura imperfeita é seguro, liberar não (Codex 5A rodada 8).
    if (modo === "importar") {
      resumoFinal = {
        ...resumoFinal,
        situacoes: await gravarSituacoes(observacoesDaLista(lista.pedidos, new Set(noApp.keys()), { soCancelados: !prova.ok }), lidoDe, lidoAte),
      };
    }
    const [noOmie, vistos, syncEm] = await Promise.all([
      contratosNoOmie(db, protocolos), vistosAntes(db, protocolos), syncPedidosCompletoEm(db),
    ]);
    const preCarencia = classificar(lista.pedidos, {
      protocolosNoApp: new Set(noApp.keys()), contratosNoOmie: noOmie, situacoesImportaveis: SITUACOES_IMPORTAVEIS, emissaoDesde,
    });
    // A 1ª vista só conta em rodada de IMPORTAR: "listar" não tem efeito sobre compras futuras (Codex P2).
    if (modo === "importar") {
      await registrarVistos(db, preCarencia.filter((p) => p.classe === "candidato" && !vistos.has(p.protocolo)).map((p) => p.protocolo));
    }
    const classificados = aplicarCarencia(preCarencia, vistos, syncEm);
    const candidatos = classificados.filter((p) => p.classe === "candidato");
    const contagem: Record<string, number> = {};
    for (const p of classificados) contagem[p.classe] = (contagem[p.classe] ?? 0) + 1;
    const semPo = classificados.filter((p) => p.classe === "ja_no_app" && noApp.get(p.protocolo)?.temPo === false);
    resumoFinal = {
      ...resumoFinal, contagem, situacoes_portal: envelope.situacoes ?? [],
      // Só o que NÃO está no app nem no Omie — é o que o founder precisa olhar.
      fora_do_app: classificados.filter((p) => p.classe !== "ja_no_app" && p.classe !== "ja_no_omie")
        .map((p) => ({ protocolo: p.protocolo, situacao: p.situacao, emissao: p.emissao, classe: p.classe })),
      sem_po: semPo.map((p) => ({ protocolo: p.protocolo, pedido_id: noApp.get(p.protocolo)?.id ?? null, status: noApp.get(p.protocolo)?.status ?? null })),
    };
    // "listar" é ZERO efeito (3.10): nem marca resolvido, nem grava vista, nem importa, nem avisa.
    if (modo === "importar") {
      // Falha aberta só se resolve com PO CONFIRMADO: no app com PO, ou no espelho do Omie.
      await marcarResolvidos(db, classificados.filter((p) =>
        (p.classe === "ja_no_app" && noApp.get(p.protocolo)?.temPo === true) || p.classe === "ja_no_omie").map((p) => p.protocolo));
    }
    const semTempo = () => Date.now() - t0 + FOLGA_POR_IMPORTACAO_MS > TETO_EDGE_MS;

    // 3. Candidatos NOVOS primeiro (Codex P2, 2026-11-07): um re-disparo lento não pode gastar o orçamento da rodada e
    //    adiar o pedido novo; os re-disparos e as reconsultas vêm depois, com o que sobrar.
    const importados: unknown[] = [];
    const falhas: unknown[] = [];
    const adiados: string[] = [];
    const indeterminados: unknown[] = [];
    resumoFinal = { ...resumoFinal, importados, falhas, adiados, indeterminados };
    if (modo === "importar") {
      for (const c of candidatos) {
        if (semTempo()) { adiados.push(c.protocolo); continue; }
        const bloq = motivoBloqueio(await pedidosEmVoo(db));
        if (bloq) {
          // Adiar por pedido do app em voo é LEGÍTIMO — não é falha da rodada.
          adiados.push(c.protocolo);
          break;
        }
        if ((await pedidosNoApp(db, [c.protocolo])).size > 0) continue; // entrou no app durante a rodada
        // A prova de "não está no Omie / NF não lançada" é RELIDA agora, não a do começo da rodada (Codex P1).
        const omieAgora = await contratosNoOmie(db, [c.protocolo]);
        const reclasse = classificar([c], {
          protocolosNoApp: new Set(), contratosNoOmie: omieAgora, situacoesImportaveis: SITUACOES_IMPORTAVEIS, emissaoDesde,
        })[0].classe;
        if (reclasse !== "candidato") { adiados.push(c.protocolo); continue; }
        const r = await importarContado(c.protocolo, [c.situacao_codigo as string])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        const desfecho = desfechoImportacao(r.httpStatus, r.corpo);
        console.log(`[varrer-portal] ${c.protocolo}: importar HTTP ${r.httpStatus} desfecho=${desfecho}`);
        // Sem RESPOSTA da importadora (prazo do gateway, rede, corpo sem o contrato dela): o PO pode ter saído depois.
        // INDETERMINADO, sem e-mail — mas durável (B6): a pendência aberta faz a próxima rodada/reconsulta conferir.
        if (desfecho === "ok") {
          importados.push({ protocolo: c.protocolo, mensagem: res.mensagem });
          await marcarResolvidos(db, [c.protocolo]);
        } else if (desfecho === "indeterminado") {
          const registrado = await registrarIndeterminado(db, c.protocolo,
            `Não sei se o pedido ${c.protocolo} entrou (importação sem resposta, HTTP ${r.httpStatus}): a próxima rodada confere.`);
          indeterminados.push({ protocolo: c.protocolo, http: r.httpStatus, registrado });
        } else {
          const { notificado } = await registrarFalha(db, c.protocolo, res.mensagem);
          falhas.push({ protocolo: c.protocolo, mensagem: res.mensagem, notificado });
        }
      }
    }

    // 4. Re-disparo de pedido no app SEM PO. A importadora relê a situação no portal antes (v1.5) — cancelado ou fora
    //    da lista não vira PO. Re-disparo que FALHA deixa a rodada vermelha (3.5).
    const redisparos: { protocolo: string; pedido_id: number | null; acao: string; [k: string]: unknown }[] = [];
    resumoFinal = { ...resumoFinal, redisparos };
    if (modo === "importar") {
      for (const p of semPo) {
        const ped = noApp.get(p.protocolo);
        if (!ped || !ped.status || !STATUS_REDISPARAVEIS.has(ped.status)) {
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped?.id ?? null, status: ped?.status ?? null, acao: "nao_redisparavel" });
          continue;
        }
        if (semTempo()) { redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "adiado_tempo" }); continue; }
        if (!(p.situacao_codigo && SITUACOES_IMPORTAVEIS.has(p.situacao_codigo))) {
          const { notificado } = await registrarFalha(db, p.protocolo,
            `Pedido ${p.protocolo} está no app (#${ped.id}) sem pedido de compra no Omie, mas está "${p.situacao}" no portal — ` +
              `o cron não re-dispara. Confira no portal e abra o pedido #${ped.id} em Gerir pedidos.`);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "situacao_impeditiva", notificado });
          continue;
        }
        // B5: carência do re-disparo — o sync do espelho tem de ter terminado depois da última mudança do pedido, que é
        // RELIDA agora (outro disparo pode ter falhado durante a rodada; Codex revisão 2) — e a entrega do pedido tem
        // de cair na janela que o sync cobre.
        const pedAgora = (await pedidosNoApp(db, [p.protocolo])).get(p.protocolo);
        if (!pedAgora || pedAgora.id !== ped.id || pedAgora.temPo || !pedAgora.status || !STATUS_REDISPARAVEIS.has(pedAgora.status)) {
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "mudou_durante_a_rodada" });
          continue;
        }
        if (!entregaCobertaPeloSync(pedAgora.dataEntrega, hoje)) {
          const { notificado } = await registrarFalha(db, p.protocolo, mensagemForaDaCobertura(p.protocolo, ped.id, pedAgora.dataEntrega));
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "fora_da_cobertura_do_sync", notificado });
          continue;
        }
        const car = carenciaRedisparo(pedAgora.ultimaMudanca, syncEm, Date.now());
        if (car !== "pode") {
          const notificado = car === "aguarda_sync_travado"
            ? (await registrarFalha(db, p.protocolo, mensagemRedisparoTravado(p.protocolo, ped.id, ped.ultimaMudanca))).notificado
            : undefined;
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: car, notificado });
          continue;
        }
        if ((await contratosNoOmie(db, [p.protocolo])).size > 0) {
          const { notificado } = await registrarFalha(db, p.protocolo,
            `Pedido ${p.protocolo}: o #${ped.id} do app está sem pedido de compra, mas já existe PO no Omie com este contrato ` +
              `(lançado à mão?). O cron não re-dispara para não duplicar — não lance outro PO.`);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "po_ja_no_omie", notificado });
          continue;
        }
        const r = await importarContado(p.protocolo, [p.situacao_codigo])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        const desfecho = desfechoImportacao(r.httpStatus, r.corpo);
        if (desfecho === "ok") {
          await marcarResolvidos(db, [p.protocolo]);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "po_criado" });
        } else if (desfecho === "indeterminado") {
          const registrado = await registrarIndeterminado(db, p.protocolo,
            `Não sei se o re-disparo do pedido ${p.protocolo} (#${ped.id}) criou o pedido de compra (sem resposta, HTTP ${r.httpStatus}): a próxima rodada confere.`);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "indeterminado", http: r.httpStatus, registrado });
        } else {
          const { notificado } = await registrarFalha(db, p.protocolo,
            `Pedido ${p.protocolo} está no app (#${ped.id}) sem pedido de compra no Omie e o re-disparo não confirmou: ${res.mensagem}`);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "falhou", notificado, mensagem: res.mensagem });
        }
      }
    }

    // 5. Pendências ALÉM da janela de 7 dias (3.7): pedido do app sem PO e falha aberta cujo protocolo não apareceu na
    //    lista lida são reconsultados POR NÚMERO pela importadora (lê o pedido, a situação, e só então grava/re-dispara),
    //    com teto por rodada e no máximo 1 vez a cada 20 h por protocolo (cada uma é 1 sessão do Browserless).
    const reconsultas: { protocolo: string; acao: string; [k: string]: unknown }[] = [];
    resumoFinal = { ...resumoFinal, reconsultas };
    if (modo === "importar") {
      const [abertas, appSemPo] = await Promise.all([falhasAbertas(db), appSemPoAntigos(db)]);
      const ultimaDaFalha = new Map(abertas.map((f) => [f.protocolo, f.ultima_em]));
      const recentes = new Set(abertas.filter((f) => Date.now() - Date.parse(f.ultima_em) < INTERVALO_RECONSULTA_MS).map((f) => f.protocolo));
      const fila = reconsultasForaDaJanela({
        lidos: new Set(protocolos),
        semPoNoApp: appSemPo.filter((p) => !recentes.has(p.protocolo)).map((p) => ({ ...p, ultima_tentativa: ultimaDaFalha.get(p.protocolo) ?? null })),
        falhasAbertas: abertas.filter((f) => !recentes.has(f.protocolo)),
      });
      for (const q of fila) {
        if (semTempo()) { reconsultas.push({ ...q, acao: "adiado_tempo" }); continue; }
        if (motivoBloqueio(await pedidosEmVoo(db))) { reconsultas.push({ ...q, acao: "adiado_em_voo" }); break; }
        const reserva = await reservarTentativa(db, q.protocolo, q.origem === "app_sem_po"
          ? `Pedido ${q.protocolo} (#${q.pedido_id}) no app sem pedido de compra, fora da janela da varredura: reconsulta por número.`
          : `Reconsulta por número de pendência fora da janela da varredura.`);
        if (reserva !== "reservado") { reconsultas.push({ ...q, acao: reserva === "disputa" ? "reservado_por_outra_execucao" : "falhou", mensagem: reserva === "erro" ? "reserva da tentativa não gravou no banco" : undefined }); continue; }
        // Reconfere o BANCO antes de abrir o navegador (Codex P2): PO já no Omie resolve sem gastar sessão.
        const [noAppQ, omieQ] = await Promise.all([pedidosNoApp(db, [q.protocolo]), contratosNoOmie(db, [q.protocolo])]);
        const pedQ = noAppQ.get(q.protocolo) ?? null;
        if (!pedQ) {
          if (omieQ.size > 0) { await marcarResolvidos(db, [q.protocolo]); reconsultas.push({ ...q, acao: "ja_no_omie_resolvido" }); continue; }
          // Sem pedido no app, a reconsulta pode CRIAR o PO: a carência vale aqui também (Codex P1) — sair da janela
          // nunca libera uma compra que o sync do espelho ainda não deixou provar que não foi lançada à mão.
          const vistosQ = await vistosAntes(db, [q.protocolo]);
          // Sem 1ª vista (ex.: virou falha como "atendido", nunca foi candidato): grava agora — sem isto a carência nunca
          // venceria (Codex P2, 2ª rodada).
          if (!vistosQ.has(q.protocolo)) await registrarVistos(db, [q.protocolo]);
          const cl = aplicarCarencia([{ protocolo: q.protocolo, situacao: "", situacao_codigo: null, emissao: null, classe: "candidato" }], vistosQ, syncEm)[0];
          if (cl.classe !== "candidato") { reconsultas.push({ ...q, acao: cl.classe }); continue; }
        } else if (pedQ.temPo) {
          await marcarResolvidos(db, [q.protocolo]); reconsultas.push({ ...q, acao: "po_ja_no_app_resolvido" }); continue;
        } else if (omieQ.size > 0) {
          // Pedido no app sem PO e PO manual no Omie: pendência de vinculação (item 7.1), não re-disparo. A situação é
          // relida mesmo assim (só situação): a pendência pode ser um 6 que o botão leu e não gravou (Codex rodada 2).
          const rs = await importarContado(q.protocolo, [...SITUACOES_IMPORTAVEIS], true)
            .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
          reconsultas.push({ ...q, acao: "po_manual_no_omie", situacao_relida: (rs.corpo as { situacao_gravada?: unknown } | null)?.situacao_gravada ?? null });
          continue;
        } else {
          // B5: pedido do app sem PO — a reconsulta RE-DISPARA; mesma carência e cobertura do re-disparo da janela.
          // Sem elas, a reconsulta ainda RELÊ e GRAVA a situação (só situação, sem disparo): é o que persiste um 6 que
          // a importadora leu e não conseguiu gravar (B3, Codex revisão 2).
          const coberta = entregaCobertaPeloSync(pedQ.dataEntrega, hoje);
          const car = carenciaRedisparo(pedQ.ultimaMudanca, syncEm, Date.now());
          if (!coberta || car !== "pode") {
            const msg = !coberta ? mensagemForaDaCobertura(q.protocolo, pedQ.id, pedQ.dataEntrega)
              : car === "aguarda_sync_travado" ? mensagemRedisparoTravado(q.protocolo, pedQ.id, pedQ.ultimaMudanca) : null;
            const notificado = msg ? (await registrarFalha(db, q.protocolo, msg)).notificado : undefined;
            const rs = await importarContado(q.protocolo, [...SITUACOES_IMPORTAVEIS], true)
              .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
            const sg = (rs.corpo as { situacao_gravada?: unknown } | null)?.situacao_gravada ?? null;
            reconsultas.push({ ...q, acao: !coberta ? "fora_da_cobertura_do_sync" : car, notificado, situacao_relida: sg });
            continue;
          }
        }
        const r = await importarContado(q.protocolo, [...SITUACOES_IMPORTAVEIS])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        const desfecho = desfechoImportacao(r.httpStatus, r.corpo);
        const c = (r.corpo && typeof r.corpo === "object" ? r.corpo : {}) as { motivo?: unknown; pedido_id?: unknown };
        if (desfecho === "ok") {
          await marcarResolvidos(db, [q.protocolo]);
          reconsultas.push({ ...q, acao: "po_confirmado" });
        } else if (desfecho === "indeterminado") {
          // A reserva já deixou a linha aberta com `ultima_em` = agora: a próxima reconsulta (≥ 20 h) confere (B6).
          reconsultas.push({ ...q, acao: "indeterminado", http: r.httpStatus });
        } else if (c.motivo === "pedido_cancelado" && c.pedido_id == null) {
          // Cancelado no portal e nunca gravado no app: não há compra a fazer — a pendência acabou.
          await marcarResolvidos(db, [q.protocolo]);
          reconsultas.push({ ...q, acao: "cancelado_no_portal_resolvido" });
        } else {
          // Situação fora da lista (atendido, pendente) é pendência HUMANA esperada; o resto é falha OPERACIONAL e deixa
          // a rodada vermelha como o re-disparo dentro da janela (Codex P2).
          const humana = c.motivo === "situacao_nao_permitida";
          const { notificado } = await registrarFalha(db, q.protocolo, `Reconsulta além da janela: ${res.mensagem}`);
          reconsultas.push({ ...q, acao: humana ? "pendente_humano" : "falhou", notificado, mensagem: res.mensagem });
        }
      }
    }


    // 6. Carência presa esperando o sync do espelho há mais de 6 h (3.9): o sync de pedidos de compra travou e nada
    //    importa sozinho — vira pendência visível (e-mail 1 vez por protocolo), não espera eterna em silêncio.
    const travados = carenciaTravada(classificados, vistos, Date.now());
    const carenciaPresa: unknown[] = [];
    if (modo === "importar") {
      for (const t of travados) {
        const { notificado } = await registrarFalha(db, t.protocolo,
          `Pedido ${t.protocolo} está esperando o sync de pedidos de compra do Omie desde ${t.visto_em} (mais de 6 h): a ` +
            `importação automática não sai enquanto o sync não terminar "complete". Confira o sync ou use "Importar do portal".`);
        carenciaPresa.push({ ...t, notificado });
      }
    } else {
      carenciaPresa.push(...travados);
    }
    // Atendido sem PO: e-mail 1 vez por pedido para o founder conferir no Omie (não é falha da rodada).
    const avisados: unknown[] = [];
    if (modo === "importar") {
      for (const p of classificados.filter((x) => x.classe === "atendido_conferir")) {
        const { notificado } = await registrarFalha(db, p.protocolo,
          `Pedido ${p.protocolo} está "${p.situacao}" no portal (emissão ${p.emissao ?? "?"}) e não tem pedido de compra no Omie. ` +
            `O cron não importa pedido já faturado: confira no Omie se a NF já foi lançada e, se não, use "Importar do portal".`);
        avisados.push({ protocolo: p.protocolo, notificado });
      }
    }
    resumoFinal = { ...resumoFinal, carencia_presa: carenciaPresa, avisados };

    // 7. Reconciliação do "PO a reconciliar" (v1.3): cancelado no portal + PO fora do Omie ⇒ encerra pela porta auditada.
    resumoFinal = { ...resumoFinal, reconciliacao: await reconciliar(hoje, emissaoDesde, lista, semTempo) };

    // 8. Cobertura (v1.9, 5.4): situação relida dos pedidos com compra em aberto além da janela de 7 dias.
    if (modo === "importar") resumoFinal = { ...resumoFinal, cobertura: await cobrir(hoje, semTempo) };

    // Rodada com qualquer coisa não resolvida NÃO é sucesso no registro: o ✓ do UltimaExecucao esconderia o pedido.
    const problemas: string[] = [];
    if (!prova.ok) problemas.push(`leitura incompleta (${prova.motivo}): ${prova.detalhe}`);
    if (falhas.length > 0) problemas.push(`${falhas.length} pedido(s) do portal não entraram no Omie: ${falhas.map((f) => (f as { protocolo: string }).protocolo).join(", ")}`);
    const redisparosFalhos = redisparos.filter((r) => r.acao === "falhou");
    if (redisparosFalhos.length > 0) problemas.push(`${redisparosFalhos.length} re-disparo(s) sem PO confirmado: ${redisparosFalhos.map((r) => r.protocolo).join(", ")}`);
    const reconsultasFalhas = reconsultas.filter((r) => r.acao === "falhou");
    if (reconsultasFalhas.length > 0) problemas.push(`${reconsultasFalhas.length} reconsulta(s) além da janela falharam: ${reconsultasFalhas.map((r) => r.protocolo).join(", ")}`);
    if (falhasSituacao.length > 0) problemas.push(`situação do portal não gravada no pedido: ${falhasSituacao.join(" · ")}`);
    // B6: "não sei" não é sucesso — a rodada fica vermelha até a conferência (a pendência durável já está aberta).
    const naoSei = [
      ...indeterminados.map((i) => (i as { protocolo: string }).protocolo),
      ...redisparos.filter((r) => r.acao === "indeterminado").map((r) => r.protocolo),
      ...reconsultas.filter((r) => r.acao === "indeterminado").map((r) => r.protocolo),
    ];
    if (naoSei.length > 0) problemas.push(`${naoSei.length} importação(ões) sem resposta — não sei se entraram (a próxima rodada confere): ${naoSei.join(", ")}`);
    // Releitura só-situação que não gravou (timeout, HTTP de erro, ilegível): o 6 pode seguir sem bloqueio (Codex rodada 2).
    const naoRelidas = reconsultas.filter((r) => "situacao_relida" in r && r.situacao_relida !== "aceita" && r.situacao_relida !== "nao_aceita");
    if (naoRelidas.length > 0) problemas.push(`${naoRelidas.length} releitura(s) da situação além da janela não gravaram: ${naoRelidas.map((r) => `${r.protocolo} (${String(r.situacao_relida)})`).join(", ")}`);
    const naoRegistrados = [...indeterminados, ...redisparos].filter((x) => (x as { registrado?: boolean }).registrado === false);
    if (naoRegistrados.length > 0) problemas.push(`${naoRegistrados.length} indeterminado(s) sem pendência gravada no banco`);
    if (falhasReconciliacao.length > 0) {
      problemas.push(`Reconciliação: ${falhasReconciliacao.length} pedido(s) cancelado(s) no portal não encerraram: ` +
        falhasReconciliacao.map((f) => `#${f.pedido_id} (${f.mensagem})`).join("; "));
    }
    if (falhasCobertura.length > 0) problemas.push(`cobertura da situação dos pedidos com compra em aberto: ${falhasCobertura.join(" · ")}`);
    if (problemas.length > 0) throw new Error(problemas.join(" · "));
    return resumoFinal;
  }

  // ── Cobertura (v1.9, item 5.4) ───────────────────────────────────────────────────────────────────────────────────
  // Lê de `sayerlack_cobertura_situacao_portal()` (a MESMA fonte que o vigia do data_health cobra) quem não tem leitura
  // do seu protocolo desde o início do dia e relê a lista do portal desde a emissão mais antiga. Toda falha é da RODADA
  // (vermelha): leitura sem prova, sem tempo, protocolo que não apareceu ou não gravou — e o vigia fica stale.
  async function cobrir(hoje: string, semTempo: () => boolean): Promise<Record<string, unknown>> {
    const inicioDoDia = `${hoje}T00:00:00-03:00`;
    const ler = async (): Promise<PedidoACobrir[]> => {
      const { data, error } = await db.rpc("sayerlack_cobertura_situacao_portal");
      if (error) throw new Error(`cobertura: ${error.message}`);
      return (Array.isArray(data) ? data : []) as PedidoACobrir[];
    };
    let linhas: PedidoACobrir[];
    try {
      linhas = await ler();
    } catch (e) {
      falhasCobertura.push(mensagemDeErro(e) ?? "leitura da cobertura falhou");
      return { erro: "leitura da cobertura falhou" };
    }
    const alvo = coberturaPendente(linhas, inicioDoDia, hoje);
    const resumo: Record<string, unknown> = {
      pedidos: linhas.length, pendentes: alvo.pendentes.map((p) => p.protocolo),
      fora_do_alcance: alvo.foraDoAlcance.map((p) => p.protocolo),
    };
    if (alvo.foraDoAlcance.length > 0) falhasCobertura.push(`fora do alcance da leitura (> 90 dias): ${alvo.foraDoAlcance.map((p) => p.protocolo).join(", ")}`);
    if (alvo.pendentes.length === 0 || !alvo.emissaoDesde) return resumo;
    if (semTempo()) { falhasCobertura.push("adiada: sem tempo na rodada"); return { ...resumo, adiado: "sem tempo" }; }
    const lidoDe = new Date().toISOString();
    const env = await lerPortalContado(alvo.emissaoDesde)
      .catch((e): BrowserlessData => ({ success: false, erroTipo: "REDE", erro: mensagemDeErro(e) ?? "erro de rede" }));
    const lidoAte = new Date().toISOString();
    resumo.emissao_leitura = alvo.emissaoDesde;
    if (env.success !== true) {
      falhasCobertura.push(`leitura estendida falhou (${env.erroTipo ?? "?"})`);
      return { ...resumo, leitura_falhou: `${env.erroTipo ?? "?"}: ${env.erro ?? "sem detalhe"}` };
    }
    const lida = lerListaConsulta(env.linhas ?? []);
    const prova = provarLeitura({
      headers: env.headers ?? [], linhasLidas: (env.linhas ?? []).length, respostaTotal: env.resposta_total, dtTotal: env.dt_total, info: env.info,
      ilegiveis: lida.ilegiveis, repetidos: lida.repetidos,
    });
    const parcial = !prova.ok && (prova.motivo === "linhas_ilegiveis" || prova.motivo === "protocolo_repetido");
    if (!prova.ok && !parcial) {
      falhasCobertura.push(`leitura estendida sem prova (${prova.motivo})`);
      return { ...resumo, leitura_falhou: `sem prova (${prova.motivo}): ${prova.detalhe}` };
    }
    // Com linha ilegível/repetida, só os 6 entram (bloquear é seguro, liberar não) — e a rodada fica vermelha.
    if (parcial) falhasCobertura.push(`leitura estendida incompleta (${prova.motivo})`);
    const noAppCob = await pedidosNoApp(db, lida.pedidos.map((p) => p.protocolo));
    resumo.situacoes = await gravarSituacoes(observacoesDaLista(lida.pedidos, new Set(noAppCob.keys()), { soCancelados: !prova.ok }), lidoDe, lidoAte);
    // Relê a fonte: quem segue sem leitura de hoje não apareceu na lista ou não gravou (ordem temporal) — vermelho.
    try {
      const ainda = coberturaPendente(await ler(), inicioDoDia, hoje).pendentes.map((p) => p.protocolo);
      resumo.sem_leitura_depois = ainda;
      if (ainda.length > 0 && !parcial) falhasCobertura.push(`sem leitura depois da leitura estendida: ${ainda.join(", ")}`);
    } catch (e) {
      falhasCobertura.push(mensagemDeErro(e) ?? "releitura da cobertura falhou");
    }
    return resumo;
  }

  // ── Reconciliação (v1.3) ─────────────────────────────────────────────────────────────────────────────────────────
  // Roda DEPOIS das importações e com leitura PRÓPRIA quando precisa de emissão além dos 7 dias (Codex P2). Falha da
  // leitura estendida só RELATA (o pedido segue no card); encerramento que falhou é falha ALTA.
  async function reconciliar(
    hoje: string, emissaoDesde: string, lista: { pedidos: ReturnType<typeof lerListaConsulta>["pedidos"]; repetidos: string[] },
    semTempo: () => boolean,
  ): Promise<Record<string, unknown>> {
    const aRec = await carregarAReconciliar(db);
    if (aRec.lista.length === 0 || !aRec.marcador) return { a_reconciliar: aRec.lista.length };
    const resumoRec: Record<string, unknown> = { a_reconciliar: aRec.lista.length, marcador_finalizado_em: aRec.marcador.finalizado_em };
    if (!marcadorFresco(aRec.marcador, Date.now())) {
      return { ...resumoRec, adiado: "detector de PO desatualizado (último run válido há mais de 26 h): ausência velha não encerra" };
    }
    const janela = janelaDeLeitura(hoje, aRec.lista);
    resumoRec.fora_do_alcance = janela.foraDoAlcance.map((p) => ({ pedido_id: p.pedido_id, protocolo: p.protocolo, data_ciclo: p.data_ciclo }));
    if (janela.alcancaveis.length === 0) return resumoRec;
    let listaRec = lista;
    if (janela.emissaoDesde < emissaoDesde) {
      if (semTempo()) return { ...resumoRec, adiado: "sem tempo na rodada para a leitura estendida" };
      const lidoDeRec = new Date().toISOString();
      const env = await lerPortalContado(janela.emissaoDesde)
        .catch((e): BrowserlessData => ({ success: false, erroTipo: "REDE", erro: mensagemDeErro(e) ?? "erro de rede" }));
      const lidoAteRec = new Date().toISOString();
      console.log(`[varrer-portal] leitura estendida desde ${janela.emissaoDesde}: tipo=${env.erroTipo ?? "-"} linhas=${env.linhas?.length ?? "-"}`);
      // Lista incompleta NUNCA decide: success=false cobre paginação incompleta e página ilegível; e a prova da Onda 3
      // vale aqui também — total anunciado = linhas lidas, sem ilegível nem repetido.
      if (env.success !== true) return { ...resumoRec, leitura_falhou: `${env.erroTipo ?? "?"}: ${env.erro ?? "sem detalhe"}` };
      const lida = lerListaConsulta(env.linhas ?? []);
      const provaRec = provarLeitura({
        headers: env.headers ?? [], linhasLidas: (env.linhas ?? []).length, respostaTotal: env.resposta_total, dtTotal: env.dt_total, info: env.info,
        ilegiveis: lida.ilegiveis, repetidos: lida.repetidos,
      });
      // Onda 5A: a situação vai ao pedido ANTES de decidir a reconciliação. Leitura provada grava tudo; com linha
      // ilegível/repetida (o resto é legível), só os 6 — bloquear é seguro, liberar não (Codex 5A rodadas 8-9).
      const parcial = !provaRec.ok && (provaRec.motivo === "linhas_ilegiveis" || provaRec.motivo === "protocolo_repetido");
      if (modo === "importar" && (provaRec.ok || parcial)) {
        const noAppRec = await pedidosNoApp(db, lida.pedidos.map((p) => p.protocolo));
        resumoRec.situacoes = await gravarSituacoes(
          observacoesDaLista(lida.pedidos, new Set(noAppRec.keys()), { soCancelados: !provaRec.ok }), lidoDeRec, lidoAteRec);
      }
      if (!provaRec.ok) return { ...resumoRec, leitura_falhou: `sem prova (${provaRec.motivo}): ${provaRec.detalhe}` };
      listaRec = lida;
      resumoRec.emissao_leitura = janela.emissaoDesde;
    }
    const desfechos = desfechoNoPortal(janela.alcancaveis, listaRec);
    const encerrados: unknown[] = [];
    // No resumo ANTES do laço: se a releitura do 2º lançar, o 1º encerramento não some do registro (Codex P2).
    resumoFinal = { ...resumoFinal, reconciliacao: { ...resumoRec, encerrados, falhas: falhasReconciliacao } };
    if (modo === "importar") {
      for (const d of desfechos) {
        if (d.classe !== "cancelado_no_portal") continue;
        // Relê o pedido (status + PO ainda fora + marcador fresco): a prova do começo da rodada não basta.
        const agora = await carregarAReconciliar(db, d.pedido_id);
        const ainda = agora.lista.find((p) => p.pedido_id === d.pedido_id && p.protocolo === d.protocolo && p.omie_po_id === d.omie_po_id);
        if (!ainda || !agora.marcador || !marcadorFresco(agora.marcador, Date.now())) continue; // a próxima rodada decide
        const r = await encerrarCanceladoNoPortal(db, ainda, d.situacao, agora.marcador);
        console.log(`[varrer-portal] reconciliação #${d.pedido_id} (${d.protocolo}): ${r.mensagem}`);
        if (r.ok) encerrados.push({ pedido_id: d.pedido_id, protocolo: d.protocolo, situacao: d.situacao });
        else falhasReconciliacao.push({ pedido_id: d.pedido_id, protocolo: d.protocolo, mensagem: r.mensagem });
      }
    }
    return {
      ...resumoRec,
      desfechos: desfechos.map((d) => ({ pedido_id: d.pedido_id, protocolo: d.protocolo, classe: d.classe, situacao: "situacao" in d ? d.situacao : null })),
      encerrados,
      falhas: falhasReconciliacao,
    };
  }
});
