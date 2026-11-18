// Publicação de um run do omie-sync-estoque — do retrato do físico JÁ LIDO até o resumo da resposta. Concentra toda
// decisão sobre o PAR (físico, pendente) que o motor de reposição consome, com as escritas INJETADAS: o handler passa
// os adaptadores reais (supabase, Omie) e os testes Deno passam falsos que registram cada efeito. Sem import remoto —
// o `deno test --no-remote` executa este arquivo; o index.ts, que importa supabase-js, não pode ser importado.
//
// v1.6 — os três caminhos em que a v1.5 respondia ok:true sobre um par que o motor não deveria consumir (achados
// preexistentes do adversarial do #2817; desenho com o Codex em 2026-10-06):
//   C2 físico incompleto → FALHA antes da fase do PO (veredito de fisico.ts). Nada é gravado.
//   C1 pendente não confiável → FALHA antes de qualquer escrita. O par velho fica coerente (físico e pendente do mesmo
//      run anterior). Gravar o físico fresco com o pendente velho conta 2× a NF recebida depois do último run bom — o
//      motor sub-sugere e ninguém vê; o par velho erra no TEMPO, e a idade aparece no badge e na Sentinela.
//   C3 gravação parcial → DEGRADA. O que gravou fica (cada linha leva físico E pendente juntos: o par é coerente por
//      SKU); marcadores 'partial' (a Sentinela alerta "degradado"); resposta ok:false (o botão não recalcula). O cron
//      do motor continua consumindo o snapshot — os SKUs que falharam ficam com o par velho, agora visível.
// RESIDUAL (precisa de primitiva compartilhada no banco — lease ou versão; não cabe na edge): dois runs sobrepostos
// (cron × botão) podem terminar na ordem inversa da leitura, e o atrasado regrava par mais velho com timestamp novo.

import { type AgregadoSku, exigirFisicoPublicavel, type VereditoFisico } from "./fisico.ts";
import { type LinhaObservada, observacaoBateComPendente } from "./observacao-po.ts";
import { timeoutRequestMs } from "../_shared/omie-deadline.ts";
import { hojeSP } from "../_shared/hoje-sp.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

export type Empresa = "OBEN" | "COLACOR";
type Desfecho = "completo" | "parcial";

/** Marcas ASCII, caixa fixa, no INÍCIO das recusas (o registro guarda só 300 caracteres do erro). */
export const MARCA_PENDENTE = "PENDENTE_NAO_CONFIAVEL";
export const MARCA_GRAVACAO = "GRAVACAO_NAO_CONFIRMADA";

export const MARKER_FULL = "reposicao_estoque_full";
export const MARKER_PENDENTE_PO = "reposicao_pendente_po";

/** Escrita com prazo: `semConfirmacao` = o prazo abortou o request, e o banco PODE ter gravado. */
export interface ResultadoEscrita {
  erro: string | null;
  semConfirmacao: boolean;
}

/**
 * Escrita/leitura do banco com prazo — o adaptador que o handler usa em toda chamada da cauda. Mora aqui (e não no
 * index.ts) para o Deno executá-lo: é ele que separa sucesso, falha e "sem confirmação" (o request que o PRAZO abortou;
 * o banco pode ter gravado). Devolver sucesso onde houve erro tornaria toda a degradação invisível.
 */
export async function comPrazo(
  executar: (sinal: AbortSignal) => PromiseLike<{ error: unknown }>,
  prazoMs: number,
): Promise<ResultadoEscrita> {
  const sinal = AbortSignal.timeout(prazoMs);
  try {
    const { error } = await executar(sinal);
    if (!error) return { erro: null, semConfirmacao: false };
    return { erro: mensagemDeErro(error) ?? "erro sem mensagem", semConfirmacao: sinal.aborted };
  } catch (err) {
    return { erro: mensagemDeErro(err) ?? "falha sem mensagem", semConfirmacao: sinal.aborted };
  }
}

interface ResultadoLeitura<T> {
  erro: string | null;
  dados: T;
}

interface ObservacaoPo {
  observados: LinhaObservada[];
  janelaDe: string;
  janelaAte: string;
  varreduraCompleta: boolean;
  coletaIntegra: boolean;
  perdaColeta: string | null;
}

