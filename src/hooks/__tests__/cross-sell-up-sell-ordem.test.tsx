import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O top-2 do UP-SELL era sorteio, e o sorteio era invisível.
 *
 * O ramo de up-sell calculava
 *   `pij = TAXA_CONVERSAO_UP_SELL * (healthScore/100) * engagementFactor * 0.8`
 * e `affinityScore = pij` — NENHUM termo depende do produto candidato. Todos os candidatos
 * do mesmo cliente empatavam, o `sort` (estável em V8) preservava a ordem de inserção e o
 * `slice(0,2)` entregava os dois primeiros da varredura do `productList`, que vem de
 * `fetchAllPages` com `.order('id')`. O top-2 era a ordem de uuid do catálogo.
 *
 * MEDIDO em prod (psql-ro, 20/08/2026): as 422 ofertas up_sell vivas (= 211 pares
 * `(farmer,cliente)` × 2 vagas) cabem em 15 SKUs de 2.463 vendáveis; a mediana de candidatos
 * elegíveis por cliente é **2.068**; 229 das 422 (54%) estão no rank 1 ou 2 POR ID entre os
 * elegíveis do seu `current_product_id`, onde o acaso daria ~0,16%; e uma simulação
 * determinística do motor reproduz 203/422 ofertas exatamente.
 *
 * O conserto NÃO reintroduz margem no browser — o custo saiu de lá de propósito. Ver
 * `@/lib/farmer/upsell-ordem` para o desenho inteiro. O que cada caso aqui prende:
 *
 *   B · a ORDEM sai do sinal, não da posição no `productList`;
 *   C · o gate de LINHA (família) descarta quem não é substituível;
 *   D · `affinity_score` NÃO carrega a ordem — e por que isso é decisão, não omissão;
 *   E · a popularidade realmente DESEMPATA (senão a 2ª chave seria decorativa);
 *   F · o mesmo SKU não ocupa as duas vagas (dedup);
 *   G/H · empate residual aparece no head, com denominador.
 *
 * ⚠️ NÃO há gate de `account` aqui, e a ausência é DESENHO: o #1823 mediu e descartou
 * (47,4% dos clientes compram pelas duas empresas do grupo), e
 * `cross-sell-conta-da-oferta.test.tsx` exige que a oferta cross-empresa continue saindo.
 */
const FARMER = 'farmer-1';

/** O item comprado: R$ 50, linha `Lixas`/`UN`. O piso de elegibilidade é 1,1× = R$ 55. */
const SKU_BASE = 'sku-base';

/** Candidatos da MESMA linha, inseridos no `productList` em ordem INVERSA ao mérito. */
const SKU_SALTO_GRANDE = 'sku-a-salto-grande'; // R$ 500 — razão 10,0
const SKU_SALTO_MEDIO = 'sku-b-salto-medio'; //  R$ 150 — razão  3,0
const SKU_LINHA_SUPERIOR = 'sku-c-linha-superior'; // R$ 60 — razão 1,2 · ÚLTIMO do catálogo

/**
 * Os dois descartados pelo GATE. Ambos são mais próximos em preço que o vencedor legítimo e
 * ambos vêm ANTES dele no `productList`: venceriam tanto no motor antigo quanto numa
 * ordenação por preço SEM gate, então são eles que isolam o gate da ordenação.
 */
const SKU_OUTRA_FAMILIA = 'sku-0-outra-familia'; // R$ 56 — razão 1,12, família `Tintas`
const SKU_OUTRA_UNIDADE = 'sku-0-outra-unidade'; // R$ 57 — razão 1,14, `Lixas` mas em `CX`

const CODIGO: Record<string, number> = {
  [SKU_BASE]: 1,
  [SKU_OUTRA_FAMILIA]: 2,
  [SKU_OUTRA_UNIDADE]: 3,
  [SKU_SALTO_GRANDE]: 4,
  [SKU_SALTO_MEDIO]: 5,
  [SKU_LINHA_SUPERIOR]: 6,
  'sku-pop-baixa': 7,
  'sku-pop-alta': 8,
  'sku-empate-1': 9,
  'sku-empate-2': 10,
  'sku-base-2': 11,
  'sku-dedup': 12,
  'sku-longe': 13,
};

const persistidas: Array<Record<string, unknown>> = [];

type Cenario = 'ordem' | 'popularidade' | 'empate' | 'dedup';
let cenario: Cenario = 'ordem';

