// Edge Function: enviar-pedido-portal-sayerlack
// Automatiza envio de pedidos aprovados (OBEN -> Sayerlack) via Browserless.io
// Modos: ECO (validacao), lote (cron), individual (manual)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";

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
  // Não usamos timeout interno menor que o Browserless: em 14/05, o pedido #116
  // clicou em "Efetivar Pedido" por volta de 53s e a Promise.race anterior
  // devolveu TIMEOUT_INTERNO aos 55s, encerrando o browser antes do portal concluir.

  // preLoginScreenshot é referenciado em returns de erro; declarado aqui para
  // nunca lançar ReferenceError (que mascararia o envelope estruturado).
  let preLoginScreenshot = null;

  // === PR2: Budget management (deadline global) ===
  // O Browserless mata a função em ~60s. Em vez de esperar isso acontecer com
  // um waitFor pendurado (cenário do bug original — "Waiting failed: 7000ms"
  // mascarando o teto externo), morremos controlado dentro de 58s e devolvemos
  // envelope estruturado. Todos os timeouts do script passam por budgetFor.
  // PR9: upgrade do Browserless Free (60s) -> Prototyping (15min). Subimos o
  // deadline interno para 280s (4min40s) — cabe pedido de 30+ SKUs em uma única
  // sessão. Mantém 20s de margem antes do timeout HTTP de 300s na URL.
  const HARD_CEILING_MS = 280_000;
  const RETURN_GUARD_MS = 2_000;    // tempo para Browserless serializar o JSON
  const SUBMIT_RESERVED_MS = 8_000; // reservado para o click + sinal pós-submit
  const ITEM_MIN_BUDGET_MS = 3_000; // tempo mínimo viável por item do loop
  const deadline = t0 + HARD_CEILING_MS;

  const remainingMs = () => Math.max(0, deadline - Date.now());

  // budgetFor: calcula min(idealMs, restante - reserva); lança BUDGET_EXHAUSTED
  // se o resultado for menor que minMs. NUNCA retorna fallback silencioso —
  // preferimos abortar limpo a deixar um waitFor pendurado quando o teto chega.
  const budgetFor = (label, idealMs, opts) => {
    const reserveSubmit = !(opts && opts.reserveSubmit === false);
    const minMs = (opts && typeof opts.minMs === 'number') ? opts.minMs : 500;
    const reserved = (reserveSubmit ? SUBMIT_RESERVED_MS : 0) + RETURN_GUARD_MS;
    const budget = Math.max(0, remainingMs() - reserved);
    const allowed = Math.min(idealMs, budget);
    if (allowed < minMs) {
      const err = new Error(
        'BUDGET_EXHAUSTED em "' + label + '": precisava de >=' + minMs +
        'ms mas só restam ' + allowed + 'ms (deadline em ' + remainingMs() + 'ms)'
      );
      err.code = 'BUDGET_EXHAUSTED';
      err.label = label;
      throw err;
    }
    return allowed;
  };

  // Verificação antes de cada item: se o restante não comporta os itens que
  // faltam + reserva de submit + return guard, aborta agora. Evita o pior
  // cenário (montar 80% do pedido, chegar no submit com budget zero e gerar
  // indeterminado por timeout do banner).
  const assertEnoughTimeForRemainingItems = (currentIndex, totalItems) => {
    const remainingItems = Math.max(0, totalItems - currentIndex);
    const need = remainingItems * ITEM_MIN_BUDGET_MS + SUBMIT_RESERVED_MS + RETURN_GUARD_MS;
    const rem = remainingMs();
    if (rem < need) {
      const err = new Error(
        'BUDGET_EXHAUSTED: faltam ' + need + 'ms para completar ' + remainingItems +
        ' itens + submit, mas só restam ' + rem + 'ms (item ' + currentIndex +
        ' de ' + totalItems + ')'
      );
      err.code = 'BUDGET_EXHAUSTED';
      err.label = 'remaining-items-' + currentIndex + '-of-' + totalItems;
      throw err;
    }
  };

  // === PR1: Network Recorder ===
  // Listener global armado ANTES de qualquer navegação. Captura todo POST que
  // bate em endpoints suspeitos de efetivação. É a fonte primária de evidência
  // para classificação: se um POST saiu, o pedido NUNCA é tratado como
  // retentável — vai para conciliação.
  const installOrderNetworkRecorder = (pg) => {
    const SUSPECT_RE = /pedido|efetivar|salvar|criar|order|novo[-_]?pedido/i;
    const events = [];
    let requestSent = false;
    pg.on('request', (req) => {
      try {
        const method = req.method();
        const url = req.url();
        if (method === 'POST' && SUSPECT_RE.test(url)) {
          requestSent = true;
          let postDataPreview = null;
          try { postDataPreview = String(req.postData() || '').slice(0, 500); } catch (e) {}
          events.push({ phase: 'request', method, url, postDataPreview, t: Date.now() - t0 });
        }
      } catch (e) {}
    });
    pg.on('response', (resp) => {
      try {
        const req = resp.request();
        const method = req.method();
        const url = resp.url();
        if (method === 'POST' && SUSPECT_RE.test(url)) {
          const entry = {
            phase: 'response',
            method,
            url,
            status: resp.status(),
            contentType: (resp.headers() || {})['content-type'] || null,
            bodyPreview: null,
            t: Date.now() - t0,
          };
          events.push(entry);
          // Enriquecimento assíncrono do corpo — best-effort. Pode não resolver
          // antes da classificação; PR3 trata isso com microjanela dedicada.
          resp.text()
            .then((txt) => { entry.bodyPreview = String(txt || '').slice(0, 1000); })
            .catch((e) => { entry.bodyPreview = '<<sem-corpo:' + String((e && e.message) || '').slice(0, 60) + '>>'; });
        }
      } catch (e) {}
    });
    return {
      getSubmitEvidence: () => {
        const requests = events.filter((e) => e.phase === 'request');
        const responses = events.filter((e) => e.phase === 'response');
        const okResponse = responses.find((r) => r.status >= 200 && r.status < 300) || null;
        return {
          requestSent,
          requestCount: requests.length,
          responseCount: responses.length,
          okResponse: okResponse ? { url: okResponse.url, status: okResponse.status, contentType: okResponse.contentType } : null,
          events,
        };
      },
    };
  };

  // === PR1.5: Extração automática de protocolo do corpo da resposta ===
  // Quando o script morre por timeout (60s do Browserless) mas o portal já
  // respondeu OK ao POST, o recorder captura o corpo da resposta. Se der pra
  // extrair o número do protocolo, recuperamos o pedido como sucesso_portal
  // automaticamente — sem precisar de conciliação manual.
  // Conservador por design: só extrai com padrões específicos (JSON com chave
  // conhecida ou texto "Pedido NNN criado"). Falso positivo geraria pedido
  // duplicado no Omie, então preferimos errar pra "indeterminado".
  // Chaves conhecidas para extração de protocolo. Lista ordenada por
  // confiabilidade (mais específicas e reais do Sayerlack primeiro).
  // Capturado via DevTools real do portal Sayerlack (15/05/2026):
  //   POST /order-creation/form/add → 200 JSON com nr_pedido (number),
  //   nr_pedido_cliente (string), data.ordernum (number), data.ordercust (string).
  const PROTOCOLO_KEYS_SAYERLACK = ['nr_pedido', 'nr_pedido_cliente', 'ordernum', 'ordercust'];
  // Padrões genéricos para outros portais (mantidos pra futuro/defesa).
  const PROTOCOLO_KEYS_GENERICOS = ['nNumPed', 'numero_pedido', 'numeroPedido', 'protocolo', 'cNumPed', 'numero', 'pedido', 'idPedido', 'id_pedido', 'codigoPedido', 'codigo_pedido'];

  const tryExtractProtocoloFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    // Gate de sucesso: se o JSON tem success: false explicitamente, NÃO extrai —
    // a resposta indica falha mesmo que contenha um número.
    if (obj.success === false) return null;
    const KEYS = PROTOCOLO_KEYS_SAYERLACK.concat(PROTOCOLO_KEYS_GENERICOS);
    const isProtocolo = (v) => v != null && /^\\d{3,12}$/.test(String(v).trim());
    const checkObj = (o) => {
      for (const k of KEYS) {
        if (o && Object.prototype.hasOwnProperty.call(o, k) && isProtocolo(o[k])) return String(o[k]).trim();
      }
      return null;
    };
    const top = checkObj(obj);
    if (top) return top;
    // 1 nível aninhado (resposta normalmente vem como { data: {...} } / { result: {...} }).
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const nested = checkObj(v);
        if (nested) return nested;
      }
    }
    return null;
  };

  const tryExtractProtocolo = (body) => {
    if (typeof body !== 'string' || !body) return null;
    // 1. JSON estruturado (caminho principal do Sayerlack).
    try {
      const obj = JSON.parse(body);
      const fromJson = tryExtractProtocoloFromObject(obj);
      if (fromJson) return fromJson;
    } catch (e) { /* não é JSON, segue pro fallback de texto */ }
    // 2. Regex textual conservadora (HTML / texto puro / JSON mal formado).
    const PATTERNS = [
      /Pedido\\s+(\\d{3,12})\\s+(?:criado|cadastrado|salvo|registrado)/i,
      /"(?:nr_pedido|nr_pedido_cliente|ordernum|ordercust|nNumPed|numero_pedido|numeroPedido|protocolo|cNumPed|codigoPedido)"\\s*:\\s*"?(\\d{3,12})"?/i,
    ];
    for (const re of PATTERNS) {
      const m = body.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  };

  const extractProtocoloFromEvidence = (evidence) => {
    if (!evidence || !Array.isArray(evidence.events)) return null;
    // Procura primeiro nas respostas OK; se nada bater, tenta qualquer resposta
    // com body capturado (defensivo — alguns portais retornam 200 com erro embutido).
    const okResponses = evidence.events.filter((e) =>
      e.phase === 'response' && typeof e.status === 'number' && e.status >= 200 && e.status < 300
    );
    for (const ev of okResponses) {
      const p = tryExtractProtocolo(ev.bodyPreview);
      if (p) return { protocolo: p, source: 'response_ok', url: ev.url, status: ev.status };
    }
    return null;
  };

  // === PR3: Wait composto pós-submit ===
  // Promise.any de 4 sinais positivos. Vence o primeiro que cumprir; rejeições
  // individuais são ignoradas (até todos rejeitarem). É a substituição do
  // waitForFunction de banner único, frágil. Os 4 sinais são complementares:
  //  - network:  POST de efetivação capturado (evidência primária + body).
  //  - banner:   "Pedido NNN criado com sucesso" no DOM (fonte clássica).
  //  - modal:    modal de sucesso (Bootstrap, SweetAlert, toast).
  //  - url:      URL muda para /pedidos (navegação pós-submit comum).
  const SUBMIT_SUSPECT_RE = /pedido|efetivar|salvar|criar|order|novo[-_]?pedido/i;
  const waitForPositiveSubmitSignal = (pg, timeoutMs) => {
    const networkSignal = pg.waitForResponse(
      (r) => {
        try {
          return r.request().method() === 'POST' && SUBMIT_SUSPECT_RE.test(r.url());
        } catch (e) { return false; }
      },
      { timeout: timeoutMs }
    ).then((resp) => ({ kind: 'network', response: resp }));
    const bannerSignal = pg.waitForFunction(
      () => /Pedido\\s+\\d+\\s+criado/i.test(document.body && document.body.innerText || ''),
      { timeout: timeoutMs }
    ).then(() => ({ kind: 'banner' }));
    const modalSignal = pg.waitForSelector(
      '.modal.show .alert-success, .swal2-success, .toast.show.bg-success',
      { timeout: timeoutMs }
    ).then(() => ({ kind: 'modal' }));
    const urlSignal = pg.waitForFunction(
      () => /pedidos?\\/?($|\\?)/.test(location.pathname || ''),
      { timeout: timeoutMs }
    ).then(() => ({ kind: 'url' }));
    return Promise.any([networkSignal, bannerSignal, modalSignal, urlSignal]);
  };

  // === PR3: leitura defensiva do corpo da resposta ===
  // Puppeteer pode lançar ao ler body de resposta consumida / redirect / etc.
  // Devolve sempre um envelope simples; nunca propaga exception.
  const readResponseBodySafe = async (resp) => {
    if (!resp) return { status: null, ok: false, contentType: null, body: null, parsed: null };
    let status = null;
    try { status = resp.status(); } catch (e) {}
    const headers = (() => { try { return resp.headers() || {}; } catch (e) { return {}; } })();
    const contentType = headers['content-type'] || null;
    const ok = typeof status === 'number' && status >= 200 && status < 300;
    let body = null;
    try { body = await resp.text(); } catch (e) { body = null; }
    let parsed = null;
    if (body) {
      try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
    }
    return { status, ok, contentType, body, parsed };
  };

  // === PR1: Envelope estruturado ===
  // Traduz o resultado bruto do runFlow (legado: { data: {...} }) + a evidência
  // do recorder na máquina de estados. Regra de ouro: requestSent === true
  // jamais resulta em estado retentável.
  const buildEnvelope = (raw, evidence) => {
    const elapsedMs = Date.now() - t0;
    const data = (raw && raw.data) ? raw.data : {};
    const screenshot = raw ? (raw.screenshot || null) : null;
    const preLogin = raw ? (raw.preLoginScreenshot || null) : null;
    const requestSent = !!(evidence && evidence.requestSent);
    let protocolo = data.protocolo || null;

    // PR1.5: se a runFlow não capturou protocolo, tenta extrair do recorder.
    let protocoloAutoExtraido = null;
    if (!protocolo) {
      const extracted = extractProtocoloFromEvidence(evidence);
      if (extracted) {
        protocolo = extracted.protocolo;
        protocoloAutoExtraido = extracted;
      }
    }

    let status;
    let ok;
    let safeToRetry;
    let needsReconciliation;

    if (data.success === true) {
      ok = true;
      status = protocolo ? 'sucesso_portal' : 'aceito_portal_sem_protocolo';
      safeToRetry = false;
      needsReconciliation = !protocolo;
    } else if (protocoloAutoExtraido && requestSent) {
      // PR1.5: recuperação automática. O script morreu (timeout do Browserless)
      // mas o portal já respondeu OK ao POST e conseguimos extrair o protocolo
      // do corpo. Trata como sucesso completo.
      ok = true;
      status = 'sucesso_portal';
      safeToRetry = false;
      needsReconciliation = false;
    } else {
      ok = false;
      const tipo = data.erroTipo || 'UNKNOWN';
      const erroLogicoPreSubmit =
        tipo === 'LOGIN_FAILED' || tipo === 'CLIENTE_NOT_FOUND' || tipo === 'SKU_NOT_FOUND'
        || tipo === 'GRUPO_LEADTIME_MISMATCH';
      if (requestSent) {
        // Houve POST: independente do tipo de erro, só conciliação resolve.
        status = 'indeterminado_requer_conciliacao';
        safeToRetry = false;
        needsReconciliation = true;
      } else if (erroLogicoPreSubmit) {
        // Erro lógico antes de qualquer submit — retentar não adianta.
        status = 'erro_nao_retentavel';
        safeToRetry = false;
        needsReconciliation = false;
      } else {
        // NAVIGATION_FAILED / INCLUIR_ITEM_NOT_FOUND / EXCEPTION (inclui o
        // timeout do Browserless) / UNKNOWN, sem POST capturado.
        status = 'erro_retentavel';
        safeToRetry = true;
        needsReconciliation = false;
      }
    }

    // Mantém a forma externa { data, type, screenshot, preLoginScreenshot } que
    // o Browserless v2 já serializa hoje; o envelope estruturado vai dentro de data.
    // PR4: portal_data_entrega vem do submit quando o sinal vencedor foi
    // network e o JSON foi parseado (ISO YYYY-MM-DD); null nos outros casos.
    return {
      data: {
        ok,
        status,
        protocolo,
        portal_data_entrega: data.portal_data_entrega || null,
        // Totais capturados do #datatable_itens (custo). Propaga o que o runFlow
        // anexou em raw.data.itens_capturados pro Deno casar com os itens.
        itens_capturados: Array.isArray(data.itens_capturados) ? data.itens_capturados : [],
        safeToRetry,
        needsReconciliation,
        evidence: {
          requestSent: evidence ? evidence.requestSent : false,
          requestCount: evidence ? evidence.requestCount : 0,
          responseCount: evidence ? evidence.responseCount : 0,
          okResponse: evidence ? evidence.okResponse : null,
          network: evidence ? evidence.events : [],
          protocoloAutoExtraido,
          erroTipo: data.erroTipo || null,
          erro: data.erro || null,
          successText: data.successText || null,
          loginCheckResult: data.loginCheckResult || null,
          trace: data.trace || trace,
        },
        elapsedMs,
      },
      type: 'application/json',
      screenshot,
      preLoginScreenshot: preLogin,
    };
  };

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

  const runFlow = async () => {
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
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: budgetFor('login-goto', 30_000) });
    await page.waitForSelector('#user', { timeout: budgetFor('login-form', 10_000) });
    await fillInput('#user', user);
    await fillInput('#password', pass);

    const navPromise = page.waitForNavigation({ timeout: budgetFor('login-nav', 15_000) }).catch(() => null);
    await clickButtonByText('Entrar');
    await navPromise;

    // Heuristica robusta: aguarda evidencia POSITIVA de login bem-sucedido
    // (URL mudou para fora de /login OU elemento exclusivo da area logada apareceu)
    // PR2: budget único para os 3 caminhos da Promise.race. Computado FORA dos
    // IIFEs para que um BUDGET_EXHAUSTED propague pelo catch externo em vez de
    // virar primeiro-settle da race (que mataria os outros caminhos cedo).
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
      (async () => {
        try {
          await page.waitForFunction(
            () => {
              const userSpan = document.querySelector('.navbar-user .d-md-inline');
              return userSpan && userSpan.innerText.trim().length > 0;
            },
            { timeout: loginCheckMs }
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
      { timeout: budgetFor('sidebar-links', 15_000) }
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
    }, { timeout: budgetFor('sidebar-pedidos-link', 3_000, { minMs: 300 }), polling: 100 });

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
      { timeout: budgetFor('nav-order-creation', 15_000) }
    ).catch(() => null);
    await sleep(2000); // dá tempo do DOM da página de pedidos estabilizar

    const urlAposClick = page.url();
    console.log('[DEBUG_AFTER_CLICK_PEDIDOS]', JSON.stringify({ url: urlAposClick, chegou_em_order_creation: urlAposClick.endsWith('/order-creation') }));
    trace.push({ step: 'after_click_pedidos', url: urlAposClick, t: Date.now() - t0 });

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
      // PR2: aborta cedo se não há janela para os itens restantes + submit.
      // Evita o pior cenário (montar 80% do pedido, chegar no submit com
      // budget zero e gerar indeterminado).
      assertEnoughTimeForRemainingItems(i, items.length);
      trace.push({ step: 'item_' + i + '_start', sku: item.sku_portal, t: Date.now() - t0, remaining: remainingMs() });

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
      }, { timeout: budgetFor('item-' + i + '-validacao-data', 15_000), polling: 250 });
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
      await page.waitForSelector(select2ContainerSel, { timeout: budgetFor('item-' + i + '-select2-container', 12_000) });
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
      await page.waitForSelector('.select2-search__field', { timeout: budgetFor('item-' + i + '-select2-search', 5_000) });
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

      // PR12: o portal Sayerlack às vezes ignora o click do #btnGravarItem
      // silenciosamente — o POST /save-tab-preco-session não dispara e a row
      // fica em modo edit no DOM. O script anterior achava que salvou
      // (waitForFunction de row count passava porque a row já existe na UI),
      // continuava pro próximo item, e a próxima iteração travava na validação
      // (15s timeout em validacao_data_entrega) porque o portal estava em
      // estado inconsistente.
      //
      // Correção: armar waitForResponse('save-tab-preco-session') ANTES do
      // click. Se o POST não vier em 7s, retentamos o click uma vez.
      const SAVE_TAB_RE = /save-tab-preco-session/i;
      const armarSaveWait = (label) => page.waitForResponse(
        (resp) => {
          try {
            return resp.request().method() === 'POST' && SAVE_TAB_RE.test(resp.url());
          } catch (e) { return false; }
        },
        { timeout: budgetFor(label, 7_000, { minMs: 1_000 }) }
      ).then((r) => ({ ok: true, status: r.status() })).catch(() => ({ ok: false }));

      let saveConfirm = armarSaveWait('item-' + i + '-save-confirm');
      await page.click('#btnGravarItem');
      let saveResult = await saveConfirm;

      if (!saveResult.ok) {
        // Retry: portal ignorou o click. Tenta de novo.
        console.warn('[DEBUG_ITEM_SAVE_RETRY]', JSON.stringify({ iteration: i, sku: item.sku_portal }));
        trace.push({ step: 'item_' + i + '_save_retry', t: Date.now() - t0 });
        saveConfirm = armarSaveWait('item-' + i + '-save-retry');
        await page.click('#btnGravarItem');
        saveResult = await saveConfirm;

        if (!saveResult.ok) {
          // Falhou 2x — POST do save nunca saiu. Aborta o pedido com erro
          // específico pra ficar claro na auditoria que foi o save do item
          // que travou (não outra coisa). Sem POST de submit ainda → vira
          // erro_retentavel via buildEnvelope.
          const errSave = new Error(
            'Portal Sayerlack ignorou o click do Gravar Item duas vezes para o item ' +
            i + ' (SKU ' + item.sku_portal + '). Save POST nunca disparou.'
          );
          errSave.code = 'ITEM_SAVE_NAO_CONFIRMADO';
          throw errSave;
        }
      }
      trace.push({ step: 'item_' + i + '_save_confirmed', t: Date.now() - t0, httpStatus: saveResult.status });

      // Mantém o waitForFunction da row count como segunda checagem (defensivo).
      await page.waitForFunction(
        (esperado) => {
          const rows = document.querySelectorAll('#datatable_itens tbody tr');
          return rows.length === esperado;
        },
        { timeout: budgetFor('item-' + i + '-row-count', 5_000) },
        i + 1
      ).catch(() => null);
      await sleep(400); // buffer pos-render
      trace.push({ step: 'item_' + i + '_saved', t: Date.now() - t0 });
    }

    // Aguardar fim da janela "Validando data de entrega" pós-último item.
    // O portal aplica disabled+pointer-events:none+opacity:0.65 no btnSalvarNovoPedido durante validação.
    // Mesmo padrão usado entre items, agora antes do click do Efetivar.
    await page.waitForFunction(function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const visiveis = btns.filter(function(b) { return b.offsetParent !== null; });
      const temValidando = visiveis.some(function(b) {
        return (b.innerText || '').includes('Validando');
      });
      const btnEfetivar = document.querySelector('#btnSalvarNovoPedido');
      const efetivarHabilitado = btnEfetivar && !btnEfetivar.disabled;
      return !temValidando && efetivarHabilitado;
    }, { timeout: budgetFor('validacao-pre-efetivar', 15_000), polling: 250 });
    trace.push({ step: 'validacao_data_entrega_ok_pre_efetivar', t: Date.now() - t0, remaining: remainingMs() });

    // PR13: scroll do botão "Efetivar Pedido" pra dentro da viewport ANTES do
    // click. O navbar sticky do portal Sayerlack cobre o topo da página; quando
    // há vários itens no formulário, a rolagem deixa o botão atrás do navbar
    // (y negativo). O Puppeteer clica na coordenada certa mas o navbar
    // intercepta — click some silenciosamente. Reproduzido em pedido de 6 SKUs
    // (trace mostrou rect.y=-17, elementoNoCentro=div.navbar-nav).
    await page.evaluate(() => {
      const btn = document.querySelector('#btnSalvarNovoPedido');
      if (btn) btn.scrollIntoView({ block: 'center' });
    });
    await sleep(300); // tempo do scroll completar e DOM estabilizar

    // Diagnóstico rico pré-click: estado do botão, contexto, hit-test, listeners jQuery
    const preClickDiag = await page.evaluate(function() {
      const btn = document.querySelector('#btnSalvarNovoPedido');
      if (!btn) return { btnEncontrado: false };

      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const elemPonto = document.elementFromPoint(cx, cy);

      // jQuery handlers count (se jQuery existir)
      let jqHandlersInfo = 'sem_jquery';
      try {
        if (window.$ && window.$._data) {
          const events = window.$._data(btn, 'events');
          jqHandlersInfo = events ? JSON.stringify(Object.keys(events)) : 'sem_handlers_jq';
        } else if (window.jQuery && window.jQuery._data) {
          const events = window.jQuery._data(btn, 'events');
          jqHandlersInfo = events ? JSON.stringify(Object.keys(events)) : 'sem_handlers_jq';
        }
      } catch (e) { jqHandlersInfo = 'erro_acesso_jq:' + (e.message || '').substring(0, 50); }

      // Buscar pistas textuais no body
      const corpo = (document.body.innerText || '').toLowerCase();
      const temObrigatorio = corpo.includes('obrigatório') || corpo.includes('obrigatorio');
      const temPreenchaCampo = corpo.includes('preencha') || corpo.includes('preenchimento');
      const temErroGenerico = /\berro\b/.test(corpo);

      // Estado computed do botão
      const computed = window.getComputedStyle(btn);

      return {
        btnEncontrado: true,
        disabled: btn.disabled,
        ariaDisabled: btn.getAttribute('aria-disabled'),
        classListContemDisabled: btn.classList.contains('disabled'),
        classes: (btn.className || '').substring(0, 150),
        offsetParentNull: btn.offsetParent === null,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        pointerEvents: computed.pointerEvents,
        opacity: computed.opacity,
        visibility: computed.visibility,
        elementoNoCentro: elemPonto ? {
          tag: elemPonto.tagName,
          id: elemPonto.id || '',
          classes: (elemPonto.className || '').toString().substring(0, 100),
          mesmoBotaoOuFilho: elemPonto === btn || btn.contains(elemPonto),
          contemBotao: elemPonto.contains ? elemPonto.contains(btn) : false
        } : null,
        jqHandlersInfo: jqHandlersInfo,
        pistasNoBody: {
          temObrigatorio: temObrigatorio,
          temPreenchaCampo: temPreenchaCampo,
          temErroGenerico: temErroGenerico
        },
        parentHTML: btn.parentElement ? btn.parentElement.outerHTML.substring(0, 500) : null
      };
    });
    trace.push({ step: 'pre_click_efetivar_diag', t: Date.now() - t0, diag: preClickDiag });
    console.log('[DEBUG_PRE_CLICK_EFETIVAR]', JSON.stringify(preClickDiag));

    // === PR3: wait composto pós-submit ===
    // Arma os 4 sinais ANTES do click — qualquer um que cumpra ganha. Ignora
    // rejeições individuais via Promise.any. Substitui o waitForFunction de
    // banner único do PR1/PR2 (sinal frágil que perdia respostas atrasadas).
    // PR11: 60s em vez de 14s. Descoberta no trace do pedido #230 (20 SKUs):
    // a resposta do POST /order-creation/form/add ESCALA COM O TAMANHO DO
    // PEDIDO no Sayerlack:
    //   4 SKUs  → ~9s   (era o que o PR6 calibrou)
    //   20 SKUs → ~20s  (estoura os 14s do PR6 facilmente)
    // Com HARD_CEILING_MS=280s do PR9 e ~118s sobrando no click típico,
    // usar 60s aqui é confortável. budgetFor cai pra (restante - 2s) se
    // o pedido for mais lento e chegar com menos folga.
    const postSubmitBudget = budgetFor('submit-pedido', 60_000, { reserveSubmit: false, minMs: 2_000 });
    const signalPromise = waitForPositiveSubmitSignal(page, postSubmitBudget);

    await page.click('#btnSalvarNovoPedido');
    trace.push({ step: 'efetivar_clicked', t: Date.now() - t0, postSubmitBudget, remaining: remainingMs() });

    // Snapshot imediato (sem sleep) pra capturar mudança instantânea no DOM.
    const snapImediato = await page.evaluate(function() {
      const btn = document.querySelector('#btnSalvarNovoPedido');
      return {
        btnAindaPresente: !!btn,
        btnDisabled: btn ? btn.disabled : null,
        btnClassListDisabled: btn ? btn.classList.contains('disabled') : null,
        btnClasses: btn ? (btn.className || '').substring(0, 150) : null,
        url: location.href,
        bodyTextSnippet: (document.body.innerText || '').substring(0, 300)
      };
    });
    trace.push({ step: 'snapshot_pos_efetivar_imediato', t: Date.now() - t0, snapshot: snapImediato });
    console.log('[DEBUG_POS_EFETIVAR_IMEDIATO]', JSON.stringify(snapImediato));

    // Aguarda o primeiro sinal positivo. Se nenhum cumprir no budget, lança
    // AggregateError (Promise.any) — capturado e classificado abaixo.
    let firstSignal;
    try {
      firstSignal = await signalPromise;
    } catch (err) {
      firstSignal = { kind: 'none', error: (err && err.message) || String(err) };
    }
    trace.push({ step: 'first_signal', kind: firstSignal.kind, t: Date.now() - t0, remaining: remainingMs() });
    console.log('[DEBUG_FIRST_SIGNAL]', JSON.stringify({ kind: firstSignal.kind, error: firstSignal.error || null }));

    // Microjanela: 250ms a mais pro recorder receber o body da response caso o
    // sinal vencedor tenha sido banner/modal/url (que chegam antes do network
    // em alguns cenários).
    if (remainingMs() > 800) {
      await sleep(250);
    }

    // Extrai protocolo via cascata de fontes confiáveis:
    //   1. body da response do POST capturado pelo Promise.any (mais confiável)
    //   2. DOM do banner (quando o sinal vencedor foi banner)
    //   3. fallback PR1.5: qualquer response capturada pelo recorder
    let protocolo = null;
    let protocoloSource = null;
    let responseInfo = null;
    let bodySuccessFalse = false;  // portal devolveu success:false explícito
    // PR4: data_entrega devolvida pelo portal (campo top-level "data_entrega"
    // do JSON em formato ISO YYYY-MM-DD; ex.: "2026-05-22"). Usada pelo
    // disparar-pedidos-aprovados como base do dDtPrevisao do Omie (+ 2 dias).
    let portalDataEntrega = null;

    if (firstSignal.kind === 'network' && firstSignal.response) {
      const r = await readResponseBodySafe(firstSignal.response);
      responseInfo = {
        status: r.status,
        ok: r.ok,
        contentType: r.contentType,
        parsedKind: r.parsed ? 'json' : (r.body ? 'text' : 'empty'),
      };
      if (r.parsed && r.parsed.success === false) bodySuccessFalse = true;
      if (r.parsed && !bodySuccessFalse) {
        protocolo = tryExtractProtocoloFromObject(r.parsed);
        if (protocolo) protocoloSource = 'network_json';
        // PR4: data_entrega top-level (ISO YYYY-MM-DD). Validação estrita
        // para não persistir lixo no banco.
        if (typeof r.parsed.data_entrega === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(r.parsed.data_entrega)) {
          portalDataEntrega = r.parsed.data_entrega;
        }
      }
      if (!protocolo && r.body && !bodySuccessFalse) {
        protocolo = tryExtractProtocolo(r.body);
        if (protocolo) protocoloSource = 'network_text';
      }
    }

    if (!protocolo && firstSignal.kind === 'banner') {
      protocolo = await page.evaluate(() => {
        const body = (document.body && document.body.innerText) || '';
        const m = body.match(/Pedido\\s+(\\d+)\\s+criado/i);
        return m ? m[1] : null;
      });
      if (protocolo) protocoloSource = 'banner_dom';
    }

    if (!protocolo && !bodySuccessFalse) {
      // Fallback PR1.5: olha qualquer response no recorder (não só a que o
      // Promise.any pegou — outros POSTs podem ter trazido o número também).
      const evidenceForExtract = recorder.getSubmitEvidence();
      const fromRecorder = extractProtocoloFromEvidence(evidenceForExtract);
      if (fromRecorder) {
        protocolo = fromRecorder.protocolo;
        protocoloSource = 'recorder_fallback';
      }
    }

    trace.push({
      step: 'submit_classified',
      firstSignalKind: firstSignal.kind,
      protocolo,
      protocoloSource,
      portalDataEntrega,
      responseInfo,
      bodySuccessFalse,
      t: Date.now() - t0
    });
    console.log('[DEBUG_SUBMIT_CLASSIFIED]', JSON.stringify({
      firstSignalKind: firstSignal.kind, protocolo, protocoloSource, portalDataEntrega, responseInfo, bodySuccessFalse
    }));

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, encoding: 'base64' }).catch(() => null);

    // Decisão final (alinhada com a cascata de classifySubmitResult do doc):
    //  - Portal devolveu success:false explícito → falha; buildEnvelope vê
    //    requestSent e classifica como indeterminado (operador concilia).
    //  - Sinal positivo (network/banner/modal) OU protocolo extraído de
    //    qualquer fonte → success:true; buildEnvelope mapeia para
    //    sucesso_portal (com protocolo) ou aceito_portal_sem_protocolo.
    //  - firstSignal === 'url' (só URL change, sem nada mais) → success:false
    //    com erroTipo AMBIGUO_URL_ONLY → indeterminado.
    //  - firstSignal === 'none' → success:false com erroTipo NO_POSITIVE_SIGNAL
    //    → buildEnvelope decide via requestSent (POST capturado → indeterminado;
    //    sem POST → erro_retentavel).
    if (bodySuccessFalse) {
      return {
        data: {
          success: false,
          erroTipo: 'PORTAL_RESPONSE_FAILURE',
          erro: 'Portal devolveu success:false na resposta do POST de efetivação',
          firstSignal: { kind: firstSignal.kind },
          responseInfo,
          durationMs: Date.now() - t0,
          trace,
        },
        type: 'application/json',
        screenshot,
      };
    }

    const positiveKinds = ['network', 'banner', 'modal'];
    if (positiveKinds.indexOf(firstSignal.kind) !== -1 || protocolo) {
      trace.push({ step: 'success_detected', protocolo, source: protocoloSource, portalDataEntrega, t: Date.now() - t0 });
      return {
        data: {
          success: true,
          protocolo,
          protocoloSource,
          portal_data_entrega: portalDataEntrega,
          firstSignal: { kind: firstSignal.kind },
          responseInfo,
          successText: protocolo ? ('Pedido ' + protocolo + ' criado com sucesso') : null,
          durationMs: Date.now() - t0,
          trace,
        },
        type: 'application/json',
        screenshot,
      };
    }

    // firstSignal === 'url' ou 'none', sem protocolo.
    return {
      data: {
        success: false,
        erroTipo: firstSignal.kind === 'url' ? 'AMBIGUO_URL_ONLY' : 'NO_POSITIVE_SIGNAL',
        erro: firstSignal.kind === 'url'
          ? 'Apenas mudança de URL detectada após submit — sem protocolo, requer conciliação'
          : 'Nenhum sinal positivo de submit em ' + postSubmitBudget + 'ms (banner/modal/network/url todos timed out)',
        firstSignal: { kind: firstSignal.kind, error: firstSignal.error || null },
        durationMs: Date.now() - t0,
        trace,
      },
      type: 'application/json',
      screenshot,
    };
  } catch (err) {
    const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' }).catch(() => null);
    // PR12: propaga qualquer err.code conhecido (BUDGET_EXHAUSTED, ITEM_SAVE_NAO_CONFIRMADO, ...)
    // pra auditoria. Sem code → EXCEPTION genérico.
    const erroTipo = (err && err.code) ? err.code : 'EXCEPTION';
    return {
      data: {
        success: false,
        erro: (err && err.message) ? err.message : String(err),
        erroTipo,
        budgetLabel: (err && err.label) || null,
        elapsedMs: Date.now() - t0,
        remainingMs: remainingMs(),
        trace,
      },
      type: 'application/json',
      screenshot: errorScreenshot,
    };
   }
  };

  // Recorder armado ANTES do runFlow (logo, antes de qualquer page.goto).
  const recorder = installOrderNetworkRecorder(page);
  let raw;
  try {
    raw = await runFlow();
  } catch (err) {
    // Rede de segurança: runFlow tem try/catch interno, mas qualquer escape
    // ainda devolve envelope estruturado (nunca um throw nu para o Browserless).
    // PR12: propaga qualquer err.code conhecido (BUDGET_EXHAUSTED, ITEM_SAVE_NAO_CONFIRMADO, ...)
    // pra auditoria. Sem code → EXCEPTION genérico.
    const erroTipo = (err && err.code) ? err.code : 'EXCEPTION';
    raw = {
      data: {
        success: false,
        erro: (err && err.message) ? err.message : String(err),
        erroTipo,
        budgetLabel: (err && err.label) || null,
        elapsedMs: Date.now() - t0,
        remainingMs: remainingMs(),
        trace,
      },
      type: 'application/json',
      screenshot: null,
    };
  }
  return buildEnvelope(raw, recorder.getSubmitEvidence());
};
`;

// ============================================================================
// Captura de custo do portal (Deno scope — NÃO roda dentro do Browserless).
// ESPELHO VERBATIM de src/lib/reposicao/sayerlack-scraping-pedido.ts — manter
// em sincronia. (parseDiasPrzEnt é dependência de casarLinhasComItens; o gate
// de grupo roda no browser, então validarGrupoLeadtime fica fora daqui.)
// ============================================================================
function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR: ponto=milhar, vírgula=decimal
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

function parseDiasPrzEnt(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) ? n : null;
}

interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_raw: string; }
interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number; preco_atual: number;
}
interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; }
interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }

function casarLinhasComItens(linhas: LinhaPortal[], itens: ItemPedido[]): ResultadoMatch {
  const casados: Casado[] = [];
  const naoCasados: ItemPedido[] = [];
  const ambiguos: ItemPedido[] = [];

  const itensPorSku = new Map<string, ItemPedido[]>();
  for (const it of itens) {
    const k = normPortal(it.sku_portal);
    if (!k) { naoCasados.push(it); continue; }
    const arr = itensPorSku.get(k) ?? [];
    arr.push(it); itensPorSku.set(k, arr);
  }
  const linhasPorSku = new Map<string, LinhaPortal[]>();
  for (const ln of linhas) {
    const k = normPortal(ln.sku_portal);
    if (!k) continue;
    const arr = linhasPorSku.get(k) ?? [];
    arr.push(ln); linhasPorSku.set(k, arr);
  }
  for (const [k, its] of itensPorSku) {
    const lns = linhasPorSku.get(k) ?? [];
    if (its.length > 1 || lns.length > 1) { ambiguos.push(...its); continue; }
    if (lns.length === 0) { naoCasados.push(its[0]); continue; }
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: parseBRL(lns[0].total_raw) });
  }
  return { casados, naoCasados, ambiguos };
}

interface CustoUpdate { item_id: number; preco_unitario: number; valor_linha: number; }
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const total = c.total_linha; const qtde = c.item.qtde_final;
    if (total == null || !(total > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (!(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    if (round2(total) === round2(qtde * c.item.preco_atual)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'sem_mudanca' }); continue; }
    updates.push({ item_id: c.item.item_id, preco_unitario: total / qtde, valor_linha: total }); // precisão cheia
  }
  return { updates, pulados };
}

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
  // preço unitário atual do item (base da tolerância na captura de custo do portal)
  preco_atual?: number;
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

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string;
}

interface PedidoItemDireto {
  id: number;
  sku_codigo_omie: string;
  sku_descricao: string;
  qtde_final: number | string;
}

interface SkuFornecedorExternoRow {
  sku_omie: string;
  sku_portal: string | null;
  unidade_portal: string | null;
  fator_conversao: number | string | null;
  ativo: boolean | null;
}

interface BrowserlessEnvelope {
  evidence?: Record<string, unknown>;
  elapsedMs?: number;
  preLoginScreenshotUrl?: string | null;
  portal_data_entrega?: string;
  [key: string]: unknown;
}

interface BrowserlessResponse {
  data?: BrowserlessEnvelope;
  type?: string;
  screenshot?: string | null;
  preLoginScreenshot?: string | null;
  raw?: string;
  [key: string]: unknown;
}

async function uploadScreenshot(
  supabase: SupabaseClient,
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

async function registrarPedidoOmieAposPortal(pedido: PedidoCandidato) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/disparar-pedidos-aprovados`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ empresa: pedido.empresa, pedido_id: pedido.id }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[envio-portal] Pedido #${pedido.id}: falha ao registrar Omie apos portal [${resp.status}] ${text.slice(0, 300)}`);
      return;
    }
    console.log(`[envio-portal] Pedido #${pedido.id}: Omie acionado apos portal [${resp.status}] ${text.slice(0, 300)}`);
  } catch (e) {
    console.error(`[envio-portal] Pedido #${pedido.id}: excecao ao registrar Omie apos portal`, e instanceof Error ? e.message : String(e));
  }
}

