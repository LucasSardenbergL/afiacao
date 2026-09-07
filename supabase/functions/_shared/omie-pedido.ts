// Canon Omie pedido → campos locais (sales_orders/order_items). FONTE ÚNICA do mapeamento
// etapa→status, do subtotal-com-desconto e do snapshot items-jsonb, para o sync (omie-vendas-sync)
// e o reprocess (sync-reprocess) NÃO divergirem. Essa divergência foi a causa do #B: o reprocess
// tinha o mapa INVERTIDO (60→cancelado / 50→faturado) e reescrevia o hash_payload de identidade.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/_shared/omie-pedido_test.ts`.
//
// ⚠️ omie-vendas-sync ainda mantém o mapa/subtotal/itemsJson inline (L1166-1193) — unificar num
//    follow-up. Este módulo já é a fonte canônica; o teste trava o canon contra regressão (#B).

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

/** subtotal = Σ qty·preço·(1 − desconto%/100), arredondado a 2 casas. `desconto` é PERCENTUAL.
 *  MESMA semântica do omie-vendas-sync (L1170-1173): `|| ` (qty 0 → 1, igual ao sync) — NÃO `??`.
 *
 *  ⚠️ ITEM SEM PREÇO NÃO ENTRA — e o número não muda por isso (somar `qty·0` e omitir o item dão
 *  a mesma soma). O que muda é que a incompletude deixa de ser invisível: use
 *  `contarItensSemPreco()` junto, ou leia `valor_unitario === null` no items-jsonb.
 *
 *  DECISÃO (2026-09-05), documentada porque a alternativa foi considerada e recusada: o subtotal
 *  NÃO degrada para `null` quando falta preço. `sales_orders.subtotal`/`total` são NOT NULL em
 *  prod, `reconciliar_pedidos_omie` rejeita total nulo, e os KPIs de faturamento somam a coluna —
 *  anular o total de um pedido por causa de UM item trocaria um total encolhido por um buraco no
 *  faturamento, que é pior. O sinal honesto de "este total está incompleto" fica DERIVÁVEL do
 *  items-jsonb (algum item com `valor_unitario: null`), sem coluna nova e sem fabricar número. */
export function subtotalPedidoComDesconto(det: DetInput[]): number {
  let subtotal = 0;
  for (const d of det) {
    const prod = d.produto || {};
    const qty = prod.quantidade || 1;
    const price = precoUnitarioOmie(prod.valor_unitario);
    if (price === null) continue;
    const desc = prod.desconto || 0;
    subtotal += qty * price * (1 - desc / 100);
  }
  return Math.round(subtotal * 100) / 100;
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
 * Mescla o preço GRAVADO por cima de uma reconstrução do items-jsonb, casando por
 * `omie_codigo_produto`. Serve a um caso específico e real: um backfill cujo escopo é
 * acrescentar UM campo (a cor da tinta) reconstrói o array inteiro a partir da leitura atual
 * do Omie e, ao gravar, leva junto o preço daquela leitura. Se o Omie tiver parado de informar
 * `valor_unitario` desde o sync original, o preço bom seria APAGADO por uma leitura pior — uma
 * perda silenciosa, num campo que o backfill nem pretendia tocar.
 *
 * Regra: a leitura NOVA vence quando sabe o preço. Só onde ela não sabe é que o preço gravado
 * é reaproveitado, e apenas se for utilizável — um gravado LIXO não é promovido a verdade.
 *
 * ⚠️ CÓDIGO REPETIDO NÃO É MESCLADO, e essa é a decisão que importa. Com dois itens do mesmo
 * `omie_codigo_produto` não há como saber qual preço pertence a qual linha; aplicar o primeiro
 * aos dois espalharia um preço para uma linha que talvez nunca o teve. Precisão > recall: na
 * ambiguidade o campo fica `null` ("não sei") em vez de receber um palpite. A repetição é rara
 * mas não hipotética — a RPC de reconciliação também recusa SKU duplicado, então não há quem
 * conserte depois. [P1 do challenge Codex]
 *
 * Casa por código com `String(...)` porque o jsonb devolve number e o Omie às vezes manda
 * string. Lê apenas `valor_unitario`: medido em prod (psql-ro, 2026-09-05), os 70.927 itens do
 * items-jsonb têm `valor_unitario` e ZERO têm `unit_price` — o shape é único.
 */
export function mesclarPrecoPreservado<T extends { omie_codigo_produto?: number | string; valor_unitario: number | null }>(
  novos: T[],
  gravados: unknown,
): T[] {
  if (!Array.isArray(gravados)) return novos;
  const porCodigo = new Map<string, number>();
  const ambiguos = new Set<string>();
  for (const g of gravados) {
    if (g === null || typeof g !== "object") continue;
    const linha = g as Record<string, unknown>;
    const cod = linha.omie_codigo_produto;
    if (cod === null || cod === undefined) continue;
    const chave = String(cod);
    if (porCodigo.has(chave) || ambiguos.has(chave)) { ambiguos.add(chave); porCodigo.delete(chave); continue; }
    const preco = precoUnitarioOmie(linha.valor_unitario);
    if (preco !== null) porCodigo.set(chave, preco);
  }
  // Repetição do lado NOVO também é ambígua: um preço gravado único não diz a qual das duas
  // linhas novas ele pertence, e copiá-lo para as duas inventaria receita.
  const vistos = new Set<string>();
  for (const n of novos) {
    const cod = n.omie_codigo_produto;
    if (cod === null || cod === undefined) continue;
    const chave = String(cod);
    if (vistos.has(chave)) ambiguos.add(chave);
    vistos.add(chave);
  }
  if (porCodigo.size === 0) return novos;
  return novos.map((n) => {
    if (n.valor_unitario !== null) return n; // a leitura nova já sabe o preço
    if (n.omie_codigo_produto === null || n.omie_codigo_produto === undefined) return n;
    const chave = String(n.omie_codigo_produto);
    if (ambiguos.has(chave)) return n;      // código repetido: não adivinha
    const gravado = porCodigo.get(chave);
    return gravado === undefined ? n : { ...n, valor_unitario: gravado };
  });
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
