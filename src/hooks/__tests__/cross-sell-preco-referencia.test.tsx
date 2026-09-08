import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O preço de referência do up-sell era o de uma compra ARBITRÁRIA.
 *
 * O motor reduz `sales_orders` a `(cliente, SKU) → preço` com "último item vence", e "último"
 * era a ordem de LEITURA: `fetchAllPages` pagina com `.order('id')`, e `id` é uuid. Ordem de
 * uuid não tem relação com a data do pedido — então entre duas compras do mesmo SKU vencia a
 * de uuid maior, que pode ser a de 2020.
 *
 * Isso sempre governou a ELEGIBILIDADE (`premiumPrice > referencia * 1,1`). Desde o #1837
 * governa também a ORDEM (`razaoPreco = premiumPrice / referencia`, chave PRIMÁRIA do
 * `compararCandidatosUpSell`) — então referência arbitrária virou top-2 arbitrário.
 *
 * MEDIDO em prod (psql-ro, 07/09/2026, réplica do motor em SQL com controle): em 29,2% dos
 * 13.287 pares o uuid pega um pedido estritamente MAIS ANTIGO (mediana 238 dias, máx ~6 anos),
 * o preço difere em 17,7% (|Δ| mediana 13,7%), e **166 dos 1.060 clientes (15,7%)** recebem um
 * top-2 diferente.
 *
 * O que cada caso prende:
 *   A · o preço vem do pedido mais RECENTE, mesmo quando o uuid diz o contrário (o defeito);
 *   B · CONTROLE POSITIVO — quando uuid e `created_at` concordam, o desfecho é o de sempre
 *       (senão A passaria só por eu ter invertido a regra);
 *   C · `created_at` empatado desempata por `id` (1,94% dos pares em prod empatam no topo);
 *   D · data ilegível NÃO se declara recente (fail-closed), mas o preço observado continua
 *       valendo — não repetir o #2224, onde ausência de dado apagava oferta legítima.
 *
 * ⚠️ A ordem de PAGINAÇÃO segue `.order('id')` de propósito (PK ⇒ ordem TOTAL estável, exigida
 * pela capa de 1.000 do PostgREST). A recência é decidida na REDUÇÃO. Por isso os pedidos aqui
 * são listados em ordem CRESCENTE de `id`: é o que a leitura real entrega ao motor.
 */
const FARMER = 'farmer-preco-ref';
const CLI = 'cli-1';

const SKU_BASE = 'sku-base'; //   comprado — Lixas/UN
const SKU_PERTO = 'sku-perto'; // R$ 60
const SKU_MEDIO = 'sku-medio'; // R$ 150
const SKU_LONGE = 'sku-longe'; // R$ 200

/** Segunda base comprada e os dois candidatos do cenário de ORDEM (ver caso F). */
const SKU_BASE_B = 'sku-base-b';
const SKU_CAND_X = 'sku-cand-x'; // R$ 130
const SKU_CAND_Y = 'sku-cand-y'; // R$ 250

const CODIGO: Record<string, number> = {
  [SKU_BASE]: 1,
  [SKU_PERTO]: 2,
  [SKU_MEDIO]: 3,
  [SKU_LONGE]: 4,
  [SKU_BASE_B]: 5,
  [SKU_CAND_X]: 6,
  [SKU_CAND_Y]: 7,
};

/**
 * Preços escolhidos para que a REFERÊNCIA mude o conjunto, não só a ordem:
 *
 *   ref R$ 50 (a compra ANTIGA, de uuid maior) → piso 55 → elegíveis PERTO(1,2) MEDIO(3) LONGE(4)
 *                                                        → top-2 = [PERTO, MEDIO]
 *   ref R$ 100 (a compra RECENTE)              → piso 110 → PERTO (0,6) sai; MEDIO(1,5) LONGE(2)
 *                                                        → top-2 = [MEDIO, LONGE]
 */
const PRECO_RECENTE = 100;
const PRECO_ANTIGO = 50;

type Cenario = 'divergente' | 'concordante' | 'empate_created_at' | 'data_ilegivel'
  | 'mesmo_pedido_ultimo_vence' | 'mesmo_pedido_ultimo_sem_preco' | 'ordem_duas_bases';
let cenario: Cenario = 'divergente';

const produto = (id: string, valor: number) => ({
  id,
  codigo: id,
  descricao: `Produto ${id}`,
  valor_unitario: valor,
  metadata: null,
  ativo: true,
  omie_codigo_produto: CODIGO[id],
  estoque: 9,
  account: 'colacor',
  familia: 'Lixas',
  unidade: 'UN',
});

const catalogo = () =>
  cenario === 'ordem_duas_bases'
    ? [produto(SKU_BASE, 100), produto(SKU_BASE_B, 100), produto(SKU_CAND_X, 130), produto(SKU_CAND_Y, 250)]
    : [produto(SKU_BASE, 50), produto(SKU_PERTO, 60), produto(SKU_MEDIO, 150), produto(SKU_LONGE, 200)];

