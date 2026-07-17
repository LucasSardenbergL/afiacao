import { describe, it, expect } from 'vitest';
import {
  skuItemsBackoffMs,
  skuItemsElegivel,
  skuItemsCompararFila,
  skuItemsDedupPorRecebimento,
  agregarItensRecebimento,
  type SkuItemsFilaControle,
  type ItemRecebimentoResolvido,
} from '../sku-items-fila-helpers';

const H = 3_600_000;
const AGORA = Date.parse('2026-07-14T21:00:00Z');
const isoHorasAtras = (h: number) => new Date(AGORA - h * H).toISOString();

describe('skuItemsBackoffMs — escada 6h/24h/72h', () => {
  it('virgem (0 ou negativo) não espera', () => {
    expect(skuItemsBackoffMs(0)).toBe(0);
    expect(skuItemsBackoffMs(-1)).toBe(0);
  });

  it('1ª falha re-tenta em 6h, 2ª em 24h, 3ª+ em 72h (cap)', () => {
    expect(skuItemsBackoffMs(1)).toBe(6 * H);
    expect(skuItemsBackoffMs(2)).toBe(24 * H);
    expect(skuItemsBackoffMs(3)).toBe(72 * H);
    expect(skuItemsBackoffMs(15)).toBe(72 * H);
  });
});

describe('skuItemsElegivel — quem entra na fila do run', () => {
  const c = (tentativas: number, ultimaHorasAtras: number | null): SkuItemsFilaControle => ({
    tentativas,
    ultima_tentativa: ultimaHorasAtras === null ? null : isoHorasAtras(ultimaHorasAtras),
  });

  it('sem controle (NFe virgem) → sempre elegível', () => {
    expect(skuItemsElegivel(undefined, AGORA)).toBe(true);
  });

  it('controle degradado (tentativas 0 / sem timestamp / timestamp ilegível) → elegível (fail-open)', () => {
    expect(skuItemsElegivel(c(0, 5), AGORA)).toBe(true);
    expect(skuItemsElegivel(c(2, null), AGORA)).toBe(true);
    expect(skuItemsElegivel({ tentativas: 2, ultima_tentativa: 'not-a-date' }, AGORA)).toBe(true);
  });

  it('1 tentativa: bloqueada até 6h, liberada depois', () => {
    expect(skuItemsElegivel(c(1, 5), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(1, 6), AGORA)).toBe(true);
  });

  it('2 tentativas: bloqueada até 24h, liberada depois', () => {
    expect(skuItemsElegivel(c(2, 23), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(2, 25), AGORA)).toBe(true);
  });

  it('3+ tentativas (poison): bloqueada até 72h, liberada depois — nunca abandonada', () => {
    expect(skuItemsElegivel(c(3, 71), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(3, 73), AGORA)).toBe(true);
    expect(skuItemsElegivel(c(9, 71), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(9, 73), AGORA)).toBe(true);
  });
});

describe('skuItemsCompararFila — nunca-tentadas primeiro, poison pro fim', () => {
  it('menos tentativas vence, mesmo com faturamento mais recente do outro lado', () => {
    const virgemAntiga = { tentativas: 0, t2: '2026-06-15T00:00:00+00:00' };
    const poisonRecente = { tentativas: 5, t2: '2026-07-14T00:00:00+00:00' };
    expect(skuItemsCompararFila(virgemAntiga, poisonRecente)).toBeLessThan(0);
    expect(skuItemsCompararFila(poisonRecente, virgemAntiga)).toBeGreaterThan(0);
  });

  it('empate em tentativas → earliest-deadline-first (a mais ANTIGA vai primeiro)', () => {
    // A antiga é a de menor folga: está prestes a sair da janela de `dias` e some
    // sem virar leadtime. A recente volta na próxima janela.
    const recente = { tentativas: 0, t2: '2026-07-14T00:00:00+00:00' };
    const antiga = { tentativas: 0, t2: '2026-07-01T00:00:00+00:00' };
    expect(skuItemsCompararFila(antiga, recente)).toBeLessThan(0);
    expect(skuItemsCompararFila(recente, antiga)).toBeGreaterThan(0);
    expect(skuItemsCompararFila(antiga, antiga)).toBe(0);
  });

  it('forma do incidente: poison sai da frente e a prestes-a-expirar vai primeiro', () => {
    // Poison = NFe já consultada várias vezes que sempre responde 0 itens; ela era
    // re-consultada em todo run e comia o guard, deixando as órfãs virgens antigas
    // inalcançáveis. Com a fila nova: virgens antes do poison e, entre elas, a mais
    // antiga (a primeira a expirar da janela) lidera.
    const fila = [
      { id: 'poison', tentativas: 5, t2: '2026-07-14T00:00:00+00:00' },
      { id: 'virgem-antiga', tentativas: 0, t2: '2026-06-15T00:00:00+00:00' },
      { id: 'virgem-recente', tentativas: 0, t2: '2026-07-10T00:00:00+00:00' },
      { id: 'tentada-1x', tentativas: 1, t2: '2026-07-08T00:00:00+00:00' },
    ].sort(skuItemsCompararFila);
    expect(fila.map((f) => f.id)).toEqual([
      'virgem-antiga',
      'virgem-recente',
      'tentada-1x',
      'poison',
    ]);
  });
});

