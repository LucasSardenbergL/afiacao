import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha de leitura do universo de baixo giro tem de CHEGAR ao painel e ao
 * badge do cockpit.
 *
 * Buraco (classe #1565→#1579→#1697→#2894, consumidores que ficaram de fora): os dois
 * destruturavam `useBaixoGiro()` sem pegar o `error` que o hook JÁ expõe.
 *
 * - `AdminReposicaoBaixoGiro`: sob falha `rows === []` e `kpis` sai todo zerado, então
 *   `<BaixoGiroKpis>` afirmava **R$ 0,00 de capital parado** e **0 itens na cauda** — número de
 *   DINHEIRO fabricado por falha de transporte. É o `Number(null) === 0` do CLAUDE.md numa
 *   camada acima. O irmão da MESMA tela (`excesso.error`) já era lido e declarava a falha; o
 *   baixo giro, não.
 * - `BaixoGiroBadge`: `if (isLoading || kpis.totalItens === 0) return null` — sob falha o atalho
 *   SOME calado do cockpit. O irmão `ForaDoMotorBadge` documenta a decisão oposta no próprio
 *   arquivo ("se o sensor falhar, ele DIZ que não conseguiu consultar em vez de sumir — sumir
 *   calado é exatamente o defeito que ele vigia").
 *
 * Contrato (§7 do money-path.md): falha → retry → último dado bom + aviso de stale; sem cache
 * → "indisponível" com o motivo. Nunca zero fabricado.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→`somarCapitalParado`→KPI é
 * o que precisa ser honesta.
 */

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharBaixoGiro = false;
let universoVazio = false;

const PARAMS = [{
  sku_codigo_omie: 101, sku_descricao: 'VERNIZ CAUDA LONGA', fornecedor_nome: 'SAYERLACK',
  classe_consolidada: 'C', demanda_media_diaria: 0.01, valor_vendido_90d: 0,
  estoque_minimo: null, ponto_pedido: null, estoque_maximo: null,
  habilitado_reposicao_automatica: false, tipo_reposicao: 'automatica',
  parametro_cold_start: false,
}];
const POSICAO = [{ omie_codigo_produto: 101, saldo: 10, cmc: 5 }];
const ULTIMA_VENDA = [{ sku_codigo_omie: 101, ultima_venda_data: '2026-01-10', vendas_registradas: 3 }];

/**
 * `sku_parametros` é lido pelos DOIS hooks da tela e só o encadeamento os separa: o universo de
 * baixo giro usa `.or(BAIXO_GIRO_OR_FILTER)`, o de excesso usa `.not('estoque_maximo', ...)`.
 * Discriminar aqui mantém a falha isolada no hook sob teste (o `excesso.error`, que a tela já
 * lia antes deste PR, não entra no caminho e não polui a asserção).
 */
function resposta(table: string, chamadas: Set<string>): unknown {
  if (table === 'sku_parametros') {
    if (!chamadas.has('or')) return { data: [], error: null }; // universo do excesso: vazio
    if (falharBaixoGiro) return { data: null, error: ERRO_TIMEOUT };
    return { data: universoVazio ? [] : PARAMS, error: null };
  }
  if (table === 'inventory_position') return { data: POSICAO, error: null };
  if (table === 'v_sku_ultima_venda') return { data: ULTIMA_VENDA, error: null };
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const chamadas = new Set<string>();
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => { chamadas.add(m); return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table, chamadas));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t) },
}));
// `user` nasce DENTRO da factory: `vi.mock` é içado, então um const de fora cairia na TDZ. E
// precisa ser o MESMO objeto entre renders — identidade nova a cada chamada já custou um teste
// que TRAVAVA em loop de render (lição do #1697).
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'staff-1' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false }) };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import AdminReposicaoBaixoGiro from '../AdminReposicaoBaixoGiro';
import { BaixoGiroBadge } from '@/components/reposicao/BaixoGiroBadge';

const montar = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(arvore()) };
};

beforeEach(() => {
  falharBaixoGiro = false;
  universoVazio = false;
  vi.clearAllMocks();
});

describe('AdminReposicaoBaixoGiro — capital parado não nasce de leitura falha', () => {
  it('DETECTOR: o caminho feliz mostra o KPI de capital e a linha lida', async () => {
    montar(<AdminReposicaoBaixoGiro />);

    expect(await screen.findByText('VERNIZ CAUDA LONGA')).toBeTruthy();
    expect(screen.getByText('Capital parado na cauda')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sob falha SEM dado: nenhum KPI de dinheiro, alerta com motivo e retry', async () => {
    falharBaixoGiro = true;

    montar(<AdminReposicaoBaixoGiro />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(
      /não foi possível|não consegui|indispon/i,
    );
    expect(
      screen.queryByText('Capital parado na cauda'),
      'afirmou R$ 0,00 de capital parado sobre um universo que NÃO foi lido',
    ).toBeNull();
    expect(
      screen.queryByText('Itens na cauda'),
      'afirmou 0 itens na cauda sobre um universo que NÃO foi lido',
    ).toBeNull();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → KPIs aparecem', async () => {
    falharBaixoGiro = true;

    montar(<AdminReposicaoBaixoGiro />);
    await screen.findByRole('alert');

    falharBaixoGiro = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('VERNIZ CAUDA LONGA')).toBeTruthy();
    expect(screen.getByText('Capital parado na cauda')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('último dado bom + aviso de stale quando a releitura falha', async () => {
    const { qc } = montar(<AdminReposicaoBaixoGiro />);
    await screen.findByText('VERNIZ CAUDA LONGA');

    falharBaixoGiro = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ['reposicao-baixo-giro'] }); });

    expect(
      screen.getByText('VERNIZ CAUDA LONGA'),
      'descartou o último dado bom em vez de mantê-lo com aviso',
    ).toBeTruthy();
    expect(screen.getByText('Capital parado na cauda')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(/desatualizad|última leitura/i);
  });
});

describe('BaixoGiroBadge — sumir calado é o defeito que ele vigia', () => {
  it('DETECTOR: o caminho feliz mostra o pulso do capital parado', async () => {
    montar(<BaixoGiroBadge />);

    expect(await screen.findByText(/1 item/)).toBeTruthy();
  });

  it('DETECTOR: universo legitimamente VAZIO (sem erro) continua sumindo', async () => {
    // O par que impede "conserta sumindo nunca": zero LIDO é zero de verdade, e o atalho não
    // deve poluir o cockpit. Sem este teste, um fix que renderizasse sempre passaria no de erro.
    universoVazio = true;

    const { container } = montar(<BaixoGiroBadge />);

    await waitFor(() => { expect(container.querySelector('button')).toBeNull(); });
  });

  it('sob falha: DIZ que não conseguiu consultar em vez de sumir', async () => {
    falharBaixoGiro = true;

    montar(<BaixoGiroBadge />);

    const botao = await screen.findByRole('button');
    expect(
      botao.textContent,
      'o badge sumiu calado: o cockpit perde o atalho sem ninguém saber que a leitura falhou',
    ).toMatch(/não consegui consultar/i);
  });
});