const produto = (id: string, valor: number, familia: string | null, unidade: string | null) => ({
  id,
  codigo: id,
  descricao: `Produto ${id}`,
  valor_unitario: valor,
  metadata: null,
  ativo: true,
  omie_codigo_produto: CODIGO[id],
  estoque: 9,
  account: 'colacor',
  familia,
  unidade,
});

/** A ordem do array É a ordem do `productList` (o stub não implementa `.order`). */
function catalogo(): ReturnType<typeof produto>[] {
  switch (cenario) {
    case 'popularidade':
      return [
        produto(SKU_BASE, 50, 'Lixas', 'UN'),
        // Mesmo preço (razão 3,0) — só a popularidade os separa. O MENOS popular vem
        // primeiro, então a ordem de `id` daria a resposta errada.
        produto('sku-pop-baixa', 150, 'Lixas', 'UN'),
        produto('sku-pop-alta', 150, 'Lixas', 'UN'),
        produto(SKU_LINHA_SUPERIOR, 60, 'Lixas', 'UN'),
      ];
    case 'empate':
      return [
        produto(SKU_BASE, 50, 'Lixas', 'UN'),
        produto('sku-empate-1', 150, 'Lixas', 'UN'),
        produto('sku-empate-2', 150, 'Lixas', 'UN'),
        produto(SKU_LINHA_SUPERIOR, 60, 'Lixas', 'UN'),
      ];
    case 'dedup':
      return [
        produto(SKU_BASE, 50, 'Lixas', 'UN'),
        produto('sku-base-2', 55, 'Lixas', 'UN'),
        // Supera as DUAS bases (razão 1,22 sobre 50 e 1,109 sobre 55): sem dedup entra duas
        // vezes e ocupa as duas vagas sozinho.
        produto('sku-dedup', 61, 'Lixas', 'UN'),
        produto('sku-longe', 200, 'Lixas', 'UN'),
      ];
    default:
      return [
        produto(SKU_BASE, 50, 'Lixas', 'UN'),
        produto(SKU_OUTRA_FAMILIA, 56, 'Tintas', 'UN'),
        produto(SKU_OUTRA_UNIDADE, 57, 'Lixas', 'CX'),
        produto(SKU_SALTO_GRANDE, 500, 'Lixas', 'UN'),
        produto(SKU_SALTO_MEDIO, 150, 'Lixas', 'UN'),
        produto(SKU_LINHA_SUPERIOR, 60, 'Lixas', 'UN'),
      ];
  }
}

/** O que `cli-1` já comprou — some do universo de candidatos por definição. */
const comprasDoAlvo = (): number[] =>
  cenario === 'dedup' ? [CODIGO[SKU_BASE], CODIGO['sku-base-2']] : [CODIGO[SKU_BASE]];

const vendaveis = (): string[] => {
  const comprados = new Set(comprasDoAlvo());
  return catalogo().map((p) => p.id).filter((id) => !comprados.has(CODIGO[id]));
};

/** Clientes que só existem para dar popularidade — nenhum deles é `cli-1`. */
const CLIENTES_POPULARIDADE = ['cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6'];

function itensDePopularidade(indiceDoCliente: number): Array<Record<string, unknown>> {
  return vendaveis().flatMap((id) => {
    // A popularidade conta CLIENTES DISTINTOS da carteira, então quem a move é o número de
    // clientes que compram — não a repetição da linha (repetir contava OCORRÊNCIA, e essa
    // definição saiu). No cenário `popularidade`, `sku-pop-baixa` é comprado só pelos 2
    // primeiros clientes e `sku-pop-alta` por todos os 5.
    //
    // Fora desse cenário todos ficam iguais, para que a popularidade nunca seja o que decide
    // onde o teste afirma que quem decide é o preço.
    const soOsDoisPrimeiros = cenario === 'popularidade' && id === 'sku-pop-baixa';
    if (soOsDoisPrimeiros && indiceDoCliente >= 2) return [];
    return [{ omie_codigo_produto: CODIGO[id], quantity: 1, unit_price: 100 }];
  });
}

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    // Quem dá POPULARIDADE precisa estar na CARTEIRA: a métrica passou a contar clientes
    // distintos da carteira (antes eram ocorrências de item na base inteira), então comprador
    // de fora não pontua mais. Só `cli-1` tem `profiles`, então a GERAÇÃO segue restrita a ele
    // e o observável destes testes — o top-2 de up-sell do alvo — não muda.
    farmer_client_scores: [
      { customer_user_id: 'cli-1', farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50 },
      ...CLIENTES_POPULARIDADE.map((cid) => ({
        customer_user_id: cid, farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50,
      })),
    ],
    omie_products: catalogo(),
    sales_orders: [
      {
        customer_user_id: 'cli-1',
        items: comprasDoAlvo().map((cod) => ({ omie_codigo_produto: cod, quantity: 1, unit_price: cod === CODIGO[SKU_BASE] ? 50 : 55 })),
        total: 105,
        created_at: '2026-01-01T00:00:00Z',
        account: 'colacor',
      },
      ...CLIENTES_POPULARIDADE.map((cid, i) => ({
        customer_user_id: cid,
        items: itensDePopularidade(i),
        total: 999,
        created_at: '2026-01-01T00:00:00Z',
        account: 'colacor',
      })),
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
            // TODO candidato é vendável: o gate de custo não pode ser o que separa os
            // desfechos deste teste.
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

type Rec = { productId: string; affinityScore: number };
type ResultadoCrossSell = { current: { recommendations: Array<{ crossSell: Rec[]; upSell: Rec[] }> } };

const rodar = async () => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return (result as unknown as ResultadoCrossSell).current.recommendations.flatMap((c) => c.upSell);
};

