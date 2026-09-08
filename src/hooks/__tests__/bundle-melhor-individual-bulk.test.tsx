import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * A comparação "bundle × ofertas individuais" em UMA leitura — e os estados dela.
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
 *   4. As DUAS rotas chegam SEPARADAS. A célula única comparava `affinity_score` de motores com
 *      escalas incomensuráveis, e o vencedor saía por artefato de escala — up_sell venceu 186 de
 *      186 pares em prod (07/09/2026). Uma chave de Map por cliente fazia a segunda linha
 *      sobrescrever a primeira em silêncio; a chave passou a incluir o tipo.
 *
 * CENÁRIO: seis cestas fazem o Apriori achar P1→P2 e P1→P3; `C7` comprou só P1 e recebe o par
 * P2+P3 como bundle. `C8` NÃO recebe bundle nenhum — é ele quem revela a omissão.
 *
 * ⚠️ Os ids são uuids DE VERDADE porque o validador de resposta exige formato (achado R2/4):
 * um `customer_user_id` fora de formato some na consulta pela chave do Map, e sumir é
 * indistinguível de "este cliente não tem oferta" — a falha entrando pela porta dos fundos.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = uuid(1);
const C7 = uuid(7);
const C8 = uuid(8);
const C9 = uuid(9);
const P1 = uuid(101);
const P2 = uuid(102);
const P3 = uuid(103);
const P4 = uuid(104);
const RUN_UNICO = uuid(200);
const RUN_A = uuid(201);
const RUN_B = uuid(202);
/** SKU válido em FORMA que o catálogo ativo não conhece — a deriva, não a resposta malformada. */
const SKU_FANTASMA = uuid(999);

let falhaBulk: 'nao' | 'erro' | 'rejeita' | 'null_mudo' | 'nao_array' | 'string_json' = 'nao';
/** RPC íntegra devolvendo `[]` — o vazio LEGÍTIMO, que não é falha de leitura nenhuma. */
let semPendentes = false;
/** `true` = a carteira devolvida tem 1.500 entradas — mais que o antigo cap de 1.000. */
let carteiraGrande = false;
/** `true` = o SKU nomeado não está no catálogo ATIVO (`productMap` não resolve). */
let produtoForaDoCatalogo = false;
/** `true` = a tabela tem DUAS gerações pendentes vivas ao mesmo tempo. */
let duasGeracoes = false;
/** Linhas extras injetadas no payload — os estados que o cenário base não produz. */
let linhasExtras: Array<Record<string, unknown>> = [];

const chamadasBulk: number[] = [];
/** Args da RPC que persiste os bundles — é por ela que o head (completude) é movido. */
const argsSubstituir: Array<Record<string, unknown>> = [];

