// Edge Function: enviar-pedido-portal-sayerlack
// Automatiza envio de pedidos aprovados (OBEN -> Sayerlack) via Browserless.io
// Modos: ECO (validacao), lote (cron), individual (manual)

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const SAYERLACK_PORTAL_CLIENTE_CODIGO = Deno.env.get("SAYERLACK_PORTAL_CLIENTE_CODIGO");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");

const MAX_PEDIDOS_POR_EXECUCAO = 5;
const MAX_TENTATIVAS = 3;

// Funcao JS que roda no Chrome remoto via Browserless
// Sintaxe: Browserless v2 (/function endpoint) — usa "export default" e API Puppeteer
// Browserless v2 usa Puppeteer (NAO Playwright). Helpers Puppeteer-only:
//   - page.type(sel, txt) [nao page.fill]
//   - page.$ / page.$$ [nao page.locator]
//   - seletores CSS puros, sem :has-text
// Ref: https://docs.browserless.io/rest-apis/function
const BROWSERLESS_FUNCTION = `
export default async ({ page, context }) => {
  const { user, pass, portalUrl, clienteCodigo, items } = context;
  const trace = [];
  const t0 = Date.now();

  // Helper: limpa input e digita (substitui page.fill do Playwright)
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

  // Helper: clica em botao por texto (substitui :has-text do Playwright)
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

  // Helper: sleep (substitui page.waitForTimeout que sumiu em puppeteer recente)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Helper: aplica mascaras anti-deteccao (validado em teste isolado contra WAF Sayerlack)
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

  try {
    console.log('[DEBUG_CREDS]', JSON.stringify({
      user_present: typeof user === 'string' && user.length > 0,
      user_length: user?.length ?? 0,
      pass_present: typeof pass === 'string' && pass.length > 0,
      pass_length: pass?.length ?? 0,
      portalUrl,
      clienteCodigo,
    }));

    await applyStealth();
    trace.push({ step: 'login_start', t: Date.now() - t0 });
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#user', { timeout: 10000 });
    await fillInput('#user', user);
    await fillInput('#password', pass);

    const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
    await clickButtonByText('Entrar');
    await navPromise;

    // Heuristica robusta: aguarda evidencia POSITIVA de login bem-sucedido
    // (URL mudou para fora de /login OU elemento exclusivo da area logada apareceu)
    const loginCheck = await Promise.race([
      (async () => {
        for (let i = 0; i < 30; i++) { // 30 * 500ms = 15s max
          const url = page.url();
          if (!url.includes('/login')) return { ok: true, via: 'url_changed', url };
          await sleep(500);
        }
        return { ok: false, via: 'url_stuck_login', url: page.url() };
      })(),
      (async () => {
        try {
          await page.waitForSelector('#sidebar, .app-sidebar', { timeout: 15000 });
          return { ok: true, via: 'sidebar_found', url: page.url() };
        } catch {
          return { ok: false, via: 'sidebar_not_found', url: page.url() };
        }
      })(),
      (async () => {
        try {
          await page.waitForFunction(
            () => {
              const userSpan = document.querySelector('.navbar-user .d-md-inline');
              return userSpan && userSpan.innerText.trim().length > 0;
            },
            { timeout: 15000 }
          );
          return { ok: true, via: 'user_in_header', url: page.url() };
        } catch {
          return { ok: false, via: 'user_not_in_header', url: page.url() };
        }
      })(),
    ]);

    if (!loginCheck.ok) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
      const loginErrorInfo = await page.evaluate(() => {
        const body = document.body.innerText;
        const url = window.location.href;
        const alertEl = document.querySelector('.alert, .alert-danger, .error-message, .login-error, [role="alert"]');
        return {
          url,
          alertText: alertEl ? alertEl.innerText.trim() : null,
          bodyPreview: body.substring(0, 1500),
        };
      });
      console.log('[DEBUG_LOGIN_CHECK]', JSON.stringify({
        via: loginCheck.via,
        url: loginCheck.url,
        alertText: loginErrorInfo.alertText,
        bodyContains_naoEPossivel: loginErrorInfo.bodyPreview.includes('Não é possível'),
        bodyContains_credenciaisInvalidas:
          loginErrorInfo.bodyPreview.toLowerCase().includes('credenciais') ||
          loginErrorInfo.bodyPreview.toLowerCase().includes('inválida'),
        bodyPreview_first_500: loginErrorInfo.bodyPreview.substring(0, 500),
      }));
      return {
        data: {
          success: false,
          erro: loginErrorInfo.alertText || 'Login falhou — area logada nao detectada apos submit (possivel bloqueio ou credenciais invalidas)',
          erroTipo: 'LOGIN_FAILED',
          urlFinal: page.url(),
          loginCheckResult: loginCheck,
          alertText: loginErrorInfo.alertText,
          bodyPreview: loginErrorInfo.bodyPreview.substring(0, 800),
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
        preLoginScreenshot,
      };
    }
    trace.push({ step: 'login_success', via: loginCheck.via, url: loginCheck.url, t: Date.now() - t0 });

    await sleep(2000); // dá tempo do portal estabilizar sessão pós-login antes de navegar

    // Navegação para /order-creation: SEMPRE via click no menu, NUNCA via goto direto
    // Razão: portal Sayerlack redireciona goto direto para /login/order-creation (rota de erro)
    trace.push({ step: 'navegacao_via_menu_start', urlAtual: page.url(), t: Date.now() - t0 });

    const urlAposLogin = page.url();
    if (!urlAposLogin.endsWith('/home') && !urlAposLogin.includes('/home')) {
      console.log('[DEBUG_NAV] URL inesperada após login:', urlAposLogin);
    }

    // Garante sidebar expandida (portal tem botão minify que recolhe sidebar por padrão)
    await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.classList.contains('app-sidebar-minified')) {
        const minifyBtn = document.querySelector('.app-sidebar-minify-btn');
        if (minifyBtn) minifyBtn.click();
      }
    });
    await sleep(800);

    // Aguarda sidebar com itens estar disponível (DOM completo, não só aparente)
    await page.waitForFunction(
      () => {
        const sidebarLinks = document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link');
        return sidebarLinks.length > 0;
      },
      { timeout: 15000 }
    ).catch(() => null);

    // Click em "Vendas" para expandir submenu
    const expandiu_vendas = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link'));
      const vendasLink = links.find((l) => (l.innerText || '').trim().includes('Vendas'));
      if (vendasLink) {
        vendasLink.click();
        return { clicked: true, found_links: links.length, vendas_text: (vendasLink.innerText || '').trim().substring(0, 50) };
      }
      return { clicked: false, found_links: links.length, all_texts: links.map((l) => (l.innerText || '').trim().substring(0, 30)).slice(0, 10) };
    });
    console.log('[DEBUG_CLICK_VENDAS]', JSON.stringify(expandiu_vendas));
    trace.push({ step: 'clicked_vendas', expandiu_vendas, t: Date.now() - t0 });
    await page.waitForFunction(function() {
      const links = Array.from(document.querySelectorAll('a'));
      return links.some(function(a) {
        return a.getAttribute('href') === '/order-creation' && a.offsetParent !== null;
      });
    }, { timeout: 3000, polling: 100 });

    // Click em "Pedidos / Propostas" — esse SIM navega corretamente
    const clicou_pedidos = await page.evaluate(() => {
      // Procura especificamente por <a href="/order-creation"> que contenha "Pedidos"
      const allLinks = Array.from(document.querySelectorAll('a'));
      const pedidosLink = allLinks.find((l) =>
        l.getAttribute('href') === '/order-creation' &&
        (l.innerText || '').trim().toLowerCase().includes('pedidos')
      );
      if (pedidosLink) {
        pedidosLink.click();
        return { clicked: true, href: pedidosLink.getAttribute('href'), text: (pedidosLink.innerText || '').trim().substring(0, 50) };
      }
      // Fallback 1: qualquer <a> apontando para /order-creation
      const fallbackLink = allLinks.find((l) => l.getAttribute('href') === '/order-creation');
      if (fallbackLink) {
        fallbackLink.click();
        return { clicked: true, href: '/order-creation', text: (fallbackLink.innerText || '').trim().substring(0, 50), via_fallback: true };
      }
      return {
        clicked: false,
        total_links: allLinks.length,
        links_com_order_creation: allLinks.filter((l) => (l.getAttribute('href') || '').includes('order-creation')).map((l) => ({ href: l.getAttribute('href'), text: (l.innerText || '').trim().substring(0, 50) })),
      };
    });
    console.log('[DEBUG_CLICK_PEDIDOS]', JSON.stringify(clicou_pedidos));
    trace.push({ step: 'clicked_pedidos', clicou_pedidos, t: Date.now() - t0 });

    if (!clicou_pedidos.clicked) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
      return {
        data: {
          success: false,
          erro: 'Não conseguiu clicar em "Pedidos / Propostas" no menu lateral. Sidebar pode não estar carregada ou estrutura mudou.',
          erroTipo: 'NAVIGATION_FAILED',
          urlFinal: page.url(),
          debug_clicou_pedidos: clicou_pedidos,
          debug_expandiu_vendas: expandiu_vendas,
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
        preLoginScreenshot,
      };
    }

    // Aguarda navegação completar (URL muda para /order-creation)
    await page.waitForFunction(
      () => window.location.href.endsWith('/order-creation'),
      { timeout: 15000 }
    ).catch(() => null);
    await sleep(2000); // dá tempo do DOM da página de pedidos estabilizar

    const urlAposClick = page.url();
    console.log('[DEBUG_AFTER_CLICK_PEDIDOS]', JSON.stringify({ url: urlAposClick, chegou_em_order_creation: urlAposClick.endsWith('/order-creation') }));
    trace.push({ step: 'after_click_pedidos', url: urlAposClick, t: Date.now() - t0 });

    await page.waitForSelector('#btnNovoPedido', { timeout: 25000 });
    await page.click('#btnNovoPedido');
    await page.waitForSelector('#select2-cliente-container', { timeout: 10000 });
    trace.push({ step: 'novo_pedido_open', t: Date.now() - t0 });

    await page.click('#select2-cliente-container');
    await sleep(300);
    await page.waitForSelector('.select2-search__field', { timeout: 5000 });
    await fillInput('.select2-search__field', clienteCodigo);
    await sleep(2000);
    const clienteOption = await page.$('.select2-results__option:not(.select2-results__message)');
    if (!clienteOption) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
      return {
        data: {
          success: false,
          erro: 'Cliente ' + clienteCodigo + ' nao encontrado no Select2',
          erroTipo: 'CLIENTE_NOT_FOUND',
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
      };
    }
    await clienteOption.click();
    await sleep(500);
    trace.push({ step: 'cliente_selecionado', t: Date.now() - t0 });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      trace.push({ step: 'item_' + i + '_start', sku: item.sku_portal, t: Date.now() - t0 });

      // Aguardar fim da janela de validação assíncrona da data de entrega.
      // O portal Sayerlack substitui os botões "Incluir Item" por "Validando data de entrega"
      // durante validação backend; precisamos esperar voltar antes do próximo click.
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
      }, { timeout: 15000, polling: 250 });
      // Buffer mínimo pós-validação pra DOM estabilizar
      await sleep(300);
      trace.push({ step: 'validacao_data_entrega_ok_iter_' + i, t: Date.now() - t0 });

      // Tenta o seletor primário primeiro (mesmo do primeiro item, geralmente persiste)
      // Se não achar, tenta fallbacks até funcionar
      const addItemClicado = await page.evaluate(function(idx) {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const visibleBtns = allBtns.filter(function(b) { return b.offsetParent !== null; });
        const debug_btns_visible = visibleBtns
          .map(function(b) { return (b.innerText || '').trim().substring(0, 60); })
          .slice(0, 20);
        // Tentativa 1 (PRIMÁRIA): texto "+ Incluir Item" excluindo "Múltiplos"
        const incluirBtn = visibleBtns.find(function(b) {
          const txt = (b.innerText || '').trim();
          return txt.includes('Incluir Item') && !txt.includes('Múltiplos');
        });
        if (incluirBtn) {
          incluirBtn.click();
          return {
            clicked: true,
            via: 'text_match',
            text: (incluirBtn.innerText || '').trim().substring(0, 30),
            debug_btns_visible: debug_btns_visible
          };
        }
        // Tentativa 2 (#colSpanBtnIncluirItem): APENAS no primeiro item.
        // Para idx > 0 esse seletor é armadilha — pega button visível mas inerte.
        if (idx === 0) {
          const primario = document.querySelector('#colSpanBtnIncluirItem button.btn-primary');
          if (primario && primario.offsetParent !== null) {
            primario.click();
            return {
              clicked: true,
              via: 'colSpanBtnIncluirItem',
              debug_btns_visible: debug_btns_visible
            };
          }
        }
        // Tentativa 3 (tfoot): sempre disponível
        const tfootBtn = document.querySelector('tfoot button.btn-primary');
        if (tfootBtn && tfootBtn.offsetParent !== null) {
          tfootBtn.click();
          return {
            clicked: true,
            via: 'tfoot',
            debug_btns_visible: debug_btns_visible
          };
        }
        return {
          clicked: false,
          debug_btns_visible: debug_btns_visible
        };
      }, i);
      console.log('[DEBUG_INCLUIR_ITEM_CLICK]', JSON.stringify({ iteration: i, ...addItemClicado }));
      trace.push({ step: 'incluir_item_clicked_iter_' + i, addItemClicado, t: Date.now() - t0 });
      if (!addItemClicado.clicked) {
        const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
        return {
          data: {
            success: false,
            erro: 'Nao conseguiu clicar em "+ Incluir Item" para o item ' + i + ' (' + item.sku_portal + '). Botao nao encontrado por nenhum dos 3 seletores.',
            erroTipo: 'INCLUIR_ITEM_NOT_FOUND',
            iteracao: i,
            sku_falho: item.sku_portal,
            debug_addItemClicado: addItemClicado,
            trace,
          },
          type: 'application/json',
          screenshot: errorScreenshot,
          preLoginScreenshot,
        };
      }
      await sleep(500); // dá tempo do botão de incluir abrir o Select2
      // Diagnóstico DOM 1.5s após click do incluir, antes do waitForSelector
      await sleep(2000); // tempo extra pra portal montar a linha nova (aumentado de 1000 pra 2000)
      const debugDomAposIncluir = await page.evaluate(() => {
        const allSelect2Containers = Array.from(document.querySelectorAll('[id^="select2-it_codigo"], [id*="it_codigo"]'));
        const allSelect2Search = Array.from(document.querySelectorAll('.select2-search__field'));
        const datatableRows = document.querySelectorAll('#datatable_itens tbody tr');
        const selectIts = Array.from(document.querySelectorAll('select[id^="it_codigo"], select[id*="it_codigo"]'));
        return {
          rows_count: datatableRows.length,
          select2_containers_it_codigo: allSelect2Containers.map(function(el) {
            return { id: el.id, visible: el.offsetParent !== null, tag: el.tagName };
          }),
          select2_search_fields_count: allSelect2Search.length,
          select_native_it_codigo: selectIts.map(function(el) {
            return { id: el.id, name: el.name || null };
          }),
          has_select2_it_codigo_container_exact: !!document.querySelector('#select2-it_codigo-container'),
        };
      });
      console.log('[DEBUG_DOM_APOS_INCLUIR_2]', JSON.stringify({ iteration: i, ...debugDomAposIncluir }));
      trace.push({ step: 'dom_apos_incluir_iter_' + i, debugDomAposIncluir, t: Date.now() - t0 });
      // AGORA o waitForSelector original, mas com fallback inteligente
      let select2ContainerSel = '#select2-it_codigo-container';
      if (!debugDomAposIncluir.has_select2_it_codigo_container_exact && debugDomAposIncluir.select2_containers_it_codigo.length > 0) {
        const visibleContainer = debugDomAposIncluir.select2_containers_it_codigo.find(function(c) { return c.visible; });
        if (visibleContainer) {
          select2ContainerSel = '#' + visibleContainer.id;
          console.log('[DEBUG_SELECT2_FALLBACK]', 'Usando ID alternativo: ' + select2ContainerSel);
          trace.push({ step: 'select2_fallback_iter_' + i, sel: select2ContainerSel, t: Date.now() - t0 });
        }
      }
      await page.waitForSelector(select2ContainerSel, { timeout: 12000 });
      const debugPosIncluir = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('#panel_novo_pedido button.btn-primary, #colSpanBtnIncluirItem button.btn-primary, tfoot button.btn-primary'));
        return {
          select2_sku_visible: !!document.querySelector('#select2-it_codigo-container'),
          select2_search_field_visible: !!document.querySelector('.select2-search__field'),
          btn_primary_count: allBtns.length,
          btn_primary_texts: allBtns.map((b) => (b.innerText || '').trim().substring(0, 30)),
        };
      });
      console.log('[DEBUG_POS_INCLUIR_ITEM]', JSON.stringify({ iteration: i, ...debugPosIncluir }));
      await page.click(select2ContainerSel);
      await sleep(300);
      await page.waitForSelector('.select2-search__field', { timeout: 5000 });
      await fillInput('.select2-search__field', item.sku_portal);
      await sleep(2000);
      const skuOption = await page.$('.select2-results__option:not(.select2-results__message)');
      if (!skuOption) {
        const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
        return {
          data: {
            success: false,
            erro: 'SKU ' + item.sku_portal + ' (' + item.sku_descricao + ') nao encontrado no portal',
            erroTipo: 'SKU_NOT_FOUND',
            skuFalho: item.sku_portal,
            trace,
          },
          type: 'application/json',
          screenshot: errorScreenshot,
        };
      }
      await skuOption.click();
      await sleep(800);
      const qtdInputSel = '#datatable_itens tbody tr:nth-last-child(1) td:nth-of-type(7) input';
      await fillInput(qtdInputSel, String(item.qtde));

      // Diagnóstico: confirmar identidade do botão de gravar item
      const debugGravarItem = await page.evaluate(function() {
        const btn = document.querySelector('#btnGravarItem');
        if (!btn) return { found: false };
        return {
          found: true,
          visible: btn.offsetParent !== null,
          text: (btn.innerText || '').trim().substring(0, 40),
          title: btn.getAttribute('title') || '',
          classes: btn.className.substring(0, 80),
          tagName: btn.tagName,
          parentTag: btn.parentElement ? btn.parentElement.tagName : null,
          parentClass: btn.parentElement ? btn.parentElement.className.substring(0, 60) : null,
          candidatos_gravar: Array.from(document.querySelectorAll('button, a[role="button"], i.fa-save, span.fa-save'))
            .filter(function(el) { return el.offsetParent !== null; })
            .map(function(el) {
              return {
                tag: el.tagName,
                id: el.id || '',
                text: (el.innerText || '').trim().substring(0, 30),
                title: el.getAttribute('title') || '',
                classes: el.className.substring(0, 60)
              };
            })
            .filter(function(info) {
              const blob = (info.text + ' ' + info.title + ' ' + info.classes).toLowerCase();
              return blob.includes('grav') || blob.includes('salv') || blob.includes('save') || blob.includes('disco') || blob.includes('disquete') || info.id.toLowerCase().includes('grav');
            })
            .slice(0, 10)
        };
      });
      trace.push({ step: 'debug_btn_gravar_iter_' + i, t: Date.now() - t0, debugGravarItem: debugGravarItem });
      console.log('[DEBUG_BTN_GRAVAR]', JSON.stringify({ iteration: i, ...debugGravarItem }));

      await page.click('#btnGravarItem');
      // Aguarda a linha aparecer/atualizar no datatable
      await page.waitForFunction(
        (esperado) => {
          const rows = document.querySelectorAll('#datatable_itens tbody tr');
          return rows.length === esperado;
        },
        { timeout: 5000 },
        i + 1
      ).catch(() => null);
      await sleep(400); // buffer pos-render
      trace.push({ step: 'item_' + i + '_saved', t: Date.now() - t0 });
    }

    await page.click('#btnSalvarNovoPedido');
    trace.push({ step: 'efetivar_clicked', t: Date.now() - t0 });

    // Aguarda o texto de sucesso aparecer (Puppeteer suporta waitForFunction sem jsonValue)
    await page.waitForFunction(
      () => {
        const body = document.body.innerText;
        return /Pedido \\d+ criado com sucesso/.test(body);
      },
      { timeout: 45000 }
    );
    // Extrai o texto via evaluate puro
    const successStr = await page.evaluate(() => {
      const body = document.body.innerText;
      const match = body.match(/Pedido (\\d+) criado com sucesso/);
      return match ? match[0] : null;
    });
    const protocoloMatch = successStr ? successStr.match(/Pedido (\\d+) criado com sucesso/) : null;
    const protocolo = protocoloMatch ? protocoloMatch[1] : null;
    trace.push({ step: 'success_detected', protocolo, t: Date.now() - t0 });

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, encoding: 'base64' });
    return {
      data: {
        success: true,
        protocolo,
        successText: successStr,
        durationMs: Date.now() - t0,
        trace,
      },
      type: 'application/json',
      screenshot,
    };
  } catch (err) {
    const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
    return {
      data: {
        success: false,
        erro: (err && err.message) ? err.message : String(err),
        erroTipo: 'EXCEPTION',
        trace,
      },
      type: 'application/json',
      screenshot: errorScreenshot,
    };
  }
};
`;