export interface ResultadoPendente {
  pendente: Map<string, number>;
  confiavel: boolean;
  problemas: string[];
  /** Só o ramo OBEN (PesquisarPedCompra) observa o conjunto aberto. */
  observacao: ObservacaoPo | null;
  /** Pendente dos membros de grupo NÃO habilitados, da MESMA varredura (ausente = a varredura não os cobriu). */
  pendenteMembros?: Map<string, number>;
  /** Membro com item de PO inválido: fora do lote (o par ficaria incompleto) — nunca barra os habilitados. */
  membrosPendenteIlegiveis?: string[];
}

export interface OpsPublicacao {
  /** Relógio de parede (Date.now em produção). */
  agora(): number;
  /** Fase do PO. LANÇA em erro de varredura — fatal por desenho (Codex P1 2026-06-20). */
  lerPendente(): Promise<ResultadoPendente>;
  upsertEstoque(linhas: Record<string, unknown>[], prazoMs: number): Promise<ResultadoEscrita>;
  /**
   * INSERT … ON CONFLICT DO NOTHING em sku_estoque_atual: nunca sobrescreve linha existente. `inseridos` = os SKUs que
   * o banco DEVOLVEU como inseridos (RETURNING) — a única prova de que o par entrou; vazio em erro.
   */
  inserirEstoqueSeAusente(
    linhas: Record<string, unknown>[],
    prazoMs: number,
  ): Promise<ResultadoEscrita & { inseridos: string[] }>;
  /**
   * UPDATE … WHERE empresa, sku, fonte_sync = FONTE_SEM_POSICAO E ultima_sincronizacao < `retratoAntesDe` (o início da
   * coleta do PO deste run); `atualizado` = o RETURNING devolveu a linha.
   */
  atualizarLinhaSemPosicao(
    linha: Record<string, unknown>,
    retratoAntesDe: string,
    prazoMs: number,
  ): Promise<ResultadoEscrita & { atualizado: boolean }>;
  /** sku → data_inativacao já gravada. */
  lerInativacoes(codigos: string[], prazoMs: number): Promise<ResultadoLeitura<Map<string, string | null>>>;
  upsertStatus(linhas: Record<string, unknown>[], prazoMs: number): Promise<ResultadoEscrita>;
  /** SKUs que já têm evento sku_inativado_omie pendente. */
  lerEventosPendentes(codigos: string[], prazoMs: number): Promise<ResultadoLeitura<Set<string>>>;
  inserirEventos(linhas: Record<string, unknown>[], prazoMs: number): Promise<ResultadoEscrita>;
  publicarObservacao(run: Record<string, unknown>, itens: LinhaObservada[], prazoMs: number): Promise<ResultadoEscrita>;
  gravarMarcador(linha: Record<string, unknown>, prazoMs: number): Promise<ResultadoEscrita>;
  log(nivel: "log" | "warn" | "error", msg: string): void;
}

export interface EntradaPublicacao {
  empresa: Empresa;
  habilitados: ReadonlyMap<string, string | null>;
  fisico: {
    veredito: VereditoFisico;
    encontrados: ReadonlyMap<string, AgregadoSku>;
    /** Membros de grupo de equivalência NÃO habilitados: gravados com o PAR físico+pendente (ver concluirRun). */
    membros?: ReadonlyMap<string, AgregadoSku>;
    membrosIlegiveis?: readonly string[];
    /** A leitura dos membros falhou: o resumo diz isso em vez de "0 membros". */
    membrosErro?: string | null;
    /** TODOS os membros de grupo NÃO habilitados, da leitura da equivalência; ausente = a leitura falhou. */
    membrosGrupo?: ReadonlySet<string>;
    paginas: number;
    faseMs: number;
  };
  /** Date.now() do início do run. */
  iniciadoEm: number;
  /** Instante absoluto em que gravação, inativação e observação param de começar requests (deadline + folga). */
  limiteCauda: number;
  prazos: {
    /** Teto por escrita/leitura da cauda. */
    tetoEscritaMs: number;
    /** Abaixo disto não se começa uma escrita da cauda. */
    minimoEscritaMs: number;
    tetoObservacaoMs: number;
    /** Prazo FIXO de cada marcador — roda depois do limite da cauda. */
    marcadorMs: number;
  };
  chunk: number;
  versao: string;
  filtrosPendente: Record<string, unknown>;
}

/** Lança (com a marca no início) se o pendente não é confiável. Nada foi gravado até aqui. */
function exigirPendenteConfiavel(r: Pick<ResultadoPendente, "confiavel" | "problemas">, fasePoMs: number): void {
  if (r.confiavel) return;
  const motivo = r.problemas.length > 0
    ? `${r.problemas.length} problema(s): ${r.problemas.slice(0, 3).join(" | ")}`
    : "varredura do PO sem nenhum pedido aberto";
  throw new Error(`${MARCA_PENDENTE} (PO ${fasePoMs}ms): ${motivo}; par (físico, pendente) preservado, nada foi gravado`);
}

