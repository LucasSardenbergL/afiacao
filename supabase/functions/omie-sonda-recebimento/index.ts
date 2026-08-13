// Edge function: omie-sonda-recebimento
//
// SONDA DE DIAGNÓSTICO — READ-ONLY ao Omie e ao banco. Não grava nada, não toca o motor de
// reposição, não altera `sku_estoque_atual`. Existe para responder a pergunta que trava o desenho
// do receipt-first ledger (spec docs/superpowers/specs/2026-08-13-reposicao-onorder-po-recebida-
// medicao.md, §6):
//
//   244 POs já recebidas seguem em etapa 15. No fluxo NATIVO do Omie, associar itens da NF-e à
//   PO move o pedido para "Recebido Parcialmente"/"Recebido". Então OU etapa-15 é um workflow
//   paralelo ao estado nativo, OU a associação item-a-item nunca é feita neste tenant.
//
// Há uma TERCEIRA hipótese, levantada pelo Codex e sustentada pelo próprio código do espelho:
// `omie-sync-nfes-recebidas` monta o vínculo PO↔NF-e a partir de `itensInfoAdic.nNumPedCompra`
// — uma referência TEXTUAL escrita pelo fornecedor no XML — e não dos ids nativos
// `nIdPedido`/`nIdItPedido`. Se for esse o caso dominante, o `t4` do espelho é INFERÊNCIA NOSSA,
// não recebimento do Omie, e a etapa-15 deixa de ser contradição. Por isso a S2 classifica CADA
// item numa taxonomia de vínculo, em vez de só perguntar "o campo existe?".
//
// As sondas, todas sobre as MESMAS POs:
//   S1  ConsultarPedCompra (id nativo) × PesquisarPedCompra espelhado — o detalhe expõe
//       recebimento por item que a listagem esconde?
//   S2  ConsultarRecebimento (nIdReceb) — taxonomia de vínculo por item + estado CORRENTE do
//       recebimento (cRecebido/cCancelada/cEtapa) contra o `t4` local, que é histórico e nunca
//       é limpo em reversão.
//   S3  movimento de estoque — O SINAL QUE O LEDGER VAI USAR. Métodos descobertos em duas
//       camadas: `{}` para a taxonomia do fault, e params reais (produto, período, local) para
//       a forma do dado.
//   S4  unidade, local e granularidade do saldo pendente.
//
// SEGURANÇA: o destino é um ENUM fechado (`urlDoServico`), nunca dado de entrada — a edge envia
// app_key/app_secret no corpo, então URL vinda da invocação seria exfiltração de credencial.
// A allowlist de método (`ehMetodoDeLeitura`) é a segunda camada: no MESMO serviço de recebimento
// moram AlterarRecebimento e ConcluirRecebimento.
//
// Invocação: POST { empresa?, limite?, pedidos?, incluir_bruto?, candidatos_movimento? }
// Gate: authorizeCronOrStaff.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  buscarValorProfundo,
  caminhosDeChave,
  type ClasseAssociacao,
  classificarAssociacao,
  classificarResposta,
  type Desfecho,
  diffCaminhos,
  ehMetodoDeLeitura,
  escolherPorNotaDiversa,
  etapaDaPO,
  idNativo,
  localizarItens,
  normalizarItemPO,
  normalizarItemRecebimento,
  redigirSegredos,
  servicosConhecidos,
  urlDoServico,
} from "./sondas.ts";

const corsHeaders = { ...sharedCors, "Access-Control-Allow-Methods": "POST, OPTIONS" };

const MAX_TENTATIVAS = 3;
/** Teto duro de chamadas por execução — a sonda é barata por desenho; estourar isso é bug. */
const MAX_CHAMADAS = 80;
const LIMITE_PADRAO = 3;
const BRUTO_MAX_CHARS = 40_000;
/** Itens normalizados no relatório. Alto de propósito: uma associação no item 26 não pode sumir. */
const ITENS_NO_RELATORIO = 200;

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

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function somarDias(d: Date, dias: number): Date {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + dias);
  return x;
}

