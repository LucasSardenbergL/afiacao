# Conserto da ordem do "melhor individual" — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parar de apresentar como veredicto uma escolha feita por uuid — a RPC do melhor individual elege por `id` em 98,7% dos pares medidos — entregando ordem persistida, honestidade de estado e duas células rotuladas no cartão.

**Architecture:** Uma coluna `ordem` (rank **denso**) e uma coluna `referencia_ambigua` passam a viajar no payload do writer; uma RPC nova devolve **um objeto por (cliente, tipo)** com identidade (`produtos`) separada da eleição (`produto_eleito`) e uma `situacao` de 5 estados avaliada por precedência; o leitor valida invariantes entre campos e o cartão mostra duas células rotuladas. A RPC antiga continua servindo o front antigo até o Publish ser adotado.

**Tech Stack:** Postgres 17 (migration manual via SQL Editor do Lovable) · React 18 + TS 5.8 strict · vitest · `bash` + `psql` para o harness PG.

## Global Constraints

- **Spec autoritativa:** `docs/superpowers/specs/2026-09-07-rpc-melhor-individual-ordem-design.md` (revisão 4). Divergência entre plano e spec = a spec vence, e o plano é corrigido.
- **`supabase/migrations/` é DR — NUNCA aplicar de lá.** A migration é colada pelo founder no SQL Editor (skill `lovable-db-operator`). O arquivo no repo é registro.
- **Escrita no banco só pelo founder.** Leitura/diagnóstico: `~/.config/afiacao/psql-ro`, sempre com `-v ON_ERROR_STOP=1` e marcador positivo de fim.
- **`CREATE OR REPLACE` de função:** pré-flight obrigatório com `pg_get_functiondef` da PROD; a última a recriar vence.
- **Nomenclatura pt-BR** em código, rotas e commits.
- **Arquivo novo em `src/` precisa de dono** em `src/lib/modulos/manifesto.ts` (`codigo` e `testes`), senão `manifesto.gate` falha só no CI.
- **Ausente ≠ zero:** nunca `Number(null)`, nunca default que afirme medição não feita.
- **Rank DENSO** (empatados compartilham o valor). Posições distintas mudariam o endereço do bug de uuid para índice de array.
- **Toda validação conta só com evidência positiva:** rodar o comando, ver terminar, capturar `exit 0` colado.

---

## Estrutura de arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/migrations/2026…_farmer_ordem_e_referencia_ambigua.sql` *(criar)* | colunas novas + `CREATE OR REPLACE` do writer + `CREATE` da RPC nova |
| `src/lib/farmer/rank-denso.ts` *(criar)* | rank denso genérico, sobre um comparador — usado pelos dois tipos |
| `src/lib/farmer/melhor-individual.ts` *(criar)* | contrato do leitor: tipos dos 5 estados + validação com invariantes cruzados |
| `src/lib/farmer/upsell-ordem.ts` *(modificar)* | exportar o predicado de empate para o rank denso |
| `src/hooks/useCrossSellEngine.ts` *(modificar)* | flag por cliente · rank denso nos dois tipos · D3 · payload |
| `src/hooks/useBundleEngine.ts` *(modificar)* | os 7 pontos de §3.6 |
| `src/components/farmer/bundles/CustomerBundleCard.tsx` *(modificar)* | duas células rotuladas, 5 estados |
| `db/test-farmer-head-geracao.sh` *(modificar)* | contrato do banco + falsificação |

---

### Task 1: Migration — colunas, writer e RPC nova

**Files:**
- Create: `supabase/migrations/20260907HHMMSS_farmer_ordem_e_referencia_ambigua.sql`

**Interfaces:**
- Produces: colunas `farmer_recommendations.ordem smallint NULL` e `.referencia_ambigua boolean NULL`; `farmer_recomendacoes_substituir` aceitando as duas chaves em `p_linhas`; `farmer_melhores_individuais_por_cliente(uuid) RETURNS jsonb`.
- Consumes: definição de PROD de `farmer_recomendacoes_substituir` (8 parâmetros, o último `p_head_visto uuid DEFAULT NULL`).

- [ ] **Step 1: Pré-flight contra a PROD**

```bash
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "
SELECT pg_get_functiondef('public.farmer_recomendacoes_substituir(uuid,uuid,uuid,jsonb,text,text,jsonb,uuid)'::regprocedure);
SELECT 'FIM-OK-PREFLIGHT';"
```

Esperado: a definição atual, terminando com o marcador. Se a assinatura não existir, **parar**: o apply manual divergiu do repo e o `CREATE OR REPLACE` do passo seguinte apagaria o que está em produção.

- [ ] **Step 2: Escrever a migration**

Três blocos, nesta ordem. O corpo do writer é a definição de PROD do Step 1 com **exatamente** estas mudanças:

1. Colunas:

```sql
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS ordem              smallint,
  ADD COLUMN IF NOT EXISTS referencia_ambigua boolean;

COMMENT ON COLUMN public.farmer_recommendations.ordem IS
  'Rank DENSO dentro de (farmer_id, customer_user_id, recommendation_type, run_id): empatados compartilham o valor. NULL = geracao gravada por produtor que nao calcula rank. Posicoes distintas mudariam o endereco do bug de uuid para indice de array.';
COMMENT ON COLUMN public.farmer_recommendations.referencia_ambigua IS
  'up_sell: o preco de referencia do cliente saiu de um desempate por uuid (preco-referencia.ts). NULL = nao medido — NAO usar DEFAULT false, que afirmaria medicao sobre linha legada.';
```