interface PedidoCandidato {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  status_envio_portal: string | null;
  portal_tentativas: number | null;
  portal_protocolo: string | null;
}

interface ItemMapeado {
  item_id: number;
  sku_codigo_omie: string;
  sku_descricao: string;
  qtde_final: number;
  sku_portal: string | null;
  unidade_portal: string | null;
  fator_conversao: number;
  mapeamento_ativo: boolean | null;
}

interface ProcessResult {
  pedido_id: number;
  status_inicial: string;
  status_final: string;
  protocolo: string | null;
  tentativas: number;
  erro: string | null;
  screenshot_url: string | null;
  duracao_ms: number;
}

async function uploadScreenshot(
  supabase: ReturnType<typeof createClient>,
  pedidoId: number,
  base64: string,
  suffix: string = "",
): Promise<string | null> {
  try {
    // Browserless v2 as vezes retorna data URL ("data:image/png;base64,XXXX") em vez de base64 puro.
    // atob() falha com prefixo, entao removemos defensivamente.
    let cleaned = base64;
    if (cleaned && cleaned.startsWith("data:")) {
      const commaIdx = cleaned.indexOf(",");
      if (commaIdx !== -1) cleaned = cleaned.substring(commaIdx + 1);
    }
    console.log("[DEBUG_SCREENSHOT_PREFIX]", JSON.stringify({
      pedido_id: pedidoId,
      has_data_prefix: base64?.startsWith("data:") ?? false,
      base64_length: cleaned?.length ?? 0,
      base64_first_20: cleaned?.substring(0, 20) ?? null,
    }));
    const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    const path = `pedido_${pedidoId}_${Date.now()}${suffix}.png`;
    const { error: upErr } = await supabase.storage
      .from("portal_screenshots")
      .upload(path, bytes, { contentType: "image/png", upsert: false });
    if (upErr) {
      console.error(`[envio-portal] Erro upload screenshot pedido ${pedidoId}:`, upErr.message);
      return null;
    }
    // Bucket é privado: gera signed URL com 30 dias
    const { data: signed } = await supabase.storage
      .from("portal_screenshots")
      .createSignedUrl(path, 60 * 60 * 24 * 30);
    return signed?.signedUrl ?? path;
  } catch (e) {
    console.error(`[envio-portal] Excecao upload screenshot pedido ${pedidoId}:`, e);
    return null;
  }
}

