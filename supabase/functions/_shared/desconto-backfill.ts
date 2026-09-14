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
 *
 * Os dois abaixo NÃO nascem da correspondência: são o PORTÃO (`portaoDoPedido`) retirando do plano
 * uma linha que casou e foi apurada, antes de qualquer escrita.
 *
 *   total_nao_confere      o PEDIDO não passou na conferência com o total do próprio Omie
 *                          (`conferirTotalPedido` ≠ confere): duas fontes do Omie discordam sobre o
 *                          mesmo desconto, e escrever a dos itens seria escolher por conveniência.
 *                          Caso-mãe: pedido 7638, itens com R$ 292,26 e total R$ 0,00 (Codex r2, P1).
 *   excluido_pelo_operador a linha está na exclusão explícita da invocação (`excluir_ids`): conflito
 *                          documental fora do alcance da edge — pedidos 12305 e 12787, desconto de
 *                          R$ 0,69 no pedido e nota fiscal emitida no bruto. A exclusão só ESTREITA.
 *   fora_do_plano_aprovado a invocação trouxe o plano aprovado (id → valor em centavos) e a linha, que
 *                          ainda seria escrita, não está nele com o MESMO valor: o Omie mudou entre o
 *                          dry-run e a escrita, ou a página deslocou. É o vínculo PREVENTIVO ao plano
 *                          (Codex r3) — comparar depois da escrita só detectaria o valor já gravado.
 */
export type MotivoRecusa =
  | "base_indeterminada"
  | "sem_correspondencia"
  | "ambiguo"
  | "leitura_recusada"
  | "total_nao_confere"
  | "excluido_pelo_operador"
  | "fora_do_plano_aprovado";

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
 *   confere        a soma dos itens é IGUAL ao total, em centavos inteiros
 *   diverge        os dois existem e não são iguais — inclusive por um centavo
 *   sem_total      o cabeçalho não trouxe `valor_descontos` legível — ausência de dado, não "zero"
 *   item_ilegivel  a régua recusou algum item (null) — a soma seria parcial, e parcial não confere
 *
 * ⚠️ SEM tolerância, e em centavos (v1.5, Codex r2). O 1º desenho aceitava um centavo POR ITEM, e as
 * duas propriedades eram falsas: (a) a folga crescia com o número de itens — 100 itens zerados contra
 * um total de R$ 0,69 davam `confere`, e o desconto inteiro sumia dentro dela; (b) comparar reais em
 * ponto flutuante fazia `|0,03 − 0,04|` valer 0,010000000000000002 e virar `diverge` exatamente no
 * limite. A régua devolve cada desconto já arredondado ao centavo e o Omie informa o total com 2
 * casas: somados em centavos inteiros, os dois lados são comparáveis por igualdade. Uma diferença de
 * arredondamento do percentual deixa de ser absorvida — ela vira recusa (precisão > recall) e
 * aparece medida no detalhe por pedido, em vez de ser escondida pela folga.
 */
export type ConferenciaTotalPedido = "confere" | "diverge" | "sem_total" | "item_ilegivel";

/** R$ → centavos inteiros. `Math.round` e não truncagem: 0,29 × 100 é 28,999999999999996. */
function centavos(n: number): number {
  return Math.round(n * 100);
}

export function conferirTotalPedido(
  itensOmie: ItemOmieDetalhe[],
  valorDescontosOmie: unknown,
): {
  veredito: ConferenciaTotalPedido;
  soma_itens: number | null;
  total_omie: number | null;
  soma_centavos: number | null;
  total_centavos: number | null;
} {
  const total = finitoNaoNegativo(valorDescontosOmie);
  let soma = 0;
  let legivel = true;
  for (const it of itensOmie) {
    const q = finitoNaoNegativo(it.produto?.quantidade);
    const p = finitoNaoNegativo(it.produto?.valor_unitario);
    const d = descontoItemOmie(it.produto, q === null || p === null ? null : q * p);
    if (d === null) { legivel = false; break; }
    soma += centavos(d);
  }
  const somaCentavos = legivel ? soma : null;
  const totalCentavos = total === null ? null : centavos(total);
  const medida = {
    soma_itens: somaCentavos === null ? null : somaCentavos / 100,
    total_omie: totalCentavos === null ? null : totalCentavos / 100,
    soma_centavos: somaCentavos,
    total_centavos: totalCentavos,
  };
  if (totalCentavos === null) return { veredito: "sem_total", ...medida };
  if (somaCentavos === null) return { veredito: "item_ilegivel", ...medida };
  return { veredito: somaCentavos === totalCentavos ? "confere" : "diverge", ...medida };
}

