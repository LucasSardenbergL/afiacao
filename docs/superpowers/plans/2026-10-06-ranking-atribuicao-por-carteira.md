# Ranking do Master pelo dono da carteira — Plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou
> superpowers:executing-plans para executar este plano tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** o card "Ranking de vendedores · mês" do Master credita cada pedido válido ao dono ATUAL da carteira
elegível do cliente (a régua da positivação e da comissão). O rodapé separa "Carteira de não-vendedor" de "Sem
vendedor atribuído", e o tile "vendedores ativos" deixa de contar o carimbo técnico das importadas.

**Arquitetura:** tudo no front. Uma leitura nova (`fetchDonosCarteira`, lotes de 150 com `eligible = true`) entrega
`cliente → dono`. A régua pura `montarRanking` reparte os pedidos do mês em três destinos, o hook `useTeamRanking`
orquestra e o card mostra. O tile filtra `hash_payload` nulo. Não há migration nem edge, então o único deploy é o
Publish.

**Stack:** React 18 + TS strict · @tanstack/react-query · Supabase JS (PostgREST) · vitest + @testing-library/react
(`.ts` roda no project `node`, `.tsx` no `dom`/jsdom; `globals: true` faz o cleanup entre renders) · bash + python3
(falsificação).

**Spec:** `docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md`. Leia junto: o plano parte
dela.

## Restrições globais

- Worktree ÚNICO: `/Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas`, branch
  `claude/atribuicao-vendas-importadas`. Todo comando roda com `cd` nesse diretório, nunca no checkout principal.
- pt-BR em tudo (código, testes, commits, PR). Todo commit termina com o parágrafo
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Universo de venda: `STATUS_NAO_VENDA` / `STATUS_NAO_VENDA_POSTGREST` de `@/lib/farmer/universo-pedidos`,
  `deleted_at` nulo, `order_date_kpi` (dia de SP). Nenhuma lista de status nova.
- Carteira: só `eligible = true` ("zero comissão + invisível; todo leitor filtra"), dono ATUAL
  (`carteira_assignments.owner_user_id`, `UNIQUE(customer_user_id)`).
- Ausente ≠ zero: `error` lança, e `data` nula sem `error` também lança. Falha de leitura NUNCA vira "Sem vendedor
  atribuído": vira "Indisponível no momento", que o card já tem.
- `.in()` em lotes de 150 (o teto do PostgREST é de 1.000 linhas).
- Não ler `gemeo_importado_id`: sem GRANT para `authenticated`, dá 42501.
- NÃO tocar `supabase/migrations/` nem `supabase/functions/`. O `sonda:fingerprint` faz hash dos bytes crus da
  edge, comentário incluso, e qualquer byte novo no `omie-vendas-sync` abriria pendência de deploy (DIVERGE_P2).
- Banco só para leitura, via `~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "<SQL>" -c '\echo FIM-OK'`. Sem o
  `FIM-OK` na saída a medição não aconteceu, porque o wrapper sai 0 mesmo com ERROR.
- Comandos pesados com o prefixo `heavy` (M2 8 GB).
- Nada de `git stash` cru.
- Validação só vale com evidência positiva: o comando autoritativo terminou e o `EXIT=0` está colado.
- Textos de UI exatos: `por dono da carteira · {escopo}`, `Carteira de não-vendedor: {R$} · {N} ped.`,
  `Sem vendedor atribuído: {R$} · {N} ped.`.
- Todo `it(...)` novo começa com um marcador ASCII entre colchetes (`[RK-A]`, `[FD-ELIG]`…). A falsificação casa
  por ele com `grep -F`, igual nos dois locales.
- O PR fica **DRAFT** até o Codex adversarial no diff (a cota reabre em 09/10 19:30) e a revisão final com contexto
  novo.

## Foco de revisão

Modos de falha que a spec implica e que os testes originais dela não exercitam. Cada um ganhou teste na tarefa
dona:

1. `fetchPedidosMTD` sem `customer_user_id` no select: todo pedido chega sem cliente e o mês inteiro vai, calado,
   para "Sem vendedor atribuído". → `[MTD-COL]` (Tarefa 2).
2. O hook manda à carteira a lista errada (vazia ou com nulo), com o mesmo efeito do item 1. → `[HK-IDS]`
   (Tarefa 3).
3. O hook engole a falha da carteira (`.catch(() => new Map())`) e o card mostra "Sem vendedor atribuído: R$ (o
   mês)" no lugar de "Indisponível". → `[HK-FALHA]` (Tarefa 3).
4. Erro no 2º lote da carteira transforma um mapa PARCIAL em verdade, e metade dos clientes fica "sem vendedor".
   → `[FD-ERRO-LOTE2]` (Tarefa 1).
5. Num mês só com carteira de não-vendedor (ex.: dia 1 com um pedido do pool órfão), o card some. → `[RK-SP]`
   (Tarefa 3) e `[CARD-SO-NV]` (Tarefa 4).

Há ainda um modo de falha de DADO que nenhum teste pega: uma linha do app nascer com `hash_payload` não nulo faria o
filtro do tile esconder atividade real. → medição no pré-voo (Tarefa 0), com parada se aparecer.

**Desvios da spec original, já refletidos nela neste mesmo commit:** `montarRanking(orders, { donoPorCliente,
vendedores })` usa um objeto nomeado, porque dois `Map<string, string>` posicionais trocariam de lugar sem erro de
tipo. A §5.6 não põe nenhum byte na edge: a lição vai para `docs/agent/database.md`. A falsificação ganhou S6b, S8,
S9 e S10.

---

### Tarefa 0: Pré-voo — base atualizada e a premissa do `hash_payload` medida

**Arquivos:** nenhum (git e leitura do banco).

- [ ] **Passo 1: rebase na main** (o branch só tem os commits de docs da spec e do plano)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git fetch origin && git rebase origin/main && git log --oneline -3
```

Esperado: rebase limpo, com os commits de docs no topo.

- [ ] **Passo 2: ninguém mais mexendo no ranking** (PR aberto ou artefato já na main)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
gh pr list --state open --limit 100 --json number,headRefName,files --jq '.[] | select([.files[].path] | any(test("src/lib/dashboard/|useTeamRanking|useTeamKpis|RankingVendedoresCard|universo-pedidos-ts-registro"))) | "\(.number) \(.headRefName)"'; echo "EXIT=$?"
git grep -n -e 'fetchDonosCarteira' -e 'carteiraNaoVendedor' origin/main -- src; echo "EXIT_GREP=$? (1 = nenhum artefato)"
```

Esperado: nenhuma linha de PR, `EXIT=0` e `EXIT_GREP=1`. Se aparecer PR ou artefato, coordenar antes de seguir.

- [ ] **Passo 3: dependências**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
bun install --frozen-lockfile; echo "EXIT=$?"
```

Esperado: `EXIT=0`.

- [ ] **Passo 4: medir a premissa do filtro do tile** (a linha do app nasce com `hash_payload` nulo, e só o
  importador grava `omie_*`)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "
SELECT CASE WHEN hash_payload IS NULL THEN 'nulo (app)'
            WHEN hash_payload LIKE 'omie\_%' THEN 'omie_* (importador)'
            ELSE 'OUTRO' END AS origem,
       count(*) AS linhas, min(created_at)::date AS de, max(created_at)::date AS ate
FROM sales_orders
WHERE created_at >= now() - interval '180 days'
GROUP BY 1 ORDER BY 1;" -c '\echo FIM-OK'; echo "EXIT=$?"
```

Esperado: só `nulo (app)` e `omie_* (importador)`, mais `FIM-OK` e `EXIT=0`. **Se aparecer `OUTRO`, PARE** e leve
ao founder: o filtro esconderia a atividade dessas linhas.

---

### Tarefa 1: `fetchDonosCarteira` — o dono atual da carteira elegível, em lotes

**Arquivos:**
- Criar: `src/lib/dashboard/fetch-donos-carteira.ts`
- Criar: `src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts`
- Manifesto: nada a registrar (`src/lib/dashboard/**` já é do módulo `farmer-inteligencia`).

**Interfaces:**
- Consome: `supabase` de `@/integrations/supabase/client` (tipos gerados: `carteira_assignments.customer_user_id`
  e `owner_user_id` são `string` NOT NULL).
- Produz: `export async function fetchDonosCarteira(clienteIds: string[]): Promise<Map<string, string>>`, com
  cliente → dono e só `eligible = true`. Lança `Error` com mensagem começando por `carteira_assignments (donos):`.

- [ ] **Passo 1: escrever o teste que falha**

