// Edge Function: sayerlack-captura-precos
// Captura mensal de preços dos concentrados WP (QT×GL) no portal Sayerlack —
// alimenta a tela de Embalagem econômica e o motor (troca estrita QT→GL).
// Spec: docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md
//
// SEGURANÇA (money-path): esta edge é SEPARADA da de envio de pedido e compartilha
// só o PADRÃO de login/navegação. Não existe caminho de código que finalize/grave
// pedido no portal: o fluxo lê o preço da linha EM EDIÇÃO (o preço aparece ao
// selecionar o item no select2 — achado do spike-A) e CANCELA a linha. Nada é
// gravado, nem em sessão. O teste-invariante
// src/lib/reposicao/__tests__/embalagem-captura-edge-invariants.test.ts quebra o CI
// se qualquer token de finalização/gravação aparecer neste arquivo.
//
// Modos: 'spike' (1 grupo — WP01, referência conferível) e 'full' (todos os grupos).
// Disparo: 'cron' (mensal, dias 10-12, guard idempotente) | 'manual' (staff) |
// 'reajuste' (Fase 1.5 — reservado). Kill-switch company_config
// 'embalagem_captura_automatica_habilitada' gateia SÓ o disparo cron (a captura
// AUTOMÁTICA); manual staff roda com ele desligado (é como o spike-B valida em prod).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import {
  decidirLeituraEmbalagem,
  decidirExecucaoRun,
  resumirRun,
  montarInsertPreco,
  escolherGrupoSpike,
  type CapturaItemBruto,
  type LeituraEmbalagem,
  type RunResumo,
  type InsertPreco,
} from "../_shared/embalagem-captura-helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const SAYERLACK_PORTAL_CLIENTE_CODIGO = Deno.env.get("SAYERLACK_PORTAL_CLIENTE_CODIGO");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");

