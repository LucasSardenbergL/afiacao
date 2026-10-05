import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// "Margem Global" (e Margem Real/Potencial/Gap) somavam as 100 linhas mais recentes de um log que
// ACRESCENTA ~508 por execução — 5–7% da carteira auditada (medido em prod, 2026-10-05). O mock abaixo é
// FIEL ao que importa: filtra `calculated_at` por gte/lte com MICROSSEGUNDOS, ordena, pagina por `range`,
// devolve `count` com `head` e `null` no `maybeSingle` sem linha — sem isso, uma regressão de janela ou de
// paginação passaria verde.

type Linha = {
  id: string;
  customer_user_id: string;
  period_start: string;
  period_end: string;
  margin_real: number | null;
  margin_potential: number | null;
  margin_gap: number | null;
  gap_pct: number | null;
  calculated_at: string;
  created_at: string;
};

let LOG: Linha[] = [];
/** Página (índice) cuja leitura falha — `null` = nenhuma. */
let falharPagina: number | null = null;
/** Chamado a cada contagem (`head`) — o teste usa para gravar no meio da leitura. */
let aoContar: ((n: number) => void) | null = null;
let contagens = 0;
let faixasLidas: Array<[number, number]> = [];
const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

/** Instante em MICROSSEGUNDOS, preservando a fração que o `Date` cortaria. */
function us(iso: string): number {
  const m = iso.match(/^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/);
  if (!m) throw new Error(`instante inválido: ${iso}`);
  return Date.parse(m[1] + (m[3] || 'Z')) * 1000 + Number((m[2] ?? '').padEnd(6, '0').slice(0, 6));
}

function chainLog(): unknown {
  const st = {
    head: false,
    gte: null as string | null,
    lte: null as string | null,
    order: [] as Array<[keyof Linha, boolean]>,
    limit: null as number | null,
    range: null as [number, number] | null,
    single: false,
  };
  const c: Record<string, unknown> = {};
  c.select = (_cols: string, opts?: { head?: boolean }) => ((st.head = !!opts?.head), c);
  c.gte = (col: string, v: string) => ((col === 'calculated_at' ? (st.gte = v) : null), c);
  c.lte = (col: string, v: string) => ((col === 'calculated_at' ? (st.lte = v) : null), c);
  c.order = (col: keyof Linha, o?: { ascending?: boolean }) => (st.order.push([col, o?.ascending !== false]), c);
  c.limit = (n: number) => ((st.limit = n), c);
  c.range = (de: number, ate: number) => ((st.range = [de, ate]), c);
  c.maybeSingle = () => ((st.single = true), c);
  c.then = (resolve: (v: unknown) => void) => {
    let rows = LOG.filter(
      (l) => (st.gte == null || us(l.calculated_at) >= us(st.gte)) && (st.lte == null || us(l.calculated_at) <= us(st.lte)),
    );
    if (st.head) {
      contagens++;
      const n = rows.length;
      aoContar?.(contagens);
      return resolve({ data: null, count: n, error: null });
    }
    for (const [col, asc] of [...st.order].reverse()) {
      rows = [...rows].sort((a, b) => {
        const va = col === 'calculated_at' ? us(a[col]) : String(a[col]);
        const vb = col === 'calculated_at' ? us(b[col]) : String(b[col]);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return asc ? cmp : -cmp;
      });
    }
    if (st.range) {
      faixasLidas.push(st.range);
      if (falharPagina != null && st.range[0] === falharPagina * 1000) return resolve({ data: null, error: ERRO_TIMEOUT });
      rows = rows.slice(st.range[0], st.range[1] + 1);
    }
    if (st.limit != null) rows = rows.slice(0, st.limit);
    if (st.single) return resolve({ data: rows[0] ?? null, error: null });
    return resolve({ data: rows, error: null });
  };
  return c;
}

