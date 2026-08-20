import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * A comparação "bundle × melhor produto individual" em UMA leitura — e os três estados dela.
 *
 * ERA N+1: um `.from('farmer_recommendations')` por cliente, dentro do laço. O #1800 consertou
 * a HONESTIDADE daquela leitura (o `error` resolvido e a Promise rejeitada passaram a ser
 * capturados); o challenge Codex (gpt-5.6-sol, xhigh) apontou o que sobrou — a FORMA:
 *
 *   (a) numa carteira de centenas são centenas de round-trips seriais;
 *   (b) e, o que pesa: N consultas são N INSTANTES. Sob substituição concorrente de
 *       `farmer_recommendations`, metade dos clientes enxerga uma geração e a outra metade
 *       enxerga outra — todas com sucesso, nenhuma com erro, e o conjunto sem formar snapshot.
 *
 * O que este arquivo guarda, e que nenhum outro guarda:
 *
 *   1. A leitura é UMA (bulk) — não uma por cliente. É o (a)+(b) medido pelo número de
 *      chamadas, que é a única evidência que não some num refactor.
 *   2. Ela é PAGINADA. A capa de 1.000 do PostgREST vale para `.rpc()` igual a `.from()` e já
 *      zerou este motor duas vezes (#1782, #1801). Sem `.range()`, o cliente da posição 1.001
 *      viraria "não tem oferta individual" — um veredicto, não uma ausência.
 *   3. `indisponivel` NÃO omite o cliente da lista. Este é o §2 do money-path (ausente ≠ zero)
 *      na forma de rótulo: `IndividualComparison | null` colapsava "li e não há" com "não
 *      consegui ler", e o filtro `if (topBundles.length > 0 || bestIndividual)` transformava o
 *      colapso na afirmação "não há rota individual para este cliente".
 *
 * CENÁRIO: seis cestas fazem o Apriori achar P1→P2 e P1→P3; `c7` comprou só P1 e recebe o par
 * P2+P3 como bundle. `c8` NÃO recebe bundle nenhum — é ele quem revela a omissão.
 */
const FARMER = 'farmer-bulk';
/** Igual ao `POSTGREST_PAGE_SIZE` de `@/lib/postgrest` — é o cap que estamos reproduzindo. */
const PAGINA = 1000;

/** 'nao' | 'erro' (resolvido) | 'rejeita' (Promise rejeitada). */
let falhaBulk: 'nao' | 'erro' | 'rejeita' = 'nao';
/** `true` = o melhor individual de `c8` cai na 2ª página (o defeito que o cap causaria). */
let c8NaCauda = false;
/** `true` = a tabela tem DUAS gerações pendentes vivas ao mesmo tempo. */
let duasGeracoes = false;

const chamadasBulk: Array<{ de: number; ate: number }> = [];
const ordenacoesBulk: string[] = [];
/** Args da RPC que persiste os bundles — é por ela que o head (completude) é movido. */
const argsSubstituir: Array<Record<string, unknown>> = [];

const PEDIDOS = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-04T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-05T00:00:00Z' },
  { customer_user_id: 'c7', items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-06T00:00:00Z' },
];
const PRODUTOS = ['P1', 'P2', 'P3', 'P4'].map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));
const score = (cid: string) => ({
  customer_user_id: cid, farmer_id: FARMER, health_score: 75, answer_rate_60d: 60,
  whatsapp_reply_rate_60d: 60, avg_monthly_spend_180d: 1000, gross_margin_pct: 30,
  category_count: 2, days_since_last_purchase: 10,
});
const perfil = (cid: string) => ({ user_id: cid, name: `Cliente ${cid}`, customer_type: 'moveleiro', cnae: '3101' });

function dadosDa(tabela: string): unknown[] {
  switch (tabela) {
    case 'farmer_client_scores': return ['c9', 'c8', 'c7'].map(score);
    case 'omie_products': return PRODUTOS;
    case 'profiles': return ['c9', 'c8', 'c7'].map(perfil);
    case 'sales_orders': return PEDIDOS;
    default: return [];
  }
}

const linhaBulk = (cid: string, pid: string, run = 'run-unico') => ({
  customer_user_id: cid, product_id: pid, affinity_score: 0.42,
  recommendation_type: 'cross_sell', run_id: run,
});
/** Ruído de clientes que não estão na carteira — só serve para empurrar `c8` para a 2ª página. */
const RUIDO = Array.from({ length: PAGINA }, (_, i) => linhaBulk(`ruido-${i}`, 'P4'));