/**
 * O PORTÃO do pedido: decide, ANTES de qualquer escrita, que linhas apuradas podem entrar no plano.
 *
 * Até a v1.4 a conferência com o total era só DIAGNÓSTICO — o pedido 7638 respondia `diverge` e as
 * nove linhas seguiam para a RPC do mesmo jeito (Codex r2 reproduziu: `diverge=1`, HTTP 200, nove
 * aplicadas). Agora um pedido cujo total não confere não tem linha nenhuma no plano, e cada linha
 * retirada vira recusa COM MOTIVO — não um `continue` que sumiria com ela do fechamento por id.
 *
 * Ordem: exclusão do operador → total do pedido → plano aprovado. Uma linha que já tinha sido recusada
 * pela correspondência mantém o motivo dela — é o mais informativo, e o portão só existe para impedir
 * ESCRITA, que aquela linha nunca teria.
 *
 * O plano aprovado (`null` = sem plano, só em dry-run) vale apenas para linha que AINDA SERIA ESCRITA:
 * a que outro writer já preencheu (`jaPreenchidas`) está fora do plano por construção — o dry-run a
 * lista em `ja_apuradas` —, e recusá-la esvaziaria o controle conhecido sem proteger escrita nenhuma.
 * A comparação é em centavos inteiros, a mesma unidade do plano.
 */
export function portaoDoPedido(
  plano: PlanoDesconto,
  veredito: ConferenciaTotalPedido,
  excluir: ReadonlySet<string>,
  planoAprovado: ReadonlyMap<string, number> | null,
  jaPreenchidas: { has(id: string): boolean },
): PlanoDesconto {
  const apurados: LinhaApurada[] = [];
  const recusados: LinhaRecusada[] = [...plano.recusados];
  for (const a of plano.apurados) {
    if (excluir.has(a.id)) {
      recusados.push({ id: a.id, motivo: "excluido_pelo_operador" });
    } else if (veredito !== "confere") {
      recusados.push({ id: a.id, motivo: "total_nao_confere" });
    } else if (planoAprovado !== null && !jaPreenchidas.has(a.id) && planoAprovado.get(a.id) !== centavos(a.desconto_valor)) {
      recusados.push({ id: a.id, motivo: "fora_do_plano_aprovado" });
    } else {
      apurados.push(a);
    }
  }
  return { apurados, recusados };
}

/** Teto de uma exclusão por invocação. Exclusão é para conflito documental conhecido, caso a caso —
 *  uma lista de milhares seria outro processo fingindo ser este. */
const EXCLUIR_IDS_MAX = 1000;
const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Lê `excluir_ids` do corpo da invocação. FAIL-CLOSED: qualquer forma inesperada é ERRO (a edge
 * responde 400), nunca "sem exclusão" — uma lista malformada que virasse conjunto vazio escreveria
 * justamente as linhas que o operador pediu para segurar. Só AUSENTE (a chave não veio) é vazio
 * legítimo: `null` passava como exceção ao contrato "ausente ou array", e a suíte protegia a exceção
 * (Codex r3). Os ids são normalizados para minúsculas, a forma que o PostgREST devolve.
 */
export function lerExcluirIds(raw: unknown): { ok: true; ids: Set<string> } | { ok: false; erro: string } {
  if (raw === undefined) return { ok: true, ids: new Set() };
  if (!Array.isArray(raw)) return { ok: false, erro: `excluir_ids tem de ser um array de uuids (veio ${typeof raw})` };
  if (raw.length > EXCLUIR_IDS_MAX) {
    return { ok: false, erro: `excluir_ids com ${raw.length} ids passa do teto de ${EXCLUIR_IDS_MAX}` };
  }
  const ids = new Set<string>();
  for (const v of raw) {
    const s = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (!FORMA_UUID.test(s)) {
      return { ok: false, erro: `excluir_ids contém um valor que não é uuid: ${String(JSON.stringify(v)).slice(0, 60)}` };
    }
    ids.add(s);
  }
  return { ok: true, ids };
}

/** Teto do plano aprovado por invocação: uma página tem ~200 linhas, e o plano pode trazer as páginas
 *  vizinhas para absorver deslocamento. Acima disso não é o plano de UMA escrita. */
const PLANO_APROVADO_MAX = 2000;

/**
 * Lê `plano_aprovado` — o manifesto [id, valor] que a ESCRITA só pode cumprir, nunca ampliar. Os
 * valores ficam em centavos inteiros, a unidade da conferência. FAIL-CLOSED: ausente é "sem plano";
 * qualquer outra forma é erro — par malformado, id que não é uuid, valor que não é número finito
 * não-negativo, id repetido com valores diferentes, lista acima do teto.
 */
