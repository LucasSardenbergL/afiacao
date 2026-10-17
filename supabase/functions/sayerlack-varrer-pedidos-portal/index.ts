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
//
// ⚠️ LEITURA PURA NO PORTAL: o script do navegador só usa menu, filtros, "Filtrar" e a paginação da tabela; recusa todo
// diálogo nativo (dismiss — nunca confirma). Nada aqui grava no portal.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarPosLogin } from "../_shared/sayerlack-pos-login.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { hojeSP } from "../_shared/hoje-sp.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
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
    trace.push({ step: 'login_start', t: Date.now() - t0 });
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: budgetFor('login-goto', 30000) });
    await page.waitForSelector('#user', { timeout: budgetFor('login-form', 10000) });
    await fillInput('#user', user);
    await fillInput('#password', pass);
    const navPromise = page.waitForNavigation({ timeout: budgetFor('login-nav', 15000) }).catch(() => null);
    const clicouEntrar = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim().includes('Entrar'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicouEntrar) return await falha('LOGIN_FAILED', 'Botão Entrar não encontrado na tela de login');
    await navPromise;
    await sleep(1500);

    await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.classList.contains('app-sidebar-minified')) {
        const b = document.querySelector('.app-sidebar-minify-btn');
        if (b) b.click();
      }
    });
    await page.waitForFunction(
      () => document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link').length > 0,
      { timeout: budgetFor('pos-login-dashboard', 15000), polling: 250 }
    ).catch(() => null);
    const sinais = await page.evaluate(function() {
      const menu = document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link');
      const senhas = Array.from(document.querySelectorAll('input[type=password]')).filter(function(el) { return el.offsetParent !== null; });
      return { url: window.location.href, menuLinks: menu.length, camposSenha: senhas.length, titulo: document.title || '',
               texto: (document.body ? (document.body.innerText || '') : '').substring(0, 3000) };
    });
    sinais.origemEsperada = portalUrl || null;
    const posLogin = classificarPosLogin(sinais);
    trace.push({ step: 'pos_login_check', tipo: posLogin.tipo, url: sinais.url, menuLinks: sinais.menuLinks, t: Date.now() - t0 });
    if (posLogin.tipo !== 'dashboard') {
      return await falha('POS_LOGIN_NAO_DASHBOARD', 'Login não chegou à área logada do portal (' + posLogin.tipo + ')');
    }

    // === Consulta Pedidos ===
    const navConsulta = page.waitForNavigation({ timeout: budgetFor('nav-consulta', 20000) }).catch(() => null);
    const clicouMenu = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((x) => (x.getAttribute('href') || '').endsWith('/order-viewer'));
      if (a) { a.click(); return true; }
      return false;
    });
    if (clicouMenu) await navConsulta;
    if (page.url().indexOf('/order-viewer') === -1) {
      await page.goto(portalUrl + '/order-viewer', { waitUntil: 'domcontentloaded', timeout: budgetFor('goto-consulta', 30000) });
    }
    const temForm = await page.waitForSelector('#getFilterData', { timeout: budgetFor('form-consulta', 15000) }).then(() => true).catch(() => false);
    if (!temForm) return await falha('CONSULTA_INDISPONIVEL', 'Tela Consulta Pedidos sem o botão Filtrar');
    const pronta = await page.waitForFunction(
      () => !!window.jQuery && !!document.querySelector('table.dataTable'),
      { timeout: budgetFor('consulta-pronta', 20000), polling: 250 },
    ).then(() => true).catch(() => false);
    trace.push({ step: 'consulta_pronta', pronta, t: Date.now() - t0 });
    if (!pronta) return await falha('CONSULTA_INDISPONIVEL', 'Tabela da Consulta Pedidos não inicializou (jQuery/DataTables)');

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
      ).then((r) => ({ ok: r.status() < 400, status: r.status() })).catch((e) => ({ ok: false, erro: String((e && e.message) || e).substring(0, 120) }));
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
      const infoEl = document.querySelector('.dataTables_info');
      const prox = document.querySelector('.paginate_button.next');
      const temProxima = !!prox && !prox.classList.contains('disabled') && !(prox.parentElement && prox.parentElement.classList.contains('disabled'));
      return { ok: true, headers, linhas, processando, info: infoEl ? (infoEl.innerText || '').trim() : null, temProxima };
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
    trace.push({ step: 'consulta_lida', headers, paginas, n_linhas: linhas.length, info: infoInicial, t: Date.now() - t0 });
    if (pagina.temProxima) return await falha('PAGINACAO_INCOMPLETA', 'Mais de 30 páginas na consulta — lista não lida inteira', { paginas });

    return {
      data: { success: true, headers, linhas, info: infoInicial, paginas, situacoes, filtro, trace },
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

async function protocolosNoApp(db: Db, protocolos: string[]): Promise<Set<string>> {
  if (protocolos.length === 0) return new Set();
  const linhas = await fetchAll<{ portal_protocolo: string | null }>(
    (de, ate) => db.from("pedido_compra_sugerido").select("id, portal_protocolo").in("portal_protocolo", protocolos)
      .order("id", { ascending: true }).range(de, ate),
    "varrer-portal:protocolos-no-app",
  );
  return new Set(linhas.map((r) => (r.portal_protocolo ?? "").trim()).filter(Boolean));
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

async function importar(protocolo: string, situacaoCodigo: string): Promise<{ httpStatus: number; corpo: unknown }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/sayerlack-importar-pedido-portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      // A releitura da importadora tem de achar a MESMA situação que a varredura classificou (Codex P1, 2026-10-16/17):
      // um pedido que passou de Aberto para Atendido no meio da rodada escaparia da trava de NF.
      body: JSON.stringify({ protocolo, situacoes_permitidas: [situacaoCodigo] }),
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
  let resumoFinal: Record<string, unknown> | null = null;

  try {
    const resumo = await comRegistro(db as unknown as DbRegistro, ACAO_REGISTRO, auth, async (): Promise<Record<string, unknown>> => {
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
      const emissaoDesde = inicioDaJanela(hojeSP());
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
      console.log(`[varrer-portal] Browserless ${Date.now() - t0}ms tipo=${envelope.erroTipo ?? "-"} linhas=${envelope.linhas?.length ?? "-"}`);
      if (envelope.success !== true) {
        throw new Error(`Leitura do portal falhou (${envelope.erroTipo ?? "?"}): ${envelope.erro ?? "sem detalhe"}`);
      }

      // 2. Classifica.
      const lista = lerListaConsulta(envelope.linhas ?? []);
      const protocolos = lista.pedidos.map((p) => p.protocolo);
      const [noApp, noOmie, vistos, syncEm] = await Promise.all([
        protocolosNoApp(db, protocolos), contratosNoOmie(db, protocolos), vistosAntes(db, protocolos), syncPedidosCompletoEm(db),
      ]);
      const preCarencia = classificar(lista.pedidos, {
        protocolosNoApp: noApp, contratosNoOmie: noOmie, situacoesImportaveis: SITUACOES_IMPORTAVEIS, emissaoDesde,
      });
      // A 1ª vista só conta em rodada de IMPORTAR: "listar" não tem efeito sobre compras futuras (Codex P2).
      if (modo === "importar") {
        await registrarVistos(db, preCarencia.filter((p) => p.classe === "candidato" && !vistos.has(p.protocolo)).map((p) => p.protocolo));
      }
      const classificados = aplicarCarencia(preCarencia, vistos, syncEm);
      const candidatos = classificados.filter((p) => p.classe === "candidato");
      const contagem: Record<string, number> = {};
      for (const p of classificados) contagem[p.classe] = (contagem[p.classe] ?? 0) + 1;
      const base = {
        modo, versao: VERSAO, emissao_desde: emissaoDesde, paginas: envelope.paginas ?? null, info_portal: envelope.info ?? null,
        lidos: lista.pedidos.length, ilegiveis: lista.ilegiveis, repetidos: lista.repetidos, contagem,
        situacoes_portal: envelope.situacoes ?? [],
        // Só o que NÃO está no app nem no Omie — é o que o founder precisa olhar.
        fora_do_app: classificados.filter((p) => p.classe !== "ja_no_app" && p.classe !== "ja_no_omie")
          .map((p) => ({ protocolo: p.protocolo, situacao: p.situacao, emissao: p.emissao, classe: p.classe })),
      };
      // Falha aberta de protocolo que JÁ entrou no app (por timeout indeterminado, botão ou rodada anterior) se resolve.
      await marcarResolvidos(db, classificados.filter((p) => p.classe === "ja_no_app" || p.classe === "ja_no_omie").map((p) => p.protocolo));
      // Atendido sem PO: e-mail 1 vez por pedido para o founder conferir no Omie (não é falha da rodada).
      const conferir = classificados.filter((p) => p.classe === "atendido_conferir");
      const avisados: unknown[] = [];
      if (modo === "importar") {
        for (const p of conferir) {
          const { notificado } = await registrarFalha(db, p.protocolo,
            `Pedido ${p.protocolo} está "${p.situacao}" no portal (emissão ${p.emissao ?? "?"}) e não tem pedido de compra no Omie. ` +
              `O cron não importa pedido já faturado: confira no Omie se a NF já foi lançada e, se não, use "Importar do portal".`);
          avisados.push({ protocolo: p.protocolo, notificado });
        }
      }
      if (modo === "listar" || candidatos.length === 0) return { ...base, avisados, importados: [], falhas: [], adiados: [] };

      // 3. Importa, um por vez, reconferindo o banco antes de cada um.
      const importados: unknown[] = [];
      const falhas: unknown[] = [];
      const adiados: string[] = [];
      const indeterminados: unknown[] = [];
      for (const c of candidatos) {
        if (Date.now() - t0 + FOLGA_POR_IMPORTACAO_MS > TETO_EDGE_MS) {
          adiados.push(c.protocolo);
          continue;
        }
        const bloq = motivoBloqueio(await pedidosEmVoo(db));
        if (bloq) {
          adiados.push(c.protocolo);
          falhas.push({ protocolo: c.protocolo, mensagem: `adiado: ${bloq}` });
          break;
        }
        if ((await protocolosNoApp(db, [c.protocolo])).size > 0) continue; // entrou no app durante a rodada
        // A prova de "não está no Omie / NF não lançada" é RELIDA agora, não a do começo da rodada (Codex P1).
        const omieAgora = await contratosNoOmie(db, [c.protocolo]);
        const reclasse = classificar([c], {
          protocolosNoApp: new Set(), contratosNoOmie: omieAgora, situacoesImportaveis: SITUACOES_IMPORTAVEIS, emissaoDesde,
        })[0].classe;
        if (reclasse !== "candidato") {
          adiados.push(c.protocolo);
          continue;
        }
        const r = await importar(c.protocolo, c.situacao_codigo as string).catch((e) => ({ httpStatus: 0, corpo: { ok: false, mensagem: mensagemDeErro(e) ?? "erro de rede" } }));
        const res = resumoImportacao(r.httpStatus, r.corpo);
        console.log(`[varrer-portal] ${c.protocolo}: importar HTTP ${r.httpStatus} ok=${res.ok}`);
        // Sem corpo da importadora (timeout de 150 s do gateway, rede): o PO pode ter saído depois. É INDETERMINADO —
        // nada de e-mail "não entrou"; a próxima rodada vê o protocolo no app (e resolve) ou tenta de novo (idempotente).
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
      resumoFinal = { ...base, avisados, importados, falhas, adiados, indeterminados };
      // Rodada com falha NÃO é sucesso no registro (Codex P2): o ✓ do UltimaExecucao esconderia o pedido que não entrou.
      if (falhas.length > 0) {
        throw new Error(`${falhas.length} pedido(s) do portal não entraram no Omie: ${falhas.map((f) => (f as { protocolo: string }).protocolo).join(", ")}`);
      }
      return resumoFinal;
    }, (r) => r);
    return json({ ok: true, ...resumo });
  } catch (e) {
    return json({ ok: false, modo, versao: VERSAO, mensagem: mensagemDeErro(e) ?? "erro inesperado", ...(resumoFinal ?? {}) }, 500);
  }
});
