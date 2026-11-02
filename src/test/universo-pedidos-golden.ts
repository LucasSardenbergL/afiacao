/**
 * Fixture DETERMINÍSTICA + stub de `supabase` para os testes GOLDEN dos três motores do Farmer
 * (`useFarmerScoring`, `useCrossSellEngine`, `useBundleEngine`) — plano v4, lote 16 (C4′).
 *
 * O lote trocou COMO os motores leem `sales_orders` (uma consulta compartilhada, páginas em
 * paralelo) e o invariante é "mesmo dado ⇒ mesmo score". A prova é golden de verdade: a saída de
 * cada motor foi GRAVADA rodando o código ANTERIOR à troca (commit do golden) e o teste exige
 * igualdade profunda com o código atual. Regravar (`GRAVAR_GOLDEN=1`) só é legítimo quando o
 * CÁLCULO muda de propósito — nunca para "consertar" um vermelho deste lote.
 *
 * Por que um stub próprio e não o passthrough dos testes vizinhos: o passthrough ignora filtro,
 * ordem e colunas, e aí a troca de leitura passaria com QUALQUER forma. Este aplica o que a leitura
 * de `sales_orders` usa (`not.in` NULL-blind, `is null`, `eq`/`in`, `order` estável, `range`,
 * PROJEÇÃO das colunas do `select`) — se um motor passar a ler uma coluna que o `select` antigo
 * não trazia (ex.: `id` no bundle), a saída muda e o golden fica vermelho.
 */

import { addDias } from '@/lib/time/sp-day';

const AGORA = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00:00Z — relógio fixo do golden
export const AGORA_GOLDEN = AGORA;
export const FARMER_GOLDEN = 'farmer-1';
const OUTRO_FARMER = 'farmer-2';
const DIA = 24 * 60 * 60 * 1000;
const DIA_AGORA = '2026-10-15';

/** mulberry32: PRNG de 32 bits, mesma sequência em qualquer máquina. */
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

type Linha = Record<string, unknown>;