2. No writer, a lista de colunas do bloco de **validação** (etapa 6) ganha as duas, e a validação ganha uma cláusula:

```sql
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric,
    ordem                   smallint,
    referencia_ambigua      boolean
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        )
     -- `ordem` é opcional (produtor legado não a emite), mas quando vem tem de ser rank:
     -- 0 e negativos não são posição, e um `smallint` fora de faixa já explodiu no cast.
     OR (r.ordem IS NOT NULL AND r.ordem < 1);
```

⚠️ `jsonb_to_recordset` **falha** no cast quando a chave existe com tipo errado (`"x"` para `smallint`, `"talvez"` para `boolean`) — o erro vem do cast, não do `WHERE`, e é o comportamento desejado: o lote inteiro é recusado antes de expirar nada. O harness prova as duas portas.

3. No `INSERT` do writer, as duas colunas entram na lista, no `SELECT` e na lista do `jsonb_to_recordset` do `FROM` (que é **outra** lista, separada da validação):

```sql
  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    ordem, referencia_ambigua,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij, NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    r.ordem, r.referencia_ambigua,
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric,
    ordem                   smallint,
    referencia_ambigua      boolean
  );
```

4. A RPC nova:

```sql
CREATE OR REPLACE FUNCTION public.farmer_melhores_individuais_por_cliente(p_farmer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', pg_temp
AS $fn$
  WITH base AS (
    SELECT r.customer_user_id, r.recommendation_type, r.product_id,
           r.affinity_score, r.run_id, r.ordem, r.referencia_ambigua
    FROM public.farmer_recommendations r
    WHERE r.farmer_id = p_farmer_id
      AND r.status = 'pendente'
      AND r.affinity_score IS NOT NULL
  ),
  grupo AS (
    SELECT customer_user_id, recommendation_type,
           count(*)                                       AS candidatos,
           count(*) FILTER (WHERE ordem IS NULL)           AS sem_ordem,
           min(ordem)                                      AS ordem_minima,
           -- fail-closed de §5.2: NULL na flag COM ordem preenchida conta como ambígua.
           bool_or(coalesce(referencia_ambigua, ordem IS NOT NULL)) AS ambigua,
           max(affinity_score)                             AS affinity_score,
           (array_agg(run_id ORDER BY ordem NULLS LAST, id))[1] AS run_id
    FROM base GROUP BY 1, 2
  ),
  situado AS (
    SELECT g.*,
      CASE
        WHEN g.ambigua                        THEN 'referencia_ambigua'
        WHEN g.candidatos >= 2
         AND g.sem_ordem > 0                  THEN 'ordem_indisponivel'
        WHEN g.candidatos = 1                 THEN 'unico_registrado'
        ELSE NULL  -- decidido abaixo, precisa contar quantos estão no rank mínimo
      END AS situacao_parcial
    FROM grupo g
  ),
  topo AS (
    SELECT s.customer_user_id, s.recommendation_type,
           count(*) AS no_topo
    FROM situado s
    JOIN base b USING (customer_user_id, recommendation_type)
    WHERE s.situacao_parcial IS NULL AND b.ordem = s.ordem_minima
    GROUP BY 1, 2
  ),
  final AS (
    SELECT s.customer_user_id, s.recommendation_type, s.candidatos,
           s.affinity_score, s.run_id, s.ordem_minima,
           coalesce(s.situacao_parcial,
                    CASE WHEN t.no_topo > 1 THEN 'empatado' ELSE 'eleito' END) AS situacao
    FROM situado s LEFT JOIN topo t USING (customer_user_id, recommendation_type)
  ),
  montado AS (
    SELECT f.customer_user_id, f.recommendation_type, f.situacao, f.candidatos,
           f.affinity_score, f.run_id,
           (SELECT coalesce(jsonb_agg(b.product_id ORDER BY b.product_id), '[]'::jsonb)
              FROM base b
             WHERE b.customer_user_id = f.customer_user_id
               AND b.recommendation_type = f.recommendation_type
               -- `eleito`/`empatado` nomeiam o TOPO; os demais nomeiam o grupo inteiro.
               AND (f.situacao NOT IN ('eleito','empatado') OR b.ordem = f.ordem_minima)
           ) AS produtos,
           CASE WHEN f.situacao = 'eleito' THEN
             (SELECT b.product_id FROM base b
               WHERE b.customer_user_id = f.customer_user_id
                 AND b.recommendation_type = f.recommendation_type
                 AND b.ordem = f.ordem_minima LIMIT 1)
           END AS produto_eleito
    FROM final f
  )
  SELECT coalesce(
           jsonb_agg(to_jsonb(m) ORDER BY m.customer_user_id, m.recommendation_type),
           '[]'::jsonb)
  FROM montado m
$fn$;

REVOKE ALL ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) TO service_role;
```

