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
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";
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
/** Janela de emissão da busca: limita a varredura (que vai até o FIM, para provar que o número é único). */
const JANELA_EMISSAO_DIAS = 180;
const CONTAS: readonly Conta[] = ["oben", "colacor", "afiacao"];

/** O `AuthResult` aprovado do `_shared/auth.ts` (o reprovado já respondeu no `index.ts`). */
export type AuthAprovado = { ok: true; via: "cron" | "service_role" | "staff"; userId?: string };

/** Uma chamada LÓGICA ao Omie (o adaptador real é o `chamarOmie` do núcleo). */
export type ChamadaOmie = (conta: Conta, endpoint: string, metodo: string, param: Record<string, unknown>) => Promise<RespostaOmie>;

export interface DepsProcessNfe {
  omie: ChamadaOmie;
  db: DbTrilha;
  novoId(): string;
  /** Dia de hoje em SP (`AAAA-MM-DD`); injetável para teste. */
  hoje?: () => string;
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

  // Erro de entrada volta 200 com `steps`/`error`: a tela lê `data`, e um 400 chegaria a ela só como
  // "non-2xx". Hífen NÃO é removido: "1234-5" juntaria a série ao número e casaria com outra NF.
  const entradaInvalida = (mensagem: string) =>
    json({ steps: [{ step: 0, description: "Validar a NF informada", status: "error", detail: mensagem }], error: mensagem, desfecho: "recusado", versao: VERSAO });
  const nfBruto = texto(corpo.nf_number);
  const nf = nfBruto?.replace(/[\s.]/g, "") ?? "";
  if (!/^\d{1,20}$/.test(nf)) return entradaInvalida("Número da NF obrigatório, só dígitos (sem série)");
  const contaPedida = corpo.account === undefined || corpo.account === null || corpo.account === "" ? "oben" : corpo.account;
  if (typeof contaPedida !== "string" || !(CONTAS as readonly string[]).includes(contaPedida)) {
    return entradaInvalida(`Empresa inválida — use ${CONTAS.join(", ")}`);
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
  // `desfecho` é o resultado legível por máquina: `indeterminado` (pode ter gravado — conferir no Omie
  // antes de repetir) não é `erro` (o Omie recusou, ou nada foi enviado) nem `recusado` (guarda daqui).
  const parar = async (passo: PassoTrilha, resultado: ResultadoTrilha, step: number, descricao: string, mensagem: string, detalhe: Record<string, unknown> = {}) => {
    steps.push({ step, description: descricao, status: "error", detail: mensagem });
    await registrarResultado({ passo, resultado, detalhe: { mensagem, ...detalhe } });
    await registrarResultado({ passo: "fim", resultado });
    return responder({ error: mensagem, desfecho: resultado });
  };
  const semTrilha = (step: number, descricao: string) => {
    const mensagem = "Não consegui gravar a trilha do recebimento — nada foi enviado ao Omie neste passo. Tente de novo.";
    steps.push({ step, description: descricao, status: "error", detail: mensagem });
    return responder({ error: mensagem, desfecho: "erro" });
  };

  console.log(`[process-nfe] Iniciando: NF="${nf}", conta="${conta}", execucao=${trilha.execucaoId}`);
  if (!(await trilha.registrar({ passo: "inicio", resultado: "intencao", detalhe: { nf_informada: nfBruto } }))) {
    return semTrilha(0, "Registrar a trilha do recebimento");
  }

  // STEP 1 — achar a NF (ListarRecebimentos). A varredura vai até o FIM da janela de emissão: número
  // de NF é por EMITENTE, então dois fornecedores podem ter o mesmo — e concluir o recebimento do
  // outro dá entrada de mercadoria que não chegou. Mais de um recebimento não cancelado com o número
  // → recusa. `cExibirDetalhes:'S'` traz o `infoCadastro` na listagem (omie-nfe-recebimento-sync).
  let nIdReceb: number | null = null;
  let chave: string | null = null;
  try {
    const dtEmissaoDe = paraDataOmie(somarDias((deps.hoje ?? hojeSP)(), -JANELA_EMISSAO_DIAS));
    const achados: { nIdReceb: number; chave: string | null; fornecedor: string; numero: string }[] = [];
    let canceladas = 0;
    let fimReal = false;
    let pagina = 1;
    for (; pagina <= MAX_PAGINAS; pagina++) {
      const r = await deps.omie(conta, ENDPOINT_RECEBIMENTO, "ListarRecebimentos", {
        nPagina: pagina, nRegistrosPorPagina: POR_PAGINA, cOrdenarPor: "CODIGO", dtEmissaoDe, cExibirDetalhes: "S",
      });
      if (fimDePaginacao(r)) { fimReal = true; break; }
      const falha = falhaOmie(r, "ListarRecebimentos");
      if (falha !== null) throw new Error(falha);
      const recebimentos = (r.corpo as Record<string, unknown>).recebimentos;
      if (!Array.isArray(recebimentos)) throw new Error("Omie: ListarRecebimentos sem lista de recebimentos legível");
      for (const rec of recebimentos) {
        const cabec = registro(registro(rec).cabec);
        const numero = texto(cabec.cNumeroNFe);
        if (numero === null || semZeros(numero) !== semZeros(nf)) continue;
        if (texto(registro(registro(rec).infoCadastro).cCancelada)?.toUpperCase() === "S") { canceladas++; continue; }
        const id = numeroOuNulo(cabec.nIdReceb);
        if (id === null) throw new Error(`Omie: recebimento da NF ${numero} sem nIdReceb legível`);
        achados.push({ nIdReceb: id, chave: texto(cabec.cChaveNfe), fornecedor: texto(cabec.cNome) ?? texto(cabec.cRazaoSocial) ?? "Fornecedor", numero });
      }
      if (recebimentos.length < POR_PAGINA) { fimReal = true; break; }
    }
    if (!fimReal) {
      return await parar("nf_localizada", "recusado", 1, `Buscar NF ${nf}`,
        `A busca passou de ${MAX_PAGINAS} páginas sem chegar ao fim — não dá para provar que a NF ${nf} é única; nada foi enviado`, { achados: achados.length });
    }
    if (achados.length === 0) {
      return await parar("nf_localizada", "erro", 1, `Buscar NF ${nf}`,
        `NF ${nf} não encontrada no Omie entre as emitidas nos últimos ${JANELA_EMISSAO_DIAS} dias${canceladas > 0 ? ` (${canceladas} cancelada(s) ignorada(s))` : ""}`);
    }
    if (achados.length > 1) {
      return await parar("nf_localizada", "recusado", 1, `Buscar NF ${nf}`,
        `Há ${achados.length} recebimentos com o número ${nf} (${achados.map((a) => a.fornecedor).join("; ")}) — não sei qual é; nada foi enviado`,
        { achados: achados.map((a) => ({ n_id_receb: a.nIdReceb, fornecedor: a.fornecedor })) });
    }
    const achado = achados[0];
    nIdReceb = achado.nIdReceb;
    chave = achado.chave;
    trilha.fixarNf(nIdReceb, chave);
    steps.push({
      step: 1, description: `NF encontrada: ${achado.fornecedor} (NF ${achado.numero})`, status: "success",
      detail: `nIdReceb: ${nIdReceb}, chave: ${chave ? chave.substring(0, 20) + "..." : "N/A"}`,
    });
    await registrarResultado({ passo: "nf_localizada", resultado: "ok", detalhe: { fornecedor: achado.fornecedor, numero_omie: achado.numero, paginas: pagina, canceladas } });
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
    // "Aberta" exige EVIDÊNCIA (mesmo critério do `omie-nfe-recebimento-sync/estado.ts`): `cRecebido` e
    // `cCancelada` explicitamente "N". Ausente/vazio é desconhecido, e desconhecido não recebe — é
    // também o que impede a repetição de uma conclusão indeterminada de concluir duas vezes.
    const info = registro(det.infoCadastro);
    const recebido = texto(info.cRecebido)?.toUpperCase() ?? null;
    const cancelada = texto(info.cCancelada)?.toUpperCase() ?? null;
    if (recebido !== "N" || cancelada !== "N" || etapa === "80") {
      const motivo = cancelada === "S" ? "NF cancelada no Omie" : recebido === "S" || etapa === "80" ? "NF já recebida no Omie" : "estado da NF no Omie desconhecido";
      return await parar("consulta", "recusado", 2, "Consultar detalhes da NF",
        `${motivo} (etapa ${etapa ?? "?"}, recebido ${recebido ?? "?"}, cancelada ${cancelada ?? "?"}) — nada foi enviado`, { etapa, recebido, cancelada });
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
  return responder({ success: true, desfecho: "ok" });
}