/** Chamada ao Omie. `servico` é chave do enum — NUNCA uma URL. */
interface Chamada {
  servico: string;
  call: string;
  param: Record<string, unknown>;
  /** Rótulo para o relatório quando o mesmo método é tentado com params diferentes. */
  nota?: string;
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
 * não existe" é o dado que se quer. Lança apenas o que impede medir (destino inválido, método de
 * escrita, credencial, teto, transporte após retries).
 */
async function chamarOmie(
  { servico, call, param }: Chamada,
  creds: Credenciais,
  ctx: Ctx,
): Promise<Desfecho> {
  const endpoint = urlDoServico(servico);
  if (endpoint === null) {
    throw new Error(
      `BLOQUEADO: serviço "${servico}" não está no enum — conhecidos: ${
        servicosConhecidos().join(", ")
      }`,
    );
  }
  if (!ehMetodoDeLeitura(call)) {
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
      if (msg.startsWith("AUTH_ERRO") || msg.startsWith("BLOQUEADO")) throw err;
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
 * Guarda o payload bruto redigido. Corta por TAMANHO sem reparsear o texto cortado: `JSON.parse`
 * de string truncada lança, e a sonda não pode morrer por causa do próprio anexo de diagnóstico.
 */
function guardarBruto(
  destino: Record<string, unknown>,
  chave: string,
  payload: Record<string, unknown>,
): void {
  const texto = redigirSegredos(JSON.stringify(payload));
  // Reparsear o texto REDIGIDO (não devolver o objeto): o original não passou pela redação.
  destino[chave] = texto.length <= BRUTO_MAX_CHARS
    ? JSON.parse(texto)
    : { truncado: true, chars: texto.length, inicio: texto.slice(0, BRUTO_MAX_CHARS) };
}

/** Itens de PO normalizados, com o CAMINHO onde foram encontrados (contrato medido). */
function resumirItensPO(payload: unknown): Record<string, unknown> {
  const achado = localizarItens(payload);
  if (!achado) return { encontrados: false };
  return {
    encontrados: true,
    caminho: achado.caminho,
    n: achado.itens.length,
    itens: achado.itens.slice(0, ITENS_NO_RELATORIO).map(normalizarItemPO),
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
/** 360 POs OBEN têm `t4` hoje (244 em etapa 15) — folga sobre isso, longe da capa de 1.000. */
const TETO_LEITURA = 500;

/**
 * Carrega POs etapa-15 já recebidas, de NOTAS DISTINTAS.
 *
 * Duas armadilhas evitadas aqui:
 *
 * 1. O filtro por caminho jsonb aninhado tem precedente no repo só com UM nível
 *    (`metadata->>segmento`, rag-search). Se a forma não for aceita, o risco não é erro visível —
 *    é a query voltar VAZIA e a sonda concluir "não há PO alvo", trocando "não consegui filtrar"
 *    por "não existe". Por isso há fallback em memória, e o caminho usado vai no relatório.
 * 2. "As N POs mais recentes" tende a pegar N POs da MESMA nota: 94% das POs alvo dividem nota.
 *    A S2 rodaria uma vez só. `escolherPorNotaDiversa` garante notas distintas e cobre os dois
 *    extremos da consolidação.
 */
async function carregarAmostra(
  supabase: SupabaseClient,
  empresa: string,
  limite: number,
  pedidos: string[] | null,
): Promise<{ linhas: LinhaPO[]; via: string; candidatasLidas: number }> {
  const base = () => {
    let q = supabase
      .from("purchase_orders_tracking")
      .select(COLUNAS_PO)
      .eq("empresa", empresa)
      .not("t4_data_recebimento", "is", null);
    if (pedidos && pedidos.length > 0) q = q.in("numero_pedido", pedidos);
    return q;
  };

  const { data, error } = await base()
    .eq(`raw_data->cabecalho_consulta->>cEtapa`, ETAPA_ALVO)
    .order("t4_data_recebimento", { ascending: false })
    .limit(TETO_LEITURA);

  let candidatas: LinhaPO[];
  let via: string;
  if (!error && (data?.length ?? 0) > 0) {
    candidatas = data as LinhaPO[];
    via = "filtro_jsonb";
  } else {
    if (error) {
      console.warn(`[sonda] filtro jsonb recusado (${error.message}) — caindo no fallback`);
    }
    const { data: todas, error: erro2 } = await base()
      .order("t4_data_recebimento", { ascending: false })
      .limit(TETO_LEITURA);
    if (erro2) throw new Error(`leitura da amostra: ${erro2.message}`);
    candidatas = ((todas ?? []) as LinhaPO[]).filter((l) => etapaDaPO(l.raw_data) === ETAPA_ALVO);
    via = "fallback_memoria";
  }

  // Quando o chamador pediu POs específicas, respeitar a escolha dele — não diversificar.
  const linhas = pedidos && pedidos.length > 0
    ? candidatas.slice(0, limite)
    : escolherPorNotaDiversa(candidatas, limite);
  return { linhas, via, candidatasLidas: candidatas.length };
}

/**
 * Candidatos da S3 — descoberta do contrato de MOVIMENTO DE ESTOQUE, em duas camadas.
 *
 * Camada A (`param: {}`): serve para a TAXONOMIA DO FAULT. "falta o parâmetro obrigatório X" é
 * evidência forte de que o método EXISTE e ainda nomeia o que ele quer; "método não encontrado"
 * rejeita aquele nome naquele serviço. O que `{}` NÃO faz é medir dado — por isso não é a única
 * camada, correção que veio do Codex.
 *
 * Camada B (params reais): produto, período e local de verdade, para ver a FORMA do movimento —
 * é isso que decide se o `stock_posting` do ledger é alimentável.
 *
 * Os controles positivos (`ListarPosEstoque`, `ListarSaldoPendente`) usam os params verbatim de
 * `omie-sync-estoque`. Sem eles, um fault genérico seria lido como "o Omie não expõe movimento de
 * estoque" — a conclusão errada que a sonda existe para evitar. Eles também provam que no MESMO
 * serviço convivem convenções diferentes de parâmetro (`nPagina`/`nRegPorPagina` húngaro ×
 * `pagina`/`registros_por_pagina` snake_case PT), então nome de param não se infere do vizinho.
 */
function candidatosMovimentoPadrao(
  codProduto: string | null,
  t4: string | null,
): Chamada[] {
  const hoje = new Date();
  const ref = t4 ? new Date(t4) : hoje;
  const de = ddmmyyyy(somarDias(ref, -7));
  const ate = ddmmyyyy(somarDias(ref, 7));

  const lista: Chamada[] = [
    // ── controles positivos ──
    {
      servico: "estoque_consulta",
      call: "ListarPosEstoque",
      param: { nPagina: 1, nRegPorPagina: 5, dDataPosicao: ddmmyyyy(hoje), cExibeTodos: "S" },
      nota: "controle positivo (params verbatim de omie-sync-estoque)",
    },
    {
      servico: "estoque_consulta",
      call: "ListarSaldoPendente",
      param: { pagina: 1, registros_por_pagina: 5, tipo: "ENTRADA" },
      nota: "controle positivo + S4 (granularidade do saldo pendente)",
    },
    // ── camada A: taxonomia do fault ──
    { servico: "estoque_consulta", call: "ListarMovimentoEstoque", param: {}, nota: "camada A" },
    { servico: "estoque_consulta", call: "MovimentoEstoque", param: {}, nota: "camada A" },
    { servico: "estoque_resumo", call: "ObterEstoqueProduto", param: {}, nota: "camada A" },
    { servico: "estoque_movestoque", call: "ListarMovimentos", param: {}, nota: "camada A" },
    { servico: "estoque_ajuste", call: "ListarAjusteEstoque", param: {}, nota: "camada A" },
    { servico: "estoque_local", call: "ListarLocaisEstoque", param: {}, nota: "camada A" },
  ];

  // ── camada B: params reais ──
  lista.push({
    servico: "estoque_consulta",
    call: "ListarMovimentoEstoque",
    param: {
      nPagina: 1,
      nRegPorPagina: 20,
      dDtInicial: de,
      dDtFinal: ate,
      ...(codProduto ? { nIdProduto: Number(codProduto) } : {}),
    },
    nota: "camada B — período em torno do t4 da PO alvo",
  });
  if (codProduto) {
    lista.push({
      servico: "estoque_resumo",
      call: "ObterEstoqueProduto",
      param: { nIdProduto: Number(codProduto), dDia: ddmmyyyy(hoje) },
      nota: "camada B — produto real da PO alvo",
    });
    lista.push({
      servico: "estoque_consulta",
      call: "MovimentoEstoque",
      param: { nIdProduto: Number(codProduto), dDtInicial: de, dDtFinal: ate },
      nota: "camada B — produto real + período",
    });
  }
  lista.push({
    servico: "estoque_movestoque",
    call: "ListarMovimentos",
    param: { nPagina: 1, nRegPorPagina: 20, dDtInicial: de, dDtFinal: ate },
    nota: "camada B — controle: agregado diário, não rastreia recebimento",
  });
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

    const { linhas: amostra, via: viaAmostra, candidatasLidas } = await carregarAmostra(
      supabase,
      empresa,
      limite,
      pedidos,
    );
    if (amostra.length === 0) {
      return json({
        ok: false,
        erro: "nenhuma PO etapa-15 com t4 encontrada para a amostra",
        viaAmostra,
        candidatasLidas,
      }, 404);
    }

    const bruto: Record<string, unknown> = {};

    // ── S1 — ConsultarPedCompra × PesquisarPedCompra espelhado ────────────────────────────────
    const s1: Record<string, unknown>[] = [];
    for (const po of amostra) {
      const codPed = po.omie_codigo_pedido;
      const linha: Record<string, unknown> = {
        numeroPedido: po.numero_pedido,
        omieCodigoPedido: codPed,
        t4Local: po.t4_data_recebimento,
        etapaNoEspelho: etapaDaPO(po.raw_data),
      };
      if (codPed == null) {
        linha.desfecho = "sem_id_nativo_no_espelho";
        s1.push(linha);
        continue;
      }
      try {
        const d = await chamarOmie(
          {
            servico: "pedido_compra",
            call: "ConsultarPedCompra",
            param: { nCodPed: Number(codPed) },
          },
          creds,
          ctx,
        );
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          const dif = diffCaminhos(caminhosDeChave(d.json), caminhosDeChave(po.raw_data ?? {}));
          // A resposta da S1 em duas listas: o que o detalhe tem e a listagem não, e vice-versa.
          linha.soNoDetalhe = dif.soEmA;
          linha.soNoEspelho = dif.soEmB;
          // Estado CORRENTE no Omie contra o `t4` local, que é histórico e nunca é limpo.
          linha.etapaAgoraNoOmie = idNativo(buscarValorProfundo(d.json, ["cEtapa"]));
          linha.itens = resumirItensPO(d.json);
          linha.itensEspelho = resumirItensPO(po.raw_data ?? {});
          if (incluirBruto) guardarBruto(bruto, `s1_${po.numero_pedido}`, d.json);
        }
      } catch (err) {
        // Uma PO que falha no transporte não pode levar S2 e S3 junto — medir 2 de 3 sondas é
        // muito melhor do que perder a rodada e ter que pedir outro deploy.
        linha.desfecho = "nao_medido";
        linha.motivo = redigirSegredos(
          mensagemDeErro(err) ?? "falha sem mensagem ao consultar o pedido",
        );
      }
      s1.push(linha);
    }

    // ── S2 — ConsultarRecebimento: taxonomia de vínculo por item ──────────────────────────────
    const s2: Record<string, unknown>[] = [];
    for (const po of amostra) {
      const nid = po.nid_receb;
      if (nid == null) continue;
      const alvo = {
        idPedido: idNativo(po.omie_codigo_pedido),
        numeroPedido: idNativo(po.numero_pedido),
      };
      const linha: Record<string, unknown> = {
        nidReceb: nid,
        poAlvo: po.numero_pedido,
        idPedidoAlvo: alvo.idPedido,
        chaveNfeFinal: po.nfe_chave_acesso ? `…${po.nfe_chave_acesso.slice(-8)}` : null,
      };
      try {
        // Só `nIdReceb`: mandar `cChaveNfe` junto (ou vazio) pode fazer o backend combinar
        // filtros e falhar apesar do id correto — falso negativo caro.
        const d = await chamarOmie(
          { servico: "recebimento_nfe", call: "ConsultarRecebimento", param: { nIdReceb: nid } },
          creds,
          ctx,
        );
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          // Estado CORRENTE do recebimento — o `t4` local não é limpo se houve reversão.
          linha.estadoCorrente = {
            cRecebido: buscarValorProfundo(d.json, ["cRecebido"]) ?? null,
            cCancelada: buscarValorProfundo(d.json, ["cCancelada"]) ?? null,
            cDevolvido: buscarValorProfundo(d.json, ["cDevolvido"]) ?? null,
            cEtapa: buscarValorProfundo(d.json, ["cEtapa"]) ?? null,
            dRegistro: buscarValorProfundo(d.json, ["dRegistro", "dDtRegistro"]) ?? null,
          };
          const achado = localizarItens(d.json);
          const itens = (achado?.itens ?? []).slice(0, ITENS_NO_RELATORIO)
            .map(normalizarItemRecebimento);
          const classes = itens.map((i) => classificarAssociacao(i, alvo));
          const contagem: Partial<Record<ClasseAssociacao, number>> = {};
          for (const c of classes) contagem[c] = (contagem[c] ?? 0) + 1;

          linha.itens = {
            caminho: achado?.caminho ?? null,
            n: achado?.itens.length ?? 0,
            chavesDoItem: caminhosDeChave(achado?.itens[0] ?? {}),
            detalhe: itens.map((i, k) => ({ ...i, classe: classes[k] })),
          };
          // A resposta da S2 em uma linha: como os itens desta nota se ligam à PO alvo.
          linha.classesDeAssociacao = contagem;
          linha.temVinculoNativoPorItem = classes.some((c) => c === "native_exact");
          linha.camposQueCitamPedido = caminhosDeChave(d.json).filter((c) =>
            /ped|compra|order/i.test(c)
          );
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
      : candidatosMovimentoPadrao(primeiroProduto, amostra[0]?.t4_data_recebimento ?? null);

    const s3: Record<string, unknown>[] = [];
    for (const cand of candidatos) {
      const linha: Record<string, unknown> = {
        servico: cand.servico,
        call: cand.call,
        nota: cand.nota ?? null,
        param: cand.param,
      };
      try {
        const d = await chamarOmie(cand, creds, ctx);
        Object.assign(linha, resumirDesfecho(d));
        if (d.tipo === "ok") {
          linha.itens = resumirItensPO(d.json);
          if (incluirBruto) guardarBruto(bruto, `s3_${cand.servico}_${cand.call}`, d.json);
        }
      } catch (err) {
        // Candidato bloqueado ou estourando o teto não pode derrubar a medição dos outros.
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
      candidatasLidas,
      chamadasAoOmie: ctx.chamadas,
      amostra: amostra.map((p) => ({
        numeroPedido: p.numero_pedido,
        omieCodigoPedido: p.omie_codigo_pedido,
        nidReceb: p.nid_receb,
        t4: p.t4_data_recebimento,
      })),
      s1_detalhe_vs_listagem: s1,
      s2_associacao_por_item: s2,
      s3_movimento_estoque: s3,
      ...(incluirBruto ? { bruto } : {}),
    });
  } catch (err) {
    const msg = mensagemDeErro(err) ?? "falha sem mensagem na sonda";
    console.error(`[sonda] falhou: ${msg}`);
    return json({ ok: false, erro: redigirSegredos(msg), chamadasAoOmie: ctx.chamadas }, 500);
  }
});