⚠️ `SECURITY INVOKER` de propósito, como a RPC antiga: `frec_select_carteira` segue sendo a única fronteira e `p_farmer_id` é filtro, não autorização. ⚠️ A RPC antiga **não** é derrubada aqui (§3.4) — ela serve o front antigo até a adoção do Publish.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/ && git commit -m "feat(db): ordem densa e referencia_ambigua no melhor individual"
```

---

### Task 2: Harness PG17 — o contrato do banco

**Files:**
- Modify: `db/test-farmer-head-geracao.sh`

**Interfaces:**
- Consumes: a migration da Task 1.
- Produces: asserts nomeados `O*` (ordem) e `S*` (situação) reutilizados pelas sabotagens da Task 8.

⚠️ **Este harness e não o `test-farmer-geracao-vigente.sh`**: aquele aplica só a `20260814223445` e exercita uma assinatura de `farmer_recomendacoes_substituir` **sem `p_head_visto`**, que não é a que o front chama (`useCrossSellEngine.ts:1205`).

- [ ] **Step 1: Aplicar a migration nova na ZONA 2**

Depois de `P -q -f "$MIG"` (linha ~185), acrescentar:

```bash
MIG_ORDEM="$REPO_ROOT/supabase/migrations/20260907HHMMSS_farmer_ordem_e_referencia_ambigua.sql"
P -q -f "$MIG_ORDEM"
P -q -f "$MIG_ORDEM"   # idempotência: o founder pode re-colar
ok "I2 migration da ordem é idempotente (aplicada 2x sem erro)"
```

- [ ] **Step 2: Escrever os asserts de situação — os cinco estados e a precedência**

Um grupo por estado, semeando via a RPC real (não `INSERT` direto — a gravação é parte do contrato):

```bash
sit() {  # sit <cliente> <tipo> -> a situacao que a RPC devolve
  Pq -c "SELECT j->>'situacao' FROM jsonb_array_elements(
           public.farmer_melhores_individuais_por_cliente('$FARMER_A')) j
          WHERE j->>'customer_user_id' = '$1' AND j->>'recommendation_type' = '$2';"
}
eq "$(sit "$CLI_ELEITO" cross_sell)"      "eleito"              "S1 topo único com ordem conhecida"
eq "$(sit "$CLI_EMPATE" cross_sell)"      "empatado"            "S2 dois no rank mínimo"
eq "$(sit "$CLI_SINGLETON" up_sell)"      "unico_registrado"    "S3 singleton NUNCA é eleito"
eq "$(sit "$CLI_PARCIAL" cross_sell)"     "ordem_indisponivel"  "S4 [1,2,null] é incompleta"
eq "$(sit "$CLI_AMBIGUO" up_sell)"        "referencia_ambigua"  "S5 flag vence empate E eleição"
eq "$(sit "$CLI_FLAG_NULA" up_sell)"      "referencia_ambigua"  "S6 flag NULL com ordem preenchida é fail-closed"
```

⚠️ `CLI_SINGLETON` é semeado com `ordem` **nula** e um único candidato. A revisão 3 do plano exigia `eleito` aqui **e** `unico_registrado` noutro assert — oráculo contraditório; a precedência de §3.3 resolve, e este assert é o que a prende.

- [ ] **Step 3: Escrever os asserts de payload — `produtos`, `candidatos`, `produto_eleito`**

O caso `[A:1, B:1, C:2]`, que é onde a revisão 3 mentia:

```bash
eq "$(Pq -c "SELECT jsonb_array_length(j->'produtos') FROM … WHERE cliente='$CLI_EMPATE' …")" \
   "2" "O1 produtos nomeia só o TOPO no empate"
eq "$(Pq -c "SELECT j->>'candidatos' FROM … WHERE cliente='$CLI_EMPATE' …")" \
   "3" "O2 candidatos é o GRUPO inteiro, não o topo"
eq "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(public.farmer_melhores_individuais_por_cliente('$FARMER_A')) j
              WHERE (j->>'produto_eleito' IS NOT NULL) <> (j->>'situacao' = 'eleito');")" \
   "0" "O3 produto_eleito não-nulo ⟺ eleito, sem exceção na carteira"
```

- [ ] **Step 4: Escrever os negativos — SQLSTATE nomeada, re-lançando o resto**

```bash
neg() {  # neg <json-de-p_linhas> <sqlstate-esperada> <rotulo>
  local saida; saida=$(P -tA -c "
    DO \$\$ BEGIN
      PERFORM public.farmer_recomendacoes_substituir('$FARMER_A', gen_random_uuid(), NULL, '$1'::jsonb);
      RAISE EXCEPTION 'NAO-RECUSOU';
    EXCEPTION WHEN SQLSTATE '$2' THEN RAISE NOTICE 'RECUSOU-COMO-ESPERADO';
    END \$\$;" 2>&1 || true)
  case "$saida" in *RECUSOU-COMO-ESPERADO*) ok "$3" ;; *) bad "$3 — veio: $(printf '%s' "$saida" | head -c 200)" ;; esac
}
neg '[{…,"ordem":0}]'                  FG007 "N1 ordem 0 recusada"
neg '[{…,"ordem":-1}]'                 FG007 "N2 ordem negativa recusada"
neg '[{…,"referencia_ambigua":"talvez"}]' 22P02 "N3 flag não-booleana morre no cast, antes de expirar"
```

⚠️ O `WHEN OTHERS THEN 'OK'` está proibido: a cláusula captura a SQLSTATE **esperada** e qualquer outra sobe. Um teste que aceita "lançou algo" aprovaria a exceção errada.

- [ ] **Step 5: RLS e ACL**

```bash
eq "$(Pq -c "SET ROLE authenticated; SET request.jwt.claims TO '{\"sub\":\"$FARMER_B\"}';
             SELECT jsonb_array_length(public.farmer_melhores_individuais_por_cliente('$FARMER_A'));")" \
   "0" "R1 carteira alheia não volta sob RLS"
