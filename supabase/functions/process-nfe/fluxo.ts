// Fluxo da `process-nfe` DEPOIS do gate e da sonda (que ficam no `index.ts`, onde o contrato da
// sonda os lê), com as dependências INJETADAS (Omie, banco, id) — sem import remoto, para o teste
// Deno (`fluxo_test.ts`, `--no-remote`) exercitar a sequência inteira de escrita.
//
// Sequência (plano de melhoria v3, item 1 — a aba Manual virou caminho oficial do recebimento):
//   [index.ts: auth → sonda] → staff → trilha `inicio` [sem ela, nada vai ao Omie]
//   → ListarRecebimentos (acha a NF) → ConsultarRecebimento (itens + estado)
//   → guarda: já recebida no Omie (cRecebido=S ou etapa 80) → para, sem escrever
//   → regra de quantidade (regra-quantidade.ts) → qualquer recusa → para, sem escrever
//   → trilha `quantidades/intencao` → AlterarRecebimento
//   → (etapa ≠ 40) trilha `alterar_etapa/intencao` → AlterarEtapaRecebimento
//   → trilha `concluir_recebimento/intencao` → ConcluirRecebimento → trilha `fim`
// Toda chamada ao Omie passa pelo núcleo `_shared/omie-cliente.ts` (relógio de 140s, retentativa só
// do que é seguro); escrita com desfecho desconhecido volta como INDETERMINADA, com a instrução de
// conferir no Omie antes de repetir — e a guarda "já recebida" faz a repetição não concluir duas vezes.
import { ehEscritaIndeterminada } from "../_shared/omie-chamada-relogio.ts";
import { fimDePaginacao, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { VERSAO } from "./versao.ts";
import { decidirQuantidades, ehItemIgnorado, type ItemDecidido, type ItemOmieBruto, numeroOuNulo } from "./regra-quantidade.ts";
import { type Conta, criarTrilha, type DbTrilha, type EventoTrilha, type PassoTrilha, type ResultadoTrilha } from "./trilha.ts";

// Origem fixa "*" (igual ao `_shared/auth.ts`; a auth é por Bearer, não cookie): o secret ALLOWED_ORIGIN
// valia "123456" em prod e o navegador rejeitava todo preflight — 5 edges mudas para o app (2026-10-12).
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export const ENDPOINT_RECEBIMENTO = "produtos/recebimentonfe/";
export const ENDPOINT_DEPARTAMENTOS = "geral/departamentos/";
const POR_PAGINA = 50;
const MAX_PAGINAS = 30;
const CONTAS: readonly Conta[] = ["oben", "colacor", "afiacao"];

/** O `AuthResult` aprovado do `_shared/auth.ts` (o reprovado já respondeu no `index.ts`). */
export type AuthAprovado = { ok: true; via: "cron" | "service_role" | "staff"; userId?: string };

/** Uma chamada LÓGICA ao Omie (o adaptador real é o `chamarOmie` do núcleo). */
export type ChamadaOmie = (conta: Conta, endpoint: string, metodo: string, param: Record<string, unknown>) => Promise<RespostaOmie>;

export interface DepsProcessNfe {
  omie: ChamadaOmie;
  db: DbTrilha;
  novoId(): string;
}

interface StepResult {
  step: number;
  description: string;
  status: "success" | "error" | "warning";
  detail?: string;
}

export function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function registro(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function semZeros(s: string): string {
  return s.replace(/^0+/, "") || "0";
}

function falhaOmie(r: RespostaOmie, metodo: string): string | null {
  if (r.faultstring !== null) return `Omie: ${redigirSegredo(r.faultstring).slice(0, 300)}`;
  if (!r.ok) return `Omie: HTTP ${r.status} em ${metodo}`;
  if (r.faultcode !== null) return `Omie: faultcode ${r.faultcode} em ${metodo}`;
  if (r.corpo === null) return `Omie: resposta ilegível em ${metodo}`;
  return null;
}

/** Leitura: qualquer coisa que não seja corpo bom LANÇA (ausência nunca vira "sem registros"). */
async function ler(omie: ChamadaOmie, conta: Conta, endpoint: string, metodo: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await omie(conta, endpoint, metodo, param);
  const falha = falhaOmie(r, metodo);
  if (falha !== null) throw new Error(falha);
  return r.corpo as Record<string, unknown>;
}

type DesfechoEscrita = { tipo: "ok" } | { tipo: "erro" | "indeterminado"; mensagem: string };

/**
 * Escrita: `erro` = o Omie RECUSOU (fault/4xx) ou a chamada não chegou a ser feita; `indeterminado` = pode
 * ter gravado (transporte, 2xx ilegível). A distinção é do núcleo (`OmieEscritaIndeterminada`).
 */
async function escrever(omie: ChamadaOmie, conta: Conta, metodo: string, param: Record<string, unknown>): Promise<DesfechoEscrita> {
  try {
    const r = await omie(conta, ENDPOINT_RECEBIMENTO, metodo, param);
    if (r.ok && r.faultstring === null && r.faultcode === null && r.corpo === null) {
      return { tipo: "indeterminado", mensagem: `${metodo}: o Omie respondeu 2xx ilegível — PODE ter gravado; confira no Omie antes de repetir` };
    }
    const falha = falhaOmie(r, metodo);
    return falha === null ? { tipo: "ok" } : { tipo: "erro", mensagem: falha };
  } catch (e) {
    if (ehEscritaIndeterminada(e)) return { tipo: "indeterminado", mensagem: e.message };
    return { tipo: "erro", mensagem: mensagemDeErro(e) ?? `${metodo}: falhou sem mensagem` };
  }
}

function descreverItem(i: ItemDecidido): string {
  const cod = i.codigo ?? `seq ${i.sequencia}`;
  const regra = i.regra === "conversao_do_omie" ? "conversão do Omie" : i.regra === "nf_igual_omie" ? "NF = Omie" : "sem conversão";
  return `${cod}: NF ${i.qtdNf} ${i.unidadeNf ?? "?"} → ${i.qtdEnviada} ${i.unidadeEstoque ?? i.unidadeNf ?? "?"} (${regra})`;
}

function itemNaTrilha(i: ItemDecidido): Record<string, unknown> {
  return {
    seq: i.sequencia, codigo: i.codigo, id_produto: i.idProduto, un_nf: i.unidadeNf, un_estoque: i.unidadeEstoque,
    qtd_nf: i.qtdNf, qtd_omie: i.qtdOmie, fator_no_item: i.fatorNoItem, regra: i.regra, qtd_enviada: i.qtdEnviada,
    ...(i.aviso ? { aviso: i.aviso } : {}),
  };
}

export async function processarNfe(auth: AuthAprovado, corpoBruto: unknown, deps: DepsProcessNfe): Promise<Response> {
  const corpo = registro(corpoBruto);

  // O recebimento é ATRIBUÍDO a quem clicou: só JWT de staff. (Antes, x-cron-secret + qualquer JWT de
  // usuário passava — inclusive de customer — e ninguém ficava registrado.)
  if (auth.via !== "staff" || !auth.userId) {
    return json({ error: "process-nfe exige usuário staff — o recebimento fica registrado em nome de quem o executa", versao: VERSAO }, 403);
  }

  const nfBruto = texto(corpo.nf_number);
  const nf = nfBruto?.replace(/[\s.-]/g, "") ?? "";
  if (!/^\d{1,20}$/.test(nf)) {
    return json({ error: "nf_number é obrigatório (só dígitos)", versao: VERSAO }, 400);
  }
  const contaPedida = corpo.account === undefined || corpo.account === null || corpo.account === "" ? "oben" : corpo.account;
  if (typeof contaPedida !== "string" || !(CONTAS as readonly string[]).includes(contaPedida)) {
    return json({ error: `account inválida — use ${CONTAS.join(", ")}`, versao: VERSAO }, 400);
  }
  const conta = contaPedida as Conta;

  const steps: StepResult[] = [];
  const trilha = criarTrilha(deps.db, { execucaoId: deps.novoId(), executadoPor: auth.userId, conta, nfNumero: nf, versao: VERSAO });
  let trilhaIncompleta = false;
  const registrarResultado = async (e: EventoTrilha) => {
    if (!(await trilha.registrar(e))) trilhaIncompleta = true;
  };
  const responder = (extra: Record<string, unknown>) =>
    json({ steps, ...extra, execucao_id: trilha.execucaoId, ...(trilhaIncompleta ? { trilha_incompleta: true } : {}), versao: VERSAO });
  const parar = async (passo: PassoTrilha, resultado: ResultadoTrilha, step: number, descricao: string, mensagem: string, detalhe: Record<string, unknown> = {}) => {
    steps.push({ step, description: descricao, status: "error", detail: mensagem });
    await registrarResultado({ passo, resultado, detalhe: { mensagem, ...detalhe } });
    await registrarResultado({ passo: "fim", resultado });
    return responder({ error: mensagem });
  };
  const semTrilha = (step: number, descricao: string) => {
    const mensagem = "Não consegui gravar a trilha do recebimento — nada foi enviado ao Omie neste passo. Tente de novo.";
    steps.push({ step, description: descricao, status: "error", detail: mensagem });
    return responder({ error: mensagem });
  };

  console.log(`[process-nfe] Iniciando: NF="${nf}", conta="${conta}", execucao=${trilha.execucaoId}`);
  if (!(await trilha.registrar({ passo: "inicio", resultado: "intencao", detalhe: { nf_informada: nfBruto } }))) {
    return semTrilha(0, "Registrar a trilha do recebimento");
  }

  // STEP 1 — achar a NF (ListarRecebimentos). Para no 1º recebimento com o número; o fornecedor e a
  // chave vão para a tela e para a trilha.
  let nIdReceb: number | null = null;
  let chave: string | null = null;
  try {
    let fimReal = false;
    let pagina = 1;
    let fornecedor = "Fornecedor";
    let numeroOmie = nf;
    for (; pagina <= MAX_PAGINAS && nIdReceb === null; pagina++) {
      const r = await deps.omie(conta, ENDPOINT_RECEBIMENTO, "ListarRecebimentos", { nPagina: pagina, nRegistrosPorPagina: POR_PAGINA });
      if (fimDePaginacao(r)) { fimReal = true; break; }
      const falha = falhaOmie(r, "ListarRecebimentos");
      if (falha !== null) throw new Error(falha);
      const recebimentos = (r.corpo as Record<string, unknown>).recebimentos;
      if (!Array.isArray(recebimentos)) throw new Error("Omie: ListarRecebimentos sem lista de recebimentos legível");
      for (const rec of recebimentos) {
        const cabec = registro(registro(rec).cabec);
        const numero = texto(cabec.cNumeroNFe);
        if (numero === null || semZeros(numero) !== semZeros(nf)) continue;
        const id = numeroOuNulo(cabec.nIdReceb);
        if (id === null) throw new Error(`Omie: recebimento da NF ${numero} sem nIdReceb legível`);
        nIdReceb = id;
        chave = texto(cabec.cChaveNfe);
        fornecedor = texto(cabec.cNome) ?? texto(cabec.cRazaoSocial) ?? "Fornecedor";
        numeroOmie = numero;
        break;
      }
      if (nIdReceb === null && recebimentos.length < POR_PAGINA) { fimReal = true; break; }
    }
    if (nIdReceb === null) {
      const lidas = Math.min(pagina, MAX_PAGINAS);
      return await parar("nf_localizada", "erro", 1, `Buscar NF ${nf}`, fimReal
        ? `NF ${nf} não encontrada no Omie (${lidas} página(s) lidas até o fim)`
        : `NF ${nf} não encontrada nas primeiras ${MAX_PAGINAS} páginas do Omie — busca incompleta, nada foi enviado`);
    }
    trilha.fixarNf(nIdReceb, chave);
    steps.push({
      step: 1, description: `NF encontrada: ${fornecedor} (NF ${numeroOmie})`, status: "success",
      detail: `nIdReceb: ${nIdReceb}, chave: ${chave ? chave.substring(0, 20) + "..." : "N/A"}`,
    });
    await registrarResultado({ passo: "nf_localizada", resultado: "ok", detalhe: { fornecedor, numero_omie: numeroOmie, pagina } });
  } catch (e) {
    return await parar("nf_localizada", "erro", 1, `Buscar NF ${nf}`, mensagemDeErro(e) ?? "falha sem mensagem ao buscar a NF");
  }

  // STEP 2 — itens e estado (ConsultarRecebimento).
  let itens: ItemOmieBruto[] = [];
  let etapa: string | null = null;
  try {
    const consulta: Record<string, unknown> = { nIdReceb };
    if (chave) consulta.cChaveNfe = chave;
    const det = await ler(deps.omie, conta, ENDPOINT_RECEBIMENTO, "ConsultarRecebimento", consulta);
    const cabec = registro(det.cabec);
    const idConsulta = numeroOuNulo(cabec.nIdReceb);
    if (idConsulta !== null && idConsulta !== nIdReceb) {
      return await parar("consulta", "recusado", 2, "Consultar detalhes da NF", `nIdReceb diverge na consulta (${idConsulta} ≠ ${nIdReceb}) — nada foi enviado`);
    }
    etapa = texto(cabec.cEtapa);
    const recebido = texto(registro(det.infoCadastro).cRecebido)?.toUpperCase() ?? null;
    if (recebido === "S" || etapa === "80") {
      return await parar("consulta", "recusado", 2, "Consultar detalhes da NF",
        `NF já recebida no Omie (etapa ${etapa ?? "?"}, recebido ${recebido ?? "?"}) — nada foi enviado`, { etapa, recebido });
    }
    if (!Array.isArray(det.itensRecebimento) || det.itensRecebimento.length === 0) {
      return await parar("consulta", "recusado", 2, "Consultar detalhes da NF", "O Omie não devolveu itens para esta NF — nada foi enviado", { etapa, recebido });
    }
    itens = det.itensRecebimento.map((i) => registro(i) as ItemOmieBruto);

    const avisos: string[] = [];
    itens.forEach((item, i) => {
      const cab = registro(item.itensCabec);
      if (ehItemIgnorado(item)) { avisos.push(`Item ${i + 1}: ignorado`); return; }
      const idProduto = numeroOuNulo(cab.nIdProduto);
      if (idProduto === null || idProduto === 0) avisos.push(`Item ${i + 1} (${texto(cab.cCodigoProduto) ?? "?"}): sem produto associado`);
    });
    const semProduto = avisos.filter((a) => a.endsWith("sem produto associado")).length;
    steps.push(semProduto > 0
      ? { step: 2, description: `Itens verificados: ${itens.length} itens, ${semProduto} sem associação`, status: "warning", detail: avisos.join("; ") }
      : { step: 2, description: `Itens verificados: ${itens.length} itens, todos associados`, status: "success" });
    await registrarResultado({ passo: "consulta", resultado: semProduto > 0 ? "aviso" : "ok", detalhe: { etapa, recebido, n_itens: itens.length, sem_produto: semProduto } });
  } catch (e) {
    return await parar("consulta", "erro", 2, "Consultar detalhes da NF", mensagemDeErro(e) ?? "falha sem mensagem na consulta");
  }

  // STEP 3 — quantidades (regra explícita) + departamento → AlterarRecebimento.
  const decisao = decidirQuantidades(itens);
  if (!decisao.ok) {
    const motivos = decisao.recusas.map((r) => `${r.codigo ?? `item ${r.posicao}`}: ${r.detalhe}`).join(" | ");
    return await parar("quantidades", "recusado", 3, "Conferir quantidades a receber", `Recebimento recusado, nada foi enviado ao Omie — ${motivos}`,
      { recusas: decisao.recusas, itens: decisao.itens.map(itemNaTrilha) });
  }

  let departamento = "";
  try {
    const dept = await ler(deps.omie, conta, ENDPOINT_DEPARTAMENTOS, "ListarDepartamentos", { pagina: 1, registros_por_pagina: 50 });
    const lista = Array.isArray(dept.departamentos) ? dept.departamentos.map(registro) : [];
    const ops = lista.find((d) => (texto(d.descricao) ?? "").toLowerCase().includes("opera") || (texto(d.codigo) ?? "").toLowerCase().includes("opera"));
    departamento = texto(ops?.codigo) ?? "";
  } catch (e) {
    // Comportamento herdado: sem a lista, o recebimento segue sem rateio de departamento (fica na trilha).
    console.log(`[process-nfe] Erro ao listar departamentos: ${mensagemDeErro(e) ?? "sem mensagem"}`);
  }
  // Valor para o rateio de departamento — cálculo herdado da versão anterior, sem mudança de regra.
  let totalNf = 0;
  for (const item of itens) {
    if (ehItemIgnorado(item)) continue;
    const cab = registro(item.itensCabec);
    totalNf += (numeroOuNulo(cab.nQtdeNFe) ?? 0) * (numeroOuNulo(cab.nValorUnitario) || numeroOuNulo(cab.nValorTotal) || 0);
  }
  if (totalNf === 0) {
    for (const item of itens) {
      if (ehItemIgnorado(item)) continue;
      totalNf += numeroOuNulo(registro(item.itensCabec).nValorTotal) ?? 0;
    }
  }

  const alterar: Record<string, unknown> = {
    ide: { nIdReceb },
    itensRecebimentoEditar: decisao.itens.map((i) => ({ itensIde: { nSequencia: i.sequencia, cAcao: "EDITAR" }, itensAjustes: { nQtdeRecebida: i.qtdEnviada } })),
  };
  const departamentoAplicado = departamento && totalNf > 0
    ? { cCodDepartamento: departamento, pDepartamento: 100, vDepartamento: Math.round(totalNf * 100) / 100 }
    : null;
  if (departamentoAplicado) alterar.departamentos = [departamentoAplicado];

  if (!(await trilha.registrar({
    passo: "quantidades", resultado: "intencao",
    detalhe: { itens: decisao.itens.map(itemNaTrilha), ignorados: decisao.ignorados, departamento: departamentoAplicado },
  }))) {
    return semTrilha(3, "Atualizar recebimento");
  }
  const dAlterar = await escrever(deps.omie, conta, "AlterarRecebimento", alterar);
  if (dAlterar.tipo !== "ok") return await parar("alterar_recebimento", dAlterar.tipo, 3, "Atualizar recebimento", dAlterar.mensagem);
  await registrarResultado({ passo: "alterar_recebimento", resultado: "ok" });
  const avisosQtd = decisao.itens.filter((i) => i.aviso).map((i) => `${i.codigo ?? `seq ${i.sequencia}`}: ${i.aviso}`);
  steps.push({
    step: 3, description: `Quantidades recebidas e departamento atualizados (${decisao.itens.length} itens)`,
    status: avisosQtd.length > 0 ? "warning" : "success",
    detail: [...decisao.itens.map(descreverItem), ...(departamento ? [`Depto: ${departamento}`] : []), ...avisosQtd].join(" | "),
  });

  // STEP 4 — etapa 40 (conferência). Já em 40 (repetição depois de uma falha) → não chama.
  if (etapa === "40") {
    steps.push({ step: 4, description: "Etapa já em conferência (40)", status: "success" });
    await registrarResultado({ passo: "alterar_etapa", resultado: "pulado", detalhe: { etapa } });
  } else {
    if (!(await trilha.registrar({ passo: "alterar_etapa", resultado: "intencao", detalhe: { de: etapa, para: "40" } }))) {
      return semTrilha(4, "Alterar etapa");
    }
    const dEtapa = await escrever(deps.omie, conta, "AlterarEtapaRecebimento", { nIdReceb, cChaveNfe: chave ?? "", cEtapa: "40" });
    if (dEtapa.tipo !== "ok") return await parar("alterar_etapa", dEtapa.tipo, 4, "Alterar etapa", dEtapa.mensagem);
    await registrarResultado({ passo: "alterar_etapa", resultado: "ok" });
    steps.push({ step: 4, description: "Etapa alterada para conferência", status: "success" });
  }

  // STEP 5 — ConcluirRecebimento: a entrada de estoque e fiscal no ERP.
  if (!(await trilha.registrar({ passo: "concluir_recebimento", resultado: "intencao" }))) {
    return semTrilha(5, "Concluir recebimento");
  }
  const dConcluir = await escrever(deps.omie, conta, "ConcluirRecebimento", { nIdReceb, cChaveNfe: chave ?? "" });
  if (dConcluir.tipo !== "ok") return await parar("concluir_recebimento", dConcluir.tipo, 5, "Concluir recebimento", dConcluir.mensagem);
  await registrarResultado({ passo: "concluir_recebimento", resultado: "ok" });
  await registrarResultado({ passo: "fim", resultado: "ok" });
  steps.push({ step: 5, description: "Recebimento concluído com sucesso", status: "success" });
  return responder({ success: true });
}