export interface UniversoGolden {
  tabelas: Record<string, Linha[]>;
  rpcs: Record<string, Linha[]>;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** uuid-like a partir do PRNG — hex minúsculo, como o Postgres devolve (a ordem de texto = a de uuid). */
function uuidDe(r: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 160 clientes (100 na carteira do farmer-1, 60 na de outro), 30 SKUs em "famílias" que
 * co-ocorrem (dão regra de associação e bundle), `nPedidos` pedidos com a mistura real de status
 * (inclui `cancelado`, status NULO e soft-delete, que NÃO podem entrar no universo), itens nas
 * duas formas que existem (pt-BR `omie_codigo_produto` e a antiga `product_id`).
 * `nPedidos` > 6.000 cruza a fronteira de uma ONDA de 6 páginas da leitura paralela.
 */
export function gerarUniversoGolden(nPedidos = 6_500): UniversoGolden {
  const r = prng(20261102);
  const clientes = Array.from({ length: 160 }, (_, i) => `cli-${pad(i, 3)}`);
  const daCarteira = (i: number) => i < 100;

  const skus = Array.from({ length: 30 }, (_, i) => ({
    id: `sku-${pad(i, 2)}`,
    codigo: `C${pad(i, 2)}`,
    descricao: `Produto ${i}`,
    valor_unitario: Math.round((20 + r() * 480) * 100) / 100,
    metadata: null,
    ativo: i !== 29,
    omie_codigo_produto: 1000 + i,
    estoque: Math.floor(r() * 50),
    account: i % 3 === 0 ? 'colacor' : 'oben',
    familia: null,
    subfamilia: null,
  }));
  const familias = [[0, 1, 2], [3, 4], [5, 6, 7], [8, 9], [10, 11, 12, 13], [14, 15], [16, 17, 18], [19, 20], [21, 22, 23], [24, 25, 26, 27, 28, 29]];

  const statusSorteado = () => {
    const x = r();
    if (x < 0.6) return 'faturado';
    if (x < 0.75) return 'importado';
    if (x < 0.83) return 'separacao';
    if (x < 0.9) return 'enviado';
    if (x < 0.96) return 'cancelado';
    if (x < 0.97) return null;
    return 'faturado';
  };

  const pedidos: Linha[] = [];
  for (let k = 0; k < nPedidos; k++) {
    // Cauda longa: poucos clientes concentram pedidos, como na base real.
    const ci = Math.min(159, Math.floor(Math.pow(r(), 1.6) * 160));
    const fam = familias[Math.floor(r() * familias.length)];
    const escolhidos = new Set<number>();
    for (const s of fam) if (r() < 0.7) escolhidos.add(s);
    if (r() < 0.35) escolhidos.add(Math.floor(r() * 30));
    if (escolhidos.size === 0) escolhidos.add(fam[0]);
    const formaAntiga = r() < 0.15;
    const items = [...escolhidos].map((s) => {
      const quantidade = 1 + Math.floor(r() * 6);
      const valor_unitario = skus[s].valor_unitario;
      return formaAntiga
        ? { product_id: skus[s].id, quantity: quantidade, unit_price: valor_unitario }
        : { omie_codigo_produto: skus[s].omie_codigo_produto, quantidade, valor_unitario, codigo: skus[s].codigo };
    });
    const total = Math.round(items.reduce((t, it) => t + Number(it.quantidade ?? it.quantity) * Number(it.valor_unitario ?? it.unit_price), 0) * 100) / 100;
    const instante = AGORA - Math.floor(r() * 720 * DIA);
    const comKpi = r() < 0.9;
    pedidos.push({
      id: uuidDe(r),
      customer_user_id: clientes[ci],
      items,
      total,
      created_at: new Date(instante + DIA).toISOString(),
      // Dia de calendário do instante (época UTC) a partir de um dia FIXO — fixture, não "hoje".
      order_date_kpi: comKpi ? addDias(DIA_AGORA, Math.floor(instante / DIA) - Math.floor(AGORA / DIA)) : null,
      status: statusSorteado(),
      account: r() < 0.7 ? 'oben' : 'colacor',
      deleted_at: r() < 0.03 ? new Date(instante + 2 * DIA).toISOString() : null,
    });
  }

  const scores = clientes.map((cid, i) => ({
    customer_user_id: cid,
    farmer_id: daCarteira(i) ? FARMER_GOLDEN : OUTRO_FARMER,
    health_score: Math.round(r() * 1000) / 10,
    answer_rate_60d: Math.round(r() * 1000) / 10,
    whatsapp_reply_rate_60d: Math.round(r() * 1000) / 10,
    avg_monthly_spend_180d: Math.round(r() * 500000) / 100,
    gross_margin_pct: r() < 0.2 ? null : Math.round(r() * 400) / 10,
    category_count: Math.floor(r() * 12),
    days_since_last_purchase: Math.floor(r() * 400),
  }));

  const chamadas: Linha[] = [];
  for (let k = 0; k < 400; k++) {
    const ci = Math.floor(r() * 100);
    chamadas.push({
      customer_user_id: clientes[ci],
      farmer_id: FARMER_GOLDEN,
      call_result: r() < 0.5 ? 'contato_sucesso' : 'sem_resposta',
      is_whatsapp: r() < 0.4,
      whatsapp_replied: r() < 0.5,
      created_at: new Date(AGORA - Math.floor(r() * 120 * DIA)).toISOString(),
    });
  }

  const faixas = ['verde', 'amarelo', 'vermelho', 'neutro'];
  const faixaMargem = clientes
    .filter(() => r() < 0.85)
    .map((cid) => {
      const faixa = faixas[Math.floor(r() * faixas.length)];
      const conhecida = faixa !== 'neutro';
      return {
        customer_user_id: cid,
        faixa,
        motivo: conhecida ? 'apurada' : 'sem_custo',
        g: conhecida ? Math.round(r() * 1000) / 1000 : null,
        margem_pct: conhecida ? Math.round((r() * 60 - 5) * 10) / 10 : null,
      };
    });

  return {
    tabelas: {
      sales_orders: pedidos,
      farmer_client_scores: scores,
      omie_products: skus,
      profiles: clientes.map((cid, i) => ({
        user_id: cid,
        name: `Cliente ${i}`,
        phone: i % 7 === 0 ? null : `11 9${pad(i, 4)}-0000`,
        customer_type: i % 2 ? 'industria' : 'revenda',
        cnae: i % 3 ? '2222' : '3101',
      })),
      farmer_calls: chamadas,
      // Exclusão de carteira (fornecedor): sai do universo do scoring ANTES do cálculo.
      cliente_classificacao: [{ user_id: 'cli-007', excluir_da_carteira: true }, { user_id: 'cli-013', excluir_da_carteira: true }],
      // O que a RLS devolveria ao farmer-1 (a policy é `carteira_visivel_para`): só a carteira dele.
      carteira_assignments: clientes.filter((_, i) => daCarteira(i)).map((cid) => ({ customer_user_id: cid, eligible: true })),
      // Config NÃO-padrão: um golden com o DEFAULT não distinguiria "leu a config" de "caiu no default".
      farmer_algorithm_config: [
        { key: 'k1', value: 1.3 },
        { key: 'sla_contact_days', value: 10 },
        { key: 'agenda_pct_risco', value: 0.4 },
        { key: 'agenda_pct_expansao', value: 0.35 },
        { key: 'health_w_rf', value: 0.3 },
      ],
      farmer_category_conversion: [],
      farmer_association_rules: [],
      farmer_recommendations: [],
      farmer_bundle_recommendations: [],
      farmer_geracao_vigente: [],
    },
    rpcs: {
      get_carteira_margem_faixa: faixaMargem,
      get_skus_margem_positiva: skus.filter((_, i) => i < 25).map((s) => ({ product_id: s.id })),
      get_scores_margem: scores.map((s) => ({
        customer_user_id: s.customer_user_id,
        gross_margin_pct: s.gross_margin_pct,
        margem_visivel: true,
      })),
      farmer_melhores_individuais_por_cliente: [],
    },
  };
}

// ─── Stub ────────────────────────────────────────────────────────────────────

/** `("a","b","c")` → `['a','b','c']` — a forma do `not.in` do PostgREST. */
function listaPostgrest(bruto: string): string[] {
  const m = /^\((.*)\)$/.exec(bruto.trim());
  if (!m) throw new Error(`stub: valor de .not(…,'in',…) fora da forma ("a","b"): ${bruto}`);
  return m[1].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
}

function comparar(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // NULLS LAST, como o default ASC do Postgres
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/** Colunas de um `select` simples (`a, b, c`); `null` = forma que o stub não projeta (`*`, embed, alias). */
function colunasDoSelect(sel: string | undefined): string[] | null {
  if (!sel || sel.trim() === '*' || /[(:!]/.test(sel)) return null;
  return sel.split(',').map((c) => c.trim()).filter(Boolean);
}

export interface RegistroStub {
  /** Cada leitura de `sales_orders`: o select e a faixa pedidos. */
  leiturasPedidos: Array<{ select: string; de: number; ate: number }>;
  /** RPCs de escrita/registro e escritas em tabela, em ordem. */
  escritas: Array<{ alvo: string; args: unknown }>;
  /**
   * Leitura de `sales_orders` (índice 0-based, na ordem de chegada) que falha: `'erro'` = página
   * perdida (`{data:null, error}`), `'data_null'` = resposta malformada (`{data:null}` sem erro).
   */
  falharLeituraPedidos: ((indice: number) => false | 'erro' | 'data_null') | null;
  /** Operadores que o "servidor" IGNORA em `sales_orders` — simula filtro/cursor não honrado. */
  ignorarEmPedidos: ReadonlyArray<'gt' | 'gte' | 'lt'>;
  /** Tabelas cuja leitura devolve erro (ex.: `farmer_algorithm_config`). */
  falharTabelas: ReadonlyArray<string>;
  /** Atraso (ms) da N-ésima leitura de uma tabela — para forçar uma execução a terminar DEPOIS. */
  atrasoLeitura: ((tabela: string, indiceNaTabela: number) => number) | null;
  /** Leituras por tabela (contador interno do atraso). */
  leiturasPorTabela: Record<string, number>;
}

export function criarRegistroStub(): RegistroStub {
  return { leiturasPedidos: [], escritas: [], falharLeituraPedidos: null, ignorarEmPedidos: [], falharTabelas: [], atrasoLeitura: null, leiturasPorTabela: {} };
}

type Filtro = (l: Linha) => boolean;

export function criarSupabaseStub(universo: () => UniversoGolden, reg: RegistroStub) {
  function chain(tabela: string) {
    const filtros: Filtro[] = [];
    const ordens: Array<{ col: string; asc: boolean }> = [];
    let selecao: string | undefined;
    let de = 0;
    let ate: number | null = null;
    let limite: number | null = null;
    let escrita: string | null = null;
    let unico: 'single' | 'maybe' | null = null;
    const c: Record<string, unknown> = {};
    const reto = () => c;
    c.select = (s?: string) => { selecao = s; return c; };
    c.eq = (col: string, v: unknown) => { filtros.push((l) => l[col] === v); return c; };
    c.neq = (col: string, v: unknown) => { filtros.push((l) => l[col] !== null && l[col] !== v); return c; };
    c.in = (col: string, vs: unknown[]) => { filtros.push((l) => vs.includes(l[col])); return c; };
    const ignora = (op: 'gt' | 'gte' | 'lt') => tabela === 'sales_orders' && reg.ignorarEmPedidos.includes(op);
    c.gt = (col: string, v: unknown) => { if (!ignora('gt')) filtros.push((l) => l[col] != null && comparar(l[col], v) > 0); return c; };
    c.gte = (col: string, v: unknown) => { if (!ignora('gte')) filtros.push((l) => l[col] != null && comparar(l[col], v) >= 0); return c; };
    c.lt = (col: string, v: unknown) => { if (!ignora('lt')) filtros.push((l) => l[col] != null && comparar(l[col], v) < 0); return c; };
    c.lte = (col: string, v: unknown) => { filtros.push((l) => l[col] != null && comparar(l[col], v) <= 0); return c; };
    c.not = (col: string, op: string, v: string) => {
      if (op === 'in') {
        const proibidos = listaPostgrest(v);
        // NULL-blind como o PostgREST: `NOT (col IN …)` é NULL — logo NÃO passa — com col nula.
        filtros.push((l) => {
          if (!(col in l)) throw new Error(`stub: fixture de ${tabela} sem a coluna \`${col}\``);
          return l[col] !== null && !proibidos.includes(String(l[col]));
        });
      } else if (op === 'is' && v === null) {
        filtros.push((l) => l[col] != null);
      } else {
        throw new Error(`stub: .not(…, '${op}', …) não modelado`);
      }
      return c;
    };
    c.is = (col: string, v: unknown) => {
      if (v !== null) throw new Error(`stub: .is(…, ${String(v)}) não modelado`);
      filtros.push((l) => {
        if (!(col in l)) throw new Error(`stub: fixture de ${tabela} sem a coluna \`${col}\``);
        return l[col] === null;
      });
      return c;
    };
    for (const m of ['or', 'filter', 'contains', 'ilike', 'like', 'match', 'overlaps', 'textSearch', 'returns', 'abortSignal']) c[m] = reto;
    c.order = (col: string, opts?: { ascending?: boolean }) => { ordens.push({ col, asc: opts?.ascending !== false }); return c; };
    c.range = (d: number, a: number) => { de = d; ate = a; return c; };
    c.limit = (n: number) => { limite = n; return c; };
    c.single = () => { unico = 'single'; return c; };
    c.maybeSingle = () => { unico = 'maybe'; return c; };
    for (const m of ['insert', 'upsert', 'update', 'delete']) {
      c[m] = (args?: unknown) => { escrita = m; reg.escritas.push({ alvo: `${tabela}.${m}`, args }); return c; };
    }
    c.then = (resolverDireto: (v: unknown) => void, rejeitar?: (e: unknown) => void) => {
      const n = (reg.leiturasPorTabela[tabela] = (reg.leiturasPorTabela[tabela] ?? 0) + 1) - 1;
      const atraso = escrita ? 0 : (reg.atrasoLeitura?.(tabela, n) ?? 0);
      const resolver = (v: unknown) => (atraso > 0 ? void setTimeout(() => resolverDireto(v), atraso) : resolverDireto(v));
      try {
        if (escrita) return resolver({ data: null, error: null });
        if (reg.falharTabelas.includes(tabela)) {
          return resolver({ data: null, error: { message: 'permission denied for table', code: '42501' } });
        }
        if (tabela === 'sales_orders') {
          const indice = reg.leiturasPedidos.length;
          reg.leiturasPedidos.push({ select: selecao ?? '', de, ate: ate ?? -1 });
          const falha = reg.falharLeituraPedidos?.(indice);
          if (falha === 'erro') {
            return resolver({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } });
          }
          if (falha === 'data_null') return resolver({ data: null, error: null });
        }
        let linhas = (universo().tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordens.length) {
          linhas = [...linhas].sort((a, b) => {
            for (const o of ordens) {
              const x = comparar(a[o.col], b[o.col]);
              if (x !== 0) return o.asc ? x : -x;
            }
            return 0;
          });
        }
        const total = linhas.length;
        if (ate !== null) linhas = linhas.slice(de, ate + 1);
        if (limite !== null) linhas = linhas.slice(0, limite);
        const cols = colunasDoSelect(selecao);
        const projetadas = cols
          ? linhas.map((l) => Object.fromEntries(cols.filter((k) => k in l).map((k) => [k, structuredClone(l[k])])))
          : linhas.map((l) => structuredClone(l));
        if (unico) return resolver({ data: projetadas[0] ?? null, error: null });
        return resolver({ data: projetadas, error: null, count: total });
      } catch (e) {
        if (rejeitar) return rejeitar(e);
        throw e;
      }
    };
    return c;
  }

  function rpc(nome: string, args?: Record<string, unknown>) {
    const dados = universo().rpcs[nome];
    if (dados === undefined) reg.escritas.push({ alvo: `rpc:${nome}`, args: args ?? null });
    const ordens: Array<{ col: string; asc: boolean }> = [];
    let de = 0;
    let ate: number | null = null;
    const c: Record<string, unknown> = {};
    c.order = (col: string, opts?: { ascending?: boolean }) => { ordens.push({ col, asc: opts?.ascending !== false }); return c; };
    c.range = (d: number, a: number) => { de = d; ate = a; return c; };
    c.then = (resolver: (v: unknown) => void) => {
      if (dados === undefined) return resolver({ data: null, error: null });
      let linhas = [...dados];
      if (ordens.length) {
        linhas.sort((a, b) => {
          for (const o of ordens) {
            const x = comparar(a[o.col], b[o.col]);
            if (x !== 0) return o.asc ? x : -x;
          }
          return 0;
        });
      }
      if (ate !== null) linhas = linhas.slice(de, ate + 1);
      return resolver({ data: structuredClone(linhas), error: null });
    };
    return c;
  }

  return { from: (tabela: string) => chain(tabela), rpc };
}

/**
 * Forma canônica para comparar: ida-e-volta por JSON (Map/Set não sobrevivem — o teste converte
 * antes). Sem arredondar número de propósito: o invariante é BIT-A-BIT. Somar as mesmas linhas
 * em OUTRA ordem já muda o último bit de um float, e isso tem de ficar vermelho aqui.
 */
export function canonico(valor: unknown): unknown {
  return JSON.parse(JSON.stringify(valor));
}