/** Linha do marcador do Sentinela. 'complete' e 'partial' avançam last_sync_at (houve gravação); 'error' preserva. */
export function linhaMarcador(
  entityType: string,
  empresa: Empresa,
  status: "complete" | "partial" | "error",
  meta: Record<string, unknown>,
  erro: string | null,
  agoraMs: number,
): Record<string, unknown> {
  const iso = new Date(agoraMs).toISOString();
  const linha: Record<string, unknown> = {
    entity_type: entityType,
    account: empresa.toLowerCase(),
    status,
    updated_at: iso,
    error_message: erro,
    metadata: { ...meta, gravado_em: iso },
  };
  if (status !== "error") linha.last_sync_at = iso;
  return linha;
}

interface Gravacao {
  confirmados: number;
  falhas: Array<{ sku: string; erro: string }>;
  semConfirmacao: string[];
  naoTentados: string[];
}

function prazoCauda(ops: OpsPublicacao, e: EntradaPublicacao): number {
  return timeoutRequestMs(ops.agora(), e.limiteCauda, e.prazos.tetoEscritaMs, e.prazos.minimoEscritaMs);
}

const skuDa = (linha: Record<string, unknown>) => String(linha.sku_codigo_omie);

// Em lotes; lote que falha (ou que o prazo abortou) cai no upsert individual, para isolar o SKU problemático. Nenhum
// request começa depois do limite da cauda: o que sobra é "não tentado", e o run segue até os marcadores.
async function gravarEstoque(ops: OpsPublicacao, e: EntradaPublicacao, linhas: Record<string, unknown>[]): Promise<Gravacao> {
  const g: Gravacao = { confirmados: 0, falhas: [], semConfirmacao: [], naoTentados: [] };
  for (let i = 0; i < linhas.length; i += e.chunk) {
    const lote = linhas.slice(i, i + e.chunk);
    const prazoLote = prazoCauda(ops, e);
    if (prazoLote === 0) {
      g.naoTentados.push(...lote.map(skuDa));
      continue;
    }
    const r = await ops.upsertEstoque(lote, prazoLote);
    if (r.erro === null) {
      g.confirmados += lote.length;
      continue;
    }
    ops.log(
      "error",
      `erro upsert lote ${i}-${i + lote.length}${r.semConfirmacao ? " (prazo, sem confirmação)" : ""}: ${r.erro}. Tentando individual.`,
    );
    for (const linha of lote) {
      const prazo = prazoCauda(ops, e);
      if (prazo === 0) {
        g.naoTentados.push(skuDa(linha));
        continue;
      }
      const ri = await ops.upsertEstoque([linha], prazo);
      if (ri.erro === null) g.confirmados++;
      else if (ri.semConfirmacao) g.semConfirmacao.push(skuDa(linha));
      else g.falhas.push({ sku: skuDa(linha), erro: ri.erro });
    }
  }
  return g;
}

/** fonte_sync das linhas que a PRÓPRIA edge cria para o membro com PO fora do retrato — a marca de dono da reconciliação. */
export const FONTE_SEM_POSICAO = "PO_sem_posicao_ListarPosEstoque";

interface Reconciliacao {
  /** SKUs cujo par (0, pendente) o banco CONFIRMOU neste run (RETURNING do insert ou do update). */
  gravados: Set<string>;
  inseridos: number;
  atualizados: number;
  /** Insert que bateu em linha existente de OUTRA origem, ou update que não achou mais a linha nossa (corrida). */
  conflitos: number;
  falhas: number;
}

