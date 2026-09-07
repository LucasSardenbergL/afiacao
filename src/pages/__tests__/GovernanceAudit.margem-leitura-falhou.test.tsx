import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard — a aba "Margem (Alg. A)" não pode AFIRMAR "Sem registros de auditoria" sobre uma fonte
 * que tem 12.913 linhas (`margin_audit_log`, psql-ro 2026-09-07 — +1.044 em um dia).
 *
 * O `queryFn` fazia `if (error) { console.error(error); return []; }`: a query terminava em
 * `success` com `[]`, o `error` do react-query NUNCA populava, e a tela do erro era byte-a-byte a
 * tela da fonte vazia — só que com uma FRASE afirmando o vazio, e um "0 registros" no cabeçalho
 * afirmando o mesmo com número. Sub-tipo que MENTE
 * (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, sítio #3 da ordem por dano).
 *
 * A PÁGINA roda de verdade — as queries são as do componente, só o supabase é mockado. Mockar a
 * query provaria apenas que o JSX renderiza um estado montado à mão, e o defeito mora exatamente
 * na tradução "select falhou" → "data []" → "tela idêntica à da auditoria vazia".
 *
 * `AuthContext` e `useCommercialRole` são módulo `plataforma` ⇒ mocká-los não cria aresta no
 * `fronteiras.gate.test.ts` (`vi.mock` conta como import: `src/lib/modulos/imports.ts`).
 */
type Resposta = { data: unknown; error: { message: string } | null };

const ERRO = { message: 'permission denied' };

let falhaMargem = false;
let linhasMargem: unknown[] = [];

const linha = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  customer_user_id: 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb',
  margin_real: 1000,
  margin_potential: 1500,
  margin_gap: 500,
  gap_pct: 33.3,
  calculated_at: '2026-09-07T10:00:00Z',
  ...over,
});

function resposta(tabela: string): Resposta {
  if (tabela === 'margin_audit_log') {
    return falhaMargem ? { data: null, error: ERRO } : { data: linhasMargem, error: null };
  }
  // As outras duas abas leem fontes hoje VAZIAS (`permission_change_log` e `farmer_audit_log` =
  // 0 linhas, psql-ro 2026-09-07) — respondem vazio e sem erro para não gatear o `isLoading`
  // que embrulha as Tabs.
  return { data: [], error: null };
}

function chain(tabela: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ]) {
    c[m] = () => c;
  }
  c.then = (resolve: (v: Resposta) => void) => resolve(resposta(tabela));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));
vi.mock('@/hooks/useCommercialRole', () => ({
  useCommercialRole: () => ({ isSuperAdmin: false, canViewStrategic: true }),
}));

import GovernanceAudit from '../GovernanceAudit';

/** A frase do aviso — o que separa "não consegui ler" de "não há auditoria". */
const AVISO = /não quer dizer que está tudo certo/i;
/** A frase que MENTE quando a leitura falhou. */
const FRASE_VAZIO = /Sem registros de auditoria/i;

function novoQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPagina(qc = novoQc()) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GovernanceAudit />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * A aba de margem é a terceira; o `TabsContent` do Radix só monta quando ela está ativa.
 *
 * A âncora é o CABEÇALHO DA TABELA, não o título do card: `/Auditoria de Margem/i` casaria também
 * a copy do próprio `<AvisoLeituraFalhou oque="a auditoria de margem">` — e aí o helper de
 * navegação só quebrava nos testes em que o aviso aparece, que são exatamente os que importam.
 * O `<thead>` fica fora de todo condicional, então serve nos quatro estados.
 */
async function abrirAbaMargem() {
  const tab = await screen.findByRole('tab', { name: /Margem/i });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await screen.findByRole('columnheader', { name: 'M. Real' });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  falhaMargem = false;
  linhasMargem = [];
});
afterEach(() => { onlineManager.setOnline(true); });

describe('GovernanceAudit — auditoria de margem ilegível NÃO pode afirmar "sem registros"', () => {
  it('CONTROLE: leitura boa com registros → a tabela aparece, conta, e NÃO há aviso', async () => {
    linhasMargem = [linha(), linha({ id: 'm2' })];
    renderPagina();
    await abrirAbaMargem();

    expect(await screen.findByText(/2 registros\./)).toBeTruthy();
    expect(screen.queryByText(FRASE_VAZIO)).toBeNull();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('CONTROLE do vazio REAL: leu e não há → a frase é dita, e é VERDADE (sem aviso)', async () => {
    linhasMargem = [];
    renderPagina();
    await abrirAbaMargem();

    expect(await screen.findByText(FRASE_VAZIO)).toBeTruthy();
    expect(screen.getByText(/0 registros\./)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa — e PARA de afirmar "sem registros" e "0 registros"', async () => {
    falhaMargem = true;
    renderPagina();
    await abrirAbaMargem();

    expect(await screen.findByText(AVISO)).toBeTruthy();
    // o defeito da classe, nas duas vozes: a frase e o número
    expect(screen.queryByText(FRASE_VAZIO)).toBeNull();
    expect(screen.queryByText(/0 registros\./)).toBeNull();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    linhasMargem = [linha()];
    renderPagina();
    await abrirAbaMargem();

    const aviso = await screen.findByTestId('aviso-leitura-margem');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(screen.queryByText(FRASE_VAZIO)).toBeNull();
  });

  it('DADO EM CACHE + offline no refetch: avisa SEM apagar os registros (o composto)', async () => {
    const qc = novoQc();
    linhasMargem = [linha()];
    renderPagina(qc);
    await abrirAbaMargem();
    expect(await screen.findByText(/1 registros\./)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();

    onlineManager.setOnline(false);
    void qc.invalidateQueries();

    expect(await screen.findByText(AVISO)).toBeTruthy();
    // e a tabela CONTINUA na tela, com o aviso ao lado
    expect(screen.getByText(/1 registros\./)).toBeTruthy();
  });

  it('erro e vazio real NÃO produzem a mesma tela (o colapso, medido)', async () => {
    linhasMargem = [];
    const vazia = renderPagina();
    await abrirAbaMargem();
    await screen.findByText(FRASE_VAZIO);
    const telaVazia = vazia.container.textContent;
    vazia.unmount();

    falhaMargem = true;
    const erro = renderPagina();
    await abrirAbaMargem();
    await screen.findByText(AVISO);
    expect(erro.container.textContent).not.toBe(telaVazia);
  });
});