// PR1: grava uma linha de auditoria em pedidos_portal_tentativas.
// Best-effort — uma falha aqui nunca aborta o processamento do pedido.
async function gravarTentativa(
  supabase: SupabaseClient,
  pedidoId: number,
  params: {
    iniciadoEm: string;
    statusResultado: string;
    elapsedMs: number | null;
    evidence: Record<string, unknown>;
    browserlessResponseMs: number | null;
    erro: string | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("pedidos_portal_tentativas").insert({
      pedido_id: pedidoId,
      iniciado_em: params.iniciadoEm,
      concluido_em: new Date().toISOString(),
      status_resultado: params.statusResultado,
      elapsed_ms: params.elapsedMs,
      evidence: params.evidence ?? {},
      browserless_response_ms: params.browserlessResponseMs,
      erro: params.erro,
    });
    if (error) {
      console.error(`[envio-portal] Pedido #${pedidoId}: falha ao gravar tentativa de auditoria:`, error.message);
    }
  } catch (e) {
    console.error(`[envio-portal] Pedido #${pedidoId}: excecao ao gravar tentativa de auditoria:`, e instanceof Error ? e.message : String(e));
  }
}

async function processarPedido(
  supabase: SupabaseClient,
  pedido: PedidoCandidato,
): Promise<ProcessResult> {
  const t0 = Date.now();
  const iniciadoEm = new Date(t0).toISOString();
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

  // Idempotencia: pedido comprovadamente no portal nao e reprocessado.
  // Cobre o estado legado (enviado_portal) e o novo (sucesso_portal), ambos
  // exigem protocolo confirmado.
  if (
    pedido.portal_protocolo &&
    (pedido.status_envio_portal === "enviado_portal" ||
      pedido.status_envio_portal === "sucesso_portal")
  ) {
    console.log(`[envio-portal] Pedido #${pedido.id}: ja enviado (protocolo=${pedido.portal_protocolo}), pulando`);
    result.status_final = pedido.status_envio_portal;
    result.protocolo = pedido.portal_protocolo;
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  // 1. Buscar itens com mapeamento
  console.log("[DEBUG_RPC] tentando RPC envio_portal_itens_mapeados, pedido_id=", pedido.id);
  const { data: itens, error: itensErr } = await supabase.rpc("envio_portal_itens_mapeados", {
    p_pedido_id: pedido.id,
  }).select("*") as unknown as { data: ItemMapeado[] | null; error: PostgrestErrorLike | null };

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
    const { data: itensDirectRaw, error: e2 } = await supabase
      .from("pedido_compra_item")
      .select(`
        id,
        sku_codigo_omie,
        sku_descricao,
        qtde_final
      `)
      .eq("pedido_id", pedido.id)
      .order("id", { ascending: true });
    const itensDirect = (itensDirectRaw ?? []) as unknown as PedidoItemDireto[];
    if (e2 || !itensDirectRaw) {
      // Erro de banco ao buscar itens — transiente, nenhum POST foi enviado.
      result.erro = `Erro ao buscar itens: ${e2?.message ?? "desconhecido"}`;
      result.tentativas += 1;
      const esgotado = result.tentativas >= MAX_TENTATIVAS;
      result.status_final = esgotado ? "erro_nao_retentavel" : "erro_retentavel";
      await supabase.from("pedido_compra_sugerido").update({
        status_envio_portal: result.status_final,
        portal_tentativas: result.tentativas,
        portal_erro: result.erro,
        portal_proximo_retry_em: esgotado ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }).eq("id", pedido.id);
      await gravarTentativa(supabase, pedido.id, {
        iniciadoEm,
        statusResultado: result.status_final,
        elapsedMs: Date.now() - t0,
        evidence: { phase: "pre_browserless", motivo: "erro_buscar_itens", requestSent: false },
        browserlessResponseMs: null,
        erro: result.erro,
      });
      result.duracao_ms = Date.now() - t0;
      return result;
    }
    const skus = itensDirect.map((i) => i.sku_codigo_omie);
    console.log("[DEBUG_FALLBACK_ITENS]", JSON.stringify({
      pedido_id: pedido.id,
      pedido_empresa: pedido.empresa,
      itensDirect_count: itensDirect?.length ?? 0,
      skus_extraidos: skus,
    }));
    const { data: mapsRaw, error: mapsErr } = await supabase
      .from("sku_fornecedor_externo")
      .select("sku_omie, sku_portal, unidade_portal, fator_conversao, ativo")
      .eq("empresa", pedido.empresa)
      .ilike("fornecedor_nome", "%SAYERLACK%")
      .in("sku_omie", skus);
    const maps = (mapsRaw ?? []) as unknown as SkuFornecedorExternoRow[];
    console.log("[DEBUG_FALLBACK_MAPS]", JSON.stringify({
      pedido_id: pedido.id,
      filtro_empresa: pedido.empresa,
      filtro_fornecedor_pattern: '%SAYERLACK%',
      filtro_skus: skus,
      maps_count: maps.length,
      maps_amostra: maps.slice(0, 3).map((m) => ({ sku_omie: m.sku_omie, sku_portal: m.sku_portal, ativo: m.ativo })),
      mapsErr: mapsErr ? { message: mapsErr.message, code: mapsErr.code } : null,
    }));
    const mapByOmie = new Map<string, SkuFornecedorExternoRow>();
    maps.forEach((m) => mapByOmie.set(m.sku_omie, m));
    itensList = itensDirect.map((i) => {
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
    // Erro logico — retentar nao resolve.
    result.status_final = "erro_nao_retentavel";
    result.erro = "Pedido sem itens";
    result.tentativas += 1;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: result.status_final,
      portal_tentativas: result.tentativas,
      portal_erro: result.erro,
      portal_proximo_retry_em: null,
    }).eq("id", pedido.id);
    await gravarTentativa(supabase, pedido.id, {
      iniciadoEm,
      statusResultado: result.status_final,
      elapsedMs: Date.now() - t0,
      evidence: { phase: "pre_browserless", motivo: "pedido_sem_itens", requestSent: false },
      browserlessResponseMs: null,
      erro: result.erro,
    });
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
    // Erro logico — retentar nao resolve enquanto o mapeamento nao for corrigido.
    result.status_final = "erro_nao_retentavel";
    result.erro = `SKUs sem mapeamento ativo: ${lista}`;
    result.tentativas += 1;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: result.status_final,
      portal_tentativas: result.tentativas,
      portal_erro: result.erro,
      portal_proximo_retry_em: null,
    }).eq("id", pedido.id);
    await gravarTentativa(supabase, pedido.id, {
      iniciadoEm,
      statusResultado: result.status_final,
      elapsedMs: Date.now() - t0,
      evidence: { phase: "pre_browserless", motivo: "skus_sem_mapeamento", skus: semMap.map((i) => i.sku_codigo_omie), requestSent: false },
      browserlessResponseMs: null,
      erro: result.erro,
    });
    console.log(`[envio-portal] Pedido #${pedido.id}: falha SKUs sem mapeamento`);
    result.duracao_ms = Date.now() - t0;
    return result;
  }

  // preco_unitario atual (base da tolerância de custo na captura). Independe da RPC trazer ou não.
  {
    const ids = itensList.map((i) => i.item_id);
    if (ids.length > 0) {
      const { data: precos } = await supabase.from("pedido_compra_item").select("id, preco_unitario").in("id", ids);
      const pm = new Map<number, number>((precos ?? []).map((p) => [Number((p as { id: number }).id), Number((p as { preco_unitario: number | null }).preco_unitario ?? 0)]));
      for (const it of itensList) (it as { preco_atual?: number }).preco_atual = pm.get(it.item_id) ?? 0;
    }
  }

  // lead time esperado do grupo (validação de Prz Ent). Null = sem config → gate fica indisponível (fail-open).
  // grupo_codigo não vem no PedidoCandidato (select enxuto) — buscamos a config direto por empresa+fornecedor+grupo.
  let ltEsperado: number | null = null;
  {
    const { data: pedRow } = await supabase
      .from("pedido_compra_sugerido")
      .select("grupo_codigo")
      .eq("id", pedido.id)
      .maybeSingle();
    const grupoCodigo = (pedRow as { grupo_codigo?: string | null } | null)?.grupo_codigo ?? null;
    if (grupoCodigo) {
      const { data: grp } = await supabase
        .from("fornecedor_grupo_producao")
        .select("lt_producao_dias, lt_producao_unidade")
        .eq("empresa", pedido.empresa)
        .eq("fornecedor_nome", pedido.fornecedor_nome)
        .eq("grupo_codigo", grupoCodigo)
        .maybeSingle();
      if (grp && ((grp as { lt_producao_unidade?: string }).lt_producao_unidade ?? 'uteis') === 'uteis'
          && Number.isInteger((grp as { lt_producao_dias?: number }).lt_producao_dias)) {
        ltEsperado = (grp as { lt_producao_dias: number }).lt_producao_dias;
      }
    }
  }

  // 3. Calcular qtde portal
  // Portal Sayerlack só aceita unidades inteiras: arredondar SEMPRE para cima.
  const itemsPortal = itensList.map((i) => ({
    sku_portal: i.sku_portal!,
    qtde: Math.max(1, Math.ceil(i.qtde_final * i.fator_conversao)),
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
  let bResp: BrowserlessResponse | null = null;
  let httpErr: string | null = null;

  try {
    const ctrl = new AbortController();
    // PR9: 350s no abort do fetch (50s de margem após o ?timeout=300000 do
    // Browserless Prototyping). Antes era 150s + ?timeout=60000.
    const timeout = setTimeout(() => ctrl.abort(), 350_000);
    const resp = await fetch(
      `https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=300000`,
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
            ltEsperado,
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
      bResp = { raw: txt };
    }
  } catch (e) {
    httpErr = e instanceof Error ? e.message : String(e);
  }
  const browserlessMs = Date.now() - tBrowserless;
  console.log(`[envio-portal] Pedido #${pedido.id}: Browserless retornou em ${browserlessMs}ms — status=${httpStatus}`);

  // 6. Tratar respostas HTTP do Browserless
  if (httpStatus === 401 || httpStatus === 403) {
    // Token invalido — o Browserless rejeitou a chamada na camada HTTP: nenhum
    // browser subiu, nenhum POST saiu. Seguro retentar (erro_retentavel, nunca
    // mais reverte cegamente para pendente_envio_portal). Lanca pra fora para o
    // caller devolver 500 e o operador notar o problema do token.
    console.error(`[envio-portal] BROWSERLESS_TOKEN invalido (HTTP ${httpStatus})`);
    const erroToken = `BROWSERLESS_TOKEN invalido: HTTP ${httpStatus}`;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "erro_retentavel",
      portal_erro: erroToken,
      portal_proximo_retry_em: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }).eq("id", pedido.id);
    await gravarTentativa(supabase, pedido.id, {
      iniciadoEm,
      statusResultado: "erro_retentavel",
      elapsedMs: Date.now() - t0,
      evidence: { phase: "browserless_http", httpStatus, motivo: "token_invalido", requestSent: false },
      browserlessResponseMs: browserlessMs,
      erro: erroToken,
    });
    throw new Error(erroToken);
  }

  const tempFail =
    httpErr !== null ||
    httpStatus === 408 ||
    httpStatus === 0 ||
    (httpStatus >= 500 && httpStatus < 600);

  // Extrair envelope estruturado (PR1): o script sempre devolve
  // { data: <envelope>, type, screenshot, preLoginScreenshot }.
  const envelope: BrowserlessEnvelope = (bResp?.data ?? (bResp as BrowserlessEnvelope | null) ?? {}) as BrowserlessEnvelope;
  const screenshotB64: string | null = bResp?.screenshot ?? null;
  const preLoginScreenshotB64: string | null = bResp?.preLoginScreenshot ?? null;
  const evidence: Record<string, unknown> = (envelope?.evidence ?? {}) as Record<string, unknown>;
  const requestSent = evidence?.requestSent === true;

  // Upload de screenshots (instrumentacao — comportamento inalterado)
  if (screenshotB64) {
    result.screenshot_url = await uploadScreenshot(supabase, pedido.id, screenshotB64);
    if (result.screenshot_url) {
      console.log(`[envio-portal] Pedido #${pedido.id}: screenshot uploaded`);
    }
  }
  if (preLoginScreenshotB64) {
    const preUrl = await uploadScreenshot(
      supabase,
      pedido.id,
      preLoginScreenshotB64,
      "_pre_login",
    );
    if (preUrl) {
      console.log(`[envio-portal] Pedido #${pedido.id}: pre_login_screenshot uploaded`);
      envelope.preLoginScreenshotUrl = preUrl;
    }
  }

  const novasTentativas = result.tentativas + 1;
  result.tentativas = novasTentativas;

  // Helper local: aplica a transicao de estado, grava a linha de auditoria
  // e fecha o ProcessResult. Fonte unica de UPDATE em pedido_compra_sugerido
  // pos-Browserless.
  const aplicarTransicao = async (
    statusFinal: string,
    opts: {
      erro: string | null;
      protocolo?: string | null;
      proximoRetryEm?: string | null;
      enviadoPortalEm?: boolean;
    },
  ): Promise<ProcessResult> => {
    result.status_final = statusFinal;
    result.erro = opts.erro;
    if (opts.protocolo !== undefined && opts.protocolo !== null) {
      result.protocolo = opts.protocolo;
    }
    const update: Record<string, unknown> = {
      status_envio_portal: statusFinal,
      portal_screenshot_url: result.screenshot_url,
      portal_tentativas: novasTentativas,
      portal_erro: opts.erro,
      portal_resposta: envelope,
      portal_proximo_retry_em: opts.proximoRetryEm ?? null,
    };
    if (opts.protocolo !== undefined) update.portal_protocolo = opts.protocolo;
    if (opts.enviadoPortalEm) update.enviado_portal_em = new Date().toISOString();
    // PR4: persiste a data_entrega devolvida pelo portal (formato ISO YYYY-MM-DD).
    // Só grava se veio um valor válido — não sobrescreve com null em re-tentativas
    // que não capturaram a data (ex.: caminho PR1.5 do recorder fallback).
    const portalDataEntrega = envelope?.portal_data_entrega;
    if (typeof portalDataEntrega === "string" && /^\d{4}-\d{2}-\d{2}$/.test(portalDataEntrega)) {
      update.portal_data_entrega = portalDataEntrega;
    }
    await supabase.from("pedido_compra_sugerido").update(update).eq("id", pedido.id);
    await gravarTentativa(supabase, pedido.id, {
      iniciadoEm,
      statusResultado: statusFinal,
      elapsedMs: typeof envelope?.elapsedMs === "number" ? envelope.elapsedMs : (Date.now() - t0),
      evidence: {
        ...evidence,
        httpStatus,
        envelopeStatus: envelope?.status ?? null,
        ok: envelope?.ok ?? null,
        protocolo: opts.protocolo ?? null,
        statusFinal,
      },
      browserlessResponseMs: browserlessMs,
      erro: opts.erro,
    });
    console.log(`[envio-portal] Pedido #${pedido.id}: enviando_portal -> ${statusFinal} (envelope=${envelope?.status ?? "?"})`);
    result.duracao_ms = Date.now() - t0;
    return result;
  };

  // tempFail: o Browserless nao entregou um envelope estruturado.
  if (tempFail) {
    const erroMsg = httpErr ?? `HTTP ${httpStatus} do Browserless`;
    if (httpErr !== null) {
      // fetch lancou (conexao caiu / abort): genuinamente ambiguo — nao da pra
      // provar que nenhum POST saiu. Conciliacao.
      return await aplicarTransicao("indeterminado_requer_conciliacao", {
        erro: `Browserless sem resposta (ambiguo): ${erroMsg}`,
      });
    }
    // Status HTTP de erro do Browserless (>=500 / 0 / 408): a camada HTTP
    // respondeu erro, o script nao chegou a submeter. Retentavel.
    const esgotado = novasTentativas >= MAX_TENTATIVAS;
    return await aplicarTransicao(
      esgotado ? "erro_nao_retentavel" : "erro_retentavel",
      {
        erro: erroMsg,
        proximoRetryEm: esgotado ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    );
  }

  // HTTP 200 mas sem envelope estruturado inteligivel — nao da pra descartar
  // que um POST saiu. Conciliacao.
  if (!envelope || typeof envelope.status !== "string") {
    return await aplicarTransicao("indeterminado_requer_conciliacao", {
      erro: "Browserless devolveu HTTP 200 sem envelope estruturado",
    });
  }

  // Rede de seguranca: se o recorder viu um POST sair, o pedido NUNCA pode
  // terminar em estado retentavel, ainda que o envelope diga o contrario.
  let envStatus: string = envelope.status;
  if (requestSent && envStatus === "erro_retentavel") {
    console.warn(`[envio-portal] Pedido #${pedido.id}: requestSent=true mas envelope=erro_retentavel — forcando indeterminado`);
    envStatus = "indeterminado_requer_conciliacao";
  }

  // Maquina de estados guiada pelo envelope.
  if (envStatus === "sucesso_portal") {
    const r = await aplicarTransicao("sucesso_portal", {
      erro: null,
      protocolo: envelope.protocolo ?? null,
      enviadoPortalEm: true,
    });
    // Captura de custo do portal: itens_capturados [{sku_portal, total_raw}]. Idempotente (só antes do Omie existir). Best-effort.
    // (envelope === bResp.data já é o envelope achatado do buildEnvelope; itens_capturados é top-level, não envelope.data.)
    try {
      const capturados = ((envelope?.itens_capturados ?? []) as Array<{ sku_portal: string; total_raw: string; prz_ent_raw?: string }>);
      const jaTemOmie = !!(pedido as { omie_pedido_compra_numero?: string | null }).omie_pedido_compra_numero;
      if (capturados.length > 0 && !jaTemOmie) {
        const itensParaCusto: ItemPedido[] = itensList.map((i) => ({
          item_id: i.item_id, sku_codigo_omie: i.sku_codigo_omie, sku_descricao: i.sku_descricao,
          sku_portal: i.sku_portal, qtde_final: Number(i.qtde_final), preco_atual: Number((i as { preco_atual?: number }).preco_atual ?? 0),
        }));
        const linhas: LinhaPortal[] = capturados.map((c) => ({ sku_portal: c.sku_portal, prz_ent_raw: c.prz_ent_raw ?? '', total_raw: c.total_raw }));
        const match = casarLinhasComItens(linhas, itensParaCusto);
        const { updates, pulados } = derivarCustos(match);
        for (const u of updates) {
          await supabase.from("pedido_compra_item").update({ preco_unitario: u.preco_unitario, valor_linha: u.valor_linha }).eq("id", u.item_id);
        }
        if (updates.length > 0) {
          const novoTotal = match.casados.reduce((s, c) => s + (c.total_linha ?? (c.item.qtde_final * c.item.preco_atual)), 0);
          await supabase.from("pedido_compra_sugerido").update({ valor_total: novoTotal }).eq("id", pedido.id);
        }
        console.log(`[envio-portal] Pedido #${pedido.id}: custo capturado — ${updates.length} atualizados, ${pulados.length} pulados`);
      }
    } catch (e) {
      console.error(`[envio-portal] Pedido #${pedido.id}: falha best-effort na captura de custo:`, e instanceof Error ? e.message : String(e));
    }
    await registrarPedidoOmieAposPortal(pedido);
    return r;
  }

  if (envStatus === "aceito_portal_sem_protocolo") {
    // Portal aceitou mas sem numero confirmado: NAO registra no Omie ainda —
    // exige conciliacao para obter o protocolo.
    return await aplicarTransicao("aceito_portal_sem_protocolo", {
      erro: "Portal aceitou o pedido sem protocolo — requer conciliacao",
      protocolo: envelope.protocolo ?? null,
    });
  }

  if (envStatus === "indeterminado_requer_conciliacao") {
    return await aplicarTransicao("indeterminado_requer_conciliacao", {
      erro: evidence?.erro ?? "Resultado ambiguo — requer conciliacao manual",
    });
  }

  if (envStatus === "erro_nao_retentavel") {
    // Erro logico do automador (login / cliente / sku invalido).
    const erroTipo: string = evidence?.erroTipo ?? "UNKNOWN";
    const erroMsg: string = evidence?.erro ?? "Falha logica do automador";
    const r = await aplicarTransicao("erro_nao_retentavel", { erro: erroMsg });
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
    return r;
  }

  // erro_retentavel (default): POST comprovadamente nunca saiu, seguro retentar.
  const erroMsg: string = evidence?.erro ?? "Falha do automador (retentavel)";
  const esgotado = novasTentativas >= MAX_TENTATIVAS;
  return await aplicarTransicao(
    esgotado ? "erro_nao_retentavel" : "erro_retentavel",
    {
      erro: erroMsg,
      proximoRetryEm: esgotado ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  );
}

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE_KEY) return true;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE_KEY },
    });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
    );
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