const insumoDoHead = (nome: string) => {
  const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { ok: boolean; n: number; esperado?: number }>;
  return insumos[nome];
};

beforeEach(() => {
  persistidas.length = 0;
  cenario = 'ordem';
  vi.clearAllMocks();
});

describe('useCrossSellEngine — o top-2 do up-sell sai de SINAL, não da ordem de `id`', () => {
  it('A (controle positivo): a fixture PRODUZ up-sell, e persiste', async () => {
    // Sem este caso todo `expect` abaixo passaria por vacuidade: `[]` não contém o SKU
    // errado, e "não ofertou nada" é indistinguível de "ofertou certo".
    const up = await rodar();
    expect(up.length).toBe(2);
    expect(persistidas.length).toBe(1);
  });

  it('B: vence a LINHA SUPERIOR (menor salto), não quem vem primeiro no `productList`', async () => {
    // O coração do bug. `SKU_SALTO_GRANDE` (R$ 500, razão 10,0) vem ANTES no catálogo e era
    // o que o motor entregava; `SKU_LINHA_SUPERIOR` (R$ 60, razão 1,2) vem por ÚLTIMO. Todos
    // empatam em popularidade de propósito, então só a razão de preço pode decidir.
    const up = await rodar();
    expect(up.map((r) => r.productId)).toEqual([SKU_LINHA_SUPERIOR, SKU_SALTO_MEDIO]);
    expect(up.map((r) => r.productId)).not.toContain(SKU_SALTO_GRANDE);
  });

  it('C: o gate de LINHA descarta outra família E outra unidade, mesmo sendo mais próximos', async () => {
    // Os dois candidatos descartados custam R$ 56 e R$ 57 — as MENORES razões do cenário — e
    // vêm antes do vencedor no `productList`. A unidade está aqui porque 19 das 81 famílias
    // de prod misturam unidades (1.080 SKUs, 34%): sem ela o "menor salto" compararia
    // preço-por-unidade com preço-por-caixa.
    const up = await rodar();
    expect(up.map((r) => r.productId)).not.toContain(SKU_OUTRA_FAMILIA);
    expect(up.map((r) => r.productId)).not.toContain(SKU_OUTRA_UNIDADE);

    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ product_id: string; recommendation_type: string }>;
    const upPersistido = linhas.filter((l) => l.recommendation_type === 'up_sell').map((l) => l.product_id);
    expect(upPersistido).not.toContain(SKU_OUTRA_FAMILIA);
    expect(upPersistido).not.toContain(SKU_OUTRA_UNIDADE);
  });

  it('D: `affinity_score` NÃO carrega a ordem — e é assim de propósito', async () => {
    // A tentação óbvia é gravar o mérito no score (ex.: `pij × 1,1/razão`) para a ordem
    // sobreviver à persistência. É armadilha, e este teste existe para que quem tentar
    // encare o motivo em vez de "melhorar" o motor:
    //
    // `farmer_melhor_individual_atomico` e `usePropostaPreview` leem `affinity_score` SEM
    // filtrar `recommendation_type` — ali a MAGNITUDE é comparada entre cross-sell e
    // up-sell, como dado cardinal. `1,1/r`, `(1,1/r)²` e uma exponencial dão a MESMA ordem
    // local e resultados diferentes nesses consumidores: escolher uma seria afirmar, sem
    // dado, como a afinidade decai com preço. Isso é inventar score.
    //
    // LIMITAÇÃO DECLARADA: a ordem vive no ARRAY. A tela do vendedor renderiza o array do
    // hook (`FarmerRecommendations.tsx`), então ela recebe o conserto inteiro; os dois
    // consumidores acima podem reordenar ENTRE as 2 emitidas. Fechar isso pede coluna de
    // rank (migration manual) ou filtro por tipo — decisão separada, fora deste PR.
    const up = await rodar();
    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ product_id: string; recommendation_type: string; affinity_score: number; p_ij: number }>;
    const upPersistido = linhas.filter((l) => l.recommendation_type === 'up_sell');

    // O CONJUNTO persistido é o emitido — isso sim tem de valer.
    expect([...upPersistido.map((l) => l.product_id)].sort()).toEqual([...up.map((r) => r.productId)].sort());
    // E o score é a propensão do CLIENTE: igual entre candidatos, por desenho declarado.
    expect(new Set(upPersistido.map((l) => l.affinity_score)).size).toBe(1);
    // `p_ij` é exibido como "% de conversão" na tela: nenhum fator de ranking pode dobrá-lo.
    expect(new Set(upPersistido.map((l) => l.p_ij)).size).toBe(1);
  });

  it('E: a POPULARIDADE desempata preços iguais — a 2ª chave não é decorativa', async () => {
    // Sem este caso a 2ª chave estaria escrita e nunca exercida: as duas fixtures de preço
    // acima têm popularidade uniforme. `sku-pop-baixa` (2 clientes da carteira) vem ANTES de
    // `sku-pop-alta` (5) no `productList` e tem o MESMO preço, então a ordem de `id` daria
    // a resposta errada e só a popularidade pode dar a certa.
    cenario = 'popularidade';
    const up = await rodar();
    expect(up.map((r) => r.productId)).toEqual([SKU_LINHA_SUPERIOR, 'sku-pop-alta']);
  });

  it('F: o mesmo SKU não ocupa as DUAS vagas (dedup por produto)', async () => {
    // O laço externo percorre os itens JÁ COMPRADOS, então um candidato aparece uma vez por
    // item que ele supera. `sku-dedup` (R$ 61) supera as duas bases do cliente (R$ 50 e
    // R$ 55) e, sem dedup, entra duas vezes com razões 1,22 e 1,109 — ocupando o top-2
    // sozinho. Em prod isso JÁ acontece: 37 pares `(cliente, SKU)` duplicados nas ofertas
    // vivas (achado do challenge Codex). A tela usa `productId` como key React e o WhatsApp
    // deduplica DEPOIS, sem repor a vaga: duas ofertas viravam uma.
    cenario = 'dedup';
    const up = await rodar();
    expect(up.map((r) => r.productId)).toEqual(['sku-dedup', 'sku-longe']);
    expect(new Set(up.map((r) => r.productId)).size).toBe(up.length);
  });

  it('G: sem empate, o head declara `upsell_ordem_decidida` com `n === esperado`', async () => {
    // O par do caso H. Sem ele o sensor seria um contador que só sobe, e `n < esperado`
    // nunca distinguiria empate de defeito do próprio sensor.
    const up = await rodar();
    const sensor = insumoDoHead('upsell_ordem_decidida');
    expect(sensor).toBeTruthy();
    expect(sensor.ok).toBe(true);
    expect(sensor.esperado).toBe(up.length);
    expect(sensor.n).toBe(sensor.esperado);
  });

  it('H: com empate real, o head CONTA a posição não-decidida (`n < esperado`)', async () => {
    // Os 8,3% medidos em prod sobre o cutoff REAL. Dois SKUs indistinguíveis (mesma linha,
    // R$ 150, mesma popularidade) disputam a 2ª vaga: quem entra é arbitrário, e o
    // entregável mínimo é que isso APAREÇA — não que o motor finja ter escolhido.
    cenario = 'empate';
    const up = await rodar();
    expect(up.length).toBe(2);

    const sensor = insumoDoHead('upsell_ordem_decidida');
    expect(sensor.ok).toBe(true);
    expect(sensor.esperado).toBe(up.length);
    // A vaga 1 (`SKU_LINHA_SUPERIOR`, razão 1,2) é decidida; a vaga 2 empata com o descartado.
    expect(sensor.n).toBe(1);
    expect(sensor.n).toBeLessThan(sensor.esperado as number);
  });
});