```ts
// src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A leitura que decide QUEM vendeu no ranking do Master (spec 2026-10-06 §5.2): cliente → dono ATUAL da
 * carteira ELEGÍVEL. Falha de leitura nunca pode virar "cliente sem carteira" — isso mandaria a venda
 * para "Sem vendedor atribuído", um veredito sobre o que ninguém leu.
 */
type Resposta = { data: unknown; error: { message: string } | null };
type Chamada = { metodo: string; args: unknown[] };

/** Uma lista de chamadas por requisição (cada `from()` abre uma). */
let requisicoes: Chamada[][] = [];
let tabelas: string[] = [];
/** Resposta da requisição `n` (0-based), dado o lote pedido nela. */
let responder: (lote: string[], n: number) => Resposta = () => ({ data: [], error: null });

function builder() {
  const n = requisicoes.length;
  const chamadas: Chamada[] = [];
  requisicoes.push(chamadas);
  let lote: string[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ metodo: m, args });
      if (m === 'in') lote = args[1] as string[];
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(responder(lote, n)).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => {
      tabelas.push(t);
      return builder();
    },
  },
}));

import { fetchDonosCarteira } from '../fetch-donos-carteira';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `C${i + 1}`);
const loteDe = (req: Chamada[]) => (req.find((c) => c.metodo === 'in')?.args[1] ?? []) as string[];

beforeEach(() => {
  requisicoes = [];
  tabelas = [];
  responder = () => ({ data: [], error: null });
});

describe('fetchDonosCarteira', () => {
  it('[FD-VAZIO] lista vazia: mapa vazio e nenhuma requisição', async () => {
    expect(await fetchDonosCarteira([])).toEqual(new Map());
    expect(requisicoes).toHaveLength(0);
  });

  it('[FD-LOTE] 151 clientes: 2 requisições (150 + 1), cada cliente pedido uma vez', async () => {
    await fetchDonosCarteira(ids(151));
    expect(requisicoes.map((r) => loteDe(r).length)).toEqual([150, 1]);
    expect(new Set(requisicoes.flatMap(loteDe))).toEqual(new Set(ids(151)));
  });

  it('[FD-DEDUP] cliente repetido vai uma vez só', async () => {
    await fetchDonosCarteira(['C1', 'C2', 'C1', 'C2', 'C3']);
    expect(requisicoes).toHaveLength(1);
    expect([...loteDe(requisicoes[0])].sort()).toEqual(['C1', 'C2', 'C3']);
  });

  it('[FD-ELIG] toda requisição lê carteira_assignments filtrando eligible = true', async () => {
    await fetchDonosCarteira(ids(151));
    expect(tabelas).toEqual(['carteira_assignments', 'carteira_assignments']);
    for (const req of requisicoes) expect(req).toContainEqual({ metodo: 'eq', args: ['eligible', true] });
  });

  it('[FD-MAPA] devolve cliente → dono das linhas lidas; cliente sem linha fica fora', async () => {
    responder = () => ({
      data: [
        { customer_user_id: 'C1', owner_user_id: 'V1' },
        { customer_user_id: 'C2', owner_user_id: 'MASTER' },
      ],
      error: null,
    });
    const donos = await fetchDonosCarteira(['C1', 'C2', 'C3']);
    expect(donos).toEqual(new Map([['C1', 'V1'], ['C2', 'MASTER']]));
    expect(donos.has('C3')).toBe(false);
  });

  it('[FD-ERRO] erro da leitura lança com a marca da carteira — nunca vira "sem carteira"', async () => {
    responder = () => ({ data: null, error: { message: 'permission denied' } });
    await expect(fetchDonosCarteira(['C1'])).rejects.toThrow('carteira_assignments (donos): permission denied');
  });

  it('[FD-ERRO-LOTE2] erro no 2º lote lança — o 1º lote não vira mapa parcial', async () => {
    responder = (lote, n) =>
      n === 0
        ? { data: lote.map((c) => ({ customer_user_id: c, owner_user_id: 'V1' })), error: null }
        : { data: null, error: { message: 'statement timeout' } };
    await expect(fetchDonosCarteira(ids(151))).rejects.toThrow('carteira_assignments (donos): statement timeout');
  });

  it('[FD-NULO] data nula sem error lança — malformada não é fim', async () => {
    responder = () => ({ data: null, error: null });
    await expect(fetchDonosCarteira(['C1'])).rejects.toThrow('carteira_assignments (donos): data null sem error');
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts
```

Esperado: FAIL na coleta com `Failed to resolve import "../fetch-donos-carteira"`, porque o arquivo ainda não
existe.

- [ ] **Passo 3: implementação mínima**

```ts
// src/lib/dashboard/fetch-donos-carteira.ts
import { supabase } from '@/integrations/supabase/client';

/** `UNIQUE(customer_user_id)` ⇒ cada lote devolve ≤ 150 linhas, longe do teto de 1.000 do PostgREST. */
const LOTE = 150;

/**
 * Dono ATUAL da carteira ELEGÍVEL de cada cliente (cliente → owner_user_id): a régua do ranking do Master,
 * a mesma da positivação e da cadeia de comissão. `eligible = false` (clone de grupo, alias fiscal) é
 * invisível por contrato — todo leitor filtra.
 *
 * Cliente sem linha elegível NÃO entra no mapa: é a verdade do banco (sem carteira). Já a falha de leitura
 * LANÇA — `error` ou `data` nula sem `error` —, porque tratá-la como "sem carteira" mandaria a venda para
 * "Sem vendedor atribuído": veredito sobre o que ninguém leu (classe #1338→#1564).
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md §5.2
 */
export async function fetchDonosCarteira(clienteIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(clienteIds)];
  const donos = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const { data, error } = await supabase
      .from('carteira_assignments')
      .select('customer_user_id, owner_user_id')
      .eq('eligible', true)
      .in('customer_user_id', lote);
    if (error) throw new Error(`carteira_assignments (donos): ${error.message}`);
    if (data == null) throw new Error('carteira_assignments (donos): data null sem error — malformada, não é fim');
    for (const r of data) donos.set(r.customer_user_id, r.owner_user_id);
  }
  return donos;
}
```

(Não use o `chunk` de `@/lib/carteira/escopo-clientes`. Ele traria junto `@/lib/scoring/margin` e
`@/lib/scoring/churn` por causa de um laço de três linhas.)

- [ ] **Passo 4: rodar e ver passar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts; echo "EXIT=$?"
```

Esperado: `8 passed` e `EXIT=0`.

- [ ] **Passo 5: commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add src/lib/dashboard/fetch-donos-carteira.ts src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts
git commit -m "feat(dashboard): fetchDonosCarteira — dono atual da carteira elegível em lotes de 150; falha lança [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 2: `fetchPedidosMTD` traz o `customer_user_id`

**Arquivos:**
- Modificar: `src/lib/dashboard/fetch-pedidos-mtd.ts:5-10` (tipo) e `:28` (select)
- Criar: `src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts`

**Interfaces:**
- Produz: `PedidoMTDRow` ganha `customer_user_id: string | null`. Nesta tarefa o `created_by` FICA, porque o hook
  ainda o lê; ele sai na Tarefa 3.

- [ ] **Passo 1: escrever o teste que falha**

```ts
// src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * O ranking do Master credita o pedido ao dono da carteira do CLIENTE (spec 2026-10-06). Sem o
 * `customer_user_id` na página, todo pedido chegaria sem cliente e o mês inteiro iria, calado, para
 * "Sem vendedor atribuído".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let selects: unknown[] = [];
