/**
 * Sócios PF com CPF MASCARADO (`***dddddd**`, como a Receita publica) para `radar_socios` — passo 3 do "Radar
 * sucessor" (migration 20261107040000). A carga lê o QSA do país inteiro (Socios*.zip, já baixado para a fila) e:
 *   - guarda só as raízes do recorte ∪ dos CNPJs conhecidos (clientes fora do recorte entram aqui);
 *   - conta, no PAÍS, em quantas empresas a chave (nome normalizado + máscara) aparece (`n_raizes_pais`) — é o filtro
 *     que tira diretor/conselheiro de S.A. grande e síndico (medido em 2026-11-06);
 *   - minimiza: só PF com máscara válida; sem representante legal, faixa etária ou país (LGPD).
 *
 * A normalização do nome TEM de ser a de `private.radar_nome_norm` (a regra casa o QSA com o titular de MEI, cujo nome
 * o banco normaliza). Os mapas abaixo são os da migration — `socios.test.ts` lê o arquivo e compara.
 */
import { createHash } from "node:crypto";

export const NOME_DE = "áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ";
export const NOME_PARA = "aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY";

/** Versão da transformação da carga (vai para o manifesto do lote: conteúdo de outra versão = outro lote). */
export const VERSAO_CARGA_SOCIOS = "socios-v1";
export const MAX_LINHAS_CHUNK_SOCIOS = 5000;

/** Expressão DuckDB equivalente a `private.radar_nome_norm(col)`. */
export const sqlNomeNorm = (col: string): string =>
  `trim(regexp_replace(upper(translate(${col}, '${NOME_DE}', '${NOME_PARA}')), '\\s+', ' ', 'g'))`;

/** A mesma normalização em TS (usada pelos testes e por quem precisar comparar fora do DuckDB). */
export function nomeNorm(nome: string): string | null {
  let s = "";
  for (const ch of nome) {
    const i = NOME_DE.indexOf(ch);
    s += i >= 0 ? NOME_PARA[i] : ch;
  }
  const r = s.toUpperCase().replace(/\s+/g, " ").trim();
  return r || null;
}

export interface LinhaSocio {
  raiz: string;
  nome_normalizado: string;
  cpf_mascarado: string;
  qualificacao: string;
  data_entrada: string | null;
  n_raizes_pais: number;
}

/** Digest do CONTEÚDO do lote (linhas já ordenadas pela carga): o manifesto do banco é imutável por digest. */
export function digestSocios(linhas: readonly LinhaSocio[]): string {
  const h = createHash("sha256");
  for (const l of linhas) {
    h.update(JSON.stringify([l.raiz, l.nome_normalizado, l.cpf_mascarado, l.qualificacao, l.data_entrada, l.n_raizes_pais]));
    h.update("\n");
  }
  return h.digest("hex");
}

export function emChunks<T>(xs: readonly T[], n: number): T[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`emChunks: tamanho inválido ${n}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** SQL DuckDB que gera as linhas de `radar_socios` (ordenadas, deduplicadas) a partir do QSA e do universo. */
export function sqlLinhasSocios(socCsvGlob: string, universoSql: string, saidaJsonl: string): string {
  return `
    CREATE TEMP TABLE uni AS ${universoSql};
    CREATE TEMP TABLE pf AS
      SELECT lpad(b, 8, '0') AS b, ${sqlNomeNorm("nome")} AS nome, doc AS mask, qualif,
             CAST(try_strptime(dt_entrada, '%Y%m%d') AS DATE) AS dt
        FROM read_csv('${socCsvGlob}', delim=';', header=false, quote='"', all_varchar=true, parallel=false,
                      names=['b','tipo','nome','doc','qualif','dt_entrada','pais','rep_cpf','rep_nome','rep_qualif','faixa'])
       WHERE tipo = '2' AND regexp_full_match(doc, '\\*\\*\\*[0-9]{6}\\*\\*') AND regexp_full_match(qualif, '[0-9]{2}');
    CREATE TEMP TABLE npais AS SELECT nome, mask, count(DISTINCT b) AS n FROM pf GROUP BY nome, mask;
    COPY (
      SELECT pf.b AS raiz, pf.nome AS nome_normalizado, pf.mask AS cpf_mascarado, pf.qualif AS qualificacao,
             strftime(min(pf.dt), '%Y-%m-%d') AS data_entrada, max(np.n)::INTEGER AS n_raizes_pais
        FROM pf JOIN uni ON uni.b = pf.b JOIN npais np ON np.nome = pf.nome AND np.mask = pf.mask
       WHERE regexp_full_match(pf.nome, '[^ ]+( [^ ]+)+') AND length(pf.nome) <= 200 AND regexp_full_match(pf.b, '[0-9A-Z]{8}')
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
    ) TO '${saidaJsonl}' (FORMAT json);`;
}