export function lerPlanoAprovado(
  raw: unknown,
): { ok: true; plano: Map<string, number> | null } | { ok: false; erro: string } {
  if (raw === undefined) return { ok: true, plano: null };
  if (!Array.isArray(raw)) {
    return { ok: false, erro: `plano_aprovado tem de ser um array de pares [uuid, valor] (veio ${typeof raw})` };
  }
  if (raw.length > PLANO_APROVADO_MAX) {
    return { ok: false, erro: `plano_aprovado com ${raw.length} linhas passa do teto de ${PLANO_APROVADO_MAX}` };
  }
  const plano = new Map<string, number>();
  for (const par of raw) {
    const id = Array.isArray(par) && typeof par[0] === "string" ? par[0].trim().toLowerCase() : "";
    const valor: number | null = Array.isArray(par) && par.length === 2 && typeof par[1] === "number" &&
        Number.isFinite(par[1]) && par[1] >= 0 ? par[1] : null;
    if (!FORMA_UUID.test(id) || valor === null) {
      return { ok: false, erro: `plano_aprovado contém um par inválido: ${String(JSON.stringify(par)).slice(0, 80)}` };
    }
    const c = centavos(valor);
    const anterior = plano.get(id);
    if (anterior !== undefined && anterior !== c) {
      return { ok: false, erro: `plano_aprovado repete o id ${id} com valores diferentes` };
    }
    plano.set(id, c);
  }
  return { ok: true, plano };
}

export interface ParametrosBackfill {
  account: "oben" | "colacor";
  meses: number;
  pagina: number;
  maxPaginas: number;
  dryRun: boolean;
  excluirIds: Set<string>;
  planoAprovado: Map<string, number> | null;
}

/** Inteiro dentro da faixa quando PRESENTE; AUSENTE devolve o padrão. `"1"` não é 1: a coerção por
 *  `Number()` foi o que fez `max_paginas: "1"` virar 12 páginas em silêncio. Devolve a mensagem de
 *  erro como string. */
function inteiroOpcional(raw: unknown, nome: string, min: number, max: number, padrao: number): number | string {
  if (raw === undefined) return padrao;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return `${nome} tem de ser inteiro entre ${min} e ${max} (veio ${String(JSON.stringify(raw)).slice(0, 40)})`;
  }
  return Number(raw);
}

/**
 * Lê o corpo da invocação INTEIRO, antes de qualquer efeito (Codex r3, P1). Até a v1.5 cada parâmetro
 * tinha um padrão silencioso — e o de `dry_run` era ESCREVER: um JSON quebrado virava `{}`, e `{}`
 * virava escrita sem exclusão e com 12 páginas. Agora:
 *   - o corpo tem de ser um OBJETO;
 *   - `dry_run` é OBRIGATÓRIO e booleano — o modo que escreve só existe por opt-in explícito;
 *   - parâmetro PRESENTE e inválido é erro; só o AUSENTE recebe padrão;
 *   - a ESCRITA exige `plano_aprovado` (o dry-run não precisa, mas aceita — para ensaiar o portão).
 */
export function lerParametrosBackfill(
  corpo: unknown,
  padraoMaxPaginas: number,
): { ok: true; p: ParametrosBackfill } | { ok: false; erro: string } {
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { ok: false, erro: "o corpo tem de ser um objeto JSON com os parâmetros" };
  }
  const c = corpo as Record<string, unknown>;
  if (typeof c.dry_run !== "boolean") {
    return { ok: false, erro: "dry_run é obrigatório e tem de ser true ou false — o modo que escreve não tem padrão" };
  }
  const dryRun = c.dry_run === true;
  if (c.account !== undefined && c.account !== "oben" && c.account !== "colacor") {
    return { ok: false, erro: `account tem de ser "oben" ou "colacor" (veio ${String(JSON.stringify(c.account)).slice(0, 40)})` };
  }
  const meses = inteiroOpcional(c.meses, "meses", 1, 24, 12);
  if (typeof meses === "string") return { ok: false, erro: meses };
  const pagina = inteiroOpcional(c.pagina, "pagina", 1, 10000, 1);
  if (typeof pagina === "string") return { ok: false, erro: pagina };
  const maxPaginas = inteiroOpcional(c.max_paginas, "max_paginas", 1, 100, padraoMaxPaginas);
  if (typeof maxPaginas === "string") return { ok: false, erro: maxPaginas };
  const excl = lerExcluirIds(c.excluir_ids);
  if (!excl.ok) return { ok: false, erro: excl.erro };
  const plano = lerPlanoAprovado(c.plano_aprovado);
  if (!plano.ok) return { ok: false, erro: plano.erro };
  if (dryRun === false && plano.plano === null) {
    return { ok: false, erro: "a escrita exige plano_aprovado — sem ele não há vínculo preventivo entre o dry-run aprovado e o que se grava" };
  }
  return {
    ok: true,
    p: {
      account: c.account === "colacor" ? "colacor" : "oben",
      meses,
      pagina,
      maxPaginas,
      dryRun,
      excluirIds: excl.ids,
      planoAprovado: plano.plano,
    },
  };
}

