// formula-identica.ts — o lote de /formulas que só reenvia fórmulas IDÊNTICAS à última staging da chave.
//
// O conector 0.2.5 reenvia, a cada ciclo (~10,5 min), a fórmula PERSONALIZADA mais recente: a entidade
// `formulaperson` tem HWM com margem de 5 min e a consulta de delta é `> hwm − 5min`, então a linha de
// `data_atualizacao` máxima volta em todo ciclo; e o filtro de hash só roda com HWM zerado
// (connector/sayersync/sync.go `applyHashFilter := hwm.IsZero()`). Medido em 2026-10-27 (psql-ro): um
// revezamento COPAIBA → VERDE ACRILICO → CHOCOLATE → ERVA MATE, cada troca no instante em que nasce uma
// personalizada nova; só a ERVA MATE foram 442 reenvios byte-idênticos. Cada um abria um run de 1 registro
// e a promoção re-expandia o PAR (cod_produto, id_base) inteiro: ~8.240 fórmulas e ~320 MB de disco lidos.
// Esse lote agora recebe o MESMO ack do catálogo vazio (catalogo-vazio.ts), sem run e sem fila.
//
// Money-path (precisão > recall): o conector cacheia o hash no 200, então um falso "idêntico" seria um dado
// perdido calado; um falso "diferente" custa só I/O. Por isso o descarte exige, para CADA fórmula do lote:
//   · a última staging da MESMA chave da promoção — (account, store_code, cor_id, cod_produto, id_base,
//     COALESCE(subcolecao,''), personalizada), ordem created_at DESC, id DESC (= `_formulas_latest`);
//   · raw_data idêntico ao payload (comparação canônica, ordem de chave irrelevante, ausente ≠ null);
//   · cada coluna do header que a promoção lê idêntica à que o builder de HOJE gravaria (pega linha
//     gravada por uma versão antiga da edge, ex. is_base_pura antes da Fase 1d);
//   · os itens gravados (id_corante, ordem, qtd_ml) idênticos, como multiconjunto, aos que seriam gravados;
//   · o run dessa linha com promocao_status = 'promovido' (fila pendente ou run fora da fila → caminho normal).
// Lote com fórmula inválida, vazio ou maior que MAX_FORMULAS_CHECADAS segue o caminho normal.
// Com tudo igual, o estado após o descarte é o mesmo de uma fórmula cujo hash o conector cacheou (o caminho
// das outras ~135 mil): a staging da chave fica como está e a promoção seguinte do par a relê.
//
// Testável com `deno test --no-remote` (formula-identica_test.ts) — não reimplementar inline no index.
import { montarStagingFormulaRow, montarStagingItemRows, type TintFormulaPayload } from "./staging-rows.ts";

/** Teto de fórmulas checadas (3 consultas cada). O laço medido é de 1; lote maior segue o caminho normal. */
export const MAX_FORMULAS_CHECADAS = 5;

/** Quantas linhas mais recentes da chave sem subcoleção ler; a 1ª da subcoleção certa é a última dela. */
export const JANELA_ULTIMAS = 20;

/** Colunas do header que a promoção lê de tint_staging_formulas (`_formulas_latest`), além do raw_data. */
export const COLUNAS_HEADER = [
  "cor_id",
  "nome_cor",
  "cod_produto",
  "id_base",
  "id_embalagem",
  "subcolecao",
  "volume_final_ml",
  "preco_final",
  "personalizada",
  "expected_item_count",
  "is_base_pura",
] as const;

/** O select da última staging: id, run, ordenação, raw_data e as colunas comparadas. */
export const SELECT_ULTIMA = ["id", "sync_run_id", "created_at", "raw_data", ...COLUNAS_HEADER].join(", ");

/** Linha de tint_staging_formulas como o PostgREST a devolve. */
export type LinhaStaging = Record<string, unknown> & { id: string; sync_run_id: string };

/** Linha de tint_staging_formula_itens como o PostgREST a devolve. */
export interface ItemStaging {
  id_corante: unknown;
  ordem: unknown;
  qtd_ml: unknown;
}

/** JSON com chaves ordenadas em todo nível; `undefined` vira null (coluna ausente no builder = NULL no banco).
 *  Chave AUSENTE continua ≠ chave com null: o conjunto de chaves entra na string (raw_data jsonb preserva). */
export function jsonCanonico(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** O lote é candidato: array de 1..MAX fórmulas, todas com os campos que o caminho normal exige. */
export function loteElegivel(formulas: unknown): formulas is TintFormulaPayload[] {
  if (!Array.isArray(formulas) || formulas.length === 0 || formulas.length > MAX_FORMULAS_CHECADAS) return false;
  return formulas.every((f) =>
    f !== null && typeof f === "object" && !Array.isArray(f) &&
    !!(f as TintFormulaPayload).cor_id && !!(f as TintFormulaPayload).cod_produto &&
    !!(f as TintFormulaPayload).id_base && !!(f as TintFormulaPayload).id_embalagem
  );
}

/** Numa lista em created_at DESC, id DESC da chave sem subcoleção, a 1ª linha com a MESMA
 *  COALESCE(subcolecao,'') — é a última dela. Nenhuma na janela → null (caminho normal). */
export function ultimaDaChave(linhasDesc: LinhaStaging[], f: TintFormulaPayload): LinhaStaging | null {
  const sub = f.subcolecao || "";
  return linhasDesc.find((l) => ((l.subcolecao as string | null) ?? "") === sub) ?? null;
}

function projetarItem(i: ItemStaging): string {
  return jsonCanonico({ id_corante: i.id_corante, ordem: i.ordem, qtd_ml: i.qtd_ml });
}

/** A fórmula do payload é idêntica à última staging da chave, em tudo que a promoção usa? */
export function formulaIdentica(
  f: TintFormulaPayload,
  account: string,
  storeCode: string,
  ultima: LinhaStaging,
  itensGravados: ItemStaging[],
  promocaoStatus: unknown,
): boolean {
  if (promocaoStatus !== "promovido") return false;
  if (jsonCanonico(ultima.raw_data) !== jsonCanonico(f)) return false;

  const esperado = montarStagingFormulaRow(f, "", account, storeCode);
  for (const col of COLUNAS_HEADER) {
    if (jsonCanonico(esperado[col]) !== jsonCanonico(ultima[col])) return false;
  }

  const itensEsperados = montarStagingItemRows(f, ultima.id, "").map((r) => projetarItem(r as unknown as ItemStaging));
  const gravados = itensGravados.map(projetarItem);
  if (itensEsperados.length !== gravados.length) return false;
  itensEsperados.sort();
  gravados.sort();
  return itensEsperados.every((x, i) => x === gravados[i]);
}