eq "$(Pq -c "SELECT has_function_privilege('anon','public.farmer_melhores_individuais_por_cliente(uuid)','EXECUTE');")" \
   "f" "R2 anon não executa"
```

- [ ] **Step 6: Rodar o harness e capturar o exit code colado**

```bash
bash db/test-farmer-head-geracao.sh; echo "EXIT=$?"
```

Esperado: todos os `ok`, `EXIT=0`. Ausência de vermelho **não** é aprovação: conferir que a contagem de asserts subiu na linha de resumo.

- [ ] **Step 7: Commit**

```bash
git add db/ && git commit -m "test(db): contrato dos 5 estados do melhor individual"
```

---

### Task 3: `rank-denso.ts` — o rank, isolado do motor

**Files:**
- Create: `src/lib/farmer/rank-denso.ts`
- Create: `src/lib/farmer/__tests__/rank-denso.test.ts`
- Modify: `src/lib/farmer/upsell-ordem.ts`
- Modify: `src/lib/modulos/manifesto.ts`

**Interfaces:**
- Produces: `rankDenso<T>(itens: readonly T[], comparar: (a:T,b:T)=>number): number[]` — devolve, na ordem de `itens`, o rank 1-based **denso**; e `chavesEmpatam` exportado de `upsell-ordem.ts`.
- Consumes: `compararCandidatosUpSell` de `upsell-ordem.ts`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
import { describe, expect, it } from 'vitest';
import { rankDenso } from '../rank-denso';

const num = (a: number, b: number) => a - b;

describe('rankDenso', () => {
  it('empatados COMPARTILHAM o rank, e o seguinte não pula', () => {
    // Denso, não competition ranking: [1,1,2] e nunca [1,1,3] — e nunca [1,2,3],
    // que é o bug trocando de endereço (uuid → índice do array).
    expect(rankDenso([10, 10, 20], num)).toEqual([1, 1, 2]);
  });

  it('devolve os ranks na ordem de ENTRADA, não na ordenada', () => {
    expect(rankDenso([30, 10, 20], num)).toEqual([3, 1, 2]);
  });

  it('não reordena a entrada', () => {
    const entrada = [30, 10, 20];
    rankDenso(entrada, num);
    expect(entrada).toEqual([30, 10, 20]);
  });

  it('lista vazia devolve vazio', () => {
    expect(rankDenso([], num)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/lib/farmer/__tests__/rank-denso.test.ts; echo "EXIT=$?"
```

Esperado: FAIL — `Failed to resolve import "../rank-denso"`.

- [ ] **Step 3: Implementar**

```ts
/**
 * Rank DENSO 1-based sobre um comparador — a peça que faz a ordem sobreviver à persistência.
 *
 * DENSO e não posicional: candidatos indistinguíveis para o comparador recebem o MESMO
 * número. Numerar 1,2,3 entre empatados seria trocar o endereço do defeito que esta entrega
 * conserta — hoje o desempate é `id` uuid, e viraria "índice no array", que é a ordem de
 * varredura do catálogo. Um empate compartilhado é a afirmação verdadeira: o sinal não
 * separou estes dois.
 *
 * O empate é derivado do PRÓPRIO comparador (`comparar(a,b) === 0`) em vez de um predicado
 * paralelo: dois critérios de igualdade divergem no dia em que um dos dois muda, e a
 * divergência apareceria como eleição fabricada.
 */
export function rankDenso<T>(itens: readonly T[], comparar: (a: T, b: T) => number): number[] {
  const indices = itens.map((_, i) => i);
  indices.sort((x, y) => comparar(itens[x], itens[y]));

  const ranks = new Array<number>(itens.length);
  let rank = 0;
  for (let p = 0; p < indices.length; p++) {
    if (p === 0 || comparar(itens[indices[p - 1]], itens[indices[p]]) !== 0) rank++;
    ranks[indices[p]] = rank;
  }
  return ranks;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/lib/farmer/__tests__/rank-denso.test.ts; echo "EXIT=$?"
```

Esperado: 4 passed, `EXIT=0`.

- [ ] **Step 5: Registrar no manifesto**

Em `src/lib/modulos/manifesto.ts`, no módulo que já dona `src/lib/farmer/upsell-ordem.ts`, acrescentar `"src/lib/farmer/rank-denso.ts"` em `codigo` e `"src/lib/farmer/__tests__/rank-denso.test.ts"` em `testes`. Sem isso o `manifesto.gate` reprova **só no CI**.

- [ ] **Step 6: Commit**

```bash
git add src/lib/farmer/ src/lib/modulos/manifesto.ts
git commit -m "feat(farmer): rank denso, com o empate derivado do proprio comparador"
```

