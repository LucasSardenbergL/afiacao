import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha de leitura dos casamentos de catalisador tem de CHEGAR à tela do
 * pedido, porque ela MUDA O PREÇO que o vendedor vê.
 *
 * Buraco (classe #1565→#1579→#1697→#2894): o `useCatalisadorLinksMap` passou a expor o sinal no
 * #1697 e `UnifiedOrder` é o ÚNICO consumidor — e era o único que não o lia
 * (`const { byKey: catalisadorByKey } = useCatalisadorLinksMap()`).
 *
 * O dano não é um número errado, é um número AUSENTE sem explicação: sob falha o mapa sai vazio,
 * `montarSelosVendaAssistida` monta `catalisadorEmbalagens: []`, `resolverOpcaoVenda` devolve
 * preço incompleto e TODO produto com catalisador degrada para **"Sob consulta"**. O fallback
 * vazio é o certo (nunca inventar vínculo — está escrito no próprio hook), mas sem declaração
 * o vendedor não distingue "este produto não tem casamento confirmado" de "não consegui ler os
 * casamentos" — e as duas pedem ações OPOSTAS: a primeira é pedir o casamento ao master, a
 * segunda é esperar/recarregar. Na dúvida ele cota "sob consulta" um item que TEM preço.
 *
 * Contrato (§7 do money-path.md): a degradação pode ser silenciosa no VALOR, nunca na TELA.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→mapa→selo é o que precisa
 * ser honesta.
 */

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharCatalisador = false;
let semCasamentoConfirmado = false;

const LINKS = [{ catalisador_codigo_norm: 'XYZ123', account: 'oben', omie_codigo_produto: 7001 }];

function resposta(table: string): unknown {
  if (table === 'kb_catalisador_links') {
    if (falharCatalisador) return { data: null, error: ERRO_TIMEOUT };
    return { data: semCasamentoConfirmado ? [] : LINKS, error: null };
  }
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete', 'overlaps', 'textSearch',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: [], error: null }),
    channel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = () => ch;
      return ch;
    },
    removeChannel: () => undefined,
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    auth: { getSession: () => Promise.resolve({ data: { session: null }, error: null }) },
  },
}));
// `user` nasce DENTRO da factory (`vi.mock` é içado ⇒ const de fora cai na TDZ) e precisa ser o
// MESMO objeto entre renders — identidade nova a cada chamada trava o teste em loop de render.
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'vendedor-1' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false, role: 'employee' }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'vendedor-1' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import UnifiedOrder from '../UnifiedOrder';

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/pedido']}>
        <UnifiedOrder />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(arvore()) };
};

const aviso = () => screen.queryByTestId('aviso-catalisador');

beforeEach(() => {
  falharCatalisador = false;
  semCasamentoConfirmado = false;
  vi.clearAllMocks();
});

describe('UnifiedOrder — a falha dos casamentos de catalisador é declarada', () => {
  it('DETECTOR: leitura boa não inventa aviso', async () => {
    montar();

    // A tela precisa ter montado de verdade antes de afirmar a ausência (senão o teste passa
    // por não ter renderizado nada — ausência por vacuidade).
    expect(await screen.findByRole('heading', { name: 'Novo Pedido' })).toBeTruthy();
    expect(aviso()).toBeNull();
  });

  it('DETECTOR: ZERO casamento confirmado (leitura OK) também não avisa', async () => {
    // O par que separa "não há" de "não consegui": com a tabela vazia e leitura BOA o mapa é
    // legitimamente vazio e o selo degrada a "sob consulta" por ausência de casamento — isso
    // NÃO é falha e não pode acender aviso (precisão > recall).
    semCasamentoConfirmado = true;

    montar();

    await screen.findByRole('heading', { name: 'Novo Pedido' });
    expect(aviso()).toBeNull();
  });

  it('sob falha: a tela DIZ que não leu os casamentos', async () => {
    falharCatalisador = true;

    montar();

    const a = await screen.findByTestId('aviso-catalisador');
    expect(a.textContent, 'o aviso não nomeia o que não foi lido').toMatch(/catalisador/i);
    expect(
      a.textContent,
      'o aviso não diz que a leitura falhou — "sob consulta" segue indistinguível de "sem casamento"',
    ).toMatch(/não foi possível|não consegui|sem conexão/i);
  });

  it('a leitura boa que volta apaga o aviso', async () => {
    falharCatalisador = true;

    const { qc } = montar();
    await screen.findByTestId('aviso-catalisador');

    falharCatalisador = false;
    await qc.refetchQueries({ queryKey: ['kb-catalisador-map'] });

    await waitFor(() => { expect(aviso()).toBeNull(); });
  });
});
