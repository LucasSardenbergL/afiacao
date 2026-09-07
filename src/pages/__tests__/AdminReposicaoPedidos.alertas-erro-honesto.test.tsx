import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — os dois alertas de PRÉ-DISPARO desta tela não podem sumir quando a
 * leitura falha (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, sítio #2).
 *
 * `const bloqueados = (pedidos ?? []).filter(p => p.status === 'bloqueado_guardrail')` sobre
 * uma query que LANÇA: no erro `pedidos` é `undefined`, `bloqueados` vira `[]` e o
 * `{bloqueados.length > 0 && …}` apaga "N pedido(s) bloqueado(s) por guardrail. Revise antes
 * do disparo." A mesma forma apaga "N SKU(s) abaixo do ponto sem fornecedor — não entram em
 * compra". Nos dois casos a AUSÊNCIA afirma segurança ("nada bloqueado", "nada ficou de fora")
 * a um clique do botão que compra. 80 pedidos expirados sem aprovação em 30d provam a tela em
 * uso; são 3 pessoas no total (2 employee + 1 master) — um alerta perdido é um terço da operação.
 *
 * A PÁGINA roda de verdade — as queries são as do componente; só o supabase é mockado. Mockar
 * as queries provaria apenas que o JSX renderiza um estado que eu mesmo montei, e o defeito mora
 * exatamente na tradução "select falhou" → "data undefined" → "tela idêntica à do ciclo limpo".
 */
type Resposta = { data: unknown; error: { message: string } | null };

const ERRO = { message: 'permission denied' };

/** Qual das leituras falha nesta rodada — nomeadas, porque as duas alimentam alertas distintos. */
let falha: 'nenhuma' | 'pedidos' | 'sem-fornecedor' = 'nenhuma';
let pedidosDoCiclo: unknown[] = [];
let skusSemFornecedor: unknown[] = [];

const pedido = (over: Record<string, unknown> = {}) => ({
  id: 1, empresa: 'colacor_sc', data_ciclo: '2026-09-06', fornecedor_nome: 'Sayerlack',
  fornecedor_id: 9, status: 'pendente_aprovacao', valor_total: 1234.5, itens_count: 3,
  status_envio_portal: null, criado_em: '2026-09-06T09:00:00Z', ...over,
});

const sku = (over: Record<string, unknown> = {}) => ({
  sku_codigo_omie: 'ABC-1', sku_descricao: 'Verniz PU', estoque_efetivo: 2, ponto_pedido: 10, ...over,
});

/**
 * As DUAS queries da página leem `pedido_compra_sugerido` (ciclo de hoje e fila cross-ciclo de
 * atenção). O discriminador é o filtro que só o ciclo aplica — `data_ciclo` —, por isso a chain
 * grava as colunas filtradas em vez de responder só pelo nome da tabela: falhar as duas juntas
 * esconderia qual delas o alerta de guardrail realmente consome.
 */
function resposta(tabela: string, colunas: string[]): Resposta {
  if (tabela === 'pedido_compra_sugerido' && colunas.includes('data_ciclo')) {
    return falha === 'pedidos' ? { data: null, error: ERRO } : { data: pedidosDoCiclo, error: null };
  }
  if (tabela === 'v_reposicao_sku_sem_fornecedor') {
    return falha === 'sem-fornecedor'
      ? { data: null, error: ERRO }
      : { data: skusSemFornecedor, error: null };
  }
  return { data: [], error: null };
}

function chain(tabela: string): unknown {
  const colunas: string[] = [];
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) {
    c[m] = (arg?: unknown) => {
      if (typeof arg === 'string') colunas.push(arg);
      return c;
    };
  }
  c.then = (resolve: (v: Resposta) => void) => resolve(resposta(tabela, colunas));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  },
}));
// `user` nasce DENTRO da factory (vi.mock é içado; um const de fora cairia na TDZ) e precisa ser
// o MESMO objeto entre renders — identidade instável em dep de efeito vira loop de render.
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'master-1' };
  return {
    useAuth: () => ({ user, isMaster: true, isGestorComercial: false, isStaff: true, loading: false }),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import AdminReposicaoPedidos from '../AdminReposicaoPedidos';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/reposicao/pedidos']}>
        <AdminReposicaoPedidos />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(ui()) };
}

const ALERTA_GUARDRAIL = /pedido\(s\) bloqueado\(s\) por guardrail/i;
const ALERTA_SEM_FORNECEDOR = /abaixo do ponto sem fornecedor/i;