// Watchdog: trata pedidos travados em "enviando_portal" há mais de N minutos.
// Acontece quando o background task (EdgeRuntime.waitUntil) é interrompido.
// PR1: NUNCA reverte para pendente_envio_portal — um pedido travado em
// enviando_portal pode ter submetido um POST antes de o task morrer. Sem
// evidência, o destino seguro é conciliação manual.
async function runWatchdog(supabase: SupabaseClient, minutos = 5) {
  const cutoff = new Date(Date.now() - minutos * 60 * 1000).toISOString();
  const { data: stuck, error } = await supabase
    .from("pedido_compra_sugerido")
    .select("id")
    .eq("empresa", "OBEN")
    .ilike("fornecedor_nome", "%SAYERLACK%")
    .eq("status_envio_portal", "enviando_portal")
    .lt("atualizado_em", cutoff);
  if (error) {
    console.error("[envio-portal][watchdog] erro:", error.message);
    return { conciliacao: 0, erro: error.message };
  }
  let conciliacao = 0;
  const agora = new Date().toISOString();
  for (const p of (stuck ?? []) as Array<{ id: number }>) {
    const erroMsg = `Watchdog: pedido travou em enviando_portal por mais de ${minutos}min — requer conciliacao`;
    await supabase.from("pedido_compra_sugerido").update({
      status_envio_portal: "indeterminado_requer_conciliacao",
      portal_erro: erroMsg,
      portal_proximo_retry_em: null,
    }).eq("id", p.id);
    await gravarTentativa(supabase, p.id, {
      iniciadoEm: agora,
      statusResultado: "indeterminado_requer_conciliacao",
      elapsedMs: null,
      evidence: { phase: "watchdog", motivo: "travado_em_enviando_portal", minutos },
      browserlessResponseMs: null,
      erro: erroMsg,
    });
    conciliacao++;
  }
  console.log(`[envio-portal][watchdog] cutoff=${minutos}min conciliacao=${conciliacao}`);
  return { conciliacao };
}