let resposta: Resposta = { data: [], error: null };

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'is', 'gte', 'lt', 'order', 'range', 'eq']) {
    b[m] = (...args: unknown[]) => {
      if (m === 'select') selects.push(args[0]);
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

import { fetchPedidosMTD } from '../fetch-pedidos-mtd';

beforeEach(() => {
  selects = [];
  resposta = { data: [], error: null };
});

describe('fetchPedidosMTD', () => {
  it('[MTD-COL] a página traz o customer_user_id de cada pedido', async () => {
    const linha = { total: 10, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-01' };
    resposta = { data: [linha], error: null };
    const rows = await fetchPedidosMTD('oben', '2026-10-01', '2026-10-07');
    expect(selects).toHaveLength(1);
    expect(String(selects[0]).split(',').map((c) => c.trim())).toContain('customer_user_id');
    expect(rows).toEqual([linha]);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts
```

Esperado: FAIL em `[MTD-COL]` com `expected [ 'total', 'status', 'created_by', 'order_date_kpi' ] to include
'customer_user_id'`.

- [ ] **Passo 3: implementação mínima** (dois trechos de `src/lib/dashboard/fetch-pedidos-mtd.ts`)

Tipo (linhas 5-10):

```ts
export interface PedidoMTDRow {
  total: number | null;
  status: string | null;
  created_by: string | null;
  /** Cliente do pedido — o ranking credita a venda ao dono da carteira dele. */
  customer_user_id: string | null;
  order_date_kpi: string | null;
}
```

Select (a linha `.select('total, status, created_by, order_date_kpi')`):

```ts
      .select('total, status, created_by, customer_user_id, order_date_kpi')
```

- [ ] **Passo 4: rodar e ver passar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts; echo "EXIT=$?"
```

Esperado: `1 passed` e `EXIT=0`.

- [ ] **Passo 5: commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add src/lib/dashboard/fetch-pedidos-mtd.ts src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts
git commit -m "feat(dashboard): a página MTD traz o customer_user_id — base da régua da carteira [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 3: a régua da carteira de ponta a ponta (`montarRanking` + hook)

A mudança de assinatura cruza três arquivos, por isso eles mudam juntos e o commit sai verde.

**Arquivos:**
- Modificar: `src/lib/dashboard/team-kpis.ts:55-109` (bloco "Ranking de vendedores")
- Modificar: `src/lib/dashboard/__tests__/team-kpis.test.ts:2-11` (imports) e `:55-79` (os 2 testes de
  `montarRanking`)
- Modificar: `src/lib/dashboard/fetch-pedidos-mtd.ts` (sai o `created_by`)
- Modificar: `src/hooks/useTeamRanking.ts`
- Criar: `src/hooks/__tests__/useTeamRanking.carteira.test.tsx`
- Modificar: `src/lib/modulos/manifesto.ts` (o teste novo entra em `testes` do `farmer-inteligencia`)
- Modificar: `docs/agent/database.md` (a lição do `created_by`)

**Interfaces:**
- Consome: `fetchDonosCarteira(clienteIds: string[]): Promise<Map<string, string>>` (Tarefa 1) e
  `PedidoMTDRow.customer_user_id` (Tarefa 2).
- Produz (usadas nas Tarefas 4 e 6):

```ts
export interface OrderRankRow { total: number | null; status: string | null; customer_user_id: string | null }
export interface RankingResult {
  ranking: RankingVendedor[]; // RankingVendedor = { id; nome; receita; pedidos } (não exportado, como hoje)
  carteiraNaoVendedor: { receita: number; pedidos: number };
  naoAtribuido: { receita: number; pedidos: number };
  semAtividade: number;
}
export function montarRanking(
  orders: OrderRankRow[],
  regua: { donoPorCliente: Map<string, string>; vendedores: Map<string, string> },
): RankingResult
export function rankingSemPedido(r: RankingResult): boolean
```

- [ ] **Passo 1: testes da régua que falham** — em `src/lib/dashboard/__tests__/team-kpis.test.ts`, troque o
  bloco de import (linhas 2-11) por:

```ts
import {
  isPedidoValido,
  somarReceita,
  contarAtivos,
  montarRanking,
  rankingSemPedido,
  variacaoPct,
  type OrderRow,
  type AtividadeRow,
  type OrderRankRow,
  type RankingResult,
} from '../team-kpis';
```

e troque os dois testes de `montarRanking` (de `it('montarRanking: atribui por created_by…` até o fim de
`it('montarRanking: vazio → …')`) por:

```ts
  // ── Ranking pelo DONO DA CARTEIRA (spec 2026-10-06) ──────────────────────────────────────────
  // C1/C2 → carteira de vendedor (Regina, Tatyana) · C3 → carteira do master (não vende) · C4 sem
  // carteira elegível. O `created_by` das importadas é carimbo técnico: não decide nada.
  const vendedores = new Map([['V1', 'Regina'], ['V2', 'Tatyana'], ['V3', 'Cris']]);
  const donoPorCliente = new Map([['C1', 'V1'], ['C2', 'V2'], ['C3', 'MASTER']]);
  const regua = { donoPorCliente, vendedores };
  const vazio = { receita: 0, pedidos: 0 };

  it('[RK-A] carteira elegível de vendedor: a venda é do dono', () => {
    const r = montarRanking([{ total: 1000, status: 'faturado', customer_user_id: 'C1' }], regua);
    expect(r.ranking).toEqual([{ id: 'V1', nome: 'Regina', receita: 1000, pedidos: 1 }]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-B] dono que não é farmer/hunter/closer: rodapé próprio, fora do ranking e do não-atribuído', () => {
    const r = montarRanking([{ total: 700, status: 'faturado', customer_user_id: 'C3' }], regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual({ receita: 700, pedidos: 1 });
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-C] cliente sem carteira elegível: sem vendedor atribuído', () => {
    const r = montarRanking([{ total: 300, status: 'enviado', customer_user_id: 'C4' }], regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual({ receita: 300, pedidos: 1 });
  });

  it('[RK-D] created_by de um vendedor não tira a venda do dono da carteira', () => {
    // Variável, não literal: o tipo não tem `created_by` (nenhuma via o lê), e a linha real tem.
    const linhas = [{ total: 500, status: 'faturado', customer_user_id: 'C2', created_by: 'V1' }];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([{ id: 'V2', nome: 'Tatyana', receita: 500, pedidos: 1 }]);
  });

  it('[RK-E] linha do app e importada do mesmo cliente: o mesmo dono', () => {
    const linhas = [
      { total: 100, status: 'faturado', customer_user_id: 'C2', created_by: 'V1' }, // app: lançada pela V1
      { total: 200, status: 'faturado', customer_user_id: 'C2', created_by: 'SISTEMA' }, // importada: carimbo
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([{ id: 'V2', nome: 'Tatyana', receita: 300, pedidos: 2 }]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
  });

  it('[RK-F] status fora do universo de venda não entra em destino nenhum', () => {
    const linhas: OrderRankRow[] = [
      ...STATUS_NAO_VENDA.map((s) => ({ total: 100, status: s, customer_user_id: 'C1' })),
      { total: 100, status: null, customer_user_id: 'C3' },
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([]);
    expect(r.carteiraNaoVendedor).toEqual(vazio);
    expect(r.naoAtribuido).toEqual(vazio);
  });

  it('[RK-G] conservação: ranking + não-vendedor + não-atribuído = todos os pedidos válidos', () => {
    const linhas: OrderRankRow[] = [
      { total: 100, status: 'faturado', customer_user_id: 'C1' },
      { total: 200, status: 'enviado', customer_user_id: 'C3' },
      { total: 300, status: 'faturado', customer_user_id: 'C4' },
      { total: 400, status: 'faturado', customer_user_id: null },
      { total: 999, status: 'cancelado', customer_user_id: 'C1' },
    ];
    const r = montarRanking(linhas, regua);
    const soma = (f: 'receita' | 'pedidos') =>
      r.ranking.reduce((s, v) => s + v[f], 0) + r.carteiraNaoVendedor[f] + r.naoAtribuido[f];
    expect(soma('receita')).toBe(1000);
    expect(soma('pedidos')).toBe(4);
  });

  it('[RK-H] ordena por receita desc e conta o vendedor sem venda em semAtividade', () => {
    const linhas: OrderRankRow[] = [
      { total: 300, status: 'faturado', customer_user_id: 'C1' },
      { total: 1000, status: 'faturado', customer_user_id: 'C2' },
      { total: 500, status: 'enviado', customer_user_id: 'C2' },
    ];
    const r = montarRanking(linhas, regua);
    expect(r.ranking).toEqual([
      { id: 'V2', nome: 'Tatyana', receita: 1500, pedidos: 2 },
      { id: 'V1', nome: 'Regina', receita: 300, pedidos: 1 },
    ]);
    expect(r.semAtividade).toBe(1); // Cris
  });

  it('[RK-I] pedido sem cliente: sem vendedor atribuído', () => {
    const r = montarRanking([{ total: 80, status: 'faturado', customer_user_id: null }], regua);
    expect(r.naoAtribuido).toEqual({ receita: 80, pedidos: 1 });
    expect(r.carteiraNaoVendedor).toEqual(vazio);
  });

  it('[RK-VAZIO] mês sem pedido: os três destinos zerados e todo vendedor em semAtividade', () => {
    expect(montarRanking([], regua)).toEqual({
      ranking: [],
      carteiraNaoVendedor: vazio,
      naoAtribuido: vazio,
      semAtividade: 3,
    });
  });

  it('[RK-SP] rankingSemPedido: só é true com os TRÊS destinos vazios', () => {
    const base: RankingResult = { ranking: [], carteiraNaoVendedor: vazio, naoAtribuido: vazio, semAtividade: 2 };
    expect(rankingSemPedido(base)).toBe(true);
    expect(rankingSemPedido({ ...base, carteiraNaoVendedor: { receita: 50, pedidos: 1 } })).toBe(false);
    expect(rankingSemPedido({ ...base, naoAtribuido: { receita: 50, pedidos: 1 } })).toBe(false);
    expect(rankingSemPedido({ ...base, ranking: [{ id: 'V1', nome: 'Regina', receita: 50, pedidos: 1 }] })).toBe(false);
  });
```

- [ ] **Passo 2: teste do hook que falha** — criar `src/hooks/__tests__/useTeamRanking.carteira.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A ligação do ranking do Master (spec 2026-10-06 §5.3): pedidos do mês → carteira dos clientes →
 * régua. É o hook que decide QUAIS clientes a carteira lê e o que acontece quando ela falha — os dois
 * erros mandariam o mês, calado, para "Sem vendedor atribuído".
 */
type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in']) b[m] = () => b;
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(respostas[tabela]).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'oben' }) }));

const { fetchPedidosMTD, fetchDonosCarteira } = vi.hoisted(() => ({
  fetchPedidosMTD: vi.fn(),
  fetchDonosCarteira: vi.fn(),
}));
vi.mock('@/lib/dashboard/fetch-pedidos-mtd', () => ({ fetchPedidosMTD }));
vi.mock('@/lib/dashboard/fetch-donos-carteira', () => ({ fetchDonosCarteira }));

import { useTeamRanking } from '../useTeamRanking';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTeamRanking(), { wrapper });
}

const PEDIDOS = [
  { total: 100, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-02' },
  { total: 50, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-03' },
  { total: 70, status: 'enviado', customer_user_id: 'C2', order_date_kpi: '2026-10-03' },
  { total: 30, status: 'faturado', customer_user_id: null, order_date_kpi: '2026-10-04' },
];

beforeEach(() => {
  fetchPedidosMTD.mockReset();
  fetchDonosCarteira.mockReset();
  respostas.commercial_roles = {
    data: [
      { user_id: 'V1', commercial_role: 'farmer' },
      { user_id: 'V2', commercial_role: 'farmer' },
    ],
    error: null,
  };
  respostas.profiles = {
    data: [
      { user_id: 'V1', name: 'Regina', razao_social: null },
      { user_id: 'V2', name: 'Tatyana', razao_social: null },
    ],
    error: null,
  };
});

describe('useTeamRanking — pedidos do mês pela carteira', () => {
  it('[HK-IDS] a carteira é lida com os clientes dos pedidos do mês (sem nulo)', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockResolvedValue(new Map([['C1', 'V1'], ['C2', 'V2']]));
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchDonosCarteira).toHaveBeenCalledTimes(1);
    expect(new Set(fetchDonosCarteira.mock.calls[0][0])).toEqual(new Set(['C1', 'C2']));
  });

  it('[HK-REGUA] o resultado credita o dono da carteira e separa o pedido sem cliente', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockResolvedValue(new Map([['C1', 'V1'], ['C2', 'V2']]));
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      ranking: [
        { id: 'V1', nome: 'Regina', receita: 150, pedidos: 2 },
        { id: 'V2', nome: 'Tatyana', receita: 70, pedidos: 1 },
      ],
      carteiraNaoVendedor: { receita: 0, pedidos: 0 },
      naoAtribuido: { receita: 30, pedidos: 1 },
      semAtividade: 0,
    });
  });

  it('[HK-FALHA] carteira que falha derruba o ranking (card "Indisponível"), nunca "Sem vendedor atribuído"', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockRejectedValue(new Error('carteira_assignments (donos): statement timeout'));
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
```

E registre o teste no manifesto: em `src/lib/modulos/manifesto.ts`, na lista `testes` do módulo
`farmer-inteligencia`, logo depois da linha `      "src/hooks/__tests__/useSinalPositivacao.rotulos.test.tsx",`,
acrescente:

```ts
      "src/hooks/__tests__/useTeamRanking.carteira.test.tsx",
```

- [ ] **Passo 3: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/team-kpis.test.ts src/hooks/__tests__/useTeamRanking.carteira.test.tsx
```

Esperado: FAIL. Em `team-kpis.test.ts`, os `[RK-*]` caem porque a régua velha lê o objeto `regua` como se fosse o
Map: dá asserção errada (tudo em `naoAtribuido`, `semAtividade` NaN) ou `vendedores.has is not a function` nas
linhas com `created_by`. O `[RK-SP]` cai com `rankingSemPedido is not a function`. No hook, `[HK-IDS]` acusa
`fetchDonosCarteira` com 0 chamadas, `[HK-REGUA]` acusa a falta de `carteiraNaoVendedor` e `[HK-FALHA]` estoura o
`waitFor`. Os 5 testes antigos (isPedidoValido ×2, somarReceita, contarAtivos, variacaoPct) continuam verdes.

- [ ] **Passo 4: a régua** — em `src/lib/dashboard/team-kpis.ts`, troque o bloco das linhas 55-109 (do separador
  `// ---…` acima de `// Ranking de vendedores (Master v2)` até a `}` que fecha `montarRanking`) por:

```ts
// ---------------------------------------------------------------------------
// Ranking de vendedores (Master) — pelo DONO DA CARTEIRA do cliente
// ---------------------------------------------------------------------------

export interface OrderRankRow {
  total: number | null;
  status: string | null;
  /** Cliente do pedido: a venda vai para o dono ATUAL da carteira elegível dele. */
  customer_user_id: string | null;
}
interface RankingVendedor {
  id: string;
  nome: string;
  receita: number;
  pedidos: number;
}
export interface RankingResult {
  ranking: RankingVendedor[];
  /** Pedidos válidos de cliente com carteira ELEGÍVEL cujo dono não é vendedor (hoje: o master e o pool órfão). */
  carteiraNaoVendedor: { receita: number; pedidos: number };
  /** Pedidos válidos sem carteira elegível (cliente sem carteira, carteira inelegível, pedido sem cliente). */
  naoAtribuido: { receita: number; pedidos: number };
  /** Vendedores cadastrados sem nenhum pedido válido na janela. */
  semAtividade: number;
}

/**
 * Ranking de vendedores por receita de pedidos válidos, ATRIBUÍDO ao dono ATUAL da carteira ELEGÍVEL do
 * cliente — a régua da positivação e da cadeia de comissão. O `created_by` não entra: na importada ele é
 * carimbo técnico (o 1º staff do `profiles`), não quem vendeu.
 * `donoPorCliente` = cliente → dono, SÓ `eligible`; `vendedores` = userId → nome (commercial_role
 * farmer/hunter/closer). Os dois vão NOMEADOS: são do mesmo tipo, e trocá-los compilaria.
 * Dono fora de `vendedores` → `carteiraNaoVendedor`; sem dono → `naoAtribuido`. Ordena por receita desc;
 * vendedor sem pedido entra em `semAtividade`.
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
 */
export function montarRanking(
  orders: OrderRankRow[],
  { donoPorCliente, vendedores }: { donoPorCliente: Map<string, string>; vendedores: Map<string, string> },
): RankingResult {
  const acc = new Map<string, { receita: number; pedidos: number }>();
  const carteiraNaoVendedor = { receita: 0, pedidos: 0 };
  const naoAtribuido = { receita: 0, pedidos: 0 };
  for (const o of orders) {
    if (!isPedidoValido(o.status)) continue;
    const v = o.total ?? 0;
    const dono = o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined;
    if (dono !== undefined && vendedores.has(dono)) {
      const cur = acc.get(dono) ?? { receita: 0, pedidos: 0 };
      cur.receita += v;
      cur.pedidos += 1;
      acc.set(dono, cur);
      continue;
    }
    const balde = dono === undefined ? naoAtribuido : carteiraNaoVendedor;
    balde.receita += v;
    balde.pedidos += 1;
  }
  const ranking = [...acc.entries()]
    .map(([id, a]) => ({ id, nome: vendedores.get(id) ?? 'Vendedor', receita: a.receita, pedidos: a.pedidos }))
    .sort((a, b) => b.receita - a.receita);
  return {
    ranking,
    carteiraNaoVendedor,
    naoAtribuido,
    semAtividade: vendedores.size - ranking.length,
  };
}

/**
 * O card se esconde só quando NENHUM dos três destinos tem pedido: um mês só de carteira de não-vendedor
 * (ex.: dia 1 com um pedido do pool órfão) é um mês COM venda e precisa aparecer.
 */
export function rankingSemPedido(r: RankingResult): boolean {
  return r.ranking.length === 0 && r.carteiraNaoVendedor.pedidos === 0 && r.naoAtribuido.pedidos === 0;
}
```

- [ ] **Passo 5: a leitura do mês perde o `created_by`** — em `src/lib/dashboard/fetch-pedidos-mtd.ts`:

```ts
export interface PedidoMTDRow {
  total: number | null;
  status: string | null;
  /** Cliente do pedido — o ranking credita a venda ao dono da carteira dele. */
  customer_user_id: string | null;
  order_date_kpi: string | null;
}
```

```ts
      .select('total, status, customer_user_id, order_date_kpi')
```

- [ ] **Passo 6: o hook** — `src/hooks/useTeamRanking.ts`. Troque o import da régua e acrescente o da carteira:

```ts
import { fetchPedidosMTD } from '@/lib/dashboard/fetch-pedidos-mtd';
import { fetchDonosCarteira } from '@/lib/dashboard/fetch-donos-carteira';
import { montarRanking, type RankingResult } from '@/lib/dashboard/team-kpis';
```

troque o docblock logo acima de `export function useTeamRanking()` por:

```ts
/**
 * Ranking de vendedores do mês (MTD) pro dashboard Master, escopado na empresa do switcher.
 * Atribuição pelo DONO ATUAL da carteira ELEGÍVEL do cliente do pedido (a régua da positivação e da
 * comissão). Dono que não é farmer/hunter/closer → "carteira de não-vendedor"; cliente sem carteira →
 * "não atribuído". O `created_by` não entra: na importada é carimbo técnico do importador.
 * Receita = pedidos válidos, paginada (não trunca). Read-only; pedidos e carteira LANÇAM em erro — o card
 * mostra "Indisponível", nunca "Sem vendedor atribuído" por falha de leitura.
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
 */
```

e troque o fim do `queryFn` (de `// Pedidos MTD (paginado, lança em erro).` até o `);` que fecha o
`return montarRanking(…)`) por:

```ts
      // Pedidos MTD (paginado, lança em erro) → dono da carteira de cada cliente (lança em erro).
      const orders = await fetchPedidosMTD(selection, mesInicio, amanha);
      const clienteIds = orders.map((o) => o.customer_user_id).filter((id): id is string => id != null);
      const donoPorCliente = await fetchDonosCarteira(clienteIds);
      return montarRanking(
        orders.map((o) => ({ total: o.total, status: o.status, customer_user_id: o.customer_user_id })),
        { donoPorCliente, vendedores },
      );
```

- [ ] **Passo 7: rodar e ver passar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/lib/dashboard/__tests__/team-kpis.test.ts src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts src/hooks/__tests__/useTeamRanking.carteira.test.tsx; echo "EXIT=$?"
heavy bun run typecheck:app; echo "EXIT_TC=$?"
```

Esperado: todos os testes passam (16 em `team-kpis`, 1 em `fetch-pedidos-mtd`, 3 no hook), `EXIT=0` e
`EXIT_TC=0`. O card ainda compila: ele lê `ranking`, `naoAtribuido` e `semAtividade`, que continuam existindo.

- [ ] **Passo 8: registrar a lição em `docs/agent/database.md`** — acrescente um bullet logo DEPOIS do bullet que
  começa com `- **BFLA de \`sales_orders\` FECHADO pelo eixo do VERBO`:

```markdown
- **`sales_orders.created_by` da IMPORTADA é carimbo técnico, NÃO autoria (medido 2026-10-06).** O `omie-vendas-sync` (bloco `// System user for created_by` do `sync_pedidos`) grava o 1º `profiles WHERE is_employee` (`LIMIT 1` sem `ORDER BY`) em toda linha com `hash_payload 'omie_*'` — set+out/26: 100% numa farmer só. "Quem vendeu" = **dono ATUAL da carteira elegível** do `customer_user_id` (ranking do Master, positivação, comissão); atividade de vendedor = linha do app (`hash_payload IS NULL`). Leitores de `created_by` em prod: 0 policy, 0 view, só o escritor `criar_pedidos_com_itens`. Trocar o carimbo é outra entrega (coluna `NOT NULL` sem default). → `docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md`
```

- [ ] **Passo 9: commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add src/lib/dashboard/team-kpis.ts src/lib/dashboard/__tests__/team-kpis.test.ts src/lib/dashboard/fetch-pedidos-mtd.ts src/hooks/useTeamRanking.ts src/hooks/__tests__/useTeamRanking.carteira.test.tsx src/lib/modulos/manifesto.ts docs/agent/database.md
git commit -m "feat(dashboard): o ranking do Master credita o dono da carteira, não o created_by — carteira de não-vendedor separada [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 4: o card mostra a régua

**Arquivos:**
- Modificar: `src/components/dashboard/RankingVendedoresCard.tsx` (o arquivo inteiro: docblock, import, esconder,
  subtítulo e rodapé)
- Criar: `src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx` (dono:
  `src/components/dashboard/**`, nada a registrar)

**Interfaces:**
- Consome: `rankingSemPedido(r: RankingResult): boolean` e `RankingResult` (Tarefa 3), `useTeamRanking()`.

- [ ] **Passo 1: escrever o teste que falha**

```tsx
// src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RankingResult } from '@/lib/dashboard/team-kpis';

/**
 * O card do ranking do Master pela régua da carteira (spec 2026-10-06 §5.4): diz a régua no subtítulo,
 * separa "Carteira de não-vendedor" de "Sem vendedor atribuído" e só some quando nenhum dos três destinos
 * tem pedido.
 */
let estado: { data?: RankingResult; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
vi.mock('@/hooks/useTeamRanking', () => ({ useTeamRanking: () => estado }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ selection: 'oben', companyInfo: { shortName: 'Oben' } }),
}));

import { RankingVendedoresCard } from '../RankingVendedoresCard';

const vazio = { receita: 0, pedidos: 0 };
function comDados(over: Partial<RankingResult>) {
  estado = {
    isLoading: false,
    isError: false,
    data: { ranking: [], carteiraNaoVendedor: vazio, naoAtribuido: vazio, semAtividade: 0, ...over },
  };
}

describe('RankingVendedoresCard — régua da carteira', () => {
  it('[CARD-SUB] o subtítulo diz a régua', () => {
    comDados({ ranking: [{ id: 'V1', nome: 'Regina', receita: 1000, pedidos: 2 }] });
    render(<RankingVendedoresCard />);
    expect(screen.getByText(/por dono da carteira · Oben/)).toBeTruthy();
    expect(screen.queryByText(/quem lançou/)).toBeNull();
  });

  it('[CARD-SO-NV] mês só com carteira de não-vendedor: o card aparece, com a linha e o porquê', () => {
    comDados({ carteiraNaoVendedor: { receita: 1234.5, pedidos: 3 } });
    render(<RankingVendedoresCard />);
    const linha = screen.getByText(/Carteira de não-vendedor:/);
    expect(linha.textContent).toContain('3 ped.');
    expect(linha.getAttribute('title')).toContain('farmer, hunter nem closer');
  });

  it('[CARD-ORDEM] não-vendedor vem antes de "Sem vendedor atribuído", em linhas distintas', () => {
    comDados({ carteiraNaoVendedor: { receita: 200, pedidos: 1 }, naoAtribuido: { receita: 300, pedidos: 2 } });
    const { container } = render(<RankingVendedoresCard />);
    const texto = container.textContent ?? '';
    const nv = texto.indexOf('Carteira de não-vendedor:');
    expect(nv).toBeGreaterThan(-1);
    expect(nv).toBeLessThan(texto.indexOf('Sem vendedor atribuído:'));
    expect(screen.getByText(/Carteira de não-vendedor:/)).not.toBe(screen.getByText(/Sem vendedor atribuído:/));
  });

  it('[CARD-VAZIO] sem pedido em destino nenhum: o card some', () => {
    comDados({ semAtividade: 2 });
    const { container } = render(<RankingVendedoresCard />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx
```

Esperado: FAIL em `[CARD-SUB]` (ainda diz "por quem lançou o pedido"), `[CARD-SO-NV]` (o card some, porque
`ranking` e `naoAtribuido` estão vazios) e `[CARD-ORDEM]` (a linha não existe). O `[CARD-VAZIO]` passa.

- [ ] **Passo 3: implementação** — `src/components/dashboard/RankingVendedoresCard.tsx` inteiro:

```tsx
/**
 * Ranking de vendedores do mês (MTD) no dashboard Master. Read-only, escopo da empresa do switcher.
 * Ordena por receita de pedidos válidos, atribuída ao DONO ATUAL da carteira elegível do cliente (a régua
 * da positivação e da comissão — o `created_by` da importada é carimbo técnico, não quem vendeu).
 * O rodapé separa "carteira de não-vendedor" (dono sem papel de venda) de "sem vendedor atribuído"
 * (cliente sem carteira) e expõe "sem pedido no mês". Some só sem pedido em nenhum dos três destinos.
 * Conversão de visita fica fora (route_visits não tem account → seria cross-empresa).
 * Specs: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 *        docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
 */
import { Card, CardHeader } from '@/components/ui/card';
import { Trophy, Loader2 } from 'lucide-react';
import { useTeamRanking } from '@/hooks/useTeamRanking';
import { useCompany } from '@/contexts/CompanyContext';
import { formatBRL } from '@/components/customer360/format';
import { rankingSemPedido } from '@/lib/dashboard/team-kpis';

const TOP = 8;

export function RankingVendedoresCard() {
  const { data, isLoading, isError } = useTeamRanking();
  const { selection, companyInfo } = useCompany();
  const escopo = selection === 'all' ? 'todas as empresas' : companyInfo.shortName;

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (isError) {
    return (
      <Card className="p-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4" />
          Ranking de vendedores
        </div>
        <p className="mt-2">Indisponível no momento.</p>
      </Card>
    );
  }
  if (!data) return null;
  if (rankingSemPedido(data)) return null; // nenhum dos 3 destinos tem pedido no mês

  const { ranking, carteiraNaoVendedor, naoAtribuido, semAtividade } = data;
  const visiveis = ranking.slice(0, TOP);
  const restante = ranking.length - visiveis.length;
  const temRodape =
    restante > 0 || carteiraNaoVendedor.pedidos > 0 || naoAtribuido.pedidos > 0 || semAtividade > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-muted-foreground" />
          <div>
            <h2 className="text-base font-medium">Ranking de vendedores · mês</h2>
            <p className="text-2xs text-muted-foreground">por dono da carteira · {escopo}</p>
          </div>
        </div>
      </CardHeader>

      <div className="divide-y divide-border">
        {visiveis.map((v, i) => (
          <div key={v.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="w-5 text-center text-xs font-medium text-muted-foreground tabular-nums">{i + 1}</div>
            <div className="flex-1 min-w-0 text-sm font-medium truncate">{v.nome}</div>
            <div className="text-2xs text-muted-foreground tabular-nums">{v.pedidos} ped.</div>
            <div className="text-sm font-medium tabular-nums w-28 text-right">{formatBRL(v.receita)}</div>
          </div>
        ))}
      </div>

      {temRodape && (
        <div className="px-4 pb-3 pt-2 space-y-0.5 text-2xs text-muted-foreground">
          {restante > 0 && (
            <div>
              +{restante} vendedor{restante > 1 ? 'es' : ''} com pedido
            </div>
          )}
          {carteiraNaoVendedor.pedidos > 0 && (
            <div title="Dono da carteira sem papel farmer, hunter nem closer — hoje o master e o pool órfão.">
              Carteira de não-vendedor: {formatBRL(carteiraNaoVendedor.receita)} · {carteiraNaoVendedor.pedidos} ped.
            </div>
          )}
          {naoAtribuido.pedidos > 0 && (
            <div title="Cliente sem carteira elegível (ou pedido sem cliente).">
              Sem vendedor atribuído: {formatBRL(naoAtribuido.receita)} · {naoAtribuido.pedidos} ped.
            </div>
          )}
          {semAtividade > 0 && (
            <div>
              {semAtividade} vendedor{semAtividade > 1 ? 'es' : ''} sem pedido no mês
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx; echo "EXIT=$?"
```

Esperado: `4 passed` e `EXIT=0`.

- [ ] **Passo 5: commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add src/components/dashboard/RankingVendedoresCard.tsx src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx
git commit -m "feat(dashboard): o card do ranking diz a régua — por dono da carteira, com a carteira de não-vendedor no rodapé [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 5: o tile deixa de contar o carimbo da importada

**Arquivos:**
- Modificar: `src/hooks/useTeamKpis.ts:40-45` (q2)
- Modificar: `src/lib/gates/universo-pedidos-ts-registro.ts:66` (a forma registrada da query)
- Criar: `src/hooks/__tests__/useTeamKpis.atividade.test.tsx`
- Modificar: `src/lib/modulos/manifesto.ts` (o teste novo entra em `testes` do `farmer-inteligencia`)

**Interfaces:** nenhuma nova. `TeamKpis` não muda.

- [ ] **Passo 1: escrever o teste que falha** — criar `src/hooks/__tests__/useTeamKpis.atividade.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Tile "vendedores ativos" do Master (spec 2026-10-06 §5.5): pedido IMPORTADO não é atividade. O
 * `created_by` dele é carimbo técnico (o 1º staff do `profiles`), e contava um "vendedor ativo" que não
 * lançou nada. Só a linha nascida no app (sem `hash_payload`) conta.
 */
type Chamada = { tabela: string; metodo: string; args: unknown[] };
let chamadas: Chamada[] = [];

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'gte', 'eq']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ tabela, metodo: m, args });
      return b;
    };
  }
  b.then = (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'oben' }) }));
vi.mock('@/lib/dashboard/fetch-pedidos-mtd', () => ({ fetchPedidosMTD: async () => [] }));

import { useTeamKpis } from '../useTeamKpis';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTeamKpis(), { wrapper });
}

beforeEach(() => {
  chamadas = [];
});

describe('useTeamKpis — atividade de vendedor', () => {
  it('[TK-HASH] a atividade de pedido lê só a linha do app (hash_payload nulo), sem perder o deleted_at', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const doPedido = chamadas.filter((c) => c.tabela === 'sales_orders');
    expect(doPedido).toContainEqual({ tabela: 'sales_orders', metodo: 'is', args: ['hash_payload', null] });
    expect(doPedido).toContainEqual({ tabela: 'sales_orders', metodo: 'is', args: ['deleted_at', null] });
  });
});
```

E no manifesto, na lista `testes` do `farmer-inteligencia`, logo depois da linha
`      "src/hooks/__tests__/useTeamRanking.carteira.test.tsx",` (Tarefa 3), acrescente:

```ts
      "src/hooks/__tests__/useTeamKpis.atividade.test.tsx",
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/hooks/__tests__/useTeamKpis.atividade.test.tsx
```

Esperado: FAIL em `[TK-HASH]`, porque a lista de chamadas não contém `is('hash_payload', null)`.

- [ ] **Passo 3: o filtro** — em `src/hooks/useTeamKpis.ts`, troque as linhas 40-45 (de
  `// q2 — vendedores que lançaram pedido nos últimos 7d` até `.gte('created_at', inicio7dUTC);`) por:

```ts
      // q2 — vendedores que lançaram pedido NO APP nos últimos 7d (escopo de empresa). A importada
      // (hash_payload 'omie_*') fica fora: o created_by dela é carimbo técnico do importador (o 1º staff
      // do profiles), não quem vendeu — contava um "vendedor ativo" que não lançou nada.
      let qSales = supabase
        .from('sales_orders')
        .select('created_by, created_at')
        .is('deleted_at', null)
        .is('hash_payload', null)
        .gte('created_at', inicio7dUTC);
```

- [ ] **Passo 4: ver o gate do universo acusar a forma nova** (ele é o registro dessa query)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/__tests__/universo-pedidos-ts-gate.test.ts
```

Esperado: FAIL nos itens de forma nova/órfã, citando
`src/hooks/useTeamKpis.ts · select·is(deleted_at)·is(hash_payload)·gte(created_at)·eq(account)`. Se a forma
citada for outra, use a citada no Passo 5.

- [ ] **Passo 5: atualizar o registro** — em `src/lib/gates/universo-pedidos-ts-registro.ts`, a linha 66 passa a
  ser:

```ts
  { arquivo: 'src/hooks/useTeamKpis.ts', forma: 'select·is(deleted_at)·is(hash_payload)·gte(created_at)·eq(account)', categoria: 'proposito', motivo: 'atividade de vendedor (quem CRIOU pedido NO APP em 7d; a importada sai por hash_payload nulo — o created_by dela é carimbo do importador): orçamento é atividade; a receita do mesmo hook vem de fetchPedidosMTD' },
```

- [ ] **Passo 6: rodar e ver passar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bunx vitest run src/hooks/__tests__/useTeamKpis.atividade.test.tsx src/__tests__/universo-pedidos-ts-gate.test.ts src/__tests__/leitura-single-shot-gate.test.ts src/lib/modulos/__tests__/manifesto.gate.test.ts; echo "EXIT=$?"
```

Esperado: tudo verde e `EXIT=0`.

- [ ] **Passo 7: commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add src/hooks/useTeamKpis.ts src/lib/gates/universo-pedidos-ts-registro.ts src/hooks/__tests__/useTeamKpis.atividade.test.tsx src/lib/modulos/manifesto.ts
git commit -m "fix(dashboard): vendedores ativos deixa de contar a importada — o created_by dela é carimbo do importador [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 6: falsificação — cada camada sozinha, nos dois locales

**Arquivos:**
- Criar: `scripts/falsificar-ranking-carteira.sh` (mesmo idioma do `scripts/falsificar-individuais.sh`, mais
  estrito: o vermelho tem de cair EXATAMENTE nos marcadores declarados, sem nenhum a mais e sem nenhum a menos)

- [ ] **Passo 1: o script**

```bash
#!/usr/bin/env bash
# Falsificação do ranking do Master pela carteira (spec 2026-10-06-ranking-atribuicao-por-carteira §6).
#
# Sabota UMA camada por vez e exige VERMELHO exatamente nos testes que a sabotagem declara: todos eles,
# e nenhum outro. Sabotagem verde = teste inalcançado ou redundante; vermelho fora da lista = asserção
# que casa por acidente; arquivo de teste que nem carrega conta como vermelho ERRADO.
#
# ⚠️ O CONTROLE roda na MESMA invocação, antes do 1º replace, e aborta se não estiver verde
# (docs/historico/falsificacao-sem-linha-de-base.md). A bateria inteira roda em LC_ALL=C E em
# pt_BR.UTF-8 (#1483); os testes casam por marcador ASCII entre colchetes ([RK-D]…), com grep -F.
#
# Uso:  bash scripts/falsificar-ranking-carteira.sh   (commite antes: restaurar() é git checkout --)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FONTES=(
  src/lib/dashboard/team-kpis.ts
  src/lib/dashboard/fetch-donos-carteira.ts
  src/lib/dashboard/fetch-pedidos-mtd.ts
  src/hooks/useTeamRanking.ts
  src/hooks/useTeamKpis.ts
  src/components/dashboard/RankingVendedoresCard.tsx
)
ALVOS=(
  src/lib/dashboard/__tests__/team-kpis.test.ts
  src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts
  src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts
  src/hooks/__tests__/useTeamRanking.carteira.test.tsx
  src/hooks/__tests__/useTeamKpis.atividade.test.tsx
  src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx
)

TMP="$(mktemp -d)"
restaurar() { git checkout -- "${FONTES[@]}" 2>/dev/null || true; }
trap 'restaurar; rm -rf "$TMP"' EXIT

# Estado limpo é PRÉ-REQUISITO: restaurar() descartaria edição não commitada junto com a sabotagem.
if ! git diff --quiet -- "${FONTES[@]}" "${ALVOS[@]}"; then
  echo "ABORTADO: há edição não commitada nas fontes ou nos testes. Commite antes de falsificar."
  exit 2
fi

# Roda os ALVOS e imprime uma linha por teste: "P<TAB>nome" (passou), "F<TAB>nome" (falhou),
# "S<TAB>nome" (nem passou nem falhou) ou "Q<TAB>arquivo" (o arquivo nem carregou). Sem relatório JSON
# → "Q": vitest que nem subiu não pode virar "zero falhas".
rodar() {
  local json="$TMP/r.json"
  rm -f "$json"
  bunx vitest run "${ALVOS[@]}" --reporter=json --outputFile="$json" >"$TMP/saida.txt" 2>&1
  if [ ! -s "$json" ]; then
    printf 'Q\t__SEM_RELATORIO__\n'
    return 0
  fi
  PYTHONIOENCODING=utf-8 python3 - "$json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    d = json.load(f)
for arq in d.get('testResults', []):
    testes = arq.get('assertionResults', [])
    if arq.get('status') == 'failed' and not testes:
        print('Q\t' + arq.get('name', '?'))
    for t in testes:
        st = t.get('status')
        marca = 'P' if st == 'passed' else ('F' if st == 'failed' else 'S')
        print(marca + '\t' + t.get('fullName', '(sem nome)'))
PY
}

controle() {
  local n
  rodar >"$TMP/controle.txt"
  n="$(grep -c '^P' "$TMP/controle.txt" || true)"
  if grep -qv '^P' "$TMP/controle.txt" || [ "$n" -eq 0 ]; then
    echo "ABORTADO (LC_ALL=$LC_ALL): o controle não está verde — nenhuma sabotagem provaria nada."
    grep -v '^P' "$TMP/controle.txt" | sed 's/^/    /'
    exit 1
  fi
  echo "controle verde (LC_ALL=$LC_ALL): $n testes"
}

falhou=0
# sabotar <rótulo> <arquivo> <trecho velho> <trecho novo> <marcadores que TÊM de avermelhar, por vírgula>
sabotar() {
  local rotulo="$1" arquivo="$2" velho="$3" novo="$4" esperados="$5"
  local -a marcas
  local m linha vermelhos faltou="" sobrou="" casou
  IFS=',' read -r -a marcas <<<"$esperados"
  # O marcador declarado tem de EXISTIR no controle — senão "faltou" seria sobre um teste fantasma.
  for m in "${marcas[@]}"; do
    if ! grep -qF -- "$m" "$TMP/controle.txt"; then
      echo "✗ $rotulo — o marcador $m não existe no controle"
      falhou=1
      return
    fi
  done
  # Aplicar tem de ser VERIFICADO: padrão que não casa deixaria a fonte intacta e a suíte verde.
  if ! python3 - "$arquivo" "$velho" "$novo" <<'PY'
import io, sys
p, velho, novo = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
if s.count(velho) != 1:
    print('  padrão casou %d vez(es) — sabotagem NÃO aplicada' % s.count(velho))
    sys.exit(1)
io.open(p, 'w', encoding='utf-8').write(s.replace(velho, novo))
PY
  then
    echo "✗ $rotulo — NÃO APLICOU"
    falhou=1
    restaurar
    return
  fi
  rodar >"$TMP/sab.txt"
  restaurar
  vermelhos="$(grep -v '^P' "$TMP/sab.txt" || true)"
  if [ -z "$vermelhos" ]; then
    echo "✗ $rotulo — SEM DENTE: sabotei e a suíte seguiu verde"
    falhou=1
    return
  fi
  for m in "${marcas[@]}"; do
    printf '%s\n' "$vermelhos" | grep -qF -- "$m" || faltou="$faltou $m"
  done
  while IFS= read -r linha; do
    casou=0
    for m in "${marcas[@]}"; do
      case "$linha" in *"$m"*) casou=1 ;; esac
    done
    [ "$casou" -eq 1 ] || sobrou="$sobrou | $linha"
  done <<<"$vermelhos"
  if [ -n "$faltou" ] || [ -n "$sobrou" ]; then
    echo "✗ $rotulo — vermelho DIFERENTE do declarado (faltou:${faltou:- nada} · sobrou:${sobrou:- nada})"
    falhou=1
  else
    echo "✓ $rotulo — vermelho exatamente em $esperados"
  fi
}

for LOC in C pt_BR.UTF-8; do
  if [ "$LOC" != C ] && ! locale -a 2>/dev/null | grep -qx "$LOC"; then
    echo "ABORTADO: o locale $LOC não existe nesta máquina — a falsificação exige os dois."
    exit 2
  fi
  export LC_ALL="$LOC"
  echo
  echo "== LC_ALL=$LC_ALL =="
  controle

  sabotar 'S1 carteira sem o filtro eligible' src/lib/dashboard/fetch-donos-carteira.ts \
    "      .eq('eligible', true)"$'\n' '' \
    '[FD-ELIG]'
  sabotar 'S2 credito por created_by' src/lib/dashboard/team-kpis.ts \
    'const dono = o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined;' \
    'const dono = (o as { created_by?: string }).created_by ?? (o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined);' \
    '[RK-D],[RK-E]'
  # shellcheck disable=SC2016  # `${...}` aqui é o LITERAL do template TS a casar, não expansão de shell.
  sabotar 'S3 erro da carteira vira mapa' src/lib/dashboard/fetch-donos-carteira.ts \
    'if (error) throw new Error(`carteira_assignments (donos): ${error.message}`);' \
    'if (error) return donos;' \
    '[FD-ERRO],[FD-ERRO-LOTE2]'
  sabotar 'S4 data nula vira fim' src/lib/dashboard/fetch-donos-carteira.ts \
    'if (data == null) throw' \
    'if (data == null) break; if (false) throw' \
    '[FD-NULO]'
  sabotar 'S5 nao-vendedor somado em naoAtribuido' src/lib/dashboard/team-kpis.ts \
    'const balde = dono === undefined ? naoAtribuido : carteiraNaoVendedor;' \
    'const balde = naoAtribuido;' \
    '[RK-B]'
  sabotar 'S6 rankingSemPedido olha 2 destinos' src/lib/dashboard/team-kpis.ts \
    'r.ranking.length === 0 && r.carteiraNaoVendedor.pedidos === 0 && r.naoAtribuido.pedidos === 0' \
    'r.ranking.length === 0 && r.naoAtribuido.pedidos === 0' \
    '[RK-SP],[CARD-SO-NV]'
  sabotar 'S6b card volta a olhar 2 destinos' src/components/dashboard/RankingVendedoresCard.tsx \
    'if (rankingSemPedido(data)) return null;' \
    'if (data.ranking.length === 0 && data.naoAtribuido.pedidos === 0) return null;' \
    '[CARD-SO-NV]'
  sabotar 'S7 tile sem o filtro de hash_payload' src/hooks/useTeamKpis.ts \
    "        .is('hash_payload', null)"$'\n' '' \
    '[TK-HASH]'
  sabotar 'S8 hook manda lista vazia a carteira' src/hooks/useTeamRanking.ts \
    'fetchDonosCarteira(clienteIds)' \
    'fetchDonosCarteira([])' \
    '[HK-IDS]'
  sabotar 'S9 hook engole a falha da carteira' src/hooks/useTeamRanking.ts \
    'fetchDonosCarteira(clienteIds)' \
    'fetchDonosCarteira(clienteIds).catch(() => new Map<string, string>())' \
    '[HK-FALHA]'
  sabotar 'S10 pagina do mes sem customer_user_id' src/lib/dashboard/fetch-pedidos-mtd.ts \
    "'total, status, customer_user_id, order_date_kpi'" \
    "'total, status, order_date_kpi'" \
    '[MTD-COL]'
done

echo
if [ "$falhou" -eq 0 ]; then
  echo "TODAS AS SABOTAGENS TEM DENTE NOS DOIS LOCALES"
  exit 0
fi
echo "HA SABOTAGEM SEM DENTE OU COM VERMELHO ERRADO — veja acima"
exit 1
```

- [ ] **Passo 2: shellcheck**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
bun run lint:shell; echo "EXIT=$?"
```

Esperado: `EXIT=0`. Se o shellcheck apontar algo, corrija no script. Não afrouxe a regra.

- [ ] **Passo 3: commit ANTES de falsificar** (o `restaurar()` é `git checkout --`)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add scripts/falsificar-ranking-carteira.sh
git commit -m "test(dashboard): falsificação do ranking pela carteira — 11 sabotagens, vermelho exato, 2 locales [money-path]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git status --short; echo "EXIT=$?"
```

Esperado: `git status --short` vazio.

- [ ] **Passo 4: rodar e guardar o recibo**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
R=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-competent-mestorf-41ead1/316f250b-164f-4a15-b95c-6ed4cbdeac8e/scratchpad/falsificacao-ranking.txt
heavy bash scripts/falsificar-ranking-carteira.sh >"$R" 2>&1; echo "EXIT=$?"; tail -c 3000 "$R"
git status --short; echo "EXIT_ST=$?"
```

Esperado: nos dois blocos (`== LC_ALL=C ==` e `== LC_ALL=pt_BR.UTF-8 ==`), `controle verde`, 11 linhas `✓`, a
última linha `TODAS AS SABOTAGENS TEM DENTE NOS DOIS LOCALES`, `EXIT=0`, e `git status --short` vazio (o trap
restaurou). Uma linha `✗` é achado: conserte o TESTE ou a declaração. Se o vermelho cair num marcador não
declarado, decida se ele é coacusador legítimo (declare-o) ou se a sabotagem não está isolada (refaça). Commite e
rode de novo.

---

### Tarefa 7: verificação completa e PR DRAFT

**Arquivos:**
- Criar: `docs/historico/ranking-atribuicao-por-carteira.md`
- Modificar: `docs/historico/README.md` (uma linha na tabela)

- [ ] **Passo 1: base fresca e ninguém entregou o mesmo** (o auto-merge fecha PR em minutos)

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git fetch origin && git rebase origin/main; echo "EXIT=$?"
git grep -n -e 'fetchDonosCarteira' -e 'carteiraNaoVendedor' origin/main -- src; echo "EXIT_GREP=$? (1 = nenhum artefato)"
```

Esperado: `EXIT=0` e `EXIT_GREP=1`. Rebase com conflito: resolva, rode de novo as Tarefas 6 e 7 a partir daqui.

- [ ] **Passo 2: a bateria autoritativa, com exit colado**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
heavy bun run typecheck; echo "EXIT_TYPECHECK=$?"
bun lint; echo "EXIT_LINT=$?"
heavy bun run test; echo "EXIT_TEST=$?"
bunx knip; echo "EXIT_KNIP=$?"
bun run lint:shell; echo "EXIT_SHELL=$?"
```

Esperado: os cinco `EXIT_*=0`. O `test` inclui os gates do manifesto, de fronteiras, do universo e o G6. Se o knip
reprovar, cada achado que cite arquivo deste diff (`git diff --name-only origin/main...HEAD`) é desta entrega e
tem de ser consertado. Achado só em arquivo fora do diff é pré-existente: cole a saída no PR com essa ressalva.

- [ ] **Passo 3: o diário** — criar `docs/historico/ranking-atribuicao-por-carteira.md`:

```markdown
# Ranking do Master pelo dono da carteira (2026-10-06)

**Problema.** O card "Ranking de vendedores · mês" creditava a venda ao `created_by`. Na importada
(`hash_payload 'omie_*'`) esse campo é o carimbo técnico do `omie-vendas-sync`: o 1º `profiles WHERE
is_employee`, com `LIMIT 1` e sem `ORDER BY`. Em set+out/26 isso deu 589 pedidos e R$ 592.547,12, 100% numa farmer
só. O tile "vendedores ativos" contava a mesma farmer como ativa sem ela ter lançado nada.

**Régua (decisão do founder).** A venda vai para o dono ATUAL da carteira ELEGÍVEL do cliente, a mesma régua da
positivação e da cadeia de comissão. Dono sem papel de venda (master, pool órfão) aparece como "Carteira de
não-vendedor"; cliente sem carteira aparece como "Sem vendedor atribuído". A leitura acontece no front
(`fetchDonosCarteira`, lotes de 150, e falha lança).

**Antes → depois (set/26, 528 pedidos válidos, R$ 533.890,89).** Antes, 100% numa farmer só. Depois: Regina 69,0%
(332 ped.), Tatyana 27,4% (175 ped.), carteira de não-vendedor 3,7% (21 ped.) e sem vendedor 0%.

**Lições.**
- `created_by` da importada é carimbo técnico, não autoria (→ `docs/agent/database.md`).
- Comentário em edge instrumentada não é "zero deploy": o `sonda:fingerprint` faz hash dos bytes crus, e um
  comentário abriria pendência DIVERGE_P2. Lição de documentação vai para `docs/agent/`, não para a edge.
- Dois `Map<string, string>` posicionais trocam de lugar sem erro de tipo, por isso viraram um objeto nomeado.

**Prova.** vitest (TDD) e `scripts/falsificar-ranking-carteira.sh` (11 sabotagens, vermelho exato, `LC_ALL=C` e
`pt_BR.UTF-8`). Spec: `docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md`.
```

E em `docs/historico/README.md`, na tabela, logo depois da linha do `app-grava-kpi-no-envio.md`:

```markdown
| [ranking-atribuicao-por-carteira.md](ranking-atribuicao-por-carteira.md) | 2026-10-06: o ranking do Master credita a venda ao dono atual da carteira elegível (a régua da positivação e da comissão), não ao `created_by` — que na importada é carimbo técnico do importador; o rodapé separa carteira de não-vendedor de sem vendedor; o tile de ativos deixa de contar a importada |
```

- [ ] **Passo 4: commit, push e PR DRAFT**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
git add docs/historico/ranking-atribuicao-por-carteira.md docs/historico/README.md
git commit -m "docs(historico): ranking do Master pelo dono da carteira" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin claude/atribuicao-vendas-importadas; echo "EXIT=$?"
```

O corpo do PR vai num arquivo do scratchpad (`$R` do recibo da Tarefa 6). Cole nele as linhas `✓` e a linha final
do recibo, e os cinco `EXIT_*` do Passo 2:

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
B=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-competent-mestorf-41ead1/316f250b-164f-4a15-b95c-6ed4cbdeac8e/scratchpad/pr-body.md
gh pr create --draft --base main --head claude/atribuicao-vendas-importadas --title "feat(dashboard): ranking do Master pelo dono da carteira — o created_by das importadas deixa de decidir quem vendeu [money-path]" --body-file "$B"; echo "EXIT=$?"
```

Conteúdo de `pr-body.md` (os dois blocos marcados como recibo levam a saída real colada):

```markdown
## O quê
O card "Ranking de vendedores · mês" do Master passa a creditar cada pedido válido ao **dono atual da carteira elegível** do cliente, a régua da positivação e da cadeia de comissão. Antes creditava o `created_by`, que nas importadas é o carimbo técnico do `omie-vendas-sync` (`profiles WHERE is_employee LIMIT 1`, sem `ORDER BY`). O rodapé separa **"Carteira de não-vendedor"** (dono sem papel farmer/hunter/closer: o master e o pool órfão) de **"Sem vendedor atribuído"** (cliente sem carteira). O tile "vendedores ativos" deixa de contar a importada: só conta `hash_payload` nulo, que é a linha do app.

## RÉGUA
- **Unidade decisória:** o PEDIDO válido do universo canônico, creditado inteiro ao dono ATUAL da carteira ELEGÍVEL do `customer_user_id`.
- **Onde aparece:** no card do ranking (MasterDashboard) e no tile "vendedores ativos". A mesma carteira decide a positivação e a comissão.
- **Denominador (set/26):** 528 pedidos válidos, R$ 533.890,89, 100% com carteira.
- **Falsificação:** `scripts/falsificar-ranking-carteira.sh`, com 11 sabotagens, vermelho exato e 2 locales.
- **Ordem irreversível:** nenhuma. É só front, e nenhum dado é escrito.

## Antes → depois (set/26, prod)
- Antes: 100% numa farmer só (o carimbo do importador).
- Depois: Regina 69,0% (332 ped.), Tatyana 27,4% (175 ped.), carteira de não-vendedor 3,7% (21 ped.) e sem vendedor 0%.

## Prova
- vitest TDD: `[FD-*]`, `[MTD-COL]`, `[RK-*]`, `[HK-*]`, `[CARD-*]`, `[TK-HASH]`.
- Falsificação: recibo das linhas `✓` dos dois locales e da linha final.
- typecheck · lint · test · knip · lint:shell: recibo dos cinco `EXIT_*=0`.

## Deploy
Só o **Publish** (founder), e depois atualizar o app: o SW só troca de build no clique. Não há migration nem edge. O `omie-vendas-sync` não foi tocado, porque um comentário mudaria o `sonda:fingerprint` e abriria pendência de deploy.

## Riscos aceitos (spec §8)
Pedidos e carteira vêm de dois instantes diferentes; vale o dono atual, não o da data da venda; um par app×importada com cliente diferente pode trocar de dono; quem não é master não lê a carteira inteira. Hoje o tile mostra 0/0, que é o que o app de fato enxerga.

Codex: desenho=? · código=? · extra=nenhum
(desenho: Caminho B na spec §7, cota em 92%. código: adversarial no diff quando a janela reabrir, em 09/10 19:30. O PR fica DRAFT até lá.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Passo 5: ligar o PR ao app e o Auto-fix** — carregar
  `ToolSearch select:mcp__ccd_pr__get_status,mcp__ccd_pr__bind_pr,mcp__ccd_pr__set_monitor`. Chamar `get_status`.
  Se ele não reportar o PR, fazer `bind_pr` com o número. Depois `set_monitor` com `auto_fix` e
  `address_comments` ligados. Nunca ligar auto-merge pelo app.

---

### Tarefa 8: Codex adversarial no diff e revisão com contexto novo

**Arquivos:** os que os achados pedirem (cada conserto com teste e, se for camada nova, uma sabotagem nova no
script).

- [ ] **Passo 1: o Codex, em background, quando a janela reabrir** (a partir de 09/10 19:30). Se o preflight sair
  79 (saldo acima do teto), anote a hora em que a janela reabre e espere. Não insista antes disso.

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
scripts/codex-async.sh -r max - <<'EOF'
Revisão ADVERSARIAL de um diff money-path (ranking de vendedores / atribuição de venda). Responda em pt-BR.
Rode: git diff origin/main...HEAD -- src scripts docs/agent
Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
RÉGUA: unidade = PEDIDO válido do universo canônico (STATUS_NAO_VENDA fora, deleted_at nulo, order_date_kpi no mês de SP), creditado inteiro ao dono ATUAL da carteira ELEGÍVEL (carteira_assignments.eligible = true, UNIQUE(customer_user_id)) do customer_user_id. Dono fora de farmer/hunter/closer → "Carteira de não-vendedor"; sem carteira → "Sem vendedor atribuído". Falha de leitura → erro (card "Indisponível"), nunca um destino.
Ataque, item por item: (1) caminho em que falha/ausência vira "Sem vendedor atribuído" ou R$ 0; (2) truncamento PostgREST (lotes de 150 no .in, paginação do mês); (3) dupla contagem ou perda (Σ dos 3 destinos = Σ válidos); (4) o filtro hash_payload IS NULL do tile esconder atividade real; (5) a falsificação (scripts/falsificar-ranking-carteira.sh) aprovar algo sem dente; (6) RLS: quem abre o card sem ler a carteira inteira.
Para cada achado: arquivo:linha, cenário concreto (entrada → saída errada) e severidade. Sem achado num item, escreva "nenhum" nele.
EOF
```

(Rodar com `run_in_background: true`. Quem avisa do fim é a notificação, então não fique consultando.)

- [ ] **Passo 2: revisão com contexto novo, em paralelo** — despachar um subagente novo (Agent,
  `general-purpose`, `model: "opus"`) com: "Responda em pt-BR. Revise adversarialmente o diff
  `git diff origin/main...HEAD` do worktree `/Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas`
  contra a spec `docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md` e o plano
  `docs/superpowers/plans/2026-10-06-ranking-atribuicao-por-carteira.md`. Procure: fabricação de atribuição,
  ausência virando zero, teste que passa por vacuidade, sabotagem sem dente, texto de UI fora do combinado. Devolva
  só achados com arquivo:linha e cenário concreto."

- [ ] **Passo 3: tratar os achados** — conserto pede teste vermelho, depois verde, depois commit. Camada nova pede
  sabotagem nova no script e nova rodada da Tarefa 6. Achado recusado ganha uma linha no PR com o porquê.

- [ ] **Passo 4: registrar o Codex no corpo do PR** — a linha passa a ser
  `Codex: desenho=? · código=<nome do rollout>·<pp> · extra=nenhum`, com o rollout e o saldo que o
  `codex-async.sh` imprimir. Use `gh pr edit "$PR" --body-file "$B"`, com `PR=$(gh pr view --json number --jq .number)`.

- [ ] **Passo 5: tirar do DRAFT e confirmar o merge**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
PR=$(gh pr view --json number --jq .number); gh pr ready "$PR"; echo "EXIT=$?"
```

O auto-merge roda quando o `validate` passa. Confirme com
`gh pr view "$PR" --json state,mergedAt --jq '"\(.state) \(.mergedAt)"'`, que deve dar `MERGED <data>`.

- [ ] **Passo 6: pedir o Publish ao founder** — merge não é produção. O founder clica Publish no Lovable e depois
  atualiza o app (o SW só troca de build no clique).

---

### Tarefa 9: medir depois, registrar e fechar

- [ ] **Passo 1: a régua no banco, no dia da validação** (o mês corrente e todas as empresas: compare com o card
  com o switcher em "todas as empresas")

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-atribuicao-vendas-importadas
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "
WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d),
u AS (
  SELECT so.customer_user_id, so.total FROM sales_orders so, hoje
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
    AND so.order_date_kpi >= date_trunc('month', hoje.d)::date AND so.order_date_kpi < hoje.d + 1
),
vend AS (SELECT DISTINCT user_id FROM commercial_roles WHERE commercial_role IN ('farmer','hunter','closer'))
SELECT CASE WHEN ca.customer_user_id IS NULL THEN 'sem vendedor atribuido'
            WHEN ca.owner_user_id IN (SELECT user_id FROM vend) THEN coalesce(p.razao_social, p.name, ca.owner_user_id::text)
            ELSE 'carteira de nao-vendedor' END AS destino,
       count(*) AS pedidos, round(sum(u.total)::numeric, 2) AS receita
FROM u
LEFT JOIN carteira_assignments ca ON ca.customer_user_id = u.customer_user_id AND ca.eligible
LEFT JOIN profiles p ON p.user_id = ca.owner_user_id
GROUP BY 1 ORDER BY 3 DESC;" -c '\echo FIM-OK'; echo "EXIT=$?"
```

Esperado: `FIM-OK` e `EXIT=0`. Os números batem com o card do founder no mesmo instante (o card tem `staleTime` de
60 s).

- [ ] **Passo 2: registrar o "no ar"** — um PR pequeno de docs acrescenta a
  `docs/historico/ranking-atribuicao-por-carteira.md` a seção "No ar", com a data, os números do Passo 1 e a
  confirmação do founder no card.

- [ ] **Passo 3: `/fecho`** — quando o founder perguntar se pode apagar a sessão.