/** SKUs que o cliente já comprou — saem do universo de candidatos por definição. */
const comprados = () => (cenario === 'ordem_duas_bases' ? [SKU_BASE, SKU_BASE_B] : [SKU_BASE]);

const vendaveis = () => {
  const jaTem = new Set(comprados());
  return catalogo().map((p) => p.id).filter((id) => !jaTem.has(id));
};

/** `valor_unitario` porque é o que 100% dos itens em prod carregam. */
const item = (sku: string, preco: number | null) => ({
  omie_codigo_produto: CODIGO[sku],
  quantity: 1,
  valor_unitario: preco,
});

const pedidoDe = (id: string, created_at: string, itens: Array<[string, number | null]>) => ({
  id,
  customer_user_id: CLI,
  items: itens.map(([sku, preco]) => item(sku, preco)),
  total: 0,
  created_at,
  account: 'colacor',
});

/** Um pedido com N itens do SKU_BASE. */
const pedidoCom = (id: string, created_at: string, precos: Array<number | null>) =>
  pedidoDe(id, created_at, precos.map((p) => [SKU_BASE, p] as [string, number | null]));

/** Um pedido com UM item do SKU_BASE. */
const pedido = (id: string, created_at: string, preco: number) =>
  pedidoCom(id, created_at, [preco]);

/**
 * Sempre em ordem CRESCENTE de `id` — a ordem que `.order('id')` entrega. O que muda entre os
 * cenários é como `created_at` se relaciona com ela.
 */
function pedidosDoCenario() {
  switch (cenario) {
    // uuid e data DISCORDAM: a compra recente tem uuid MENOR, então "último lido" pega a antiga.
    case 'divergente':
      return [
        pedido('1111-recente', '2026-06-01T00:00:00Z', PRECO_RECENTE),
        pedido('9999-antigo', '2020-01-01T00:00:00Z', PRECO_ANTIGO),
      ];
    // CONTROLE: uuid e data CONCORDAM (a recente também é a de uuid maior). Vence R$ 50 nos
    // dois mundos — o desfecho é o mesmo de antes do conserto.
    case 'concordante':
      return [
        pedido('1111-antigo', '2020-01-01T00:00:00Z', PRECO_RECENTE),
        pedido('9999-recente', '2026-06-01T00:00:00Z', PRECO_ANTIGO),
      ];
    // `created_at` IDÊNTICO: só o `id` separa. O maior vence ⇒ R$ 50.
    case 'empate_created_at':
      return [
        pedido('1111-igual', '2026-06-01T00:00:00Z', PRECO_RECENTE),
        pedido('9999-igual', '2026-06-01T00:00:00Z', PRECO_ANTIGO),
      ];
    // Data podre no pedido de uuid MAIOR: ele não pode se declarar mais recente. Vence o
    // datado (R$ 100) — mas o SKU continua com preço, e não descartado.
    case 'data_ilegivel':
      return [
        pedido('1111-datado', '2026-06-01T00:00:00Z', PRECO_RECENTE),
        pedido('9999-podre', 'nao-e-data', PRECO_ANTIGO),
      ];
    // MESMO pedido, SKU repetido: `created_at` e `id` empatam por construção, então quem
    // decide é a POSIÇÃO no array — e o hook precisa passá-la certa (o teste do comparador
    // isolado não prova isso). Último item informa preço ⇒ vence ele (R$ 50).
    case 'mesmo_pedido_ultimo_vence':
      return [pedidoCom('1111-unico', '2026-06-01T00:00:00Z', [PRECO_RECENTE, PRECO_ANTIGO])];
    // Mesma forma, só que o ÚLTIMO item não informa preço: o guard do #2224 segura o R$ 100.
    // O par isola "posição decide" de "ausência não apaga" — só o último item muda.
    case 'mesmo_pedido_ultimo_sem_preco':
      return [pedidoCom('1111-unico', '2026-06-01T00:00:00Z', [PRECO_RECENTE, null])];
    // DUAS bases, e só a referência de A muda entre os mundos. Ver o caso F.
    case 'ordem_duas_bases':
      return [
        pedidoDe('1111-a-recente', '2026-06-01T00:00:00Z', [[SKU_BASE, 200]]),
        pedidoDe('5555-b', '2026-03-01T00:00:00Z', [[SKU_BASE_B, 100]]),
        pedidoDe('9999-a-antigo', '2020-01-01T00:00:00Z', [[SKU_BASE, 50]]),
      ];
  }
}

