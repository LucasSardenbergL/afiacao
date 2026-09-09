// Correspondência entre a linha JÁ GRAVADA em `order_items` e o item que o Omie devolve HOJE —
// a fronteira que decide se um desconto lido agora pode ser atribuído a uma linha antiga.
//
// ── Por que este módulo existe ────────────────────────────────────────────────────────────────
// `_shared/desconto-omie.ts` sabe LER o desconto de um item do Omie. Ele não sabe — e não tem
// como saber — se aquele item é o par da linha que está no banco. O backfill precisa das duas
// coisas, e a segunda é onde mora o dinheiro errado.
//
// ── Por que a chave NÃO é `hash_payload` ──────────────────────────────────────────────────────
// `hash_payload` é `omie_<conta>_<pedido>_<produto>`: ele identifica pedido × SKU, não linha.
// Medido em produção 2026-09-08: 1.200 hashes distintos cobrem 2.640 linhas de `order_items`
// (71.006 no total). Um `UPDATE ... WHERE hash_payload = $1` aplicaria o mesmo desconto às duas
// linhas — com R$ 10 numa e R$ 30 na outra, as duas ficariam com o mesmo número e a soma do
// pedido continuaria parecendo sã. É dinheiro errado sem divergência aparente, que é a pior
// classe. `omie_codigo_item` existe (migration 20260906180000) e SERIA a chave certa, mas está
// preenchido em 1.043 de 71.006 linhas (1,5%) — e em 45 das 2.640 linhas duplicadas. Não serve
// para o acervo, que é justamente o que o backfill precisa alcançar.
//
// ── Por que a chave inclui PREÇO e QUANTIDADE, e não só o SKU ─────────────────────────────────
// Duas razões independentes, e cada uma bastaria:
//
//   1. Desempate. No recorte Oben/TTM (10.647 itens), a ambiguidade cai de 477 itens pela chave
//      de SKU para 51 pela chave do trio — de 4,5% para 0,48%. Medido 2026-09-08.
//   2. Prova de que a base não mudou. O Omie devolve o pedido COMO ESTÁ HOJE. Se ele foi editado
//      desde a ingestão, o desconto atual incide sobre outro preço/quantidade; aplicá-lo à linha
//      gravada produziria uma versão do pedido que nunca existiu em lugar nenhum. Exigir que o
//      trio bata é a precondição que torna a atribuição defensável — e ela é verificada sobre o
//      MESMO detalhe de onde o desconto é lido, nunca sobre uma leitura separada.
//
// Unicidade é exigida DOS DOIS LADOS. Um único item do Omie para duas linhas locais é tão
// indecidível quanto o contrário: escolher qualquer lado seria inventar uma atribuição.
//
// ── O que este módulo NÃO faz ─────────────────────────────────────────────────────────────────
// Não decide o que é desconto — isso é de `descontoItemOmie`, e o `null` dela é transportado com
// motivo próprio, nunca convertido em 0. E não escreve: devolve o plano, e quem escreve aplica
// por chave primária. `0` apurado é DADO ("o Omie informou que não há desconto") e é gravado
// como 0; `null` nunca é gravado — a linha simplesmente segue não apurada.

import { descontoItemOmie, finitoNaoNegativo, type DescontoOmieBruto } from "./desconto-omie.ts";

/** A linha como está em `order_items`. `numeric` do Postgres chega como string no supabase-js —
 *  daí os tipos largos: normalizar é responsabilidade daqui, não de quem lê o banco. */
export interface LinhaLocal {
  /** PK de `order_items` — é por ela que a escrita acontece, nunca pelo hash. */
  id: string;
  omie_codigo_produto: number | string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
}

/** Um elemento de `det` do pedido do Omie: o produto com identidade, base e o trio de desconto. */
export interface ItemOmieDetalhe {
  produto?:
    | (DescontoOmieBruto & {
      codigo_produto?: number | string | null;
      quantidade?: number | string | null;
      valor_unitario?: number | string | null;
    })
    | null;
}

/**
 * Por que uma linha não foi apurada. Cada motivo é uma decisão DIFERENTE, e colapsá-los num
 * contador único esconderia justamente o que distingue "o acervo mudou" de "não sei ler o Omie":
 *
 *   base_indeterminada  a linha local não tem SKU, quantidade ou preço — não há identidade
 *                       econômica para casar. (`unit_price` é nullable desde 2026-09-05.)
 *   sem_correspondencia nenhum item do Omie tem esse trio hoje: o pedido foi editado, o item
 *                       saiu, ou o preço/quantidade mudaram desde a ingestão.
 *   ambiguo             mais de uma linha local ou mais de um item do Omie compartilham o trio.
 *   leitura_recusada    o par foi achado, e `descontoItemOmie` recusou-se a ler o desconto
 *                       (discriminador fora do vocabulário, percentual fora de faixa, desconto
 *                       acima da base). A recusa da régua chega inteira até aqui.
 */