const PEDIDOS = [
  { customer_user_id: C9, items: [{ product_id: P1 }, { product_id: P2 }, { product_id: P3 }], total: 300, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: C9, items: [{ product_id: P1 }, { product_id: P2 }, { product_id: P3 }], total: 300, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: C8, items: [{ product_id: P4 }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: C8, items: [{ product_id: P4 }], total: 50, created_at: '2026-07-04T00:00:00Z' },
  { customer_user_id: C8, items: [{ product_id: P4 }], total: 50, created_at: '2026-07-05T00:00:00Z' },
  { customer_user_id: C7, items: [{ product_id: P1 }], total: 100, created_at: '2026-07-06T00:00:00Z' },
];
const NOMES: Record<string, string> = { [P1]: 'Produto P1', [P2]: 'Produto P2', [P3]: 'Produto P3', [P4]: 'Produto P4' };
const PRODUTOS = [P1, P2, P3, P4].map((id) => ({
  id, codigo: id, descricao: NOMES[id], valor_unitario: 100,
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
    case 'farmer_client_scores': return [C9, C8, C7].map(score);
    case 'omie_products': return PRODUTOS;
    case 'profiles': return [C9, C8, C7].map(perfil);
    case 'sales_orders': return PEDIDOS;
    default: return [];
  }
}

/**
 * Uma linha da RPC. `situacao` e `candidatos` são DERIVADOS do array por padrão para que o
 * cenário base não escreva combinação que o validador rejeitaria — quem quer um estado
 * específico o declara em `extras`, e é exatamente aí que o teste fica explícito.
 */
const linhaIndividual = (
  cid: string,
  produtos: string[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> => ({
  customer_user_id: cid,
  recommendation_type: 'cross_sell',
  situacao: produtos.length === 1 ? 'eleito' : 'empatado',
  produtos,
  produto_eleito: produtos.length === 1 ? produtos[0] : null,
  candidatos: Math.max(2, produtos.length),
  affinity_score: 0.42,
  run_id: RUN_UNICO,
  ...extras,
});

/** 1.500 clientes de enchimento: 50% acima do cap de linhas que a versão paginada sofria. */
const CARTEIRA_GRANDE = Array.from({ length: 1500 }, (_, i) => linhaIndividual(uuid(1000 + i), [P4]));

function linhasBulk(): Array<Record<string, unknown>> {
  const uteis = duasGeracoes
    ? [
        linhaIndividual(C8, [P4], { run_id: RUN_A }),
        linhaIndividual(C9, [P2], { run_id: RUN_B }),
      ]
    : [linhaIndividual(C8, [produtoForaDoCatalogo ? SKU_FANTASMA : P4])];
  // O cliente útil vai no FIM: na versão paginada ele cairia fora do cap e viraria `nenhum`.
  return [...(carteiraGrande ? CARTEIRA_GRANDE : []), ...uteis, ...linhasExtras];
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
      if (nome === 'farmer_melhores_individuais_por_cliente') {
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
const acharCliente = (result: Awaited<ReturnType<typeof calcular>>, cid: string) =>
  result.current.customerBundles.find((c) => c.customerId === cid);

beforeEach(() => {
  falhaBulk = 'nao';
  semPendentes = false;
  carteiraGrande = false;
  duasGeracoes = false;
  produtoForaDoCatalogo = false;
  linhasExtras = [];
  chamadasBulk.length = 0;
  argsSubstituir.length = 0;
  vi.clearAllMocks();
});

describe('useBundleEngine — as ofertas individuais em UMA leitura, com os estados separados', () => {
  it('DETECTOR: o cenário produz bundle e a comparação chega ao cliente certo', async () => {
    // Sem este controle positivo, tudo abaixo passaria por vacuidade — "nenhum bundle" é o
    // desfecho de QUALQUER insumo faltando.
    const result = await calcular();
    const c7 = acharCliente(result, C7);
    const c8 = acharCliente(result, C8);

    expect(c7?.bundles.length, 'C7 devia receber o par P2+P3').toBeGreaterThan(0);
    expect(c7?.individuais.cross_sell.status).toBe('nenhum');
    expect(c8?.individuais.cross_sell).toEqual({
      status: 'encontrado',
      situacao: 'eleito',
      nomes: ['Produto P4'],
      produtos: 1,
      candidatos: 2,
    });
    // O tipo que o cenário NÃO produziu não vira falha nem invenção — vira `nenhum`.
    expect(c8?.individuais.up_sell.status).toBe('nenhum');
  });

  it('as DUAS rotas do mesmo cliente coexistem — a de cima não engole a de baixo', async () => {
    // Com a chave do Map em `customer_user_id` puro, a segunda linha sobrescrevia a primeira e
    // uma das rotas sumia da tela como `nenhum` — um veredicto, e o defeito que a célula única
    // escondia por construção. A chave passou a ser `${cliente}:${tipo}`.
    linhasExtras = [
      linhaIndividual(C8, [P2], { recommendation_type: 'up_sell', situacao: 'unico_registrado', produto_eleito: null, candidatos: 1 }),
    ];
    const result = await calcular();
    const c8 = acharCliente(result, C8);

    expect(c8?.individuais.cross_sell.status, 'a rota complementar sumiu').toBe('encontrado');
    expect(c8?.individuais.up_sell).toEqual({
      status: 'encontrado',
      situacao: 'unico_registrado',
      nomes: ['Produto P2'],
      produtos: 1,
      candidatos: 1,
    });
  });

  it('`empatado` que perde UM nome no catálogo continua empatado — não promove o sobrevivente', async () => {
    // O achado R3/3, e a razão de `nomes` e `produtos` serem campos separados: esconder o
    // participante que o catálogo não soube nomear converteria uma falha de catálogo em
    // ELEIÇÃO. A célula segue `empatado`, declarando 1 de 2 não identificado.
    linhasExtras = [
      linhaIndividual(C9, [P2, SKU_FANTASMA], { situacao: 'empatado', candidatos: 2 }),
    ];
    const result = await calcular();

    expect(acharCliente(result, C9)?.individuais.cross_sell).toEqual({
      status: 'encontrado',
      situacao: 'empatado',
      nomes: ['Produto P2'],
      produtos: 2,
      candidatos: 2,
    });
  });

  it('linha que viola invariante ENTRE campos derruba a leitura INTEIRA, não só a linha', async () => {
    // `{empatado, candidatos:1, produtos:[X]}` passa em toda checagem campo a campo — tipo
    // reconhecido, inteiro ≥1, sem eleito fora de `eleito` — e não representa empate nenhum.
    // Descartar só a linha ruim daria um Map parcial apresentado como completo: o cliente
    // afetado viraria `nenhum`, que é um veredicto. Rejeitar tudo é a saída honesta.
    // `produto_eleito: null` EXPLÍCITO: sem ele o helper o deriva do array de um elemento, a
    // linha é recusada pela checagem de `produto_eleito` e este teste ficaria verde mesmo com a
    // cardinalidade do `empatado` desligada — provando outra coisa que não a que promete.
    linhasExtras = [
      linhaIndividual(C9, [P2], { situacao: 'empatado', produto_eleito: null, candidatos: 1 }),
    ];
    const result = await calcular();

    expect(acharCliente(result, C8)?.individuais.cross_sell.status).toBe('indisponivel');
    expect(acharCliente(result, C9)?.individuais.cross_sell.status).toBe('indisponivel');
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

    expect(acharCliente(result, C8)?.individuais.cross_sell.status).toBe('encontrado');
    expect(chamadasBulk.length, 'voltou a fatiar a leitura em mais de um request').toBe(1);
  });

  it('`data: null` SEM erro é FALHA, não vazio', async () => {
    // O §6 do money-path: o contrato tem de EXPOR a falha, senão o caller não pode detectar. A
    // RPC faz `coalesce(…, '[]')` — o assert A3 do harness PG17 é o outro lado deste par —, então
    // `null` só chega aqui se algo quebrou. Tratá-lo como lista vazia faria a carteira INTEIRA
    // virar `nenhum`, silenciosamente, com toast de sucesso.
    falhaBulk = 'null_mudo';
    const result = await calcular();

    expect(acharCliente(result, C8)?.individuais.cross_sell.status).toBe('indisponivel');
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
      expect(acharCliente(result, C8)?.individuais.cross_sell.status).toBe('indisponivel');
      expect(toast.success, 'anunciou sucesso sobre uma leitura que não aconteceu').not.toHaveBeenCalled();
    },
  );

  it('SKU fora do catálogo ativo vira `indisponivel`, não um nome inventado', async () => {
    // Era `productName: prod?.descricao || 'Produto'`: a tela dizia ter ENCONTRADO o melhor
    // individual e mostrava um literal. É a mesma fabricação de rótulo que esta união veio
    // matar, um nível abaixo. Aqui NENHUM nome resolve — só então a célula perde a identidade.
    produtoForaDoCatalogo = true;
    const result = await calcular();

    expect(acharCliente(result, C8)?.individuais.cross_sell).toEqual({
      status: 'indisponivel', motivo: 'produto_nao_resolve',
    });
  });

  it.each(['erro', 'rejeita'] as const)(
    'a leitura falhando (%s) marca INDISPONÍVEL e NÃO omite o cliente da lista',
    async (modo) => {
      // O coração desta entrega. Antes, `C8` (sem bundle próprio) sumia da lista quando a
      // leitura dele falhava — e sumir é afirmar, pelo silêncio, que não há rota individual
      // para ele. As duas portas contam: `{ error }` resolvido e Promise rejeitada.
      falhaBulk = modo;
      const result = await calcular();

      const c8 = acharCliente(result, C8);
      expect(c8, 'o cliente sem bundle sumiu da lista quando a leitura falhou').toBeDefined();
      // AS DUAS rotas ficam indisponíveis: a falha de leitura é da carteira inteira, e deixar
      // uma delas em `nenhum` afirmaria ausência sobre o que ninguém leu.
      expect(c8?.individuais.cross_sell).toEqual({ status: 'indisponivel', motivo: 'leitura_falhou' });
      expect(c8?.individuais.up_sell).toEqual({ status: 'indisponivel', motivo: 'leitura_falhou' });

      // E o cliente COM bundle não perde o bundle por causa da leitura acessória.
      const c7 = acharCliente(result, C7);
      expect(c7?.bundles.length).toBeGreaterThan(0);
      expect(c7?.individuais.cross_sell.status).toBe('indisponivel');
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
    await calcular();
    const avisos = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes('gerações diferentes'))).toBe(false);
  });

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
    // frágil: as chaves mudaram para `comparacao_individual_*` naquele PR e aquela linha teria
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

  // ── Os estados da evidência inerte (money-path §13) ──────────────────────────────────────
  //
  // A tabela existe porque UMA chave só não distingue os casos: "clientes com veredicto"
  // gravaria 237/238 num cenário em que a resolução real é 0/1 — o `nenhum`, que é fato
  // comercial legítimo, mascarando a deriva que o sensor existe para expor.
  //
  // A unidade da resolução é o SKU PEDIDO, não a célula: uma célula `empatado` promete dois
  // nomes e pede duas resoluções, e contá-la como uma esconderia metade da deriva.
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
    produtoForaDoCatalogo = true;
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '0/1' });
  });

  it('a resolução conta SKU, não célula — o empate parcial aparece como 1/2', async () => {
    // Se o denominador fosse a célula, esta linha contaria 1/1 e a deriva do SKU que sumiu do
    // catálogo ficaria invisível justamente no estado em que há mais nomes para perder.
    linhasExtras = [linhaIndividual(C9, [P2, SKU_FANTASMA], { situacao: 'empatado', candidatos: 2 })];
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '2/3' });
  });

  it('o denominador é o LAÇO, não o payload da RPC', async () => {
    // 1.500 linhas de clientes que não estão em `farmer_client_scores` — o laço nunca as
    // exercita contra o catálogo. Contá-las inflaria o denominador com trabalho que não houve.
    carteiraGrande = true;
    await calcular();
    expect(evidencias()).toEqual({ leitura: '1/1', resolucao: '1/1' });
  });

  it('mas a falha TAMBÉM não vira sucesso — ela sai pelo aviso, que é onde ela pertence', async () => {
    falhaBulk = 'erro';
    await calcular();
    expect(toast.success).not.toHaveBeenCalled();
    const avisos = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => m.includes('não pôde ser lida'))).toBe(true);
  });

  it('"li e não há" continua sendo `nenhum` — a falha não contamina o zero legítimo', async () => {
    semPendentes = true;
    const result = await calcular();
    const c7 = acharCliente(result, C7);
    expect(c7?.bundles.length, 'o bundle sumiu junto — o cenário perdeu o detector').toBeGreaterThan(0);
    expect(c7?.individuais.cross_sell.status).toBe('nenhum');
    expect(c7?.individuais.up_sell.status).toBe('nenhum');
  });
});