const persistidas: Array<Record<string, unknown>> = [];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      { customer_user_id: CLI, farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50 },
    ],
    omie_products: catalogo(),
    sales_orders: pedidosDoCenario(),
    profiles: [{ user_id: CLI, name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
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
        // Builder com `.order()`/`.range()`, NUNCA Promise crua (#1782/#1798) — o hook pagina
        // esta RPC, e uma Promise crua não tem `.order`.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = vendaveis().map((id) => ({ product_id: id }));
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

type Rec = { productId: string };
type ResultadoCrossSell = { current: { recommendations: Array<{ upSell: Rec[] }> } };

const topUpSell = async (): Promise<string[]> => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return (result as unknown as ResultadoCrossSell).current.recommendations
    .flatMap((c) => c.upSell)
    .map((r) => r.productId);
};

describe('up-sell: o preço de referência é o do pedido mais RECENTE', () => {
  beforeEach(() => { persistidas.length = 0; cenario = 'divergente'; });

  it('A · uuid maior ≠ mais recente: a referência é a compra recente, e o top-2 muda', async () => {
    cenario = 'divergente';
    // Com a referência CERTA (R$ 100) o piso é 110: o SKU de R$ 60 deixa de ser "superior".
    // Com a referência de uuid (R$ 50) ele entraria em 1º — é exatamente o que o defeito fazia.
    expect(await topUpSell()).toEqual([SKU_MEDIO, SKU_LONGE]);
  });

  it('B · CONTROLE: uuid e created_at concordando, o desfecho é o de sempre', async () => {
    cenario = 'concordante';
    // Aqui a mais recente É a de uuid maior (R$ 50). Referência 50 ⇒ piso 55 ⇒ o de R$ 60 entra.
    // Se A passasse por eu ter apenas INVERTIDO a regra, este caso quebraria.
    expect(await topUpSell()).toEqual([SKU_PERTO, SKU_MEDIO]);
  });

  it('C · `created_at` empatado desempata pelo maior `id`', async () => {
    cenario = 'empate_created_at';
    // Mesma data nos dois; vence `9999` ⇒ R$ 50 ⇒ o mesmo top-2 do controle.
    expect(await topUpSell()).toEqual([SKU_PERTO, SKU_MEDIO]);
  });

  it('D · data ilegível não se declara recente — e não apaga o preço conhecido', async () => {
    cenario = 'data_ilegivel';
    // O pedido de uuid maior tem data podre: fail-closed, não vence o datado ⇒ referência 100.
    expect(await topUpSell()).toEqual([SKU_MEDIO, SKU_LONGE]);
  });

  it('E · SKU repetido no MESMO pedido: decide a posição no array', async () => {
    cenario = 'mesmo_pedido_ultimo_vence';
    // `created_at` e `id` empatam por construção — sobra a posição. Referência 50.
    expect(await topUpSell()).toEqual([SKU_PERTO, SKU_MEDIO]);
  });

  it('E2 · ...mas o último item SEM preço não apaga o do anterior (#2224)', async () => {
    cenario = 'mesmo_pedido_ultimo_sem_preco';
    // Mesma forma de E, só o último item muda ⇒ referência segue 100.
    expect(await topUpSell()).toEqual([SKU_MEDIO, SKU_LONGE]);
  });

  /**
   * F · O caso que os A-E NÃO cobriam, e que o challenge Codex expôs: com UMA base só, todos
   * os candidatos dividem pela MESMA referência, então `razaoPreco = premium / ref` ordena
   * igual a `premium` — os A-E mudam de top-2 pela ELEGIBILIDADE, não pela ORDEM. Prova: o
   * Codex trocou `premiumPrice / purchaseData.price` por `premiumPrice` e os 12 testes
   * passaram.
   *
   * Aqui há DUAS bases compradas, e só a referência de A muda entre os mundos:
   *
   *   base A · uuid ⇒ R$ 50 (pedido `9999`, de 2020) · created_at ⇒ R$ 200 (pedido `1111`)
   *   base B · R$ 100 nos dois
   *
   * `razaoPreco` de cada candidato é o MENOR salto entre as bases que ele supera (o dedup):
   *
   *            premium │ mundo uuid (A=50, B=100)      │ mundo created_at (A=200, B=100)
   *   CAND_X │  R$ 130 │ min(130/50, 130/100) = 1,30   │ 130 < 220 ⇒ só B ⇒ 1,30
   *   CAND_Y │  R$ 250 │ min(250/50, 250/100) = 2,50   │ min(250/200, 250/100) = 1,25
   *
   * Os DOIS são elegíveis nos DOIS mundos — o CONJUNTO não muda, só a ORDEM. E ordenar por
   * `premium` cru (a sabotagem do Codex) daria [X, Y] nos dois, reprovando aqui.
   */
  it('F · duas bases: muda a ORDEM, não a elegibilidade — e prende a razão, não o preço', async () => {
    cenario = 'ordem_duas_bases';
    expect(await topUpSell()).toEqual([SKU_CAND_Y, SKU_CAND_X]);
  });
});
