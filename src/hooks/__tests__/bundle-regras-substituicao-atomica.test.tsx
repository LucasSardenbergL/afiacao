import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — a substituição das regras de associação não pode ZERAR a tabela.
 *
 * `farmer_association_rules` é GLOBAL (não tem farmer_id) e o engine a substituía assim:
 *
 *   await supabase.from('farmer_association_rules').delete().neq('id', '000…');  // apaga TUDO
 *   if (discoveredRules.length > 0) await supabase.from(…).insert(rulesToInsert);
 *
 * Três defeitos num bloco de cinco linhas: (1) DELETE e INSERT são chamadas PostgREST
 * separadas — logo transações separadas — e uma falha entre elas deixa a tabela VAZIA;
 * (2) o `error` das duas era descartado e o toast de sucesso saía do mesmo jeito, então o
 * operador via "N regras gravadas" com a tabela zerada; (3) sem lote (0 regras) o DELETE
 * rodava sozinho.
 *
 * O estrago não fica no bundle engine — cinco consumidores leem essa tabela e nenhum
 * distingue "sem regra" de "zerada": `get_meu_mixgap` (card MixGap em FarmerCalls),
 * `melhoria_produtos_relacionados` (canal Melhorias, em prod), a edge `recommend`
 * (assoc_score, peso w_assoc), o `useCrossSellEngine` e o próprio bundle engine.
 *
 * DISCRIMINADOR: nenhum `delete()` sobre `farmer_association_rules` pode partir do cliente.
 * A troca inteira vai por `farmer_association_rules_substituir`, que faz DELETE+INSERT numa
 * transação (provada em db/test-farmer-association-rules-atomica.sh).
 *
 * Irmão de `bundle-escopo-sob-falha.test.tsx` (mesmo hook, outro defeito).
 */
const FARMER = 'farmer-real';
const CLIENTE = 'cliente-1';

type Q = { table: string; metodos: string[] };
type ChamadaRpc = { nome: string; args: Record<string, unknown> };

let queries: Q[] = [];
let rpcs: ChamadaRpc[] = [];
let rpcFalha = false;
let semPedidos = false;
let naLente = false;

const ERRO_RPC = { code: '08006', message: 'connection failure', details: '', hint: '' };

/**
 * Quatro cestas desenhadas para o Apriori achar UMA regra acima dos pisos
 * (minSupport 0.01, minLift 1.05): P1 e P2 só aparecem juntos, P3 sozinho.
 * lift(P1→P2) = conf/support(P2) = 1 / (2/4) = 2.
 */
const PEDIDOS = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }], total: 100, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }], total: 100, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P3' }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P3' }], total: 50, created_at: '2026-07-04T00:00:00Z' },
];

const PRODUTOS = ['P1', 'P2', 'P3'].map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));

function dadosDa(tabela: string): unknown[] {
  switch (tabela) {
    case 'farmer_client_scores':
      return [{ customer_user_id: CLIENTE, health_score: 80, answer_rate_60d: 50,
                whatsapp_reply_rate_60d: 50, avg_monthly_spend_180d: 1000,
                gross_margin_pct: 30, category_count: 2, days_since_last_purchase: 10 }];
    case 'omie_products': return PRODUTOS;
    case 'profiles': return [{ user_id: CLIENTE, name: 'Cliente 1', customer_type: 'moveleiro', cnae: '3101' }];
    case 'sales_orders': return semPedidos ? [] : PEDIDOS;
    default: return [];
  }
}

function chain(table: string): unknown {
  const q: Q = { table, metodos: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => { q.metodos.push(m); return c; };
  c.then = (resolve: (v: unknown) => void) => resolve({ data: dadosDa(table), error: null, count: 0 });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args: Record<string, unknown>) => {
      // Leitura ATÔMICA do melhor individual: UMA tupla jsonb (array), não linhas paginadas.
      // `[]` = li e não há — que é o estado deste cenário. `null` seria FALHA, não vazio.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        return Promise.resolve({ data: [], error: null });
      }
      rpcs.push({ nome, args });
      // O engine passou a perguntar quais SKUs são vendáveis antes de montar bundle. Ela
      // responde SEMPRE, e à parte do `rpcFalha`: o defeito que este arquivo guarda é a
      // troca de REGRAS falhando, e derrubar as duas juntas mediria outra coisa (o toast
      // sairia por fail-closed de bundle, não pela regra não gravada).
      //
      // Lista VAZIA porque nenhum custo é semeado aqui (`product_costs` cai no `default: []`
      // de dadosDa). É o espelho honesto do que a main fazia com o costMap vazio: sem custo
      // conhecido, nenhum SKU é vendável e nenhum bundle nasce — inventar SKU vendável aqui
      // fabricaria margem que o cenário não tem.
      if (nome === 'get_skus_margem_positiva') {
        // PAGINADA (`fetchAllPages`) desde que o cap de 1.000 do PostgREST zerou o motor em
        // prod: o builder de `.rpc()` expõe `.range()` como o de `.from()`, e o dublê tem de
        // expor também. Lista vazia ⇒ a 1ª página já encerra a paginação.
        const vazio = { data: [] as { product_id: string }[], error: null };
        const c: Record<string, unknown> = {
          order: () => c,
          range: () => c,
          then: (resolve: (v: unknown) => void) => resolve(vazio),
        };
        return c;
      }
      return Promise.resolve(rpcFalha ? { data: null, error: ERRO_RPC } : { data: 2, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: naLente, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));

const toastMock = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastMock.error(...a),
                                    success: (...a: unknown[]) => toastMock.success(...a),
                                    warning: (...a: unknown[]) => toastMock.warning(...a) } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  queries = []; rpcs = [];
  rpcFalha = false; semPedidos = false; naLente = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** DELETE partindo do cliente sobre a tabela global = o defeito de volta. */