---

### Task 4: Motor — a flag de referência ambígua, por CLIENTE

**Files:**
- Modify: `src/hooks/useCrossSellEngine.ts:695`
- Test: `src/hooks/__tests__/cross-sell-referencia-ambigua.test.tsx`

**Interfaces:**
- Produces: `Set<string>` de clientes com referência ambígua, consumido pela Task 5 ao montar `recRows`.

- [ ] **Step 1: Escrever o teste que falha — o contraexemplo do challenge**

O caso que a revisão 3 não cobria: a flag tem de sobreviver à **deduplicação**, que escolhe outra base.

```tsx
it('marca o cliente mesmo quando a base ambígua PERDE a deduplicação', async () => {
  // Base A: dois pedidos no MESMO instante, preços 100 e 200 → referência decidida por uuid.
  // Base B: referência inequívoca de 150.
  // Candidatos X=230 e Y=180, mesma família/unidade, mesma popularidade.
  // Com referência 100, X e Y são ambos melhores via B — e nenhuma linha nasceria marcada
  // se a flag fosse da RELAÇÃO. Ela é do CLIENTE, então sobrevive.
  const { linhas } = await rodarMotor(cenarioDuasBases());
  expect(linhas.filter((l) => l.recommendation_type === 'up_sell')).toSatisfyAll(
    (l) => l.referencia_ambigua === true,
  );
});

it('cross_sell recebe false explícito — o tipo não usa preço de referência', async () => {
  const { linhas } = await rodarMotor(cenarioDuasBases());
  expect(linhas.filter((l) => l.recommendation_type === 'cross_sell')).toSatisfyAll(
    (l) => l.referencia_ambigua === false,
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/hooks/__tests__/cross-sell-referencia-ambigua.test.tsx; echo "EXIT=$?"
```

Esperado: FAIL — `referencia_ambigua` é `undefined`.

- [ ] **Step 3: Implementar — marcar no ponto onde a informação existe**

Em `useCrossSellEngine.ts`, antes do laço de clientes, `const clientesComReferenciaAmbigua = new Set<string>();`. No laço de preços (L695), substituir:

```ts
            if (existing.precoEm === null || compararRecencia(marca, existing.precoEm) > 0) {
```

por:

```ts
            // A ambiguidade é do CLIENTE e é decidida AQUI — antes de elegibilidade, dedup e
            // corte. Marcar a relação vencedora não bastaria: a dedup guarda, por SKU, só a
            // melhor relação, e a razão de preço que decide essa "melhor" é justamente a que a
            // referência sorteada altera. O challenge executou o contraexemplo em que os mesmos
            // dois SKUs chegam à persistência nos dois mundos e a flag da relação some.
            //
            // Indistinguível = instantes iguais OU ambos ausentes (`compararRecencia` cai no
            // `pedidoId` nos dois casos) entre pedidos DISTINTOS, com preços diferentes.
            if (
              existing.precoEm !== null &&
              existing.precoEm.instante === marca.instante &&
              existing.precoEm.pedidoId !== marca.pedidoId &&
              existing.price !== precoItem
            ) {
              clientesComReferenciaAmbigua.add(cid);
            }
            if (existing.precoEm === null || compararRecencia(marca, existing.precoEm) > 0) {
```

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/hooks/__tests__/cross-sell-referencia-ambigua.test.tsx; echo "EXIT=$?"
```

Esperado: 2 passed, `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ && git commit -m "feat(farmer): ambiguidade da referencia marcada por CLIENTE, antes da dedup"
```

---

### Task 5: Motor — rank denso nos dois tipos, D3, e o payload

**Files:**
- Modify: `src/hooks/useCrossSellEngine.ts:1032-1046` e o bloco que monta `recRows`
- Test: `src/hooks/__tests__/cross-sell-rank-denso.test.tsx`

**Interfaces:**
- Consumes: `rankDenso` (Task 3), `clientesComReferenciaAmbigua` (Task 4).
- Produces: linhas de `p_linhas` com `ordem: number` e `referencia_ambigua: boolean`.

- [ ] **Step 1: Escrever os testes que falham**

```tsx
it('up-sell: empatados compartilham a ordem', async () => {
  const { linhas } = await rodarMotor(cenarioUpSellEmpatado());
  expect(linhas.map((l) => l.ordem)).toEqual([1, 1]);
});

it('cross-sell: D3 ordena pelo score NÃO arredondado', async () => {
  // k=[9,9,9,10] colidem em 0,0001 depois do Math.round(score*10000)/10000.
  // Pela ordem antiga o topo saía por ordem de inserção (uuid do catálogo).
  const { linhas } = await rodarMotor(cenarioQuatroSkusQuaseEmpatados());
  expect(linhas[0].product_id).toBe(SKU_K10);
  expect(linhas[0].ordem).toBe(1);
});

it('recRows carrega os dois campos novos', async () => {
  const { linhas } = await rodarMotor(cenarioMinimo());
  expect(Object.keys(linhas[0])).toEqual(expect.arrayContaining(['ordem', 'referencia_ambigua']));
});
```

⚠️ As fixtures de up-sell precisam de **múltiplas bases de compra com preços diferentes**: com uma base só, ordenar por `premium/referência` dá a mesma ordem que por `premium`, e a sabotagem da Task 8 passaria verde.

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/hooks/__tests__/cross-sell-rank-denso.test.tsx; echo "EXIT=$?"
```