// Processa lista de candidatos. Pode rodar em foreground (response síncrona)
// ou em background via EdgeRuntime.waitUntil (modo async).
async function processCandidatos(
  supabase: SupabaseClient,
  candidatos: PedidoCandidato[],
): Promise<{ detalhes: ProcessResult[]; sucesso: number; falhasDef: number; falhasTmp: number; indeterminados: number }> {
  const detalhes: ProcessResult[] = [];
  let sucesso = 0;
  let falhasDef = 0;
  let falhasTmp = 0;
  let indeterminados = 0;
  for (const p of candidatos) {
    try {
      const r = await processarPedido(supabase, p);
      detalhes.push(r);
      // sucesso_portal/enviado_portal (legado) = confirmado no portal.
      if (r.status_final === "sucesso_portal" || r.status_final === "enviado_portal") sucesso++;
      // erro_nao_retentavel/falha_envio_portal (legado) = falha definitiva.
      else if (r.status_final === "erro_nao_retentavel" || r.status_final === "falha_envio_portal") falhasDef++;
      // erro_retentavel/pendente_envio_portal (legado) = falha temporaria, volta pra fila.
      else if (r.status_final === "erro_retentavel" || r.status_final === "pendente_envio_portal") falhasTmp++;
      // aceito_portal_sem_protocolo/indeterminado = precisa conciliacao manual.
      else if (r.status_final === "aceito_portal_sem_protocolo" || r.status_final === "indeterminado_requer_conciliacao") indeterminados++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[envio-portal] Excecao no pedido #${p.id}:`, errMsg);
      detalhes.push({
        pedido_id: p.id,
        status_inicial: p.status_envio_portal ?? "pendente_envio_portal",
        status_final: "erro_excecao",
        protocolo: null,
        tentativas: p.portal_tentativas ?? 0,
        erro: errMsg,
        screenshot_url: null,
        duracao_ms: 0,
      });
    }
  }
  return { detalhes, sucesso, falhasDef, falhasTmp, indeterminados };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const tStart = Date.now();
  console.log("[envio-portal] === Iniciando ===");

  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") {
      const txt = await req.text();
      body = txt ? (JSON.parse(txt) as Record<string, unknown>) : {};
    }
  } catch {
    body = {};
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // === MODO WATCHDOG ===
  if (body?.watchdog === true || body?.modo === "watchdog") {
    const minutos = Number.isFinite(body?.minutos) ? Number(body.minutos) : 5;
    const r = await runWatchdog(supabase, minutos);
    return new Response(
      JSON.stringify({ modo: "watchdog", ...r, duracao_ms: Date.now() - tStart }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  }

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
      .in("status_envio_portal", ["pendente_envio_portal", "erro_retentavel"])
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
        .in("status_envio_portal", ["pendente_envio_portal", "erro_retentavel"])
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
        indeterminados: 0,
        duracao_total_ms: Date.now() - tStart,
        detalhes: [],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  }

  // === MODO ASYNC ===
  // Retorna 202 imediato e processa em background via EdgeRuntime.waitUntil.
  // UI faz polling em status_envio_portal. Imune ao cap de 60s do Browserless +
  // ao timeout do edge function caller.
  const asyncMode = body?.async_mode === true || body?.async === true;
  if (asyncMode) {
    // CLAIM ATÔMICO: transiciona p/ enviando_portal SÓ os candidatos que NÃO estão
    // já em voo. Um UPDATE ... RETURNING é atômico (lock de linha + re-avaliação do
    // WHERE após o commit concorrente): se 2 requests competem pelo MESMO pedido
    // (ex.: "aprovar e disparar" + cron de corte no mesmo instante), só um claима;
    // o outro vê enviando_portal e é EXCLUÍDO do RETURNING. Fecha o duplo-envio ao
    // portal (2ª sessão no Browserless → PO duplicado no fornecedor). O `is.null`
    // cobre o pedido fresco (status_envio_portal NULL), que o `neq` sozinho perderia.
    const ids = candidatos.map((c) => c.id);
    // CLAIM via RPC SQL-puro (envio_portal_claim_ids): o .update().or().select() via PostgREST
    // quebrava com 42703 "column pedido_compra_sugerido.status_envio_portal does not exist"
    // (a tradução do .or() em UPDATE) → travava TODO disparo ao portal. A RPC roda o mesmo
    // UPDATE ... WHERE ... RETURNING em SQL puro, atômico (row-lock + re-avaliação do predicado),
    // preservando a proteção anti-duplo-envio.
    const { data: claimedRows, error: claimErr } = await supabase
      .rpc("envio_portal_claim_ids", { p_ids: ids });
    if (claimErr) {
      console.error("[envio-portal][async] Erro no claim atomico:", claimErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao reservar pedidos: ${claimErr.message}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
      );
    }
    const claimedIds = new Set((claimedRows ?? []).map((r) => (r as { id: number }).id));
    const candidatosClaimed = candidatos.filter((c) => claimedIds.has(c.id));
    const jaEmVoo = candidatos.length - candidatosClaimed.length;
    if (jaEmVoo > 0) {
      console.log(`[envio-portal][async] ${jaEmVoo} pedido(s) ja em voo (enviando_portal) — pulados pelo claim atomico`);
    }
    if (candidatosClaimed.length === 0) {
      return new Response(
        JSON.stringify({
          modo,
          async: true,
          accepted: true,
          pedido_ids: [],
          ja_em_voo: jaEmVoo,
          candidatos_encontrados: candidatos.length,
          duracao_total_ms: Date.now() - tStart,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 202 },
      );
    }

    // Dispara em background SÓ os reservados. Erros vão para o log e o watchdog libera depois.
    const bgTask = processCandidatos(supabase, candidatosClaimed)
      .then((r) => {
        console.log(`[envio-portal][async] OK processados=${r.detalhes.length} sucesso=${r.sucesso} falhas=${r.falhasDef + r.falhasTmp} indeterminados=${r.indeterminados}`);
      })
      .catch((e) => {
        console.error("[envio-portal][async] Excecao geral:", e?.message ?? e);
      });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-ignore intencional: EdgeRuntime é global do Deno/Supabase Edge (pode não estar tipado); @ts-expect-error quebraria o deploy se estivesse
    // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- idem acima
      // @ts-ignore
      EdgeRuntime.waitUntil(bgTask);
    }

    return new Response(
      JSON.stringify({
        modo,
        async: true,
        accepted: true,
        pedido_ids: candidatosClaimed.map((c) => c.id),
        ja_em_voo: jaEmVoo,
        candidatos_encontrados: candidatos.length,
        duracao_total_ms: Date.now() - tStart,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 202 },
    );
  }

  // === MODO SÍNCRONO (legado) ===
  // Mesmo CLAIM ATÔMICO do async (ver acima). Hoje não-exercido (todos os callers
  // reais — disparar-pedidos-aprovados e o botão — usam async_mode; o lote cron é
  // no-op), mas fecha a rota: sem isso o processarPedido marcaria enviando_portal de
  // forma incondicional → duplo-envio se 2 síncronos concorressem no mesmo pedido.
  const idsSync = candidatos.map((c) => c.id);
  // CLAIM via RPC SQL-puro (ver MODO ASYNC acima — o .update().or().select() quebrava no PostgREST).
  const { data: claimedSync, error: claimErrSync } = await supabase
    .rpc("envio_portal_claim_ids", { p_ids: idsSync });
  if (claimErrSync) {
    return new Response(
      JSON.stringify({ error: `Falha ao reservar pedidos: ${claimErrSync.message}` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
  const claimedSyncIds = new Set((claimedSync ?? []).map((r) => (r as { id: number }).id));
  const candidatosSync = candidatos.filter((c) => claimedSyncIds.has(c.id));
  const { detalhes, sucesso, falhasDef, falhasTmp, indeterminados } = await processCandidatos(supabase, candidatosSync);

  // Se algum erro foi BROWSERLESS_TOKEN invalido, devolve 500
  const tokenInvalid = detalhes.find((d) => (d.erro ?? "").includes("BROWSERLESS_TOKEN invalido"));
  if (tokenInvalid) {
    return new Response(
      JSON.stringify({ error: tokenInvalid.erro, detalhes }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }

  const duracao = Date.now() - tStart;
  console.log(`[envio-portal] === Sumario === processados=${detalhes.length} sucesso=${sucesso} falhas=${falhasDef + falhasTmp} indeterminados=${indeterminados} duracao_total=${duracao}ms`);

  return new Response(
    JSON.stringify({
      modo,
      candidatos_encontrados: candidatos.length,
      processados: detalhes.length,
      sucesso,
      falhas_definitivas: falhasDef,
      falhas_temporarias: falhasTmp,
      indeterminados,
      duracao_total_ms: duracao,
      detalhes,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
