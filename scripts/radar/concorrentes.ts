/**
 * Camada de concorrentes do mapa do Radar: revendas de tinta e verniz por município, agregadas por lote
 * do dump RFB. NÃO entram na fila de leads (`radar_empresas`) nem no recorte de `cnaes-alvo.txt`.
 *
 * CNAEs conferidos no Cnaes.zip do dump 2026-10:
 *   4679601  Comércio atacadista de tintas, vernizes e similares
 *   4741500  Comércio varejista de tintas e materiais para pintura
 * (4679-6/99 e 4744-0/05, citados no briefing, são "materiais de construção em geral" e "materiais de
 * construção não especificados" — fora do alvo.)
 */
export const CNAES_CONCORRENTES = ["4679601", "4741500"] as const;

export interface LinhaConcorrente {
  municipio_codigo: string;
  uf: string;
  cnae: string;
  quantidade: number;
}

export interface BrutaConcorrente {
  mun?: string | null;
  uf?: string | null;
  cnae1?: string | null;
  n?: number | string | null;
}

type MotivoRejeicao = "municipio" | "uf" | "cnae" | "quantidade";

/** Agrega as contagens por (município, CNAE) vindas do scan e monta a publicação. O total é a soma do que
 *  vai nas linhas: a RPC `radar_concorrentes_publicar` reconcilia os dois. Linha fora do formato é
 *  rejeitada e CONTADA por motivo. */
export function montarPublicacao(brutas: BrutaConcorrente[], cnaes: readonly string[]) {
  const rejeitadas: Record<MotivoRejeicao, number> = { municipio: 0, uf: 0, cnae: 0, quantidade: 0 };
  const porChave = new Map<string, LinhaConcorrente>();
  for (const b of brutas) {
    const municipio = (b.mun ?? "").trim();
    const uf = (b.uf ?? "").trim();
    const cnae = (b.cnae1 ?? "").trim();
    const n = b.n == null || b.n === "" ? NaN : Number(b.n);
    if (!municipio) { rejeitadas.municipio++; continue; }
    if (!/^[A-Z]{2}$/.test(uf)) { rejeitadas.uf++; continue; }
    if (!cnaes.includes(cnae)) { rejeitadas.cnae++; continue; }
    if (!Number.isInteger(n) || n <= 0) { rejeitadas.quantidade++; continue; }
    const chave = `${municipio}|${cnae}`;
    const atual = porChave.get(chave);
    if (atual) atual.quantidade += n;
    else porChave.set(chave, { municipio_codigo: municipio, uf, cnae, quantidade: n });
  }
  const linhas = [...porChave.values()].sort((a, b) =>
    a.municipio_codigo.localeCompare(b.municipio_codigo) || a.cnae.localeCompare(b.cnae));
  const estabelecimentos = linhas.reduce((s, l) => s + l.quantidade, 0);
  return { linhas, estabelecimentos, rejeitadas };
}
