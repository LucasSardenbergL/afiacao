// Canon Omie pedido → campos locais (sales_orders/order_items). FONTE ÚNICA do mapeamento
// etapa→status, do subtotal-com-desconto e do snapshot items-jsonb, para o sync (omie-vendas-sync)
// e o reprocess (sync-reprocess) NÃO divergirem. Essa divergência foi a causa do #B: o reprocess
// tinha o mapa INVERTIDO (60→cancelado / 50→faturado) e reescrevia o hash_payload de identidade.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/_shared/omie-pedido_test.ts`.
//
// ⚠️ omie-vendas-sync ainda mantém o mapa etapa→status e o itemsJson inline — unificar num
//    follow-up. O SUBTOTAL já é unificado (2026-09-10): os três escritores chamam
//    `apurarSubtotalPedido`, e a forma é pinada em src/__tests__/edge-money-path-invariants.test.ts.

import { descontoItemOmie } from "./desconto-omie.ts";

/** Os status cujo dono é o Omie — a lista que o `sync-reprocess` ENVIA à RPC
 *  `reconciliar_pedidos_omie`, que a compara por CONJUNTO com a sua cópia canônica e LANÇA se
 *  divergir. Status app-avançado (`confirmado`, `entregue`, …) fica de fora de propósito: quem
 *  reconcilia por cima dele apaga trabalho humano. Mudar esta lista sem mudar a da migration
 *  `20260830190000_reconciliar_pedidos_omie.sql` PARA a reconciliação (22023) — fail-closed, não
 *  silencioso. */
export const STATUS_GERIDO_OMIE: readonly string[] = [
  "importado",
  "separacao",
  "enviado",
  "faturado",
  "cancelado",
];
const ETAPAS_CONHECIDAS = new Set(["20", "50", "60", "70", "80"]);

/** etapa (cabecalho.etapa do Omie) → status local. Default 'importado' (etapa 10/desconhecida). */
export function omieEtapaToStatus(etapa: string | undefined | null): string {
  const e = etapa || "";
  if (e === "60" || e === "70") return "faturado";
  if (e === "50") return "separacao";
  if (e === "20") return "enviado";
  if (e === "80") return "cancelado";
  return "importado";
}

/** etapa reconhecida? O reprocess só reconcilia status com etapa CONHECIDA — não rebaixa para
 *  'importado' a partir de uma leitura malformada/sem etapa (precisão>recall). */
export function etapaConhecida(etapa: string | undefined | null): boolean {
  return ETAPAS_CONHECIDAS.has(etapa || "");
}

interface DetInput {
  produto?: {
    codigo_produto?: number | string;
    descricao?: string;
    quantidade?: number;
    valor_unitario?: number;
    desconto?: number;
    tipo_desconto?: string;
    percentual_desconto?: number | string;
    valor_desconto?: number | string;
  };
  observacao?: { obs_item?: string };
  inf_adic?: { dados_adicionais_item?: string };
}

/**
 * Preço unitário do item Omie, ou `null` quando NÃO SABIDO. Régua de FINITUDE NÃO-NEGATIVA,
 * espelho exato do `CASE WHEN … >= 0 AND … < 'Infinity'` da RPC `criar_pedidos_com_itens`
 * (migration 20260905225613): a ingestão preserva o fato, não o julga.
 *
 *   ausente / null / ''       → null   ("o Omie não informou")
 *   0                         → 0      ("o Omie informou zero": bonificação/brinde é dado)
 *   negativo / NaN / Infinity  → null   (lixo, não dado)
 *
 * O `|| 0` que estava aqui mapeava "não informou" e "informou 0" no MESMO byte, e o 0 seguia
 * para `order_items.unit_price` (NOT NULL DEFAULT 0 até 2026-09-05), onde entrava na margem do
 * cliente com receita 0 e custo cheio — margem negativa fabricada.
 *
 * ⚠️ NÃO é o `valorMedido` de `_shared/score-ponderado.ts`: aquele aceita qualquer finito,
 * inclusive negativo. Preço negativo do Omie é corrupção, não desconto.
 */
