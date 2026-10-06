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
export type Desfecho = "completo" | "parcial";

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

export interface ResultadoLeitura<T> {
  erro: string | null;
  dados: T;
}

export interface ObservacaoPo {
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
}

export interface OpsPublicacao {
  /** Relógio de parede (Date.now em produção). */
  agora(): number;
  /** Fase do PO. LANÇA em erro de varredura — fatal por desenho (Codex P1 2026-06-20). */
  lerPendente(): Promise<ResultadoPendente>;
  upsertEstoque(linhas: Record<string, unknown>[], prazoMs: number): Promise<ResultadoEscrita>;
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
export function exigirPendenteConfiavel(r: Pick<ResultadoPendente, "confiavel" | "problemas">, fasePoMs: number): void {
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
): Promise<{ publicada: boolean; motivo: string | null }> {
  const o = pend.observacao;
  if (o === null) return { publicada: false, motivo: null };
  let motivo: string;
  try {
    const prazoMs = timeoutRequestMs(ops.agora(), e.limiteCauda, e.prazos.tetoObservacaoMs);
    if (!o.coletaIntegra) {
      motivo = `coleta_incompleta: ${o.perdaColeta ?? "sem motivo"}`;
    } else if (!observacaoBateComPendente(o.observados, pend.pendente)) {
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
  const obs = await publicarObservacao(ops, e, pend, gravacaoCompleta);

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