function linhasBulk(): Array<Record<string, unknown>> {
  const uteis = duasGeracoes
    ? [linhaBulk('c8', 'P4', 'run-A'), linhaBulk('c9', 'P2', 'run-B')]
    : [linhaBulk('c8', 'P4')];
  return c8NaCauda ? [...RUIDO, ...uteis] : uteis;
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve({ data: dadosDa(table), error: null, count: 0 });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_bundle_recomendacoes_substituir') {
        argsSubstituir.push(args ?? {});
        return Promise.resolve({ data: null, error: null });
      }
      if (nome === 'get_skus_margem_positiva') {
        const c: Record<string, unknown> = {
          order: () => c, range: () => c,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: PRODUTOS.map((p) => ({ product_id: p.id })), error: null }),
        };
        return c;
      }
      if (nome === 'farmer_melhor_individual_por_cliente') {
        // Reproduz o PostgREST: a fatia pedida por `.range()`, e SEM `.range()` as 1.000
        // primeiras. Um dublê que devolvesse tudo não provaria paginação nenhuma.
        let de = 0;
        let ate = PAGINA - 1;
        const c: Record<string, unknown> = {
          order: (coluna: string) => { ordenacoesBulk.push(coluna); return c; },
          range: (d: number, a: number) => { de = d; ate = a; return c; },
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            chamadasBulk.push({ de, ate });
            if (falhaBulk === 'rejeita') return reject(new Error('Failed to fetch'));
            if (falhaBulk === 'erro') {
              return resolve({ data: null, error: { code: '57014', message: 'statement timeout' } });
            }
            return resolve({ data: linhasBulk().slice(de, ate + 1), error: null });
          },
        };
        return c;
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { toast } from 'sonner';
import { useBundleEngine } from '../useBundleEngine';

async function calcular() {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result;
}

beforeEach(() => {
  falhaBulk = 'nao';
  c8NaCauda = false;
  duasGeracoes = false;
  chamadasBulk.length = 0;
  ordenacoesBulk.length = 0;
  argsSubstituir.length = 0;
  vi.clearAllMocks();
});

