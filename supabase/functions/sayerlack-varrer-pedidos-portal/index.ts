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
//
// ⚠️ LEITURA PURA NO PORTAL: o script do navegador só usa menu, filtros, "Filtrar" e a paginação da tabela; recusa todo
// diálogo nativo (dismiss — nunca confirma). Nada aqui grava no portal.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarPosLogin } from "../_shared/sayerlack-pos-login.ts";
import { ABRIR_CONSULTA_PEDIDOS } from "../_shared/sayerlack-portal-navegador.ts";
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
    const situacoes = await page.evaluate(() => Array.from(document.querySelectorAll('#situacao option'))
      .map((o) => ({ valor: String(o.value), texto: (o.textContent || '').trim() })));

    // Filtros: cliente OBEN, só PEDIDO (não proposta), qualquer situação (o cancelado é LIDO e descartado em Deno),
    // nº do pedido em branco, emissão desde o início da janela, entrega desde 2020 (o default é só o último mês).
    const filtro = await page.evaluate((cod, desde) => {
      const jq = window.jQuery;
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (jq) { jq(el).val(v).trigger('change'); } else { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      };
      const r = {
        cliente: set('#cliente', String(cod)), situacao: set('#situacao', 'todos'), exibir: set('#exibir', '1'),
        ini: set('#num_ped_ini', ''), fim: set('#num_ped_fim', ''),
        emissao: set('#data_emissao_ini', desde), entrega: set('#data_entrega_ini', '2020-01-01'),
      };
      const val = (sel) => { const el = document.querySelector(sel); return el ? String(el.value) : null; };
      return { set: r, cliente: val('#cliente'), exibir: val('#exibir'), situacao: val('#situacao'),
               emissao: val('#data_emissao_ini'), emissaoFim: val('#data_emissao_fim'), ini: val('#num_ped_ini') };
    }, clienteCodigo, emissaoDesde);
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
    let resp = await esperarConsulta('filtrar-1', clicarFiltrar);
    if (!resp.ok) resp = await esperarConsulta('filtrar-2', clicarFiltrar);
    trace.push({ step: 'consulta_resposta', resp, t: Date.now() - t0 });
    if (!resp.ok) return await falha('CONSULTA_SEM_RESPOSTA', 'O portal não respondeu à consulta (2 tentativas)');

    const lerPagina = () => page.evaluate(() => {
      const nomeTh = (th) => {
        const inp = th.querySelector('input');
        return ((th.innerText || '').trim() || (inp && inp.placeholder ? inp.placeholder.trim() : '') || (th.getAttribute('aria-label') || '').split(':')[0].trim());
      };
      const t = Array.from(document.querySelectorAll('table')).find((tb) => Array.from(tb.querySelectorAll('thead th')).some((th) => nomeTh(th).toLowerCase().indexOf('situa') !== -1));
      if (!t) return { ok: false, headers: [], linhas: [], processando: false, info: null, temProxima: false };
      let headers = [];
      Array.from(t.querySelectorAll('thead tr')).forEach((tr) => {
        const hs = Array.from(tr.children).map(nomeTh);
        if (hs.filter(Boolean).length > headers.filter(Boolean).length) headers = hs;
      });
      const linhas = Array.from(t.querySelectorAll('tbody tr'))
        .filter((tr) => !tr.querySelector('td.dataTables_empty'))
        .map((tr) => {
          const tds = Array.from(tr.children);
          const o = {};
          headers.forEach((h, i) => { if (h && tds[i]) o[h] = (tds[i].innerText || '').split(String.fromCharCode(10)).join(' ').trim(); });
          return o;
        });
      const proc = document.querySelector('.dataTables_processing');
      const processando = !!proc && window.getComputedStyle(proc).display !== 'none';
      // '.dataTables_info' nunca casou em 46 rodadas: o portal pode nomear o elemento pelo id da tabela ('<id>_info').
      const infoEl = document.querySelector('.dataTables_info') || document.querySelector('[id$="_info"]') || document.querySelector('.dt-info');
      const prox = document.querySelector('.paginate_button.next');
      const temProxima = !!prox && !prox.classList.contains('disabled') && !(prox.parentElement && prox.parentElement.classList.contains('disabled'));
      // Total pela API da instância DataTables DESTA tabela (page.info().recordsDisplay), sem depender do elemento visual.
      let dtTotal = null;
      try {
        const jq = window.jQuery;
        if (jq && jq.fn && jq.fn.dataTable && jq.fn.dataTable.isDataTable(t)) {
          const pi = jq(t).DataTable().page.info();
          if (pi && typeof pi.recordsDisplay === 'number') dtTotal = pi.recordsDisplay;
        }
      } catch (e) { dtTotal = null; }
      return { ok: true, headers, linhas, processando, info: infoEl ? (infoEl.innerText || '').trim() : null, temProxima, dtTotal };
    });
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

    const linhas = [];
    let pagina = await lerEstavel();
    if (!pagina) return await falha('CONSULTA_ILEGIVEL', 'Tabela da consulta não estabilizou (ausente ou processando)');
    const headers = pagina.headers;
    const infoInicial = pagina.info;
    const dtTotalInicial = pagina.dtTotal;
    linhas.push(...pagina.linhas);
    let paginas = 1;
    while (pagina.temProxima && paginas < 30) {
      const r = await esperarConsulta('pagina-' + (paginas + 1), () => {
        const b = document.querySelector('.paginate_button.next');
        const a = b && (b.tagName === 'A' ? b : (b.querySelector('a') || b));
        if (a) a.click();
      });
      if (!r.ok) return await falha('PAGINACAO_SEM_RESPOSTA', 'O portal não respondeu à página ' + (paginas + 1), { paginas, n_linhas: linhas.length });
      pagina = await lerEstavel();
      if (!pagina) return await falha('PAGINACAO_ILEGIVEL', 'Página ' + (paginas + 1) + ' da consulta não estabilizou', { paginas, n_linhas: linhas.length });
      linhas.push(...pagina.linhas);
      paginas++;
    }
    trace.push({ step: 'consulta_lida', headers, paginas, n_linhas: linhas.length, info: infoInicial, resposta_total: resp.total, resposta_chaves: resp.chaves, dt_total: dtTotalInicial, t: Date.now() - t0 });
    if (pagina.temProxima) return await falha('PAGINACAO_INCOMPLETA', 'Mais de 30 páginas na consulta — lista não lida inteira', { paginas });

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

