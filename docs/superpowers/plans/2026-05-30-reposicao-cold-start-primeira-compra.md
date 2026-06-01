# Cold-start / Candidatos a Primeira Compra (Reposição) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) — este plano
> mistura SQL aplicado MANUALMENTE no SQL Editor do Lovable (Parte A) com código TS/React (Parte B).
> A Parte A NÃO é executável por subagente (constraint Lovable §5 do CLAUDE.md): eu escrevo a migration,
> entrego o bloco SQL pro founder colar, ele cola + cola a validação, eu interpreto. A Parte B é PR normal.

**Goal:** Tornar visíveis (e promovíveis em 1 clique) os SKUs que vendem com recorrência real mas estão
presos pelo gate `num_ordens<2` da reposição, SEM injetá-los na fila de compra automática (risco de one-off).

**Architecture:** Trilha nova `CANDIDATO_PRIMEIRA_COMPRA` na `v_sku_parametros_sugeridos` que intercepta
SÓ casos hoje em `num_ordens<2` que passam um guard de recorrência (180d), expondo uma quantidade-teste
CAPADA em colunas NOVAS (os `*_sugerido` normais seguem `NULL` → o cron #487 não aplica → fila automática
intacta). Uma RPC `promover_candidato_primeira_compra` preenche os parâmetros capados em `sku_parametros`
(habilitando a reposição) → o item entra no fluxo NORMAL (motor sugere → aprovação do pedido → disparo).
A UI reusa a tela de Revisão (novo filtro de status + botão "Promover").

**Tech Stack:** Postgres (view + RPC plpgsql, `security_invoker`/`SECURITY DEFINER`), React + TanStack
Query + shadcn, helper puro TS (vitest). Sem edge function. Sem deploy — só migration manual + PR.

**Decisões travadas (eu + 2 consults codex):**
- **NÃO** relaxar o gate pra fila automática. Trilha de REVISÃO (promoção manual em 1 clique).
- Guard de recorrência (180d): `meses_distintos≥2 AND nfs_distintas≥2 AND dias_desde_ultima≤60`.
  `clientes_distintos` é EXPOSTO como flag (não filtra) — a revisão humana decide os de 1 cliente.
- Cap (compra-teste, sem inflar segurança): `qtde = GREATEST(1, LEAST(qc_eoq, ceil(d × cap_dias)))`,
  `cap_dias` A=30 / B=21 / C=14.
- **Sem hardcode de fornecedor** — o guard de recorrência sozinho concentra ~95% em Sayerlack
  (medido: 21 de 22 candidatos), então escopar a fornecedor é desnecessário e o guard é mais robusto.
- **`pg_get_viewdef` de produção é obrigatório** antes do `CREATE OR REPLACE` — o `schema-snapshot.sql`
  está STALE (mostra `gerar_pedidos_sugeridos_ciclo` SEM o `cmc` do #422/2026-05-28 → snapshot é anterior).
- Helper TS testado é o ORÁCULO da fórmula do cap (espelhado verbatim no SQL) + usado pela UI pra
  exibir/explicar a qtde-teste. Não é dead-code.

**Números do report-first (BLOCO 0, prod 2026-05-30):** 67 presos elegíveis → 22 passam o guard forte
(18 com ≥2 clientes), ~R$17k venda/180d, 21/22 Sayerlack. Risco de capital ~R$1-3k pra ~R$34k/ano de giro.

---

## Ordem de execução

1. **Parte B (código) PRIMEIRO** — helper + tipos + hook + UI podem ser escritos, testados e mergeados
   ANTES do SQL existir em prod (a UI só RENDERIZA dados quando a view tiver as colunas; até lá o filtro
   "primeira_compra" volta vazio — degradação benigna). PR mergeia com CI verde.
2. **Parte A (SQL) DEPOIS** — A0 (obter viewdef) → revisar o `CREATE OR REPLACE` com codex → A1 (view) →
   A2 (RPC) → A3 (validação). Aplicado via SQL Editor pelo founder.
3. Coordenação: quando A1 estiver em prod, o filtro "primeira_compra" da UI passa a listar; quando A2
   estiver em prod, o botão "Promover" funciona. Ambos degradam honestamente até lá.

> ⚠️ A migration vai em `supabase/migrations/` (versionada) MAS é aplicada à mão (§5). A nota de PR e a
> conversa carregam "**ATENÇÃO: migration manual + RPC manual via SQL Editor**" + os blocos prontos.

---

## PARTE B — Código (PR normal, testável isolado)

### Task B1: Helper puro do cap da primeira compra (TDD)

**Files:**
- Create: `src/lib/reposicao/primeira-compra-cap.ts`
- Test: `src/lib/reposicao/__tests__/primeira-compra-cap.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

```ts
import { describe, it, expect } from "vitest";
import { capDiasPorClasse, calcularParametrosPrimeiraCompra } from "../primeira-compra-cap";

describe("capDiasPorClasse", () => {
  it("A=30, B=21, C=14, default 14", () => {
    expect(capDiasPorClasse("A")).toBe(30);
    expect(capDiasPorClasse("B")).toBe(21);
    expect(capDiasPorClasse("C")).toBe(14);
    expect(capDiasPorClasse(null)).toBe(14);
    expect(capDiasPorClasse("Z")).toBe(14);
  });
});

describe("calcularParametrosPrimeiraCompra", () => {
  it("capa pela cobertura quando qc_eoq é maior", () => {
    // d=2/dia, classe B (21d) → cap = 42; qc_eoq=100 → qtde = 42
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 100, demandaDiaria: 2, leadTime: 8, classe: "B" });
    expect(r.qtde).toBe(42);          // ceil(2*21)=42, < 100
    expect(r.pontoPedido).toBe(16);   // ceil(2*8)=16
    expect(r.estoqueMaximo).toBe(42); // max(qtde=42, ponto+1=17) = 42
    expect(r.capDias).toBe(21);
  });

  it("usa qc_eoq quando ele é MENOR que o cap de cobertura", () => {
    // d=2/dia, classe A (30d) → cap = 60; qc_eoq=10 → qtde = 10
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 10, demandaDiaria: 2, leadTime: 5, classe: "A" });
    expect(r.qtde).toBe(10);
    expect(r.pontoPedido).toBe(10);   // ceil(2*5)=10
    expect(r.estoqueMaximo).toBe(11); // max(qtde=10, ponto+1=11) = 11  (lead time força +1)
  });

  it("piso de 1 em tudo e nunca estoqueMaximo <= pontoPedido", () => {
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 1, demandaDiaria: 0, leadTime: 0, classe: "C" });
    expect(r.qtde).toBe(1);
    expect(r.pontoPedido).toBe(1);
    expect(r.estoqueMaximo).toBe(2);  // GREATEST(qtde=1, ponto+1=2)
  });

  it("lead time longo força estoqueMaximo a cobrir o LT (acima do cap)", () => {
    // d=1/dia, classe C (14d) → cap qtde = 14; lt=20 → ponto = 20 → max = 21 (> cap)
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 50, demandaDiaria: 1, leadTime: 20, classe: "C" });
    expect(r.qtde).toBe(14);
    expect(r.pontoPedido).toBe(20);
    expect(r.estoqueMaximo).toBe(21);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd "$(git rev-parse --show-toplevel)" && bunx vitest run src/lib/reposicao/__tests__/primeira-compra-cap.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// src/lib/reposicao/primeira-compra-cap.ts
