import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { criarRegistroStub, criarSupabaseStub, type RegistroStub, type UniversoGolden } from '@/test/universo-pedidos-golden';

/**
 * A leitura compartilhada do universo de pedidos (plano v4, lote 16 — C4′): keyset particionado,
 * faixas em paralelo, react-query. O golden de cada motor prova "mesmo dado ⇒ mesmo score"; ESTE
 * arquivo prova o "mesmo dado": a leitura nova devolve EXATAMENTE o array da antiga (conteúdo e
 * ordem), falha de qualquer página rejeita a leitura inteira, e o cache se comporta como o
 * contrato diz (frescor de quem publica, chave por usuário real, offline vira erro).
 */

const estado = vi.hoisted(() => ({
  supabase: null as null | { from: (t: string) => unknown; rpc: (n: string, a?: Record<string, unknown>) => unknown },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => estado.supabase!.from(t),
    rpc: (n: string, a?: Record<string, unknown>) => estado.supabase!.rpc(n, a),
  },
}));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { supabase } from '@/integrations/supabase/client';
import { ehFalhaDePagina, fetchAllKeyset, fetchAllPages } from '@/lib/postgrest';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import {
  COLUNAS_UNIVERSO_PEDIDOS,
  FAIXAS_DO_ID,
  FRESCOR_UNIVERSO_MS,
  buscarUniversoPedidos,
  lerUniversoPedidos,
} from '@/lib/farmer/universo-pedidos-query';