/**
 * Por que as recusas de UMA chamada de `desconto_backfill_aplicar` não puderam ser repartidas.
 *
 *   ja_apuradas_ausente           o retorno não trouxe o campo (ausente ou null): responde uma RPC
 *                                 de outro contrato.
 *   ja_apuradas_ilegivel          o campo veio e não é inteiro não-negativo. String numérica
 *                                 inclusive — `Number("3")` é a mesma coerção que faz
 *                                 `Number(null) === 0`.
 *   ja_apuradas_excede_recusadas  mais "já apuradas" do que recusas — repartir daria "base mudou"
 *                                 NEGATIVO. É a assinatura da RPC ANTERIOR ao #2475, que contava
 *                                 depois do UPDATE e somava as linhas que a própria chamada
 *                                 escreveu. Na corrigida, só com escritor CONCORRENTE: a
 *                                 reconciliação zera o desconto de uma linha entre a contagem e o
 *                                 UPDATE, e ela é aplicada mesmo assim — {aplicadas: 1, recusadas:
 *                                 0, ja_apuradas: 1} (Codex). ⚠️ E não prova versão: a anterior só se
 *                                 denuncia quando as aplicadas superam as recusas — com poucas, o
 *                                 número inflado cabe em `recusadas` e sai como partição plausível
 *                                 e errada. Qual versão está no ar se prova no banco (md5 do corpo
 *                                 em `pg_proc`), não aqui.
 */
export type CausaNaoClassificada =
  | "ja_apuradas_ausente"
  | "ja_apuradas_ilegivel"
  | "ja_apuradas_excede_recusadas";

/**
 * O desfecho de UMA chamada, em três formas. A do meio NÃO TEM `base_mudou`: a ausência é
 * estrutural, para que nenhum consumidor a leia como zero.
 *
 *   classificado      `recusadas` repartida em base_mudou (= recusadas − ja_apuradas) e ja_apuradas.
 *   nao_classificado  `aplicadas` e `recusadas` legíveis, `ja_apuradas` não — as recusas seguem
 *                     inteiras, com a causa.
 *   ilegivel          sem `aplicadas`/`recusadas` legíveis, ou com soma que não fecha com as linhas
 *                     enviadas: não se sabe o que foi escrito.
 */
type RetornoEscrita =
  | { tipo: "classificado"; aplicadas: number; base_mudou: number; ja_apuradas: number }
  | { tipo: "nao_classificado"; aplicadas: number; recusadas: number; causa: CausaNaoClassificada }
  | { tipo: "ilegivel"; motivo: "nao_e_objeto" | "contagem_ilegivel" | "soma_nao_fecha"; detalhe: string };