describe('useBundleEngine — o melhor individual em UMA leitura, com os três estados', () => {
  it('DETECTOR: o cenário produz bundle e a comparação chega ao cliente certo', async () => {
    // Sem este controle positivo, tudo abaixo passaria por vacuidade — "nenhum bundle" é o
    // desfecho de QUALQUER insumo faltando.
    const result = await calcular();
    const c7 = result.current.customerBundles.find((c) => c.customerId === 'c7');
    const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');

    expect(c7?.bundles.length, 'c7 devia receber o par P2+P3').toBeGreaterThan(0);
    expect(c7?.bestIndividual.status).toBe('nenhum');
    expect(c8?.bestIndividual).toEqual({
      status: 'encontrado',
      value: { productId: 'P4', productName: 'Produto P4', affinity: 0.42, type: 'cross_sell' },
    });
  });

  it('a leitura é UMA — não uma por cliente (o N+1 morreu)', async () => {
    // A prova do (a)+(b) do Codex. Com 3 clientes na carteira, o motor antigo fazia 3
    // consultas em 3 instantes; agora é 1 página só, porque o conjunto cabe nela.
    await calcular();
    expect(chamadasBulk.length).toBe(1);
  });

  it('a RPC é PAGINADA — o cliente da posição 1.001 não vira "não tem oferta"', async () => {
    // Sem `.range()` o motor receberia as 1.000 primeiras e trataria a cauda como ausência —
    // e ausência, aqui, é renderizada como veredicto. É o #1782/#1801 nesta terceira RPC.
    c8NaCauda = true;
    const result = await calcular();

    expect(chamadasBulk.length, 'parou na 1ª página e chamou a cauda de "acabou"').toBeGreaterThan(1);
    const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');
    expect(c8?.bestIndividual.status).toBe('encontrado');
  });

  it('a paginação pede ORDEM ESTÁVEL — sem ela as páginas pulam clientes', async () => {
    c8NaCauda = true;
    await calcular();
    expect(ordenacoesBulk).toContain('customer_user_id');
  });

  it.each(['erro', 'rejeita'] as const)(
    'a leitura falhando (%s) marca INDISPONÍVEL e NÃO omite o cliente da lista',
    async (modo) => {
      // O coração desta entrega. Antes, `c8` (sem bundle próprio) sumia da lista quando a
      // leitura dele falhava — e sumir é afirmar, pelo silêncio, que não há rota individual
      // para ele. As duas portas contam: `{ error }` resolvido e Promise rejeitada.
      falhaBulk = modo;
      const result = await calcular();

      const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');
      expect(c8, 'o cliente sem bundle sumiu da lista quando a leitura falhou').toBeDefined();
      expect(c8?.bestIndividual.status).toBe('indisponivel');

      // E o cliente COM bundle não perde o bundle por causa da leitura acessória.
      const c7 = result.current.customerBundles.find((c) => c.customerId === 'c7');
      expect(c7?.bundles.length).toBeGreaterThan(0);
      expect(c7?.bestIndividual.status).toBe('indisponivel');
    },
  );

  it('duas gerações vivas viram AVISO — o `run_id` existe para isso', async () => {
    // O bulk cura a incoerência da LEITURA (um SELECT é um snapshot só), não a do DADO: duas
    // gerações pendentes ao mesmo tempo fazem o melhor individual de um cliente vir de um
    // cálculo e o do vizinho de outro. Antes isso era INDETECTÁVEL daqui — o `.select()` nem
    // pedia `run_id`. Canário, não fail-closed: quem responde pela unicidade da geração é a
    // RPC de substituição do cross-sell, e mover a decisão para cá poria o gate longe da causa.
    duasGeracoes = true;
    await calcular();

    const avisos = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes('gerações diferentes'))).toBe(true);
  });

  it('CONTRAPROVA: com UMA geração o aviso não aparece (senão seria ruído constante)', async () => {
    // Sem esta, um `toast.warning` disparado sempre passaria no teste acima e o canário seria
    // indistinguível de um alarme quebrado — o "rótulo com DEFAULT constante não é fato".
    await calcular();
    const avisos = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes('gerações diferentes'))).toBe(false);
  });

  // ── O insumo do snapshot de completude (a reavaliação que o bulk destravou) ───────────────
  //
  // `melhor_individual` era de PROPÓSITO mantido FORA do `InsumosSnapshot`, e o fundamento era
  // um só: o RUÍDO. `avaliarCompletude` degrada com um único `ok:false`, e com a consulta POR
  // CLIENTE uma falha isolada carimbaria `degradado` em quase toda execução de carteira grande
  // — sinal que nunca varia deixa de ser sinal. Com a leitura em BLOCO é 1 leitura e 1 falha
  // possível por execução: a premissa caiu, e a assimetria de custo (degradar custa uma oferta
  // velha na tela; `completo` errado custa a carteira da vendedora) passa a mandar declarar.
  it('a leitura ÍNTEGRA declara o insumo e o head sai `completo`', async () => {
    // Controle positivo obrigatório: sem ele, "saiu degradado" e "o cenário nunca chega a
    // gravar" seriam indistinguíveis, e o teste seguinte passaria por vacuidade.
    await calcular();

    expect(argsSubstituir.length, 'o cenário não chegou a persistir nada').toBeGreaterThan(0);
    const head = argsSubstituir[0];
    expect((head.p_insumos as Record<string, unknown>).melhor_individual).toEqual({ ok: true, n: 1 });
    expect(head.p_completude).toBe('completo');
  });

  it('a leitura FALHANDO degrada o head — e o motivo NOMEIA o insumo', async () => {
    // O que isto compra: `completo` é o único rótulo que autoriza a fase 2 a EXPIRAR a carteira.
    // Com o insumo declarado, uma execução que não conseguiu ler nunca produz essa licença.
    falhaBulk = 'erro';
    await calcular();

    expect(argsSubstituir.length, 'o cenário não chegou a persistir nada').toBeGreaterThan(0);
    const head = argsSubstituir[0];
    expect((head.p_insumos as Record<string, unknown>).melhor_individual).toEqual({ ok: false, n: 0 });
    expect(head.p_completude).toBe('degradado');
    expect(String(head.p_motivo)).toContain('melhor_individual');
  });

  it('"li e não há" continua sendo `nenhum` — a falha não contamina o zero legítimo', async () => {
    // A contraprova do caso acima: sem falha, `c7` (que de fato não tem recomendação pendente)
    // sai `nenhum`, não `indisponivel`. Um `indisponivel` universal seria fail-closed demais e
    // apagaria a informação que o motor de fato tem.
    const result = await calcular();
    const c7 = result.current.customerBundles.find((c) => c.customerId === 'c7');
    expect(c7?.bestIndividual.status).toBe('nenhum');
  });
});