export function precoUnitarioOmie(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Itens cujo preço é NÃO SABIDO — o denominador da confiança no subtotal (ver abaixo). */
export function contarItensSemPreco(det: DetInput[]): number {
  let n = 0;
  for (const d of det) if (precoUnitarioOmie((d.produto || {}).valor_unitario) === null) n += 1;
  return n;
}

export interface SubtotalApurado {
  /** Σ (qty·preço − desconto) arredondado a 2 casas — ou `null` quando o líquido do pedido é
   *  DESCONHECIDO (algum item com preço tem desconto que a régua recusou ler). `null` aqui NÃO é
   *  "total zero": é "esta revisão monetária não se publica" (ver o bloco ⚠️ abaixo). */
  subtotal: number | null;
  /** Quantos itens com preço tiveram o desconto recusado pela régua. `> 0` ⇔ `subtotal === null`. */
  itensDescontoIlegivel: number;
}

/**
 * Subtotal do pedido — a fórmula ÚNICA dos três escritores de `sales_orders.subtotal`/`total`:
 * `omie-vendas-sync` (inserção e reparo de órfão, via `criar_pedidos_com_itens`) e `sync-reprocess`
 * (via `reconciliar_pedidos_omie`). Três cópias da conta foram o que deixou o bug morar aqui.
 *
 *   subtotal = Σ (qty·preço − desconto) sobre os itens que viram linha de `order_items`, com
 *              `qty = quantidade || 1` (quirk legado — é a MESMA quantidade gravada na linha) e o
 *              desconto pela RÉGUA (`descontoItemOmie`, _shared/desconto-omie.ts), em R$ da linha,
 *              sobre a base qty·preço — a mesma chamada que grava `order_items.desconto_valor`.
 *
 * ── O defeito que isto corrige (2026-09-10) ──────────────────────────────────────────────────
 * A fórmula era `qty·preço·(1 − prod.desconto/100)`. `desconto` pelado NÃO existe na API do Omie
 * (`det.produto` expõe `tipo_desconto` "V"/"P", `percentual_desconto`, `valor_desconto`): o campo
 * chegava `undefined`, o `|| 0` zerava o fator e o subtotal saía BRUTO. Medido em prod: 31.315/31.315
 * pais Omie com `total == Σ qty·preço`, e o primeiro pedido com desconto apurado pela régua (oben
 * 12183048572) gravado a 1629,25 quando o líquido é 1489,34. Sem desconto, o número novo é BIT A
 * BIT o antigo (`x − 0 === x·1`) — por isso a reconciliação só reescreve quem de fato tem desconto.
 *
 * ── Universo: os itens que VIRAM LINHA (com `codigo_produto`) ────────────────────────────────
 * O cabeçalho descreve as mesmas linhas que `order_items` guarda — o sync só grava item com
 * `codigo_produto`. Antes o cabeçalho somava todo `det` e o reparo só os com código (duas seleções
 * para a mesma conta). Numericamente inerte no acervo: nos 31.315 pais medidos, `total` já batia
 * com a soma de `order_items`. E o item sem código que tivesse preço nem chega a gravar: o
 * items-jsonb o carrega e as linhas não, e a trigger de coerência do agregado recusa o pedido.
 *
 * ⚠️ ITEM SEM PREÇO NÃO ENTRA — e o número não muda por isso (somar `qty·0` e omitir o item dão
 * a mesma soma). O que muda é que a incompletude deixa de ser invisível: use
 * `contarItensSemPreco()` junto, ou leia `valor_unitario === null` no items-jsonb.
 *
 * ⚠️ ITEM COM DESCONTO ILEGÍVEL DERRUBA O SUBTOTAL INTEIRO PARA `null` — fail-closed por PEDIDO.
 * A régua devolve `null` quando não sabe ler o desconto (discriminador fora do vocabulário, campos
 * contraditórios, percentual > 100, desconto maior que a base). As duas saídas "óbvias" fabricam:
 *   · somar o item pelo BRUTO é o `null → 0` que a régua documenta como o bug renascido no
 *     primeiro consumidor — receita cheia, indistinguível de "o Omie disse que não há desconto";
 *   · deixar SÓ o item de fora publica uma soma PARCIAL com cara de total. Diferente do item sem
 *     preço, aqui o items-jsonb não guarda a evidência (a chave legado `desconto` diz 0), então a
 *     incompletude some da superfície. E no único órfão do acervo (total 0) um item assim faria o
 *     G5 de `criar_pedidos_com_itens` APROVAR um reparo com cabeçalho zero — o valor recusado
 *     viraria "compatível" (achado do challenge Codex, 2026-09-10).
 * Então: líquido desconhecido ⇒ a revisão monetária NÃO se publica. Quem chama pula o pedido
 * (existente fica na revisão anterior; novo não entra) e o REGISTRA — contador e amostra de ids
 * no resultado da execução, que vai para `fin_sync_log`/`sync_reprocess_log`. Medido 2026-09-10:
 * 0 ilegíveis nas 77 linhas apuradas pela régua desde que ela entrou na ingestão.
 *
 * ── Arredondamento: UMA vez, no fim — e a diferença para a soma das linhas é conhecida ────────
 * Arredondar no fim mantém o número bit a bit igual ao legado para pedido sem desconto (o
 * arredondamento por linha mudaria centavos de pedidos com preço de 3 casas e dispararia
 * reescritas que não são correção). O preço de fazer isso: `receitaLiquidaItem` arredonda POR
 * LINHA, então Σ das linhas pode diferir deste subtotal em até ½ centavo por linha quando a base
 * qty·preço tem fração de centavo (ex.: 0,5 × 10,01). Com bases em centavos inteiros — o caso de
 * quantidade inteira e preço de 2 casas — as duas somas coincidem. Provado nos dois sentidos em
 * `omie-pedido_test.ts`.
 *
 * DECISÃO (2026-09-05), documentada porque a alternativa foi considerada e recusada: o subtotal
 * NÃO degrada para `null` quando falta preço. `sales_orders.subtotal`/`total` são NOT NULL em
 * prod, `reconciliar_pedidos_omie` rejeita total nulo, e os KPIs de faturamento somam a coluna —
 * anular o total de um pedido por causa de UM item trocaria um total encolhido por um buraco no
 * faturamento, que é pior. O sinal honesto de "este total está incompleto" fica DERIVÁVEL do
 * items-jsonb (algum item com `valor_unitario: null`), sem coluna nova e sem fabricar número.
 * (O `null` do desconto ilegível NÃO contradiz isto: ele não chega à coluna — é o pedido que não
 * se publica.)
 */
export function apurarSubtotalPedido(det: DetInput[]): SubtotalApurado {
  let subtotal = 0;
  let itensDescontoIlegivel = 0;
  for (const d of det) {
    const prod = d.produto || {};
    if (!prod.codigo_produto) continue;
    const qty = prod.quantidade || 1;
    const price = precoUnitarioOmie(prod.valor_unitario);
    if (price === null) continue;
    const bruto = qty * price;
    const desconto = descontoItemOmie(prod, bruto);
    if (desconto === null) {
      itensDescontoIlegivel += 1;
      continue;
    }
    subtotal += bruto - desconto;
  }
  if (itensDescontoIlegivel > 0) return { subtotal: null, itensDescontoIlegivel };
  return { subtotal: Math.round(subtotal * 100) / 100, itensDescontoIlegivel: 0 };
}

/** Só o número de `apurarSubtotalPedido`. `null` = líquido desconhecido: NÃO publique o pedido. */
export function subtotalPedidoComDesconto(det: DetInput[]): number | null {
  return apurarSubtotalPedido(det).subtotal;
}

/** Cor de tinta a partir da obs do item ("Cor: <label> - <embalagem>"). Espelha o parseCorObs do
 *  omie-vendas-sync verbatim (a cor vai em obs_item na ida; o sync extrai de volta). */
function parseCorObs(obs: string | null | undefined): { tint_nome_cor: string } | null {
  if (!obs) return null;
  const m = /^\s*cor:\s*(.+)$/i.exec(obs);
  if (!m) return null;
  const label = m[1].replace(/\s*-\s*(?:QT|GL|LT|\d+(?:[.,]\d+)?\s*ML)\s*$/i, "").trim();
  if (!label) return null;
  return { tint_nome_cor: label };
}

interface ItemJson {
  omie_codigo_produto: number | string | undefined;
  descricao: string;
  quantidade: number;
  /** `null` = preço NÃO SABIDO. Os leitores do items-jsonb devem mostrar "—", nunca R$ 0,00. */
  valor_unitario: number | null;
  desconto: number;
  tint_nome_cor?: string;
}

/** Reconstrói o snapshot sales_orders.items (jsonb) IGUAL ao omie-vendas-sync (L1178-1185):
 *  mesmas chaves, desconto bruto, cor de tinta da obs. Mantém os MUITOS leitores de items-jsonb
 *  (scoring/cross-sell/bundle/UI/print) consistentes com order_items após o reconcile (achado #B
 *  Codex A2 — o reprocess antigo atualizava order_items mas deixava items-jsonb stale). */
export function construirItemsJson(det: DetInput[]): ItemJson[] {
  const out: ItemJson[] = [];
  for (const d of det) {
    const prod = d.produto || {};
    const cor = parseCorObs(d.observacao?.obs_item ?? d.inf_adic?.dados_adicionais_item);
    out.push({
      omie_codigo_produto: prod.codigo_produto,
      descricao: prod.descricao || "",
      quantidade: prod.quantidade || 1,
      valor_unitario: precoUnitarioOmie(prod.valor_unitario),
      desconto: prod.desconto || 0,
      ...(cor ? { tint_nome_cor: cor.tint_nome_cor } : {}),
    });
  }
  return out;
}

/**
 * Backfill de cor: acrescenta `tint_nome_cor` aos itens JÁ GRAVADOS, sem tocar em mais nada.
 *
 * A direção importa. O backfill nasceu RECONSTRUINDO o items-jsonb inteiro a partir da leitura
 * ATUAL do Omie: o escopo declarado era a cor, mas ele carregava junto produto, quantidade,
 * preço e desconto. Num pedido canônico — que tem linhas em `order_items` e ninguém as reescreve
 * aqui — isso move UM dos dois espelhos do agregado e deixa o outro parado: a mesma classe de
 * defeito do write-back da edição (ver 20260907210000_pedido_edicao_omie_atomica.sql).
 * Havia aqui um `mesclarPrecoPreservado` que preservava o preço gravado — meia solução, porque o
 * resto do item continuava vindo da leitura nova. Esta função tapa a classe inteira invertendo
 * quem manda: a BASE é o que está gravado, e só a cor entra. (Aquele helper saiu junto: sem a
 * reconstrução, ficou sem chamador.)
 *
 * Só casa código 1-1 nos dois lados — código repetido não diz qual cor pertence a qual linha, e
 * adivinhar rotularia o item errado. Item que já tem cor não é tocado. Devolve `null` quando não
 * há nada a fazer (nada gravado, ou nenhuma cor aplicável), para o chamador PULAR o UPDATE em vez
 * de reescrever o jsonb igual — UPDATE que não muda nada ainda assim dispara trigger e updated_at.
 */
export function aplicarCorPreservandoItens(
  gravados: unknown,
  lidos: Array<{ omie_codigo_produto?: number | string | null; tint_nome_cor?: string }>,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(gravados) || gravados.length === 0) return null;

  const corPorCodigo = new Map<string, string>();
  const ambiguos = new Set<string>();
  for (const l of lidos) {
    const cod = l?.omie_codigo_produto;
    if (cod === null || cod === undefined) continue;
    const chave = String(cod);
    if (corPorCodigo.has(chave) || ambiguos.has(chave)) { ambiguos.add(chave); corPorCodigo.delete(chave); continue; }
    if (typeof l.tint_nome_cor === "string" && l.tint_nome_cor.length > 0) corPorCodigo.set(chave, l.tint_nome_cor);
  }

  // Repetição do lado GRAVADO também é ambígua: uma cor só não diz a qual das duas linhas ela
  // pertence, e copiá-la para as duas rotularia um item que pode ser de outra cor.
  const vistos = new Set<string>();
  for (const g of gravados) {
    if (g === null || typeof g !== "object") continue;
    const cod = (g as Record<string, unknown>).omie_codigo_produto;
    if (cod === null || cod === undefined) continue;
    const chave = String(cod);
    if (vistos.has(chave)) ambiguos.add(chave);
    vistos.add(chave);
  }
  if (corPorCodigo.size === 0) return null;

  let mudou = false;
  const saida = gravados.map((g) => {
    if (g === null || typeof g !== "object" || Array.isArray(g)) return g as Record<string, unknown>;
    const linha = g as Record<string, unknown>;
    if (typeof linha.tint_nome_cor === "string" && linha.tint_nome_cor.length > 0) return linha;
    const cod = linha.omie_codigo_produto;
    if (cod === null || cod === undefined) return linha;
    const chave = String(cod);
    if (ambiguos.has(chave)) return linha;
    const cor = corPorCodigo.get(chave);
    if (cor === undefined) return linha;
    mudou = true;
    return { ...linha, tint_nome_cor: cor };
  });

  return mudou ? saida : null;
}

