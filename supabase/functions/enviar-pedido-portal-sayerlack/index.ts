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

  try {
    trace.push({ step: 'login_start', t: Date.now() - t0 });
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#user', { timeout: 10000 });
    await fillInput('#user', user);
    await fillInput('#password', pass);
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => null),
      clickButtonByText('Entrar'),
    ]);
    if (page.url().includes('/login/401') || page.url().endsWith('/login')) {
      const errorScreenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
      return {
        data: {
          success: false,
          erro: 'Login falhou — credenciais invalidas ou senha expirada',
          erroTipo: 'LOGIN_FAILED',
          urlFinal: page.url(),
          trace,
        },
        type: 'application/json',
        screenshot: errorScreenshot,
      };
    }
    trace.push({ step: 'login_success', t: Date.now() - t0 });

    await page.goto(portalUrl + '/order-creation', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#btnNovoPedido', { timeout: 10000 });
    await page.click('#btnNovoPedido');
    await page.waitForSelector('#select2-cliente-container', { timeout: 10000 });
    trace.push({ step: 'novo_pedido_open', t: Date.now() - t0 });

    await page.click('#select2-cliente-container');
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
      const addItemBtnSel = i === 0
        ? '#panel_novo_pedido button.btn-primary'
        : 'tfoot button.btn-primary';
      await page.click(addItemBtnSel);
      await page.waitForSelector('#select2-it_codigo-container', { timeout: 8000 });
      await page.click('#select2-it_codigo-container');
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
      await page.click('#btnGravarItem');
      await sleep(1200);
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

    const screenshot = await page.screenshot({ type: 'png', fullPage: false, encoding: 'base64' });
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
    const path = `pedido_${pedidoId}_${Date.now()}.png`;
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
      `https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}`,
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

  // 8. Upload screenshot se houver
  if (screenshotB64) {
    result.screenshot_url = await uploadScreenshot(supabase, pedido.id, screenshotB64);
    if (result.screenshot_url) {
      console.log(`[envio-portal] Pedido #${pedido.id}: screenshot uploaded`);
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
