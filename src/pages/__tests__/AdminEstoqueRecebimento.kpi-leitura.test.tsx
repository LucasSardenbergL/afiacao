import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * C2 do plano v6 (REC-ZERO): os 4 cards do Recebimento mostravam "0" e "R$ 0,00" quando a
 * leitura FALHAVA — os `queryFn` descartavam `error` (`count ?? 0`, `data ?? []`) e o render
 * fabricava de novo (`?? 0`). Aqui cada card é provado nos TRÊS estados que não podem se
 * confundir: carregando (sem número), erro (— + Indisponível) e zero observado (o 0 é fato).
 *
 * As 4 queries batem na MESMA tabela, então o mock não roteia por tabela: ele reconhece a
 * query pelos filtros que ela aplica (a chave de cada card), para que só UMA falhe por vez —
 * um mock que derruba as 4 juntas aprovaria um fix que só cobre uma.
 */

type Chave = 'pendentes' | 'divergencias' | 'transito' | 'efetivadas';
type Resposta = { data: unknown; error: { message: string } | null; count: number | null };
type Plano = 'erro' | 'pendente' | { count?: number | null; data?: unknown[] };

let plano: Partial<Record<Chave, Plano>> = {};

function chaveDe(chamadas: Array<[string, unknown[]]>): Chave {
  const sel = chamadas.find(([m]) => m === 'select')?.[1][0];
  if (sel === 'valor_total') return 'transito';
  const status = chamadas.filter(([m, a]) => (m === 'eq' || m === 'in') && a[0] === 'status');
  const v = status[0]?.[1][1];
  if (v === 'divergencia') return 'divergencias';
  if (v === 'efetivado') return 'efetivadas';
  return 'pendentes';
}

function builder() {
  const chamadas: Array<[string, unknown[]]> = [];
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'range', 'order']) {
    q[m] = (...args: unknown[]) => {
      chamadas.push([m, args]);
      return q;
    };
  }
  q.then = (ok: (r: Resposta) => unknown, ko?: (e: unknown) => unknown) => {
    const p = plano[chaveDe(chamadas)] ?? { count: 0, data: [] };
    if (p === 'pendente') return new Promise(() => {}); // nunca resolve: o card fica carregando
    const r: Resposta =
      p === 'erro'
        ? { data: null, error: { message: 'permission denied' }, count: null }
        : { data: p.data === undefined ? [] : p.data, error: null, count: p.count === undefined ? 0 : p.count };
    return Promise.resolve(r).then(ok, ko);
  };
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => builder() },
}));
vi.mock('../Recebimento', () => ({ default: () => null }));
vi.mock('../NfeReceipt', () => ({ default: () => null }));

import AdminEstoqueRecebimento from '../AdminEstoqueRecebimento';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/estoque/recebimento']}>
          <AdminEstoqueRecebimento />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

const card = (id: Chave) => screen.getByTestId(`kpi-receb-${id}`);
/** Texto do card sem espaços (o BRL usa NBSP entre "R$" e o número). */
const texto = (id: Chave) => (card(id).textContent ?? '').replace(/\s/g, '');

const CARDS: Array<{ id: Chave; label: string; zero: string; queryKey: string }> = [
  { id: 'pendentes', label: 'NF-esPendentes', zero: '0', queryKey: 'estoque-receb-pendentes' },
  { id: 'divergencias', label: 'Divergências', zero: '0', queryKey: 'estoque-receb-divergencias' },
  { id: 'transito', label: 'ValoremTrânsito', zero: 'R$0,00', queryKey: 'estoque-receb-valor-transito' },
  { id: 'efetivadas', label: 'EfetivadasHoje', zero: '0', queryKey: 'estoque-receb-efetivadas-hoje' },
];

beforeEach(() => {
  plano = {};
});
afterEach(() => {
  onlineManager.setOnline(true);
});

