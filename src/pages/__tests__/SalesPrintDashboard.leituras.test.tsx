// Revisão /sales, leva 3 A2 — /sales/print:
//   L2-c  parcela chaveada POR CONTA (a lista da Colacor não sobrescreve a da Oben);
//   L2-d  leitura que FALHA aparece na tela (nunca "Nenhum pedido encontrado" / "Cliente" calados);
//   #36   leituras `.in('user_id', …)` em LOTES — dia cheio não estoura a URL do PostgREST.
// É o teste que prova o 4→0 da baseline do gate `erro-colapsado-em-vazio` como CONSERTO: cada erro
// que o detector deixou de ver aqui é renderizado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  type Resp = { data: unknown; error: unknown };
  const estado = {
    respostas: {} as Record<string, Resp>,
    formas: {} as Record<string, unknown>,
    payloads: [] as Array<{ id: string; omie_payload: unknown }>,
    inChamadas: {} as Record<string, unknown[][]>,
    contato: new Map<string, unknown>(),
    /** Quantas leituras de contato passam antes de falhar (Infinity = nunca falha). */
    contatoOkAte: Infinity,
    contatoLidas: 0,
    consultarCliente: { data: null, error: null } as Resp,
  };
  const builder = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'gte', 'lte', 'not', 'is', 'order', 'neq', 'eq']) b[m] = () => b;
    b.in = (_col: string, ids: unknown[]) => {
      (estado.inChamadas[tabela] ??= []).push(ids);
      return b;
    };
    b.then = (ok: (r: Resp) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(estado.respostas[tabela] ?? { data: [], error: null }).then(ok, ko);
    return b;
  };
  return { estado, builder };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/sales/print/buscarDescontosItens', () => ({ buscarDescontosItens: vi.fn(async () => new Map()) }));
vi.mock('@/lib/contato-cliente', () => ({
  lerContatoOperacional: vi.fn(async () => {
    h.estado.contatoLidas++;
    if (h.estado.contatoLidas > h.estado.contatoOkAte) throw new Error('contato 503');
    return h.estado.contato;
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => h.builder(t),
    rpc: vi.fn(async () => ({ data: h.estado.payloads, error: null })),
    functions: {
      invoke: vi.fn(async (_nome: string, opts: { body: { action: string; account?: string } }) => {
        if (opts.body.action === 'listar_formas_pagamento') return { data: h.estado.formas[opts.body.account ?? ''] ?? { formas: [] }, error: null };
        if (opts.body.action === 'buscar_logos_empresas') return { data: { logos: {} }, error: null };
        if (opts.body.action === 'consultar_cliente') return h.estado.consultarCliente;
        return { data: null, error: null };
      }),
    },
  },
}));

import SalesPrintDashboard from '../SalesPrintDashboard';
import { comQueryClient } from '@/test/query-client';
// O cupom é de OUTRO módulo (fronteiras.gate): nem import nem vi.mock dele — o teste lê o HTML que o cupom
// REAL escreve na janela de impressão, que é o que vai ao papel.
const vias: string[] = [];
const ultimaVia = () => vias.at(-1) ?? '';
const prazo = (texto: string) => `<strong>Prazo:</strong> ${texto}</div>`;
import { toast } from 'sonner';

const agora = () => new Date().toISOString();
const ITENS = [{ omie_codigo_produto: 1, codigo: 'C1', descricao: 'Lixa', unidade: 'UN', quantidade: 1, valor_unitario: 10, valor_total: 10 }];

function pedido(id: string, account: string, numero: string, cliente: string) {
  return {
    id, customer_user_id: cliente, account, omie_numero_pedido: numero, created_at: agora(), items: ITENS,
    subtotal: 10, total: 10, discount: null, notes: null, status: 'pendente', order_date_kpi: null,
  };
}

function contatoDe(cliente: string) {
  return {
    customer_user_id: cliente, document: '123', phone: '11',
    enderecos: [{ street: 'Rua A', number: '1', complement: null, neighborhood: 'B', city: 'C', state: 'SP', zip_code: '0' }],
  };
}

function cenario(pedidos: ReturnType<typeof pedido>[]) {
  h.estado.respostas = {
    sales_orders: { data: pedidos, error: null },
    orders: { data: [], error: null },
    profiles: { data: pedidos.map((p) => ({ user_id: p.customer_user_id, name: `Nome ${p.customer_user_id}` })), error: null },
  };
  h.estado.contato = new Map(pedidos.map((p) => [p.id, contatoDe(p.customer_user_id)]));
}

const renderizar = () => render(<SalesPrintDashboard />, { wrapper: comQueryClient() });

function imprimirUm(numero: string) {
  const linha = screen.getByText(`#${numero}`).closest('[class*="cursor-pointer"]') as HTMLElement;
  fireEvent.click(within(linha).getByRole('button'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vias.length = 0;
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: (html: string) => { vias.push(html); }, close: () => {} } }) as never);
  h.estado.formas = {};
  h.estado.payloads = [];
  h.estado.inChamadas = {};
  h.estado.contatoOkAte = Infinity;
  h.estado.contatoLidas = 0;
  h.estado.consultarCliente = { data: null, error: null };
});