// Cap da PRIMEIRA COMPRA (cold-start). Compra-teste conservadora: não infla segurança, capa a
// cobertura por classe. É o ORÁCULO testável da fórmula espelhada VERBATIM no SQL da
// v_sku_parametros_sugeridos (trilha CANDIDATO_PRIMEIRA_COMPRA). A UI usa pra exibir/explicar.
// Revisado com codex: cap_dias A=30/B=21/C=14; ponto = demanda no lead time (sem z); estoque_maximo
// nunca <= ponto (senão o motor não compra: qtde = max - efetivo).

export function capDiasPorClasse(classeAbc: string | null | undefined): number {
  switch (classeAbc) {
    case "A": return 30;
    case "B": return 21;
    default:  return 14; // C, Z, null
  }
}

export interface ParametrosPrimeiraCompraInput {
  qcEoq: number;          // qtde_compra_ciclo (EOQ) calculada pela view
  demandaDiaria: number;  // demanda_media_diaria
  leadTime: number;       // lt (dias úteis)
  classe: string | null | undefined; // classe_abc_proposta
}

export interface ParametrosPrimeiraCompra {
  qtde: number;          // quanto comprar na primeira vez (capado)
  pontoPedido: number;   // dispara a compra (demanda no LT)
  estoqueMaximo: number; // teto que o motor recompõe (sempre > pontoPedido)
  capDias: number;
}

