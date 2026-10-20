// Carga escalonada da aba Ciclo (incidente 2026-10-19: ~9 leituras pesadas simultâneas → todas 500 por
// statement_timeout de 8 s). Hooks REAIS + supabase falso que segura cada leitura até o teste soltar: mede o
// pico de leituras em voo e prova que as seções abaixo da dobra só leem quando aparecem na tela.
// Duas faixas (filaCiclo de 2 para RPCs + filaCicloEdge de 1 para a edge): pico total 3, e a edge lenta não segura o topo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Pendente = { nome: string; soltar: () => void };
const EDGE = 'fin-cashflow-engine';
const estado = vi.hoisted(() => ({
  pendentes: [] as Pendente[], chamadas: [] as string[], ativas: 0, pico: 0, ativasEdge: 0, picoEdge: 0, picoRpc: 0,
}));

function leitura(nome: string, resposta: unknown) {
  const edge = nome === EDGE;
  estado.chamadas.push(nome);
  estado.ativas += 1;
  if (edge) estado.ativasEdge += 1;
  estado.pico = Math.max(estado.pico, estado.ativas);
  estado.picoEdge = Math.max(estado.picoEdge, estado.ativasEdge);
  estado.picoRpc = Math.max(estado.picoRpc, estado.ativas - estado.ativasEdge);
  return new Promise((resolve) => {
    estado.pendentes.push({ nome, soltar: () => { estado.ativas -= 1; if (edge) estado.ativasEdge -= 1; resolve(resposta); } });
  });
}

vi.mock('@/integrations/supabase/client', () => {
  const builder = (nome: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'eq', 'gte']) b[m] = () => b;
    b.range = () => leitura(nome, { data: [], error: null });
    return b;
  };
  return {
    supabase: {
      rpc: (nome: string) => builder(nome),
      from: (tabela: string) => builder(tabela),
      functions: { invoke: (nome: string) => leitura(nome, { data: {}, error: null }) },
    },
  };
});
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

type Observado = { cb: IntersectionObserverCallback; el: Element; io: IntersectionObserver };
const observados: Observado[] = [];
class IntersectionObserverFalso {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) { observados.push({ cb: this.cb, el, io: this as unknown as IntersectionObserver }); }
  unobserve() {}
  disconnect() { for (let i = observados.length - 1; i >= 0; i--) if (observados[i].io === (this as unknown)) observados.splice(i, 1); }
  takeRecords() { return []; }
}

import { CicloTab } from '@/components/financeiro/cashflow/ciclo/CicloTab';

const ABAIXO_DA_DOBRA = ['fin_ciclo_cp_titulos', 'fin_ciclo_fornecedor_resumo', 'fin_ciclo_giro_sku'];

async function tick() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

/** Solta as leituras uma a uma (a mais antiga primeiro), dando vez à fila entre cada uma. `filtro` segura as demais. */
async function drenar(filtro: (p: Pendente) => boolean = () => true) {
  await tick();
  for (let i = estado.pendentes.findIndex(filtro); i >= 0; i = estado.pendentes.findIndex(filtro)) {
    const [p] = estado.pendentes.splice(i, 1);
    await act(async () => { p.soltar(); });
    await tick();
  }
}

function conferirTetos() {
  expect(estado.picoEdge).toBe(1);
  expect(estado.picoRpc).toBeLessThanOrEqual(2);
  expect(estado.pico).toBeLessThanOrEqual(3);
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/financeiro/capital-giro?aba=ciclo']}><CicloTab /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CicloTab — carga escalonada', () => {
  beforeEach(() => {
    estado.pendentes = []; estado.chamadas = []; estado.ativas = 0; estado.pico = 0;
    estado.ativasEdge = 0; estado.picoEdge = 0; estado.picoRpc = 0;
    observados.length = 0;
    vi.stubGlobal('IntersectionObserver', IntersectionObserverFalso);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('no mount, edge com 1 vaga e RPCs com 2 (pico 3) — e todas as de cima da dobra rodam', async () => {
    montar();
    await drenar();
    conferirTetos();
    for (const nome of ['fin_ciclo_cliente_resumo', 'fin_ciclo_empresa_coorte', 'fin_ciclo_cp_empresa', EDGE]) {
      expect(estado.chamadas).toContain(nome);
    }
    expect(estado.chamadas.filter((n) => n === EDGE)).toHaveLength(3);
  });

  it('a edge lenta NÃO segura as RPCs do topo (prod 2026-10-19: só começavam em t≈23 s)', async () => {
    montar();
    // A edge nunca responde: as RPCs do topo têm de rodar e terminar mesmo assim.
    await drenar((p) => p.nome !== EDGE);
    for (const nome of ['fin_ciclo_cliente_resumo', 'fin_ciclo_empresa_coorte', 'fin_ciclo_cp_empresa']) {
      expect(estado.chamadas).toContain(nome);
    }
    expect(estado.chamadas.filter((n) => n === EDGE)).toHaveLength(1);
    expect(estado.pendentes.map((p) => p.nome)).toEqual([EDGE]);
    conferirTetos();
    await drenar();
  });

  it('fornecedores e giro de estoque só leem quando a seção aparece na tela', async () => {
    montar();
    await drenar();
    for (const nome of ABAIXO_DA_DOBRA) expect(estado.chamadas).not.toContain(nome);

    await act(async () => {
      for (const o of [...observados]) {
        o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], o.io);
      }
    });
    await drenar();
    for (const nome of ABAIXO_DA_DOBRA) expect(estado.chamadas).toContain(nome);
    conferirTetos();
  });
});
