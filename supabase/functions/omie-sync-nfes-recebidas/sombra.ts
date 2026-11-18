// Orquestra a SOMBRA da associação NF↔PO para UMA NF: busca os POs dos contratos, classifica (associacao.ts) e
// publica (RPC recebimento_associacao_sombra_publicar, compare-and-set por observado_em). Nada vai ao Omie.
//
// Contrato com o laço principal (pareceres Codex 2026-10-16 achado 10 e 2026-10-17): a sombra roda numa FASE
// POSTERIOR ao vínculo NF↔PO, com orçamento próprio, e NUNCA lança. Estado decidido só pela NF (fora de alcance, já
// vinculada, órfã) é publicado sem buscar POs; falha na busca publica `ambigua` + `leitura_po_falhou` — a proposta
// verde anterior não sobrevive como evidência vigente. Invariante: tentadas = gravadas + leituras_velhas +
// falhas_publicacao; leituras_po_falhas ≤ tentadas.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  classificarAssociacao,
  type Classificacao,
  type PedidoDoContrato,
  VERSAO_CLASSIFICADOR,
} from "./associacao.ts";

export interface SombraSummary {
  tentadas: number;
  gravadas: number;
  leituras_velhas: number;
  falhas_publicacao: number;
  leituras_po_falhas: number;
  puladas_por_tempo: number;
  /** Contagem por classe das classificações deste run (não é o estado da tabela). */
  por_classe: Record<string, number>;
  /** Revisita das pendentes antigas (v1.11). As reconsultadas entram em tentadas/gravadas como qualquer NF. */
  pendentes?: PendentesSummary;
}

export function novaSombraSummary(): SombraSummary {
  return { tentadas: 0, gravadas: 0, leituras_velhas: 0, falhas_publicacao: 0, leituras_po_falhas: 0, puladas_por_tempo: 0, por_classe: {} };
}

export interface PortaSombra {
  /** POs (todos, qualquer situação) de cada contrato, por empresa. Lança em erro de leitura. `sinal` = teto
   *  compartilhado de quem chama (a captura); sem ele, a porta usa o prazo de uma leitura. */
  buscarPedidos(contratos: string[], sinal?: AbortSignal): Promise<Map<string, PedidoDoContrato[]>>;
  /** Devolve o texto da RPC ('gravada' | 'leitura_velha'). Lança em erro. */
  publicar(linha: Record<string, unknown>): Promise<string>;
}

export interface NFParaSombra {
  empresa: string;
  nIdReceb: number;
  numero_nfe: string | null;
  chave_nfe: string | null;
  fornecedor_codigo_omie: number | null;
}

/** Contratos citados pela NF (texto cru de nNumPedCompra, sem "0"/vazio) — a busca; o casamento é por item. */
export function contratosDoDetalhe(detalhe: unknown): string[] {
  const itens = (detalhe as { itensRecebimento?: unknown } | null)?.itensRecebimento;
  if (!Array.isArray(itens)) return [];
  const set = new Set<string>();
  for (const it of itens) {
    const v = (it as { itensInfoAdic?: { nNumPedCompra?: unknown } } | null)?.itensInfoAdic?.nNumPedCompra;
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (s !== "" && s !== "0") set.add(s);
  }
  return [...set].sort();
}

const DECIDIDA_PELA_NF = new Set(["fora_de_alcance", "ja_vinculada", "orfa"]);