// Membros fora do retrato, com o prazo da cauda: INSERT … ON CONFLICT DO NOTHING em lote; o que o RETURNING não
// devolveu (a linha já existia) vai ao UPDATE condicionado à marca de dono E ao relógio. Sem fallback individual no
// insert: são poucos (0 em prod em 2026-11-18) e a falha não muda o desfecho. Lote com erro, sem confirmação ou não
// tentado conta como falha — só o RETURNING prova a linha.
async function reconciliarAusentes(
  ops: OpsPublicacao,
  e: EntradaPublicacao,
  inserir: Record<string, unknown>[],
  retratoAntesDe: string,
): Promise<Reconciliacao> {
  const r: Reconciliacao = { gravados: new Set(), inseridos: 0, atualizados: 0, conflitos: 0, falhas: 0 };
  const omitidos: Record<string, unknown>[] = [];
  const atualizar1 = async (linha: Record<string, unknown>): Promise<void> => {
    const prazo = prazoCauda(ops, e);
    if (prazo === 0) {
      r.falhas++;
      return;
    }
    const ru = await ops.atualizarLinhaSemPosicao(linha, retratoAntesDe, prazo);
    if (ru.erro !== null) {
      r.falhas++;
      ops.log("error", `update do membro ausente ${skuDa(linha)}${ru.semConfirmacao ? " (prazo, sem confirmação)" : ""}: ${ru.erro}`);
    } else if (ru.atualizado) {
      r.atualizados++;
      r.gravados.add(skuDa(linha));
    } else {
      r.conflitos++;
    }
  };
  for (let i = 0; i < inserir.length; i += e.chunk) {
    const lote = inserir.slice(i, i + e.chunk);
    const prazo = prazoCauda(ops, e);
    if (prazo === 0) {
      r.falhas += lote.length;
      continue;
    }
    const ri = await ops.inserirEstoqueSeAusente(lote, prazo);
    if (ri.erro !== null) {
      r.falhas += lote.length;
      ops.log("error", `insert dos membros ausentes ${i}-${i + lote.length}${ri.semConfirmacao ? " (prazo, sem confirmação)" : ""}: ${ri.erro}`);
      continue;
    }
    const inseridos = new Set(ri.inseridos);
    for (const linha of lote) {
      if (inseridos.has(skuDa(linha))) {
        r.inseridos++;
        r.gravados.add(skuDa(linha));
      } else {
        omitidos.push(linha);
      }
    }
  }
  // A linha já existia: o update condicionado (marca + relógio) decide — reconcilia a nossa; a de outra origem, ou com
  // retrato mais novo que a coleta deste run, fica intacta (conflito).
  for (const linha of omitidos) await atualizar1(linha);
  return r;
}

interface Inativacao {
  naoEncontrados: string[];
  completa: boolean;
  erro: string | null;
  alertasNovos: number;
}

// SKU habilitado que não apareceu numa varredura COMPLETA → ativo_no_omie=false + evento para humano. A v1.5 só
// logava as falhas daqui, e ignorava o erro das duas leituras: sem as datas existentes o upsert reescreveria a
// data_inativacao original com "agora"; sem os eventos pendentes, duplicaria o alerta. Falha agora degrada o run.
async function inativarNaoEncontrados(ops: OpsPublicacao, e: EntradaPublicacao): Promise<Inativacao> {
  const naoEncontrados = [...e.habilitados.keys()].filter((c) => !e.fisico.encontrados.has(c));
  if (naoEncontrados.length === 0) return { naoEncontrados, completa: true, erro: null, alertasNovos: 0 };
  ops.log("warn", `${naoEncontrados.length} SKUs habilitados não vieram do Omie: ${naoEncontrados.join(",")}`);
  const falhou = (erro: string): Inativacao => ({ naoEncontrados, completa: false, erro, alertasNovos: 0 });

  let prazo = prazoCauda(ops, e);
  if (prazo === 0) return falhou("sem tempo no run para a inativação");
  const datas = await ops.lerInativacoes(naoEncontrados, prazo);
  if (datas.erro !== null) return falhou(`leitura de sku_status_omie: ${datas.erro}`);

  const agoraIso = new Date(ops.agora()).toISOString();
  const status = naoEncontrados.map((codigo) => ({
    empresa: e.empresa,
    sku_codigo_omie: codigo,
    sku_descricao: e.habilitados.get(codigo) ?? null,
    ativo_no_omie: false,
    ultima_sincronizacao: agoraIso,
    fonte_sincronizacao: "nao_apareceu_em_ListarPosicaoEstoque",
    data_inativacao: datas.dados.get(codigo) ?? agoraIso,
  }));
  prazo = prazoCauda(ops, e);
  if (prazo === 0) return falhou("sem tempo no run para gravar sku_status_omie");
  const rs = await ops.upsertStatus(status, prazo);
  if (rs.erro !== null) return falhou(`upsert sku_status_omie${rs.semConfirmacao ? " (sem confirmação)" : ""}: ${rs.erro}`);

  prazo = prazoCauda(ops, e);
  if (prazo === 0) return falhou("sem tempo no run para os eventos");
  const pendentes = await ops.lerEventosPendentes(naoEncontrados, prazo);
  if (pendentes.erro !== null) return falhou(`leitura de eventos_outlier: ${pendentes.erro}`);
  const novos = naoEncontrados
    .filter((codigo) => !pendentes.dados.has(codigo))
    .map((codigo) => ({
      empresa: e.empresa,
      sku_codigo_omie: codigo,
      sku_descricao: e.habilitados.get(codigo) ?? null,
      tipo: "sku_inativado_omie",
      severidade: "atencao",
      data_evento: hojeSP(new Date(ops.agora())),
      detalhes: {
        mensagem:
          "SKU foi inativado no Omie. Decidir: (1) merge histórico com outro SKU, (2) descadastrar do módulo de reposição, (3) reativar manualmente no Omie.",
        detectado_em: agoraIso,
        fonte: "omie-sync-estoque",
      },
    }));
  if (novos.length === 0) return { naoEncontrados, completa: true, erro: null, alertasNovos: 0 };
  prazo = prazoCauda(ops, e);
  if (prazo === 0) return falhou("sem tempo no run para inserir os eventos");
  const ri = await ops.inserirEventos(novos, prazo);
  if (ri.erro !== null) return falhou(`insert eventos_outlier${ri.semConfirmacao ? " (sem confirmação)" : ""}: ${ri.erro}`);
  return { naoEncontrados, completa: true, erro: null, alertasNovos: novos.length };
}

