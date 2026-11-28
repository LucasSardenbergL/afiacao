// Variante e ambiguidade da saída da IA (PR 3.1 do Novo Pedido, "IA honesta"). Puro, sem import
// remoto: roda sob `deno test --no-remote`, o `test:edges` do CI.
//
// Três defeitos que este módulo fecha, todos medidos no código anterior do index.ts:
//
//   1. UMA VARIANTE POR ITEM. O prompt mandava a IA devolver "TODAS as variantes (oben E colacor)"
//      de cada item, e a única deduplicação era por `codigo + quantidade`. O mesmo item nas duas
//      empresas com quantidades diferentes passava duas vezes, e o "adicionar tudo" o duplicava. Aqui
//      o mesmo `codigo` vira UM item. A empresa sai de `escolherContaPorQuantidade` (#4109), não da
//      ordem em que a IA listou.
//   2. AMBÍGUO FICA PARA O VENDEDOR. O resgate de `product_id` inválido usava `.find` — o primeiro
//      candidato que casava pelo prefixo virava o produto, mesmo com outras embalagens na lista e
//      sem conferir a embalagem pedida. Aqui só resgata quando há UM código distinto; com mais de um,
//      os candidatos voltam como sugestão. Embalagem pedida (sufixo) é filtro DURO: um candidato sem
//      ela nunca é resgatado.
//   3. NADA SOME EM SILÊNCIO. O dedup de embalagem removia as outras variantes sem dizer nada, e
//      escolhia a 1ª do grupo quando nenhuma pista do texto desempatava. Aqui só fica com uma quando
//      uma pista EXPLÍCITA a destaca; o resto vira sugestão com o motivo.
//
// Precisão > recall (money-path, princípio 1): melhor o vendedor escolher entre duas latas do que o
// pedido nascer com a embalagem errada.

import { escolherContaPorQuantidade } from "./escolha-conta.ts";

export interface CandidatoCatalogo {
  id: string;
  codigo: string;
  descricao: string;
  account?: string | null;
  estoque?: number | null;
}

/** Item de produto como sai do sanitizador (`sanitizarListaIA`). */
export interface ItemProdutoIA {
  product_id?: string;
  codigo?: string;
  descricao?: string;
  quantity?: number;
  quantidade_inferida?: boolean;
  account?: string;
  notes?: string;
}

/** Sugestão de produto que a edge devolve ao front. */
export interface SugestaoProduto {
  type: "product";
  product_id: string;
  codigo: string;
  descricao: string;
  quantity?: number;
  quantidade_inferida?: boolean;
  account?: string;
  reason: string;
}

/** Teto de candidatos por item ambíguo — a lista é para escolher, não um catálogo. */
export const MAX_CANDIDATOS_AMBIGUOS = 6;

/** Código sem pontuação e sem caixa: "FO5.6717" e "fo56717" são o mesmo código. */
export function normalizarCodigo(codigo: string | null | undefined): string {
  return (codigo ?? "").replace(/[.\-\s]/g, "").toLowerCase();
}

/**
 * Colapsa o par Oben/Colacor do mesmo código num representante só. A conta sai de
 * `escolherContaPorQuantidade` (cobre o pedido > cobre em parte > desconhecido > zero); empate
 * mantém o primeiro. A ordem dos códigos é a da primeira aparição.
 */
export function representantesPorCodigo<T extends CandidatoCatalogo>(
  candidatos: ReadonlyArray<T>,
  quantidade: unknown,
): T[] {
  const porCodigo = new Map<string, T>();
  for (const c of candidatos) {
    const chave = normalizarCodigo(c.codigo) || `id:${c.id}`;
    const atual = porCodigo.get(chave);
    if (!atual) {
      porCodigo.set(chave, c);
      continue;
    }
    if (atual.account !== c.account &&
      escolherContaPorQuantidade(atual.estoque, c.estoque, quantidade) === "outra") {
      porCodigo.set(chave, c);
    }
  }
  return [...porCodigo.values()];
}

export type Resolucao<T> =
  | { tipo: "nenhum" }
  | { tipo: "unico"; produto: T }
  | { tipo: "ambiguo"; candidatos: T[] };

/** Um código distinto resolve; mais de um é ambíguo; zero é nenhum. */
export function resolverCandidatos<T extends CandidatoCatalogo>(
  candidatos: ReadonlyArray<T>,
  quantidade: unknown,
): Resolucao<T> {
  const reps = representantesPorCodigo(candidatos, quantidade);
  if (reps.length === 0) return { tipo: "nenhum" };
  if (reps.length === 1) return { tipo: "unico", produto: reps[0] };
  return { tipo: "ambiguo", candidatos: reps };
}

