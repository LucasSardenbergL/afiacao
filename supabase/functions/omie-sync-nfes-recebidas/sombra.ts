// Orquestra a SOMBRA da associação NF↔PO para UMA NF: busca os POs dos contratos, classifica (associacao.ts) e
// publica (RPC recebimento_associacao_sombra_publicar, compare-and-set por observado_em). Nada vai ao Omie.
//
// Contrato com o laço principal (pareceres Codex 2026-10-16 achado 10 e 2026-10-17): a sombra roda numa FASE
// POSTERIOR ao vínculo NF↔PO, com orçamento próprio, e NUNCA lança. Estado decidido só pela NF (fora de alcance, já
// vinculada, órfã) é publicado sem buscar POs; falha na busca publica `ambigua` + `leitura_po_falhou` — a proposta
// verde anterior não sobrevive como evidência vigente. Invariante: tentadas = gravadas + leituras_velhas +
// falhas_publicacao; leituras_po_falhas ≤ tentadas.

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
): Promise<Classificacao | null> {
  if (!temTempo()) { resumo.puladas_por_tempo++; return null; }
  resumo.tentadas++;
  const base = { detalhe, fornecedor_codigo_omie: nf.fornecedor_codigo_omie, skusComEquivalencia };
  let c = classificarAssociacao({ ...base, pedidosPorContrato: null });
  const contratos = contratosDoDetalhe(detalhe).filter((x) => !x.includes("/"));
  if (!DECIDIDA_PELA_NF.has(c.classe)) {
    try {
      // Sem contrato buscável (só compostos "a/b") a consulta é vazia por definição — não "não consultada".
      const pedidos = contratos.length > 0 ? await porta.buscarPedidos(contratos) : new Map<string, PedidoDoContrato[]>();
      c = classificarAssociacao({ ...base, pedidosPorContrato: pedidos });
    } catch (err) {
      resumo.leituras_po_falhas++;
      c = { ...c, classe: "ambigua", motivos: [...new Set([...c.motivos, "leitura_po_falhou"])].sort(), pares: [], pedidos: [] };
      console.warn(`[sync-nfes] sombra nIdReceb=${nf.nIdReceb} leitura de POs falhou (publica ambígua): ${err instanceof Error ? err.message : String(err)}`);
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
    console.warn(`[sync-nfes] sombra nIdReceb=${nf.nIdReceb} publicação falhou (o vínculo segue): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface ItemFilaSombra {
  nf: NFParaSombra;
  detalhe: unknown;
  /** Carimbo tirado ANTES da consulta da NF: ordena a evidência pela leitura, não pela chegada da resposta. */
  observadoEm: string;
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
  for (const f of fila) await executarSombra(porta, f.nf, f.detalhe, skus, f.observadoEm, temTempo, resumo);
}
