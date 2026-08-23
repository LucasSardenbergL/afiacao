import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — o painel onde a cobertura é CRIADA não pode afirmar "não há" sem ler.
 *
 * Ele fazia `const { data: coverages = [] } = useCoverageList()` sem tocar em `error`. Como
 * o hook lança quando o SELECT falha, o default `[]` do destructuring atendia o erro e o
 * vazio com a MESMA frase: "Nenhuma cobertura ativa." Nesta tela isso é caro em dobro —
 * é aqui que o gestor decide CADASTRAR: afirmar vazio o convida a recriar uma cobertura
 * que talvez já exista, e a duplicata nasce de uma leitura que nunca aconteceu.
 *
 * O HOOK roda de verdade; só o supabase é mockado, e por tabela.
 */
const EU = 'gestor-1';
type Resposta = { data: unknown; error: { message: string } | null };
let porTabela: Record<string, Resposta> = {};

function respostaDaTabela(t: string): Resposta {
  return porTabela[t] ?? { data: [], error: null };
}

vi.mock('@/integrations/supabase/client', () => {
  const mk = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range']) b[m] = () => b;
    b.then = (ok: (r: Resposta) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(respostaDaTabela(tabela)).then(ok, falha);
    return b;
  };
  return { supabase: { from: (t: string) => mk(t) } };
});
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: EU }, isStaff: true, isMaster: true, loading: false }),
}));

import { CoveragePanel } from '../CoveragePanel';

const COBERTURA = {
  id: 'cov-1', covering_user_id: 'tati-1', covered_user_id: 'regina-1',
  valid_from: '2026-08-01T00:00:00Z', valid_until: null, active: true,
  created_at: '2026-08-01T00:00:00Z',
};
const VENDEDORES = [{ user_id: 'tati-1', commercial_role: 'farmer' }];

function renderPainel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <CoveragePanel />
    </QueryClientProvider>,
  );
}

const AVISO = /não quer dizer que está tudo certo/i;
const VAZIO = /Nenhuma cobertura ativa/i;

beforeEach(() => { porTabela = {}; onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('CoveragePanel — "não consegui ler" não pode sair como "não há cobertura"', () => {
  it('VAZIO legítimo: a frase de sempre, e nenhum alarme fabricado', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      commercial_roles: { data: VENDEDORES, error: null },
    };
    renderPainel();
    expect(await screen.findByText(VAZIO)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('leitura OK com cobertura: a lista, sem aviso', async () => {
    porTabela = {
      carteira_coverage: { data: [COBERTURA], error: null },
      commercial_roles: { data: VENDEDORES, error: null },
    };
    renderPainel();
    await waitFor(() => expect(screen.queryByText(VAZIO)).toBeNull());
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO nas coberturas: avisa E NÃO afirma vazio — este é o defeito da classe', async () => {
    porTabela = {
      carteira_coverage: { data: null, error: { message: 'permission denied' } },
      commercial_roles: { data: VENDEDORES, error: null },
    };
    renderPainel();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    // A asserção que carrega o peso: as duas frases não podem coexistir nem se substituir.
    expect(screen.queryByText(VAZIO)).toBeNull();
  });

  it('OFFLINE: avisa igual — pending+paused não é lista vazia', async () => {
    onlineManager.setOnline(false);
    porTabela = {
      carteira_coverage: { data: [COBERTURA], error: null },
      commercial_roles: { data: VENDEDORES, error: null },
    };
    renderPainel();
    // Offline pausa AS DUAS queries, então os dois avisos saem — por isso a asserção mira o
    // texto ESPECÍFICO das coberturas em vez da frase comum, que aqui casaria em duplicata.
    expect(await screen.findByText(/as coberturas ativas/)).toBeTruthy();
    expect(screen.queryByText(VAZIO)).toBeNull();
  });

  it('ERRO só na lista de vendedores: avisa do dropdown, sem contaminar as coberturas', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      commercial_roles: { data: null, error: { message: 'permission denied' } },
    };
    renderPainel();
    expect(await screen.findByText(/a lista de vendedores/)).toBeTruthy();
    // a leitura das coberturas foi bem: a frase de vazio continua legítima aqui
    expect(await screen.findByText(VAZIO)).toBeTruthy();
  });
});
