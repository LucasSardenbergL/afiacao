import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Guard money-path — a tela de bundles tem de descrever o que REALMENTE aconteceu.
 *
 * O #1791 fez o `useBundleEngine` expor `erro`/`desatualizado` e a página renderizar um
 * alerta. O challenge Codex (gpt-5.6-sol, xhigh) daquele PR apontou que sobraram três
 * estados em que o texto ainda mente. Dois deles são desta suíte:
 *
 *  1. O alerta trata QUALQUER exceção como falha de LEITURA ("a leitura da base falhou.
 *     Nada abaixo foi estimado"). Mas o `catch` também pega a falha da GRAVAÇÃO — a RPC
 *     `farmer_bundle_recomendacoes_substituir` roda DEPOIS de `aplicarBundles`, então os
 *     bundles na tela são válidos e desta execução. Desacreditá-los é jogar fora o
 *     trabalho bom: o vendedor tem uma oferta legítima na mão e o aviso manda ignorá-la.
 *
 *  2. O empty state diz 'Clique em "Calcular"' tanto para quem nunca clicou quanto para um
 *     cálculo que RODOU e concluiu honestamente "não há bundle para esta carteira". São
 *     coisas diferentes: uma é trabalho a fazer, a outra é o veredicto do motor. O irmão
 *     `FarmerRecommendations` já separa os três casos.
 *
 * DISCRIMINADOR: o texto na tela distingue leitura-falhou / calculado-mas-não-salvo /
 * calculado-e-vazio / nunca-calculado — sem colapsar dois estados no mesmo texto.
 *
 * Aqui o hook roda de VERDADE (só o supabase é mockado): mockar o hook provaria apenas que
 * a página sabe renderizar um estado que eu mesmo montei.
 */
const FARMER = 'farmer-real';

/** Falha na LEITURA (scores) — a exceção nasce antes de qualquer resultado. */
let falharLeitura = false;
/** Falha na GRAVAÇÃO — a exceção nasce depois de os bundles já estarem na tela. */
let falharGravacao = false;
/** Seed sem coocorrência: o Apriori não acha regra e o motor conclui vazio SEM erro. */
let semBundles = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

/**
 * Seis cestas desenhadas para o Apriori achar DUAS regras com o mesmo antecedente e
 * consequentes distintos (P1→P2 e P1→P3). Isso importa: o motor só monta bundle combinando
 * DUAS regras aplicáveis, então um cliente com uma regra só não produz linha — e o teste
 * passaria por vacuidade. `c7` comprou apenas P1: o par P2+P3 vira bundle para ele.
 * (Mesmo seed de `bundle-head-nao-mente-apos-linhas.test.tsx`.)
 */
const PEDIDOS = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-04T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-05T00:00:00Z' },
  { customer_user_id: 'c7', items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-06T00:00:00Z' },
];

/**
 * Cada cliente compra um SKU só e nenhum par se repete: existe histórico (a carteira está
 * viva, os insumos vêm todos não-vazios), mas não há coocorrência de onde tirar regra. É o
 * "zero de verdade" — o cálculo roda inteiro e conclui que não há bundle.
 */
const PEDIDOS_SEM_PADRAO = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P2' }], total: 100, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c7', items: [{ product_id: 'P3' }], total: 100, created_at: '2026-07-03T00:00:00Z' },
];

const PRODUTOS = ['P1', 'P2', 'P3', 'P4'].map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));

const score = (cid: string, health: number) => ({
  customer_user_id: cid, farmer_id: FARMER, health_score: health, answer_rate_60d: 60,
  whatsapp_reply_rate_60d: 60, avg_monthly_spend_180d: 1000, gross_margin_pct: 30,
  category_count: 2, days_since_last_purchase: 10,
});
const perfil = (cid: string) => ({ user_id: cid, name: `Cliente ${cid}`, customer_type: 'moveleiro', cnae: '3101' });

