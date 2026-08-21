import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O `productList` dos motores é o catálogo GLOBAL, e ofertar SKU de outra empresa do grupo é
 * DESENHO — não defeito. Este teste fixa as duas metades dessa decisão:
 *
 *   1. o motor SEGUE ofertando cross-empresa (nos DOIS ramos: cross-sell e up-sell), porque
 *      filtrar apagaria recall legítimo — 47,4% dos clientes compram pelas duas empresas
 *      (psql-ro, 20/08/2026); e
 *   2. essa oferta passa a ser CONTADA, no head da geração, com denominador.
 *
 * Sem (1) o teste viraria a prova de um filtro que a medição descartou; sem (2) a decisão
 * ficaria só num comentário, e "está no ar e ninguém reclamou" não é dado.
 *
 * CENÁRIO: `cli-1` só comprou pela `colacor`. Dois SKUs alvo — um `colacor`, um `oben` — são
 * ativos, vendáveis e igualmente populares, e `cli-1` não comprou nenhum dos dois. Nada além
 * da CONTA os separa, então o que o sensor contar é atribuível só a ela.
 */
const FARMER = 'farmer-1';

const SKU_BASE = 'sku-base-colacor';
const SKU_ALVO_COLACOR = 'sku-alvo-colacor';
const SKU_ALVO_OBEN = 'sku-alvo-oben';
/**
 * Candidatos `colacor` que passam todos os gates e NÃO cabem no top-3/top-2. Existem para
 * reproduzir a assinatura de produção: a disponibilidade favorece `colacor` e a ORDENAÇÃO
 * entrega `oben`. Sem folga entre candidatos e slots, as duas frações do par seriam iguais
 * por construção e o teste não provaria nada.
 */
const SKUS_EXTRA_COLACOR = ['sku-extra-1', 'sku-extra-2', 'sku-extra-3'];
const CODIGO_EXTRA: Record<string, number> = { 'sku-extra-1': 5, 'sku-extra-2': 6, 'sku-extra-3': 7 };

/** Compram os dois alvos (um pedido por conta) e dão popularidade a ambos. */
const CLIENTES_POPULARIDADE = ['cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6'];

const persistidas: Array<Record<string, unknown>> = [];

/** `true` = `cli-1` também tem pedido `oben` — o cliente das DUAS empresas, o caso NORMAL. */
let alvoCompraNasDuas = false;