Esperado: FAIL — `ordem` é `undefined`.

- [ ] **Step 3: Implementar**

Substituir o bloco de ordenação e corte (L1032-1046):

```ts
        const upSellOrdenado = [...upSellPorProduto.values()].sort((a, b) =>
          compararCandidatosUpSell(a.chave, b.chave),
        );
        const topUpCand = upSellOrdenado.slice(0, VAGAS_UP_SELL);
        const ordemUp = rankDenso(topUpCand.map((c) => c.chave), compararCandidatosUpSell);

        // D3: o cross-sell ordenava por `affinityScore`, que é o score ARREDONDADO a 4 casas —
        // 32 valores distintos em 714 linhas. Entre empatados o `sort` estável devolvia a ordem
        // de inserção, que é a varredura do catálogo (`.order('id')`): o top-3 do vendedor era
        // uuid. Passa a ordenar pelo score cru, que é o que o motor de fato calculou.
        crossSellRecs.sort((a, b) => b.scoreCru - a.scoreCru);
        const topCross = crossSellRecs.slice(0, 3);
        const ordemCross = rankDenso(topCross.map((r) => r.scoreCru), (a, b) => b - a);
```

⚠️ `scoreCru` **não existe hoje** — `Recommendation` só carrega `affinityScore`, que já vem
arredondado de `Math.round(affinityScore * 10000) / 10000`. Acrescentar o campo ao tipo interno e
preenchê-lo com o `pij` cru **antes** do arredondamento; sem ele, D3 é impossível de escrever e o
`sort` continua sendo o mesmo de hoje com outro nome.

E, ao montar `recRows`, cada linha recebe:

```ts
          ordem: ordemDoCandidato,                                  // 1-based, denso
          referencia_ambigua:
            tipo === 'up_sell' ? clientesComReferenciaAmbigua.has(cid) : false,
```

⚠️ `false` explícito no cross-sell é **afirmação verdadeira** sobre o tipo (o `pij` do cross-sell não usa preço), não silêncio — e é o que impede o fail-closed da RPC de marcar o tipo inteiro como ambíguo.

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/hooks/__tests__/; echo "EXIT=$?"
```

Esperado: toda a suíte do hook verde, `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ && git commit -m "feat(farmer): rank denso persistido nos dois tipos, e D3 pelo score cru"
```

---

### Task 6: Leitor — contrato, validação e os 7 pontos

**Files:**
- Create: `src/lib/farmer/melhor-individual.ts`
- Create: `src/lib/farmer/__tests__/melhor-individual.test.ts`
- Modify: `src/hooks/useBundleEngine.ts` (L57-95, 844, 1038-1080, 1163)
- Modify: `src/lib/modulos/manifesto.ts`

**Interfaces:**
- Produces: `type SituacaoIndividual` (5 estados), `type LinhaMelhorIndividual`, `validarRespostaMelhorIndividual(data: unknown): LinhaMelhorIndividual[]` (lança em resposta inválida), e `ComparacaoIndividual` ampliada.
- Consumes: a RPC da Task 1.

- [ ] **Step 1: Escrever o teste que falha — a linha que a revisão 3 deixava passar**

```ts
it('rejeita empatado com um produto só — o validador de campo a campo aceitava', () => {
  expect(() => validarRespostaMelhorIndividual([{
    customer_user_id: '11111111-1111-4111-8111-111111111111',
    recommendation_type: 'cross_sell',
    situacao: 'empatado',
    candidatos: 1,
    produtos: [],
    produto_eleito: null,
  }])).toThrow(/empatado exige/);
});

it('rejeita produto_eleito fora de eleito', () => { /* … situacao:'empatado', produto_eleito:'…' */ });
it('rejeita produto_eleito que não está em produtos', () => { /* … */ });
it('rejeita produtos com duplicata', () => { /* … */ });
it('rejeita length(produtos) > candidatos', () => { /* … */ });
it('aceita o caso [A:1,B:1,C:2]: produtos 2, candidatos 3', () => { /* … não lança */ });
```

⚠️ `toThrow(/empatado exige/)` casa a **marca do ramo**, não "lançou algo": um `toThrow()` pelado aprovaria a exceção errada.

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/lib/farmer/__tests__/melhor-individual.test.ts; echo "EXIT=$?"
```

Esperado: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o contrato**

