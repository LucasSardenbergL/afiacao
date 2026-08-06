import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Guard money-path — a falha do engine tem de CHEGAR À TELA.
 *
 * O `useCrossSellEngine` passou a expor `erro`/`desatualizado` (antes a exceção morria num
 * `console.error`). Isso é metade: consertar o hook não conserta a tela. Esta página tem dois
 * lugares onde uma falha vira afirmação sobre o negócio:
 *
 *  - os três KPIs do topo somam sobre `recommendations` → "EIP Total R$ 0,00", "0 Cross-sell";
 *  - o empty state diz "Nenhuma recomendação disponível. Calcule os scores primeiro" — que
 *    manda o vendedor recalcular um cálculo que JÁ rodou e falhou, e afirma "não existe" onde
 *    a verdade é "não consegui ler".
 *
 * E o caso mais silencioso: com resultado de um cálculo ANTERIOR na mão, a tela fica idêntica a
 * um recálculo bem-sucedido. Contrato: sob falha a tela diz o que aconteceu — e distingue
 * "indisponível" (nada na mão) de "desatualizado" (o que está aí é de antes).
 *
 * Aqui o hook roda de VERDADE (só o supabase é mockado): é a cadeia leitura→engine→tela que
 * precisa ser honesta, e mockar o hook provaria apenas que a página sabe renderizar um estado
 * que eu mesmo montei.
 */
const FARMER = 'farmer-real';

let falharScores = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// Mesmo seed mínimo de `cross-sell-escopo-sob-falha.test.tsx`: produz UMA recomendação de
// cross-sell (p2, puxada pela regra de associação p1→p2).
const SCORES = [{
  customer_user_id: 'c1', farmer_id: FARMER,
  health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50,
}];
const PRODUTOS = [
  { id: 'p1', codigo: 'P1', descricao: 'Produto Um', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 10 },
  { id: 'p2', codigo: 'P2', descricao: 'Produto Dois', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 5 },
];
const CUSTOS = [
  { product_id: 'p1', cost_final: 60, cost_price: null },
  { product_id: 'p2', cost_final: 100, cost_price: null },
];
const PEDIDOS = [{
  customer_user_id: 'c1', total: 200, created_at: '2026-07-01T00:00:00Z',
  items: [{ product_id: 'p1', quantity: 2, unit_price: 100 }],
}];
const REGRAS = [{
  antecedent_product_ids: ['p1'], consequent_product_ids: ['p2'],
  confidence: 0.5, lift: 2, support: 0.1,
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', customer_type: 'pj', cnae: null }];

function resposta(table: string): unknown {
  if (table === 'farmer_client_scores') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: SCORES, error: null };
  }
  if (table === 'omie_products') return { data: PRODUTOS, error: null };
  if (table === 'product_costs') return { data: CUSTOS, error: null };
  if (table === 'sales_orders') return { data: PEDIDOS, error: null };
  if (table === 'farmer_association_rules') return { data: REGRAS, error: null };
  if (table === 'profiles') return { data: PERFIS, error: null };
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER }, isStaff: true, loading: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerRecommendations from '../FarmerRecommendations';

beforeEach(() => { falharScores = false; vi.clearAllMocks(); });

/** Texto do card do KPI de topo (o rótulo e o valor são irmãos no mesmo bloco). */
const cardDo = (rotulo: string): string =>
  screen.getByText(rotulo).closest('div')?.parentElement?.textContent ?? '';

describe('FarmerRecommendations — falha do engine não vira "nenhuma recomendação"', () => {
  it('DETECTOR: o caminho feliz renderiza a recomendação e nenhum alerta', async () => {
    // Sem isto, "não achei o alerta" e "a tela nem chegou a montar" seriam indistinguíveis.
    render(<FarmerRecommendations />);

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('anuncia que NÃO CONSEGUIU calcular, em vez de "nenhuma recomendação disponível"', async () => {
    falharScores = true;

    render(<FarmerRecommendations />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(/não foi possível|indispon/i);
    // O empty state de sucesso manda "calcular os scores primeiro" — sob falha isso é um
    // conselho errado sobre um estado que não é o real.
    expect(
      screen.queryByText(/Nenhuma recomendação disponível/i),
      'afirmou "não existe" onde a verdade é "não consegui ler"',
    ).toBeNull();
  });

  it('os KPIs do topo mostram "—", não R$ 0,00 / 0, quando o cálculo falhou sem dado', async () => {
    falharScores = true;

    render(<FarmerRecommendations />);
    await screen.findByRole('alert');

    for (const rotulo of ['EIP Total (estimativa)', 'Cross-sell', 'Up-sell']) {
      const texto = cardDo(rotulo);
      expect(texto, `KPI "${rotulo}" exibiu zero fabricado`).not.toMatch(/R\$\s*0,00|\b0\b/);
      expect(texto, `KPI "${rotulo}" devia mostrar "—"`).toMatch(/—/);
    }
  });

  it('avisa que a lista é de um cálculo ANTERIOR quando o recálculo falha', async () => {
    render(<FarmerRecommendations />);
    await screen.findByText('Cliente Um');

    // Recálculo que perde uma página: hoje a lista se acomoda igualzinho a um sucesso.
    falharScores = true;
    fireEvent.click(screen.getByRole('button', { name: /Recalcular/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'nada avisa que os números são de antes').toMatch(/desatualiz|anterior/i);
    // O último dado bom continua na tela — descartá-lo trocaria uma mentira por outra.
    await waitFor(() => { expect(screen.getByText('Cliente Um')).toBeTruthy(); });
  });
});