/** As OUTRAS leituras da aba (scores, pedidos, itens, perfis): vazias e bem-comportadas. */
function chainVazia(): unknown {
  const c: Record<string, unknown> = {};
  let head = false;
  let single = false;
  for (const m of ['eq', 'neq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'filter']) c[m] = () => c;
  c.select = (_c: string, o?: { head?: boolean }) => ((head = !!o?.head), c);
  c.maybeSingle = () => ((single = true), c);
  c.then = (resolve: (v: unknown) => void) =>
    resolve(head ? { data: null, count: 0, error: null } : { data: single ? null : [], error: null });
  return c;
}

let aoRecalcular: (() => void) | null = null;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => (t === 'margin_audit_log' ? chainLog() : chainVazia()),
    functions: {
      invoke: vi.fn(async () => {
        aoRecalcular?.();
        return { data: null, error: null };
      }),
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import {
  agregarExecucao,
  lerUltimaExecucaoAuditoria,
  reconhecerExecucao,
  rodapeExecucao,
  TAMANHO_LOTE_AUDITORIA,
  type LinhaAuditoria,
} from '../auditoria-margem-execucao';
import { IntelligenceStrategicTab } from '../IntelligenceStrategicTab';
import { ehFalhaDePagina } from '@/lib/postgrest';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const PERIODO = { period_start: '2025-10-04', period_end: '2026-10-04' };
/** ids embaralhados: a leitura por `order('id')` INTERCALA os lotes, como os uuids reais. */
const idDe = (i: number) => `${((i * 2654435761) % 2 ** 32).toString(16).padStart(8, '0')}-${String(i).padStart(6, '0')}`;
let seq = 0;
function linha(carimbo: string, extra: Partial<Linha> = {}, opts: { novo?: boolean } = {}): Linha {
  const i = seq++;
  return {
    id: idDe(i),
    customer_user_id: `c${String(i).padStart(6, '0')}`,
    ...PERIODO,
    margin_real: 10,
    margin_potential: 30,
    margin_gap: 20,
    gap_pct: 66.7,
    calculated_at: carimbo,
    // formato novo: o edge carimba o INÍCIO da execução; `created_at` é o default do insert, depois
    created_at: opts.novo ? '2026-10-04T03:01:30.123456+00:00' : carimbo,
    ...extra,
  };
}
const lote = (n: number, carimbo: string, extra: Partial<Linha> = {}, opts: { novo?: boolean } = {}) =>
  Array.from({ length: n }, () => linha(carimbo, extra, opts));

// execução de FORMATO ANTIGO: 500 + 500 + 201 em 3 carimbos a ~100 ms; a âncora tem microssegundos
const T1 = '2026-10-04T03:00:24.781192+00:00';
const T2 = '2026-10-04T03:00:24.881192+00:00';
const T3 = '2026-10-04T03:00:24.975623+00:00';
/** execução MANUAL anterior, mesmo período, 8,8 s antes — DENTRO da janela de leitura, valores outros */
const T_MANUAL = '2026-10-04T03:00:15.981192+00:00';

function cenarioAntigo() {
  LOG = [
    ...lote(26, T_MANUAL, { margin_real: 999, margin_potential: 999, margin_gap: 999 }),
    ...lote(500, T1),
    ...lote(500, T2),
    ...lote(200, T3),
    // o MAIOR gap da execução é uma linha do último lote — chega na 2ª página da leitura por id
    linha(T3, { margin_gap: 5000, customer_user_id: 'c-maior-gap' }),
  ];
}

beforeEach(() => {
  LOG = [];
  falharPagina = null;
  aoContar = null;
  contagens = 0;
  faixasLidas = [];
  aoRecalcular = null;
  seq = 0;
});

// ── reconhecimento e agregação (puros) ───────────────────────────────────────────────────────────────
describe('reconhecerExecucao', () => {
  it('formato antigo: junta os lotes de 500 a < 1 s e deixa de fora a execução manual anterior', () => {
    cenarioAntigo();
    const ex = reconhecerExecucao(LOG as LinhaAuditoria[], T3);
    expect(ex?.linhas).toHaveLength(1201);
    expect(ex?.formato).toBe('reconstruida');
    expect(ex?.linhas.some((l) => l.calculated_at === T_MANUAL)).toBe(false);
    expect(ex?.limiteDaJanela).toBe(false);
  });

  it('formato antigo: carimbo anterior a < 1 s mas SEM lote cheio é outra execução', () => {
    LOG = [...lote(26, '2026-10-04T03:00:24.700000+00:00'), ...lote(8, T3)];
    expect(reconhecerExecucao(LOG as LinhaAuditoria[], T3)?.linhas).toHaveLength(8);
  });

  it('formato NOVO: um carimbo só, sem fundir com outra execução de 500 logo antes', () => {
    LOG = [...lote(500, '2026-10-04T03:00:24.775623+00:00', {}, { novo: true }), ...lote(508, T3, {}, { novo: true })];
    const ex = reconhecerExecucao(LOG as LinhaAuditoria[], T3);
    expect(ex?.linhas).toHaveLength(508);
    expect(ex?.formato).toBe('carimbo-unico');
  });

  it('a cadeia que encosta no início da janela é sinalizada', () => {
    LOG = [...lote(500, T1), ...lote(500, T2), ...lote(8, T3)];
    expect(reconhecerExecucao(LOG as LinhaAuditoria[], T3)?.limiteDaJanela).toBe(true);
  });

  it('âncora ausente das linhas lidas → null', () => {
    LOG = lote(3, T1);
    expect(reconhecerExecucao(LOG as LinhaAuditoria[], T3)).toBeNull();
  });
});

describe('agregarExecucao', () => {
  it('desconhecido continua desconhecido; zero e prejuízo conhecidos entram na soma', () => {
    const base = lote(3, T3);
    base[0].margin_real = null;
    base[1].margin_real = 0;
    base[2].margin_real = -40;
    const a = agregarExecucao(base as LinhaAuditoria[]);
    expect(a.margemReal).toBe(-40);
    expect(a.comMargemReal).toBe(2);
    expect(agregarExecucao(lote(2, T3, { margin_real: null, margin_potential: null }) as LinhaAuditoria[]).margemReal).toBeNull();
  });

  it('cliente repetido aparece em `duplicados` (invalida a soma na tela)', () => {
    const l = lote(2, T3);
    l[1].customer_user_id = l[0].customer_user_id;
    expect(agregarExecucao(l as LinhaAuditoria[]).duplicados).toBe(1);
  });

  it('múltiplo exato do lote é SUSPEITA de interrupção — não afirmação', () => {
    expect(agregarExecucao(lote(TAMANHO_LOTE_AUDITORIA, T3) as LinhaAuditoria[]).suspeitaInterrompida).toBe(true);
    expect(agregarExecucao(lote(508, T3) as LinhaAuditoria[]).suspeitaInterrompida).toBe(false);
  });
});

// ── leitura (consultas reais contra o mock fiel) ───────────────────────────────────────────────────
describe('lerUltimaExecucaoAuditoria', () => {
  it('a execução INTEIRA: 1.201 clientes em 2 páginas, sem a execução manual da mesma janela', async () => {
    cenarioAntigo();
    const r = await lerUltimaExecucaoAuditoria();
    expect(faixasLidas).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(r?.agregado.clientes).toBe(1201);
    expect(r?.agregado.margemReal).toBe(12010);
    expect(r?.agregado.gap).toBe(1200 * 20 + 5000);
    // o maior gap veio do fim da leitura e lidera o ranking
    expect(r?.agregado.maioresGaps[0].customer_user_id).toBe('c-maior-gap');
    expect(rodapeExecucao(r!)).toContain('1201 clientes auditados');
    expect(rodapeExecucao(r!)).toContain('conclusão não confirmada');
  });

  it('a âncora fica no texto ORIGINAL: o último lote (com microssegundos) entra', async () => {
    cenarioAntigo();
    const r = await lerUltimaExecucaoAuditoria();
    expect(r?.execucao.carimbo).toBe(T3);
    expect(r?.execucao.linhas.filter((l) => l.calculated_at === T3)).toHaveLength(201);
  });

  it('página 2 falha → erro do fetchAllPages, nunca a soma da 1ª página', async () => {
    cenarioAntigo();
    falharPagina = 1;
    const erro = await lerUltimaExecucaoAuditoria().then(
      () => null,
      (e: unknown) => e,
    );
    expect(ehFalhaDePagina(erro)).toBe(true);
  });

  it('lote do MESMO carimbo gravado no meio da leitura → a tentativa é descartada e refeita', async () => {
    LOG = lote(508, T3, {}, { novo: true });
    aoContar = (n) => {
      if (n === 1) LOG.push(...lote(500, T3, {}, { novo: true }));
    };
    const r = await lerUltimaExecucaoAuditoria();
    expect(r?.agregado.clientes).toBe(1008);
    expect(contagens).toBe(4);
  });

  it('log mudando a cada leitura → desiste (não publica uma soma de gerações misturadas)', async () => {
    LOG = lote(508, T3, {}, { novo: true });
    aoContar = (n) => {
      if (n % 2 === 1) LOG.push(...lote(10, T3, {}, { novo: true }));
    };
    await expect(lerUltimaExecucaoAuditoria()).rejects.toThrow('o log mudou durante a leitura');
  });

  it('execução NOVA gravada depois da âncora não entra (a janela tem teto)', async () => {
    cenarioAntigo();
    aoContar = (n) => {
      if (n === 1) LOG.push(...lote(508, '2026-10-04T03:05:00.000001+00:00', {}, { novo: true }));
    };
    const r = await lerUltimaExecucaoAuditoria();
    expect(r?.agregado.clientes).toBe(1201);
  });

  it('log vazio → null (nenhuma execução), não uma execução zerada', async () => {
    expect(await lerUltimaExecucaoAuditoria()).toBeNull();
  });
});

// ── a aba ─────────────────────────────────────────────────────────────────────────────────────────
function renderAba(ui: ReactElement = <IntelligenceStrategicTab />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return qc;
}
/** Texto do card do KPI (o título e o valor são irmãos dentro do mesmo bloco). */
const cardDo = (titulo: string): string => screen.getByText(titulo).closest('div')?.parentElement?.textContent ?? '';

describe('IntelligenceStrategicTab — a última execução inteira', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('os cinco KPIs saem da execução INTEIRA (não das 100 linhas mais recentes)', async () => {
    cenarioAntigo();
    renderAba();
    await screen.findByTestId('rodape-execucao');
    expect(cardDo('Margem Real')).toContain('R$ 12.010');
    expect(cardDo('Margem Potencial')).toContain('R$ 36.030');
    expect(cardDo('Gap de Margem')).toContain('R$ 29.000');
    expect(cardDo('Clientes auditados')).toContain('1201');
    expect(cardDo('Margem Global')).toContain('R$ 12.010');
    expect(screen.getByText('Maiores gaps da última execução')).toBeTruthy();
    expect(screen.getByText('c-maior-...')).toBeTruthy(); // o id cortado em 8 (sem nome em profiles)
  });

  it('margem desconhecida em todos os clientes → "—", não R$ 0 (o gap, conhecido, aparece)', async () => {
    LOG = lote(508, T3, { margin_real: null, margin_potential: null }, { novo: true });
    renderAba();
    await screen.findByTestId('rodape-execucao');
    expect(cardDo('Margem Real')).toMatch(/—/);
    expect(cardDo('Margem Real')).not.toContain('R$ 0');
    expect(cardDo('Gap de Margem')).toContain('R$ 10.160');
  });

  it('"Recalcular" atualiza a leitura: a tela passa à execução NOVA', async () => {
    cenarioAntigo();
    aoRecalcular = () => {
      LOG.push(...lote(508, '2026-10-04T15:00:00.000001+00:00', { margin_real: 1 }, { novo: true }));
    };
    renderAba();
    await screen.findByTestId('rodape-execucao');
    expect(cardDo('Clientes auditados')).toContain('1201');
    fireEvent.click(screen.getByRole('button', { name: /Recalcular/ }));
    await waitFor(() => expect(cardDo('Clientes auditados')).toContain('508'));
    expect(cardDo('Margem Real')).toContain('R$ 508');
  });

  it('offline sem cache → "—" e o aviso, nunca KPIs zerados', async () => {
    cenarioAntigo();
    onlineManager.setOnline(false);
    renderAba();
    await screen.findByText(/Auditoria de margem indisponível/);
    for (const titulo of ['Margem Real', 'Margem Potencial', 'Gap de Margem', 'Clientes auditados', 'Margem Global']) {
      expect(cardDo(titulo), `${titulo} sem leitura`).toMatch(/—/);
    }
  });
});

// ── acoplamento com o escritor ─────────────────────────────────────────────────────────────────────
describe('acoplamento com o edge algorithm-a-audit', () => {
  // O reconhecimento depende de DUAS coisas do escritor: o carimbo único (formato novo) e o tamanho do
  // lote (reconstrução do formato antigo). Lido como TEXTO, sem comentários (a prosa não conta).
  const fonte = readFileSync(resolve(__dirname, '../../../../supabase/functions/algorithm-a-audit/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('um carimbo por EXECUÇÃO: declarado uma vez, antes do laço por cliente, e gravado em toda linha', () => {
    const declaracoes = fonte.match(/const calculadoEm = new Date\(\)\.toISOString\(\);/g) ?? [];
    expect(declaracoes).toHaveLength(1);
    expect(fonte.indexOf('const calculadoEm = ')).toBeLessThan(fonte.indexOf('for (const client of clients)'));
    expect(fonte).toContain('calculated_at: calculadoEm,');
  });

  it(`o lote do insert é ${TAMANHO_LOTE_AUDITORIA} — o mesmo que a reconstrução do formato antigo assume`, () => {
    expect(fonte).toContain(`i += ${TAMANHO_LOTE_AUDITORIA}`);
    expect(fonte).toContain(`slice(i, i + ${TAMANHO_LOTE_AUDITORIA})`);
  });
});