const pedidosDoAlvo = () => [
  { customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 1, quantity: 1, unit_price: 50 }], total: 50, created_at: '2026-01-01T00:00:00Z', account: 'colacor' },
  ...(alvoCompraNasDuas
    ? [{ customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 4, quantity: 1, unit_price: 10 }], total: 10, created_at: '2026-01-02T00:00:00Z', account: 'oben' }]
    : []),
];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      { customer_user_id: 'cli-1', farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50 },
    ],
    omie_products: [
      { id: SKU_BASE, codigo: 'B', descricao: 'Base Colacor', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 9, account: 'colacor' },
      // O `oben` ANTES dos `colacor` de propósito: os candidatos empatam em afinidade, então
      // quem ordena é a posição no `productList` — e é assim que a fixture faz o ranking
      // preferir a conta alheia mesmo com `colacor` sendo a maioria dos candidatos.
      { id: SKU_ALVO_OBEN, codigo: 'AO', descricao: 'Alvo Oben', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 3, estoque: 9, account: 'oben' },
      { id: SKU_ALVO_COLACOR, codigo: 'AC', descricao: 'Alvo Colacor', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 9, account: 'colacor' },
      ...SKUS_EXTRA_COLACOR.map((id) => ({
        id, codigo: id, descricao: `Extra ${id}`, valor_unitario: 100, metadata: null, ativo: true,
        omie_codigo_produto: CODIGO_EXTRA[id], estoque: 9, account: 'colacor',
      })),
      // Só para dar ao alvo um pedido `oben` quando `alvoCompraNasDuas`: barato e já comprado,
      // então não vira candidato e não mexe na contagem de ofertas.
      { id: 'sku-miudo-oben', codigo: 'M', descricao: 'Miudo Oben', valor_unitario: 10, metadata: null, ativo: true, omie_codigo_produto: 4, estoque: 9, account: 'oben' },
    ],
    sales_orders: [
      ...pedidosDoAlvo(),
      // Um pedido por CONTA: o SKU `oben` só resolve dentro de um pedido `oben` (#1807), então
      // dar popularidade aos dois exige as duas contas — e é isso que torna os alvos empatados.
      ...CLIENTES_POPULARIDADE.flatMap((cid) => [
        { customer_user_id: cid, items: [
          { omie_codigo_produto: 2, quantity: 1, unit_price: 100 },
          ...SKUS_EXTRA_COLACOR.map((id) => ({ omie_codigo_produto: CODIGO_EXTRA[id], quantity: 1, unit_price: 100 })),
        ], total: 400, created_at: '2026-01-01T00:00:00Z', account: 'colacor' },
        { customer_user_id: cid, items: [{ omie_codigo_produto: 3, quantity: 1, unit_price: 100 }], total: 100, created_at: '2026-01-01T00:00:00Z', account: 'oben' },
      ]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = () => chain;
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_recomendacoes_substituir') persistidas.push(args ?? {});

      if (nome === 'get_skus_margem_positiva') {
        // Builder com `.order()`/`.range()`, NUNCA Promise crua (#1782/#1798). Os dois alvos
        // são vendáveis: o gate de custo não pode ser o que separa os desfechos.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [
              { product_id: SKU_ALVO_COLACOR },
              { product_id: SKU_ALVO_OBEN },
              ...SKUS_EXTRA_COLACOR.map((id) => ({ product_id: id })),
            ];
            const c = chain as { _de?: number; _ate?: number };
            resolve({ data: todos.slice(c._de ?? 0, (c._ate ?? todos.length - 1) + 1), error: null });
          },
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

type ResultadoCrossSell = {
  current: { recommendations: Array<{ crossSell: Array<{ productId: string }>; upSell: Array<{ productId: string }> }> };
};

const rodar = async () => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result as unknown as ResultadoCrossSell;
};

const sensorDoHead = () => {
  const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { ok: boolean; n: number; esperado?: number }>;
  return insumos.oferta_conta_do_cliente;
};

beforeEach(() => {
  persistidas.length = 0;
  alvoCompraNasDuas = false;
  vi.clearAllMocks();
});