beforeEach(() => {
  onlineManager.setOnline(true);
  falha = 'nenhuma';
  pedidosDoCiclo = [];
  skusSemFornecedor = [];
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('AdminReposicaoPedidos — o alerta de guardrail não pode sumir na falha de leitura', () => {
  it('leitura OK com pedido bloqueado: o alerta de sempre, sem aviso de leitura', async () => {
    pedidosDoCiclo = [pedido({ status: 'bloqueado_guardrail' })];
    renderPagina();
    expect(await screen.findByText(ALERTA_GUARDRAIL)).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-pedidos')).toBeNull();
  });

  it('leitura OK e ciclo limpo: silêncio — o único silêncio legítimo', async () => {
    pedidosDoCiclo = [pedido({ status: 'pendente_aprovacao' })];
    renderPagina();
    // ESPERA um sinal POSITIVO de que a leitura chegou antes de afirmar o silêncio: sem
    // isso a asserção passa em t=0, quando NENHUMA query resolveu — um teste que não sabe
    // ficar vermelho.
    expect(await screen.findByText(/Sayerlack/)).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-pedidos')).toBeNull();
    expect(screen.queryByText(ALERTA_GUARDRAIL)).toBeNull();
  });

  it('ERRO de leitura: a tela FALA — este é o defeito da classe', async () => {
    falha = 'pedidos';
    renderPagina();
    const aviso = await screen.findByTestId('aviso-leitura-pedidos');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // e não inventa o alerta: não sabemos se há bloqueado
    expect(screen.queryByText(ALERTA_GUARDRAIL)).toBeNull();
  });

  it('OFFLINE (pending + paused): também fala — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    pedidosDoCiclo = [pedido({ status: 'bloqueado_guardrail' })];
    renderPagina();
    const aviso = await screen.findByTestId('aviso-leitura-pedidos');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });

  it('erro e ciclo-limpo NÃO produzem a mesma tela (o colapso, medido)', async () => {
    pedidosDoCiclo = [pedido({ status: 'pendente_aprovacao' })];
    const limpo = renderPagina();
    await waitFor(() => expect(limpo.container.textContent).toContain('Sayerlack'));
    const telaLimpa = limpo.container.textContent ?? '';
    limpo.unmount();

    falha = 'pedidos';
    const erro = renderPagina();
    await erro.findByTestId('aviso-leitura-pedidos');
    expect(erro.container.textContent).not.toBe(telaLimpa);
  });

  it('refetch falho COM ciclo no cache: a lista fica e o alerta continua — com aviso de velho', async () => {
    pedidosDoCiclo = [pedido({ status: 'bloqueado_guardrail' })];
    const { qc } = renderPagina();
    expect(await screen.findByText(ALERTA_GUARDRAIL)).toBeTruthy();

    falha = 'pedidos';
    await qc.refetchQueries({ queryKey: ['pedidos-ciclo'] });

    const aviso = await screen.findByTestId('aviso-leitura-pedidos');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // apagar 4 pedidos vivos do ciclo por causa de um refetch seria trocar um defeito por outro
    expect(screen.getByText(ALERTA_GUARDRAIL)).toBeTruthy();
  });
});

describe('AdminReposicaoPedidos — "nada ficou de fora da compra" também precisa ser lido', () => {
  it('leitura OK com SKU sem fornecedor: o alerta de sempre, sem aviso', async () => {
    skusSemFornecedor = [sku(), sku({ sku_codigo_omie: 'ABC-2' })];
    renderPagina();
    expect(await screen.findByText(ALERTA_SEM_FORNECEDOR)).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-sem-fornecedor')).toBeNull();
  });

  it('ERRO na view: fala com âncora PRÓPRIA — o aviso dos pedidos não cobre este', async () => {
    falha = 'sem-fornecedor';
    renderPagina();
    const aviso = await screen.findByTestId('aviso-leitura-sem-fornecedor');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText(ALERTA_SEM_FORNECEDOR)).toBeNull();
    // âncora separada: a leitura dos PEDIDOS foi bem, e o guard de uma não pode passar
    // verde pelo aviso da outra (docs do AvisoLeituraFalhou)
    expect(screen.queryByTestId('aviso-leitura-pedidos')).toBeNull();
  });

  it('OFFLINE: a view sem fornecedor também fala', async () => {
    onlineManager.setOnline(false);
    skusSemFornecedor = [sku()];
    renderPagina();
    const aviso = await screen.findByTestId('aviso-leitura-sem-fornecedor');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });
});
