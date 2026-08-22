import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Guard money-path — a memória local de desfecho vale para UMA geração.
 *
 * Achado P1 do `/codex` adversarial no CÓDIGO (o passo que faltava do ritual do #1851:
 * a cota esgotou na metodologia e o adversarial rodou depois, ver
 * docs/historico/farmer-sensor-desfecho.md).
 *
 * `useFarmerDesfecho` guarda os desfechos da sessão num mapa por CHAVE DE NEGÓCIO
 * (cliente|produto|tipo) — porque o browser não tem o id da linha. Só que "Recalcular"
 * chama `farmer_recomendacoes_substituir`, que EXPIRA as pendentes e insere linhas novas
 * com a mesma chave. Sem invalidar o mapa, o card da geração NOVA:
 *
 *   1. afirma "Venda registrada" sobre uma linha que está `pendente` no banco; e
 *   2. esconde os botões — o desfecho dela fica impossível de registrar e ela morre como
 *      `expirado`, que a query de medição lê como "substituída sem interação".
 *
 * Os dois lados são o mesmo bug e o segundo é o pior: é perda SILENCIOSA do sinal que
 * este sensor existe para produzir. A suíte de componente não pega — nenhum teste dela
 * monta a página nem clica em "Recalcular". É a fiação que precisa ser provada.
 *
 * Aqui o engine roda de VERDADE (só o supabase é mockado): mockar o hook provaria apenas
 * que a página sabe renderizar um estado que eu mesmo montei.
 */
const FARMER = 'farmer-real';

/** Controla a RPC de desfecho: `null` = resolve na hora; função = fica pendente. */
let segurarDesfecho: ((v: unknown) => void) | null = null;
let capturarPendente = false;
const desfechoChamadas: Record<string, unknown>[] = [];

// Mesmo seed mínimo de `FarmerRecommendations.erro-honesto.test.tsx`: produz UMA
// recomendação de cross-sell (p2, puxada pela regra de associação p1→p2).
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
  if (table === 'farmer_client_scores') return { data: SCORES, error: null };
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

/** Derivado de PRODUTOS/CUSTOS para as duas fontes não divergirem (ver erro-honesto). */
function vendaveisDoSeed(): { product_id: string }[] {
  return CUSTOS.filter((c) => {
    const p = PRODUTOS.find((x) => x.id === c.product_id);
    return p != null && c.cost_final != null && p.valor_unitario > c.cost_final;
  }).map((c) => ({ product_id: c.product_id }));
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      const c: Record<string, unknown> = { order: () => c, range: () => c };
      if (nome === 'farmer_recomendacao_registrar_desfecho') {
        desfechoChamadas.push(args ?? {});
        c.then = (resolve: (v: unknown) => void) => {
          if (capturarPendente) { segurarDesfecho = resolve; return; }
          resolve({ data: null, error: null });
        };
        return c;
      }
      const r = nome === 'get_skus_margem_positiva'
        ? { data: vendaveisDoSeed(), error: null }
        : { data: null, error: null };
      c.then = (resolve: (v: unknown) => void) => resolve(r);
      return c;
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER }, isStaff: true, loading: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerRecommendations from '../FarmerRecommendations';

beforeEach(() => {
  segurarDesfecho = null;
  capturarPendente = false;
  desfechoChamadas.length = 0;
  vi.clearAllMocks();
});

/** Abre o cliente e devolve o botão de aceite do único card de cross-sell do seed. */
async function abrirCardEPegarComprou(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText('Cliente Um'));
  return screen.findByRole('button', { name: 'Cliente comprou' });
}

const recalcular = () => screen.getByRole('button', { name: /Recalcular/i });

describe('FarmerRecommendations — o desfecho memorizado não atravessa a geração', () => {
  it('DETECTOR: o card do seed expõe o botão de desfecho e ele grava', async () => {
    // Sem este teste, "os botões voltaram" e "a tela nunca renderizou botão nenhum"
    // seriam indistinguíveis — todos os asserts abaixo passariam num componente vazio.
    render(<FarmerRecommendations />);

    fireEvent.click(await abrirCardEPegarComprou());

    await waitFor(() => expect(desfechoChamadas).toHaveLength(1));
    expect(desfechoChamadas[0].p_desfecho).toBe('aceito');
    expect(await screen.findByText('Venda registrada')).toBeTruthy();
  });

  it('após Recalcular, o card NÃO afirma "Venda registrada" sobre a linha nova', async () => {
    render(<FarmerRecommendations />);
    fireEvent.click(await abrirCardEPegarComprou());
    await screen.findByText('Venda registrada');

    // A substituição trocou as linhas: o desfecho ficou na geração ANTERIOR e a chave de
    // negócio agora aponta para uma linha `pendente` que ninguém registrou.
    fireEvent.click(recalcular());

    // Espera o card da geração NOVA existir ANTES de afirmar a ausência. Sem esta
    // âncora o assert era teatro, e a falsificação provou: `waitFor(queryByText → null)`
    // passa no primeiro poll em que o texto some, e a lista some sozinha enquanto
    // remonta — o teste ficava VERDE com a sabotagem aplicada, por um motivo que não é
    // o que o nome promete. Ausência só é evidência medida sobre algo que está lá.
    await screen.findByRole('button', { name: 'Cliente comprou' });
    expect(
      screen.queryByText('Venda registrada'),
      'o card afirmou um desfecho que a linha nova não tem',
    ).toBeNull();
  });

  it('após Recalcular, os botões VOLTAM — senão o sinal da geração nova se perde', async () => {
    // O lado silencioso do mesmo bug, e o pior: sem botão a vendedora não tem como
    // registrar o desfecho da recomendação nova, e ela morre como `expirado`, que a query
    // de medição lê como "substituída sem interação". Zero indistinguível de zero real.
    render(<FarmerRecommendations />);
    fireEvent.click(await abrirCardEPegarComprou());
    await screen.findByText('Venda registrada');

    fireEvent.click(recalcular());

    const comprou = await screen.findByRole('button', { name: 'Cliente comprou' });
    expect(comprou).toBeInTheDocument();
    // E o botão de volta grava DE VERDADE: um botão inerte seria o mesmo bug com outra cara.
    fireEvent.click(comprou);
    await waitFor(() => expect(desfechoChamadas).toHaveLength(2));
  });

  it('Recalcular fica TRAVADO enquanto uma gravação está em voo', async () => {
    // Sem a trava, a substituição corre contra a RPC de desfecho pela mesma chave: se a
    // substituição vencer, o aceite cai na geração NOVA — um cálculo que ela nunca viu.
    // A chave de negócio é a única identidade que o browser tem, então o banco não
    // consegue distinguir; a serialização é do cliente.
    capturarPendente = true;
    render(<FarmerRecommendations />);

    fireEvent.click(await abrirCardEPegarComprou());

    await waitFor(() => expect(recalcular()).toBeDisabled());

    // E DESTRAVA quando a gravação termina — travar para sempre trocaria um bug por outro.
    segurarDesfecho?.({ data: null, error: null });
    await waitFor(() => expect(recalcular()).not.toBeDisabled());
  });
});