describe.each(CARDS)('card "$label" — carregando, erro e zero observado não se confundem', (c) => {
  it('a query entra em ERRO quando o select falha (antes ela engolia e ficava success com 0)', async () => {
    plano = { [c.id]: 'erro' };
    const { qc } = renderPagina();
    await waitFor(() => {
      const estado = qc.getQueriesData({ queryKey: [c.queryKey] });
      expect(estado.length).toBe(1);
      const q = qc.getQueryState(estado[0][0]);
      expect(q?.status).toBe('error');
      // o erro é o do BANCO, não a guarda genérica de count nulo — a camada do `throw error`
      // ficava redundante (verde sob sabotagem) sem esta asserção
      expect((q?.error as { message?: string } | null)?.message).toBe('permission denied');
    });
  });

  it('ERRO: mostra "—" + Indisponível, nunca o zero; os outros cards seguem lidos', async () => {
    plano = { [c.id]: 'erro' };
    renderPagina();
    await waitFor(() => expect(card(c.id).getAttribute('data-estado')).toBe('erro'));
    expect(texto(c.id)).toBe(`${c.label}—Indisponível`);
    expect(screen.getByTestId('aviso-receb-kpis').getAttribute('data-estado')).toBe('erro');
    for (const outro of CARDS.filter((o) => o.id !== c.id)) {
      await waitFor(() => expect(texto(outro.id)).toBe(`${outro.label}${outro.zero}`));
    }
  });

  it('CARREGANDO: nenhum número (nem o zero do 1º paint), nenhum aviso', async () => {
    plano = { [c.id]: 'pendente' };
    renderPagina();
    // espera os OUTROS terminarem, para provar que só este ficou pendente
    for (const outro of CARDS.filter((o) => o.id !== c.id)) {
      await waitFor(() => expect(texto(outro.id)).toBe(`${outro.label}${outro.zero}`));
    }
    expect(card(c.id).getAttribute('data-estado')).toBe('carregando');
    expect(texto(c.id)).toBe(c.label);
    expect(screen.queryByTestId('aviso-receb-kpis')).toBeNull();
  });

  it('ZERO observado: aí o zero é fato — mostrado, sem aviso', async () => {
    renderPagina();
    await waitFor(() => expect(card(c.id).getAttribute('data-estado')).toBe('pronta'));
    expect(texto(c.id)).toBe(`${c.label}${c.zero}`);
    expect(screen.queryByTestId('aviso-receb-kpis')).toBeNull();
  });
});

describe('Recebimento — casos de borda', () => {
  it('OFFLINE: os cards não afirmam zero e o aviso diz que falta rede', async () => {
    onlineManager.setOnline(false);
    renderPagina();
    const aviso = await screen.findByTestId('aviso-receb-kpis');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    for (const c of CARDS) expect(texto(c.id)).toBe(`${c.label}—Indisponível`);
  });

  it('count nulo SEM erro não vira 0: a contagem que não veio é ausência', async () => {
    plano = { divergencias: { count: null } };
    renderPagina();
    await waitFor(() => expect(card('divergencias').getAttribute('data-estado')).toBe('erro'));
    expect(texto('divergencias')).toBe('Divergências—Indisponível');
  });

  it('valor em trânsito com data nulo SEM erro não vira R$ 0,00', async () => {
    plano = { transito: { data: null as unknown as unknown[] } };
    renderPagina();
    await waitFor(() => expect(card('transito').getAttribute('data-estado')).toBe('erro'));
    expect(texto('transito')).toBe('ValoremTrânsito—Indisponível');
  });

  it('valor em trânsito com NF-e sem valor é PISO ("≥"), não o total afirmado', async () => {
    plano = { transito: { data: [{ valor_total: 100 }, { valor_total: null }, { valor_total: 50.5 }] } };
    renderPagina();
    await waitFor(() => expect(card('transito').getAttribute('data-estado')).toBe('pronta'));
    expect(texto('transito')).toBe('ValoremTrânsito≥R$150,50Somaparcial—1NF-esemvalor');
  });

  it('valor em trânsito com todas as NF-e valoradas: total sem ressalva', async () => {
    plano = { transito: { data: [{ valor_total: 100 }, { valor_total: 50.5 }] } };
    renderPagina();
    await waitFor(() => expect(card('transito').getAttribute('data-estado')).toBe('pronta'));
    expect(texto('transito')).toBe('ValoremTrânsitoR$150,50');
  });

  it('contagem positiva observada aparece como número', async () => {
    plano = { divergencias: { count: 3 } };
    renderPagina();
    await waitFor(() => expect(texto('divergencias')).toBe('Divergências3'));
  });
});
