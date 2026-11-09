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
import { ABRIR_CONSULTA_PEDIDOS } from "../_shared/sayerlack-portal-navegador.ts";
import {
  aplicarFiltrosConsultaDom,
  clicarFiltrarDom,
  lerCondicaoSelecionadaDom,
  lerCondicoesOpcoesDom,
  lerTabelaConsultaDom,
} from "../_shared/sayerlack-portal-dom.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { mensagemNaoVinculado, mensagemVinculado, vincularPoManual } from "../_shared/sayerlack-vincular-po-manual.ts";
import { lerPedidoPortal, mensagemErroImportacao, situacaoFaturada, situacaoObservada, situacaoPermitida, type LinhaConsultaRaw } from "./leitura.ts";
import { comPrazo, cortarTrace, PRAZO_EVIDENCIA_MS } from "./evidencia.ts";
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
  const { user, pass, portalUrl, clienteCodigo, protocolo, somenteSituacao } = context;
  const trace = [];
  const t0 = Date.now();
  const classificarPosLogin = ${classificarPosLogin.toString()};
  // Funções de PÁGINA (seletores) testadas contra HTML real: ../_shared/sayerlack-portal-dom.ts (8.2).
  const aplicarFiltrosConsultaDom = ${aplicarFiltrosConsultaDom.toString()};
  const clicarFiltrarDom = ${clicarFiltrarDom.toString()};
  const lerTabelaConsultaDom = ${lerTabelaConsultaDom.toString()};
  const lerCondicaoSelecionadaDom = ${lerCondicaoSelecionadaDom.toString()};
  const lerCondicoesOpcoesDom = ${lerCondicoesOpcoesDom.toString()};

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
${ABRIR_CONSULTA_PEDIDOS}
    // Filtros: cliente OBEN, nº início = fim, só PEDIDO (não proposta), qualquer situação — o cancelado é LIDO e recusado
    // em Deno (./leitura.ts), para a tela dizer "cancelado" em vez de "não encontrado";
    // datas desde 2020 (o default é só o último mês).
    const filtro = await page.evaluate(aplicarFiltrosConsultaDom, String(clienteCodigo), String(protocolo), String(protocolo), '2020-01-01');
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
      await page.evaluate(clicarFiltrarDom);
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
    const lerConsulta = () => page.evaluate(lerTabelaConsultaDom);

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
    // Só situação (varredura, B3): a consulta basta — itens e detalhe não podem derrubar a gravação de um 6 já lido.
    if (somenteSituacao) {
      return { data: { success: true, consulta: { headers: consulta.headers, linhas: consulta.linhas }, itens: null, condicao: null, condicoes_opcoes: [], trace }, type: 'application/json' };
    }

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

    // Condição de pagamento: só existe na tela de DETALHE (select #condicoes_pagamento, ex. "70 - 7 DIAS"). Carrega a
    // página (GET, o que o founder faz à mão) se ainda não está nela e LÊ o texto selecionado — nenhum clique, nenhum
    // envio. Sem condição legível, o Deno recusa: ausente nunca vira "à vista" (revisão Fable+Codex, 2026-11).
    let condicao = null;
    let condicoesOpcoes = [];
    if (achouNaConsulta && temItens(itens)) {
      if (page.url().indexOf('/order-creation-form-edit/') === -1) {
        await page.goto(portalUrl + '/order-creation-form-edit/' + encodeURIComponent(protocolo) + '/route/order-viewer',
          { waitUntil: 'domcontentloaded', timeout: budgetFor('goto-detalhe-condicao', 30000) });
      }
      condicao = await page.waitForFunction(lerCondicaoSelecionadaDom, { timeout: budgetFor('condicao', 15000), polling: 250 }).then((h) => h.jsonValue()).catch(() => null);
      trace.push({ step: 'condicao', condicao, t: Date.now() - t0 });
      // Lista de opções do select (só leitura): insumo do de-para condição do portal → Omie (D-2).
      condicoesOpcoes = await page.evaluate(lerCondicoesOpcoesDom).catch(() => []);
    }

    return {
      data: { success: true, consulta: { headers: consulta.headers, linhas: consulta.linhas }, itens: itens ? itens.json : null, condicao, condicoes_opcoes: condicoesOpcoes, trace },
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
  /** Texto da condição de pagamento na tela de detalhe do portal ("70 - 7 DIAS"); null = não lida. */
  condicao?: string | null;
  /** Textos de todas as opções do select de condição (insumo do de-para D-2). */
  condicoes_opcoes?: string[];
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
  condicao_pagamento_codigo: string | null;
  condicao_pagamento_descricao: string | null;
}

/**
 * Grava a situação lida pelo escritor único, com 1 nova tentativa se a 1ª der erro (revisão 2, B3: um 6 lido e não
 * gravado deixa a compra liberada pelo estado antigo até outra leitura). NUNCA lança: o desfecho vai na resposta
 * (`situacao_gravada`), no ledger (`detalhes.situacao_gravada`) e no log; a varredura trata `erro` com código 6 como
 * falha da rodada com aviso.
 */