// Observação do conjunto aberto (PR0 da baixa de PO) — ACESSÓRIA e nunca fatal. Só publica o que bate com o pendente
// gravado (senão mediria outra coisa); a ausência de um PO aqui nunca vira "fechado" — quem lê decide.
async function publicarObservacao(
  ops: OpsPublicacao,
  e: EntradaPublicacao,
  pend: ResultadoPendente,
  gravacaoCompleta: boolean,
  /** O pendente GRAVADO neste run: habilitados ∪ membros de grupo que entraram com o par. */
  pendenteGravado: Map<string, number>,
): Promise<{ publicada: boolean; motivo: string | null }> {
  const o = pend.observacao;
  if (o === null) return { publicada: false, motivo: null };
  let motivo: string;
  try {
    const prazoMs = timeoutRequestMs(ops.agora(), e.limiteCauda, e.prazos.tetoObservacaoMs);
    if (!o.coletaIntegra) {
      motivo = `coleta_incompleta: ${o.perdaColeta ?? "sem motivo"}`;
    } else if (!observacaoBateComPendente(o.observados, pendenteGravado)) {
      motivo = "observacao_diverge_do_pendente";
    } else if (prazoMs === 0) {
      motivo = "sem_tempo_no_run";
    } else {
      const r = await ops.publicarObservacao({
        run_id: crypto.randomUUID(),
        empresa: e.empresa,
        iniciado_em: new Date(e.iniciadoEm).toISOString(),
        concluido_em: new Date(ops.agora()).toISOString(),
        janela_de: o.janelaDe,
        janela_ate: o.janelaAte,
        filtros: e.filtrosPendente,
        varredura_completa: o.varreduraCompleta,
        // a AFIRMAÇÃO da edge (todas as linhas do par confirmadas); a RPC confere no banco, SKU a SKU
        pendente_aplicado: gravacaoCompleta,
        pedidos_lidos: new Set(o.observados.map((x) => x.omie_codigo_pedido)).size,
        versao_edge: e.versao,
      }, o.observados, prazoMs);
      if (r.erro === null) return { publicada: true, motivo: null };
      motivo = `rpc: ${r.erro}`;
    }
  } catch (err) {
    motivo = mensagemDeErro(err) ?? "falha sem mensagem";
  }
  ops.log("error", `observação do conjunto aberto não publicada: ${motivo}`);
  return { publicada: false, motivo };
}

async function gravarMarcador(ops: OpsPublicacao, linha: Record<string, unknown>, prazoMs: number): Promise<void> {
  // Best-effort: o marcador nunca derruba o run (padrão da irmã omie-sync-pedidos-compra), mas tem prazo fixo.
  const r = await ops.gravarMarcador(linha, prazoMs);
  if (r.erro !== null) ops.log("error", `marcador ${linha.entity_type} (${linha.status}) falhou: ${r.erro}`);
}