describe('skuItemsDedupPorRecebimento', () => {
  it('N linhas com o MESMO nIdReceb viram 1 (a NFe que fatura N pedidos)', () => {
    // A forma do passivo medido em prod: 1 NFe fatura N pedidos → N linhas em
    // purchase_orders_tracking com a mesma chave, e o backfill do sync de NFes grava o
    // MESMO recebimento no raw_data de todas. Sem dedup, cada uma consultava o mesmo
    // recebimento e regravava os mesmos itens sob o seu tracking_id: peso N×.
    const out = skuItemsDedupPorRecebimento([
      { id: 'pedido-a', nIdReceb: '555' },
      { id: 'pedido-b', nIdReceb: '555' },
      { id: 'pedido-c', nIdReceb: '555' },
    ]);
    expect(out.map((o) => o.id)).toEqual(['pedido-a']);
  });

  it('recebimentos DISTINTOS passam todos (não colapsa o legítimo)', () => {
    const out = skuItemsDedupPorRecebimento([
      { id: 'a', nIdReceb: '1' },
      { id: 'b', nIdReceb: '2' },
      { id: 'c', nIdReceb: '3' },
    ]);
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('linha sem nIdReceb passa direto e NÃO deduplica contra outra sem nIdReceb', () => {
    // Sem nIdReceb não há o que consultar: são o gap de cobertura, contadas à parte pelo
    // chamador. Colapsá-las entre si (todas com chave `null`) esconderia o gap.
    const out = skuItemsDedupPorRecebimento([
      { id: 'sem-1', nIdReceb: null },
      { id: 'sem-2', nIdReceb: null },
      { id: 'com', nIdReceb: '9' },
    ]);
    expect(out.map((o) => o.id)).toEqual(['sem-1', 'sem-2', 'com']);
  });

  it('a eleita é a PRIMEIRA da ordem da fila — dedup preserva a prioridade, não a atropela', () => {
    // A fila chega ordenada earliest-deadline-first. Se o dedup elegesse outra que não a
    // primeira, a NFe prestes a expirar perderia a vez pra uma folgada.
    const fila = [
      { id: 'poison', tentativas: 5, t2: '2026-07-14T00:00:00+00:00', nIdReceb: '777' },
      { id: 'virgem', tentativas: 0, t2: '2026-06-15T00:00:00+00:00', nIdReceb: '777' },
    ].sort(skuItemsCompararFila);
    const out = skuItemsDedupPorRecebimento(fila);
    expect(out.map((o) => o.id)).toEqual(['virgem']);
  });

  it('eleição é DETERMINÍSTICA entre runs quando as irmãs empatam', () => {
    // Irmãs da mesma NFe têm t2 DIFERENTE em prod (o sync de NFes preserva o t2
    // pré-existente de cada pedido via `??`), mas quando empatam o id desempata. Sem
    // ordem total, dois runs elegeriam linhas diferentes e o item sem pedido casado
    // pousaria ora numa, ora noutra — criando a duplicata que o dedup veio matar.
    const mesmoT2 = '2026-07-01T00:00:00+00:00';
    const eleger = (ordemDeChegada: Array<{ id: string; tentativas: number; t2: string; nIdReceb: string }>) =>
      skuItemsDedupPorRecebimento([...ordemDeChegada].sort(skuItemsCompararFila))[0].id;

    const x = { id: 'bbb', tentativas: 0, t2: mesmoT2, nIdReceb: '42' };
    const y = { id: 'aaa', tentativas: 0, t2: mesmoT2, nIdReceb: '42' };
    // a MESMA fila chegando em ordens opostas tem de eleger a MESMA linha
    expect(eleger([x, y])).toBe('aaa');
    expect(eleger([y, x])).toBe('aaa');
  });
});

// ── agregarItensRecebimento — o fix do bug de sobrescrita item-a-item (2026-07-17) ──
// O writer da edge fazia 1 upsert por item de NFe com onConflict (tracking_id, sku_codigo_omie).
// Quando o MESMO SKU se repetia na NFe e caía no mesmo tracking destino, o 2º upsert
// SOBRESCREVIA o 1º em vez de somar → valor_total virava o do último item, não o total.
// Medido em prod (psql-ro, 2026-07-17): PRD02377 gravou R$139,90 de R$1.214,37 reais;
// PRD03594 R$1.190,98 de R$1.984,96; 10,9% das NFes recentes têm SKU repetido. Este helper
// agrega por (tracking, sku) ANTES do upsert. Contraparte da função SQL dropada (#1373), que
// agregava certo o total mas usava AVG(vu) simples — aqui vu é média PONDERADA por qtd.
const mk = (over: Partial<ItemRecebimentoResolvido>): ItemRecebimentoResolvido => ({
  tracking_id: 'T1',
  sku_codigo_omie: 111,
  sku_codigo: 'SKU-A',
  sku_descricao: 'Verniz A',
  sku_unidade: 'LT',
  sku_ncm: '3208',
  fornecedor_codigo_omie: 8689681266,
  fornecedor_nome: 'RENNER SAYERLACK S/A',
  grupo_leadtime: 'tintas',
  quantidade_pedida: 1,
  quantidade_recebida: 1,
  valor_unitario: 10,
  valor_total: 10,
  t1_data_pedido: '2026-03-16T00:00:00Z',
  t2_data_faturamento: '2026-03-16T00:00:00Z',
  t3_data_cte: null,
  t4_data_recebimento: '2026-03-20T00:00:00Z',
  ...over,
});

describe('agregarItensRecebimento — soma o SKU repetido na NFe (não sobrescreve)', () => {
  it('SKU repetido no MESMO tracking → 1 linha com qp/qr/vt SOMADOS (o caso DFZ.8040L5 real)', () => {
    // prod: raw tem 2 itens do mesmo SKU: (qp15, qr3, vt243.95) + (qp5, qr1, vt81.31).
    const out = agregarItensRecebimento([
      mk({ sku_codigo_omie: 111, quantidade_pedida: 15, quantidade_recebida: 3, valor_total: 243.95 }),
      mk({ sku_codigo_omie: 111, quantidade_pedida: 5, quantidade_recebida: 1, valor_total: 81.31 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quantidade_pedida).toBe(20);
    expect(out[0].quantidade_recebida).toBe(4);
    expect(out[0].valor_total).toBeCloseTo(325.26, 2);
    expect(out[0].n_itens_agregados).toBe(2);
  });

  it('valor_unitario é a média PONDERADA por quantidade_pedida, não o AVG simples (bug de 2ª ordem)', () => {
    // vu=10 q=1 e vu=20 q=3 → ponderada (10·1+20·3)/(1+3)=17.5; AVG simples seria 15.
    const out = agregarItensRecebimento([
      mk({ valor_unitario: 10, quantidade_pedida: 1 }),
      mk({ valor_unitario: 20, quantidade_pedida: 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].valor_unitario).toBeCloseTo(17.5, 6);
  });

  it('SKUs DIFERENTES no mesmo tracking → 2 linhas separadas (não funde)', () => {
    const out = agregarItensRecebimento([
      mk({ sku_codigo_omie: 111, valor_total: 100 }),
      mk({ sku_codigo_omie: 222, valor_total: 200 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.sku_codigo_omie).sort()).toEqual([111, 222]);
  });

  it('MESMO SKU em trackings DIFERENTES → 2 linhas separadas (a chave de conflito inclui o tracking)', () => {
    const out = agregarItensRecebimento([
      mk({ tracking_id: 'T1', sku_codigo_omie: 111, valor_total: 100 }),
      mk({ tracking_id: 'T2', sku_codigo_omie: 111, valor_total: 200 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.tracking_id).sort()).toEqual(['T1', 'T2']);
  });

  it('ausente ≠ zero: qr null nos DOIS itens → qr agregado null (não 0 fabricado)', () => {
    const out = agregarItensRecebimento([
      mk({ quantidade_recebida: null }),
      mk({ quantidade_recebida: null }),
    ]);
    expect(out[0].quantidade_recebida).toBeNull();
  });

  it('ausente ≠ zero: um qr null + um qr 5 → soma 5 (null é ausente, não somando 0)', () => {
    const out = agregarItensRecebimento([
      mk({ quantidade_recebida: null }),
      mk({ quantidade_recebida: 5 }),
    ]);
    expect(out[0].quantidade_recebida).toBe(5);
  });

  it('item ÚNICO (sem repetição) passa idêntico, n_itens_agregados=1 — não altera o caso comum', () => {
    const item = mk({ quantidade_pedida: 7, quantidade_recebida: 7, valor_unitario: 30, valor_total: 210 });
    const out = agregarItensRecebimento([item]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      quantidade_pedida: 7, quantidade_recebida: 7, valor_unitario: 30, valor_total: 210,
      n_itens_agregados: 1,
    });
  });

  it('preserva descritivos e datas do bucket (tracking/datas são iguais entre itens do mesmo grupo)', () => {
    const out = agregarItensRecebimento([
      mk({ sku_codigo: 'DFZ.8040L5', sku_ncm: '3208', t1_data_pedido: '2026-03-16T00:00:00Z', t4_data_recebimento: '2026-03-20T00:00:00Z' }),
      mk({ sku_codigo: 'DFZ.8040L5', sku_ncm: '3208', t1_data_pedido: '2026-03-16T00:00:00Z', t4_data_recebimento: '2026-03-20T00:00:00Z' }),
    ]);
    expect(out[0].sku_codigo).toBe('DFZ.8040L5');
    expect(out[0].sku_ncm).toBe('3208');
    expect(out[0].t1_data_pedido).toBe('2026-03-16T00:00:00Z');
    expect(out[0].t4_data_recebimento).toBe('2026-03-20T00:00:00Z');
  });

  it('lista vazia → []', () => {
    expect(agregarItensRecebimento([])).toEqual([]);
  });
});
