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

/**
 * Como os campos de desconto vieram no item do Omie que casou — o SENSOR do backfill.
 *
 * A classificação olha os campos NUMÉRICOS (`valor_desconto`, `percentual_desconto`); o tipo
 * sozinho não informa valor nenhum e vai à parte, em `tipo`.
 *
 *   ausentes    nenhum campo numérico veio (undefined, null ou string vazia) — com ou sem tipo. A
 *               régua devolve 0 ("o Omie não informou desconto"), e esse 0 é IDÊNTICO, no número,
 *               ao zero que o Omie informou. É o caso que uma cobertura de 100% esconde: o casamento
 *               pelo trio (SKU, qtd, preço) não depende dos campos de desconto, então uma resposta
 *               que não os trouxesse apuraria 100% das linhas como 0 — o acervo inteiro carimbado
 *               "sem desconto", com cara de sucesso. ⚠️ Se o Omie OMITE os campos quando não há
 *               desconto, `ausentes` é o caso normal das linhas sem desconto: sozinho ele não
 *               reprova — quem separa "omite zeros" de "a resposta não traz os campos" é a
 *               coexistência de positivas `informados` na mesma resposta e a conferência com o total
 *               do pedido (`conferirTotalPedido`).
 *   zerados     ao menos um campo numérico veio como 0 VÁLIDO e nenhum veio > 0. Este é o 0 que é
 *               DADO. (Um tipo sem número NÃO é zero informado — é `ausentes`: foi o furo do 1º
 *               desenho, apontado pelo Codex, em que `{tipo_desconto: "X"}` virava "zerados".)
 *   informados  ao menos um campo numérico veio > 0. Descreve o CONTEÚDO dos campos, não o desconto
 *               final: 0,001 arredonda a 0, e percentual sobre base zero dá 0 — por isso
 *               `zero_por_campos.informados` existe e tem de ser explicável.
 *   invalidos   um campo numérico veio preenchido e não é número finito não-negativo (lixo,
 *               negativo, NaN), ou o tipo veio preenchido e não é string. A régua trata o campo
 *               como AUSENTE e segue; o sensor não esconde que ele veio.
 *
 * O sensor NÃO muda nenhuma decisão: o valor apurado continua sendo o de `descontoItemOmie`. Ele
 * só torna legível DE ONDE o número saiu, para que um acervo de zeros possa ser auditado.
 */
type CamposDesconto = "ausentes" | "zerados" | "informados" | "invalidos";

interface OrigemDesconto {
  campos: CamposDesconto;
  /** `tipo_desconto` como a régua o lê (trim + maiúscula); "" quando não veio como string. */
  tipo: string;
  valor_desconto: number | null;
  percentual_desconto: number | null;
  /** A base do item do OMIE que casou — a que a régua usou. Não a local: o casamento quantiza a
   *  6 casas, e uma linha local de qtd 1,0000001 casa com o item de qtd 1; contar a local como
   *  "qtd > 1" fabricaria a evidência que o controle positivo exige. */
  quantidade: number | null;
  valor_unitario: number | null;
}

interface LinhaApurada {
  id: string;
  /** R$ absolutos da LINHA inteira. `0` é dado, não ausência. */
  desconto_valor: number;
  /** De onde o número saiu — ver `CamposDesconto`. */
  origem: OrigemDesconto;
}

interface LinhaRecusada {
  id: string;
  motivo: MotivoRecusa;
}

/** O plano de escrita. `LinhaApurada`/`LinhaRecusada` não são exportadas: elas existem para
 *  compor este tipo, e exportá-las sem consumidor seria superfície morta. */
export interface PlanoDesconto {
  apurados: LinhaApurada[];
  recusados: LinhaRecusada[];
}

/** Quantiza a 6 casas: é o que faz dois caminhos numéricos distintos descreverem a MESMA linha.
 *  `numeric` do Postgres chega como string e volta a float, e 100.0000001 e 100 são a mesma linha
 *  — precisam produzir a mesma chave. Tolerância por comparação não serviria no lugar disto:
 *  agrupamento exige relação de equivalência, e "quase igual" não é transitivo. */
function quantizar(n: number): number {
  return Math.round(n * 1e6) / 1e6;
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
  if (s === null) return null;
  if (q === null) return null;
  if (p === null) return null;
  return `${quantizar(s)}|${quantizar(q)}|${quantizar(p)}`;
}

/** O campo veio preenchido? String em branco conta como NÃO preenchida — é como o Omie costuma
 *  mandar "sem valor", e contá-la como presente esconderia exatamente o caso `ausentes`. */
function preenchido(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "string") return raw.trim() !== "";
  return true;
}