function resposta(tabela: string): unknown {
  switch (tabela) {
    case 'farmer_client_scores':
      if (falharLeitura) return { data: null, error: ERRO_TIMEOUT };
      return { data: [score('c9', 80), score('c8', 70), score('c7', 75)], error: null, count: 0 };
    case 'omie_products': return { data: PRODUTOS, error: null, count: 0 };
    case 'profiles': return { data: ['c9', 'c8', 'c7'].map(perfil), error: null, count: 0 };
    case 'sales_orders':
      return { data: semBundles ? PEDIDOS_SEM_PADRAO : PEDIDOS, error: null, count: 0 };
    default: return { data: [], error: null, count: 0 };
  }
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string) => {
      // Paginada desde o #1782 — builder com `.order().range()`, não Promise crua.
      if (nome === 'get_skus_margem_positiva') {
        const c: Record<string, unknown> = {
          order: () => c,
          range: () => c,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: PRODUTOS.map((p) => ({ product_id: p.id })), error: null }),
        };
        return c;
      }
      // A rejeição (e não `{ error }`) é o que leva a exceção ao `catch` do hook — que é
      // exatamente o caminho em que o alerta acusava a LEITURA de uma falha da GRAVAÇÃO.
      if (nome === 'farmer_bundle_recomendacoes_substituir' && falharGravacao) {
        return Promise.reject(new Error('connection failure'));
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER }, isStaff: true, loading: false }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerBundles from '../FarmerBundles';

beforeEach(() => {
  falharLeitura = false;
  falharGravacao = false;
  semBundles = false;
  vi.clearAllMocks();
});

/** A página não calcula sozinha — o cálculo é sempre um clique do vendedor. */
const calcular = () => fireEvent.click(screen.getByRole('button', { name: /Calcular/i }));

describe('FarmerBundles — o texto na tela descreve o que aconteceu', () => {
  it('DETECTOR: o caminho feliz renderiza o bundle e nenhum alerta', async () => {
    // Sem isto, "não achei o alerta" e "a tela nem chegou a montar" seriam indistinguíveis.
    render(<FarmerBundles />);
    calcular();

    expect(await screen.findByText('Cliente c7')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('não acusa a LEITURA quando quem falhou foi a GRAVAÇÃO', async () => {
    falharGravacao = true;

    render(<FarmerBundles />);
    calcular();

    const aviso = await screen.findByRole('alert');
    // Os bundles abaixo do alerta são desta execução e são válidos — dizer que a leitura
    // falhou e que nada foi estimado descarta trabalho bom.
    expect(
      aviso.textContent,
      'culpou a leitura por uma falha de gravação',
    ).not.toMatch(/leitura da base falhou|nada abaixo foi estimado/i);
    expect(
      aviso.textContent,
      'o alerta não diz que o cálculo deu certo e só a gravação falhou',
    ).toMatch(/n[ãa]o (foi poss[íi]vel )?(pud|p[ôo]d)e(ram)? ser salv|n[ãa]o (foram|foi) salv/i);
    // Pré-condição: o cenário PRECISA ter produzido bundle, senão o teste passa por vacuidade.
    await waitFor(() => { expect(screen.getByText('Cliente c7')).toBeTruthy(); });
  });

  it('CONTRAPROVA: quando a LEITURA falha mesmo, o alerta continua acusando a leitura', async () => {
    // O conserto acima não pode virar o defeito oposto — a falha de transporte real precisa
    // seguir dizendo que nada abaixo foi estimado.
    falharLeitura = true;

    render(<FarmerBundles />);
    calcular();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'a falha de leitura deixou de ser anunciada').toMatch(
      /leitura da base falhou|n[ãa]o foi poss[íi]vel calcular/i,
    );
  });

  it('separa "calculei e não há bundle" de "clique em Calcular"', async () => {
    semBundles = true;

    render(<FarmerBundles />);
    calcular();

    // O cálculo roda inteiro e conclui, honestamente, que não há bundle nesta carteira.
    // Esperar pelo texto NOVO (e não pela ausência do velho): enquanto o cálculo corre a
    // tela mostra o skeleton, e ali o texto antigo também está ausente — um `waitFor` sobre
    // a ausência passaria por vacuidade antes de o resultado existir.
    expect(
      await screen.findByText(/nenhum bundle|não (há|encontr)/i),
      'a tela não diz que o cálculo rodou e não achou bundle',
    ).toBeTruthy();
    expect(
      screen.queryByText(/Clique em "Calcular"/i),
      'um cálculo concluído foi apresentado como "ainda não comecei"',
    ).toBeNull();
    // E não pode virar alarme: não houve falha nenhuma.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('CONTRAPROVA: antes do primeiro cálculo a tela continua dizendo "Clique em Calcular"', async () => {
    // O defeito oposto — anunciar "não há bundle para esta carteira" para quem nunca calculou
    // é a mesma mentira ao contrário.
    render(<FarmerBundles />);

    expect(screen.getByText(/Clique em "Calcular"/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