/**
 * Filtro do resgate. A EMBALAGEM pedida (sufixo LT/QT/BH/GL/L5/BD) é DURA: sem ela o candidato sai,
 * porque resgatar a lata quando pediram o galão é o defeito. O PREFIXO da linha é brando: estreita
 * quando casa algum, e não zera a lista quando não casa nenhum (prefixo lido errado da foto).
 */
export function filtrarParaResgate<T extends CandidatoCatalogo>(
  candidatos: ReadonlyArray<T>,
  prefixo: string | null,
  sufixoEmbalagem: string | null,
): T[] {
  let r = [...candidatos];
  if (sufixoEmbalagem) {
    const s = sufixoEmbalagem.toUpperCase();
    r = r.filter((p) => p.descricao.toUpperCase().includes(s));
  }
  if (prefixo) {
    const pre = prefixo.toUpperCase();
    const comPrefixo = r.filter((p) => p.descricao.toUpperCase().includes(pre));
    if (comPrefixo.length > 0) r = comPrefixo;
  }
  return r;
}

/** As sugestões de um item ambíguo: um candidato por código, com o motivo. */
export function sugestoesDeAmbiguo(
  item: ItemProdutoIA,
  candidatos: ReadonlyArray<CandidatoCatalogo>,
  motivo: string,
): SugestaoProduto[] {
  return candidatos.slice(0, MAX_CANDIDATOS_AMBIGUOS).map((c) => ({
    type: "product" as const,
    product_id: c.id,
    codigo: c.codigo,
    descricao: c.descricao,
    quantity: item.quantity,
    quantidade_inferida: item.quantidade_inferida,
    account: c.account ?? undefined,
    reason: motivo,
  }));
}

export function rotuloItem(item: ItemProdutoIA): string {
  return item.descricao || item.codigo || "item sem descrição";
}

/**
 * Uma linha por código. O mesmo `codigo` repetido com a MESMA quantidade é a variante da outra
 * empresa (ou a IA repetindo): vira um item, na conta que `escolherContaPorQuantidade` escolher.
 * Repetido com quantidades DIFERENTES não dá para decidir qual vale: todas as ocorrências viram
 * sugestão, e o vendedor escolhe. Item sem produto no catálogo passa intacto (outra etapa cuida).
 */
export function colapsarMesmoCodigo<P extends ItemProdutoIA>(
  itens: ReadonlyArray<P>,
  catalogo: ReadonlyMap<string, CandidatoCatalogo>,
): { unicos: P[]; sugestoes: SugestaoProduto[] } {
  const grupos = new Map<string, P[]>();
  const ordem: Array<{ chave: string } | { solto: P }> = [];
  for (const item of itens) {
    const prod = item.product_id ? catalogo.get(item.product_id) : undefined;
    const chave = prod ? normalizarCodigo(prod.codigo) : "";
    if (!prod || !chave) {
      ordem.push({ solto: item });
      continue;
    }
    if (!grupos.has(chave)) {
      grupos.set(chave, []);
      ordem.push({ chave });
    }
    grupos.get(chave)!.push(item);
  }

  const unicos: P[] = [];
  const sugestoes: SugestaoProduto[] = [];
  for (const o of ordem) {
    if ("solto" in o) {
      unicos.push(o.solto);
      continue;
    }
    const grupo = grupos.get(o.chave)!;
    if (grupo.length === 1) {
      unicos.push(grupo[0]);
      continue;
    }
    const quantidades = new Set(grupo.map((g) => g.quantity));
    if (quantidades.size === 1) {
      const candidatos = grupo.map((g) => catalogo.get(g.product_id!)!);
      const [rep] = representantesPorCodigo(candidatos, grupo[0].quantity);
      const escolhido = grupo.find((g) => g.product_id === rep.id) ?? grupo[0];
      // Inferida em QUALQUER ocorrência = inferida: a marca nunca se perde no colapso.
      const inferida = grupo.some((g) => g.quantidade_inferida !== false);
      unicos.push({ ...escolhido, account: rep.account ?? escolhido.account, quantidade_inferida: inferida });
      continue;
    }
    const lista = [...quantidades].map((q) => (q === undefined ? "?" : String(q))).join(", ");
    for (const g of grupo) {
      const prod = catalogo.get(g.product_id!)!;
      sugestoes.push(...sugestoesDeAmbiguo(
        g,
        [prod],
        `O mesmo produto veio com quantidades diferentes (${lista}) — confira qual vale antes de adicionar`,
      ));
    }
  }
  return { unicos, sugestoes };
}