function prng(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;

/** Corte exato de faixa — a linha que testa o `gte`/`lt` na fronteira. */
const CORTES = FAIXAS_DO_ID.flatMap((f) => (f.de ? [f.de] : []));

/**
 * `n` pedidos com uuid aleatório, mais as linhas que a leitura NÃO pode trazer (cancelado, status
 * nulo, soft-delete). `prefixo` concentra todos os ids numa faixa só (o pior caso de partição).
 */
function universoDe(n: number, { semente = 7, prefixo = '', comCortes = true } = {}): UniversoGolden {
  const r = prng(semente);
  const pedido = (id: string, status: string | null = 'faturado', deleted_at: string | null = null) => ({
    id,
    customer_user_id: `cli-${Math.floor(r() * 50)}`,
    items: [{ omie_codigo_produto: 1000 + Math.floor(r() * 9), quantidade: 1 }],
    total: Math.round(r() * 100000) / 100,
    created_at: '2026-01-01T00:00:00Z',
    order_date_kpi: r() < 0.5 ? '2025-12-31' : null,
    status,
    account: r() < 0.5 ? 'oben' : 'colacor',
    deleted_at,
    subtotal: 1, // coluna fora da união: não pode vazar para o resultado
  });
  const linhas = Array.from({ length: n }, () => pedido(uuid(prefixo + hex(r, 32 - prefixo.length))));
  if (comCortes && n > 0) for (const c of CORTES) linhas.push(pedido(c));
  linhas.push(pedido(uuid(hex(r, 32)), 'cancelado'), pedido(uuid(hex(r, 32)), null), pedido(uuid(hex(r, 32)), 'faturado', '2026-02-01T00:00:00Z'));
  return { tabelas: { sales_orders: linhas }, rpcs: {} };
}

/** A leitura ANTERIOR ao lote, verbatim: offset sequencial com a mesma denylist e a mesma ordem. */
function lerComoAntes() {
  return fetchAllPages(
    (de, ate) =>
      supabase
        .from('sales_orders')
        .select(COLUNAS_UNIVERSO_PEDIDOS)
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(de, ate),
    'sales_orders/teste-antes',
  );
}

let reg: RegistroStub;
let universo: UniversoGolden;
function montar(u: UniversoGolden) {
  universo = u;
  reg = criarRegistroStub();
  estado.supabase = criarSupabaseStub(() => universo, reg);
}

beforeEach(() => montar(universoDe(0)));

describe('lerUniversoPedidos ≡ a leitura sequencial anterior (conteúdo E ordem)', () => {
  for (const n of [0, 1, 999, 1000, 1001, 5999, 8000, 12345]) {
    it(`N=${n}`, async () => {
      montar(universoDe(n, { semente: n + 1 }));
      const antes = await lerComoAntes();
      const depois = await lerUniversoPedidos();
      expect(depois).toEqual(antes);
      // Controle: a comparação não é entre dois vazios nem esconde a fronteira de faixa.
      expect(depois.length).toBe(n === 0 ? 0 : n + CORTES.length);
    });
  }

  it('todos os ids numa faixa só (12.345 linhas: 13 páginas pelo cursor de uma faixa)', async () => {
    montar(universoDe(12345, { prefixo: '3' }));
    const antes = await lerComoAntes();
    expect(await lerUniversoPedidos()).toEqual(antes);
  });

  it('as faixas cobrem o espaço inteiro e são contíguas (sem buraco nem sobreposição)', () => {
    expect(FAIXAS_DO_ID[0].de).toBeNull();
    expect(FAIXAS_DO_ID[FAIXAS_DO_ID.length - 1].ate).toBeNull();
    for (let i = 1; i < FAIXAS_DO_ID.length; i++) expect(FAIXAS_DO_ID[i].de).toBe(FAIXAS_DO_ID[i - 1].ate);
  });

  it('as faixas correm em PARALELO: todas pedem a 1ª página antes de qualquer 2ª', async () => {
    montar(universoDe(12000, { semente: 3 }));
    await lerUniversoPedidos();
    const primeiras = reg.leiturasPedidos.slice(0, FAIXAS_DO_ID.length);
    expect(primeiras.every((l) => l.ate === -1)).toBe(true); // keyset: `.limit`, sem `.range`
    expect(reg.leiturasPedidos.length).toBeGreaterThan(FAIXAS_DO_ID.length);
  });
});

describe('falha de página ⇒ a leitura inteira rejeita (nunca universo parcial)', () => {
  it('erro em CADA leitura possível, uma de cada vez', async () => {
    montar(universoDe(9000, { semente: 11 }));
    await lerUniversoPedidos();
    const total = reg.leiturasPedidos.length;
    expect(total).toBeGreaterThan(FAIXAS_DO_ID.length); // controle: há páginas além da 1ª de cada faixa
    for (let k = 0; k < total; k++) {
      reg.leiturasPedidos.length = 0;
      reg.falharLeituraPedidos = (i) => (i === k ? 'erro' : false);
      const e = await lerUniversoPedidos().then(
        () => null,
        (x: unknown) => x,
      );
      expect(ehFalhaDePagina(e), `leitura ${k} falhou e o universo resolveu`).toBe(true);
      if (ehFalhaDePagina(e)) expect(e.motivo).toBe('pagina_falhou');
    }
  });

  it('`data: null` sem erro é malformada, não fim', async () => {
    montar(universoDe(3000, { semente: 5 }));
    reg.falharLeituraPedidos = (i) => (i === 3 ? 'data_null' : false);
    const e = await lerUniversoPedidos().then(() => null, (x: unknown) => x);
    expect(ehFalhaDePagina(e) && e.motivo).toBe('data_null_sem_error');
  });
});

describe('o servidor tem de honrar o recorte — senão LANÇA, não "segue"', () => {
  it('cursor ignorado (`gt`) ⇒ página repetida é pega como fora de ordem', async () => {
    // Tudo numa faixa só: 3 páginas — o cursor só é usado da 2ª página em diante.
    montar(universoDe(3000, { semente: 9, prefixo: '3' }));
    reg.ignorarEmPedidos = ['gt'];
    await expect(lerUniversoPedidos()).rejects.toThrow('fora da ordem do cursor');
  });

  it('faixa ignorada (`gte`/`lt`) ⇒ linha fora do recorte (seria linha em DOBRO)', async () => {
    montar(universoDe(300, { semente: 9 }));
    reg.ignorarEmPedidos = ['gte', 'lt'];
    await expect(lerUniversoPedidos()).rejects.toThrow('fora do recorte de id');
  });

  it('controle: com o servidor honrando tudo, as mesmas fixtures resolvem', async () => {
    montar(universoDe(3000, { semente: 9, prefixo: '3' }));
    await expect(lerUniversoPedidos()).resolves.toHaveLength(3000 + CORTES.length);
    montar(universoDe(300, { semente: 9 }));
    await expect(lerUniversoPedidos()).resolves.toHaveLength(300 + CORTES.length);
  });
});

describe('escrita concorrente: o cursor não perde nem repete linha que existia', () => {
  /** Insere o menor id possível depois da `aposLeitura`-ésima requisição. */
  function inserirNoMeio(aposLeitura: number) {
    const original = universo;
    const novo = { ...original.tabelas.sales_orders[0], id: '00000000-0000-4000-8000-000000000000' };
    let feito = false;
    estado.supabase = criarSupabaseStub(() => {
      if (!feito && reg.leiturasPedidos.length > aposLeitura) {
        feito = true;
        universo = { ...original, tabelas: { sales_orders: [novo, ...original.tabelas.sales_orders] } };
      }
      return universo;
    }, reg);
  }

  it('offset sequencial (a leitura anterior): o INSERT desloca a página e REPETE uma linha', async () => {
    montar(universoDe(2500, { semente: 21, comCortes: false }));
    inserirNoMeio(1);
    const lidas = await lerComoAntes();
    const ids = lidas.map((l) => l.id);
    // É o controle do caso abaixo: o cenário é real e a leitura por offset o sente.
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('keyset: toda linha pré-existente volta EXATAMENTE uma vez', async () => {
    montar(universoDe(2500, { semente: 21, comCortes: false }));
    const pre = new Set(
      universo.tabelas.sales_orders.filter((l) => l.status === 'faturado' && l.deleted_at === null).map((l) => String(l.id)),
    );
    inserirNoMeio(1);
    const ids = (await lerUniversoPedidos()).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of pre) expect(ids).toContain(id);
  });
});

describe('fetchAllKeyset — o que NÃO é falha de leitura sobe cru', () => {
  it('throw síncrono do builder não recebe a marca', async () => {
    const e = await fetchAllKeyset<{ id: string }>(() => { throw new TypeError('builder quebrou'); }, (l) => l.id, 'x').then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(TypeError);
    expect(ehFalhaDePagina(e)).toBe(false);
  });

  it('rejeição de origem desconhecida não recebe a marca', async () => {
    const e = await fetchAllKeyset<{ id: string }>(() => Promise.reject(new RangeError('sei lá')), (l) => l.id, 'x').then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RangeError);
    expect(ehFalhaDePagina(e)).toBe(false);
  });

  it('linha sem a chave do cursor (select sem `id`) LANÇA', async () => {
    await expect(
      fetchAllKeyset<{ id?: string }>(() => Promise.resolve({ data: [{}], error: null }), (l) => l.id, 'x'),
    ).rejects.toThrow('sem a chave do cursor');
  });
});

describe('buscarUniversoPedidos — o contrato do cache', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    montar(universoDe(2500, { semente: 4 }));
  });
  afterEach(() => {
    qc.clear();
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  const leituras = () => reg.leiturasPedidos.length;

  it('duas chamadas simultâneas compartilham UMA leitura', async () => {
    const [a, b] = await Promise.all([
      buscarUniversoPedidos(qc, 'u1', { fresco: true }),
      buscarUniversoPedidos(qc, 'u1', { fresco: true }),
    ]);
    expect(a).toBe(b);
    const umaLeitura = leituras();
    await lerUniversoPedidos();
    expect(leituras()).toBe(2 * umaLeitura);
  });

  it('quem só EXIBE reusa o cache dentro do frescor; quem PUBLICA relê', async () => {
    await buscarUniversoPedidos(qc, 'u1', { fresco: true });
    const n = leituras();
    await buscarUniversoPedidos(qc, 'u1', { fresco: false });
    expect(leituras()).toBe(n);
    await buscarUniversoPedidos(qc, 'u1', { fresco: true });
    expect(leituras()).toBe(2 * n);
  });

  it('passado o frescor, até quem só exibe relê', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await buscarUniversoPedidos(qc, 'u1', { fresco: false });
    const n = leituras();
    vi.setSystemTime(Date.now() + FRESCOR_UNIVERSO_MS + 1);
    await buscarUniversoPedidos(qc, 'u1', { fresco: false });
    expect(leituras()).toBe(2 * n);
  });

  it('a chave é o usuário REAL: outro usuário não herda o universo de um', async () => {
    await buscarUniversoPedidos(qc, 'u1', { fresco: false });
    const n = leituras();
    await buscarUniversoPedidos(qc, 'u2', { fresco: false });
    expect(leituras()).toBe(2 * n);
  });

  it('falha numa releitura REJEITA — não devolve o cache anterior em silêncio', async () => {
    await buscarUniversoPedidos(qc, 'u1', { fresco: false });
    reg.falharLeituraPedidos = () => 'erro';
    const e = await buscarUniversoPedidos(qc, 'u1', { fresco: true }).then(() => null, (x: unknown) => x);
    expect(ehFalhaDePagina(e)).toBe(true);
  });

  it('sem retry: uma página que falha não vira 3 tentativas', async () => {
    reg.falharLeituraPedidos = () => 'erro';
    await buscarUniversoPedidos(qc, 'u1', { fresco: true }).catch(() => undefined);
    expect(leituras()).toBe(FAIXAS_DO_ID.length);
  });

  it('OFFLINE a busca tenta e REJEITA (o default pausaria para sempre, sem erro)', async () => {
    onlineManager.setOnline(false);
    reg.falharLeituraPedidos = () => 'erro';
    const desfecho = await Promise.race([
      buscarUniversoPedidos(qc, 'u1', { fresco: true }).then(() => 'resolveu', () => 'rejeitou'),
      new Promise((r) => setTimeout(() => r('pendurou'), 1500)),
    ]);
    expect(desfecho).toBe('rejeitou');
  });
});
