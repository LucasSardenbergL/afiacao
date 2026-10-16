// Edge Function: sayerlack-importar-pedido-portal  [money-path]
//
// O founder às vezes digita o pedido DIRETO no portal Sayerlack. Aqui ele informa só o NÚMERO do pedido; a edge:
//   1. abre o portal (Browserless), Consulta Pedidos → cliente OBEN → nº início = fim = protocolo → Filtrar, lê a linha
//      (situação, data de entrega, Vlr Mercadoria, Vlr Total) e os itens (GET /order-creation/busca-itens-pedido/<nº>);
//   2. prova a leitura em Deno (./leitura.ts — semântica posicional conferida a cada pedido, Σ linhas = Vlr Mercadoria);
//   3. grava pedido + itens pela RPC `sayerlack_importar_pedido_portal` (de-para inverso, qtde inteira no Omie, custo pela
//      MESMA prova do fluxo normal: IPI por NCM × Vlr Total) — tudo-ou-nada, idempotente por protocolo;
//   4. cria o PO no Omie pelo caminho de sempre (`disparar-pedidos-aprovados`: protocolo em mãos ⇒ already_sent, o portal
//      não é tocado de novo) e relê o pedido para responder com o que o BANCO diz.
//
// ⚠️ LEITURA PURA NO PORTAL: o script do navegador não clica em nada que grave (só menu, filtros e "Filtrar"), recusa
// todo diálogo nativo (dismiss — nunca confirma) e, se precisar abrir o pedido, só CARREGA a página de detalhe (GET, o
// que o founder faz à mão), sem tocar em botão. A invariante "zero token de gravação" vale para este arquivo.

import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarPosLogin } from "../_shared/sayerlack-pos-login.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { lerPedidoPortal, mensagemErroImportacao, type LinhaConsultaRaw } from "./leitura.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const SAYERLACK_PORTAL_CLIENTE_CODIGO = Deno.env.get("SAYERLACK_PORTAL_CLIENTE_CODIGO");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");

const PROTOCOLO_RE = /^\d{3,12}$/;
/** Pedido já importado que ainda não virou PO pode ser re-disparado por aqui (retry do Omie). */
const STATUS_REDISPARAVEIS = new Set(["aprovado_aguardando_disparo", "falha_envio"]);