/** Classifica os campos de desconto do item do Omie. Ver `CamposDesconto`. */
function origemDesconto(prod: ItemOmieDetalhe["produto"]): OrigemDesconto {
  const p = prod || {};
  const tipo = typeof p.tipo_desconto === "string" ? p.tipo_desconto.trim().toUpperCase() : "";
  const valor = finitoNaoNegativo(p.valor_desconto);
  const perc = finitoNaoNegativo(p.percentual_desconto);
  const valorVeio = preenchido(p.valor_desconto);
  const percVeio = preenchido(p.percentual_desconto);
  const tipoIlegivel = preenchido(p.tipo_desconto) && typeof p.tipo_desconto !== "string";

  let campos: CamposDesconto;
  if ((valorVeio && valor === null) || (percVeio && perc === null) || tipoIlegivel) {
    campos = "invalidos";
  } else if (!valorVeio && !percVeio) {
    campos = "ausentes";
  } else if ((valor !== null && valor > 0) || (perc !== null && perc > 0)) {
    campos = "informados";
  } else {
    campos = "zerados";
  }
  return {
    campos,
    tipo,
    valor_desconto: valor,
    percentual_desconto: perc,
    quantidade: finitoNaoNegativo(p.quantidade),
    valor_unitario: finitoNaoNegativo(p.valor_unitario),
  };
}

/**
 * Amostra com UM representante garantido por combinação. As combinações de uma positiva são 6
 * (tipo V/P/vazio × qtd > 1 sim/não) e cabem no teto; quando uma combinação NOVA chega com a
 * amostra cheia, ela toma o lugar de uma entrada cuja combinação já tem outro representante.
 * Sem isso, seis positivas "V/qtd 2" seguidas deixavam a "P/qtd 2" — justamente a que decide a
 * semântica do percentual — fora do que se confere à mão (sequência reproduzida pelo Codex).
 */
export function registrarNaAmostra<T extends { combinacao: string }>(amostra: T[], item: T, teto: number): void {
  const representantes = (c: string) => amostra.filter((x) => x.combinacao === c).length;
  if (amostra.length < teto) { amostra.push(item); return; }
  if (representantes(item.combinacao) > 0) return;
  for (let i = amostra.length - 1; i >= 0; i--) {
    if (representantes(amostra[i].combinacao) > 1) { amostra[i] = item; return; }
  }
}

/**
 * O pedido local está DENTRO da janela do alvo? A contagem do denominador sempre filtrou por
 * `order_date_kpi >= de`, mas a seleção dos candidatos vinha só dos pedidos que o Omie devolve —
 * e o filtro do `ListarPedidos` é por inclusão OU ALTERAÇÃO. Um pedido de 2024 alterado ontem
 * oferecia filhos NULL e entrava no plano: escrita fora do alvo autorizado (achado do Codex).
 *
 * Comparação de `YYYY-MM-DD` como texto é cronológica. Data ausente ou fora do formato → FORA:
 * sem data não há como afirmar que o pedido está no escopo, e a contagem do denominador também o
 * exclui (o `gte` do PostgREST não casa NULL) — as duas pontas medem o mesmo universo.
 */
export function pedidoNaJanela(orderDateKpi: unknown, deIso: string): boolean {
  if (typeof orderDateKpi !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDateKpi)) return false;
  return orderDateKpi >= deIso;
}

/**
 * Conferência do pedido contra o total que o PRÓPRIO Omie calcula (`total_pedido.valor_descontos`).
 *
 * É a testemunha por valor que não passa pela correspondência com o banco: soma o desconto que a
 * régua lê em CADA item do `det` e compara com o total do cabeçalho. Um pedido com desconto no
 * total e zero nos itens é o formato exato do furo que `ausentes` sozinho não denuncia (a régua
 * leria 0 onde o Omie diz que há desconto).
 *
 *   confere        a soma dos itens bate com o total (tolerância de UM centavo por item: a régua
 *                  arredonda cada item ao centavo, e o Omie pode arredondar o percentual de outro
 *                  jeito — diferença de arredondamento não é desconto perdido)
 *   diverge        os dois existem e não batem
 *   sem_total      o cabeçalho não trouxe `valor_descontos` legível — ausência de dado, não "zero"
 *   item_ilegivel  a régua recusou algum item (null) — a soma seria parcial, e parcial não confere
 */
export type ConferenciaTotalPedido = "confere" | "diverge" | "sem_total" | "item_ilegivel";

export function conferirTotalPedido(
  itensOmie: ItemOmieDetalhe[],
  valorDescontosOmie: unknown,
): { veredito: ConferenciaTotalPedido; soma_itens: number | null; total_omie: number | null } {
  const total = finitoNaoNegativo(valorDescontosOmie);
  let soma = 0;
  let legivel = true;
  for (const it of itensOmie) {
    const q = finitoNaoNegativo(it.produto?.quantidade);
    const p = finitoNaoNegativo(it.produto?.valor_unitario);
    const d = descontoItemOmie(it.produto, q === null || p === null ? null : q * p);
    if (d === null) { legivel = false; break; }
    soma += d;
  }
  const somaItens = legivel ? Math.round(soma * 100) / 100 : null;
  if (total === null) return { veredito: "sem_total", soma_itens: somaItens, total_omie: null };
  if (somaItens === null) return { veredito: "item_ilegivel", soma_itens: null, total_omie: total };
  const tolerancia = 0.01 * Math.max(1, itensOmie.length);
  return {
    veredito: Math.abs(somaItens - total) <= tolerancia ? "confere" : "diverge",
    soma_itens: somaItens,
    total_omie: total,
  };
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
    apurados.push({ id: linha.id, desconto_valor: desconto, origem: origemDesconto(prod) });
  }

  return { apurados, recusados };
}