async function gravarSituacaoObservada(
  db: ReturnType<typeof criarCliente>, linhas: LinhaConsultaRaw[], protocolo: string, lidoDe: string, lidoAte: string,
): Promise<"aceita" | "nao_aceita" | "ilegivel" | "erro"> {
  const r = await gravarSituacaoUmaVez(db, linhas, protocolo, lidoDe, lidoAte);
  return r === "erro" ? await gravarSituacaoUmaVez(db, linhas, protocolo, lidoDe, lidoAte) : r;
}

async function gravarSituacaoUmaVez(
  db: ReturnType<typeof criarCliente>, linhas: LinhaConsultaRaw[], protocolo: string, lidoDe: string, lidoAte: string,
): Promise<"aceita" | "nao_aceita" | "ilegivel" | "erro"> {
  const obs = situacaoObservada(linhas, protocolo);
  if (!obs) return "ilegivel";
  try {
    const { data, error } = await db.rpc("sayerlack_registrar_situacao_portal", { p_lido_de: lidoDe, p_lido_ate: lidoAte, p_itens: [obs] });
    if (error) {
      console.error(`[importar-portal] ${protocolo}: situação ${obs.codigo} NÃO gravada: ${error.message}`);
      return "erro";
    }
    const aceitos = (data as { aceitos?: unknown[] } | null)?.aceitos;
    return Array.isArray(aceitos) && aceitos.length > 0 ? "aceita" : "nao_aceita";
  } catch (e) {
    console.error(`[importar-portal] ${protocolo}: situação ${obs.codigo} NÃO gravada: ${mensagemDeErro(e) ?? "erro"}`);
    return "erro";
  }
}

/**
 * B3 pelo botão: pendência aberta em `sayerlack_varredura_falha` com `ultima_em` VENCIDA, para a próxima rodada da
 * varredura reconsultar o protocolo já (a fila é pela tentativa mais antiga). Não lança (o veto não gravado já está
 * na resposta e no ledger); falha aqui só fica no log.
 */
async function abrirPendenciaSituacaoNaoGravada(db: ReturnType<typeof criarCliente>, protocolo: string): Promise<void> {
  const mensagem = `Pedido ${protocolo} está cancelado no portal, mas o bloqueio NÃO foi gravado no pedido do app (2 tentativas): ` +
    `a varredura relê e grava na próxima rodada.`;
  const vencida = new Date(0).toISOString();
  try {
    const { data: atual, error: e1 } = await db.from("sayerlack_varredura_falha").select("protocolo").eq("protocolo", protocolo).maybeSingle();
    if (e1) throw new Error(e1.message);
    const { error } = atual
      ? await db.from("sayerlack_varredura_falha").update({ mensagem, ultima_em: vencida, resolvido_em: null }).eq("protocolo", protocolo)
      : await db.from("sayerlack_varredura_falha").insert({ protocolo, mensagem, primeira_em: new Date().toISOString(), ultima_em: vencida, tentativas: 1 });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(`[importar-portal] ${protocolo}: pendência do 6 não gravado NÃO aberta: ${mensagemDeErro(e) ?? "erro"}`);
  }
}

function criarCliente() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
type Db = ReturnType<typeof criarCliente>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Prazo do disparo: o PO costuma sair em segundos; acima disso a resposta vira "não confirmei" — nunca "não importou". */
const PRAZO_DISPARO_MS = 60_000;

