/**
 * Motor de matching base-tintométrica ↔ produto Omie (puro, testável).
 *
 * O código da base (ex. WJOB.7796) vem no INÍCIO da `tint_bases.descricao` e
 * COLADO — ou separado por espaço — no FIM da `descricao` do produto Omie,
 * seguido da embalagem (GL/QT/BH/405ML…). ⚠️ WJOB.7796 (branca) ≠ WJOI.7796
 * (intermediária): mesmo número, bases DIFERENTES → casar o código INTEIRO.
 *
 * ⚠️ money-path (sugestão errada que o humano aprova = produto errado no pedido).
 * Regras (Codex 2026-06-14, ver spec):
 *  - confiança ('forte'/'revisar') vem da CARDINALIDADE de uma chave dura EXATA
 *    (código-base + embalagem), NUNCA do score. O score só ORDENA o combobox.
 *  - parsing exato: WJOB ≠ WJOI, JO10 ≠ JO5, .7644 ≠ .7644.00 (não remover .00);
 *    1 código por lado, ancorado (início na base, fim na Omie); anti-substring.
 *  - embalagem: igualdade textual EXATA, SEM alias implícito (QT ≠ 810ML).
 *  - unicidade GLOBAL no universo elegível; candidato já mapeado a outra base → revisar.
 *
 * Spec: docs/superpowers/specs/2026-06-14-tint-mapeamento-assistido-design.md
 */

export interface LinhaSku {
  baseDescricao: string;
  embalagemDescricao: string;
  /** opcional — só entra no desempate por palavras (nunca na confiança). */
  produtoDescricao?: string;
}

export interface ProdutoOmieMatch {
  id: string;
  codigo: string;
  descricao: string;
}

export type Sugestao =
  | { tipo: 'forte'; produtoId: string }
  | { tipo: 'revisar'; candidatos: string[] } // ids ranqueados (código bate)
  | { tipo: 'sem_sugestao' };

// PREFIXO(2-4 letras + 0-2 díg) "." NUM1(3-4 díg) ["." NUM2(2-4 díg)]? — SEM
// sufixo de embalagem. O lookahead (?![\d.]) impede capturar "WJOB.7796" de
// "WJOB.77960" (dígito a mais) ou de uma 3ª parte numérica inesperada.
const CODIGO = String.raw`[A-Z]{2,4}\d{0,2}\.\d{3,4}(?:\.\d{2,4})?`;
const RE_BASE_INICIO = new RegExp(`^(${CODIGO})(?![\\d.])`);
const RE_OMIE_FIM = new RegExp(`(?:^|\\s)(${CODIGO})(?![\\d.])\\s*([A-Z0-9]*)\\s*$`);
const RE_PALAVRA = /[A-Z0-9]+/g;

function norm(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').trim().toUpperCase();
}

/** Código-base no INÍCIO da descrição da base (ex.: "WJOB.7796 - …" → "WJOB.7796"). */
export function extrairCodigoBaseInicio(s: string | null | undefined): string | null {
  return norm(s).match(RE_BASE_INICIO)?.[1] ?? null;
}

/** Código-base + embalagem no FIM da descrição Omie ("… WJOB.7796GL" → {WJOB.7796, GL}). */
export function parseDescricaoOmie(
  s: string | null | undefined,
): { codigoBase: string; embalagem: string } | null {
  const m = norm(s).match(RE_OMIE_FIM);
  if (!m) return null;
  return { codigoBase: m[1] ?? '', embalagem: m[2] ?? '' };
}

/** Chave dura: código-base e embalagem batem EXATO (sem alias/inferência). */
export function casarLinhaProduto(
  linha: LinhaSku,
  produto: ProdutoOmieMatch,
): { codigoBateu: boolean; embalagemBateu: boolean } {
  const codBase = extrairCodigoBaseInicio(linha.baseDescricao);
  const omie = parseDescricaoOmie(produto.descricao);
  if (!codBase || !omie) return { codigoBateu: false, embalagemBateu: false };
  const embLinha = norm(linha.embalagemDescricao);
  const embOmie = norm(omie.embalagem);
  return {
    codigoBateu: codBase === omie.codigoBase,
    embalagemBateu: embLinha !== '' && embOmie !== '' && embLinha === embOmie,
  };
}

/** Palavras descritivas (sem o código) — só pra desempate visual. */
function palavrasDescritivas(s: string): Set<string> {
  const semCodigo = norm(s).replace(new RegExp(CODIGO, 'g'), ' ');
  return new Set(semCodigo.match(RE_PALAVRA) ?? []);
}

/** Score de RELEVÂNCIA — usado SÓ pra ordenar o combobox, nunca pra confiança. */
export function scoreProduto(linha: LinhaSku, produto: ProdutoOmieMatch): number {
  const { codigoBateu, embalagemBateu } = casarLinhaProduto(linha, produto);
  let score = (codigoBateu ? 100 : 0) + (embalagemBateu ? 50 : 0);
  const pl = palavrasDescritivas(`${linha.produtoDescricao ?? ''} ${linha.baseDescricao}`);
  for (const w of palavrasDescritivas(produto.descricao)) if (pl.has(w)) score += 1;
  return score;
}

/**
 * Lista ranqueada pro combobox (código+embalagem no topo, depois só-código, depois
 * resto). Genérico em T pra preservar campos extras do produto (custo/estoque).
 */
export function ranquearProdutos<T extends ProdutoOmieMatch>(
  linha: LinhaSku,
  produtos: T[],
): Array<T & { score: number; codigoBateu: boolean; embalagemBateu: boolean }> {
  return produtos
    .map((p) => {
      const { codigoBateu, embalagemBateu } = casarLinhaProduto(linha, p);
      return { ...p, codigoBateu, embalagemBateu, score: scoreProduto(linha, p) };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Sugestão de mapeamento pra UMA base. `produtos` deve ser o universo ELEGÍVEL
 * COMPLETO (todas as bases ativas) — a unicidade é global. `idsJaMapeados` =
 * produtos Omie já vinculados a OUTRAS bases (não roubar/duplicar vínculo).
 *
 * forte ⟺ existe EXATAMENTE 1 produto com chave dura (código+embalagem) exata,
 * ainda livre. count 0 ou >1 → revisar. Sem código batendo → sem_sugestao.
 */
export function sugerirMapeamento(
  linha: LinhaSku,
  produtos: ProdutoOmieMatch[],
  idsJaMapeados: Set<string>,
): Sugestao {
  const casados = produtos.map((p) => ({ p, ...casarLinhaProduto(linha, p) }));
  const comCodigo = casados.filter((c) => c.codigoBateu);
  if (comCodigo.length === 0) return { tipo: 'sem_sugestao' };

  const fortes = comCodigo.filter((c) => c.embalagemBateu && !idsJaMapeados.has(c.p.id));
  if (fortes.length === 1) return { tipo: 'forte', produtoId: fortes[0].p.id };

  const candidatos = ranquearProdutos(
    linha,
    comCodigo.map((c) => c.p),
  ).map((p) => p.id);
  return { tipo: 'revisar', candidatos };
}
