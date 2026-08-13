// Edge function: omie-sonda-recebimento
//
// SONDA DE DIAGNÓSTICO — READ-ONLY ao Omie e ao banco. Não grava nada, não toca o motor de
// reposição, não altera `sku_estoque_atual`. Existe para responder UMA pergunta que trava o
// desenho do receipt-first ledger (spec docs/superpowers/specs/2026-08-13-reposicao-onorder-
// po-recebida-medicao.md, §6):
//
//   244 POs já recebidas seguem em etapa 15. No fluxo NATIVO do Omie, associar itens da NF-e à
//   PO move o pedido para "Recebido Parcialmente"/"Recebido". Então OU etapa-15 é um workflow
//   paralelo ao estado nativo de recebimento, OU a associação item-a-item nunca é feita neste
//   tenant. Até isso ser resolvido, `t4` não pode ser tratado como recebimento.
//
// As 4 sondas, todas sobre as MESMAS POs:
//   S1  ConsultarPedCompra (id nativo) vs. o PesquisarPedCompra já espelhado — o detalhe expõe
//       recebimento por item que a listagem esconde?
//   S2  ConsultarRecebimento (nIdReceb) — a associação item-a-item existe neste tenant?
//   S3  movimento de estoque ligado à NF-e — O SINAL QUE O LEDGER VAI USAR: existe, é
//       consultável, tem produto + local + quantidade?
//   S4  granularidade do saldo pendente + unidade/local do detalhe.
//
// Por que os métodos da S3 são DESCOBERTOS e não assumidos: "nome de endpoint não é contrato"
// (Codex). A edge tenta candidatos e reporta o desfecho de cada um — um método inexistente é
// RESULTADO da medição, não erro da execução. Os candidatos podem vir no corpo
// (`candidatos_movimento`) para iterar a descoberta SEM um novo deploy a cada tentativa; a trava
// `ehMetodoDeLeitura` garante que nada além de consulta chegue ao ERP de produção.
//
// Invocação: POST { empresa?, limite?, pedidos?, incluir_bruto?, candidatos_movimento? }
// Gate: authorizeCronOrStaff.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  caminhosDeChave,
  classificarResposta,
  type Desfecho,
  diffCaminhos,
  ehMetodoDeLeitura,
  etapaDaPO,
  localizarItens,
  normalizarItemPO,
  redigirSegredos,
} from "./sondas.ts";

const corsHeaders = { ...sharedCors, "Access-Control-Allow-Methods": "POST, OPTIONS" };

const URL_PED_COMPRA = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
const URL_RECEB_NFE = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const URL_ESTOQUE = "https://app.omie.com.br/api/v1/estoque/consulta/";
const URL_MOV_ESTOQUE = "https://app.omie.com.br/api/v1/estoque/movestoque/";
const URL_AJUSTE_ESTOQUE = "https://app.omie.com.br/api/v1/estoque/ajuste/";

const MAX_TENTATIVAS = 3;
/** Teto duro de chamadas por execução — a sonda é barata por desenho; estourar isso é bug. */
const MAX_CHAMADAS = 60;
const LIMITE_PADRAO = 3;
const BRUTO_MAX_CHARS = 20_000;

interface Credenciais {
  appKey: string;
  appSecret: string;
}