```ts
export type SituacaoIndividual =
  | 'eleito' | 'empatado' | 'unico_registrado' | 'ordem_indisponivel' | 'referencia_ambigua';

export interface LinhaMelhorIndividual {
  customer_user_id: string;
  recommendation_type: 'cross_sell' | 'up_sell';
  situacao: SituacaoIndividual;
  produtos: string[];
  produto_eleito: string | null;
  candidatos: number;
  affinity_score: number | null;
  run_id: string | null;
}

/**
 * Valida a resposta INTEIRA — e lança, em vez de filtrar.
 *
 * Descartar as linhas inválidas transformaria falha em ausência: o Map ficaria parcial e
 * seria apresentado como completo, e `nenhum` é um VEREDICTO na tela. O consumidor trata a
 * exceção como `leitura_falhou`, que vale para a carteira inteira e é honesto.
 *
 * Os invariantes ENTRE campos são o ponto: campo a campo,
 * `{situacao:'empatado', candidatos:1, produtos:[]}` passa em "tipo reconhecido", "inteiro ≥1"
 * e "sem eleito fora de eleito" — e não representa empate nenhum.
 */
export function validarRespostaMelhorIndividual(data: unknown): LinhaMelhorIndividual[] {
  if (!Array.isArray(data)) throw new Error(`resposta nao-array: ${data === null ? 'null' : typeof data}`);
  const vistos = new Set<string>();
  return data.map((bruta, i) => {
    const l = bruta as Record<string, unknown>;
    const onde = `linha ${i}`;
    if (typeof l.customer_user_id !== 'string') throw new Error(`${onde}: customer_user_id ausente`);
    if (l.recommendation_type !== 'cross_sell' && l.recommendation_type !== 'up_sell')
      throw new Error(`${onde}: tipo desconhecido ${String(l.recommendation_type)}`);
    const chave = `${l.customer_user_id}:${l.recommendation_type}`;
    if (vistos.has(chave)) throw new Error(`${onde}: (cliente,tipo) duplicado`);
    vistos.add(chave);

    if (!SITUACOES.has(l.situacao as string)) throw new Error(`${onde}: situacao invalida`);
    if (!Number.isInteger(l.candidatos) || (l.candidatos as number) < 1)
      throw new Error(`${onde}: candidatos precisa ser inteiro >= 1`);
    if (!Array.isArray(l.produtos) || l.produtos.length < 1 || !l.produtos.every((p) => typeof p === 'string'))
      throw new Error(`${onde}: produtos precisa ser array nao-vazio de uuid`);
    if (new Set(l.produtos).size !== l.produtos.length) throw new Error(`${onde}: produtos com duplicata`);
    if (l.produtos.length > (l.candidatos as number))
      throw new Error(`${onde}: produtos (${l.produtos.length}) excede candidatos (${l.candidatos})`);

    const eleito = l.situacao === 'eleito';
    if ((l.produto_eleito != null) !== eleito)
      throw new Error(`${onde}: produto_eleito nao-nulo tem de ser exatamente o estado eleito`);
    if (eleito && !l.produtos.includes(l.produto_eleito as string))
      throw new Error(`${onde}: produto_eleito fora de produtos`);

    // Cardinalidade POR estado — o invariante que a validacao campo-a-campo nao alcanca.
    if (l.situacao === 'empatado' && (l.produtos.length < 2 || (l.candidatos as number) < 2))
      throw new Error(`${onde}: empatado exige >=2 produtos e >=2 candidatos`);
    if (l.situacao === 'ordem_indisponivel' && (l.produtos.length < 2 || (l.candidatos as number) < 2))
      throw new Error(`${onde}: ordem_indisponivel exige >=2 produtos e >=2 candidatos`);
    if (l.situacao === 'unico_registrado' && (l.produtos.length !== 1 || l.candidatos !== 1))
      throw new Error(`${onde}: unico_registrado exige exatamente 1 produto e 1 candidato`);
    if (eleito && (l.produtos.length !== 1 || (l.candidatos as number) < 2))
      throw new Error(`${onde}: eleito exige 1 produto nomeado e >=2 candidatos`);

    return l as unknown as LinhaMelhorIndividual;
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/lib/farmer/__tests__/melhor-individual.test.ts; echo "EXIT=$?"
```

- [ ] **Step 5: Aplicar os 7 pontos em `useBundleEngine.ts`**

| # | onde | mudança |
|---|---|---|
| 1 | L844 | chave do Map vira `` `${linha.customer_user_id}:${linha.recommendation_type}` `` |
| 2 | L1046-1055 | resolve nome de **todos** os SKUs de `produtos`, não só do eleito |
| 3 | novo | nenhum resolve → `indisponivel/produto_nao_resolve`; **alguns** resolvem → mantém a `situacao` e reporta `naoIdentificados` |
| 4 | L1163 | o sensor conta só SKU que não resolve — estado sem eleição não é falha de catálogo |
| 5 | L1073 | omite o cliente só quando **ambos** os tipos são `nenhum` |
| 6 | L823-843 | `validarRespostaMelhorIndividual` no lugar do cast; a exceção cai no `catch` que já existe |
| 7 | L1057 | `geracoesExibidas.add` passa a acompanhar **todo estado exibido** |

- [ ] **Step 6: Rodar a suíte inteira do leitor**

```bash
heavy bun run test src/hooks/__tests__/; echo "EXIT=$?"
```

- [ ] **Step 7: Registrar no manifesto e commitar**

```bash
git add src/lib/farmer/ src/hooks/ src/lib/modulos/manifesto.ts
git commit -m "feat(farmer): leitor com invariantes cruzados e nome em todo estado"
```

---

### Task 7: Cartão — duas células rotuladas

**Files:**
- Modify: `src/components/farmer/bundles/CustomerBundleCard.tsx` (L68, L107-108)
- Test: `src/components/farmer/bundles/__tests__/customer-bundle-card-individuais.test.tsx`

