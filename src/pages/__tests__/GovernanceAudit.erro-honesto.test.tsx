import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" — sub-tipo que MENTE.
 *
 * `GovernanceAudit` tem uma aba de auditoria de margem cujo rodapé afirma, com palavras,
 * "Sem registros de auditoria" sempre que `marginLog` está vazio. Como o `queryFn` fazia
 * `if (error) { console.error(error); return []; }`, uma leitura FALHA chegava à tela
 * indistinguível de uma fonte vazia — sobre uma tabela que tem 11.869 linhas em prod
 * (denominador medido em 2026-09-06, docs/historico/a-forma-que-some-e-a-forma-que-mente.md).
 * O `console.error` não é interface: ninguém que decide margem lê o console.
 *
 * O defeito é de CAMADA, e é por isso que esta suíte existe antes de qualquer mexida de UI:
 * enquanto o `queryFn` engolir o erro, `error` do react-query nunca popula e
 * <AvisoLeituraFalhou> é INALCANÇÁVEL por construção. Trocar o `&&` por `estadoDeLeitura`
 * sem consertar o hook seria um diff plausível com zero mudança de comportamento.
 *
 * O HOOK roda de verdade; só o supabase é mockado — mockar a query provaria apenas que a
 * tela renderiza um estado que eu mesmo montei, e o defeito mora exatamente na tradução
 * "SELECT falhou" → "[]" → "tela idêntica à da fonte vazia".
 */

type Resposta = { data: unknown; error: { message: string; code?: string } | null };

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

const LINHA = {
  id: 'm1', customer_user_id: 'c1', margin_real: 1000, margin_potential: 1500,
  margin_gap: 500, gap_pct: 33.3, calculated_at: '2026-09-01T10:00:00Z',
};

let respostaMargem: Resposta = { data: [], error: null };

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'gt', 'not', 'is', 'in', 'range', 'filter']) {
    c[m] = () => c;
  }
  c.then = (resolve: (v: unknown) => void) =>
    resolve(table === 'margin_audit_log' ? respostaMargem : { data: [], error: null });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));
vi.mock('@/hooks/useCommercialRole', () => ({
  useCommercialRole: () => ({ isSuperAdmin: false, canViewStrategic: true }),
}));
vi.mock('@/components/governanca/CanariaPrecoCard', () => ({ CanariaPrecoCard: () => null }));

import GovernanceAudit from '../GovernanceAudit';

/** A frase do aviso — o que separa "não consegui" de "não há". */
const AVISO = /não quer dizer que está tudo certo/i;
/** A afirmação que a tela NÃO pode fazer quando a leitura falhou. */
const AFIRMA_VAZIO = /Sem registros de auditoria/i;

async function renderNaAbaMargem() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <GovernanceAudit />
    </QueryClientProvider>,
  );
  const aba = await screen.findByText(/Margem \(Alg\. A\)/);
  fireEvent.click(aba);
  await screen.findByText(/Auditoria de Margem/);
  return r;
}

beforeEach(() => { onlineManager.setOnline(true); respostaMargem = { data: [], error: null }; });
afterEach(() => { onlineManager.setOnline(true); });

describe('GovernanceAudit — a aba de margem não pode AFIRMAR vazio que não leu', () => {
  it('leitura OK com registros: a tabela mostra as linhas, sem aviso', async () => {
    respostaMargem = { data: [LINHA], error: null };
    await renderNaAbaMargem();
    expect(await screen.findByText(/R\$ 500/)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
    expect(screen.queryByText(AFIRMA_VAZIO)).toBeNull();
  });

  it('fonte VAZIA de verdade: afirma o vazio — o único vazio legítimo', async () => {
    respostaMargem = { data: [], error: null };
    await renderNaAbaMargem();
    expect(await screen.findByText(AFIRMA_VAZIO)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa em vez de afirmar vazio — o defeito da classe', async () => {
    respostaMargem = { data: null, error: ERRO_PG };
    await renderNaAbaMargem();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(screen.queryByText(AFIRMA_VAZIO)).toBeNull();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    respostaMargem = { data: [LINHA], error: null };
    await renderNaAbaMargem();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(screen.queryByText(AFIRMA_VAZIO)).toBeNull();
  });

  it('o CONTADOR não pode dizer "0 registros" quando não conseguiu contar', async () => {
    respostaMargem = { data: null, error: ERRO_PG };
    const { container } = await renderNaAbaMargem();
    await screen.findByText(AVISO);
    expect(container.textContent).not.toMatch(/0 registros/);
  });

  it('erro e fonte-vazia NÃO produzem a mesma tela (o colapso, medido)', async () => {
    respostaMargem = { data: [], error: null };
    const vazio = await renderNaAbaMargem();
    await screen.findByText(AFIRMA_VAZIO);
    const telaVazia = vazio.container.textContent;
    vazio.unmount();

    respostaMargem = { data: null, error: ERRO_PG };
    const erro = await renderNaAbaMargem();
    await screen.findByText(AVISO);
    expect(erro.container.textContent).not.toBe(telaVazia);
  });

  it('o aviso é ANCORADO por testid, não pela copy (guard não casa desenho)', async () => {
    respostaMargem = { data: null, error: ERRO_PG };
    await renderNaAbaMargem();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
  });
});