function credenciais(empresa: string): Credenciais {
  if (empresa === "OBEN") {
    return {
      appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
    };
  }
  return {
    appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "",
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Chamada {
  endpoint: string;
  call: string;
  param: Record<string, unknown>;
}

/**
 * Contador POR EXECUÇÃO. Deliberadamente não é global de módulo: o runtime reaproveita a
 * instância entre requisições, então um contador de módulo seria compartilhado por invocações
 * concorrentes — uma zeraria o teto da outra.
 */
interface Ctx {
  chamadas: number;
}

/**
 * Chama o Omie e devolve o DESFECHO classificado. Fault NÃO lança: para uma sonda, "este método
 * não existe" é o dado que se quer. Lança apenas o que impede medir (credencial, teto, transporte
 * após retries) — e nunca deixa credencial vazar para mensagem de erro.
 */
async function chamarOmie(
  { endpoint, call, param }: Chamada,
  creds: Credenciais,
  ctx: Ctx,
): Promise<Desfecho> {
  if (!ehMetodoDeLeitura(call)) {
    // Defesa em profundidade: no MESMO endpoint de recebimento moram AlterarRecebimento e
    // ConcluirRecebimento. A sonda nunca pode escrever no ERP, nem por candidato vindo do corpo.
    throw new Error(`BLOQUEADO: "${call}" não é método de leitura — a sonda é read-only`);
  }
  if (ctx.chamadas >= MAX_CHAMADAS) {
    throw new Error(`teto de ${MAX_CHAMADAS} chamadas atingido`);
  }
  if (!creds.appKey || !creds.appSecret) {
    throw new Error("credenciais Omie ausentes no ambiente");
  }

  let ultimoErro: unknown = null;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      ctx.chamadas++;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call,
          app_key: creds.appKey,
          app_secret: creds.appSecret,
          param: [param],
        }),
      });
      const texto = await res.text();

      if (res.status === 429) {
        console.warn(`[sonda] 429 em ${call} (tentativa ${tentativa}), aguardando 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`AUTH_ERRO ${res.status} em ${call}`);
      }
      return classificarResposta(res.status, texto);
    } catch (err) {
      ultimoErro = err;
      const msg = mensagemDeErro(err) ?? `falha sem mensagem em ${call}`;
      if (msg.startsWith("AUTH_ERRO")) throw err;
      const espera = 1000 * Math.pow(2, tentativa - 1);
      console.warn(`[sonda] ${call} tentativa ${tentativa}/${MAX_TENTATIVAS}: ${msg}`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoErro ?? new Error(`falha desconhecida em ${call}`);
}

/** Resumo uniforme de um desfecho — o que entra no relatório de todas as sondas. */
function resumirDesfecho(d: Desfecho): Record<string, unknown> {
  switch (d.tipo) {
    case "ok":
      return { desfecho: "ok", caminhos: caminhosDeChave(d.json) };
    case "fault":
      return { desfecho: "fault", faultcode: d.faultcode, faultstring: d.faultstring };
    case "http_erro":
      return { desfecho: "http_erro", status: d.status, corpo: redigirSegredos(d.corpo) };
    case "nao_json":
      return { desfecho: "nao_json", status: d.status, corpo: redigirSegredos(d.corpo) };
  }
}

/**
 * Guarda o payload bruto redigido. Corta por TAMANHO sem reparsear: `JSON.parse` de uma string
 * truncada lança, e uma sonda não pode morrer por causa do próprio anexo de diagnóstico.
 */
function guardarBruto(
  destino: Record<string, unknown>,
  chave: string,
  json: Record<string, unknown>,
): void {
  const texto = redigirSegredos(JSON.stringify(json));
  // Reparsear o texto REDIGIDO (não devolver `json`): o objeto original não passou pela redação.
  destino[chave] = texto.length <= BRUTO_MAX_CHARS
    ? JSON.parse(texto)
    : { truncado: true, chars: texto.length, inicio: texto.slice(0, BRUTO_MAX_CHARS) };
}

/** Itens normalizados de um payload, com o CAMINHO onde foram encontrados (contrato medido). */
function resumirItens(payload: unknown): Record<string, unknown> {
  const achado = localizarItens(payload);
  if (!achado) return { encontrados: false };
  return {
    encontrados: true,
    caminho: achado.caminho,
    n: achado.itens.length,
    itens: achado.itens.slice(0, 12).map(normalizarItemPO),
    chavesDoItem: caminhosDeChave(achado.itens[0] ?? {}),
  };
}

interface LinhaPO {
  omie_codigo_pedido: string | number | null;
  numero_pedido: string | null;
  nid_receb: number | null;
  nfe_chave_acesso: string | null;
  t4_data_recebimento: string | null;
  raw_data: Record<string, unknown> | null;
}

const COLUNAS_PO =
  "omie_codigo_pedido, numero_pedido, nid_receb, nfe_chave_acesso, t4_data_recebimento, raw_data";
const ETAPA_ALVO = "15";
/** 360 POs OBEN têm `t4` hoje (244 delas em etapa 15) — folga sobre isso, longe da capa de 1.000. */
const TETO_FALLBACK = 500;

/**
 * Carrega a amostra de POs etapa-15 já recebidas.
 *
 * O filtro por caminho jsonb aninhado (`raw_data->cabecalho_consulta->>cEtapa`) tem precedente no
 * repo só com UM nível (`metadata->>segmento`, rag-search). Se essa forma não for aceita, o risco
 * não é erro visível — é a query voltar VAZIA e a sonda concluir "não há PO alvo", trocando
 * "não consegui filtrar" por "não existe". Então: tenta o filtro no banco e, se ele falhar OU vier
 * vazio, refaz sem o filtro e resolve a etapa em memória — sempre reportando qual caminho valeu.
 */
async function carregarAmostra(
  supabase: SupabaseClient,
  empresa: string,
  limite: number,
  pedidos: string[] | null,
): Promise<{ linhas: LinhaPO[]; via: "filtro_jsonb" | "fallback_memoria" }> {
  let q = supabase
    .from("purchase_orders_tracking")
    .select(COLUNAS_PO)
    .eq("empresa", empresa)
    .not("t4_data_recebimento", "is", null)
    .eq(`raw_data->cabecalho_consulta->>cEtapa`, ETAPA_ALVO);
  if (pedidos && pedidos.length > 0) q = q.in("numero_pedido", pedidos);
  const { data, error } = await q
    .order("t4_data_recebimento", { ascending: false })
    .limit(limite);

  if (!error && (data?.length ?? 0) > 0) {
    return { linhas: data as LinhaPO[], via: "filtro_jsonb" };
  }
  if (error) {
    console.warn(`[sonda] filtro jsonb recusado (${error.message}) — caindo no fallback`);
  }

  let q2 = supabase
    .from("purchase_orders_tracking")
    .select(COLUNAS_PO)
    .eq("empresa", empresa)
    .not("t4_data_recebimento", "is", null);
  if (pedidos && pedidos.length > 0) q2 = q2.in("numero_pedido", pedidos);
  const { data: todas, error: erro2 } = await q2
    .order("t4_data_recebimento", { ascending: false })
    .limit(TETO_FALLBACK);
  if (erro2) throw new Error(`leitura da amostra: ${erro2.message}`);

  const linhas = ((todas ?? []) as LinhaPO[])
    .filter((l) => etapaDaPO(l.raw_data) === ETAPA_ALVO)
    .slice(0, limite);
  return { linhas, via: "fallback_memoria" };
}

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/**
 * Candidatos da S3 — a descoberta do contrato de MOVIMENTO DE ESTOQUE.
 *
 * Duas decisões que definem o poder de discriminação da sonda:
 *
 * 1. CONTROLE POSITIVO. `ListarPosEstoque` e `ListarSaldoPendente` já rodam em produção
 *    (omie-sync-estoque) e entram com os params EXATOS de lá. Se até eles falharem, o problema é
 *    transporte/credencial — sem esse controle, um fault genérico seria lido como "o Omie não
 *    expõe movimento de estoque", que é justamente a conclusão errada a evitar. Note que os dois
 *    provam, sozinhos, que no MESMO endpoint convivem convenções diferentes de parâmetro
 *    (`nPagina`/`nRegPorPagina` húngaro vs. `pagina`/`registros_por_pagina` snake_case PT) — mais
 *    uma razão para não inferir o param de um método a partir do vizinho.
 *
 * 2. CANDIDATO DESCONHECIDO VAI COM `param: {}`. Parece preguiça, é o contrário: mandar param
 *    chutado colapsa dois desfechos MUITO diferentes num fault só. Com param vazio, "método não
 *    existe" e "falta o parâmetro obrigatório X" chegam como faultstrings distintas — e a segunda
 *    PROVA que o método existe, além de nomear o parâmetro que ele quer. O fault vira contrato.
 */
function candidatosMovimentoPadrao(codProduto: string | null): Chamada[] {
  const lista: Chamada[] = [
    // ── controles positivos (params verbatim de omie-sync-estoque) ──
    {
      endpoint: URL_ESTOQUE,
      call: "ListarPosEstoque",
      param: {
        nPagina: 1,
        nRegPorPagina: 5,
        dDataPosicao: ddmmyyyy(new Date()),
        cExibeTodos: "S",
      },
    },
    {
      endpoint: URL_ESTOQUE,
      call: "ListarSaldoPendente",
      param: { pagina: 1, registros_por_pagina: 5, tipo: "ENTRADA" },
    },
    // ── candidatos: param vazio de propósito (ver nota 2) ──
    { endpoint: URL_ESTOQUE, call: "ListarMovimentos", param: {} },
    { endpoint: URL_ESTOQUE, call: "ListarMovimentoEstoque", param: {} },
    { endpoint: URL_ESTOQUE, call: "ConsultarMovimentoEstoque", param: {} },
    { endpoint: URL_MOV_ESTOQUE, call: "ListarMovimentos", param: {} },
    { endpoint: URL_MOV_ESTOQUE, call: "ListarMovimentoEstoque", param: {} },
    { endpoint: URL_AJUSTE_ESTOQUE, call: "ListarAjustes", param: {} },
    { endpoint: URL_RECEB_NFE, call: "ListarRecebimentos", param: {} },
  ];
  if (codProduto) {
    // Com produto real: se o método existir, a resposta já mostra a FORMA do movimento
    // (produto, local, quantidade, data) — que é o que o ledger precisa da S3.
    lista.push({
      endpoint: URL_ESTOQUE,
      call: "ObterEstoqueProduto",
      param: { nIdProduto: Number(codProduto), dDia: ddmmyyyy(new Date()) },
    });
    lista.push({
      endpoint: URL_ESTOQUE,
      call: "ListarMovimentoProduto",
      param: { nIdProduto: Number(codProduto) },
    });
  }
  return lista;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const ctx: Ctx = { chamadas: 0 };

  try {
    const corpo = await req.json().catch(() => ({})) as Record<string, unknown>;
    const empresa = typeof corpo.empresa === "string" ? corpo.empresa : "OBEN";
    const limite = typeof corpo.limite === "number"
      ? Math.max(1, Math.min(10, corpo.limite))
      : LIMITE_PADRAO;
    const pedidos = Array.isArray(corpo.pedidos) ? corpo.pedidos.map(String) : null;
    const incluirBruto = corpo.incluir_bruto === true;

    const creds = credenciais(empresa);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { linhas: amostra, via: viaAmostra } = await carregarAmostra(
      supabase,
      empresa,
      limite,
      pedidos,
    );
    if (amostra.length === 0) {
      return json({ ok: false, erro: "nenhuma PO etapa-15 com t4 encontrada para a amostra" }, 404);
    }

    const bruto: Record<string, unknown> = {};

    // ── S1 — ConsultarPedCompra vs. o PesquisarPedCompra espelhado ────────────────────────────
    const s1: Record<string, unknown>[] = [];
    for (const po of amostra) {
      const codPed = po.omie_codigo_pedido;
      const linha: Record<string, unknown> = {
        numeroPedido: po.numero_pedido,
        omieCodigoPedido: codPed,
        t4: po.t4_data_recebimento,
      };
      if (codPed == null) {
        linha.desfecho = "sem_id_nativo_no_espelho";
        s1.push(linha);
        continue;
      }
      try {
        const d = await chamarOmie(
          {
            endpoint: URL_PED_COMPRA,
            call: "ConsultarPedCompra",
            param: { nCodPed: Number(codPed) },
          },
          creds,
          ctx,
        );
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          const caminhosDetalhe = caminhosDeChave(d.json);
          const caminhosEspelho = caminhosDeChave(po.raw_data ?? {});
          const dif = diffCaminhos(caminhosDetalhe, caminhosEspelho);
          // A resposta da S1 em uma linha: o que o detalhe tem e a listagem não.
          linha.soNoDetalhe = dif.soEmA;
          linha.soNoEspelho = dif.soEmB;
          linha.itens = resumirItens(d.json);
          linha.itensEspelho = resumirItens(po.raw_data ?? {});
          if (incluirBruto) guardarBruto(bruto, `s1_${po.numero_pedido}`, d.json);
        }
      } catch (err) {
        // Uma PO que falha no transporte não pode levar S2 e S3 junto — medir 2 de 3 sondas é
        // muito melhor do que perder a rodada inteira e ter que pedir outro deploy.
        linha.desfecho = "nao_medido";
        linha.motivo = redigirSegredos(
          mensagemDeErro(err) ?? "falha sem mensagem ao consultar o pedido",
        );
      }
      s1.push(linha);
    }

    // ── S2/S3 — ConsultarRecebimento por nIdReceb ─────────────────────────────────────────────
    const s2: Record<string, unknown>[] = [];
    const notasVistas = new Set<number>();
    for (const po of amostra) {
      const nid = po.nid_receb;
      if (nid == null || notasVistas.has(nid)) continue;
      notasVistas.add(nid);
      const linha: Record<string, unknown> = {
        nidReceb: nid,
        chaveNfe: po.nfe_chave_acesso ? `…${po.nfe_chave_acesso.slice(-8)}` : null,
        deQualPO: po.numero_pedido,
      };
      try {
        const d = await chamarOmie(
          {
            endpoint: URL_RECEB_NFE,
            call: "ConsultarRecebimento",
            param: { nIdReceb: nid, cChaveNfe: po.nfe_chave_acesso ?? "" },
          },
          creds,
          ctx,
        );
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          const caminhos = caminhosDeChave(d.json);
          // A pergunta da S2: existe campo ligando o recebimento a um pedido de compra?
          linha.camposQueCitamPedido = caminhos.filter((c) => /ped|compra|order/i.test(c));
          linha.itens = resumirItens(d.json);
          if (incluirBruto) guardarBruto(bruto, `s2_${nid}`, d.json);
        }
      } catch (err) {
        linha.desfecho = "nao_medido";
        linha.motivo = redigirSegredos(
          mensagemDeErro(err) ?? "falha sem mensagem ao consultar o recebimento",
        );
      }
      s2.push(linha);
    }

    // ── S3 — descoberta do contrato de MOVIMENTO DE ESTOQUE ───────────────────────────────────
    const primeiroProduto = (() => {
      const achado = localizarItens(amostra[0]?.raw_data ?? {});
      return achado ? normalizarItemPO(achado.itens[0] ?? {}).codProduto : null;
    })();
    const candidatos = Array.isArray(corpo.candidatos_movimento)
      ? (corpo.candidatos_movimento as Chamada[])
      : candidatosMovimentoPadrao(primeiroProduto);

    const s3: Record<string, unknown>[] = [];
    for (const cand of candidatos) {
      const linha: Record<string, unknown> = { endpoint: cand.endpoint, call: cand.call };
      try {
        const d = await chamarOmie(cand, creds, ctx);
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          linha.itens = resumirItens(d.json);
          if (incluirBruto) guardarBruto(bruto, `s3_${cand.call}`, d.json);
        }
      } catch (err) {
        // Candidato bloqueado/estourando teto não pode derrubar a medição dos outros.
        linha.desfecho = "nao_medido";
        linha.motivo = mensagemDeErro(err) ?? "falha sem mensagem no candidato";
      }
      s3.push(linha);
    }

    return json({
      ok: true,
      empresa,
      geradoEm: new Date().toISOString(),
      readOnly: true,
      viaAmostra,
      chamadasAoOmie: ctx.chamadas,
      amostra: amostra.map((p) => ({
        numeroPedido: p.numero_pedido,
        omieCodigoPedido: p.omie_codigo_pedido,
        nidReceb: p.nid_receb,
        t4: p.t4_data_recebimento,
      })),
      s1_detalhe_vs_listagem: s1,
      s2_recebimento_por_item: s2,
      s3_movimento_estoque: s3,
      ...(incluirBruto ? { bruto } : {}),
    });
  } catch (err) {
    const msg = mensagemDeErro(err) ?? "falha sem mensagem na sonda";
    console.error(`[sonda] falhou: ${msg}`);
    return json({ ok: false, erro: redigirSegredos(msg), chamadasAoOmie: ctx.chamadas }, 500);
  }
});
