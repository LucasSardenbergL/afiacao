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
 *   2. Ela é ATÔMICA — uma tupla `jsonb`, não N linhas paginadas. A primeira versão desta
 *      correção usava `RETURNS TABLE` + `fetchAllPages`, e o challenge Codex mostrou que isso
 *      TROCA o defeito de lugar: K requests são K snapshots. Geração A com 1.500 clientes,
 *      página 0 lê os 1.000 primeiros; uma substituição grava a geração B com 500; a página 1
 *      pede OFFSET 1000, recebe `[]` — o sinal de FIM — e os clientes 1.001–1.500 viram
 *      `nenhum`, que é um VEREDICTO. O canário de `run_id` é cego ao caso (só viu linhas de A).
 *      Uma tupla mata as duas coisas: o cap de 1.000 conta LINHAS, e agora há uma.
 *   3. `indisponivel` NÃO omite o cliente da lista. Este é o §2 do money-path (ausente ≠ zero)
 *      na forma de rótulo: `IndividualComparison | null` colapsava "li e não há" com "não
 *      consegui ler", e o filtro `if (topBundles.length > 0 || bestIndividual)` transformava o
 *      colapso na afirmação "não há rota individual para este cliente".
 *
 * CENÁRIO: seis cestas fazem o Apriori achar P1→P2 e P1→P3; `c7` comprou só P1 e recebe o par
 * P2+P3 como bundle. `c8` NÃO recebe bundle nenhum — é ele quem revela a omissão.
 */
const FARMER = 'farmer-bulk';
let falhaBulk: 'nao' | 'erro' | 'rejeita' | 'null_mudo' | 'nao_array' | 'string_json' = 'nao';
/** RPC íntegra devolvendo `[]` — o vazio LEGÍTIMO, que não é falha de leitura nenhuma. */
let semPendentes = false;
/** `true` = a carteira devolvida tem 1.500 entradas — mais que o antigo cap de 1.000. */
let carteiraGrande = false;
/** `true` = o SKU eleito não está no catálogo ATIVO (`productMap` não resolve). */
let produtoForaDoCatalogo = false;
/** `true` = a tabela tem DUAS gerações pendentes vivas ao mesmo tempo. */
let duasGeracoes = false;

const chamadasBulk: number[] = [];
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
/** 1.500 clientes de enchimento: 50% acima do cap de linhas que a versão paginada sofria. */
const CARTEIRA_GRANDE = Array.from({ length: 1500 }, (_, i) => linhaBulk(`extra-${i}`, 'P4'));