/** Dispara o PO. NÃO lança: rede/prazo viram httpStatus 0 — quem chama já gravou o pedido e precisa responder com ele. */
async function dispararOmie(pedidoId: number): Promise<{ httpStatus: number; body: string }> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/disparar-pedidos-aprovados`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ empresa: "OBEN", pedido_id: pedidoId }),
      signal: AbortSignal.timeout(PRAZO_DISPARO_MS),
    });
    return { httpStatus: resp.status, body: (await resp.text()).slice(0, 800) };
  } catch (e) {
    return { httpStatus: 0, body: mensagemDeErro(e) ?? "disparo sem resposta" };
  }
}

// 4.3 (Codex P2): o enriquecimento vale para TODA saída, inclusive as antecipadas (sonda, gate, 400, 403).
Deno.serve(async (req: Request) => {
  const evid: Evidencia = {};
  return await comSessaoBrowserless(await atender(req, evid), evid);
});

async function atender(req: Request, evid: Evidencia): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: { protocolo?: unknown; situacoes_permitidas?: unknown; somente_situacao?: unknown } = {};
  try {
    body = (await req.json()) as { protocolo?: unknown; situacoes_permitidas?: unknown; somente_situacao?: unknown };
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

  // Lista fechada de situações (só a varredura manda): presente ⇒ a situação RELIDA tem de estar nela antes da RPC.
  let situacoesPermitidas: string[] | null = null;
  if (body?.situacoes_permitidas !== undefined) {
    const v = body.situacoes_permitidas;
    if (!Array.isArray(v) || !v.every((c) => typeof c === "string" && /^\d+$/.test(c))) {
      return json({ ok: false, mensagem: "situacoes_permitidas deve ser lista de códigos numéricos." }, 400);
    }
    situacoesPermitidas = v as string[];
  }

  const db = criarCliente();
  // Ledger de TODA tentativa (botão = manual, varredura = automatica): sucesso e recusa, com sqlstate, motivo e
  // duração (item 2.5 — substitui depender do PostHog, que é bloqueado no navegador do founder).
  const registro = await abrirRegistro(db, auth.via === "staff" ? "manual" : "automatica", operador);
  const t0Registro = Date.now();
  // Evidência da tentativa acumulada FORA da resposta (Codex revisão 2, P2 de B11): toda saída — re-disparo, recusa,
  // catch — leva ao ledger as opções de condição e o desfecho da situação que esta tentativa observou.
  // Só a varredura manda (B3/B5): reler e GRAVAR a situação, sem gravar pedido nem disparar PO.
  const somenteSituacao = body?.somente_situacao === true;
  const origem = auth.via === "staff" ? "manual" : "automatica";
  const resposta = await tratar(db, protocolo, situacoesPermitidas, operador, evid, somenteSituacao, { execucaoId: registro, origem });
  await fecharRegistro(db, registro, resposta, protocolo, Date.now() - t0Registro, evid);
  return resposta;
}

/**
 * 4.3: toda resposta diz se ESTA tentativa abriu sessão no Browserless (`sessao_browserless`), para a varredura contar a
 * cota pelo que aconteceu, não pela chamada (já com PO, recusa antes do portal e config ausente não abrem sessão).
 * `true` é marcado no instante antes do fetch: uma sessão que o fetch abriu e não respondeu ainda conta.
 * Corpo não-JSON passa intacto (a varredura lê a falta do campo como indeterminado, nunca como zero).
 */
async function comSessaoBrowserless(resposta: Response, evid: Evidencia): Promise<Response> {
  const corpo = await resposta.clone().json().catch(() => null);
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return resposta;
  return new Response(JSON.stringify({ ...corpo, sessao_browserless: evid.sessao_browserless === true }), {
    status: resposta.status,
    headers: resposta.headers,
  });
}

/** O corpo da importação. Toda saída é uma Response; o chamador registra o resultado no ledger. */
interface Evidencia {
  condicoes_opcoes?: string[] | null;
  situacao_portal?: string | null;
  situacao_gravada?: string | null;
  /** 4.3: esta tentativa abriu sessão no Browserless (marcado antes do fetch). Ausente = não abriu. */
  sessao_browserless?: boolean;
  /** 7.2: id da linha em `sayerlack_portal_evidencia` (null = não gravou; fail-open). */
  evidencia_id?: number | null;
}

/** Correlação da evidência (7.2): a linha do ledger desta tentativa e quem a pediu. */
interface ContextoEvidencia {
  execucaoId: string | null;
  origem: "manual" | "automatica";
}

/** Desfecho indeterminado (B7): o contrato diz explicitamente "não sei" — nunca falha reconhecida, nunca sqlstate. */
const INDETERMINADO = { desfecho: "indeterminado" } as const;

async function tratar(
  db: Db,
  protocolo: string,
  situacoesPermitidas: string[] | null,
  operador: string | null,
  evid: Evidencia,
  somenteSituacao: boolean,
  ctxEvid: ContextoEvidencia,
): Promise<Response> {
  const estado = async (filtro: { id?: number; protocolo?: string }): Promise<PedidoEstado | null> => {
    let q = db.from("pedido_compra_sugerido")
      .select("id, status, portal_protocolo, omie_pedido_compra_numero, omie_pedido_compra_id, valor_total, num_skus, importado_portal_em, condicao_pagamento_codigo, condicao_pagamento_descricao");
    q = filtro.id != null ? q.eq("id", filtro.id) : q.eq("portal_protocolo", filtro.protocolo as string);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`Leitura do pedido: ${error.message}`);
    return (data as PedidoEstado | null) ?? null;
  };
  const temPo = (p: PedidoEstado) => p.omie_pedido_compra_id != null && String(p.omie_pedido_compra_id).trim() !== "" && String(p.omie_pedido_compra_id).trim() !== "0";
  /**
   * Pedido com PO ⇒ a pendência aberta da varredura para este protocolo está resolvida AGORA, sem esperar a próxima
   * rodada (item 2.7). Fail-open: é a fila de avisos, não o pedido — a rodada seguinte resolve se isto falhar.
   */
  const resolverPendenciaVarredura = async (proto: string) => {
    const { error } = await db.from("sayerlack_varredura_falha").update({ resolvido_em: new Date().toISOString() })
      .eq("protocolo", proto).is("resolvido_em", null);
    if (error) console.warn(`[importar-portal] ${proto}: pendência da varredura não resolvida (fail-open): ${error.message}`);
  };
  const responderComEstado = async (pedidoId: number, extra: Record<string, unknown>) => {
    const p = await estado({ id: pedidoId });
    const comPo = !!p && temPo(p);
    if (comPo) await resolverPendenciaVarredura(protocolo);
    return json({
      ok: comPo,
      etapa: comPo ? "concluido" : "omie",
      pedido_id: pedidoId,
      protocolo,
      status: p?.status ?? null,
      omie_numero: p?.omie_pedido_compra_numero ?? null,
      valor_total: p?.valor_total ?? null,
      condicao: p?.condicao_pagamento_codigo ? `${p.condicao_pagamento_codigo} · ${p.condicao_pagamento_descricao ?? ""}`.trim() : null,
      mensagem: comPo
        ? `Pedido ${protocolo} importado: pedido de compra ${p?.omie_pedido_compra_numero ?? ""} criado no Omie.`
        : `Pedido ${protocolo} gravado no app (#${pedidoId}), mas não confirmei o pedido de compra no Omie (status ${p?.status ?? "?"}). ` +
          `Importe de novo daqui a 1 minuto para conferir e re-disparar — não duplica. Não lance à mão no Omie.`,
      ...extra,
    });
  };

  let pedidoGravado: number | null = null;
  /**
   * Pedido do app JÁ ACHADO por protocolo (revisão 2, B7): guardado no instante em que é achado, para que uma falha
   * depois (espelho de POs, Browserless, leitura) nunca responda sem o #id — a tela diria "não foi importado".
   */
  let pedidoConhecido: { id: number; status: string | null } | null = null;
  /** Pedido já gravado sem PO que pode ser re-disparado — SÓ depois de reler a situação no portal (item 2.1). */
  let redisparar: PedidoEstado | null = null;
  try {
    // 0. Já existe no app? Com PO: devolve o estado. Sem PO e re-disparável: relê o portal ANTES de re-disparar
    //    (cancelado no portal não pode virar PO; Codex A1/D1, 2026-11-06).
    const existente = await estado({ protocolo });
    if (existente) pedidoConhecido = { id: existente.id, status: existente.status };
    // Só situação (varredura): nenhuma das saídas de compra abaixo vale — lê e grava a situação, qualquer estado.
    if (existente && !somenteSituacao) {
      if (temPo(existente)) {
        await resolverPendenciaVarredura(protocolo);
        return json({
          ok: true, etapa: "concluido", ja_existia: true, pedido_id: existente.id, protocolo,
          status: existente.status, omie_numero: existente.omie_pedido_compra_numero, valor_total: existente.valor_total,
          mensagem: `O pedido ${protocolo} já está no app (#${existente.id}) com pedido de compra ${existente.omie_pedido_compra_numero ?? ""} no Omie.`,
        });
      }
      if (!existente.status || !STATUS_REDISPARAVEIS.has(existente.status)) {
        return json({
          ok: false, etapa: "importacao", ja_existia: true, pedido_id: existente.id, protocolo, status: existente.status,
          mensagem: `O pedido ${protocolo} está no app (#${existente.id}) sem pedido de compra no Omie, no status ` +
            `"${existente.status ?? "?"}", que não deixa re-disparar daqui. Abra o pedido #${existente.id} para ver o que ` +
            `aconteceu com ele. Não lance à mão no Omie.`,
        });
      }
      // PO lançado à mão no Omie com este contrato (inclusive composto "a/b") ⇒ não duplica (Codex P1, 2026-11).
      // Protocolo validado só-dígitos: seguro no LIKE.
      const { data: pos, error: errPo } = await db.from("purchase_orders_tracking").select("numero_pedido, numero_contrato_fornecedor")
        .eq("empresa", "OBEN").like("numero_contrato_fornecedor", `%${protocolo}%`).limit(50);
      if (errPo) throw new Error(`Leitura do espelho de POs do Omie: ${errPo.message}`);
      const poManual = ((pos ?? []) as { numero_pedido: string | null; numero_contrato_fornecedor: string | null }[])
        .find((x) => (x.numero_contrato_fornecedor ?? "").split("/").some((c) => c.trim() === protocolo));
      if (poManual) {
        // 7.1: vincula SÓ se a RPC provar que o PO é a compra deste pedido (contrato por token, dono, conteúdo). Erro
        // da RPC lança (cai no catch, sem re-disparo) — nunca "não conferi" vira "pode re-disparar".
        const vinculo = await vincularPoManual(db, existente.id, operador, "importar");
        if (vinculo.vinculado) {
          await resolverPendenciaVarredura(protocolo);
          return json({
            ok: true, etapa: "concluido", ja_existia: true, pedido_id: existente.id, protocolo, status: "disparado",
            motivo: "po_manual_vinculado", omie_numero: vinculo.po_numero ?? null, valor_total: existente.valor_total,
            contrato_composto: vinculo.contrato_composto ?? false,
            mensagem: mensagemVinculado(protocolo, existente.id, vinculo),
          });
        }
        return json({
          ok: false, etapa: "importacao", ja_existia: true, pedido_id: existente.id, protocolo, status: existente.status,
          motivo: "po_manual_no_omie", vinculo_motivo: vinculo.motivo, omie_numero: poManual.numero_pedido ?? null,
          ...(vinculo.diferencas ? { diferencas: vinculo.diferencas } : {}),
          mensagem: mensagemNaoVinculado(protocolo, existente.id, poManual.numero_pedido ?? null, vinculo),
        });
      }
      redisparar = existente;
    }

    const faltando = [
      ["SAYERLACK_PORTAL_USER", SAYERLACK_PORTAL_USER], ["SAYERLACK_PORTAL_PASS", SAYERLACK_PORTAL_PASS],
      ["SAYERLACK_PORTAL_URL", SAYERLACK_PORTAL_URL], ["SAYERLACK_PORTAL_CLIENTE_CODIGO", SAYERLACK_PORTAL_CLIENTE_CODIGO],
      ["BROWSERLESS_TOKEN", BROWSERLESS_TOKEN],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (faltando.length > 0) {
      return json({
        ok: false, etapa: "leitura", protocolo,
        ...(redisparar ? { ja_existia: true, pedido_id: redisparar.id, status: redisparar.status } : {}),
        mensagem: `Configuração ausente: ${faltando.join(", ")}` + (redisparar ? ` — não re-disparei o pedido #${redisparar.id}.` : ""),
      }, 500);
    }

    // 1. Lê o pedido no portal. O intervalo [lidoDe, lidoAte] é o da OBSERVAÇÃO da situação (Onda 5A).
    const t0 = Date.now();
    const lidoDe = new Date(t0).toISOString();
    let envelope: BrowserlessData = {};
    let httpStatus = 0;
    let httpErr: string | null = null;
    evid.sessao_browserless = true;
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
            clienteCodigo: SAYERLACK_PORTAL_CLIENTE_CODIGO, protocolo, somenteSituacao,
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
    const lidoAte = new Date().toISOString();
    // 7.2: o que o portal mostrou fica gravado ANTES de qualquer decisão (sucesso, recusa ou falha de leitura).
    evid.evidencia_id = await gravarEvidencia(db, {
      execucao_id: ctxEvid.execucaoId,
      protocolo,
      pedido_id: pedidoConhecido?.id ?? null,
      origem: ctxEvid.origem,
      somente_situacao: somenteSituacao,
      lido_de: lidoDe,
      lido_ate: lidoAte,
      http_status: httpStatus || null,
      leitura_ok: !httpErr && httpStatus >= 200 && httpStatus < 300 && envelope.success === true,
      erro_tipo: envelope.erroTipo ?? null,
      erro: httpErr ?? envelope.erro ?? null,
      consulta_headers: envelope.consulta?.headers ?? null,
      consulta_linhas: envelope.consulta?.linhas ?? null,
      itens_brutos: envelope.itens ?? null,
      condicao: typeof envelope.condicao === "string" ? envelope.condicao : null,
      condicoes_opcoes: Array.isArray(envelope.condicoes_opcoes) ? envelope.condicoes_opcoes : null,
      trace: cortarTrace(envelope.trace),
    });
    console.log(`[importar-portal] ${protocolo}: Browserless ${Date.now() - t0}ms http=${httpStatus}${httpErr ? ` erro=${httpErr}` : ""} tipo=${envelope.erroTipo ?? "-"}`);

    // Pedido já gravado: toda recusa daqui em diante carrega o #id e diz que NÃO re-disparou (o pedido existe).
    const doExistente = redisparar
      ? { ja_existia: true, pedido_id: redisparar.id, status: redisparar.status }
      : {};
    const naoRedisparei = (porque: string) =>
      `O pedido ${protocolo} está no app (#${redisparar?.id}) sem pedido de compra. ${porque} ` +
      `Por isso não re-disparei o pedido de compra. Não lance à mão no Omie.`;

    if (httpErr || httpStatus < 200 || httpStatus >= 300 || envelope.success !== true) {
      const causa = httpErr ? `navegador remoto: ${httpErr}` : envelope.erro ?? `HTTP ${httpStatus}`;
      return json({
        ok: false, etapa: "leitura", protocolo, erro_tipo: envelope.erroTipo ?? null, ...doExistente,
        mensagem: redisparar
          ? naoRedisparei(`Não consegui reler a situação dele no portal (${causa}), então não sei se segue valendo. Tente de novo mais tarde.`)
          : `Não consegui ler o portal Sayerlack (${causa}). Lembre: o portal fica fora do ar de sábado 12h a segunda 6h.`,
        trace: envelope.trace ?? null,
      });
    }

    // 1b. Situação observada → escritor único (Onda 5A): é o que faz o disparador geral recusar um pedido que só a
    //     reconsulta por número viu cancelado (fora dos 7 dias da varredura) — e o que libera um que voltou a valer.
    const situacaoGravada = await gravarSituacaoObservada(db, envelope.consulta?.linhas ?? [], protocolo, lidoDe, lidoAte);
    evid.condicoes_opcoes = Array.isArray(envelope.condicoes_opcoes) ? envelope.condicoes_opcoes : null;
    evid.situacao_portal = situacaoObservada(envelope.consulta?.linhas ?? [], protocolo)?.texto ?? null;
    evid.situacao_gravada = situacaoGravada;
    // B3 (Codex revisão 2): um 6 lido e NÃO gravado (2 tentativas) não pode ficar só na resposta — vira pendência
    // aberta "vencida" na fila da varredura, que na próxima rodada relê o pedido por número (só situação) e, se a
    // gravação ainda falhar, manda o e-mail (a varredura é quem avisa).
    // Só pelo BOTÃO: chamada da varredura já deixa a rodada vermelha e o e-mail é dela — regravar `ultima_em` vencida
    // aqui desfaria a reserva da reconsulta e monopolizaria a fila (Codex revisão 2, rodada 2).
    if (situacaoGravada === "erro" && situacoesPermitidas === null && !somenteSituacao &&
        situacaoObservada(envelope.consulta?.linhas ?? [], protocolo)?.codigo === "6") {
      await abrirPendenciaSituacaoNaoGravada(db, protocolo);
    }
    if (somenteSituacao) {
      return json({
        ok: situacaoGravada === "aceita" || situacaoGravada === "nao_aceita", etapa: "leitura", protocolo,
        motivo: "somente_situacao", situacao_gravada: situacaoGravada, situacao_portal: evid.situacao_portal,
        ...(pedidoConhecido ? { ja_existia: true, pedido_id: pedidoConhecido.id, status: pedidoConhecido.status } : {}),
        mensagem: `Situação do pedido ${protocolo} relida no portal ("${evid.situacao_portal ?? "ilegível"}"): ${situacaoGravada}. Nada gravado além da situação; nenhum pedido de compra disparado.`,
      });
    }

    // 2. Prova a leitura.
    const lido = lerPedidoPortal(envelope.consulta?.linhas ?? [], envelope.itens, protocolo);
    if (!lido.ok) {
      return json({
        ok: false, etapa: "leitura", protocolo, motivo: lido.motivo, ...doExistente, situacao_gravada: situacaoGravada,
        mensagem: redisparar ? naoRedisparei(lido.detalhe) : lido.detalhe,
        trace: envelope.trace ?? null,
      });
    }
    if (situacoesPermitidas && !situacaoPermitida(lido.cabecalho.situacao, situacoesPermitidas)) {
      return json({
        ok: false, etapa: "leitura", protocolo, motivo: "situacao_nao_permitida", situacao_portal: lido.cabecalho.situacao, ...doExistente,
        situacao_gravada: situacaoGravada,
        mensagem: redisparar
          ? naoRedisparei(`No portal ele está "${lido.cabecalho.situacao}", fora das situações que a varredura re-dispara sozinha.`)
          : `O pedido ${protocolo} está "${lido.cabecalho.situacao}" no portal — fora das situações que a varredura importa.`,
      });
    }

    // 2a. Re-disparo de pedido FATURADO no portal (3 Atendido Total / 7 Fatur Balcão; revisão 2, B2): a NF pode já
    //     estar no Omie — re-disparar arrisca o 2º PO. A importação NOVA segue aceitando (decisão do founder).
    if (redisparar && situacaoFaturada(lido.cabecalho.situacao)) {
      return json({
        ok: false, etapa: "leitura", protocolo, motivo: "faturado_no_portal", situacao_portal: lido.cabecalho.situacao,
        ...doExistente, situacao_gravada: situacaoGravada,
        mensagem: naoRedisparei(`No portal ele está "${lido.cabecalho.situacao}": faturado no portal — confira a NF no Omie antes de qualquer pedido de compra.`),
      });
    }

    // 2b. Re-disparo: a situação relida é importável (cancelado já foi recusado pela leitura) ⇒ o PO pelo caminho
    //     de sempre. Não grava de novo: o pedido e o custo já estão no app.
    if (redisparar) {
      pedidoGravado = redisparar.id;
      const omie = await dispararOmie(redisparar.id);
      return await responderComEstado(redisparar.id, {
        ja_existia: true, disparo_http: omie.httpStatus, situacao_portal: lido.cabecalho.situacao, situacao_gravada: situacaoGravada,
      });
    }

    if (!envelope.condicao || !String(envelope.condicao).trim()) {
      return json({
        ok: false, etapa: "leitura", protocolo, motivo: "condicao_ilegivel", trace: envelope.trace ?? null,
        mensagem: `Não consegui ler a condição de pagamento do pedido ${protocolo} na tela de detalhe do portal. Nada foi gravado — tente de novo.`,
      });
    }

    // 3. Grava (tudo-ou-nada) com a prova de custo.
    const { data: rpcData, error: rpcErr } = await db.rpc("sayerlack_importar_pedido_portal", {
      p_protocolo: protocolo,
      p_data_entrega: lido.cabecalho.data_entrega,
      p_valor_total: lido.cabecalho.valor_total,
      p_itens: lido.itens.map((i) => ({ sku_portal: i.sku_portal, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria })),
      p_operador: operador,
      p_condicao_portal: String(envelope.condicao).trim(),
    });
    const itensResumo = lido.itens.map((i) => ({ sku_portal: i.sku_portal, descricao: i.descricao, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria }));
    if (rpcErr) {
      // Erro SEM sqlstate da casa (rede, gateway): a RPC pode ter COMMITADO antes de a resposta se perder (B7). Relê
      // pelo protocolo — achou ⇒ o pedido existe e a resposta carrega o #id; não dispara daqui (importe de novo).
      if (!/^(IP|CP)\d{3}$/.test(rpcErr.code ?? "") && rpcErr.code !== "42501") {
        let releuOk = true;
        const talvez = await estado({ protocolo }).catch(() => { releuOk = false; return null; });
        // Releitura falhou, ou não achou (a transação pode ainda não ter terminado): NÃO SEI se gravou (Codex B7).
        if (!talvez) {
          return json({
            ok: false, etapa: "importacao", protocolo, ...INDETERMINADO, erro_codigo: rpcErr.code ?? null,
            mensagem: `Não sei se o pedido ${protocolo} foi gravado: a gravação respondeu com erro (${rpcErr.message})` +
              (releuOk ? "" : " e a releitura também falhou") + ". Importe de novo daqui a 1 minuto — não duplica. Não lance à mão no Omie.",
          });
        }
        if (talvez) {
          pedidoConhecido = { id: talvez.id, status: talvez.status };
          return json({
            ok: false, etapa: "importacao", protocolo, ja_existia: false, pedido_id: talvez.id, status: talvez.status,
            sqlstate: rpcErr.code ?? null,
            mensagem: `A gravação do pedido ${protocolo} respondeu com erro (${rpcErr.message}), mas o pedido está no app ` +
              `(#${talvez.id}). Não disparei o pedido de compra daqui: importe de novo daqui a 1 minuto — não duplica. Não lance à mão no Omie.`,
          });
        }
      }
      return json({
        ok: false, etapa: "importacao", protocolo, sqlstate: rpcErr.code ?? null,
        mensagem: mensagemErroImportacao(rpcErr.code, rpcErr.message),
        condicao_portal: envelope.condicao ?? null,
        // Sempre (B11): a lista real de opções é o insumo do de-para e vai ao ledger em toda tentativa, não só no IP007.
        condicoes_opcoes_portal: Array.isArray(envelope.condicoes_opcoes) ? envelope.condicoes_opcoes : null,
        situacao_gravada: situacaoGravada,
        situacao_portal: lido.cabecalho.situacao, valor_total_portal: lido.cabecalho.valor_total, itens: itensResumo,
      });
    }
    const pedidoId = Number((rpcData as { pedido_id?: unknown } | null)?.pedido_id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      // A RPC respondeu sem pedido_id válido: não sei o que ela fez (Codex B7) — indeterminado, nunca "não importado".
      return json({ ok: false, etapa: "importacao", protocolo, ...INDETERMINADO, mensagem: `Não sei se o pedido ${protocolo} foi gravado (resposta inesperada da importação: ${JSON.stringify(rpcData)?.slice(0, 200)}). Importe de novo daqui a 1 minuto — não duplica. Não lance à mão no Omie.` });
    }

    // 4. PO no Omie pelo caminho de sempre, e a resposta é o que o BANCO diz depois. Daqui em diante o pedido EXISTE:
    //    qualquer falha responde "gravado, Omie não confirmado" com o #id — nunca "não foi importado" (Codex+Fable P1:
    //    a mensagem falsa levava o operador a lançar o PO à mão no Omie).
    pedidoGravado = pedidoId;
    // 3b. 1ª importação: o escritor só faz UPDATE e o pedido não existia na gravação de 1b (revisão 2, B10). Grava a
    //     MESMA observação agora — antes do disparo, para o claim já ver o código. Sem vigente, a ordem temporal aceita.
    const situacaoGravadaPosCriar = (rpcData as { ja_existia?: unknown } | null)?.ja_existia === true
      ? situacaoGravada
      : await gravarSituacaoObservada(db, envelope.consulta?.linhas ?? [], protocolo, lidoDe, lidoAte);
    const omie = await dispararOmie(pedidoId);
    console.log(`[importar-portal] ${protocolo}: pedido ${pedidoId} gravado; disparo HTTP ${omie.httpStatus}`);
    return await responderComEstado(pedidoId, {
      ja_existia: (rpcData as { ja_existia?: unknown } | null)?.ja_existia === true,
      disparo_http: omie.httpStatus,
      situacao_portal: lido.cabecalho.situacao,
      valor_total_portal: lido.cabecalho.valor_total,
      condicao_portal: envelope.condicao ?? null,
      condicoes_opcoes_portal: Array.isArray(envelope.condicoes_opcoes) ? envelope.condicoes_opcoes : null,
      situacao_gravada: situacaoGravadaPosCriar,
      itens: itensResumo,
    });
  } catch (e) {
    if (pedidoGravado != null) {
      return json({
        ok: false, etapa: "omie", pedido_id: pedidoGravado, protocolo,
        mensagem: `Pedido ${protocolo} gravado no app (#${pedidoGravado}), mas não confirmei o pedido de compra no Omie ` +
          `(${mensagemDeErro(e) ?? "erro inesperado"}). Importe de novo daqui a 1 minuto — não duplica. Não lance à mão no Omie.`,
      });
    }
    if (pedidoConhecido != null) {
      return json({
        ok: false, etapa: "importacao", ja_existia: true, pedido_id: pedidoConhecido.id, status: pedidoConhecido.status, protocolo,
        mensagem: `O pedido ${protocolo} está no app (#${pedidoConhecido.id}), mas a conferência falhou ` +
          `(${mensagemDeErro(e) ?? "erro inesperado"}). Não re-disparei o pedido de compra. Tente de novo daqui a 1 minuto. Não lance à mão no Omie.`,
      }, 500);
    }
    return json({ ok: false, etapa: "importacao", protocolo, ...INDETERMINADO, mensagem: `Não sei se o pedido ${protocolo} foi gravado (${mensagemDeErro(e) ?? "erro inesperado"}). Importe de novo daqui a 1 minuto — não duplica. Não lance à mão no Omie.` }, 500);
  }
}