const deletesNaTabelaDeRegras = () =>
  queries.filter((q) => q.table === 'farmer_association_rules' && q.metodos.includes('delete'));

const substituicoes = () => rpcs.filter((r) => r.nome === 'farmer_association_rules_substituir');

async function calcular() {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result;
}

/**
 * ⚠️ ESTE ARQUIVO FOI INVERTIDO (2026-08-21). A invariante antiga era "substitui via RPC";
 * a nova é "NÃO ESCREVE POR VIA NENHUMA".
 *
 * O que mudou não foi opinião, foi medição. `farmer_association_rules` tinha DOIS escritores
 * chamando a mesma RPC com universos diferentes, e o último vencia. Medido em prod (psql-ro):
 * o cron gravou 24 regras (`sample_size` 479) às 07:30 UTC; este hook gravou 4 regras
 * (`sample_size` 21.579) às 01:33 UTC do dia seguinte, porque alguém abriu a tela. A corrida
 * foi OBSERVADA acontecendo, não deduzida. Enquanto os dois existissem, corrigir o produtor
 * server-side (que lia 479 dos 30.259 pedidos por causa do cap de 1.000 do PostgREST) teria
 * meia-vida de uma abertura de tela.
 *
 * O teste antigo não estava errado no que afirmava — a atomicidade da RPC segue valendo e
 * segue provada em `db/test-farmer-association-rules-atomica.sh`. Ele estava PINANDO uma
 * escrita que não deve mais existir: um teste que exige `substituicoes()).toHaveLength(1)`
 * transforma a remoção do 2º escritor em regressão vermelha. Por isso a inversão em vez do
 * delete (money-path §6: teste pode canonizar o defeito — ao consertar, reverta o teste).
 *
 * DISCRIMINADOR NOVO, mais forte que o anterior: nenhuma via de escrita sobre
 * `farmer_association_rules` pode partir do cliente — nem `delete()`, nem `insert()`,
 * nem `update()`, nem a RPC. Em NENHUM cenário (caminho feliz, zero regras, lente).
 *
 * ⚠️ Este guard cobre o CÓDIGO. A fronteira de verdade é o BANCO (`REVOKE EXECUTE ... FROM
 * authenticated` na RPC + a policy de escrita da tabela) — money-path §5: guard na fronteira
 * que TODA via cruza, não só na UI. Um teste de fonte não impede um PostgREST cru.
 */
const escritasNaTabelaDeRegras = () =>
  queries.filter(
    (q) =>
      q.table === 'farmer_association_rules' &&
      q.metodos.some((m) => m === 'delete' || m === 'insert' || m === 'update' || m === 'upsert'),
  );

describe('useBundleEngine — não publica mais o modelo global de regras', () => {
  it('caminho feliz: descobre regras, usa em memória e NÃO escreve na tabela', async () => {
    const result = await calcular();

    // As regras seguem existindo — o que saiu foi a persistência, não a mineração.
    expect(result.current.rules.length).toBeGreaterThan(0);

    expect(substituicoes()).toHaveLength(0);
    expect(escritasNaTabelaDeRegras()).toHaveLength(0);
    expect(deletesNaTabelaDeRegras()).toHaveLength(0);
  });

  it('caminho feliz mantém o toast de sucesso', async () => {
    await calcular();

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('o toast não fala mais de persistência de REGRA — não há escrita a relatar', async () => {
    await calcular();

    // Falar "as regras NÃO foram salvas" seria pior que silêncio: afirmaria uma tentativa
    // que não existe. As duas frases antigas saíram junto com a escrita.
    const ditos = [...toastMock.success.mock.calls, ...toastMock.warning.mock.calls]
      .map((c) => String(c[0]))
      .join(' | ');
    expect(ditos).not.toContain('anteriores seguem valendo');
    expect(ditos).not.toContain('regras anteriores foram preservadas');
  });

  it('zero regras descobertas: nada de escrita, e nada de aviso sobre regra', async () => {
    semPedidos = true;
    await calcular();

    expect(substituicoes()).toHaveLength(0);
    expect(escritasNaTabelaDeRegras()).toHaveLength(0);
  });

  it('na lente "Ver como" também não escreve (era o único cenário já protegido)', async () => {
    naLente = true;
    await calcular();

    expect(substituicoes()).toHaveLength(0);
    expect(escritasNaTabelaDeRegras()).toHaveLength(0);
  });

  it('a RPC falhando é IRRELEVANTE agora — o hook não a chama em cenário nenhum', async () => {
    // Falsificação do próprio guard: se alguém reintroduzir a escrita, `rpcFalha` volta a
    // ter efeito e este teste fica vermelho junto com os de cima.
    rpcFalha = true;
    await calcular();

    expect(substituicoes()).toHaveLength(0);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });
});