// Função JS que roda no Chrome remoto via Browserless v2 (/function, Puppeteer). Login e pós-login no mesmo
// molde da edge de envio/captura (provados em prod). Dentro deste template: sem crase, sem cifrão-chave, e
// regex com barra invertida dobrada.
const BROWSERLESS_FUNCTION = `
export default async ({ page, context }) => {
  const { user, pass, portalUrl, clienteCodigo, protocolo } = context;
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
    // Leitura pura: diálogo nativo do portal é sempre RECUSADO (nunca confirmamos nada).
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

    // Pós-login: confirmação POSITIVA de dashboard (sidebar expandida ANTES de medir — mesma ordem do envio).
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

    // === Consulta Pedidos: pelo MENU (goto direto pode cair em /login/...) com fallback de goto ===
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
    trace.push({ step: 'consulta_aberta', via_menu: clicouMenu, url: page.url(), t: Date.now() - t0 });
    const temForm = await page.waitForSelector('#getFilterData', { timeout: budgetFor('form-consulta', 15000) }).then(() => true).catch(() => false);
    if (!temForm) return await falha('CONSULTA_INDISPONIVEL', 'Tela Consulta Pedidos sem o botão Filtrar');
    // O botão aparece ANTES de o portal ligar o jQuery e o DataTables: clicar nessa janela não dispara a consulta e a
    // tabela fica vazia (1º uso real, pedido 2141068, 2026-10-16: "0 linha(s) lida(s)" com o pedido existindo).
    // Espera a tabela INICIALIZADA (classe dataTable, posta pelo DataTables) antes de filtrar.
    const pronta = await page.waitForFunction(
      () => !!window.jQuery && !!document.querySelector('table.dataTable'),
      { timeout: budgetFor('consulta-pronta', 20000), polling: 250 },
    ).then(() => true).catch(() => false);
    trace.push({ step: 'consulta_pronta', pronta, t: Date.now() - t0 });
    if (!pronta) return await falha('CONSULTA_INDISPONIVEL', 'Tabela da Consulta Pedidos não inicializou (jQuery/DataTables)');

    // Filtros: cliente OBEN, nº início = fim, só PEDIDO (não proposta), qualquer situação — o cancelado é LIDO e recusado
    // em Deno (./leitura.ts), para a tela dizer "cancelado" em vez de "não encontrado";
    // datas desde 2020 (o default é só o último mês).
    const filtro = await page.evaluate((cod, nr) => {
      const jq = window.jQuery;
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (jq) { jq(el).val(v).trigger('change'); } else { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      };
      const r = {
        cliente: set('#cliente', String(cod)), situacao: set('#situacao', 'todos'), exibir: set('#exibir', '1'),
        ini: set('#num_ped_ini', String(nr)), fim: set('#num_ped_fim', String(nr)),
        emissao: set('#data_emissao_ini', '2020-01-01'), entrega: set('#data_entrega_ini', '2020-01-01'),
      };
      const val = (sel) => { const el = document.querySelector(sel); return el ? String(el.value) : null; };
      return { set: r, cliente: val('#cliente'), exibir: val('#exibir'), ini: val('#num_ped_ini'), fim: val('#num_ped_fim') };
    }, clienteCodigo, protocolo);
    trace.push({ step: 'filtros', filtro, t: Date.now() - t0 });
    if (filtro.cliente !== String(clienteCodigo)) {
      return await falha('CLIENTE_INDISPONIVEL', 'Cliente ' + clienteCodigo + ' não está disponível no filtro da consulta', { filtro });
    }
    // Exibir = '1' (Pedido): proposta NÃO é pedido efetivado e não pode virar PO (Codex 2026-10-14, P1).
    if (filtro.exibir !== '1') {
      return await falha('FILTRO_NAO_APLICADO', 'Filtro Exibir = Pedido não ficou aplicado', { filtro });
    }
    if (filtro.ini !== String(protocolo) || filtro.fim !== String(protocolo)) {
      return await falha('FILTRO_NAO_APLICADO', 'Número do pedido não ficou no filtro', { filtro });
    }
    // Trocar o cliente pode disparar uma consulta própria do portal: deixa ela assentar para a resposta esperada
    // abaixo ser a do NOSSO clique, não a da troca de filtro.
    await sleep(1500);
    // Clica e espera a RESPOSTA da consulta (POST /order-viewer/form/list), com 1 nova tentativa se ela não sair,
    // em vez de desistir às cegas em 8 s de tabela vazia.
    const clicarEsperar = async (rotulo) => {
      const resp = page.waitForResponse(
        (r) => r.url().indexOf('/order-viewer/form/list') !== -1 && r.request().method() === 'POST',
        { timeout: budgetFor('resposta-' + rotulo, 60000) },
      ).then((r) => ({ ok: true, status: r.status() })).catch((e) => ({ ok: false, erro: String((e && e.message) || e).substring(0, 120) }));
      await page.evaluate(() => { const b = document.querySelector('#getFilterData'); if (b) b.click(); });
      return await resp;
    };
    let respConsulta = await clicarEsperar('1');
    trace.push({ step: 'consulta_resposta', tentativa: 1, resp: respConsulta, t: Date.now() - t0 });
    if (!respConsulta.ok) {
      respConsulta = await clicarEsperar('2');
      trace.push({ step: 'consulta_resposta', tentativa: 2, resp: respConsulta, t: Date.now() - t0 });
    }
    if (!respConsulta.ok) {
      return await falha('CONSULTA_SEM_RESPOSTA', 'O portal não respondeu à consulta do pedido (2 tentativas)');
    }

    // Lê a tabela de resultado por NOME de coluna. Os cabeçalhos são campos de filtro: o nome mora no placeholder.
    const lerConsulta = () => page.evaluate(() => {
      const nomeTh = (th) => {
        const inp = th.querySelector('input');
        return ((th.innerText || '').trim() || (inp && inp.placeholder ? inp.placeholder.trim() : '') || (th.getAttribute('aria-label') || '').split(':')[0].trim());
      };
      const tabelas = Array.from(document.querySelectorAll('table'));
      const t = tabelas.find((tb) => Array.from(tb.querySelectorAll('thead th')).some((th) => nomeTh(th).toLowerCase().indexOf('situa') !== -1));
      if (!t) return { ok: false, headers: [], linhas: [], processando: false };
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
      return { ok: true, headers, linhas, processando };
    });

    let consulta = { ok: false, headers: [], linhas: [], processando: false };
    const tFiltro = Date.now();
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      budgetFor('poll-consulta', 1000);
      consulta = await lerConsulta().catch(() => consulta);
      const achou = consulta.linhas.some((l) => Object.keys(l).some((k) => l[k] === String(protocolo)));
      if (achou && !consulta.processando) break;
      // A resposta já chegou: 4 s para o DataTables redesenhar; vazia depois disso é vazia de verdade.
      if (Date.now() - tFiltro > 4000 && !consulta.processando && consulta.linhas.length === 0) break;
    }
    trace.push({ step: 'consulta_lida', headers: consulta.headers, n_linhas: consulta.linhas.length, t: Date.now() - t0 });

    // Itens: GET de leitura do próprio portal. Se vier vazio sem o pedido aberto, carrega a página de detalhe
    // (só GET — o que o founder faz à mão) e lê de novo. Nenhum clique na tela de detalhe.
    const buscarItens = () => page.evaluate(async (nr) => {
      try {
        const r = await fetch('/order-creation/busca-itens-pedido/' + encodeURIComponent(nr), {
          credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
        });
        const txt = await r.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { json = null; }
        return { status: r.status, json, raw: json ? null : txt.substring(0, 300) };
      } catch (e) {
        return { status: 0, json: null, raw: String((e && e.message) || e) };
      }
    }, protocolo);
    const temItens = (b) => !!(b && b.json && b.json.success === true && Array.isArray(b.json.itens) && b.json.itens.length > 0);

    let itens = null;
    const achouNaConsulta = consulta.linhas.some((l) => Object.keys(l).some((k) => l[k] === String(protocolo)));
    if (achouNaConsulta) {
      itens = await buscarItens();
      trace.push({ step: 'itens_direto', status: itens.status, ok: temItens(itens), t: Date.now() - t0 });
      if (!temItens(itens)) {
        await page.goto(portalUrl + '/order-creation-form-edit/' + encodeURIComponent(protocolo) + '/route/order-viewer',
          { waitUntil: 'domcontentloaded', timeout: budgetFor('goto-detalhe', 30000) });
        await sleep(2500);
        itens = await buscarItens();
        trace.push({ step: 'itens_pos_detalhe', status: itens.status, ok: temItens(itens), t: Date.now() - t0 });
      }
    }

    return {
      data: { success: true, consulta: { headers: consulta.headers, linhas: consulta.linhas }, itens: itens ? itens.json : null, trace },
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
  consulta?: { headers?: string[]; linhas?: LinhaConsultaRaw[] };
  itens?: unknown;
  trace?: unknown[];
}

interface PedidoEstado {
  id: number;
  status: string | null;
  portal_protocolo: string | null;
  omie_pedido_compra_numero: string | null;
  omie_pedido_compra_id: string | number | null;
  valor_total: number | null;
  num_skus: number | null;
  importado_portal_em: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function dispararOmie(pedidoId: number): Promise<{ httpStatus: number; body: string }> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/disparar-pedidos-aprovados`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ empresa: "OBEN", pedido_id: pedidoId }),
  });
  return { httpStatus: resp.status, body: (await resp.text()).slice(0, 800) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: { protocolo?: unknown } = {};
  try {
    body = (await req.json()) as { protocolo?: unknown };
  } catch {
    return json({ ok: false, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial (anônimo não lê versão), antes de qualquer leitura/escrita
  // ou do portal: é o único caminho sem efeito colateral (ver versao.ts).
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }
  // Importar é ação de PESSOA: cron não importa pedido de ninguém.
  if (auth.via === "cron") return json({ ok: false, mensagem: "Importação de pedido do portal é só para staff." }, 403);
  const operador = auth.userId ?? null;

  const protocolo = String(body?.protocolo ?? "").trim();
  if (!PROTOCOLO_RE.test(protocolo)) {
    return json({ ok: false, mensagem: "Número do pedido deve ter só dígitos (3 a 12)." }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const estado = async (filtro: { id?: number; protocolo?: string }): Promise<PedidoEstado | null> => {
    let q = db.from("pedido_compra_sugerido")
      .select("id, status, portal_protocolo, omie_pedido_compra_numero, omie_pedido_compra_id, valor_total, num_skus, importado_portal_em");
    q = filtro.id != null ? q.eq("id", filtro.id) : q.eq("portal_protocolo", filtro.protocolo as string);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`Leitura do pedido: ${error.message}`);
    return (data as PedidoEstado | null) ?? null;
  };
  const temPo = (p: PedidoEstado) => p.omie_pedido_compra_id != null && String(p.omie_pedido_compra_id).trim() !== "" && String(p.omie_pedido_compra_id).trim() !== "0";
  const responderComEstado = async (pedidoId: number, extra: Record<string, unknown>) => {
    const p = await estado({ id: pedidoId });
    const comPo = !!p && temPo(p);
    return json({
      ok: comPo,
      etapa: comPo ? "concluido" : "omie",
      pedido_id: pedidoId,
      protocolo,
      status: p?.status ?? null,
      omie_numero: p?.omie_pedido_compra_numero ?? null,
      valor_total: p?.valor_total ?? null,
      mensagem: comPo
        ? `Pedido ${protocolo} importado: pedido de compra ${p?.omie_pedido_compra_numero ?? ""} criado no Omie.`
        : `Pedido ${protocolo} gravado no app, mas o pedido de compra no Omie ainda não saiu (status ${p?.status ?? "?"}). Tente importar de novo para re-disparar.`,
      ...extra,
    });
  };

  try {
    // 0. Já existe no app? Não abre o portal de novo: devolve o estado e, se faltar só o Omie, re-dispara.
    const existente = await estado({ protocolo });
    if (existente) {
      if (temPo(existente)) {
        return json({
          ok: true, etapa: "concluido", ja_existia: true, pedido_id: existente.id, protocolo,
          status: existente.status, omie_numero: existente.omie_pedido_compra_numero, valor_total: existente.valor_total,
          mensagem: `O pedido ${protocolo} já está no app (#${existente.id}) com pedido de compra ${existente.omie_pedido_compra_numero ?? ""} no Omie.`,
        });
      }
      if (existente.status && STATUS_REDISPARAVEIS.has(existente.status)) {
        const omie = await dispararOmie(existente.id);
        return await responderComEstado(existente.id, { ja_existia: true, disparo_http: omie.httpStatus });
      }
      return json({
        ok: false, etapa: "importacao", ja_existia: true, pedido_id: existente.id, protocolo, status: existente.status,
        mensagem: `O pedido ${protocolo} já está no app (#${existente.id}, status ${existente.status}) sem pedido de compra no Omie — resolva por Gerir pedidos.`,
      });
    }

    const faltando = [
      ["SAYERLACK_PORTAL_USER", SAYERLACK_PORTAL_USER], ["SAYERLACK_PORTAL_PASS", SAYERLACK_PORTAL_PASS],
      ["SAYERLACK_PORTAL_URL", SAYERLACK_PORTAL_URL], ["SAYERLACK_PORTAL_CLIENTE_CODIGO", SAYERLACK_PORTAL_CLIENTE_CODIGO],
      ["BROWSERLESS_TOKEN", BROWSERLESS_TOKEN],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (faltando.length > 0) return json({ ok: false, etapa: "leitura", mensagem: `Configuração ausente: ${faltando.join(", ")}` }, 500);

    // 1. Lê o pedido no portal.
    const t0 = Date.now();
    let envelope: BrowserlessData = {};
    let httpStatus = 0;
    let httpErr: string | null = null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 185_000);
      const resp = await fetch(`https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=180000`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          code: BROWSERLESS_FUNCTION,
          context: {
            user: SAYERLACK_PORTAL_USER, pass: SAYERLACK_PORTAL_PASS, portalUrl: SAYERLACK_PORTAL_URL,
            clienteCodigo: SAYERLACK_PORTAL_CLIENTE_CODIGO, protocolo,
          },
        }),
      });
      clearTimeout(timeout);
      httpStatus = resp.status;
      const txt = await resp.text();
      try {
        envelope = ((JSON.parse(txt) as { data?: BrowserlessData }).data) ?? {};
      } catch {
        envelope = { success: false, erroTipo: "RESPOSTA_INVALIDA", erro: txt.slice(0, 300) };
      }
    } catch (e) {
      httpErr = mensagemDeErro(e) ?? "erro sem mensagem";
    }
    console.log(`[importar-portal] ${protocolo}: Browserless ${Date.now() - t0}ms http=${httpStatus}${httpErr ? ` erro=${httpErr}` : ""} tipo=${envelope.erroTipo ?? "-"}`);

    if (httpErr || httpStatus < 200 || httpStatus >= 300 || envelope.success !== true) {
      const causa = httpErr ? `navegador remoto: ${httpErr}` : envelope.erro ?? `HTTP ${httpStatus}`;
      return json({
        ok: false, etapa: "leitura", protocolo, erro_tipo: envelope.erroTipo ?? null,
        mensagem: `Não consegui ler o portal Sayerlack (${causa}). Lembre: o portal fica fora do ar de sábado 12h a segunda 6h.`,
        trace: envelope.trace ?? null,
      });
    }

    // 2. Prova a leitura.
    const lido = lerPedidoPortal(envelope.consulta?.linhas ?? [], envelope.itens, protocolo);
    if (!lido.ok) {
      return json({ ok: false, etapa: "leitura", protocolo, motivo: lido.motivo, mensagem: lido.detalhe, trace: envelope.trace ?? null });
    }

    // 3. Grava (tudo-ou-nada) com a prova de custo.
    const { data: rpcData, error: rpcErr } = await db.rpc("sayerlack_importar_pedido_portal", {
      p_protocolo: protocolo,
      p_data_entrega: lido.cabecalho.data_entrega,
      p_valor_total: lido.cabecalho.valor_total,
      p_itens: lido.itens.map((i) => ({ sku_portal: i.sku_portal, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria })),
      p_operador: operador,
    });
    const itensResumo = lido.itens.map((i) => ({ sku_portal: i.sku_portal, descricao: i.descricao, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria }));
    if (rpcErr) {
      return json({
        ok: false, etapa: "importacao", protocolo, sqlstate: rpcErr.code ?? null,
        mensagem: mensagemErroImportacao(rpcErr.code, rpcErr.message),
        situacao_portal: lido.cabecalho.situacao, valor_total_portal: lido.cabecalho.valor_total, itens: itensResumo,
      });
    }
    const pedidoId = Number((rpcData as { pedido_id?: unknown } | null)?.pedido_id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return json({ ok: false, etapa: "importacao", protocolo, mensagem: `Resposta inesperada da importação: ${JSON.stringify(rpcData)?.slice(0, 200)}` });
    }

    // 4. PO no Omie pelo caminho de sempre, e a resposta é o que o BANCO diz depois.
    const omie = await dispararOmie(pedidoId);
    console.log(`[importar-portal] ${protocolo}: pedido ${pedidoId} gravado; disparo HTTP ${omie.httpStatus}`);
    return await responderComEstado(pedidoId, {
      ja_existia: (rpcData as { ja_existia?: unknown } | null)?.ja_existia === true,
      disparo_http: omie.httpStatus,
      situacao_portal: lido.cabecalho.situacao,
      valor_total_portal: lido.cabecalho.valor_total,
      itens: itensResumo,
    });
  } catch (e) {
    return json({ ok: false, etapa: "importacao", protocolo, mensagem: mensagemDeErro(e) ?? "erro inesperado" }, 500);
  }
});