// Função JS que roda no Chrome remoto via Browserless v2 (/function, Puppeteer).
// Mesmo padrão de budget/login/navegação da edge de envio (provado em prod), MAS o
// loop de itens só SELECIONA o item no select2, LÊ as células da linha em edição e
// CANCELA a linha (X vermelho). Nunca digita quantidade, nunca grava linha.
// Regex dentro deste template literal: '\\' produz '\' no código enviado.
const BROWSERLESS_FUNCTION = `
export default async ({ page, context }) => {
  const { user, pass, portalUrl, clienteCodigo, items } = context;
  const trace = [];
  const t0 = Date.now();

  // === Budget management (deadline global, aborto limpo) ===
  // Supabase edge tem wall-clock ~400s; Browserless Prototyping aceita mais.
  // 340s interno + 20s de margem antes do ?timeout=360000 da URL. Sem reserva de
  // submit: esta função não tem etapa de finalização — o que sobra é só o return.
  const HARD_CEILING_MS = 340_000;
  const RETURN_GUARD_MS = 2_000;
  const ITEM_MIN_BUDGET_MS = 5_000;
  const deadline = t0 + HARD_CEILING_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  const budgetFor = (label, idealMs, opts) => {
    const minMs = (opts && typeof opts.minMs === 'number') ? opts.minMs : 500;
    const budget = Math.max(0, remainingMs() - RETURN_GUARD_MS);
    const allowed = Math.min(idealMs, budget);
    if (allowed < minMs) {
      const err = new Error(
        'BUDGET_EXHAUSTED em "' + label + '": precisava de >=' + minMs +
        'ms mas só restam ' + allowed + 'ms'
      );
      err.code = 'BUDGET_EXHAUSTED';
      err.label = label;
      throw err;
    }
    return allowed;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fillInput = async (selector, value) => {
    await page.click(selector);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, selector);
    await page.type(selector, String(value));
  };

  const clickButtonByText = async (text) => {
    const clicked = await page.evaluate((t) => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.innerText || '').trim().includes(t),
      );
      if (btn) { btn.click(); return true; }
      return false;
    }, text);
    if (!clicked) throw new Error('Botao com texto "' + text + '" nao encontrado');
  };

  const applyStealth = async () => {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Upgrade-Insecure-Requests': '1',
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    });
  };

  // Lê as células da ÚLTIMA linha do #datatable_itens (a linha em edição) por
  // header-matching — robusto a mudança de ordem de colunas. Célula com input
  // usa .value; senão innerText (a linha em edição pode renderizar inputs).
  // codigo_confere: o texto completo da linha precisa conter o sku esperado —
  // guarda contra o select2 ter selecionado OUTRO item (primeira option errada).
  const lerLinhaEdicao = (skuEsperado) => page.evaluate(function(skuEsp) {
    var table = document.querySelector('#datatable_itens');
    if (!table) return { ok: false, motivo: 'sem_tabela' };
    var ths = Array.from(table.querySelectorAll('thead th')).map(function(th){ return (th.innerText || '').trim(); });
    var idxPrecoVenda = ths.findIndex(function(h){ return /pre[çc]o\\s*venda/i.test(h); });
    var idxPrecoUN = ths.findIndex(function(h){ return /pre[çc]o\\s*un\\b/i.test(h); });
    var idxDesc = ths.findIndex(function(h){ return /desconto/i.test(h); });
    var idxPrz = ths.findIndex(function(h){ return /prz|prazo/i.test(h); });
    var rows = table.querySelectorAll('tbody tr');
    if (!rows.length) return { ok: false, motivo: 'sem_linha_em_edicao', headers: ths };
    var tr = rows[rows.length - 1];
    var tds = Array.from(tr.querySelectorAll('td'));
    function cell(idx) {
      if (idx < 0 || idx >= tds.length) return '';
      var td = tds[idx];
      var input = td.querySelector('input, select');
      if (input && typeof input.value === 'string' && input.value.trim() !== '') return input.value.trim();
      return (td.innerText || '').trim();
    }
    var textoLinha = (tr.innerText || '');
    Array.from(tr.querySelectorAll('input, select')).forEach(function(el) {
      if (typeof el.value === 'string') textoLinha += ' ' + el.value;
      if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions.length) {
        textoLinha += ' ' + (el.selectedOptions[0].innerText || '');
      }
    });
    var confere = textoLinha.toUpperCase().indexOf(String(skuEsp || '').toUpperCase()) !== -1;
    return {
      ok: true,
      headers: ths,
      n_rows: rows.length,
      codigo_confere: confere,
      preco_venda_raw: cell(idxPrecoVenda),
      preco_un_raw: cell(idxPrecoUN),
      desconto_raw: cell(idxDesc),
      prz_ent_raw: cell(idxPrz),
    };
  }, skuEsperado);

  // Cancela a linha em edição (X vermelho — spike-A: cancela sem dialog).
  // Cascata: #btnCancelarItem → botão/link com pista de cancelar na última linha →
  // na área da tabela. Melhor esforço: mesmo sem cancelar, nada persiste sem o
  // "Salvar Proposta" (provado no spike-A), mas a linha pendurada pode atrapalhar
  // o próximo "+ Incluir Item" — por isso registramos e verificamos rows depois.
  const cancelarLinhaEdicao = () => page.evaluate(function() {
    function visivel(el) { return el && el.offsetParent !== null; }
    var byId = document.querySelector('#btnCancelarItem');
    if (visivel(byId)) { byId.click(); return { clicked: true, via: 'btnCancelarItem' }; }
    var table = document.querySelector('#datatable_itens');
    if (!table) return { clicked: false, motivo: 'sem_tabela' };
    var rows = table.querySelectorAll('tbody tr');
    var escopos = [];
    if (rows.length) escopos.push(rows[rows.length - 1]);
    escopos.push(table);
    for (var e = 0; e < escopos.length; e++) {
      var cands = Array.from(escopos[e].querySelectorAll('button, a')).filter(visivel);
      var alvo = cands.find(function(b){
        var blob = ((b.className || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.innerHTML || '')).toLowerCase();
        return /cancel|descart|fa-times|fa-ban|btn-danger|fa-trash|times-circle/.test(blob);
      });
      if (alvo) {
        alvo.click();
        return { clicked: true, via: e === 0 ? 'linha_match' : 'tabela_match', debug: (alvo.outerHTML || '').substring(0, 120) };
      }
    }
    return {
      clicked: false,
      botoes_visiveis: Array.from(table.querySelectorAll('button, a')).filter(visivel).map(function(b){
        return { id: b.id || '', cls: (b.className || '').substring(0, 60), txt: (b.innerText || '').trim().substring(0, 30) };
      }).slice(0, 12),
    };
  });

  const contarRows = () => page.evaluate(function() {
    var table = document.querySelector('#datatable_itens');
    return table ? table.querySelectorAll('tbody tr').length : -1;
  });

  const runFlow = async () => {
    const itens = [];
    const naoProcessados = [];
    let headersVistos = [];
   try {
    await applyStealth();
    trace.push({ step: 'login_start', t: Date.now() - t0 });
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: budgetFor('login-goto', 30_000) });
    await page.waitForSelector('#user', { timeout: budgetFor('login-form', 10_000) });
    await fillInput('#user', user);
    await fillInput('#password', pass);

    const navPromise = page.waitForNavigation({ timeout: budgetFor('login-nav', 15_000) }).catch(() => null);
    await clickButtonByText('Entrar');
    await navPromise;

    const loginCheckMs = budgetFor('login-check', 15_000);
    const loginCheckPolls = Math.max(2, Math.floor(loginCheckMs / 500));
    const loginCheck = await Promise.race([
      (async () => {
        for (let i = 0; i < loginCheckPolls; i++) {
          const url = page.url();
          if (!url.includes('/login')) return { ok: true, via: 'url_changed', url };
          await sleep(500);
        }
        return { ok: false, via: 'url_stuck_login', url: page.url() };
      })(),
      (async () => {
        try {
          await page.waitForSelector('#sidebar, .app-sidebar', { timeout: loginCheckMs });
          return { ok: true, via: 'sidebar_found', url: page.url() };
        } catch {
          return { ok: false, via: 'sidebar_not_found', url: page.url() };
        }
      })(),
    ]);

    if (!loginCheck.ok) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
      return {
        data: {
          success: false,
          erro: 'Login falhou — área logada não detectada após submit do formulário de login',
          erroTipo: 'LOGIN_FAILED',
          loginCheckResult: loginCheck,
          itens, itens_nao_processados: items.map(function(it){ return it.sku_portal; }),
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
      };
    }
    trace.push({ step: 'login_success', via: loginCheck.via, t: Date.now() - t0 });

    await sleep(2000);

    // Navegação SEMPRE via clique no menu (goto direto redireciona p/ rota de erro)
    await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.classList.contains('app-sidebar-minified')) {
        const minifyBtn = document.querySelector('.app-sidebar-minify-btn');
        if (minifyBtn) minifyBtn.click();
      }
    });
    await sleep(800);
    await page.waitForFunction(
      () => document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link').length > 0,
      { timeout: budgetFor('sidebar-links', 15_000) }
    ).catch(() => null);

    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link'));
      const vendasLink = links.find((l) => (l.innerText || '').trim().includes('Vendas'));
      if (vendasLink) vendasLink.click();
    });
    await page.waitForFunction(function() {
      const links = Array.from(document.querySelectorAll('a'));
      return links.some(function(a) {
        return a.getAttribute('href') === '/order-creation' && a.offsetParent !== null;
      });
    }, { timeout: budgetFor('sidebar-pedidos-link', 5_000, { minMs: 300 }), polling: 100 }).catch(() => null);

    const clicouPedidos = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      const link = allLinks.find((l) => l.getAttribute('href') === '/order-creation');
      if (link) { link.click(); return true; }
      return false;
    });
    if (!clicouPedidos) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
      return {
        data: {
          success: false,
          erro: 'Não conseguiu navegar até Pedidos/Propostas pelo menu lateral',
          erroTipo: 'NAVIGATION_FAILED',
          itens, itens_nao_processados: items.map(function(it){ return it.sku_portal; }),
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
      };
    }
    await page.waitForFunction(
      () => window.location.href.endsWith('/order-creation'),
      { timeout: budgetFor('nav-order-creation', 15_000) }
    ).catch(() => null);
    await sleep(2000);
    trace.push({ step: 'order_creation_ok', url: page.url(), t: Date.now() - t0 });

    await page.waitForSelector('#btnNovoPedido', { timeout: budgetFor('btn-novo-pedido', 25_000) });
    await page.click('#btnNovoPedido');
    await page.waitForSelector('#select2-cliente-container', { timeout: budgetFor('select2-cliente-container', 10_000) });
    trace.push({ step: 'novo_pedido_open', t: Date.now() - t0 });

    await page.click('#select2-cliente-container');
    await sleep(300);
    await page.waitForSelector('.select2-search__field', { timeout: budgetFor('select2-cliente-search', 5_000) });
    await fillInput('.select2-search__field', clienteCodigo);
    await sleep(2000);
    const clienteOption = await page.$('.select2-results__option:not(.select2-results__message)');
    if (!clienteOption) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
      return {
        data: {
          success: false,
          erro: 'Cliente ' + clienteCodigo + ' não encontrado no select2',
          erroTipo: 'CLIENTE_NOT_FOUND',
          itens, itens_nao_processados: items.map(function(it){ return it.sku_portal; }),
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
      };
    }
    await clienteOption.click();
    await sleep(500);
    trace.push({ step: 'cliente_selecionado', t: Date.now() - t0 });

    // === Loop de captura: selecionar → ler linha em edição → cancelar ===
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const restantes = items.length - i;
      if (remainingMs() < restantes * ITEM_MIN_BUDGET_MS + RETURN_GUARD_MS && remainingMs() < ITEM_MIN_BUDGET_MS * 2) {
        // Sem janela nem para ESTE item: aborta limpo devolvendo o que já foi lido.
        for (let j = i; j < items.length; j++) naoProcessados.push(items[j].sku_portal);
        trace.push({ step: 'budget_abort', item_index: i, remaining: remainingMs(), t: Date.now() - t0 });
        break;
      }
      trace.push({ step: 'item_' + i + '_start', sku: item.sku_portal, t: Date.now() - t0, remaining: remainingMs() });

      // Espera o portal sair de eventual validação assíncrona (botão some durante).
      await page.waitForFunction(function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const visiveis = btns.filter(function(b) { return b.offsetParent !== null; });
        const temIncluirItem = visiveis.some(function(b) {
          const txt = (b.innerText || '').trim();
          return txt.includes('Incluir Item') && !txt.includes('Múltiplos');
        });
        const temValidando = visiveis.some(function(b) {
          return (b.innerText || '').includes('Validando');
        });
        return temIncluirItem && !temValidando;
      }, { timeout: budgetFor('item-' + i + '-incluir-visivel', 12_000, { minMs: 1_000 }), polling: 250 }).catch(() => null);
      await sleep(300);

      const addItemClicado = await page.evaluate(function(idx) {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const visibleBtns = allBtns.filter(function(b) { return b.offsetParent !== null; });
        const incluirBtn = visibleBtns.find(function(b) {
          const txt = (b.innerText || '').trim();
          return txt.includes('Incluir Item') && !txt.includes('Múltiplos');
        });
        if (incluirBtn) { incluirBtn.click(); return { clicked: true, via: 'text_match' }; }
        if (idx === 0) {
          const primario = document.querySelector('#colSpanBtnIncluirItem button.btn-primary');
          if (primario && primario.offsetParent !== null) { primario.click(); return { clicked: true, via: 'colSpanBtnIncluirItem' }; }
        }
        const tfootBtn = document.querySelector('tfoot button.btn-primary');
        if (tfootBtn && tfootBtn.offsetParent !== null) { tfootBtn.click(); return { clicked: true, via: 'tfoot' }; }
        return { clicked: false };
      }, i);
      trace.push({ step: 'incluir_item_' + i, addItemClicado, t: Date.now() - t0 });
      if (!addItemClicado.clicked) {
        // Sem botão de incluir — estado do formulário inesperado. Aborta limpo com o já lido.
        for (let j = i; j < items.length; j++) naoProcessados.push(items[j].sku_portal);
        trace.push({ step: 'incluir_indisponivel_abort', item_index: i, t: Date.now() - t0 });
        break;
      }
      await sleep(2000);

      // select2 do item (fallback de ID dinâmico, mesmo padrão da edge de envio)
      let select2Sel = '#select2-it_codigo-container';
      const domInfo = await page.evaluate(() => {
        const exact = !!document.querySelector('#select2-it_codigo-container');
        const cands = Array.from(document.querySelectorAll('[id^="select2-it_codigo"], [id*="it_codigo"]'))
          .filter(function(el) { return el.offsetParent !== null; })
          .map(function(el) { return el.id; });
        return { exact, cands };
      });
      if (!domInfo.exact && domInfo.cands.length > 0) select2Sel = '#' + domInfo.cands[0];
      const select2Ok = await page.waitForSelector(select2Sel, { timeout: budgetFor('item-' + i + '-select2', 10_000, { minMs: 1_000 }) }).then(() => true).catch(() => false);
      if (!select2Ok) {
        itens.push({ sku_portal: item.sku_portal, achado: false, motivo_nao_achado: 'select2_item_indisponivel' });
        const cancel0 = await cancelarLinhaEdicao().catch(() => ({ clicked: false }));
        trace.push({ step: 'item_' + i + '_select2_indisponivel', cancel: cancel0, t: Date.now() - t0 });
        continue;
      }
      await page.click(select2Sel);
      await sleep(300);
      await page.waitForSelector('.select2-search__field', { timeout: budgetFor('item-' + i + '-search', 5_000, { minMs: 800 }) });
      await fillInput('.select2-search__field', item.sku_portal);
      await sleep(2000);

      const skuOption = await page.$('.select2-results__option:not(.select2-results__message)');
      if (!skuOption) {
        // "Nenhum resultado encontrado" = sinal de item inativado (spike-A) →
        // marca e SEGUE (≠ fluxo de pedido, que aborta). Fecha o dropdown e cancela a linha.
        const msg = await page.evaluate(function() {
          const m = document.querySelector('.select2-results__message');
          return m ? (m.innerText || '').trim().substring(0, 80) : null;
        });
        await page.keyboard.press('Escape').catch(() => null);
        await sleep(300);
        const cancelNE = await cancelarLinhaEdicao().catch(() => ({ clicked: false }));
        await sleep(500);
        itens.push({ sku_portal: item.sku_portal, achado: false, motivo_nao_achado: msg || 'nenhum_resultado_select2' });
        trace.push({ step: 'item_' + i + '_nao_encontrado', msg, cancel: cancelNE, t: Date.now() - t0 });
        continue;
      }
      await skuOption.click();

      // Espera o preço popular na linha em edição (o portal preenche ao selecionar).
      await page.waitForFunction(function() {
        var table = document.querySelector('#datatable_itens');
        if (!table) return false;
        var rows = table.querySelectorAll('tbody tr');
        if (!rows.length) return false;
        var ths = Array.from(table.querySelectorAll('thead th')).map(function(th){ return (th.innerText || '').trim(); });
        var idx = ths.findIndex(function(h){ return /pre[çc]o\\s*venda/i.test(h); });
        if (idx < 0) return true;
        var tds = rows[rows.length - 1].querySelectorAll('td');
        if (idx >= tds.length) return true;
        var td = tds[idx];
        var input = td.querySelector('input, select');
        var v = input && typeof input.value === 'string' && input.value.trim() !== '' ? input.value.trim() : (td.innerText || '').trim();
        return v !== '' && v !== '0,00' && v !== '0';
      }, { timeout: budgetFor('item-' + i + '-preco-populado', 8_000, { minMs: 800 }), polling: 250 }).catch(() => null);
      await sleep(400);

      const linha = await lerLinhaEdicao(item.sku_portal);
      if (linha && Array.isArray(linha.headers)) headersVistos = linha.headers;
      trace.push({ step: 'item_' + i + '_lido', linha_ok: !!(linha && linha.ok), codigo_confere: linha ? linha.codigo_confere : null, t: Date.now() - t0 });

      // Cancela a linha em edição (nada pode ficar no rascunho).
      const cancel = await cancelarLinhaEdicao().catch(() => ({ clicked: false }));
      await sleep(600);
      const rowsApos = await contarRows().catch(() => -1);
      trace.push({ step: 'item_' + i + '_cancelado', cancel, rows_apos: rowsApos, t: Date.now() - t0 });

      itens.push({
        sku_portal: item.sku_portal,
        achado: true,
        codigo_confere: linha && linha.ok ? linha.codigo_confere : undefined,
        preco_venda_raw: linha && linha.ok ? linha.preco_venda_raw : '',
        preco_un_raw: linha && linha.ok ? linha.preco_un_raw : '',
        desconto_raw: linha && linha.ok ? linha.desconto_raw : '',
        prz_ent_raw: linha && linha.ok ? linha.prz_ent_raw : '',
        cancelamento_ok: !!(cancel && cancel.clicked) && rowsApos === 0,
        n_rows_apos: rowsApos,
      });
    }

    // Verificação final: nenhuma linha pode ter sobrado no rascunho.
    const linhasFinais = await contarRows().catch(() => -1);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, encoding: 'base64' }).catch(() => null);
    trace.push({ step: 'fim', linhas_finais: linhasFinais, t: Date.now() - t0 });

    return {
      data: {
        success: true,
        itens,
        itens_nao_processados: naoProcessados,
        linhas_finais: linhasFinais,
        headers: headersVistos,
        durationMs: Date.now() - t0,
        trace,
      },
      type: 'application/json',
      screenshot,
    };
   } catch (err) {
    const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
    const erroTipo = (err && err.code) ? err.code : 'EXCEPTION';
    // Aborto limpo: devolve o que já foi lido; os demais viram não-processados.
    const lidos = {};
    for (const it of itens) lidos[it.sku_portal] = true;
    const pendentes = items.map(function(it){ return it.sku_portal; }).filter(function(s){ return !lidos[s]; });
    return {
      data: {
        success: false,
        erro: (err && err.message) ? err.message : String(err),
        erroTipo,
        budgetLabel: (err && err.label) || null,
        itens,
        itens_nao_processados: pendentes,
        elapsedMs: Date.now() - t0,
        trace,
      },
      type: 'application/json',
      screenshot: errorScreenshot,
    };
   }
  };

  return await runFlow();
};
`;