/** Pista de embalagem no texto do pedido — a mesma tabela do prompt (regras 19-25). */
const PISTAS_EMBALAGEM: ReadonlyArray<{ sufixo: string; pistas: RegExp }> = [
  { sufixo: "LT", pistas: /\b18\s?L\b|\bLATAS?\b|\b18 LITROS\b/ },
  { sufixo: "L5", pistas: /\b5\s?L\b|\b5 LITROS\b|\bCINCO LITROS\b/ },
  { sufixo: "QT", pistas: /\b900\s?ML\b|\b810\s?ML\b|\bQUARTINHOS?\b|\b900\b|\b810\b/ },
  { sufixo: "GL", pistas: /\bGAL[AÃ]O\b|\bGAL[OÕ]ES\b|\b3[,.]6\s?L?\b/ },
  { sufixo: "BH", pistas: /\bBALDES?\b|\b20\s?L\b|\b20 LITROS\b/ },
];

/** Sufixo de embalagem que a descrição carrega no fim do código, ou null. */
function sufixoDaDescricao(descricao: string): string | null {
  const m = descricao.toUpperCase().match(/(LT|L5|QT|GL|BH|BD)\b/);
  return m ? m[1] : null;
}

/** Os sufixos que o texto do VENDEDOR pede explicitamente. */
export function embalagensPedidas(texto: string): Set<string> {
  const t = texto.toUpperCase();
  const out = new Set<string>();
  for (const { sufixo, pistas } of PISTAS_EMBALAGEM) if (pistas.test(t)) out.add(sufixo);
  // Regra 24: só o 6269 usa BD para balde/18L.
  if (/6269/.test(t) && (out.has("BH") || out.has("LT"))) out.add("BD");
  return out;
}

/**
 * Embalagens do MESMO produto base (mesmo número de 4+ dígitos, SUFIXOS distintos). Fica com a
 * embalagem que o texto do vendedor pede, quando ele pede exatamente UMA das presentes; caso contrário
 * todas viram sugestão. Mesmo sufixo com códigos distintos não é conflito (linhas diferentes). O texto é só o do VENDEDOR: a `message` da própria IA não é pista (seria a IA
 * confirmando a si mesma).
 */
export function resolverEmbalagens<P extends ItemProdutoIA>(
  itens: ReadonlyArray<P>,
  catalogo: ReadonlyMap<string, CandidatoCatalogo>,
  textoVendedor: string,
): { mantidos: P[]; sugestoes: SugestaoProduto[]; ambiguos: number } {
  const pedidas = embalagensPedidas(textoVendedor);
  const grupos = new Map<string, Array<{ item: P; prod: CandidatoCatalogo; sufixo: string }>>();
  for (const item of itens) {
    const prod = item.product_id ? catalogo.get(item.product_id) : undefined;
    if (!prod) continue;
    const base = prod.descricao.match(/(\d{4,})/)?.[1];
    const sufixo = sufixoDaDescricao(prod.descricao);
    if (!base || !sufixo) continue;
    if (!grupos.has(base)) grupos.set(base, []);
    grupos.get(base)!.push({ item, prod, sufixo });
  }

  const fora = new Set<P>();
  const sugestoes: SugestaoProduto[] = [];
  let ambiguos = 0;
  for (const [base, grupo] of grupos) {
    // Conflito de EMBALAGEM só existe entre sufixos DIFERENTES. O mesmo número com o mesmo sufixo e
    // códigos distintos (FO5.6717.00BH e FO10.6717.00BH) são linhas diferentes, pedidas de propósito:
    // nada a decidir, os dois ficam.
    const sufixos = new Set(grupo.map((g) => g.sufixo));
    if (sufixos.size <= 1) continue;
    const pedidosNoGrupo = [...sufixos].filter((s) => pedidas.has(s));
    const sufixoVencedor = pedidosNoGrupo.length === 1 ? pedidosNoGrupo[0] : null;
    if (!sufixoVencedor) ambiguos += 1;
    const vencedores = grupo.filter((g) => g.sufixo === sufixoVencedor);
    for (const g of grupo) {
      if (g.sufixo === sufixoVencedor) continue;
      fora.add(g.item);
      sugestoes.push(...sugestoesDeAmbiguo(
        g.item,
        [g.prod],
        sufixoVencedor
          ? `Outra embalagem do ${base} — o pedido fala em ${sufixoVencedor}, então entrou ${vencedores.map((v) => v.prod.descricao).join(", ")}`
          : `O ${base} tem mais de uma embalagem e o pedido não diz qual — escolha a certa`,
      ));
    }
  }
  return { mantidos: itens.filter((i) => !fora.has(i)), sugestoes, ambiguos };
}