const ACAO_REGISTRO = "reposicao.importar_portal_sayerlack";

/** Abre a linha do ledger. Fail-open: o registro é observabilidade, nunca derruba a importação. */
async function abrirRegistro(
  db: Db,
  origem: "manual" | "automatica",
  operador: string | null,
): Promise<string | null> {
  try {
    let nome: string | null = null;
    if (origem === "manual" && operador) {
      const { data } = await db.from("profiles").select("name").eq("user_id", operador).maybeSingle();
      nome = (data as { name?: string } | null)?.name ?? null;
    }
    const { data, error } = await db.from("acoes_execucoes")
      .insert({ acao: ACAO_REGISTRO, origem, executado_por: origem === "manual" ? operador : null, executado_por_nome: nome })
      .select("id").single();
    if (error || !data) {
      console.warn(`[importar-portal] ledger não abriu (fail-open): ${error?.message ?? "sem id"}`);
      return null;
    }
    return (data as { id: string }).id;
  } catch (e) {
    console.warn(`[importar-portal] ledger não abriu (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
    return null;
  }
}

/** Fecha a linha com o que a RESPOSTA disse: `ok: true` é sucesso, qualquer outra coisa é erro (ausente ≠ sucesso). */
async function fecharRegistro(
  db: Db,
  registroId: string | null,
  resposta: Response,
  protocolo: string,
  duracaoMs: number,
  evid: Evidencia,
): Promise<void> {
  if (!registroId) return;
  try {
    const corpo = (await resposta.clone().json().catch(() => null)) as Record<string, unknown> | null;
    const ok = corpo?.ok === true;
    const detalhes = {
      protocolo,
      http: resposta.status,
      etapa: corpo?.etapa ?? null,
      motivo: corpo?.motivo ?? null,
      sqlstate: corpo?.sqlstate ?? null,
      pedido_id: corpo?.pedido_id ?? null,
      omie_numero: corpo?.omie_numero ?? null,
      ja_existia: corpo?.ja_existia ?? null,
      disparo_http: corpo?.disparo_http ?? null,
      condicao_portal: corpo?.condicao_portal ?? null,
      // Revisão 2: B11 (lista real de condições do portal → de-para D-2) e B3 (o veto de cancelamento persistiu?).
      condicoes_opcoes: evid.condicoes_opcoes ?? (Array.isArray(corpo?.condicoes_opcoes_portal) ? corpo.condicoes_opcoes_portal : null),
      situacao_portal: evid.situacao_portal ?? corpo?.situacao_portal ?? null,
      // A resposta da 1ª importação traz a gravação pós-criar (B10); senão vale a da leitura.
      situacao_gravada: corpo?.situacao_gravada ?? evid.situacao_gravada ?? null,
      desfecho: corpo?.desfecho ?? null,
      // 4.3 e 7.2: a sessão do Browserless desta tentativa e a linha da evidência (null = não gravou).
      sessao_browserless: evid.sessao_browserless === true,
      evidencia_id: evid.evidencia_id ?? null,
      evidencia_gravada: evid.evidencia_id != null,
      mensagem: typeof corpo?.mensagem === "string" ? corpo.mensagem.slice(0, 300) : null,
      duracao_ms: duracaoMs,
    };
    const { error } = await db.from("acoes_execucoes")
      .update({ status: ok ? "sucesso" : "erro", finalizado_em: new Date().toISOString(), detalhes })
      .eq("id", registroId);
    if (error) console.warn(`[importar-portal] ledger não fechou (fail-open): ${error.message}`);
  } catch (e) {
    console.warn(`[importar-portal] ledger não fechou (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
  }
}

/**
 * Grava a evidência (7.2) — INSERT-only na tabela imutável. Fail-open: a evidência é auditoria, nunca derruba nem
 * muda a importação; a falha fica no ledger (`evidencia_gravada: false`) e no log.
 */
async function gravarEvidencia(db: Db, linha: Record<string, unknown>): Promise<number | null> {
  try {
    // Codex P1: a evidência está ANTES da gravação da situação e do disparo — um INSERT pendurado não pode segurá-los.
    const r = await comPrazo(db.from("sayerlack_portal_evidencia").insert(linha).select("id").single(), PRAZO_EVIDENCIA_MS);
    if (r === "prazo") {
      console.warn(`[importar-portal] ${linha.protocolo}: evidência sem resposta em ${PRAZO_EVIDENCIA_MS}ms (fail-open; pode ter gravado)`);
      return null;
    }
    const { data, error } = r;
    if (error || !data) {
      console.warn(`[importar-portal] ${linha.protocolo}: evidência não gravada (fail-open): ${error?.message ?? "sem id"}`);
      return null;
    }
    return (data as { id: number }).id;
  } catch (e) {
    console.warn(`[importar-portal] ${linha.protocolo}: evidência não gravada (fail-open): ${mensagemDeErro(e) ?? "erro"}`);
    return null;
  }
}
