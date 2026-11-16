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
  clicarDetalhePedidoDom,
  lerCondicoesOpcoesDom,
  lerTabelaConsultaDom,
} from "../_shared/sayerlack-portal-dom.ts";
import { diagnosticarCondicaoDom } from "./condicao-dom.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { mensagemNaoVinculado, mensagemVinculado, vincularPoManual } from "../_shared/sayerlack-vincular-po-manual.ts";
import { explicarCondicaoAusente, lerPedidoPortal, mensagemCondicaoAusente, mensagemErroImportacao, situacaoFaturada, situacaoObservada, situacaoPermitida, type LinhaConsultaRaw } from "./leitura.ts";
import { comPrazo, cortarTrace, PRAZO_EVIDENCIA_MS } from "./evidencia.ts";
import { conferirPortal, mensagemRecusa, montarLeitura, resumoDiferencas } from "./conferencia.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const SAYERLACK_PORTAL_CLIENTE_CODIGO = Deno.env.get("SAYERLACK_PORTAL_CLIENTE_CODIGO");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");

const PROTOCOLO_RE = /^\d{6,12}$/;
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
  const diagnosticarCondicaoDom = ${diagnosticarCondicaoDom.toString()};
  const clicarDetalhePedidoDom = ${clicarDetalhePedidoDom.toString()};

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
  // Falha diz ONDE parou (caminho/título, sem query). O screenshot saiu: o Deno nunca o lia e ele gastava a folga final.
  const falha = async (erroTipo, erro, extra) => {
    const onde = await Promise.race([
      page.evaluate(() => ({ caminho: String(location.pathname || '').substring(0, 120), titulo: String(document.title || '').substring(0, 80) })),
      sleep(1000).then(() => null),
    ]).catch(() => null);
    return { data: Object.assign({ success: false, erroTipo, erro, onde, trace }, extra || {}), type: 'application/json' };
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
    // Sem a data desde 2020, vale o default do portal (último mês) e pedido antigo vira "não encontrado" falso.
    if (filtro.emissao !== '2020-01-01') {
      return await falha('FILTRO_NAO_APLICADO', 'Data de emissão inicial não ficou no filtro', { filtro });
    }
    // Trocar o cliente pode disparar uma consulta própria do portal: deixa ela assentar para a resposta esperada
    // abaixo ser a do NOSSO clique, não a da troca de filtro.
    await sleep(1500);
    // Clica e espera a RESPOSTA da consulta (POST /order-viewer/form/list), com 1 nova tentativa se ela não sair,
    // em vez de desistir às cegas em 8 s de tabela vazia.
    const clicarEsperar = async (rotulo) => {
      // Amarrada ao NOSSO nº (a troca de cliente dispara outra consulta) e só vale com HTTP 2xx (500 não é resposta).
      const resp = page.waitForResponse(
        (r) => {
          if (r.url().indexOf('/order-viewer/form/list') === -1 || r.request().method() !== 'POST') return false;
          const corpo = r.request().postData();
          return !corpo || corpo.indexOf(String(protocolo)) !== -1;
        },
        { timeout: budgetFor('resposta-' + rotulo, 60000) },
      ).then((r) => ({ ok: r.status() >= 200 && r.status() < 300, status: r.status() }))
        .catch((e) => ({ ok: false, erro: String((e && e.message) || e).substring(0, 120) }));
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
    let estavel = false;
    let voltas = 0;
    let erroLeitura = null;
    for (let i = 0; i < 60; i++) {
      voltas = i + 1;
      await sleep(500);
      budgetFor('poll-consulta', 1000);
      consulta = await lerConsulta().catch((e) => { erroLeitura = String((e && e.message) || e).substring(0, 120); return consulta; });
      const achou = consulta.linhas.some((l) => Object.keys(l).some((k) => l[k] === String(protocolo)));
      if (consulta.ok && achou && !consulta.processando) { estavel = true; break; }
      // A resposta já chegou: 4 s para o DataTables redesenhar; vazia depois disso é vazia de verdade.
      if (consulta.ok && Date.now() - tFiltro > 4000 && !consulta.processando && consulta.linhas.length === 0) { estavel = true; break; }
    }
    trace.push({ step: 'consulta_lida', headers: consulta.headers, n_linhas: consulta.linhas.length, ok: consulta.ok,
      processando: consulta.processando, estavel, voltas, erro: erroLeitura, t: Date.now() - t0 });
    // Tabela que não estabilizou NÃO é "não encontrado" nem leitura válida (inclusive no só-situação): recusa, tente de novo.
    if (!estavel) {
      return await falha('CONSULTA_ILEGIVEL', 'A tabela da consulta não estabilizou (tente de novo)', { voltas, erro_leitura: erroLeitura });
    }
    // Só situação (varredura, B3): a consulta basta — itens e detalhe não podem derrubar a gravação de um 6 já lido.
    if (somenteSituacao) {
      return { data: { success: true, consulta: { headers: consulta.headers, linhas: consulta.linhas }, itens: null, condicao: null, condicoes_opcoes: [], trace }, type: 'application/json' };
    }

    // Itens: GET de leitura do próprio portal. Se vier vazio sem o pedido aberto, carrega a página de detalhe
    // (só GET — o que o founder faz à mão) e lê de novo. Nenhum clique na tela de detalhe.
    const buscarItens = () => page.evaluate(async (nr, prazo) => {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), prazo);
      try {
        const r = await fetch('/order-creation/busca-itens-pedido/' + encodeURIComponent(nr), {
          credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
          signal: ctrl.signal,
        });
        const txt = await r.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { json = null; }
        return { status: r.status, json, raw: json ? null : txt.substring(0, 300) };
      } catch (e) {
        return { status: 0, json: null, raw: String((e && e.message) || e) };
      } finally {
        clearTimeout(tm);
      }
    }, protocolo, budgetFor('itens', 20000));
    // Diagnóstico dos itens que NÃO vieram (HTML de login, JSON inválido, rede): curto e sem query.
    const diagItens = (b) => (b && !b.json ? String(b.raw || '').substring(0, 120) : null);
    const temItens = (b) => !!(b && b.json && b.json.success === true && Array.isArray(b.json.itens) && b.json.itens.length > 0);

    // Tela de DETALHE: pelo CLIQUE no link do nº na linha da consulta (GET, só leitura) — o goto direto não chega ao
    // detalhe no Browserless (v1.12). Fallback de goto se o link sumiu. Grava url/título/selects no trace: se a leitura
    // falhar de novo, o trace diz ONDE o robô estava (antes era cego: só 'condicao: null').
    const abrirDetalhe = async (via) => {
      const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: budgetFor('detalhe-nav-' + via, 20000) }).catch(() => null);
      // O clique navega: o evaluate pode LANÇAR (contexto destruído) tendo clicado. Lançou ⇒ espera a navegação antes de
      // decidir pelo goto (o caminho provado quebrado), e o erro vai ao trace.
      let erroClique = null;
      const clicou = await page.evaluate(clicarDetalhePedidoDom, String(protocolo))
        .catch((e) => { erroClique = String((e && e.message) || e).substring(0, 120); return null; });
      let resp = clicou === false ? null : await nav;
      const alvoDetalhe = '/order-creation-form-edit/' + String(protocolo) + '/';
      if (page.url().indexOf(alvoDetalhe) === -1) {
        resp = await page.goto(portalUrl + '/order-creation-form-edit/' + encodeURIComponent(protocolo) + '/route/order-viewer',
          { waitUntil: 'domcontentloaded', timeout: budgetFor('detalhe-goto-' + via, 30000) });
      }
      // Espera o portal terminar de carregar opções e itens antes de ler o select (nunca ler a opção-padrão de passagem).
      const idleOk = await page.waitForNetworkIdle({ idleTime: 750, timeout: budgetFor('detalhe-idle-' + via, 10000) })
        .then(() => true).catch(() => false);
      // C16: status e caminho FINAL (redirect para login/home aparece aqui), sem query.
      trace.push({ step: 'detalhe_aberto', via, via_clique: clicou, erro_clique: erroClique, idle_ok: idleOk, status: resp ? resp.status() : null, caminho: (function() { try { return new URL(page.url()).pathname; } catch (e) { return null; } })(), t: Date.now() - t0 });
    };

    let itens = null;
    const achouNaConsulta = consulta.linhas.some((l) => Object.keys(l).some((k) => l[k] === String(protocolo)));
    if (achouNaConsulta) {
      itens = await buscarItens();
      trace.push({ step: 'itens_direto', status: itens.status, ok: temItens(itens), erro: diagItens(itens), t: Date.now() - t0 });
      if (!temItens(itens)) {
        await abrirDetalhe('itens');
        await sleep(1000);
        itens = await buscarItens();
        trace.push({ step: 'itens_pos_detalhe', status: itens.status, ok: temItens(itens), erro: diagItens(itens), t: Date.now() - t0 });
      }
    }

    // Condição de pagamento: só existe na tela de DETALHE (select #condicoes_pagamento, ex. "70 - 7 DIAS"). Abre a
    // página pelo link do nº (GET, o clique que o founder faz à mão) se ainda não está nela e LÊ o texto selecionado —
    // nenhum clique de gravação, nenhum envio. Sem condição legível, o Deno recusa: ausente nunca vira "à vista" (revisão Fable+Codex, 2026-11).
    let condicao = null;
    let condicoesOpcoes = [];
    let condicaoDiag = null;
    if (achouNaConsulta && temItens(itens)) {
      if (page.url().indexOf('/order-creation-form-edit/') === -1) await abrirDetalhe('condicao');
      condicao = await page.waitForFunction(lerCondicaoSelecionadaDom, { timeout: budgetFor('condicao', 15000), polling: 250 }).then((h) => h.jsonValue()).catch(() => null);
      // A condição só vale lida na tela DESTE pedido e ESTÁVEL: uma 2ª amostra 1,2 s depois tem de repetir o texto (o
      // portal pode mostrar uma seleção de passagem antes de aplicar a do pedido). Divergiu ou outra tela ⇒ sem condição
      // (o Deno recusa; ausente nunca vira condição). Revisão final Codex+Fable, 2026-11-14.
      const naTelaDoPedido = page.url().indexOf('/order-creation-form-edit/' + String(protocolo) + '/') !== -1;
      let condicao2 = null;
      if (condicao) {
        await sleep(1200);
        condicao2 = await page.evaluate(lerCondicaoSelecionadaDom).catch(() => null);
      }
      const condicaoEstavel = !!condicao && condicao2 === condicao && naTelaDoPedido;
      trace.push({ step: 'condicao', condicao, condicao2, na_tela_do_pedido: naTelaDoPedido, estavel: condicaoEstavel, t: Date.now() - t0 });
      if (!condicaoEstavel) condicao = null;
      // Lista de opções do select (só leitura): insumo do de-para condição do portal → Omie (D-2).
      condicoesOpcoes = await page.evaluate(lerCondicoesOpcoesDom).catch(() => []);
      // C16: sem condição, o retrato da tela vai para a evidência — 13 leituras recusaram sem dizer o que a tela tinha.
      if (!condicao) {
        condicaoDiag = await page.evaluate(diagnosticarCondicaoDom).catch((e) => ({ erro: String((e && e.message) || e).substring(0, 160) }));
        trace.push({ step: 'condicao_diag', diag: condicaoDiag, t: Date.now() - t0 });
      }
    }

    return {
      data: { success: true, consulta: { headers: consulta.headers, linhas: consulta.linhas }, itens: itens ? itens.json : null, condicao, condicoes_opcoes: condicoesOpcoes, condicao_diag: condicaoDiag, trace },
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
  /** C16: retrato da tela de detalhe quando a condição não veio (`diagnosticarCondicaoDom`). */
  condicao_diag?: unknown;
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
  /** Codex 2 (v1.16): o "6" lido precisou da 2ª tentativa de evidência — e se ela ficou gravada. Ausente = 1ª bastou. */
  evidencia_cancelado?: "regravada" | "nao_gravada";
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
      // Sem PO manual no ESPELHO: só vale se o espelho estiver fresco. PO lançado à mão depois do último sync seria
      // invisível aqui e o re-disparo criaria um 2º PO (Codex P1 + Fable P1, revisão final 2026-11-14).
      const sync = await syncPedidosCompras(db);
      if (!sync.fresco) {
        return json({
          ok: false, etapa: "importacao", ja_existia: true, pedido_id: existente.id, protocolo, status: existente.status,
          motivo: "espelho_omie_defasado", sync_pedidos_em: sync.em,
          mensagem: mensagemEspelhoDefasado(protocolo, sync.em),
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
    const situacaoLida = situacaoObservada(envelope.consulta?.linhas ?? [], protocolo)?.codigo ?? null;
    const linhaEvidencia = {
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
      // Codex 2 (v1.16): a situação LIDA, em coluna dedicada — é o que a importação de OUTRA leitura consulta (IP010)
      // quando este cancelamento chega antes de o pedido existir (o escritor da situação só faz UPDATE no pedido).
      situacao_codigo: situacaoLida,
    };
    evid.evidencia_id = await gravarEvidencia(db, linhaEvidencia);
    // Codex 2 (P1-2): a evidência é fail-open, mas um "6" que não ficou gravado é o veto que some quando o pedido ainda
    // não existe — a importação (IP010) e o claim só consultam a EVIDÊNCIA. Tenta de novo com a linha MÍNIMA do veto
    // (sem os jsonb da tela: o que pesa no INSERT; rodada 2) — o prazo pode ter vencido com o INSERT esperando a
    // importação em voo do MESMO protocolo, e duplicar a linha imutável é inofensivo. Ainda falhando, pelo BOTÃO abre
    // a pendência da varredura para reler (pela varredura, a rodada já relê; regravar a fila a monopolizaria — B3).
    if (situacaoLida === "6" && evid.evidencia_id == null) {
      evid.evidencia_id = await gravarEvidencia(db, {
        execucao_id: linhaEvidencia.execucao_id, protocolo, pedido_id: linhaEvidencia.pedido_id, origem: linhaEvidencia.origem,
        somente_situacao: somenteSituacao, lido_de: lidoDe, lido_ate: lidoAte, http_status: linhaEvidencia.http_status,
        leitura_ok: linhaEvidencia.leitura_ok, situacao_codigo: situacaoLida,
      });
      evid.evidencia_cancelado = evid.evidencia_id == null ? "nao_gravada" : "regravada";
      if (evid.evidencia_id == null && situacoesPermitidas === null && !somenteSituacao) {
        await abrirPendenciaSituacaoNaoGravada(db, protocolo);
      }
    }
    console.log(`[importar-portal] ${protocolo}: Browserless ${Date.now() - t0}ms http=${httpStatus}${httpErr ? ` erro=${httpErr}` : ""} tipo=${envelope.erroTipo ?? "-"}`);

    // Pedido já gravado: toda recusa daqui em diante carrega o #id e diz que NÃO re-disparou (o pedido existe).
    const doExistente = redisparar
      ? { ja_existia: true, pedido_id: redisparar.id, status: redisparar.status }
      : {};
    const naoRedisparei = (porque: string, pedidoId: number | undefined = redisparar?.id) =>
      `O pedido ${protocolo} está no app (#${pedidoId}) sem pedido de compra. ${porque} ` +
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

    // 2b. 5.2 (revisão 2, fatia 1): antes de QUALQUER re-disparo, o pedido do app × ESTA leitura (SKU, quantidade,
    //     valor por item, total e condição) pela RPC que é a escritora única do retrato e da divergência. Divergiu
    //     ⇒ não dispara (e o claim do disparador também recusa, pelo gate na linha do pedido). Condição ilegível,
    //     recusa ou erro da conferência ⇒ também não (fail-closed: "não conferi" nunca vira "pode disparar").
    const condicaoLida = typeof envelope.condicao === "string" ? envelope.condicao.trim() : "";
    const conferirOuRecusar = async (pedidoId: number, status: string | null): Promise<Response | null> => {
      const doPedido = { ja_existia: true, pedido_id: pedidoId, status, situacao_gravada: situacaoGravada };
      if (!condicaoLida) {
        const ausente = explicarCondicaoAusente(envelope.condicao_diag);
        return json({
          ok: false, etapa: "leitura", protocolo, motivo: "condicao_ilegivel", causa_condicao: ausente.causa, ...doPedido,
          condicao_diag: envelope.condicao_diag ?? null, trace: envelope.trace ?? null,
          mensagem: naoRedisparei(
            `Não conferi a condição de pagamento dele no portal: ${ausente.porque} Sem isso não sei se o pedido mudou.` +
              (ausente.repetirResolve ? " Tente de novo." : ""),
            pedidoId,
          ),
        });
      }
      const conf = await conferirPortal(
        db, pedidoId,
        montarLeitura(protocolo, lido.itens, lido.cabecalho.valor_total, condicaoLida, lidoDe, lidoAte),
        evid.evidencia_id ?? null,
      );
      if (conf.tipo === "bate") return null;
      if (conf.tipo === "divergente") {
        return json({
          ok: false, etapa: "leitura", protocolo, motivo: "alterado_no_portal", ...doPedido,
          divergencia_id: conf.divergenciaId, diferencas: conf.diferencas, situacao_portal: lido.cabecalho.situacao,
          mensagem: naoRedisparei(
            `O pedido mudou no portal desde que entrou no app (${resumoDiferencas(conf.diferencas)}). Confira com o ` +
              `fornecedor: o pedido de compra só sai depois de aceitar o portal ou de o portal voltar ao que está no app.`,
            pedidoId,
          ),
        });
      }
      if (conf.motivo === "tem_po") return await responderComEstado(pedidoId, { ja_existia: true });
      return json({
        ok: false, etapa: "importacao", protocolo, motivo: conf.motivo, ...doPedido,
        mensagem: naoRedisparei(mensagemRecusa(conf.motivo), pedidoId),
      });
    };

    // 2c. Re-disparo: a situação relida é importável (cancelado já foi recusado pela leitura) e o conteúdo bate ⇒ o PO
    //     pelo caminho de sempre. Não grava de novo: o pedido e o custo já estão no app.
    if (redisparar) {
      const recusa = await conferirOuRecusar(redisparar.id, redisparar.status);
      if (recusa) return recusa;
      pedidoGravado = redisparar.id;
      const omie = await dispararOmie(redisparar.id);
      return await responderComEstado(redisparar.id, {
        ja_existia: true, disparo_http: omie.httpStatus, situacao_portal: lido.cabecalho.situacao, situacao_gravada: situacaoGravada,
      });
    }

    if (!envelope.condicao || !String(envelope.condicao).trim()) {
      const ausente = mensagemCondicaoAusente(protocolo, envelope.condicao_diag);
      return json({
        ok: false, etapa: "leitura", protocolo, motivo: "condicao_ilegivel", causa_condicao: ausente.causa,
        condicao_diag: envelope.condicao_diag ?? null, trace: envelope.trace ?? null,
        mensagem: ausente.mensagem,
      });
    }

    // Protocolo que já teve tentativa antes (o app pode ter orientado lançar à mão): o IP006 da RPC só enxerga PO
    // manual que o sync já trouxe — com o espelho velho, recusa em vez de arriscar 2º PO (revisão final 2026-11-14).
    if (await houveTentativaAnterior(db, protocolo, evid.evidencia_id ?? null)) {
      const sync = await syncPedidosCompras(db);
      if (!sync.fresco) {
        return json({
          ok: false, etapa: "importacao", protocolo, motivo: "espelho_omie_defasado", sync_pedidos_em: sync.em,
          mensagem: mensagemEspelhoDefasado(protocolo, sync.em),
        });
      }
    }

    // 3. Grava (tudo-ou-nada) com a prova de custo.
    const { data: rpcData, error: rpcErr } = await db.rpc("sayerlack_importar_pedido_portal", {
      p_protocolo: protocolo,
      p_data_entrega: lido.cabecalho.data_entrega,
      p_valor_total: lido.cabecalho.valor_total,
      p_itens: lido.itens.map((i) => ({ sku_portal: i.sku_portal, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria })),
      p_operador: operador,
      p_condicao_portal: String(envelope.condicao).trim(),
      // Codex 2 (v1.16): o início DESTA leitura — cancelamento visto por outra leitura depois dele recusa (IP010).
      p_lido_de: lidoDe,
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
    // 3a. A RPC achou o pedido JÁ gravado (outra aba importou durante esta leitura; Codex 5.2 P1): esta chamada vira
    //     um re-disparo — valem as mesmas recusas (faturado no portal) e a mesma conferência antes do disparo. Na
    //     importação nova, o retrato desta leitura já nasceu dentro da RPC (mesma transação do pedido).
    const jaExistia = (rpcData as { ja_existia?: unknown } | null)?.ja_existia === true;
    if (jaExistia) {
      pedidoConhecido = { id: pedidoId, status: null };
      if (situacaoFaturada(lido.cabecalho.situacao)) {
        return json({
          ok: false, etapa: "leitura", protocolo, motivo: "faturado_no_portal", situacao_portal: lido.cabecalho.situacao,
          ja_existia: true, pedido_id: pedidoId, situacao_gravada: situacaoGravada,
          mensagem: naoRedisparei(`No portal ele está "${lido.cabecalho.situacao}": faturado no portal — confira a NF no Omie antes de qualquer pedido de compra.`, pedidoId),
        });
      }
      const recusa = await conferirOuRecusar(pedidoId, null);
      if (recusa) return recusa;
    }
    pedidoGravado = pedidoId;
    // 3b. 1ª importação: o escritor só faz UPDATE e o pedido não existia na gravação de 1b (revisão 2, B10). Grava a
    //     MESMA observação agora — antes do disparo, para o claim já ver o código. Sem vigente, a ordem temporal aceita.
    const situacaoGravadaPosCriar = jaExistia
      ? situacaoGravada
      : await gravarSituacaoObservada(db, envelope.consulta?.linhas ?? [], protocolo, lidoDe, lidoAte);
    const omie = await dispararOmie(pedidoId);
    console.log(`[importar-portal] ${protocolo}: pedido ${pedidoId} gravado; disparo HTTP ${omie.httpStatus}`);
    return await responderComEstado(pedidoId, {
      ja_existia: jaExistia,
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
      // 5.2: a divergência portal × app que impediu o re-disparo (a linha da tabela tem o diff inteiro).
      divergencia_id: corpo?.divergencia_id ?? null,
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
/** Espelho de POs do Omie "fresco" = último sync COMPLETE de pedidos de compra OBEN há menos de 2 h (mesmo teto do 7.1). */
const SYNC_FRESCO_MS = 2 * 60 * 60 * 1000;
async function syncPedidosCompras(db: Db): Promise<{ fresco: boolean; em: string | null }> {
  const { data, error } = await db.from("sync_state").select("status, last_sync_at")
    .eq("entity_type", "pedidos_compra").eq("account", "oben").maybeSingle();
  if (error) throw new Error(`Leitura do sync de pedidos de compra: ${error.message}`);
  const r = data as { status?: string | null; last_sync_at?: string | null } | null;
  const em = r?.status === "complete" && r.last_sync_at ? r.last_sync_at : null;
  const ms = em ? Date.parse(em) : NaN;
  return { fresco: Number.isFinite(ms) && Date.now() - ms < SYNC_FRESCO_MS, em };
}

/** Já houve leitura deste protocolo ANTES da atual (evidência imutável)? Erro de leitura lança — nunca vira "não houve". */
async function houveTentativaAnterior(db: Db, protocolo: string, evidenciaAtual: number | null): Promise<boolean> {
  let q = db.from("sayerlack_portal_evidencia").select("id").eq("protocolo", protocolo);
  if (evidenciaAtual !== null) q = q.lt("id", evidenciaAtual);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`Leitura das tentativas anteriores: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

function mensagemEspelhoDefasado(protocolo: string, em: string | null): string {
  return `O pedido ${protocolo} já teve tentativa antes, e o espelho de pedidos de compra do Omie está sem sync recente ` +
    `(${em ? "último: " + em : "sem sync completo"}). Se alguém lançou o PO à mão, ele ainda não apareceria aqui e ` +
    `eu criaria um segundo. Espere o próximo sync de pedidos de compra e importe de novo.`;
}

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