export type MotivoRecusa =
  | "base_indeterminada"
  | "sem_correspondencia"
  | "ambiguo"
  | "leitura_recusada";

export interface LinhaApurada {
  id: string;
  /** R$ absolutos da LINHA inteira. `0` é dado, não ausência. */
  desconto_valor: number;
}

export interface LinhaRecusada {
  id: string;
  motivo: MotivoRecusa;
}

export interface PlanoDesconto {
  apurados: LinhaApurada[];
  recusados: LinhaRecusada[];
}

/** Chave de conteúdo do trio. Arredondar a 6 casas antes de compor a string é o que faz "100" e
 *  100 — e 100.0000001 vindo de dois caminhos numéricos distintos — descreverem a MESMA linha.
 *  Tolerância por comparação não serviria: agrupamento exige relação de equivalência, e
 *  "quase igual" não é transitivo. `null` quando qualquer componente é desconhecido. */
function chaveTrio(
  sku: number | string | null | undefined,
  qtd: number | string | null | undefined,
  preco: number | string | null | undefined,
): string | null {
  const s = finitoNaoNegativo(sku);
  const q = finitoNaoNegativo(qtd);
  const p = finitoNaoNegativo(preco);
  if (s === null || q === null || p === null) return null;
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return `${r(s)}|${r(q)}|${r(p)}`;
}

/** Índice chave → posições. Chave repetida marca a colisão em vez de sobrescrever: perder o
 *  primeiro item silenciosamente é exatamente o modo de falha que a duplicidade produz. */
function indexar<T>(itens: T[], chaveDe: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of itens) {
    const k = chaveDe(it);
    if (k === null) continue;
    const lista = m.get(k);
    if (lista) lista.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/**
 * Casa as linhas locais de UM pedido com os itens que o Omie devolve para ele, e devolve o plano
 * de escrita.
 *
 * Invariante: **toda linha oferecida tem exatamente um desfecho** — ou apurada, ou recusada com
 * motivo, nunca as duas e nunca nenhuma. É o que dá denominador ao resultado: sem isso, "apurei
 * 900" não tem com o que ser comparado, e linha comida em silêncio vira encolhimento invisível.
 *
 * A recusa é por LINHA, não por pedido: um trio duplicado não impede que os outros itens do
 * mesmo pedido sejam apurados. Recall jogado fora sem necessidade também é custo.
 */
export function conciliarDescontosPedido(
  locais: LinhaLocal[],
  itensOmie: ItemOmieDetalhe[],
): PlanoDesconto {
  const apurados: LinhaApurada[] = [];
  const recusados: LinhaRecusada[] = [];

  const porChaveOmie = indexar(
    itensOmie,
    (it) => chaveTrio(it.produto?.codigo_produto, it.produto?.quantidade, it.produto?.valor_unitario),
  );
  const porChaveLocal = indexar(
    locais,
    (l) => chaveTrio(l.omie_codigo_produto, l.quantity, l.unit_price),
  );

  for (const linha of locais) {
    const chave = chaveTrio(linha.omie_codigo_produto, linha.quantity, linha.unit_price);
    if (chave === null) {
      recusados.push({ id: linha.id, motivo: "base_indeterminada" });
      continue;
    }

    const pares = porChaveOmie.get(chave);
    if (!pares || pares.length === 0) {
      recusados.push({ id: linha.id, motivo: "sem_correspondencia" });
      continue;
    }
    // Unicidade dos DOIS lados. `?? 0` aqui seria inofensivo (a chave veio desta mesma linha,
    // então o grupo local existe e tem ao menos um elemento) — está escrito como leitura direta
    // para que uma futura mudança de índice não passe a fabricar "1" por omissão.
    const irmasLocais = porChaveLocal.get(chave) as LinhaLocal[];
    if (pares.length > 1 || irmasLocais.length > 1) {
      recusados.push({ id: linha.id, motivo: "ambiguo" });
      continue;
    }

    const prod = pares[0].produto ?? null;
    // A base é reconstruída do MESMO detalhe que casou — e o casamento já provou que ela é
    // idêntica à da linha local. Usar a base local aqui daria o mesmo número hoje e divergiria
    // no dia em que a chave afrouxar.
    const q = finitoNaoNegativo(prod?.quantidade);
    const p = finitoNaoNegativo(prod?.valor_unitario);
    const base = q === null || p === null ? null : q * p;

    const desconto = descontoItemOmie(prod, base);
    if (desconto === null) {
      recusados.push({ id: linha.id, motivo: "leitura_recusada" });
      continue;
    }
    apurados.push({ id: linha.id, desconto_valor: desconto });
  }

  return { apurados, recusados };
}