describe('SalesPrintDashboard — L2-d: a leitura que falha aparece', () => {
  it('controle: tudo lido → a folha lista o pedido com o nome, sem aviso de leitura', async () => {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    renderizar();
    expect(await screen.findByText('Nome c1')).toBeTruthy();
    expect(screen.queryByTestId('leitura-do-dia-falhou')).toBeNull();
    expect(screen.queryAllByRole('alert').filter((a) => a.dataset.testid?.startsWith('aviso-leitura'))).toEqual([]);
  });

  it('pedidos de venda que não leram → aviso de falha, nunca "Nenhum pedido encontrado"', async () => {
    cenario([]);
    h.estado.respostas.sales_orders = { data: null, error: { message: 'statement timeout', code: '57014' } };
    renderizar();
    const alerta = await screen.findByTestId('leitura-do-dia-falhou');
    expect(alerta.textContent).toContain('pedidos de venda');
    expect(screen.queryByText(/Nenhum pedido encontrado/)).toBeNull();
  });

  it('OS de afiação que não leram → aviso próprio', async () => {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    h.estado.respostas.orders = { data: null, error: { message: 'boom' } };
    renderizar();
    expect((await screen.findByTestId('leitura-do-dia-falhou')).textContent).toContain('afiação');
  });

  it('nomes (profiles) que não leram → aviso, e a impressão NÃO sai com "Cliente"', async () => {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    h.estado.respostas.profiles = { data: null, error: { message: 'boom' } };
    renderizar();
    expect(await screen.findByTestId('aviso-leitura-nomes')).toBeTruthy();
    imprimirUm('1001');
    expect(vias).toHaveLength(0);
    expect(toast.error).toHaveBeenCalled();
  });

  it('contato operacional que não leu → aviso, e a impressão espera', async () => {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    // A 1ª leitura (dentro da query de pedidos) passa; a da query de contato por cliente falha.
    h.estado.contatoOkAte = 1;
    renderizar();
    expect(await screen.findByTestId('aviso-leitura-contato')).toBeTruthy();
    imprimirUm('1001');
    expect(vias).toHaveLength(0);
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('SalesPrintDashboard — P3-1: impressão espera a leitura do nome', () => {
  it('nomes ainda lendo → a via NÃO sai com "Cliente"; quando chegam, imprime com o nome', async () => {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    let liberar: () => void = () => {};
    const nomes = h.estado.respostas.profiles;
    const segura = new Promise<void>((r) => { liberar = r; });
    // Builder de `profiles` só resolve quando o teste libera.
    const original = h.builder;
    h.builder = ((t: string) => {
      const b = original(t) as Record<string, unknown>;
      if (t === 'profiles') {
        b.then = (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => segura.then(() => nomes).then(ok, ko);
      }
      return b;
    }) as typeof h.builder;
    try {
      renderizar();
      await screen.findByText('#1001');
      imprimirUm('1001');
      expect(vias).toHaveLength(0);
      expect(toast.error).toHaveBeenCalled();
      liberar();
      await screen.findByText('Nome c1');
      imprimirUm('1001');
      expect(ultimaVia()).toContain('Nome c1');
    } finally {
      h.builder = original;
    }
  });
});

describe('SalesPrintDashboard — L2-d: endereço do Omie', () => {
  function semEnderecoLocal() {
    cenario([pedido('p1', 'oben', '1001', 'c1')]);
    h.estado.contato = new Map([['p1', { ...contatoDe('c1'), enderecos: [] }]]);
    h.estado.respostas.omie_customer_account_map_fresco = { data: [{ user_id: 'c1', omie_codigo_cliente: 55 }], error: null };
  }

  it('controle: endereço do Omie lido → sem aviso', async () => {
    semEnderecoLocal();
    h.estado.consultarCliente = { data: { cliente: { endereco: 'Rua Omie', cidade: 'X', estado: 'SP' } }, error: null };
    renderizar();
    await screen.findByText('Nome c1');
    await waitFor(() => expect(h.estado.inChamadas.omie_customer_account_map_fresco?.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('aviso-leitura-enderecos')).toBeNull();
  });

  it('consulta do endereço que falhou → aviso contado, não "sem endereço" calado', async () => {
    semEnderecoLocal();
    h.estado.consultarCliente = { data: null, error: { message: 'edge 503' } };
    renderizar();
    expect((await screen.findByTestId('aviso-leitura-enderecos')).textContent).toContain('1 endereço do Omie não carregou');
  });

  it('códigos Omie que não leram → aviso próprio', async () => {
    semEnderecoLocal();
    h.estado.respostas.omie_customer_account_map_fresco = { data: null, error: { message: 'boom' } };
    renderizar();
    expect(await screen.findByTestId('aviso-leitura-codigos')).toBeTruthy();
  });
});

describe('SalesPrintDashboard — L2-c: parcela por conta', () => {
  it('mesmo código nas duas empresas → cada via com a descrição da SUA conta', async () => {
    cenario([pedido('po', 'oben', '1001', 'c1'), pedido('pc', 'colacor', '2002', 'c2')]);
    h.estado.payloads = [
      { id: 'po', omie_payload: { cabecalho: { codigo_parcela: '001' } } },
      { id: 'pc', omie_payload: { cabecalho: { codigo_parcela: '001' } } },
    ];
    h.estado.formas = {
      oben: { formas: [{ codigo: '001', descricao: 'À vista' }] },
      colacor: { formas: [{ codigo: '001', descricao: '30 dias' }] },
    };
    renderizar();
    await screen.findByText('Nome c2');
    await waitFor(() => {
      imprimirUm('1001');
      expect(ultimaVia()).toContain(prazo('À vista'));
    });
    imprimirUm('2002');
    expect(ultimaVia()).toContain(prazo('30 dias'));
  });

  it('Colacor degradada → a via da Colacor sai com o CÓDIGO cru, não com a descrição da Oben', async () => {
    cenario([pedido('po', 'oben', '1001', 'c1'), pedido('pc', 'colacor', '2002', 'c2')]);
    h.estado.payloads = [
      { id: 'po', omie_payload: { cabecalho: { codigo_parcela: '001' } } },
      { id: 'pc', omie_payload: { cabecalho: { codigo_parcela: '001' } } },
    ];
    h.estado.formas = {
      oben: { formas: [{ codigo: '001', descricao: 'À vista' }] },
      colacor: { formas: [{ codigo: '001', descricao: 'GENÉRICA' }], degraded: true, source: 'fallback' },
    };
    renderizar();
    await screen.findByText('Nome c2');
    await waitFor(() => {
      imprimirUm('1001');
      expect(ultimaVia()).toContain(prazo('À vista'));
    });
    imprimirUm('2002');
    expect(ultimaVia()).toContain(prazo('001'));
  });
});

describe('SalesPrintDashboard — #36: leituras por cliente em lotes', () => {
  it('150 clientes → profiles e códigos Omie em lotes de no máximo 100', async () => {
    cenario(Array.from({ length: 150 }, (_, i) => pedido(`p${i}`, 'oben', String(3000 + i), `c${i}`)));
    renderizar();
    await screen.findByText('Nome c149');
    const lotes = h.estado.inChamadas.profiles ?? [];
    expect(lotes.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lotes.map((l) => l.length))).toBeLessThanOrEqual(100);
    expect(new Set(lotes.flat()).size).toBe(150);
    const codigos = h.estado.inChamadas.omie_customer_account_map_fresco ?? [];
    expect(codigos.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...codigos.map((l) => l.length))).toBeLessThanOrEqual(100);
  });
});
