// Carga da fila do Radar em STAGING (migration 20261110130000): helpers PUROS do chunk e do finalize.
// Os chunks gravam em radar_empresas_carga (RPC radar_carga_receber) — a tabela viva só muda na publicação
// atômica do job radar-publicar-lote, depois que o finalize valida a contagem.

/** Campos cadastrais que a carga entrega por empresa — o MESMO conjunto que a publicação copia para
 *  radar_empresas. Sem ultimo_lote/updated_at (quem rotula a foto é a publicação) e sem
 *  primeira_vista_em / prospeccao_* / ja_cliente (preservação por omissão). */
export function montarLinhaStaging(l: Record<string, unknown>): Record<string, unknown> {
  return {
    cnpj: l.cnpj, razao_social: l.razao_social ?? null, nome_fantasia: l.nome_fantasia ?? null,
    cnae_principal: l.cnae_principal, cnae_descricao: l.cnae_descricao ?? null,
    cnaes_secundarios: l.cnaes_secundarios ?? [], data_abertura: l.data_abertura ?? null,
    porte: l.porte ?? null, capital_social: l.capital_social ?? null,
    logradouro: l.logradouro ?? null, numero: l.numero ?? null, complemento: l.complemento ?? null,
    bairro: l.bairro ?? null, municipio_codigo: l.municipio_codigo ?? null,
    municipio_nome: l.municipio_nome ?? null, uf: l.uf ?? null, cep: l.cep ?? null,
    telefone1: l.telefone1 ?? null, telefone2: l.telefone2 ?? null, email: l.email ?? null,
    socios_nomes: l.socios_nomes ?? null,
  };
}

/** Dedup intra-chunk (last-wins): CNPJ repetido no MESMO INSERT … ON CONFLICT derrubaria o statement com
 *  21000, permanente (retry nunca resolve). */
export function dedupPorCnpj(linhas: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Map(linhas.map((p) => [String(p.cnpj), p])).values()];
}

export type Esperado = { ok: true; valor: number } | { ok: false; erro: string };

/** `esperado` do finalize = quantas linhas a carga diz ter entregue (soma do `upserted` dos chunks). É a
 *  contagem contra a qual o staging é validado: ausente ≠ zero, e sem ela o lote NÃO é validado. */
export function lerEsperado(v: unknown): Esperado {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    return { ok: false, erro: "esperado obrigatório (inteiro > 0): quantas linhas a carga entregou nos chunks" };
  }
  return { ok: true, valor: v };
}
