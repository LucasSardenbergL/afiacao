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
}

export function novaSombraSummary(): SombraSummary {
  return { tentadas: 0, gravadas: 0, leituras_velhas: 0, falhas_publicacao: 0, leituras_po_falhas: 0, puladas_por_tempo: 0, por_classe: {} };
}

export interface PortaSombra {
  /** POs (todos, qualquer situação) de cada contrato, por empresa. Lança em erro de leitura. */
  buscarPedidos(contratos: string[]): Promise<Map<string, PedidoDoContrato[]>>;
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
): Promise<void> {
  const contratos = [...new Set(fila.flatMap((f) => contratosDoDetalhe(f.detalhe).filter((c) => !c.includes("/"))))].sort();
  if (contratos.length === 0 || !temTempo()) return;
  const mapa = new Map<string, PedidoDoContrato[]>();
  try {
    for (let i = 0; i < contratos.length; i += CONTRATOS_POR_LEITURA) {
      if (!temTempo()) return;
      for (const [k, v] of await porta.buscarPedidos(contratos.slice(i, i + CONTRATOS_POR_LEITURA))) mapa.set(k, v);
    }
  } catch (err) {
    console.warn(`[sync-nfes] sombra: captura dos POs falhou (a fase busca ao vivo): ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    return;
  }
  for (const f of fila) f.pedidos = mapa;
}

/** Fase da sombra de uma empresa: roda DEPOIS de todo o trabalho prioritário do run, no tempo que sobrar. */
export async function executarFaseSombra(
  fila: readonly ItemFilaSombra[],
  porta: PortaSombra,
  lerEquivalencias: () => Promise<ReadonlySet<string> | null>,
  temTempo: () => boolean,
  resumo: SombraSummary,
): Promise<void> {
  if (fila.length === 0) return;
  if (!temTempo()) { resumo.puladas_por_tempo += fila.length; return; }
  let skus: ReadonlySet<string> | null;
  try { skus = await lerEquivalencias(); } catch { skus = null; }
  for (const f of fila) await executarSombra(porta, f.nf, f.detalhe, skus, f.observadoEm, temTempo, resumo, f.pedidos);
}
