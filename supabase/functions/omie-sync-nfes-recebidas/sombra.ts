// Orquestra a SOMBRA da associação NF↔PO para UMA NF: busca os POs dos contratos, classifica (associacao.ts) e
// publica (RPC recebimento_associacao_sombra_publicar, compare-and-set por observado_em). Nada vai ao Omie.
//
// Contrato com o laço principal (parecer Codex 2026-10-16, achado 10): a sombra NUNCA derruba o vínculo NF↔PO —
// roda depois dele, NUNCA lança, e tem contadores próprios com denominador (tentadas = classificadas + falhas;
// gravadas + velhas ≤ classificadas). Saúde do vínculo e saúde da sombra ficam distinguíveis no fin_sync_log.

import {
  classificarAssociacao,
  type Classificacao,
  type PedidoDoContrato,
  VERSAO_CLASSIFICADOR,
} from "./associacao.ts";

export interface SombraSummary {
  tentadas: number;
  classificadas: number;
  gravadas: number;
  leituras_velhas: number;
  falhas: number;
  puladas_por_tempo: number;
  /** Contagem por classe das classificadas neste run (não é o estado da tabela). */
  por_classe: Record<string, number>;
}

export function novaSombraSummary(): SombraSummary {
  return { tentadas: 0, classificadas: 0, gravadas: 0, leituras_velhas: 0, falhas: 0, puladas_por_tempo: 0, por_classe: {} };
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
  try {
    const contratos = contratosDoDetalhe(detalhe).filter((c) => !c.includes("/"));
    const pedidosPorContrato = contratos.length > 0 ? await porta.buscarPedidos(contratos) : new Map();
    const c = classificarAssociacao({ detalhe, fornecedor_codigo_omie: nf.fornecedor_codigo_omie, pedidosPorContrato, skusComEquivalencia });
    resumo.classificadas++;
    resumo.por_classe[c.classe] = (resumo.por_classe[c.classe] ?? 0) + 1;
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
    resumo.falhas++;
    console.warn(`[sync-nfes] sombra nIdReceb=${nf.nIdReceb} falhou (o vínculo segue): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