// ── Contrato do payload da RPC `reconciliar_pedidos_omie` (migration 20260830190000) ──────────
//
// O diff de itens NÃO mora mais aqui. Ele foi para dentro da RPC de propósito, e a razão é
// atomicidade, não arrumação: um diff computado no TS nasce de um SELECT que aconteceu FORA da
// transação de escrita. Entre a leitura e a aplicação, um item que nascesse não estaria nem em
// `inserir` nem em `deletar` e SOBREVIVERIA — a revisão aplicada seria "a nova, mais um estranho".
// Atômica e errada. A RPC recebe o conjunto DESEJADO e reconcilia contra o estado que ela mesma
// enxerga sob `FOR UPDATE` do pai, o que também torna a chamada idempotente: rodar duas vezes com
// o mesmo payload converge. Provado em `db/test-reconciliar-pedidos-omie.sh` (56 asserts, PG17).
//
// A identidade do item DENTRO do pedido é o `omie_codigo_produto`, e o `hash_payload` que vai aqui
// é o de IDENTIDADE (`omie_<account>_<pid>_<codigo>`) — NUNCA um hash de conteúdo (foi o #B no
// nível item).

export interface ItemReconciliar {
  omie_codigo_produto: number;
  quantity: number;
  /** `null` = o Omie não informou preço. A RPC grava NULL (ausente ≠ zero) e o diff dela é
   *  NULL-safe desde 20260905225613 — NULL vs NULL não reescreve, NULL vs número reescreve. */
  unit_price: number | null;
  discount: number;
  product_id: string | null;
  hash_payload: string;
  /** IDENTIDADE DE LINHA (`det.ide.codigo_item`), quando o payload a traz. `null` quando não —
   *  e aí a RPC casa por `omie_codigo_produto`, que só é identidade se o SKU não se repetir no
   *  pedido. Ausente ≠ zero: `0` não é um `codigo_item` válido e vira `null` na origem, nunca um
   *  número fabricado que casaria linha errada. */
  omie_codigo_item: number | null;
}

export interface PedidoReconciliar {
  account: string;
  hash_payload: string;
  omie_pedido_id: number;
  /** `omieEtapaToStatus(etapa)` quando a etapa é conhecida; `null` quando não é — e aí a RPC
   *  mantém o status atual (precisão>recall: não rebaixa por leitura malformada). */
  status_omie: string | null;
  total: number;
  items: unknown[];
  itens: ItemReconciliar[];
}