function motivoParcial(e: EntradaPublicacao, g: Gravacao, inat: Inativacao): string {
  const partes: string[] = [];
  const pendentes = g.falhas.length + g.semConfirmacao.length + g.naoTentados.length;
  if (pendentes > 0) {
    const ex = g.falhas[0] ? ` (ex.: ${g.falhas[0].sku}: ${g.falhas[0].erro})` : "";
    partes.push(
      `gravação parcial: ${pendentes} de ${e.fisico.encontrados.size} SKUs sem confirmação ` +
        `(falha ${g.falhas.length}, prazo ${g.semConfirmacao.length}, não tentado ${g.naoTentados.length})${ex}`,
    );
  }
  if (!inat.completa) partes.push(`inativação incompleta: ${inat.erro}`);
  return partes.join("; ");
}

/**
 * Do retrato do físico já lido até o resumo. Lança nas recusas (C2 físico, C1 pendente, gravação nenhuma confirmada) —
 * o catch do handler grava o marcador 'error' e responde 500. Devolve o resumo com `ok` derivado do desfecho.
 */
export async function concluirRun(ops: OpsPublicacao, e: EntradaPublicacao): Promise<Record<string, unknown>> {
  const v = e.fisico.veredito;
  // C2 — antes da fase do PO e de qualquer escrita.
  exigirFisicoPublicavel(v, e.fisico.faseMs);

  // Fase do PO DEPOIS do físico inteiro, em série (desenho, Codex P1 2026-10-05): lido antes, o PO conta duas vezes a
  // NF recebida no meio do run e o motor sub-sugere sem ninguém ver; nesta ordem a corrida erra para o lado visível.
  const tPo = ops.agora();
  const pend = await ops.lerPendente();
  const fasePoMs = ops.agora() - tPo;

  // C1 — antes de qualquer escrita.
  exigirPendenteConfiavel(pend, fasePoMs);

  const agoraIso = new Date(ops.agora()).toISOString();
  const linhas = [...e.fisico.encontrados].map(([codigo, agg]) => ({
    empresa: e.empresa,
    sku_codigo_omie: codigo,
    estoque_fisico: agg.fisico,
    estoque_disponivel: agg.fisico - agg.reservado,
    ultima_sincronizacao: agoraIso,
    fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
    // SKU sem PO aberto: 0 legítimo — a varredura do PO passou pelo gate de confiança acima.
    estoque_pendente_entrada: pend.pendente.get(codigo) ?? 0,
  }));

  const g = await gravarEstoque(ops, e, linhas);
  if (linhas.length > 0 && g.confirmados === 0) {
    // Nada CONFIRMADO não é "nada escrito": um request abortado pelo prazo pode ter gravado no banco.
    throw new Error(
      `${MARCA_GRAVACAO}: nenhuma das ${linhas.length} linhas de sku_estoque_atual confirmada ` +
        `(falha ${g.falhas.length}, prazo ${g.semConfirmacao.length}, não tentado ${g.naoTentados.length})`,
    );
  }
  const gravacaoCompleta = g.confirmados === linhas.length;

  // Inativação ANTES da observação: ela é efeito money-path (tira o SKU da compra); a observação é acessória.
  const inat = await inativarNaoEncontrados(ops, e);

  // Membro de grupo de equivalência NÃO habilitado: o motor SOMA o físico (GREATEST com a posição) e o pendente de todos
  // os membros do grupo, e a linha dele congelava no valor de quando era habilitado (o galão da WP01: 11,72 L de 31/07
  // com 0 confirmado no Omie). Grava o PAR da mesma varredura, num lote à parte: físico fresco com pendente velho
  // contaria a NF recebida duas vezes (o par misto que o C1 recusa). Sem o pendente dos membros na varredura, ou com
  // item de PO inválido do membro, não há par — a linha fica como está. Falha aqui não muda o desfecho; fica no resumo.
  const membros = e.fisico.membros ?? new Map<string, AgregadoSku>();
  const pendMembros = pend.pendenteMembros;
  const ilegiveisPo = new Set(pend.membrosPendenteIlegiveis ?? []);
  const linhasMembros = pendMembros === undefined ? [] : [...membros]
    .filter(([codigo]) => !ilegiveisPo.has(codigo))
    .map(([codigo, agg]) => ({
      empresa: e.empresa,
      sku_codigo_omie: codigo,
      estoque_fisico: agg.fisico,
      estoque_disponivel: agg.fisico - agg.reservado,
      ultima_sincronizacao: agoraIso,
      fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
      // Membro sem PO aberto: 0 legítimo — a mesma varredura passou pelo gate de confiança (C1) acima.
      estoque_pendente_entrada: pendMembros.get(codigo) ?? 0,
    }));
  const gm = await gravarEstoque(ops, e, linhasMembros);
  // Todo membro com item de PO ilegível (listado ou ausente do físico): ficou sem par, e o resumo diz quantos.
  const membrosIlegiveis = new Set([...(e.fisico.membrosIlegiveis ?? []), ...ilegiveisPo]);

  // v1.11 — membro com PO aberto AUSENTE do retrato. Sem linha em sku_estoque_atual o motor perdia o pendente dele, e o
  // pedido do app só contava até D−7 (corte pelo retrato do SKU, #3969): o PO era contado 0× e o grupo recomprava. O
  // físico é publicável aqui (C2 passou: a varredura com cExibeTodos=S foi COMPLETA), e o membro não veio nela — sem
  // posição. O PAR é (0, pendente da MESMA varredura): o motor já lia COALESCE(físico, 0) = 0 para o membro sem linha,
  // então o 0 não muda o físico do grupo — passa a existir o pendente e o retrato do dia.
  //   • INSERT … ON CONFLICT DO NOTHING para TODO membro atual ausente, com ou sem PO: o PO do APP é deduplicado do
  //     pendente (o em_transito o conta) e, sem o retrato do dia, o motor corta o em_transito em D−7 — com o sync
  //     atrasado, o PO fica 0×. Detectar o PO do app pelos itens do Omie falhava com item sem nCodProd (Codex, 2ª e 3ª
  //     rodadas); o retrato incondicional não depende disso.
  //   • O que o insert NÃO devolveu (a linha já existia) → UPDATE com a marca de dono E o relógio no WHERE: só a linha
  //     NOSSA (fonte_sync = FONTE_SEM_POSICAO) com retrato ANTERIOR ao início da coleta do PO deste run. Assim a linha
  //     nossa é reconciliada a cada run, inclusive para 0 (Codex P1, 1ª rodada: sem isso 10→4→0 ficava 10); um run mais
  //     velho nunca zera o retrato de um mais novo (3ª); e o perdedor de dois inserts simultâneos ainda reconcilia (4ª).
  //     Linha de OUTRA origem NUNCA é sobrescrita: a varredura completa ainda pode pular uma linha (LIMITE em
  //     fisico.ts), e zerar um físico lido antes seria fabricar.
  //   • Só MEMBRO ATUAL (a leitura da equivalência): ex-membro não ganha retrato fresco; sem a leitura (membrosGrupo
  //     ausente, ou pendenteMembros vazio por não saber quem é membro), NADA é escrito — zeraria a linha nossa às cegas.
  //   • Físico ilegível NÃO é ausente (ele veio na listagem); item de PO ilegível = sem par.
  const grupo = e.fisico.membrosErro ? undefined : e.fisico.membrosGrupo;
  const naListagem = new Set([...membros.keys(), ...(e.fisico.membrosIlegiveis ?? [])]);
  const ausente = (codigo: string) => !naListagem.has(codigo) && !ilegiveisPo.has(codigo);
  // O pendente dos membros só vale aqui com a leitura da equivalência (ver acima) — `pm` undefined = nada se escreve.
  const pm = grupo === undefined ? undefined : pendMembros;
  // O retrato do ausente é o INÍCIO da coleta do PO (não o fim): o update compara início com início, e o run que
  // começou depois vence em qualquer sobreposição (Codex P1, 5ª rodada: com o fim, A que começou antes e terminou depois
  // do início de B barrava o update de B, e o PO de B ficava 0×). É também o instante da leitura das chaves de dedup.
  const inicioColetaIso = new Date(tPo).toISOString();
  const linhasAusentes = pm === undefined || grupo === undefined ? [] : [...grupo].filter(ausente).map((codigo) => ({
    empresa: e.empresa,
    sku_codigo_omie: codigo,
    estoque_fisico: 0,
    estoque_disponivel: 0,
    ultima_sincronizacao: inicioColetaIso,
    fonte_sync: FONTE_SEM_POSICAO,
    estoque_pendente_entrada: pm.get(codigo) ?? 0,
  }));
  const ra = await reconciliarAusentes(ops, e, linhasAusentes, inicioColetaIso);

  // A observação conta o que o motor contou (habilitados ∪ membros com par ∪ ausentes CONFIRMADOS); o pendente só vale
  // como aplicado se os três lotes gravaram inteiros.
  const pendenteGravado = new Map(pend.pendente);
  for (const l of linhasMembros) pendenteGravado.set(l.sku_codigo_omie, l.estoque_pendente_entrada);
  for (const l of linhasAusentes) if (ra.gravados.has(l.sku_codigo_omie)) pendenteGravado.set(l.sku_codigo_omie, l.estoque_pendente_entrada);
  // Conflito (linha de outra origem, ou retrato mais novo) também tira o "aplicado": a observação não enxerga um 0 que
  // não foi gravado (Codex P2 2026-11-18, 2ª rodada).
  const aplicado = gravacaoCompleta && gm.confirmados === linhasMembros.length && ra.falhas === 0 && ra.conflitos === 0;
  const obs = await publicarObservacao(ops, e, pend, aplicado, pendenteGravado);

  const desfecho: Desfecho = gravacaoCompleta && inat.completa ? "completo" : "parcial";
  const duracaoMs = ops.agora() - e.iniciadoEm;
  const resumo: Record<string, unknown> = {
    ok: desfecho === "completo",
    desfecho,
    empresa: e.empresa,
    sync_iniciado_em: new Date(e.iniciadoEm).toISOString(),
    sync_concluido_em: new Date(ops.agora()).toISOString(),
    duracao_ms: duracaoMs,
    fase_fisico_ms: e.fisico.faseMs,
    fase_po_ms: fasePoMs,
    total_skus_esperados: e.habilitados.size,
    sincronizados: g.confirmados,
    nao_encontrados: inat.naoEncontrados.length,
    erros_upsert: g.falhas.length,
    upsert_sem_confirmacao: g.semConfirmacao.length,
    upsert_nao_tentados: g.naoTentados.length,
    inativacao_falhou: !inat.completa,
    alertas_novos: inat.alertasNovos,
    pendente_confiavel: pend.confiavel,
    pendente_problemas: pend.problemas.length,
    observacao_publicada: obs.publicada,
    observacao_motivo: obs.motivo,
    paginas_omie: e.fisico.paginas,
    total_produtos_omie: v.totalDeclarado,
    registros_lidos: v.registrosLidos,
    varredura_truncada: v.estado !== "completo",
    linhas_sem_local: v.linhasSemLocal,
    paginas_sem_total: v.paginasSemTotal,
    lista_nao_encontrados: inat.naoEncontrados,
    lista_erros: g.falhas,
    membros_grupo_encontrados: e.fisico.membrosErro ? null : membros.size,
    membros_grupo_erro: e.fisico.membrosErro ?? null,
    membros_grupo_gravados: gm.confirmados,
    membros_grupo_falhas: linhasMembros.length - gm.confirmados,
    membros_grupo_ilegiveis: membrosIlegiveis.size,
    ...(pendMembros === undefined && membros.size > 0 ? { membros_grupo_sem_pendente: true } : {}),
    membros_grupo_ausentes_com_po: linhasAusentes.filter((l) => l.estoque_pendente_entrada > 0).length,
    membros_grupo_ausentes_inseridos: ra.inseridos,
    membros_grupo_ausentes_reconciliados: ra.atualizados,
    membros_grupo_ausentes_ja_com_linha: ra.conflitos,
    membros_grupo_ausentes_falhas: ra.falhas,
  };
  ops.log("log", `resumo: ${JSON.stringify(resumo)}`);

  // Marcadores do Sentinela: 'partial' alerta "degradado" no sync_state_saude; 'complete' limpa a mensagem. O do
  // pendente é só OBEN (o check é OBEN-only; o ListarSaldoPendente da COLACOR não tem esteira de reposição).
  const erroParcial = desfecho === "parcial" ? motivoParcial(e, g, inat) : null;
  await gravarMarcador(
    ops,
    linhaMarcador(MARKER_FULL, e.empresa, desfecho === "completo" ? "complete" : "partial", {
      trigger: "run",
      desfecho,
      sincronizados: g.confirmados,
      nao_encontrados: inat.naoEncontrados.length,
      duracao_ms: duracaoMs,
      fase_fisico_ms: e.fisico.faseMs,
      fase_po_ms: fasePoMs,
    }, erroParcial, ops.agora()),
    e.prazos.marcadorMs,
  );
  if (e.empresa === "OBEN") {
    await gravarMarcador(
      ops,
      linhaMarcador(MARKER_PENDENTE_PO, e.empresa, gravacaoCompleta ? "complete" : "partial", {
        trigger: "run",
        skus_com_pendente: pend.pendente.size,
        duracao_ms: duracaoMs,
      }, gravacaoCompleta ? null : motivoParcial(e, g, { ...inat, completa: true }), ops.agora()),
      e.prazos.marcadorMs,
    );
  }
  return resumo;
}