function linhasBulk(): Array<Record<string, unknown>> {
  const uteis = duasGeracoes
    ? [linhaBulk('c8', 'P4', 'run-A'), linhaBulk('c9', 'P2', 'run-B')]
    : [linhaBulk('c8', produtoForaDoCatalogo ? 'SKU-QUE-NAO-EXISTE' : 'P4')];
  // O cliente útil vai no FIM: na versão paginada ele cairia fora do cap e viraria `nenhum`.
  return carteiraGrande ? [...CARTEIRA_GRANDE, ...uteis] : uteis;
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
        chamadasBulk.push(1);
        if (falhaBulk === 'rejeita') return Promise.reject(new Error('Failed to fetch'));
        if (falhaBulk === 'erro') {
          return Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } });
        }
        // `data: null` SEM `error` é o caso perigoso e é próprio: a RPC faz
        // `coalesce(…, '[]')`, então null só chega aqui se algo quebrou. Tratá-lo como vazio
        // faria a carteira inteira virar `nenhum` — a leitura que não aconteceu virando
        // veredicto (§6 do money-path).
        if (falhaBulk === 'null_mudo') return Promise.resolve({ data: null, error: null });
        if (falhaBulk === 'nao_array') return Promise.resolve({ data: { erro: 'oops' }, error: null });
        // O caso que NÃO é redundante com o `TypeError` do `for…of`: string é ITERÁVEL. Sem o
        // guard de forma, `for (const linha of '[]')` percorre CARACTERES, `linha.customer_user_id`
        // é `undefined` em cada um, e o Map fica com uma chave `undefined` — nenhum erro, nenhum
        // aviso, e a carteira INTEIRA vira `nenhum`. Achado da falsificação S10.
        if (falhaBulk === 'string_json') return Promise.resolve({ data: '[]', error: null });
        return Promise.resolve({ data: semPendentes ? [] : linhasBulk(), error: null });
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
  semPendentes = false;
  carteiraGrande = false;
  duasGeracoes = false;
  produtoForaDoCatalogo = false;
  chamadasBulk.length = 0;
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

  it('não há cap de linhas — 1.500 clientes chegam inteiros numa tupla só', async () => {
    // Na versão paginada, o cliente útil no fim de uma lista de 1.501 caía na 2ª página, e uma
    // substituição concorrente entre as duas o transformaria em `nenhum` — um veredicto. Aqui
    // ele chega junto com todo o resto, porque o cap conta LINHAS e a resposta é uma linha.
    carteiraGrande = true;
    const result = await calcular();

    const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');
    expect(c8?.bestIndividual.status).toBe('encontrado');
    expect(chamadasBulk.length, 'voltou a fatiar a leitura em mais de um request').toBe(1);
  });

  it('`data: null` SEM erro é FALHA, não vazio', async () => {
    // O §6 do money-path: o contrato tem de EXPOR a falha, senão o caller não pode detectar. A
    // RPC faz `coalesce(…, '[]')` — o assert A3 do harness PG17 é o outro lado deste par —, então
    // `null` só chega aqui se algo quebrou. Tratá-lo como lista vazia faria a carteira INTEIRA
    // virar `nenhum`, silenciosamente, com toast de sucesso.
    falhaBulk = 'null_mudo';
    const result = await calcular();

    const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');
    expect(c8?.bestIndividual.status).toBe('indisponivel');
  });

  it.each(['nao_array', 'string_json'] as const)(
    'resposta de FORMA errada (%s) também é falha — não é lista, não é vazio',
    async (modo) => {
      // Um objeto no lugar do array (RPC trocada, schema antigo, proxy que embrulha) já cairia
      // no `TypeError` do `for…of`. O caso `string_json` é o que torna o guard de FORMA
      // indispensável em vez de redundante: string é ITERÁVEL, então sem o guard o laço
      // percorre CARACTERES, o Map ganha uma chave `undefined`, e a carteira inteira vira
      // `nenhum` — sem erro, sem aviso, com toast de sucesso. A falsificação S10 encontrou
      // isto: com só o caso do objeto, desligar o guard passava VERDE.
      falhaBulk = modo;
      const result = await calcular();
      expect(
        result.current.customerBundles.find((c) => c.customerId === 'c8')?.bestIndividual.status,
      ).toBe('indisponivel');
      expect(toast.success, 'anunciou sucesso sobre uma leitura que não aconteceu').not.toHaveBeenCalled();
    },
  );

  it('SKU eleito fora do catálogo ativo vira `indisponivel`, não um nome inventado', async () => {
    // Era `productName: prod?.descricao || 'Produto'`: a tela dizia ter ENCONTRADO o melhor
    // individual e mostrava um literal. É a mesma fabricação de rótulo que esta união veio
    // matar, um nível abaixo — e `product_id` é nullable no schema, então há duas portas.
    produtoForaDoCatalogo = true;
    const result = await calcular();

    const c8 = result.current.customerBundles.find((c) => c.customerId === 'c8');
    expect(c8?.bestIndividual).toEqual({ status: 'indisponivel', motivo: 'produto_nao_resolve' });
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

  // ── A reavaliação: `melhor_individual` NÃO entra no `InsumosSnapshot` ─────────────────────
  //
  // A tarefa pedia para reavaliar, porque o fundamento antigo (o RUÍDO de N consultas por
  // execução) caiu com a leitura em bloco. Cheguei a declarar o insumo; o challenge Codex
  // mostrou que o argumento certo é outro e aponta para o lado oposto: "'não obrigatório' só
  // vale para `n===0`; `ok:false` SEMPRE degrada. Portanto `melhor_individual` passa a bloquear
  // a expiração de bundles embora seja comprovadamente invariante para `p_linhas`."
  //
  // A completude julga UMA coisa — se o zero de BUNDLES veio de snapshot íntegro — e esta
  // leitura não participa dela. Declará-la faria uma leitura acessória travar para sempre o
  // mecanismo de aposentadoria da fase 2, porque `degradado` nunca autoriza expirar.
  it('a falha da comparação NÃO degrada o head — ela não participa do que a completude julga', async () => {
    falhaBulk = 'erro';
    await calcular();

    expect(argsSubstituir.length, 'o cenário não chegou a persistir nada').toBeGreaterThan(0);
    const head = argsSubstituir[0];
    expect(head.p_completude).toBe('completo');

    // ⚠️ Era `not.toContain('melhor_individual')` — asserção pelo NOME, e o nome é a parte
    // frágil: as chaves mudaram para `comparacao_individual_*` neste PR e aquela linha teria
    // seguido VERDE por coincidência, com a decisão que ela guarda invertida. O que precisa
    // valer é a FORMA: a comparação não prega NADA no veredicto — nem `ok:false` (que degrada
    // SEMPRE, obrigatório ou não) nem `pisoCobertura` (que faria `esperado` voltar a julgar).
    const insumos = head.p_insumos as Record<string, { ok: boolean; pisoCobertura?: number }>;
    const chaves = Object.keys(insumos).filter((k) => k.startsWith('comparacao_individual'));
    expect(chaves.length, 'as evidências inertes sumiram do head — a série morre com elas').toBe(2);
    for (const nome of chaves) {
      expect(insumos[nome].ok, `${nome} virou ok:false — degrada SEMPRE e trava a fase 2`).toBe(true);
      expect(insumos[nome].pisoCobertura, `${nome} ganhou piso — voltou a julgar`).toBeUndefined();
    }
  });

  // ── Os 4 estados da evidência inerte (money-path §13) ────────────────────────────────────
  //
  // A tabela existe porque UMA chave só não distingue os casos: "clientes com veredicto"
  // gravaria 237/238 num cenário em que a resolução real é 0/1 — o `nenhum`, que é fato
  // comercial legítimo, mascarando a deriva que o sensor existe para expor.
  function evidencias() {
    const i = argsSubstituir[0].p_insumos as Record<string, { n: number; esperado?: number }>;
    const par = (k: string) => (i[k] ? `${i[k].n}/${i[k].esperado}` : 'AUSENTE');
    return {
      leitura: par('comparacao_individual_leitura'),
      resolucao: par('comparacao_individual_produto_resolvido'),
    };
  }

  it('tudo íntegro: leitura 1/1 e resolução 1/1', async () => {
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '1/1' });
  });

  it('falha global: leitura 0/1 e resolução 0/0 — o denominador some junto, não vira 0/N', async () => {
    // Com a leitura falha o motor não exercitou `productMap` para ninguém. Gravar `0/N` aqui
    // afirmaria N deriva de catálogo que ninguém mediu — o §2 (ausente ≠ zero) no sensor.
    falhaBulk = 'erro';
    await calcular();
    expect(evidencias()).toEqual({ leitura: '0/1', resolucao: '0/0' });
  });

  it('RPC íntegra e ninguém pendente: leitura 1/1 e resolução 0/0', async () => {
    semPendentes = true;
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '0/0' });
  });

  it('produto fora do catálogo ativo: leitura 1/1 e resolução 0/1 — a deriva aparece', async () => {
    // O estado que HOJE é invisível em toda parte: não está no toast, e sem esta chave não
    // estaria no head. É a deriva que o cross-sell só enxergou quando ganhou série (934/939).
    produtoForaDoCatalogo = true;
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '0/1' });
  });

  it('o denominador é o LAÇO, não o payload da RPC', async () => {
    // 1.500 linhas de clientes que não estão em `farmer_client_scores`: a RPC devolve, o laço
    // nunca os avalia, e `productMap` nunca é exercitado para eles. Contá-los inflaria o
    // denominador com trabalho que não aconteceu — e é por isso que o contador vive no laço em
    // vez de reaproveitar `insumos.clientes_com_profile`, que conta sobre outro universo
    // (`ativos`) e só EMPATA com este em produção por acaso.
    carteiraGrande = true;
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '1/1' });
  });

  it('mas a falha TAMBÉM não vira sucesso — ela sai pelo aviso, que é onde ela pertence', async () => {
    // O par indispensável do teste acima: sem ele, "não degrada o head" se leria como "a falha
    // sumiu". Ela não some — muda de canal.
    falhaBulk = 'erro';
    await calcular();

    expect(toast.success).not.toHaveBeenCalled();
    const avisos = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes('não pôde ser lida'))).toBe(true);
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