/** Uma contagem do retorno: inteiro não-negativo, ou `null`. Sem coerção — ver `CausaNaoClassificada`. */
function contagemDoRetorno(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Para a mensagem de erro: objeto como JSON (não "[object Object]"), primitivo como String (NaN
 *  não vira "null", que é o que JSON.stringify faria). */
function descrever(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/**
 * Lê o retorno de `desconto_backfill_aplicar` — `{pedidas, aplicadas, recusadas, ja_apuradas}` —
 * de uma chamada que enviou `enviadas` linhas.
 *
 * `recusadas` junta dois fatos com consertos OPOSTOS: a linha cuja base (trio) mudou desde a leitura
 * que montou o plano — reler o Omie — e a linha que JÁ tinha desconto quando a escrita chegou,
 * porque outro writer ou um run anterior ganhou a corrida — nada a fazer. Somar os dois em "base
 * mudou" mente sempre que há corrida perdida.
 *
 * ⚠️ A partição é EXATA só sem escritor concorrente durante a chamada: a RPC conta `ja_apuradas` num
 * statement e escreve em outro, e em READ COMMITTED o mundo muda entre os dois. Com concorrente, os
 * contadores trocam de fato nos DOIS sentidos (Codex):
 *   - linha NULL na contagem que outro writer preenche antes do UPDATE — inclusive enquanto o UPDATE
 *     espera o lock da linha, porque a condição é reavaliada no fim da espera — sai como
 *     `base_mudou`, sendo corrida perdida (a janela NÃO é de microssegundos);
 *   - linha contada como já apurada cujo desconto a reconciliação invalida (o preço mudou e o
 *     desconto voltou a NULL) sai como `ja_apuradas`, e precisa de reapuração;
 *   - linha que SUMIU antes da contagem (o JOIN não a acha) também sai como `base_mudou`.
 * Fechar isso exigiria a RPC devolver o motivo por linha, decidido no próprio UPDATE — fora desta
 * leitura, e a RPC não muda nesta entrega.
 *
 * `enviadas` é o que a edge SABE que mandou, sem depender do que a RPC diz. Soma que não fecha com
 * ela é outro contrato respondendo, e repartir recusas sobre ela classificaria um número que não
 * descreve a chamada.
 */
export function lerRetornoEscrita(retorno: unknown, enviadas: number): RetornoEscrita {
  if (typeof retorno !== "object" || retorno === null || Array.isArray(retorno)) {
    return { tipo: "ilegivel", motivo: "nao_e_objeto", detalhe: descrever(retorno) };
  }
  const r = retorno as Record<string, unknown>;
  const aplicadas = contagemDoRetorno(r.aplicadas);
  const recusadas = contagemDoRetorno(r.recusadas);
  if (aplicadas === null || recusadas === null) {
    return {
      tipo: "ilegivel",
      motivo: "contagem_ilegivel",
      detalhe: `aplicadas=${descrever(r.aplicadas)} recusadas=${descrever(r.recusadas)}`,
    };
  }
  if (aplicadas + recusadas !== enviadas) {
    return {
      tipo: "ilegivel",
      motivo: "soma_nao_fecha",
      detalhe: `aplicadas ${aplicadas} + recusadas ${recusadas} ≠ ${enviadas} linhas enviadas`,
    };
  }

  const ja = contagemDoRetorno(r.ja_apuradas);
  if (ja === null) {
    const ausente = r.ja_apuradas === null || r.ja_apuradas === undefined;
    return {
      tipo: "nao_classificado",
      aplicadas,
      recusadas,
      causa: ausente ? "ja_apuradas_ausente" : "ja_apuradas_ilegivel",
    };
  }
  if (ja > recusadas) {
    return { tipo: "nao_classificado", aplicadas, recusadas, causa: "ja_apuradas_excede_recusadas" };
  }
  return { tipo: "classificado", aplicadas, base_mudou: recusadas - ja, ja_apuradas: ja };
}

/** Os contadores de escrita que o retorno da RPC alimenta — o recorte da `contagem` da edge. */
export interface ContadoresEscrita {
  escrita_aplicada: number;
  escrita_recusada_base_mudou: number;
  escrita_recusada_ja_apurada: number;
  escrita_recusada_nao_classificada: number;
}

/**
 * Soma o retorno de UMA chamada nos contadores. Mora aqui, e não na edge, para que a soma tenha
 * suíte: o defeito que ela conserta era justamente o rótulo da soma, e com ela dentro da edge
 * `+= r.base_mudou + r.ja_apuradas` voltava sem nenhum teste ficar vermelho (Codex).
 *
 * Retorno `ilegivel` LANÇA antes de tocar em qualquer contador: sem `aplicadas`/`recusadas`
 * legíveis não se sabe o que foi escrito, e "0 aplicadas" seria a mentira. O resultado é
 * DESCONHECIDO — a escrita pode ter comitado. Na RPC conhecida, repetir a execução é seguro: o guard
 * `desconto_valor IS NULL` recusa o que já foi gravado. (Página segura de retomada na resposta 500 é
 * melhoria registrada, não feita: com a RPC verificada em prod este ramo não dispara.)
 */
export function somarRetornoEscrita(
  contadores: ContadoresEscrita,
  causas: Record<CausaNaoClassificada, number>,
  retorno: unknown,
  enviadas: number,
): void {
  const r = lerRetornoEscrita(retorno, enviadas);
  if (r.tipo === "ilegivel") {
    const aviso = "resultado da escrita DESCONHECIDO: ela pode ter comitado";
    throw new Error(`retorno ilegível de desconto_backfill_aplicar (${r.motivo}): ${r.detalhe} — ${aviso}`);
  }
  contadores.escrita_aplicada += r.aplicadas;
  if (r.tipo === "classificado") {
    contadores.escrita_recusada_base_mudou += r.base_mudou;
    contadores.escrita_recusada_ja_apurada += r.ja_apuradas;
  } else {
    contadores.escrita_recusada_nao_classificada += r.recusadas;
    causas[r.causa]++;
  }
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