describe('useCrossSellEngine — a conta da OFERTA é contada, não filtrada', () => {
  it('A (controle positivo): a fixture PRODUZ oferta nos dois ramos, e nas duas contas', async () => {
    // Sem este caso, todo número do sensor abaixo poderia vir de "o motor não ofertou nada" —
    // e `n = 0` de zero oferta é indistinguível de `n = 0` por conta alheia.
    const result = await rodar();
    const cross = result.current.recommendations.flatMap((c) => c.crossSell).map((r) => r.productId);
    const up = result.current.recommendations.flatMap((c) => c.upSell).map((r) => r.productId);
    expect(cross).toContain(SKU_ALVO_COLACOR);
    expect(cross).toContain(SKU_ALVO_OBEN);
    expect(up.length).toBeGreaterThan(0);
    expect(persistidas.length).toBeGreaterThan(0);
  });

  it('B: o SKU de outra empresa CONTINUA sendo ofertado — a decisão é não filtrar', async () => {
    // O oposto do que um filtro faria. Está aqui para que remover a oferta cross-empresa
    // exija encarar este teste, em vez de "limpar" o motor achando que corrige um vazamento:
    // apagaria 30,5% da oferta viva e 342 das 349 ofertas dos clientes 100% `colacor`.
    const result = await rodar();
    const ofertados = result.current.recommendations.flatMap((c) => [...c.crossSell, ...c.upSell]).map((r) => r.productId);
    expect(ofertados).toContain(SKU_ALVO_OBEN);
    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ product_id: string }>;
    expect(linhas.map((l) => l.product_id)).toContain(SKU_ALVO_OBEN);
  });

  it('C: o head declara `oferta_conta_do_cliente` com denominador, e `n < esperado`', async () => {
    // `cli-1` só compra `colacor`: as ofertas `oben` ficam fora de `n` e dentro de `esperado`.
    const result = await rodar();
    const emitidas = result.current.recommendations.flatMap((c) => [...c.crossSell, ...c.upSell]);
    const naConta = emitidas.filter((r) => r.productId !== SKU_ALVO_OBEN).length;

    const sensor = sensorDoHead();
    expect(sensor).toBeTruthy();
    expect(sensor.ok).toBe(true);
    // Amarrado ao que o motor REALMENTE emitiu, não a um literal: um número fixo aqui viraria
    // teatro no dia em que o ranking mudar o top-3.
    expect(sensor.esperado).toBe(emitidas.length);
    expect(sensor.n).toBe(naConta);
    expect(sensor.n).toBeLessThan(sensor.esperado as number);
  });

  it('D: cliente que compra pelas DUAS empresas fecha em `n === esperado` — não é achado', async () => {
    // O par do caso C, e a razão de o filtro ter sido descartado: 139 dos 293 clientes com
    // recomendação viva estão neste caso. Sem ele, `n < esperado` seria um contador que só
    // sobe, e o sensor não distinguiria deriva de operação normal.
    alvoCompraNasDuas = true;
    const result = await rodar();
    const emitidas = result.current.recommendations.flatMap((c) => [...c.crossSell, ...c.upSell]);
    expect(emitidas.length).toBeGreaterThan(0);

    const sensor = sensorDoHead();
    expect(sensor.n).toBe(sensor.esperado);
    expect(sensor.esperado).toBe(emitidas.length);
  });

  it('F: `candidatos_conta_do_cliente` é o denominador que separa carteira de RANKING', async () => {
    // O sensor de emitidas SOZINHO não distingue "a carteira só tinha candidato de fora" de
    // "havia candidato da conta e o ranking preferiu o de fora" — e as duas leituras pedem
    // ações opostas (crítica do challenge Codex, aceita). O par distingue.
    //
    // Esta fixture reproduz a assinatura de produção: a maioria dos candidatos é `colacor` e o
    // ranking entrega `oben` nos slots de topo. Logo a fração dos CANDIDATOS na conta do
    // cliente tem de ser ESTRITAMENTE MAIOR que a das EMITIDAS — se as duas empatassem, o
    // segundo insumo seria redundante e não valeria o custo.
    await rodar();
    const emitidas = sensorDoHead();
    const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { ok: boolean; n: number; esperado?: number }>;
    const candidatos = insumos.candidatos_conta_do_cliente;

    expect(candidatos).toBeTruthy();
    expect(candidatos.ok).toBe(true);
    // Todo emitido foi antes um candidato: o denominador maior é invariante, não coincidência.
    expect(candidatos.esperado).toBeGreaterThan(emitidas.esperado as number);
    expect(candidatos.n / (candidatos.esperado as number))
      .toBeGreaterThan(emitidas.n / (emitidas.esperado as number));
  });

  it('E: o sensor conta a OFERTA emitida, não o candidato considerado', async () => {
    // `esperado` tem de bater com o top-3 + top-2 que chega ao farmer. Se contasse candidatos,
    // mediria o que o motor PENSOU — e o `productList` inteiro é vendável aqui, então o número
    // saltaria acima das linhas persistidas.
    await rodar();
    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ product_id: string }>;
    expect(sensorDoHead().esperado).toBe(linhas.length);
  });
});