interface BrowserlessData {
  success?: boolean;
  erro?: string | null;
  erroTipo?: string | null;
  itens?: CapturaItemBruto[];
  itens_nao_processados?: string[];
  linhas_finais?: number | null;
  headers?: string[];
  trace?: unknown[];
  [key: string]: unknown;
}

interface BrowserlessResponse {
  data?: BrowserlessData;
  screenshot?: string | null;
  raw?: string;
  [key: string]: unknown;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function uploadEvidencia(
  supabase: SupabaseClient,
  runId: string,
  base64: string | null | undefined,
): Promise<string | null> {
  if (!base64) return null;
  try {
    let cleaned = base64;
    if (cleaned.startsWith("data:")) {
      const commaIdx = cleaned.indexOf(",");
      if (commaIdx !== -1) cleaned = cleaned.substring(commaIdx + 1);
    }
    const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    const path = `captura_${runId}_${Date.now()}.png`;
    const { error: upErr } = await supabase.storage
      .from("portal_screenshots")
      .upload(path, bytes, { contentType: "image/png", upsert: false });
    if (upErr) {
      console.error(`[captura-precos] run ${runId}: falha upload screenshot:`, upErr.message);
      return null;
    }
    const { data: signed } = await supabase.storage
      .from("portal_screenshots")
      .createSignedUrl(path, 60 * 60 * 24 * 30);
    return signed?.signedUrl ?? path;
  } catch (e) {
    console.error(`[captura-precos] run ${runId}: exceção upload screenshot:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const modo: "spike" | "full" = body.modo === "spike" ? "spike" : "full";
  // Disparo: o job AGENDADO não manda 'disparo' no body → via cron-secret sem body
  // é 'cron' (kill-switch aplica). Um operador no SQL Editor (spike-B, testes)
  // porta o MESMO secret mas declara disparo:'manual' explícito → tratado como
  // manual (quem tem o secret já é o operador do sistema — autorização
  // equivalente a staff). 'reajuste' (Fase 1.5) só via service_role.
  const disparo: "cron" | "manual" | "reajuste" =
    auth.via === "cron"
      ? body.disparo === "manual"
        ? "manual"
        : "cron"
      : body.disparo === "reajuste" && auth.via === "service_role"
        ? "reajuste"
        : "manual";
  const empresa = typeof body.empresa === "string" && body.empresa ? String(body.empresa).toLowerCase() : "oben";
  const criadoPor = auth.via === "cron" ? "cron" : auth.via === "staff" ? (auth.userId ?? "staff") : "service_role";

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Kill-switch: gateia a captura AUTOMÁTICA (cron). Ausente/inválido = desligada
  // (fail-closed). Manual staff roda com ele desligado — é como o spike-B valida
  // em prod antes de o founder decidir ligar a automação.
  if (disparo === "cron") {
    const { data: cfg, error: cfgErr } = await supabase
      .from("company_config")
      .select("value")
      .eq("key", "embalagem_captura_automatica_habilitada")
      .maybeSingle();
    if (cfgErr) return jsonResponse(500, { ok: false, erro: `config indisponível: ${cfgErr.message}` });
    if ((cfg?.value ?? "false") !== "true") {
      console.log("[captura-precos] kill-switch desligado — saída limpa (cron)");
      return jsonResponse(200, { ok: false, motivo: "desligada" });
    }
  }

  const secretsFaltando = [
    ["SAYERLACK_PORTAL_USER", SAYERLACK_PORTAL_USER],
    ["SAYERLACK_PORTAL_PASS", SAYERLACK_PORTAL_PASS],
    ["SAYERLACK_PORTAL_URL", SAYERLACK_PORTAL_URL],
    ["SAYERLACK_PORTAL_CLIENTE_CODIGO", SAYERLACK_PORTAL_CLIENTE_CODIGO],
    ["BROWSERLESS_TOKEN", BROWSERLESS_TOKEN],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (secretsFaltando.length > 0) {
    return jsonResponse(500, { ok: false, erro: `secrets ausentes: ${secretsFaltando.join(", ")}` });
  }

  // Guard de execução (lock + idempotência mensal + circuit-breaker do dia).
  // Fail-closed: run-log ilegível → não roda (não arriscar run duplo).
  const desde = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const { data: runsRecentes, error: runsErr } = await supabase
    .from("sku_preco_captura_run")
    .select("status, iniciado_em")
    .eq("empresa", empresa)
    .gte("iniciado_em", desde);
  if (runsErr) return jsonResponse(500, { ok: false, erro: `run-log indisponível: ${runsErr.message}` });
  const decisao = decidirExecucaoRun((runsRecentes ?? []) as RunResumo[], new Date().toISOString(), disparo);
  if (!decisao.executa) {
    console.log(`[captura-precos] guard barrou o run: ${decisao.motivo} (disparo=${disparo})`);
    return jsonResponse(200, { ok: false, motivo: decisao.motivo });
  }

  // Alvo: grupos ativos de embalagem (empresa minúscula) + de-para do portal
  // (case-trap: sku_fornecedor_externo usa 'OBEN' MAIÚSCULO → ilike).
  const { data: equivRaw, error: equivErr } = await supabase
    .from("sku_embalagem_equivalencia")
    .select("grupo_id, sku_codigo_omie")
    .eq("empresa", empresa)
    .eq("ativo", true);
  if (equivErr) return jsonResponse(500, { ok: false, erro: `equivalência indisponível: ${equivErr.message}` });
  const equiv = (equivRaw ?? []) as { grupo_id: string; sku_codigo_omie: string }[];
  if (equiv.length === 0) return jsonResponse(200, { ok: false, motivo: "sem_grupos_ativos" });

  const skusGrupo = [...new Set(equiv.map((e) => String(e.sku_codigo_omie)))];
  const { data: deparaRaw, error: deparaErr } = await supabase
    .from("sku_fornecedor_externo")
    .select("sku_omie, sku_portal")
    .ilike("empresa", empresa)
    .ilike("fornecedor_nome", "%SAYERLACK%")
    .eq("ativo", true)
    .in("sku_omie", skusGrupo);
  if (deparaErr) return jsonResponse(500, { ok: false, erro: `de-para indisponível: ${deparaErr.message}` });
  const portalPorOmie = new Map<string, string>();
  for (const d of (deparaRaw ?? []) as { sku_omie: string; sku_portal: string | null }[]) {
    if (d.sku_portal) portalPorOmie.set(String(d.sku_omie), String(d.sku_portal).trim().toUpperCase());
  }

  let alvo = equiv.map((e) => ({
    grupo_id: String(e.grupo_id),
    sku_codigo_omie: String(e.sku_codigo_omie),
    sku_portal: portalPorOmie.get(String(e.sku_codigo_omie)) ?? null,
  }));

  if (modo === "spike") {
    const grupoSpike = escolherGrupoSpike(
      alvo.filter((a) => a.sku_portal).map((a) => ({ grupo_id: a.grupo_id, sku_portal: a.sku_portal! })),
    );
    if (!grupoSpike) return jsonResponse(200, { ok: false, motivo: "sem_grupo_spike" });
    alvo = alvo.filter((a) => a.grupo_id === grupoSpike);
  }

  const comDepara = alvo.filter((a) => a.sku_portal);
  const semDepara = alvo.filter((a) => !a.sku_portal);
  if (comDepara.length === 0) return jsonResponse(200, { ok: false, motivo: "sem_depara" });

  // Prioriza por staleness (sem preço primeiro, depois o mais velho): se o budget
  // do browser abortar antes do fim, os runs dos dias 10/11/12 completam a cauda
  // em vez de re-capturar sempre os mesmos primeiros (anti-starvation).
  {
    const { data: precosRaw } = await supabase
      .from("sku_preco_fornecedor_capturado")
      .select("sku_codigo_omie, capturado_em")
      .eq("empresa", empresa)
      .in("sku_codigo_omie", comDepara.map((a) => a.sku_codigo_omie))
      .gte("capturado_em", new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString())
      .order("capturado_em", { ascending: false })
      .limit(1000);
    const ultimoPreco = new Map<string, string>();
    for (const p of (precosRaw ?? []) as { sku_codigo_omie: string; capturado_em: string }[]) {
      const k = String(p.sku_codigo_omie);
      if (!ultimoPreco.has(k)) ultimoPreco.set(k, p.capturado_em);
    }
    comDepara.sort((a, b) => {
      const ta = ultimoPreco.get(a.sku_codigo_omie) ?? "";
      const tb = ultimoPreco.get(b.sku_codigo_omie) ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : a.sku_portal!.localeCompare(b.sku_portal!, "en");
    });
  }

  // Cria o run (o lock do guard lê este registro; running órfão expira pela janela).
  const { data: runRow, error: runErr } = await supabase
    .from("sku_preco_captura_run")
    .insert({
      empresa,
      disparo,
      modo,
      status: "running",
      total_alvo: alvo.length,
      criado_por: criadoPor,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return jsonResponse(500, { ok: false, erro: `falha ao criar run: ${runErr?.message ?? "sem id"}` });
  }
  const runId = String((runRow as { id: string }).id);
  console.log(`[captura-precos] run ${runId} iniciado: modo=${modo} disparo=${disparo} alvo=${alvo.length} (${comDepara.length} com de-para)`);

  try {
    // Browserless
    const tBrowserless = Date.now();
    let httpStatus = 0;
    let bResp: BrowserlessResponse | null = null;
    let httpErr: string | null = null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 380_000);
      const resp = await fetch(
        `https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=360000`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            code: BROWSERLESS_FUNCTION,
            context: {
              user: SAYERLACK_PORTAL_USER,
              pass: SAYERLACK_PORTAL_PASS,
              portalUrl: SAYERLACK_PORTAL_URL,
              clienteCodigo: SAYERLACK_PORTAL_CLIENTE_CODIGO,
              items: comDepara.map((a) => ({ sku_portal: a.sku_portal })),
            },
          }),
        },
      );
      clearTimeout(timeout);
      httpStatus = resp.status;
      const txt = await resp.text();
      try {
        bResp = JSON.parse(txt) as BrowserlessResponse;
      } catch {
        bResp = { raw: txt.slice(0, 2000) };
      }
    } catch (e) {
      httpErr = e instanceof Error ? e.message : String(e);
    }
    const browserlessMs = Date.now() - tBrowserless;
    console.log(`[captura-precos] run ${runId}: Browserless retornou em ${browserlessMs}ms — status=${httpStatus}${httpErr ? ` erro=${httpErr}` : ""}`);

    const envelope: BrowserlessData = bResp?.data ?? {};
    const evidenciaUrl = await uploadEvidencia(supabase, runId, bResp?.screenshot ?? null);

    const brutoPorPortal = new Map<string, CapturaItemBruto>();
    for (const it of envelope.itens ?? []) {
      if (it && typeof it.sku_portal === "string") {
        brutoPorPortal.set(it.sku_portal.trim().toUpperCase(), it);
      }
    }
    const naoProcessados = new Set((envelope.itens_nao_processados ?? []).map((s) => String(s).trim().toUpperCase()));

    const erroGlobal: string | null =
      httpErr ? `browserless fetch: ${httpErr}`
      : httpStatus < 200 || httpStatus >= 300 ? `browserless HTTP ${httpStatus}`
      : envelope.success === false ? `${envelope.erroTipo ?? "ERRO"}: ${envelope.erro ?? "sem detalhe"}`
      : null;

    // Classificação por embalagem (helper puro espelhado) + linhas sintéticas p/
    // cobertura total do alvo no run-log (sem-de-para / não-processado / sem retorno).
    const leituras: LeituraEmbalagem[] = [];
    const runItems: Record<string, unknown>[] = [];
    const insertsPreco: InsertPreco[] = [];

    for (const a of comDepara) {
      const key = a.sku_portal!;
      const bruto = brutoPorPortal.get(key);
      let leitura: LeituraEmbalagem;
      if (bruto) {
        leitura = decidirLeituraEmbalagem(bruto);
      } else if (naoProcessados.has(key)) {
        leitura = { sku_portal: key, resultado: "falha", preco: null, fonte: null, detalhe: "não processado (tempo esgotado no browser)" };
      } else {
        leitura = { sku_portal: key, resultado: "falha", preco: null, fonte: null, detalhe: erroGlobal ? `sem retorno do browser (${erroGlobal})` : "sem retorno do browser" };
      }
      leituras.push(leitura);
      runItems.push({
        run_id: runId,
        empresa,
        sku_codigo_omie: a.sku_codigo_omie,
        sku_portal: key,
        resultado: leitura.resultado,
        preco: leitura.preco,
        fonte: leitura.fonte,
        detalhe: leitura.detalhe,
      });
      const insert = montarInsertPreco(leitura, { empresa, skuCodigoOmie: a.sku_codigo_omie, runId });
      if (insert) insertsPreco.push(insert);
    }
    for (const a of semDepara) {
      const leitura: LeituraEmbalagem = { sku_portal: a.sku_codigo_omie, resultado: "falha", preco: null, fonte: null, detalhe: "sem de-para ativo em sku_fornecedor_externo" };
      leituras.push(leitura);
      runItems.push({
        run_id: runId,
        empresa,
        sku_codigo_omie: a.sku_codigo_omie,
        sku_portal: a.sku_codigo_omie,
        resultado: "falha",
        preco: null,
        fonte: null,
        detalhe: leitura.detalhe,
      });
    }

    let resumo = resumirRun(leituras);
    let erroFinal = erroGlobal;

    // Persistência: preços PRIMEIRO (é o efeito money-path); falha aqui rebaixa o run.
    if (insertsPreco.length > 0) {
      const { error: precoErr } = await supabase.from("sku_preco_fornecedor_capturado").insert(insertsPreco);
      if (precoErr) {
        erroFinal = `${erroFinal ? erroFinal + " | " : ""}insert de preços falhou: ${precoErr.message}`;
        resumo = { ...resumo, status: "falha" };
        insertsPreco.length = 0;
      }
    }
    if (runItems.length > 0) {
      const { error: itemErr } = await supabase.from("sku_preco_captura_run_item").insert(runItems);
      if (itemErr) {
        erroFinal = `${erroFinal ? erroFinal + " | " : ""}insert de run-items falhou: ${itemErr.message}`;
      }
    }

    const { error: updErr } = await supabase
      .from("sku_preco_captura_run")
      .update({
        status: resumo.status,
        terminado_em: new Date().toISOString(),
        total_ok: resumo.total_ok,
        total_nao_encontrado: resumo.total_nao_encontrado,
        total_falha: resumo.total_falha,
        evidencia_url: evidenciaUrl,
        erro: erroFinal,
        linhas_finais_portal: typeof envelope.linhas_finais === "number" ? envelope.linhas_finais : null,
      })
      .eq("id", runId);
    if (updErr) console.error(`[captura-precos] run ${runId}: falha ao finalizar run:`, updErr.message);

    console.log(`[captura-precos] run ${runId} terminou: status=${resumo.status} ok=${resumo.total_ok} nao_encontrado=${resumo.total_nao_encontrado} falha=${resumo.total_falha} precos_gravados=${insertsPreco.length}`);

    return jsonResponse(200, {
      ok: resumo.status !== "falha",
      run_id: runId,
      status_run: resumo.status,
      modo,
      disparo,
      total_alvo: alvo.length,
      total_ok: resumo.total_ok,
      total_nao_encontrado: resumo.total_nao_encontrado,
      total_falha: resumo.total_falha,
      precos_gravados: insertsPreco.length,
      linhas_finais_portal: envelope.linhas_finais ?? null,
      evidencia_url: evidenciaUrl,
      erro: erroFinal,
    });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    console.error(`[captura-precos] run ${runId}: exceção:`, erro);
    await supabase
      .from("sku_preco_captura_run")
      .update({ status: "falha", terminado_em: new Date().toISOString(), erro })
      .eq("id", runId);
    return jsonResponse(500, { ok: false, run_id: runId, erro });
  }
});