export function calcularParametrosPrimeiraCompra(
  i: ParametrosPrimeiraCompraInput,
): ParametrosPrimeiraCompra {
  const capDias = capDiasPorClasse(i.classe);
  const d = Number.isFinite(i.demandaDiaria) && i.demandaDiaria > 0 ? i.demandaDiaria : 0;
  const lt = Number.isFinite(i.leadTime) && i.leadTime > 0 ? i.leadTime : 0;
  const eoq = Number.isFinite(i.qcEoq) && i.qcEoq > 0 ? i.qcEoq : 1;

  const qtde = Math.max(1, Math.min(eoq, Math.ceil(d * capDias)));
  const pontoPedido = Math.max(1, Math.ceil(d * lt));
  const estoqueMaximo = Math.max(qtde, pontoPedido + 1);
  return { qtde, pontoPedido, estoqueMaximo, capDias };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd "$(git rev-parse --show-toplevel)" && bunx vitest run src/lib/reposicao/__tests__/primeira-compra-cap.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/primeira-compra-cap.ts src/lib/reposicao/__tests__/primeira-compra-cap.test.ts
git commit -m "feat(reposicao): helper do cap da primeira compra (cold-start, TDD)"
```

### Task B2: Tipos — novo status filter + colunas da view

**Files:**
- Modify: `src/lib/reposicao/sku-param.ts` (adicionar `'primeira_compra'` ao `StatusFilterValue`)
- Modify: `src/components/reposicao/revisao/types.ts` (adicionar colunas novas ao `SkuSugeridoView`)

- [ ] **Step 1: Adicionar o valor de filtro**

Em `src/lib/reposicao/sku-param.ts`, achar o tipo `StatusFilterValue` (union de strings, hoje inclui
`"pendente" | "aprovado" | "aguardando_fornecedor"`) e adicionar `| "primeira_compra"`.

- [ ] **Step 2: Adicionar as colunas novas ao tipo da view**

Em `src/components/reposicao/revisao/types.ts`, no tipo `SkuSugeridoView`, adicionar (todas nullable —
a view só preenche pra `CANDIDATO_PRIMEIRA_COMPRA`):

```ts
  tipo_sugestao: string | null;
  recorrencia_meses_180d: number | null;
  recorrencia_nfs_180d: number | null;
  recorrencia_clientes_180d: number | null;
  dias_desde_ultima_venda: number | null;
  primeira_compra_qtde: number | null;
  primeira_compra_ponto_pedido: number | null;
  primeira_compra_estoque_maximo: number | null;
  primeira_compra_cap_dias: number | null;
```

- [ ] **Step 3: Typecheck**

Run: `cd "$(git rev-parse --show-toplevel)" && bunx tsc --noEmit -p tsconfig.app.json`
Expected: PASS (sem novos erros).

- [ ] **Step 4: Commit**

```bash
git add src/lib/reposicao/sku-param.ts src/components/reposicao/revisao/types.ts
git commit -m "feat(reposicao): tipos do filtro/colunas de candidatos a primeira compra"
```

### Task B3: Hook — listar candidatos + mutation de promoção

**Files:**
- Modify: `src/components/reposicao/revisao/useRevisaoParametros.ts`

- [ ] **Step 1: Adicionar o caso de query `primeira_compra`**

Logo após o bloco `if (statusFilter === "aguardando_fornecedor") { ... }` (mesmo padrão), adicionar um
bloco análogo pra `statusFilter === "primeira_compra"` que lê a view por
`status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'`, ordena por `valor_total_180d desc`, pagina, e mapeia
pra `RowWithPrice` (igual ao caso `aguardando_fornecedor`) MAS usando os campos da primeira compra pros
parâmetros exibidos:

```ts
      if (statusFilter === "primeira_compra") {
        let q = supabase
          .from("v_sku_parametros_sugeridos")
          .select("*", { count: "exact" })
          .eq("empresa", empresa)
          .eq("status_sugestao", "CANDIDATO_PRIMEIRA_COMPRA");
        if (classes.length > 0) q = q.in("classe_consolidada", classes);
        if (search.trim()) {
          const s = search.trim();
          if (/^\d+$/.test(s)) q = q.eq("sku_codigo_omie", Number(s));
          else q = q.ilike("sku_descricao", `%${s}%`);
        }
        q = q.order("valor_total_180d", { ascending: false, nullsFirst: false });
        q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        const { data: vdata, error, count } = await q;
        if (error) throw error;
        const priced: RowWithPrice[] = ((vdata ?? []) as SkuSugeridoView[]).map((v) => ({
          id: `pc-${v.sku_codigo_omie}`,
          empresa: v.empresa ?? empresa,
          sku_codigo_omie: Number(v.sku_codigo_omie),
          sku_descricao: v.sku_descricao,
          fornecedor_nome: v.fornecedor_nome,
          classe_consolidada: v.classe_consolidada,
          classe_abc: v.classe_abc_proposta,
          classe_xyz: v.classe_xyz_proposta,
          demanda_media_diaria: v.demanda_media_diaria,
          demanda_desvio_padrao: v.demanda_sigma_diario,
          demanda_coef_variacao: v.coef_variacao_ordem,
          demanda_dias_com_movimento: v.dias_com_movimento,
          demanda_total_90d: null,
          valor_vendido_90d: v.valor_total_90d,
          lt_medio_dias_uteis: v.lead_time_medio,
          lt_desvio_padrao_dias: v.lead_time_desvio,
          lt_p95_dias: v.lt_p95_dias,
          lt_n_observacoes: null,
          fonte_leadtime: v.fonte_leadtime,
          estoque_minimo: null,
          ponto_pedido: v.primeira_compra_ponto_pedido,
          estoque_maximo: v.primeira_compra_estoque_maximo,
          estoque_seguranca: null,
          z_score: v.z_aplicado,
          cobertura_alvo_dias: v.primeira_compra_cap_dias,
          aplicar_no_omie: false,
          aprovado_em: null,
          aprovado_por: null,
          justificativa_aprovacao: null,
          ultima_atualizacao_calculo: v.calculado_em,
          preco_compra_real: v.preco_compra_real,
          preco_venda_medio: v.preco_venda_medio,
          fonte_preco: v.fonte_preco,
          status_sugestao: v.status_sugestao,
          fornecedor_habilitado: v.fornecedor_habilitado,
          read_only: true,
          // extras de primeira compra (exibição)
          primeira_compra_qtde: v.primeira_compra_qtde,
          recorrencia_meses_180d: v.recorrencia_meses_180d,
          recorrencia_nfs_180d: v.recorrencia_nfs_180d,
          recorrencia_clientes_180d: v.recorrencia_clientes_180d,
          dias_desde_ultima_venda: v.dias_desde_ultima_venda,
        }));
        return { rows: priced, total: count ?? 0 };
      }
```

> Nota: `RowWithPrice` precisa aceitar os 5 campos extras. Em `src/lib/reposicao/sku-param.ts`, no tipo
> `RowWithPrice`, adicionar `primeira_compra_qtde?`, `recorrencia_meses_180d?`, `recorrencia_nfs_180d?`,
> `recorrencia_clientes_180d?`, `dias_desde_ultima_venda?` (todos `number | null` opcionais).

- [ ] **Step 2: Adicionar a `promoverMutation`**

Logo após `updateMutation`:

```ts
  const promoverMutation = useMutation({
    mutationFn: async (sku: number) => {
      const { data, error } = await supabase.rpc("promover_candidato_primeira_compra", {
        p_empresa: empresa,
        p_sku: sku,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (n) => {
      if (n && n > 0) toast.success("SKU promovido — entra na próxima sugestão de compra");
      else toast.info("Nada a promover (já promovido ou não é mais candidato)");
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao promover: " + e.message),
  });
```

E adicionar `promoverMutation` ao objeto retornado pelo hook.

- [ ] **Step 3: Typecheck**

Run: `cd "$(git rev-parse --show-toplevel)" && bunx tsc --noEmit -p tsconfig.app.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/revisao/useRevisaoParametros.ts src/lib/reposicao/sku-param.ts
git commit -m "feat(reposicao): hook lista candidatos a primeira compra + promoverMutation"
```

### Task B4: UI — opção de filtro + botão "Promover"

**Files:**
- Modify: a página/tabela de revisão (`src/pages/AdminReposicaoRevisao.tsx` e/ou os componentes em
  `src/components/reposicao/revisao/` que renderizam o seletor de status e as linhas — identificar pelo
  consumo de `statusFilter`/`onStatusChange` e `openSku`/`SkuDetailSheet`).

- [ ] **Step 1: Adicionar a opção no seletor de status**

No componente que renderiza as abas/seletor de `statusFilter` (procurar onde `aguardando_fornecedor` é
oferecido como opção), adicionar uma opção `primeira_compra` com label **"Candidatos a 1ª compra"** e um
contador (count da query). Quando ativa, mostrar uma linha de ajuda: "Itens que vendem com recorrência mas
nunca foram comprados. Revise e promova — entram no fluxo normal de compra."

- [ ] **Step 2: Exibir recorrência + qtde-teste + botão Promover**

Quando `statusFilter === "primeira_compra"`, em cada linha (ou no `SkuDetailSheet` ao abrir o SKU):
- Mostrar `primeira_compra_qtde` ("comprar ~N un"), `recorrencia_meses_180d`/`recorrencia_nfs_180d`/
  `recorrencia_clientes_180d`/`dias_desde_ultima_venda`, e o valor estimado (`primeira_compra_qtde ×
  preco_compra_real ?? preco_venda_medio×0.55`).
- Badge de atenção "1 cliente só" quando `recorrencia_clientes_180d === 1`.
- Botão **"Promover pra reposição"** que chama `promoverMutation.mutate(row.sku_codigo_omie)`, com
  `disabled={promoverMutation.isPending}`.

- [ ] **Step 3: Verificação manual (build + lint)**

Run: `cd "$(git rev-parse --show-toplevel)" && heavy bun run test && bunx tsc --noEmit -p tsconfig.app.json && bun lint`
Expected: testes verdes, sem erro de type, lint sem erro novo.

- [ ] **Step 4: Commit**

```bash
git add src/pages/AdminReposicaoRevisao.tsx src/components/reposicao/revisao/
git commit -m "feat(reposicao): UI de candidatos a primeira compra + botão Promover"
```

---

## PARTE A — SQL (migration + RPC manuais via SQL Editor do Lovable)

### Task A0: Obter o corpo verbatim da view de produção (PRÉ-REQUISITO)

- [ ] **Step 1: Entregar ao founder (read-only) e pedir o resultado colado**

```sql
SELECT pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true);
```

- [ ] **Step 2: Comparar com `supabase/schema-snapshot.sql` (linhas 12096-12399).** Se idêntico (a menos
  de espaçamento), usar como base. Se divergir, usar a versão de PRODUÇÃO como base do `CREATE OR REPLACE`.
  (O snapshot está provadamente stale pra OUTROS objetos — confirmar este.)

### Task A1: `CREATE OR REPLACE VIEW` com a trilha CANDIDATO_PRIMEIRA_COMPRA

**Files:**
- Create: `supabase/migrations/20260530210000_reposicao_view_candidato_primeira_compra.sql`

**As adições ao corpo verbatim de A0 (4 pontos de inserção):**

- [ ] **Adição 1 — nova CTE `recorrencia_180d`** (inserir junto às outras CTEs do topo, ex. após `precos_venda`):

```sql
  ), recorrencia_180d AS (
     SELECT vih.empresa,
        vih.sku_codigo_omie,
        count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
        count(DISTINCT to_char(vih.data_emissao, 'YYYY-MM')) AS meses_180d,
        count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
        (CURRENT_DATE - max(vih.data_emissao)) AS dias_desde_ultima
       FROM public.venda_items_history vih
      WHERE ((vih.data_emissao >= (CURRENT_DATE - '180 days'::interval)) AND (vih.quantidade > (0)::numeric))
      GROUP BY vih.empresa, vih.sku_codigo_omie
```

- [ ] **Adição 2 — no CTE `base`**: adicionar o LEFT JOIN e propagar 4 colunas.
  No SELECT do `base`, adicionar 4 colunas: `rec.meses_180d, rec.nfs_180d, rec.clientes_180d, rec.dias_desde_ultima`.
  No FROM do `base`, adicionar:

```sql
     LEFT JOIN recorrencia_180d rec ON (((rec.empresa = c.empresa) AND (rec.sku_codigo_omie = c.sku_codigo_omie)))
```

- [ ] **Adição 3 — no CTE `com_calculos`**: propagar as 4 colunas (`base.meses_180d, base.nfs_180d,
  base.clientes_180d, base.dias_desde_ultima`) no SELECT, e adicionar o RAMO NOVO como **primeiro** WHEN
  do CASE de `status_sugestao` (antes do `num_ordens < 2 → AGUARDANDO_SEGUNDA_ORDEM`):

```sql
                CASE
                    WHEN ((base.num_ordens < 2)
                          AND (COALESCE(base.meses_180d, 0) >= 2)
                          AND (COALESCE(base.nfs_180d, 0) >= 2)
                          AND (COALESCE(base.dias_desde_ultima, 9999) <= 60)
                          AND (base.lt IS NOT NULL)
                          AND (base.fornecedor_nome IS NOT NULL)
                          AND base.fornecedor_habilitado
                          AND (base.preco_item_eoq > (0)::numeric)
                          AND (base.classe_abc_proposta IS NOT NULL)
                          AND ((base.grupo_codigo IS NOT NULL) OR (base.fornecedor_nome <> 'RENNER SAYERLACK S/A'::text))
                         ) THEN 'CANDIDATO_PRIMEIRA_COMPRA'::text
                    WHEN (base.num_ordens < 2) THEN 'AGUARDANDO_SEGUNDA_ORDEM'::text
                    WHEN (base.lt IS NULL) THEN 'SEM_LEADTIME_DEFINIDO'::text
                    WHEN (base.fornecedor_nome IS NULL) THEN 'SEM_FORNECEDOR_IDENTIFICADO'::text
                    WHEN (NOT base.fornecedor_habilitado) THEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text
                    WHEN ((base.grupo_codigo IS NULL) AND (base.fornecedor_nome = 'RENNER SAYERLACK S/A'::text)) THEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text
                    WHEN ((base.preco_item_eoq IS NULL) OR (base.preco_item_eoq = (0)::numeric)) THEN 'SEM_PRECO'::text
                    ELSE 'OK'::text
                END AS status_sugestao
```

- [ ] **Adição 4 — no CTE `com_formulas`**: propagar as 4 colunas + computar o cap. Adicionar ao SELECT
  de `com_formulas` (que já lê de `com_calculos`):

```sql
            com_calculos.meses_180d,
            com_calculos.nfs_180d,
            com_calculos.clientes_180d,
            com_calculos.dias_desde_ultima,
            CASE com_calculos.classe_abc_proposta WHEN 'A'::text THEN 30 WHEN 'B'::text THEN 21 ELSE 14 END AS cap_dias_classe,
            GREATEST((1)::numeric, LEAST(GREATEST(com_calculos.qc_eoq, (1)::numeric), ceil(COALESCE(com_calculos.d,(0)::numeric) * (CASE com_calculos.classe_abc_proposta WHEN 'A'::text THEN 30 WHEN 'B'::text THEN 21 ELSE 14 END)::numeric))) AS pc_qtde,
            GREATEST((1)::numeric, ceil(COALESCE(com_calculos.d,(0)::numeric) * COALESCE(com_calculos.lt,(10)::numeric))) AS pc_ponto_pedido
```

- [ ] **Adição 5 — no SELECT FINAL**: adicionar as colunas novas (após `estoque_seguranca_sugerido`):

```sql
    CASE WHEN (status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'::text) THEN 'PRIMEIRA_COMPRA'::text ELSE 'NORMAL'::text END AS tipo_sugestao,
    meses_180d AS recorrencia_meses_180d,
    nfs_180d AS recorrencia_nfs_180d,
    clientes_180d AS recorrencia_clientes_180d,
    dias_desde_ultima AS dias_desde_ultima_venda,
    CASE WHEN (status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'::text) THEN pc_qtde ELSE NULL::numeric END AS primeira_compra_qtde,
    CASE WHEN (status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'::text) THEN LEAST(pc_ponto_pedido, GREATEST(pc_qtde, (pc_ponto_pedido + (1)::numeric)) - (1)::numeric) ELSE NULL::numeric END AS primeira_compra_ponto_pedido,
    CASE WHEN (status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'::text) THEN GREATEST(pc_qtde, (pc_ponto_pedido + (1)::numeric)) ELSE NULL::numeric END AS primeira_compra_estoque_maximo,
    CASE WHEN (status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'::text) THEN cap_dias_classe ELSE NULL::integer END AS primeira_compra_cap_dias
```

> ⚠️ paridade com o helper TS B1: `estoque_maximo = GREATEST(qtde, ponto+1)`; `ponto_pedido =
> LEAST(pc_ponto_pedido, estoque_maximo-1)` (garante ponto < max). `qtde = GREATEST(1, LEAST(qc_eoq,
> ceil(d×cap_dias)))`. Mesma matemática do helper — confirmar 1:1 na validação A3.

- [ ] **Adição 6 — no `ORDER BY` final**: adicionar `CANDIDATO_PRIMEIRA_COMPRA` na posição (ex. logo após `OK`):

```sql
        CASE status_sugestao
            WHEN 'OK'::text THEN 1
            WHEN 'CANDIDATO_PRIMEIRA_COMPRA'::text THEN 2
            WHEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text THEN 3
            WHEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text THEN 4
            WHEN 'SEM_LEADTIME_DEFINIDO'::text THEN 5
            WHEN 'SEM_PRECO'::text THEN 6
            ELSE 7
        END, valor_total_180d DESC NULLS LAST
```

- [ ] **Step final: montar o `CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos WITH
  (security_invoker='on') AS ...` completo** (corpo de A0 + as 6 adições), salvar na migration, entregar
  o bloco pro founder colar no SQL Editor.

### Task A2: RPC `promover_candidato_primeira_compra`

**Files:**
- Adicionar à mesma migration (ou `20260530220000_*`).

```sql
CREATE OR REPLACE FUNCTION public.promover_candidato_primeira_compra(p_empresa text, p_sku bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_atualizados int := 0;
BEGIN
  -- Gate de auth: staff (master OU employee). Reusa o padrão do projeto.
  IF NOT (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('master','employee'))
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.sku_parametros sp
  SET
    demanda_media_diaria       = v.demanda_media_diaria,
    demanda_desvio_padrao      = v.demanda_sigma_diario,
    demanda_coef_variacao      = v.coef_variacao_ordem,
    demanda_dias_com_movimento = v.num_ordens,
    valor_vendido_90d          = v.valor_total_90d,
    lt_medio_dias_uteis        = v.lead_time_medio,
    lt_desvio_padrao_dias      = v.lead_time_desvio,
    lt_p95_dias                = v.lt_p95_dias,
    fonte_leadtime             = v.fonte_leadtime,
    z_score                    = v.z_aplicado,
    estoque_seguranca          = 0,
    ponto_pedido               = v.primeira_compra_ponto_pedido,
    estoque_maximo             = v.primeira_compra_estoque_maximo,
    cobertura_alvo_dias        = v.primeira_compra_cap_dias,
    habilitado_reposicao_automatica = TRUE,
    tipo_reposicao             = 'automatica',
    aprovado_em                = now(),
    aprovado_por               = COALESCE((SELECT email FROM public.profiles WHERE user_id = auth.uid()), 'primeira_compra'),
    justificativa_aprovacao    = 'Primeira compra (cold-start): qtde-teste capada, promovida pra reposição',
    ultima_atualizacao_calculo = now()
  FROM public.v_sku_parametros_sugeridos v
  WHERE sp.empresa = v.empresa
    AND sp.sku_codigo_omie = v.sku_codigo_omie
    AND sp.empresa = p_empresa
    AND sp.sku_codigo_omie = p_sku
    AND v.status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA';  -- só promove se ainda é candidato (idempotente)

  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  RETURN v_atualizados;
END;
$$;

REVOKE ALL ON FUNCTION public.promover_candidato_primeira_compra(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promover_candidato_primeira_compra(text, bigint) TO authenticated;
```

> ⚠️ A RPC vincula `sku_parametros` por `sku_codigo_omie` (bigint = bigint). Confirmar o gate de auth
> contra o padrão real do projeto (`user_roles`/`commercial_roles`) na revisão codex — o esqueleto acima
> usa `user_roles(role IN master/employee)`; ajustar pro helper canônico se houver.

### Task A3: Validação pós-apply (read-only, founder cola o resultado)

```sql
-- A3.1 — paridade dos parâmetros calculados pros candidatos (deve casar com o helper TS)
SELECT sku_codigo_omie, classe_abc_proposta, demanda_media_diaria, lead_time_medio,
       qtde_compra_ciclo_sugerida, primeira_compra_qtde, primeira_compra_ponto_pedido,
       primeira_compra_estoque_maximo, primeira_compra_cap_dias,
       recorrencia_meses_180d, recorrencia_nfs_180d, recorrencia_clientes_180d, dias_desde_ultima_venda
FROM v_sku_parametros_sugeridos
WHERE empresa = 'OBEN' AND status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA'
ORDER BY valor_total_180d DESC NULLS LAST
LIMIT 30;

-- A3.2 — invariantes: nenhum candidato com max <= ponto, nenhum *_sugerido normal preenchido
SELECT
  count(*) AS total_candidatos,
  count(*) FILTER (WHERE primeira_compra_estoque_maximo <= primeira_compra_ponto_pedido) AS viola_max_maior_ponto,
  count(*) FILTER (WHERE ponto_pedido_sugerido IS NOT NULL OR estoque_maximo_sugerido IS NOT NULL) AS viola_sugerido_normal_preenchido,
  count(*) FILTER (WHERE primeira_compra_qtde IS NULL OR primeira_compra_qtde < 1) AS viola_qtde
FROM v_sku_parametros_sugeridos
WHERE empresa = 'OBEN' AND status_sugestao = 'CANDIDATO_PRIMEIRA_COMPRA';
-- Esperado: viola_* = 0

-- A3.3 — o caminho OK não regrediu (contagem de OK estável antes/depois)
SELECT status_sugestao, count(*) FROM v_sku_parametros_sugeridos WHERE empresa = 'OBEN' GROUP BY 1 ORDER BY 2 DESC;
```

---

## Self-review (rodado pelo autor do plano)

**1. Cobertura do spec:** trilha CANDIDATO_PRIMEIRA_COMPRA (A1) ✓; guard de recorrência (A1 Adição 3) ✓;
cap por classe + sem inflar z (B1 + A1 Adição 4/5) ✓; lista de revisão + promover 1-clique (A2 + B3 + B4) ✓;
fila automática intacta (`*_sugerido` normais seguem NULL; A1 não os toca) ✓; shadow/visibilidade (a view
é o shadow) ✓; modos de falha (ruptura/NF-gigante: o guard de recorrência + a revisão humana + cap mitigam;
clientes=1 flag) ✓. Escopo Sayerlack: decidido NÃO hardcodar (guard concentra naturalmente) — registrado.

**2. Placeholders:** nenhum "TBD"/"etc." nos steps de código. A Parte A depende de A0 (corpo verbatim) por
design (não dá pra ter o CREATE OR REPLACE final antes), mas TODAS as adições estão completas e ancoradas.

**3. Consistência de tipos:** `primeira_compra_qtde`/`_ponto_pedido`/`_estoque_maximo`/`_cap_dias`,
`recorrencia_{meses,nfs,clientes}_180d`, `dias_desde_ultima_venda`, `tipo_sugestao` — mesmos nomes na view
(A1), no tipo `SkuSugeridoView` (B2), no hook (B3) e na RPC (A2). Helper B1 ↔ SQL A1: mesma fórmula
(GREATEST/LEAST/ceil), validada por A3.1/A3.2.

**Pendência antes de aplicar A1/A2:** consult codex adversarial no SQL (derivação ponto/max, idempotência
da RPC, gate de auth, double-count). Fazer ANTES de entregar os blocos ao founder. — ✅ FEITO, ver abaixo.

---

## ⚠️ AJUSTES PÓS-CODEX ADVERSARIAL (2026-05-30) — substituem os trechos acima onde conflitarem

O codex achou 3 bugs reais. **Estes ajustes têm precedência** sobre as fórmulas/SQL escritos acima:

### FIX 1 — Fórmula do cap (bug crítico: `estoque_maximo = GREATEST(qtde, ponto+1)` quebra o motor)
O motor compra `estoque_maximo − estoque_efetivo`. Disparando no ponto, a fórmula antiga compraria só 1 un
(quando ponto>qtde). **Fórmula correta** (ponto TAMBÉM capado pela cobertura; max = ponto + lote):

```
cap_dias       = A:30 / B:21 / C:14
cap_cobertura  = ceil(d × cap_dias)
demanda_no_lt  = ceil(d × lt)
pontoPedido    = GREATEST(1, LEAST(demanda_no_lt, cap_cobertura))   -- ponto capado (fecha o buraco de LT longo)
lote           = GREATEST(1, LEAST(GREATEST(qc_eoq,1), cap_cobertura))
estoqueMaximo  = pontoPedido + lote                                 -- compra ~lote no ponto; ~ponto+lote em estoque 0
```
Colunas da view: `primeira_compra_qtde = lote`, `primeira_compra_ponto_pedido = pontoPedido`,
`primeira_compra_estoque_maximo = estoqueMaximo`, `primeira_compra_cap_dias = cap_dias`. A UI exibe o
`estoque_maximo` como "estoque-alvo (~N un)". **Helper B1 e SQL A1 usam ESTA fórmula** (testes de B1 reescritos abaixo).

Testes do helper B1 (substituem o `describe("calcularParametrosPrimeiraCompra")`):
```ts
it("capa lote E ponto pela cobertura; max = ponto + lote", () => {
  // d=2, B(21)→cap_cob=42; lt=8→dem_lt=16; qcEoq=100
  const r = calcularParametrosPrimeiraCompra({ qcEoq: 100, demandaDiaria: 2, leadTime: 8, classe: "B" });
  expect(r.lote).toBe(42); expect(r.pontoPedido).toBe(16); expect(r.estoqueMaximo).toBe(58); expect(r.capDias).toBe(21);
});
it("usa qc_eoq quando menor que a cobertura", () => {
  // d=2, A(30)→cap_cob=60; lt=5→dem_lt=10; qcEoq=10
  const r = calcularParametrosPrimeiraCompra({ qcEoq: 10, demandaDiaria: 2, leadTime: 5, classe: "A" });
  expect(r.lote).toBe(10); expect(r.pontoPedido).toBe(10); expect(r.estoqueMaximo).toBe(20);
});
it("LT longo: ponto é capado pela cobertura (não estoura)", () => {
  // d=1, C(14)→cap_cob=14; lt=20→dem_lt=20 → ponto = min(20,14)=14
  const r = calcularParametrosPrimeiraCompra({ qcEoq: 50, demandaDiaria: 1, leadTime: 20, classe: "C" });
  expect(r.lote).toBe(14); expect(r.pontoPedido).toBe(14); expect(r.estoqueMaximo).toBe(28);
});
it("d=0 → pisos de 1; max sempre > ponto", () => {
  const r = calcularParametrosPrimeiraCompra({ qcEoq: 1, demandaDiaria: 0, leadTime: 0, classe: "C" });
  expect(r.lote).toBe(1); expect(r.pontoPedido).toBe(1); expect(r.estoqueMaximo).toBe(2);
});
```
Interface do helper muda: retorna `{ lote, pontoPedido, estoqueMaximo, capDias }` (era `qtde`→agora `lote`).

SQL A1 (substitui Adição 4 `com_formulas` + Adição 5 colunas finais):
```sql
-- em com_formulas:
CASE com_calculos.classe_abc_proposta WHEN 'A' THEN 30 WHEN 'B' THEN 21 ELSE 14 END AS cap_dias_classe,
ceil(COALESCE(com_calculos.d,(0)::numeric) * (CASE com_calculos.classe_abc_proposta WHEN 'A' THEN 30 WHEN 'B' THEN 21 ELSE 14 END)::numeric) AS pc_cap_cobertura,
ceil(COALESCE(com_calculos.d,(0)::numeric) * COALESCE(com_calculos.lt,(10)::numeric)) AS pc_dem_lt
-- no SELECT final (só quando status = CANDIDATO_PRIMEIRA_COMPRA, senão NULL):
GREATEST((1)::numeric, LEAST(GREATEST(qc_eoq,(1)::numeric), pc_cap_cobertura)) AS primeira_compra_qtde,
GREATEST((1)::numeric, LEAST(pc_dem_lt, pc_cap_cobertura)) AS primeira_compra_ponto_pedido,
GREATEST((1)::numeric, LEAST(pc_dem_lt, pc_cap_cobertura)) + GREATEST((1)::numeric, LEAST(GREATEST(qc_eoq,(1)::numeric), pc_cap_cobertura)) AS primeira_compra_estoque_maximo,
cap_dias_classe AS primeira_compra_cap_dias
```

### FIX 2 — Candidato já promovido deve SAIR da lista (idempotência na view)
Após promover, `sku_parametros` ganha `ponto_pedido`, mas `num_ordens<2` segue → a view continuaria
marcando `CANDIDATO_PRIMEIRA_COMPRA` (clique repetido, confusão). **Adicionar LEFT JOIN com `sku_parametros`
no `base`** e ao guard do ramo CANDIDATO: `AND sp_existing.ponto_pedido IS NULL`.
```sql
-- no FROM do base:
LEFT JOIN public.sku_parametros sp_existing ON ((sp_existing.empresa = c.empresa) AND (sp_existing.sku_codigo_omie = c.sku_codigo_omie))
-- propagar sp_existing.ponto_pedido AS ja_tem_ponto por base→com_calculos; no ramo CANDIDATO adicionar:
AND (base.ja_tem_ponto IS NULL)
```

### FIX 3 — RPC trava contra re-promoção (protege ajuste manual)
Adicionar ao WHERE da RPC: `AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL AND COALESCE(sp.habilitado_reposicao_automatica,false) = false`.
Combinado com FIX 2, garante: promove só item virgem; depois some da lista; re-clique = no-op (retorna 0).

### FIX 4 — Índice de recorrência (performance; bloco SEPARADO, fora de transação)
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vih_recorrencia_180d
ON public.venda_items_history (empresa, sku_codigo_omie, data_emissao) WHERE quantidade > 0;
```
> Entregar como bloco PRÓPRIO (CONCURRENTLY não roda em transação). Aplicar ANTES do CREATE OR REPLACE da view.

### Decisões registradas (codex)
- **Guard de cliente:** mantido `clientes_180d` como FLAG (não filtro) — um cliente fiel recorrente é
  candidato legítimo; excluí-lo perderia demanda real. A UI destaca `clientes_180d=1` como "⚠ 1 cliente só"
  e a revisão humana decide. (O codex ofereceu `clientes>=2`; escolhi flag porque a feature É revisão.)
- **Limitação v1 conhecida:** sem coluna de status de NF em `venda_items_history`, uma devolução faturada
  com `quantidade>0` poderia inflar `nfs_180d`. Mitigação: filtro `quantidade>0` exclui devolução com qtde
  negativa; a revisão humana vê o histórico. CFOP de devolução fica como refinamento v2.
- **Trade-off LT longo:** com ponto capado pela cobertura, item de LT > cap_dias pode romper antes do
  reabastecimento na 1ª compra. Aceitável (conservador no capital; após a 1ª compra o item ganha histórico
  e os params normais recalculam). Registrado.

## 🏛️ ARQUITETURA FINAL — Opção B (view derivada) + 3º consult codex (2026-05-30)

**Mudança de arquitetura (precede tudo acima onde conflitar):** em vez de `CREATE OR REPLACE` da view-mãe
`v_sku_parametros_sugeridos` (lida por 8+ consumidores → raio de explosão alto), criei uma **VIEW DERIVADA
nova** `v_sku_candidatos_primeira_compra` (migration `20260530210000_*`) que lê da mãe (intocada) + a
CTE `recorrencia_180d` + `sku_parametros`. **A view-mãe NÃO é modificada** → zero risco pros consumidores
existentes; aplicação trivial (`CREATE VIEW`, não 300-linha `CREATE OR REPLACE`); dispensa o A0 (pg_get_viewdef).
A lógica de filtro é a do BLOCO 0 (report-first), já validada em prod (22 candidatos). O EOQ é recalculado na
derivada (a mãe expõe `*_sugerido=NULL` fora do status OK, mas expõe `custo_pedido_aplicado`/`custo_capital_efetivo_perc`/`preco_item_eoq`).

**3º consult codex (adversarial na Opção B) — incorporado na migration:**
- **P1 (candidato sem linha em `sku_parametros` → promoção UPDATE retorna 0 silencioso):** `INNER JOIN
  sku_parametros` (não LEFT) → só lista o promovível; alinha view↔RPC.
- **P4 (predicados view vs RPC divergiam):** view usa os MESMOS 3 predicados da RPC (`ponto IS NULL AND
  estoque_maximo IS NULL AND habilitado=false`).
- **P5 (EOQ):** `AND v.demanda_media_diaria > 0` explícito no WHERE.
- **P6 (perf):** `ORDER BY` removido da view (a UI ordena via `.order`). count:exact mantido (volume ~22,
  uso esporádico); materializar é v2 se crescer.
- **EOQ verbatim confirmado** pelo codex (custo_capital_efetivo_perc/100 == cm_anual da mãe).

**Trade-offs registrados (codex P2/P3/P7, aceitos pra v1):**
- **Semântica "primeira compra":** o gate é de VENDA (num_ordens<2), não prova "nunca comprado". A trilha
  captura "vende recorrente + fora da reposição automática" (pode incluir item comprado manualmente antes).
  **Mitigado:** copy honesto ("fora da reposição automática", não "nunca comprado") + o motor **auto-protege
  contra encalhe** (só compra se `estoque_efetivo ≤ ponto_pedido` — item já estocado não dispara). Não
  filtrei `n_compras` (não excluir candidatos válidos; risco absoluto baixo — venda rara → d baixo → qtde baixa).
- **Cap não-global:** `estoque_maximo = ponto + lote` (ambos capados a cap_cobertura) → em estoque 0 compra
  até ~2×cap_cobertura no pior caso (LT ≥ cap_dias). Aceitável: é o comportamento normal de reposição (cobrir
  LT + giro); qtde absoluta é baixa (d baixo); a UI exibe o estoque-alvo p/ revisão. Cap global = v2 se preciso.
- **RLS:** view `security_invoker` → validar leitura com JWT de staff (não service_role) no smoke. A tela de
  revisão já lê a mãe + `sku_parametros`; `venda_items_history` é lida pelas sub-views da mãe → staff passa.

**Frontend (Opção B):** o hook lê `.from("v_sku_candidatos_primeira_compra" as never)` (view nova não está
nos types gerados até regen; cast `as never`, sem `any` → passa o lint). A view expõe `status_sugestao =
'CANDIDATO_PRIMEIRA_COMPRA'` constante p/ o mapeamento/SkuRow funcionarem igual.

## 🔧 FIX PÓS-PROD (2026-05-31) — inclui SKUs habilitados-sem-parâmetro (3 → 22 candidatos)

Migration `20260531120000_*` (separada, pós-#504). **Achado** (diagnóstico em prod): dos 22 recorrentes-fortes,
**19 estavam `habilitado_reposicao_automatica=TRUE` mas com `ponto_pedido` E `estoque_maximo` AMBOS NULL**
(0 parciais, 0 sem-linha). O motor exige os dois NOT NULL → não compravam; e a 1ª versão da view/RPC os
excluía pelo predicado `habilitado=false` (que eu pus a pedido do codex como "virgem"). **Limbo: habilitados
mas invisíveis** (~R$15k venda/180d). **Fix** (challenge codex): o sinal de "não configurado" é **params NULL**,
não o flag `habilitado` (ortogonal). Removido `AND COALESCE(habilitado_reposicao_automatica,false)=false` da
view **e** da RPC; trava de re-promoção fica em `ponto IS NULL AND estoque_maximo IS NULL` (pós-promoção
`ponto NOT NULL` → sai da view). View ganha coluna `ja_habilitado` → UI mostra badge "já habilitado, sem nº".
Validado em PG17 local (habilitado=true agora aparece; cap idêntico). **Follow-up registrado (não-bloqueante):**
investigar a CAUSA de SKUs ficarem `habilitado=true` sem params (importação/edição em massa/default?) — pode
afetar SKUs fora desta view.