export async function executarSombra(
  porta: PortaSombra,
  nf: NFParaSombra,
  detalhe: unknown,
  skusComEquivalencia: ReadonlySet<string> | null,
  observadoEm: string,
  temTempo: () => boolean,
  resumo: SombraSummary,
  pedidosCapturados?: ReadonlyMap<string, PedidoDoContrato[]>,
): Promise<Classificacao | null> {
  if (!temTempo()) { resumo.puladas_por_tempo++; return null; }
  resumo.tentadas++;
  const base = { detalhe, fornecedor_codigo_omie: nf.fornecedor_codigo_omie, skusComEquivalencia };
  let c = classificarAssociacao({ ...base, pedidosPorContrato: null });
  const contratos = contratosDoDetalhe(detalhe).filter((x) => !x.includes("/"));
  if (!DECIDIDA_PELA_NF.has(c.classe)) {
    try {
      // Sem contrato buscável (só compostos "a/b") a consulta é vazia por definição — não "não consultada".
      const pedidos = contratos.length === 0 ? new Map<string, PedidoDoContrato[]>()
        : pedidosCapturados ?? await porta.buscarPedidos(contratos);
      c = classificarAssociacao({ ...base, pedidosPorContrato: pedidos });
    } catch (err) {
      resumo.leituras_po_falhas++;
      c = { ...c, classe: "ambigua", motivos: [...new Set([...c.motivos, "leitura_po_falhou"])].sort(), pares: [], pedidos: [] };
      console.warn(`[sync-nfes] sombra nIdReceb=${nf.nIdReceb} leitura de POs falhou (publica ambígua): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    }
  }
  resumo.por_classe[c.classe] = (resumo.por_classe[c.classe] ?? 0) + 1;
  try {
    const r = await porta.publicar({
      empresa: nf.empresa, nid_receb: nf.nIdReceb, numero_nfe: nf.numero_nfe, chave_nfe: nf.chave_nfe,
      fornecedor_codigo_omie: nf.fornecedor_codigo_omie, estado_nf: c.estado_nf, vinculo: c.vinculo, classe: c.classe,
      motivos: c.motivos, contratos: c.contratos, pares: c.pares, pedidos: c.pedidos,
      versao_classificador: VERSAO_CLASSIFICADOR, observado_em: observadoEm,
    });
    if (r === "gravada") resumo.gravadas++;
    else if (r === "leitura_velha") resumo.leituras_velhas++;
    else throw new Error(`resposta inesperada da RPC: ${String(r).slice(0, 60)}`);
    return c;
  } catch (err) {
    resumo.falhas_publicacao++;
    console.warn(`[sync-nfes] sombra nIdReceb=${nf.nIdReceb} publicação falhou (o vínculo segue): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    return null;
  }
}

export interface ItemFilaSombra {
  nf: NFParaSombra;
  detalhe: unknown;
  /** Carimbo antes do fetch da tentativa que trouxe a NF: ordena a evidência pela leitura, não pela chegada. */
  observadoEm: string;
  /** POs dos contratos capturados antes do backfill (capturarPedidosDaFila); ausente = a fase busca ao vivo. */
  pedidos?: ReadonlyMap<string, PedidoDoContrato[]>;
}

const CONTRATOS_POR_LEITURA = 50;

/** Uma leitura em lote dos POs da fila, ANTES do backfill (que troca o raw_data do PO pelo recebimento — Codex
 *  2026-10-17). Sem tempo ou com erro, não captura nada: a fase busca ao vivo, e o raw_data já trocado só pode
 *  virar `po_sem_itens` (ambígua), nunca proposta falsa. Nunca lança. */
export async function capturarPedidosDaFila(
  fila: ItemFilaSombra[],
  porta: PortaSombra,
  temTempo: () => boolean,
  prazoTotalMs: number,
): Promise<void> {
  const contratos = [...new Set(fila.flatMap((f) => contratosDoDetalhe(f.detalhe).filter((c) => !c.includes("/"))))].sort();
  if (contratos.length === 0 || !temTempo()) return;
  // UM teto para a captura inteira (Codex 2026-10-17, 3ª rodada): ela roda antes da reconciliação e do backfill.
  const sinal = AbortSignal.timeout(prazoTotalMs);
  const mapa = new Map<string, PedidoDoContrato[]>();
  try {
    for (let i = 0; i < contratos.length; i += CONTRATOS_POR_LEITURA) {
      if (!temTempo() || sinal.aborted) return;
      for (const [k, v] of await porta.buscarPedidos(contratos.slice(i, i + CONTRATOS_POR_LEITURA), sinal)) mapa.set(k, v);
    }
  } catch (err) {
    console.warn(`[sync-nfes] sombra: captura dos POs falhou (a fase busca ao vivo): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    return;
  }
  for (const f of fila) f.pedidos = mapa;
}

// ─── Revisita das PENDENTES (v1.11) ───────────────────────────────────────────────────────────────────────────────
// A fila acima só traz NFs da janela de 3 dias do laço: NF que fica pendente no Omie por mais tempo CONGELAVA na
// tabela (medido 2026-11-18: 16 de 19 pendentes com leitura de 2 a 31 dias; o card "PO a baixar no Omie" as marca
// `evidencia_desatualizada`). Agora a fase relê, por ConsultarRecebimento, as pendentes mais antigas da tabela até
// virarem concluída/cancelada. Só LEITURA do Omie. Precisão > recall: consulta que falha (exceção, faultstring, resposta
// de outra NF, carimbo ausente) NÃO publica nada — a linha fica com a leitura velha e o card segue avisando; ausência
// nunca vira "concluída". O CAS por observado_em da RPC protege contra run atrasado. Os POs são lidos ao vivo (o
// backfill já rodou): raw_data trocado só pode virar `po_sem_itens` (ambígua), nunca proposta falsa — o mesmo
// caminho da fila quando a captura falha.

/** Teto de reconsultas por run e empresa (mais antigas primeiro). ~3 s cada (1,1 s de rate-limit + Omie + PO +
 *  RPC); o cron é de 2 h e o run típico dura ~25 s (fin_sync_log 2026-11-18), então 20 cabem sem apertar a revisita. */
export const TETO_PENDENTES_POR_RUN = 20;

export interface PendenteDaSombra {
  nid_receb: number;
  numero_nfe: string | null;
  chave_nfe: string | null;
  fornecedor_codigo_omie: number | null;
}

export interface PortaPendentes {
  /** Linhas `estado_nf='pendente'` da empresa, `observado_em` mais antigo primeiro, no máximo `limite`. Lança em erro. */
  listarPendentes(limite: number): Promise<PendenteDaSombra[]>;
  /** ConsultarRecebimento da NF. `lidoEm` = carimbo antes do fetch da tentativa que respondeu. Lança em erro ou
   *  faultstring — nunca devolve detalhe vazio como se fosse leitura. */
  consultar(nIdReceb: number): Promise<{ detalhe: unknown; lidoEm: string }>;
}

interface PendentesSummary {
  listadas: number;
  reconsultadas: number;
  falhas_consulta: number;
  ja_lidas_no_run: number;
  puladas_por_tempo: number;
  erro_listagem: boolean;
}

function nIdDoDetalhe(detalhe: unknown): number | null {
  const v = (detalhe as { cabec?: { nIdReceb?: unknown } } | null)?.cabec?.nIdReceb;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function revisitarPendentes(
  empresa: string,
  revisita: { porta: PortaPendentes; lidasNoRun: Set<number>; teto: number },
  porta: PortaSombra,
  skus: ReadonlySet<string> | null,
  temTempo: () => boolean,
  resumo: SombraSummary,
): Promise<void> {
  const r: PendentesSummary = { listadas: 0, reconsultadas: 0, falhas_consulta: 0, ja_lidas_no_run: 0, puladas_por_tempo: 0, erro_listagem: false };
  resumo.pendentes = r;
  let lista: PendenteDaSombra[];
  try {
    lista = await revisita.porta.listarPendentes(revisita.teto);
  } catch (err) {
    r.erro_listagem = true;
    console.warn(`[sync-nfes] sombra ${empresa}: listagem das pendentes falhou (nada relido): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    return;
  }
  r.listadas = lista.length;
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    const nIdReceb = Number(p.nid_receb);
    // Já lida neste run (laço da janela de 3 dias): a fila acima já a publicou; repetir seria REDUNDANT na Omie.
    if (revisita.lidasNoRun.has(nIdReceb)) { r.ja_lidas_no_run++; continue; }
    if (!temTempo()) { r.puladas_por_tempo += lista.length - i; return; }
    revisita.lidasNoRun.add(nIdReceb);
    let detalhe: unknown;
    let lidoEm: string;
    try {
      ({ detalhe, lidoEm } = await revisita.porta.consultar(nIdReceb));
      if (typeof lidoEm !== "string" || lidoEm === "") throw new Error("leitura sem carimbo");
      const nid = nIdDoDetalhe(detalhe);
      if (nid !== null && nid !== nIdReceb) throw new Error(`resposta de outra NF (nIdReceb=${nid})`);
    } catch (err) {
      r.falhas_consulta++;
      console.warn(`[sync-nfes] sombra ${empresa} pendente nIdReceb=${nIdReceb}: consulta falhou (NÃO publica): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
      continue;
    }
    r.reconsultadas++;
    const nf: NFParaSombra = {
      empresa, nIdReceb, numero_nfe: p.numero_nfe, chave_nfe: p.chave_nfe,
      fornecedor_codigo_omie: p.fornecedor_codigo_omie == null ? null : Number(p.fornecedor_codigo_omie),
    };
    await executarSombra(porta, nf, detalhe, skus, lidoEm, temTempo, resumo);
  }
}

/** Fase da sombra de uma empresa: roda DEPOIS de todo o trabalho prioritário do run, no tempo que sobrar. Com
 *  `revisita`, depois da fila relê as pendentes antigas da tabela (acima). */
export async function executarFaseSombra(
  fila: readonly ItemFilaSombra[],
  porta: PortaSombra,
  lerEquivalencias: () => Promise<ReadonlySet<string> | null>,
  temTempo: () => boolean,
  resumo: SombraSummary,
  revisita?: { empresa: string; porta: PortaPendentes; lidasNoRun: Set<number>; teto: number },
): Promise<void> {
  if (fila.length === 0 && !revisita) return;
  if (!temTempo()) { resumo.puladas_por_tempo += fila.length; return; }
  let skus: ReadonlySet<string> | null;
  try { skus = await lerEquivalencias(); } catch { skus = null; }
  for (const f of fila) await executarSombra(porta, f.nf, f.detalhe, skus, f.observadoEm, temTempo, resumo, f.pedidos);
  if (revisita) await revisitarPendentes(revisita.empresa, revisita, porta, skus, temTempo, resumo);
}