interface PedidoNoApp { id: number; status: string | null; temPo: boolean }

/** Status em que o PO ainda pode ser (re)disparado pela importadora (mesma régua de STATUS_REDISPARAVEIS lá). */
const STATUS_REDISPARAVEIS = new Set(["aprovado_aguardando_disparo", "falha_envio"]);

/**
 * Pedidos do app por protocolo, COM o estado do PO (revisão Fable+Codex 2026-11, P1): estar no app não é estar
 * resolvido — gravado sem PO (Omie fora no disparo) precisa de re-disparo, não de "resolvido_em".
 */
async function pedidosNoApp(db: Db, protocolos: string[]): Promise<Map<string, PedidoNoApp>> {
  const m = new Map<string, PedidoNoApp>();
  if (protocolos.length === 0) return m;
  const linhas = await fetchAll<{ id: number; portal_protocolo: string | null; status: string | null; omie_pedido_compra_id: string | number | null }>(
    (de, ate) => db.from("pedido_compra_sugerido").select("id, portal_protocolo, status, omie_pedido_compra_id").in("portal_protocolo", protocolos)
      .order("id", { ascending: true }).range(de, ate),
    "varrer-portal:protocolos-no-app",
  );
  for (const r of linhas) {
    const prot = (r.portal_protocolo ?? "").trim();
    if (!prot) continue;
    const po = r.omie_pedido_compra_id == null ? "" : String(r.omie_pedido_compra_id).trim();
    m.set(prot, { id: r.id, status: r.status, temPo: po !== "" && po !== "0" });
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

async function importar(protocolo: string, situacoes: string[]): Promise<{ httpStatus: number; corpo: unknown }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/sayerlack-importar-pedido-portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      // A releitura da importadora tem de achar a MESMA situação que a varredura classificou (Codex P1, 2026-10-16/17):
      // um pedido que passou de Aberto para Atendido no meio da rodada escaparia da trava de NF.
      body: JSON.stringify({ protocolo, situacoes_permitidas: situacoes }),
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
async function abrirExecucao(db: Db, auth: { via: string; userId?: string }): Promise<string | null> {
  try {
    const manual = auth.via === "staff";
    const { data, error } = await db.from("acoes_execucoes")
      .insert({ acao: ACAO_REGISTRO, origem: manual ? "manual" : "automatica", executado_por: manual ? (auth.userId ?? null) : null })
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
  const registro = await abrirExecucao(db, auth);
  const falhasReconciliacao: { pedido_id: number; protocolo: string; mensagem: string }[] = [];

  try {
    const resumo = await rodada();
    await fecharExecucao(db, registro, "sucesso", resumo);
    return json({ ok: true, ...resumo });
  } catch (e) {
    const mensagem = mensagemDeErro(e) ?? "erro inesperado";
    await fecharExecucao(db, registro, "erro", { ...resumoFinal, erro: mensagem.slice(0, 600) });
    return json({ ok: false, mensagem, ...resumoFinal }, 500);
  }

  async function rodada(): Promise<Record<string, unknown>> {
    // 0a. Portal fora do ar: não abre o navegador.
    if (portalSayerlackFechado(new Date())) {
      return { modo, versao: VERSAO, pulado: "portal_fechado", mensagem: "Portal Sayerlack fora do ar (sábado 12h → segunda 6h): rodada pulada." };
    }
    // 0b. Pedido do app em voo/conciliação: pode ser ele o "pedido novo" do portal — a rodada não varre.
    const bloqueio = motivoBloqueio(await pedidosEmVoo(db));
    if (bloqueio) return { modo, versao: VERSAO, pulado: "bloqueado", mensagem: `Rodada não importa: ${bloqueio}.` };

    const faltando = [
      ["SAYERLACK_PORTAL_USER", SAYERLACK_PORTAL_USER], ["SAYERLACK_PORTAL_PASS", SAYERLACK_PORTAL_PASS],
      ["SAYERLACK_PORTAL_URL", SAYERLACK_PORTAL_URL], ["SAYERLACK_PORTAL_CLIENTE_CODIGO", SAYERLACK_PORTAL_CLIENTE_CODIGO],
      ["BROWSERLESS_TOKEN", BROWSERLESS_TOKEN],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (faltando.length > 0) throw new Error(`Configuração ausente: ${faltando.join(", ")}`);

    // 1. Lê a lista no portal.
    const hoje = hojeSP();
    const emissaoDesde = inicioDaJanela(hoje);
    const envelope = await lerPortal(emissaoDesde);
    console.log(`[varrer-portal] Browserless ${Date.now() - t0}ms tipo=${envelope.erroTipo ?? "-"} linhas=${envelope.linhas?.length ?? "-"}`);
    if (envelope.success !== true) {
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
      cabecalhos: envelope.headers ?? [], prova_leitura: prova.ok ? "ok" : prova.motivo,
    };
    // Ilegível/repetido: a rodada segue para o resto (os legíveis são legíveis), mas termina VERMELHA no fim (3.4).
    // O resto das falhas de prova não deixa decidir nada: erro já.
    if (!prova.ok && prova.motivo !== "linhas_ilegiveis" && prova.motivo !== "protocolo_repetido") {
      throw new Error(`Leitura do portal sem prova (${prova.motivo}): ${prova.detalhe}`);
    }

    // 2. Classifica.
    const protocolos = lista.pedidos.map((p) => p.protocolo);
    const [noApp, noOmie, vistos, syncEm] = await Promise.all([
      pedidosNoApp(db, protocolos), contratosNoOmie(db, protocolos), vistosAntes(db, protocolos), syncPedidosCompletoEm(db),
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
        const r = await importar(c.protocolo, [c.situacao_codigo as string])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        console.log(`[varrer-portal] ${c.protocolo}: importar HTTP ${r.httpStatus} ok=${res.ok}`);
        // Sem corpo da importadora (prazo do gateway, rede): o PO pode ter saído depois. INDETERMINADO, sem e-mail.
        const semCorpo = r.httpStatus === 0 || !(r.corpo && typeof r.corpo === "object");
        if (res.ok) {
          importados.push({ protocolo: c.protocolo, mensagem: res.mensagem });
          await marcarResolvidos(db, [c.protocolo]);
        } else if (semCorpo) {
          indeterminados.push({ protocolo: c.protocolo, http: r.httpStatus });
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
        if ((await contratosNoOmie(db, [p.protocolo])).size > 0) {
          const { notificado } = await registrarFalha(db, p.protocolo,
            `Pedido ${p.protocolo}: o #${ped.id} do app está sem pedido de compra, mas já existe PO no Omie com este contrato ` +
              `(lançado à mão?). O cron não re-dispara para não duplicar — não lance outro PO.`);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "po_ja_no_omie", notificado });
          continue;
        }
        const r = await importar(p.protocolo, [p.situacao_codigo])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        const semCorpo = r.httpStatus === 0 || !(r.corpo && typeof r.corpo === "object");
        if (res.ok) {
          await marcarResolvidos(db, [p.protocolo]);
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "po_criado" });
        } else if (semCorpo) {
          redisparos.push({ protocolo: p.protocolo, pedido_id: ped.id, acao: "indeterminado", http: r.httpStatus });
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
          // Pedido no app sem PO e PO manual no Omie: pendência de vinculação (item 7.1), não re-disparo.
          reconsultas.push({ ...q, acao: "po_manual_no_omie" }); continue;
        }
        const r = await importar(q.protocolo, [...SITUACOES_IMPORTAVEIS])
          .catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        const c = (r.corpo && typeof r.corpo === "object" ? r.corpo : {}) as { motivo?: unknown; pedido_id?: unknown };
        if (res.ok) {
          await marcarResolvidos(db, [q.protocolo]);
          reconsultas.push({ ...q, acao: "po_confirmado" });
        } else if (r.httpStatus === 0 || !(r.corpo && typeof r.corpo === "object")) {
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

    // Rodada com qualquer coisa não resolvida NÃO é sucesso no registro: o ✓ do UltimaExecucao esconderia o pedido.
    const problemas: string[] = [];
    if (!prova.ok) problemas.push(`leitura incompleta (${prova.motivo}): ${prova.detalhe}`);
    if (falhas.length > 0) problemas.push(`${falhas.length} pedido(s) do portal não entraram no Omie: ${falhas.map((f) => (f as { protocolo: string }).protocolo).join(", ")}`);
    const redisparosFalhos = redisparos.filter((r) => r.acao === "falhou");
    if (redisparosFalhos.length > 0) problemas.push(`${redisparosFalhos.length} re-disparo(s) sem PO confirmado: ${redisparosFalhos.map((r) => r.protocolo).join(", ")}`);
    const reconsultasFalhas = reconsultas.filter((r) => r.acao === "falhou");
    if (reconsultasFalhas.length > 0) problemas.push(`${reconsultasFalhas.length} reconsulta(s) além da janela falharam: ${reconsultasFalhas.map((r) => r.protocolo).join(", ")}`);
    if (falhasReconciliacao.length > 0) {
      problemas.push(`Reconciliação: ${falhasReconciliacao.length} pedido(s) cancelado(s) no portal não encerraram: ` +
        falhasReconciliacao.map((f) => `#${f.pedido_id} (${f.mensagem})`).join("; "));
    }
    if (problemas.length > 0) throw new Error(problemas.join(" · "));
    return resumoFinal;
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
      const env = await lerPortal(janela.emissaoDesde)
        .catch((e): BrowserlessData => ({ success: false, erroTipo: "REDE", erro: mensagemDeErro(e) ?? "erro de rede" }));
      console.log(`[varrer-portal] leitura estendida desde ${janela.emissaoDesde}: tipo=${env.erroTipo ?? "-"} linhas=${env.linhas?.length ?? "-"}`);
      // Lista incompleta NUNCA decide: success=false cobre paginação incompleta e página ilegível; e a prova da Onda 3
      // vale aqui também — total anunciado = linhas lidas, sem ilegível nem repetido.
      if (env.success !== true) return { ...resumoRec, leitura_falhou: `${env.erroTipo ?? "?"}: ${env.erro ?? "sem detalhe"}` };
      const lida = lerListaConsulta(env.linhas ?? []);
      const provaRec = provarLeitura({
        headers: env.headers ?? [], linhasLidas: (env.linhas ?? []).length, respostaTotal: env.resposta_total, dtTotal: env.dt_total, info: env.info,
        ilegiveis: lida.ilegiveis, repetidos: lida.repetidos,
      });
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