async function processarPedido(
  supabase: ReturnType<typeof createClient>,
  pedido: PedidoCandidato,
): Promise<ProcessResult> {
  const t0 = Date.now();
  const result: ProcessResult = {
    pedido_id: pedido.id,
    status_inicial: pedido.status_envio_portal ?? "pendente_envio_portal",
    status_final: "",
    protocolo: null,
    tentativas: (pedido.portal_tentativas ?? 0),
    erro: null,
    screenshot_url: null,
    duracao_ms: 0,
  };

  // Idempotencia
  if (
    pedido.portal_protocolo &&
    pedido.status_envio_portal === "enviado_portal"
  ) {
    console.log(`[envio-portal] Pedido #${pedido.id}: ja enviado (protocolo=${pedido.portal_protocolo}), pulando`);
    result.status_final = "enviado_portal";
    result.protocolo = pedido.portal_protocolo;
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  // 1. Buscar itens com mapeamento
  console.log("[DEBUG_RPC] tentando RPC envio_portal_itens_mapeados, pedido_id=", pedido.id);
  const { data: itens, error: itensErr } = await supabase.rpc("envio_portal_itens_mapeados", {
    p_pedido_id: pedido.id,
  }).select("*") as unknown as { data: ItemMapeado[] | null; error: any };

  let itensList: ItemMapeado[] | null = itens;
  console.log("[DEBUG_RPC_RESULT]", JSON.stringify({
    pedido_id: pedido.id,
    itensErr: itensErr ? { message: itensErr.message, code: itensErr.code, details: itensErr.details } : null,
    itensList_isNull: itensList === null,
    itensList_isArray: Array.isArray(itensList),
    itensList_length: Array.isArray(itensList) ? itensList.length : 'N/A',
  }));
  // Fallback: query direta caso RPC nao exista
  if (itensErr || !itensList) {
    const { data: itensDirect, error: e2 } = await supabase
      .from("pedido_compra_item")
      .select(`
        id,
        sku_codigo_omie,
        sku_descricao,
        qtde_final
      `)
      .eq("pedido_id", pedido.id)
      .order("id", { ascending: true });
    if (e2 || !itensDirect) {
      result.status_final = "falha_envio_portal";
      result.erro = `Erro ao buscar itens: ${e2?.message ?? "desconhecido"}`;
      result.tentativas += 1;
      await supabase.from("pedido_compra_sugerido").update({
        status_envio_portal: "falha_envio_portal",
        portal_tentativas: result.tentativas,
        portal_erro: result.erro,
        portal_proximo_retry_em: null,
      }).eq("id", pedido.id);
      result.duracao_ms = Date.now() - t0;
      return result;
    }
    const skus = itensDirect.map((i: any) => i.sku_codigo_omie);
    console.log("[DEBUG_FALLBACK_ITENS]", JSON.stringify({
      pedido_id: pedido.id,
      pedido_empresa: pedido.empresa,
      itensDirect_count: itensDirect?.length ?? 0,
      skus_extraidos: skus,
    }));
    const { data: maps, error: mapsErr } = await supabase
      .from("sku_fornecedor_externo")
      .select("sku_omie, sku_portal, unidade_portal, fator_conversao, ativo")
      .eq("empresa", pedido.empresa)
      .ilike("fornecedor_nome", "%SAYERLACK%")
      .in("sku_omie", skus);
    console.log("[DEBUG_FALLBACK_MAPS]", JSON.stringify({
      pedido_id: pedido.id,
      filtro_empresa: pedido.empresa,
      filtro_fornecedor_pattern: '%SAYERLACK%',
      filtro_skus: skus,
      maps_count: maps?.length ?? 0,
      maps_amostra: (maps ?? []).slice(0, 3).map((m: any) => ({ sku_omie: m.sku_omie, sku_portal: m.sku_portal, ativo: m.ativo })),
      mapsErr: mapsErr ? { message: mapsErr.message, code: mapsErr.code } : null,
    }));
    const mapByOmie = new Map<string, any>();
    (maps ?? []).forEach((m: any) => mapByOmie.set(m.sku_omie, m));
    itensList = itensDirect.map((i: any) => {
      const m = mapByOmie.get(i.sku_codigo_omie);
      return {
        item_id: i.id,
        sku_codigo_omie: i.sku_codigo_omie,
        sku_descricao: i.sku_descricao,
        qtde_final: Number(i.qtde_final),
        sku_portal: m?.sku_portal ?? null,
        unidade_portal: m?.unidade_portal ?? null,
        fator_conversao: Number(m?.fator_conversao ?? 1),
        mapeamento_ativo: m?.ativo ?? null,
      };
    });
  }

  if (!itensList || itensList.length === 0) {
    result.status_final = "falha_envio_portal";
    result.erro = "Pedido sem itens";
    result.tentativas += 1;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "falha_envio_portal",
      portal_tentativas: result.tentativas,
      portal_erro: result.erro,
      portal_proximo_retry_em: null,
    }).eq("id", pedido.id);
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  console.log("[DEBUG_PRE_VALIDATION]", JSON.stringify({
    pedido_id: pedido.id,
    itensList_final: itensList.map((i) => ({
      sku_codigo_omie: i.sku_codigo_omie,
      sku_portal: i.sku_portal,
      mapeamento_ativo: i.mapeamento_ativo,
      qtde_final: i.qtde_final,
    })),
  }));

  // 2. Validar SKUs

  const semMap = itensList.filter(
    (i) => !i.sku_portal || i.mapeamento_ativo === false,
  );
  if (semMap.length > 0) {
    const lista = semMap.map((i) => `${i.sku_codigo_omie} (${i.sku_descricao})`).join("; ");
    result.status_final = "falha_envio_portal";
    result.erro = `SKUs sem mapeamento ativo: ${lista}`;
    result.tentativas += 1;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "falha_envio_portal",
      portal_tentativas: result.tentativas,
      portal_erro: result.erro,
      portal_proximo_retry_em: null,
    }).eq("id", pedido.id);
    console.log(`[envio-portal] Pedido #${pedido.id}: falha SKUs sem mapeamento`);
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  // 3. Calcular qtde portal
  const itemsPortal = itensList.map((i) => ({
    sku_portal: i.sku_portal!,
    qtde: Math.max(1, Math.round(i.qtde_final * i.fator_conversao)),
    sku_descricao: i.sku_descricao,
  }));

  // 4. Marcar como enviando
  await supabase.from("pedido_compra_sugerido").update({
    status_envio_portal: "enviando_portal",
  }).eq("id", pedido.id);
  console.log(`[envio-portal] Pedido #${pedido.id}: ${result.status_inicial} -> enviando_portal (locked)`);
  console.log(`[envio-portal] Pedido #${pedido.id}: chamando Browserless... (${itemsPortal.length} SKUs)`);

  // 5. Invocar Browserless
  const tBrowserless = Date.now();
  let httpStatus = 0;
  let bResp: any = null;
  let httpErr: string | null = null;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 120000);
    const resp = await fetch(
      `https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=60000`,
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
            items: itemsPortal,
          },
        }),
      },
    );
    clearTimeout(timeout);
    httpStatus = resp.status;
    const txt = await resp.text();
    try {
      bResp = JSON.parse(txt);
    } catch {
      bResp = { raw: txt };
    }
  } catch (e: any) {
    httpErr = e?.message ?? String(e);
  }
  const browserlessMs = Date.now() - tBrowserless;
  console.log(`[envio-portal] Pedido #${pedido.id}: Browserless retornou em ${browserlessMs}ms — status=${httpStatus}`);

  // 6. Tratar respostas HTTP
  if (httpStatus === 401 || httpStatus === 403) {
    // Token invalido — nao atualiza pedido, lanca pra fora
    console.error(`[envio-portal] BROWSERLESS_TOKEN invalido (HTTP ${httpStatus})`);
    // reverte estado
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "pendente_envio_portal",
    }).eq("id", pedido.id);
    throw new Error(`BROWSERLESS_TOKEN invalido: HTTP ${httpStatus}`);
  }

  const tempFail =
    httpErr !== null ||
    httpStatus === 408 ||
    httpStatus === 0 ||
    (httpStatus >= 500 && httpStatus < 600);

  // Extrair payload
  const data = bResp?.data ?? bResp ?? {};
  const screenshotB64: string | null = bResp?.screenshot ?? null;
  const preLoginScreenshotB64: string | null = bResp?.preLoginScreenshot ?? null;

  // 8. Upload screenshot se houver
  if (screenshotB64) {
    result.screenshot_url = await uploadScreenshot(supabase, pedido.id, screenshotB64);
    if (result.screenshot_url) {
      console.log(`[envio-portal] Pedido #${pedido.id}: screenshot uploaded`);
    }
  }

  // 8b. Upload pre-login screenshot (instrumentação para debug LOGIN_FAILED)
  if (preLoginScreenshotB64) {
    const preUrl = await uploadScreenshot(
      supabase,
      pedido.id,
      preLoginScreenshotB64,
      "_pre_login",
    );
    if (preUrl) {
      console.log(`[envio-portal] Pedido #${pedido.id}: pre_login_screenshot uploaded`);
      (data as Record<string, unknown>).preLoginScreenshotUrl = preUrl;
    }
  }

  const novasTentativas = result.tentativas + 1;
  result.tentativas = novasTentativas;

  if (tempFail) {
    // Falha temporaria
    const erroMsg = httpErr ?? `HTTP ${httpStatus} do Browserless`;
    const definitiva = novasTentativas >= MAX_TENTATIVAS;
    result.status_final = definitiva ? "falha_envio_portal" : "pendente_envio_portal";
    result.erro = erroMsg;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: result.status_final,
      portal_screenshot_url: result.screenshot_url,
      portal_tentativas: novasTentativas,
      portal_erro: erroMsg,
      portal_resposta: data ?? null,
      portal_proximo_retry_em: definitiva ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }).eq("id", pedido.id);
    console.log(`[envio-portal] Pedido #${pedido.id}: enviando_portal -> ${result.status_final} (temp fail)`);
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  if (data?.success === true) {
    // SUCESSO
    result.status_final = "enviado_portal";
    result.protocolo = data.protocolo ?? null;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "enviado_portal",
      portal_protocolo: result.protocolo,
      portal_screenshot_url: result.screenshot_url,
      enviado_portal_em: new Date().toISOString(),
      portal_tentativas: novasTentativas,
      portal_erro: null,
      portal_resposta: data,
      portal_proximo_retry_em: null,
    }).eq("id", pedido.id);
    console.log(`[envio-portal] Pedido #${pedido.id}: enviando_portal -> enviado_portal OK (protocolo=${result.protocolo})`);
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  // Falha do automador
  const erroTipo: string = data?.erroTipo ?? "UNKNOWN";
  const erroMsg: string = data?.erro ?? "Falha desconhecida do automador";
  const definitiva =
    erroTipo === "LOGIN_FAILED" ||
    erroTipo === "CLIENTE_NOT_FOUND" ||
    erroTipo === "SKU_NOT_FOUND" ||
    novasTentativas >= MAX_TENTATIVAS;

  result.status_final = definitiva ? "falha_envio_portal" : "pendente_envio_portal";
  result.erro = erroMsg;

  await supabase.from("pedido_compra_sugerido").update({
    status_envio_portal: result.status_final,
    portal_screenshot_url: result.screenshot_url,
    portal_tentativas: novasTentativas,
    portal_erro: erroMsg,
    portal_resposta: data,
    portal_proximo_retry_em: definitiva ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }).eq("id", pedido.id);

  if (erroTipo === "LOGIN_FAILED") {
    await supabase.from("fornecedor_alerta").insert({
      empresa: "OBEN",
      fornecedor_nome: "RENNER SAYERLACK S/A",
      tipo: "outro",
      severidade: "urgente",
      titulo: "Senha do portal Sayerlack expirou",
      mensagem:
        `Login falhou no portal ${SAYERLACK_PORTAL_URL}. Provavel expiracao de senha. ` +
        `ACAO: 1) Trocar senha no portal Sayerlack, 2) Atualizar SAYERLACK_PORTAL_PASS no Supabase Edge Functions Secrets, ` +
        `3) Em /admin/reposicao/pedidos, clicar em "Forcar reenvio ao portal" no pedido afetado.`,
      status: "pendente_notificacao",
      metadata: { pedido_id: pedido.id, edge_function: "enviar-pedido-portal-sayerlack" },
    });
  }

  console.log(`[envio-portal] Pedido #${pedido.id}: enviando_portal -> ${result.status_final} (${erroTipo})`);
  result.duracao_ms = Date.now() - t0;
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const tStart = Date.now();
  console.log("[envio-portal] === Iniciando ===");

  let body: any = {};
  try {
    if (req.method === "POST") {
      const txt = await req.text();
      body = txt ? JSON.parse(txt) : {};
    }
  } catch {
    body = {};
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // === MODO ECO ===
  if (body?.test_eco === true) {
    const secretsOk = !!(
      SAYERLACK_PORTAL_USER &&
      SAYERLACK_PORTAL_PASS &&
      SAYERLACK_PORTAL_URL &&
      SAYERLACK_PORTAL_CLIENTE_CODIGO &&
      BROWSERLESS_TOKEN
    );
    const { count } = await supabase
      .from("pedido_compra_sugerido")
      .select("id", { count: "exact", head: true })
      .eq("status", "disparado")
      .eq("status_envio_portal", "pendente_envio_portal")
      .lt("portal_tentativas", MAX_TENTATIVAS)
      .ilike("fornecedor_nome", "%SAYERLACK%")
      .eq("empresa", "OBEN");
    console.log(`[envio-portal] ECO secrets_ok=${secretsOk} candidatos=${count ?? 0}`);
    return new Response(
      JSON.stringify({
        modo: "eco",
        secrets_ok: secretsOk,
        candidatos_encontrados: count ?? 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  }

  // Validar token
  if (!BROWSERLESS_TOKEN) {
    console.error("[envio-portal] BROWSERLESS_TOKEN nao configurado");
    return new Response(
      JSON.stringify({ error: "BROWSERLESS_TOKEN nao configurado" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
  if (!SAYERLACK_PORTAL_USER || !SAYERLACK_PORTAL_PASS || !SAYERLACK_PORTAL_URL || !SAYERLACK_PORTAL_CLIENTE_CODIGO) {
    return new Response(
      JSON.stringify({ error: "Secrets do portal Sayerlack incompletos" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }

  const modo: "lote" | "individual" = body?.pedido_id ? "individual" : "lote";
  let candidatos: PedidoCandidato[] = [];

  if (modo === "individual") {
    const pid = Number(body.pedido_id);
    if (!Number.isInteger(pid) || pid <= 0) {
      return new Response(
        JSON.stringify({ error: "pedido_id invalido" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }
    const { data, error } = await supabase
      .from("pedido_compra_sugerido")
      .select("id, empresa, fornecedor_nome, status_envio_portal, portal_tentativas, portal_protocolo")
      .eq("id", pid)
      .maybeSingle();
    if (error || !data) {
      return new Response(
        JSON.stringify({ error: `Pedido ${pid} nao encontrado` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 },
      );
    }
    candidatos = [data as PedidoCandidato];
  } else {
    // LOTE — usa RPC com FOR UPDATE SKIP LOCKED
    const { data, error } = await supabase.rpc("envio_portal_lock_candidatos", {
      p_max: MAX_PEDIDOS_POR_EXECUCAO,
    });
    if (error) {
      console.error("[envio-portal] Erro buscando candidatos:", error.message);
      // Fallback sem lock
      const { data: fb } = await supabase
        .from("pedido_compra_sugerido")
        .select("id, empresa, fornecedor_nome, status_envio_portal, portal_tentativas, portal_protocolo")
        .eq("status", "disparado")
        .eq("status_envio_portal", "pendente_envio_portal")
        .lt("portal_tentativas", MAX_TENTATIVAS)
        .ilike("fornecedor_nome", "%SAYERLACK%")
        .eq("empresa", "OBEN")
        .or("portal_proximo_retry_em.is.null,portal_proximo_retry_em.lte." + new Date().toISOString())
        .order("aprovado_em", { ascending: true })
        .limit(MAX_PEDIDOS_POR_EXECUCAO);
      candidatos = (fb ?? []) as PedidoCandidato[];
    } else {
      candidatos = (data ?? []) as PedidoCandidato[];
    }
  }

  console.log(`[envio-portal] Modo: ${modo}, candidatos: ${candidatos.length}`);

  if (candidatos.length === 0) {
    console.log("[envio-portal] Nenhum pedido pendente");
    return new Response(
      JSON.stringify({
        modo,
        candidatos_encontrados: 0,
        processados: 0,
        sucesso: 0,
        falhas_definitivas: 0,
        falhas_temporarias: 0,
        duracao_total_ms: Date.now() - tStart,
        detalhes: [],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  }

  const detalhes: ProcessResult[] = [];
  let sucesso = 0;
  let falhasDef = 0;
  let falhasTmp = 0;

  for (const p of candidatos) {
    try {
      const r = await processarPedido(supabase, p);
      detalhes.push(r);
      if (r.status_final === "enviado_portal") sucesso++;
      else if (r.status_final === "falha_envio_portal") falhasDef++;
      else if (r.status_final === "pendente_envio_portal") falhasTmp++;
    } catch (e: any) {
      console.error(`[envio-portal] Excecao no pedido #${p.id}:`, e?.message ?? e);
      detalhes.push({
        pedido_id: p.id,
        status_inicial: p.status_envio_portal ?? "pendente_envio_portal",
        status_final: "erro_excecao",
        protocolo: null,
        tentativas: p.portal_tentativas ?? 0,
        erro: e?.message ?? String(e),
        screenshot_url: null,
        duracao_ms: 0,
      });
      // Se for token invalido, abortar lote
      if (String(e?.message ?? "").includes("BROWSERLESS_TOKEN invalido")) {
        return new Response(
          JSON.stringify({ error: e.message, detalhes }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
        );
      }
    }
  }

  const duracao = Date.now() - tStart;
  console.log(`[envio-portal] === Sumario === processados=${detalhes.length} sucesso=${sucesso} falhas=${falhasDef + falhasTmp} duracao_total=${duracao}ms`);

  return new Response(
    JSON.stringify({
      modo,
      candidatos_encontrados: candidatos.length,
      processados: detalhes.length,
      sucesso,
      falhas_definitivas: falhasDef,
      falhas_temporarias: falhasTmp,
      duracao_total_ms: duracao,
      detalhes,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