**Interfaces:**
- Consumes: `ComparacaoIndividual` ampliada (Task 6).

- [ ] **Step 1: Escrever os testes que falham**

Um por estado, mais o que prende o achado R3/3:

```tsx
it('empatado com um nome faltando NÃO promove o outro a vencedor', () => {
  render(<CustomerBundleCard data={comEmpateComUmSkuForaDoCatalogo()} />);
  expect(screen.getByText(/Igualmente indicados/)).toBeInTheDocument();
  expect(screen.getByText(/1 de 2 não identificado/)).toBeInTheDocument();
  expect(screen.queryByText(/Melhor complementar: /)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/components/farmer/bundles/__tests__/; echo "EXIT=$?"`

- [ ] **Step 3: Implementar as duas células**

Rótulos: "Melhor complementar" (cross_sell) e "Melhor upgrade" (up_sell). Copy por estado, exatamente como a tabela de §3.6.

- [ ] **Step 4: Rodar e ver passar** — mesma linha do Step 2, `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add src/components/ && git commit -m "feat(farmer): cartao com duas celulas rotuladas e os cinco estados"
```

---

### Task 8: Falsificação — uma camada por vez

**Files:**
- Modify: `db/test-farmer-head-geracao.sh` (bloco `--falsificar`)

- [ ] **Step 1: Commitar TUDO antes de sabotar**

`restaurar()` costuma ser `git checkout --`: sabotar com trabalho não commitado apaga o trabalho.

```bash
git status --porcelain; echo "EXIT=$?"
```

Esperado: **saída vazia**.

- [ ] **Step 2: Linha de base VERDE na mesma invocação**

O laço roda o controle **antes** do primeiro `sed` e aborta se ele não estiver verde. Sem isso, uma suíte sempre-vermelha aprova todas as sabotagens.

- [ ] **Step 3: As seis sabotagens, conferindo contagem E nomes**

| sabotagem | vermelho esperado |
|---|---|
| dedup guarda só a flag da relação vencedora | `S5` |
| D3 volta ao score arredondado | `cross-sell: D3 ordena pelo score NÃO arredondado` |
| `rankDenso` numera 1,2,3 entre empatados | `empatados COMPARTILHAM o rank` + `O1` + `S2` |
| `recRows` omite `ordem` | `recRows carrega os dois campos novos` + `S1` |
| leitor descarta linha inválida em vez da resposta | `rejeita empatado com um produto só` |
| RPC avalia `empatado` antes de `referencia_ambigua` | `S5` |

Cada uma tem de produzir **exatamente** o conjunto declarado. Uma sabotagem que fica verde significa camada redundante ou inalcançada; uma que fica vermelha demais significa que o assert não isola o ramo.

- [ ] **Step 4: Rodar a falsificação inteira**

```bash
bash db/test-farmer-head-geracao.sh --falsificar; echo "EXIT=$?"
```

Esperado: cada sabotagem nomeada com seu conjunto de vermelhos, `EXIT=0`. ⚠️ Terminar rápido demais é sinal de que a suíte não rodou.

- [ ] **Step 5: Commit**

```bash
git add db/ && git commit -m "test(db): falsificacao das seis camadas do conserto da ordem"
```

---

### Task 9: Sensor da distribuição (§6.1) e entrega

**Files:**
- Modify: a edge/RPC que grava o log de execuções (`20260815181500_farmer_geracao_head_sensor.sql:446`)

- [ ] **Step 1: Emitir a contagem por `situacao` e tipo no log de execuções**

Server-side, porque o produtor legado não sabe emiti-la, e no log (que tem denominador) em vez de insumo do head (que é sobrescrito).

- [ ] **Step 2: Health stack completo**

```bash
heavy bun run typecheck; echo "EXIT=$?"
bun run lint; echo "EXIT=$?"
heavy bun run test; echo "EXIT=$?"
bunx knip; echo "EXIT=$?"
bun run lint:shell; echo "EXIT=$?"
```

Cada um tem de terminar e mostrar `EXIT=0` colado.

- [ ] **Step 3: RE-conferir a main imediatamente antes do PR**

`useCrossSellEngine.ts` é arquivo QUENTE (mudou +64 linhas hoje, por outra sessão).

```bash
git fetch origin && git log --oneline origin/main -5 && gh pr list --state open
git grep -l "farmer_melhores_individuais_por_cliente" origin/main || echo "artefato ainda nao esta na main"
```

- [ ] **Step 4: Escrever a sequência de implantação no corpo do PR**

A ordem é obrigatória e cada passo é MANUAL (Lovable):
**1. banco** (founder cola a migration no SQL Editor) → **2. Publish** → **3. recálculo**, que grava
os primeiros ranks → **4. PR de limpeza** derruba a RPC antiga. Inverter 1 e 2 faz o
`jsonb_to_recordset` ignorar as chaves novas **em silêncio**: nada persiste e nada falha.

- [ ] **Step 5: Abrir o PR e armar o watch**

```bash
gh pr create --draft --title "…" --body "…"
scripts/pr-watch.sh <nº> &
```

⚠️ **DRAFT**: o auto-merge squasha qualquer PR não-draft assim que o `validate` passa, e esta entrega depende de uma migration manual aplicada ANTES do Publish.
