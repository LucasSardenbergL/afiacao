# RLS: o que de fato roda por linha (plano v5, D4 — diagnóstico, sem PR de banco)

**Data:** 2026-11-04 · **Plano:** `docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md` §2 "D4" (veredito: DIAGNÓSTICO apenas, EXPLAIN por persona, nada em massa) · **Leitura só por `psql-ro`; nada escrito em prod.**

## Problema

O plano trouxe dois números: "436 policies com `auth.uid()` cru" e "26 `has_role` residuais". O Codex observou que o histórico do v4 registra **zero** `has_role` cru no `public` depois da migration `20261102204836` ([rls-has-role-initplan-classe.md](rls-has-role-initplan-classe.md)), então os dois lados precisavam de nomes para fechar a conta.

Contar no texto não responde a pergunta que importa: **o que é avaliado uma vez por consulta e o que é avaliado a cada linha**. `( SELECT has_role(…) OR has_role(…) )` tem `has_role` "cru" dentro, mas o sublink inteiro vira InitPlan e roda 1×. O regex da 1ª passada deste diagnóstico deu 62 policies "cruas" no `public`, e todas eram desse tipo, ou seja, falso positivo.

## O método

As policies foram lidas da prod (`pg_policy.polqual`/`polwithcheck` como `pg_node_tree`, 805 policies), junto com as funções `SECURITY DEFINER` de **todos** os schemas e o oid de `auth.uid()`. Um parser da árvore classifica cada chamada:

- **1×**: tem algum `SUBLINK` ancestral **não correlacionado**, sem `VAR` que aponte para fora dele. O planejador transforma esse sublink em InitPlan.
- **por linha**: todo o resto, inclusive dentro de sublink correlacionado.

Os controles batem com o texto: `omie_products_select_staff` (`( SELECT (has_role(…) OR has_role(…)) )`) dá 0 por linha, e `melhoria_itens_select` (`autor_user_id = ( SELECT auth.uid() ) OR has_role(( SELECT auth.uid() ), 'master')`) dá 1 `has_role` por linha e 0 `auth.uid()` por linha.

O claude_ro não pode medir por persona: `SET ROLE authenticated` dá `permission denied` e ele não tem EXECUTE em `private.*`. Por isso os custos abaixo vêm de duas fontes: micro-medição do corpo inlinado com GUC sintética (sem token real) e a medida do v4 para `has_role`. A medida por persona fica como consulta para o founder, no fim.

## O que a árvore mostrou

| Schema | Policies | `auth.uid()` por linha | Com `SECURITY DEFINER` por linha | Chamadas SECDEF por linha |
|---|---|---|---|---|
| `public` | 764 | 78 | 57 | 84 |
| `storage` | 35 | 26 | 24 | 79 |
| `realtime` | 4 | 4 | 4 | 16 |

### 1. Os "26 `has_role` residuais" existem, com nome, e a migration de 02/11 não os via

Eram **26 policies no `public`**, número exato do plano, em 20 tabelas: as de `pcp_*`, `melhoria_*`, `cliente_tier_preco*`, `tier_preco_config`, `reposicao_po_observado_*` e `recebimento_associacao_sombra`. Todas usam a forma **meio embrulhada**:

```sql
has_role(( SELECT auth.uid() AS uid), 'master'::app_role)
```

O `auth.uid()` vai para InitPlan, mas o `has_role`, que é SECDEF e não inlina, continua sendo chamado a cada linha. O regex da migration de 02/11 só casava `has_role(auth.uid(), '…'::app_role)` literal, e por isso o "zero cru" dela era verdade **para a forma que ela procurava**. Também é a forma que o advisor do Supabase sugere ("embrulhe o `auth.uid()`"), o que explica a recorrência.

**Peso hoje: baixo.** A maior tabela é `reposicao_po_observado_item`, com ~10,5 mil linhas e 34 `idx_scan` desde o restart; o resto tem até ~4 mil linhas e `seq_tup_read` ≈ 0. A ~38 µs por chamada (medida do v4), o pior caso é ~0,4 s para quem NÃO vê a tabela inteira.

### 2. Achado maior: `private.carteira_visivel_para` roda por linha nas tabelas da carteira

```sql
USING (private.carteira_visivel_para(customer_user_id, auth.uid()))
```

A função é SQL `SECURITY DEFINER` e recebe uma **coluna** como argumento, então não há como ela virar InitPlan. Em cada linha ela chama `has_role(_uid,'master')`, que é outro SECDEF, e depois faz até dois EXISTS em `carteira_assignments`/`carteira_coverage`. Aparece em 8 policies, uma por tabela:

| Tabela | Linhas | Leitor no cliente que lê a tabela inteira |
|---|---|---|
| `farmer_client_scores` | ~17,0 mil | 23 arquivos (a maioria filtra por cliente) |
| `farmer_recommendations` | ~17,3 mil | `IntelligenceManagerialTab` (`.range` sobre tudo) |
| `carteira_assignments` | ~17,7 mil | `useFarmerScoring` (`eligible`, `.range` sobre tudo) |
| `customer_visit_scores` | ~7,4 mil | `useMyVisitSuggestions`, `useRouteContactList` |
| `route_visits`, `farmer_calls`, `farmer_bundle_recommendations`, `visitas_agendadas` (INSERT) | menores ou sem estatística | — |

Quanto custa, com o que se consegue medir sem persona:

- **O mesmo predicado inlinado** (corpo da função copiado, `uid` do farmer com maior carteira, `farmer_client_scores` inteira, 16.991 linhas): **5,7 ms**, com 65 ms no frio. O planejador transforma os dois EXISTS em `hashed SubPlan` e o `has_role` em InitPlan.
- **Pela função SECDEF, por linha**, a estimativa era de ≥ 2 chamadas SECDEF por linha a ~38 µs cada, o que daria ~0,6–1,3 s por leitura da tabela inteira. **Medido depois por persona: 1,3–2,4 s** (seção "Medida por persona" abaixo), acima da estimativa.

O desenho do conserto é candidato a lote próprio e **não** é desta entrega. É authz, e a ordem obrigatória é prova PG17 de equivalência (como o A1 do v4) e depois Codex. Não dá para inlinar direto: a policy de `carteira_assignments` usa a própria função, o que daria recursão de RLS, e é exatamente por isso que ela é SECDEF. A forma que preserva isso é um SECDEF que **devolve o conjunto**, chamado 1× com `customer_user_id IN (SELECT private.carteira_clientes_visiveis((SELECT auth.uid())))`. Isso vira `hashed SubPlan`, e o curto-circuito do master entra dentro dela.

### 3. `auth.uid()` cru: são 78 policies por linha, não 436, e custam ~9 µs por linha

O corpo do `auth.uid()` em prod é SQL `STABLE`, sem SECDEF, então ele inlina:

```sql
coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
```

Micro-medição com 200 mil linhas, claims sintéticas de 668 bytes e comparação dependente da linha, em 3 rodadas estáveis (±1%):

| Forma | Tempo | Extra por linha |
|---|---|---|
| comparação com constante (controle) | 217 ms | — |
| corpo cru, sub só em `request.jwt.claims` | **2.025 ms** | **~9,0 µs** (parse do jsonb a cada linha) |
| corpo cru, com `request.jwt.claim.sub` definido | 347 ms | ~0,65 µs |
| `(SELECT auth.uid())` | 219 ms | 0 |

O PostgREST atual só define `request.jwt.claims`, segundo a documentação dele, então o caso da prod deve ser a linha de 9 µs. Isso **não foi conferido em prod**, porque o claude_ro não vê a sessão do PostgREST.

Os "436" eram texto. Pela árvore, só 78 policies do `public` avaliam `auth.uid()` por linha, em 44 tabelas contando os outros schemas. As grandes são do tipo `auth.uid() = user_id` em `addresses`, `profiles`, `omie_customer_account_map` e `carteira_membership_ledger`, somadas por OR à policy de staff, que já é InitPlan. O staff curto-circuita no InitPlan, e o customer paga 9 µs só nas linhas que o próprio filtro dele já trouxe. A maior exposição seria `venda_sugestao` (223 mil linhas, `farmer_user_id = auth.uid()`), mas ela **não tem leitor** no `src/` nem nas edges. Veredito: **nenhuma reescrita em massa**, como o Codex pediu.

### 4. O resto por linha: não pesa

- **`storage`/`realtime`.** A migration de 02/11 cobria só o `public`. Em `storage.objects` sobram 24 policies com `has_role` cru (79 chamadas) sobre 637 objetos; em `realtime.messages`, 4. Volume desprezível.
- **`private.is_super_admin` por linha**: `margin_audit_log`, com ~15 mil linhas e `seq_tup_read` de 17 mil desde o restart, e `commercial_roles`. É pouco lido.
- **`fin_user_can_access` (18) e `cobranca_dona` (3)** recebem coluna como argumento, então são por linha por desenho, sobre tabelas do financeiro de até centenas de linhas.

## Recomendação (para o roadmap, não executada aqui)

1. **Lote candidato: `carteira_visivel_para` por conjunto.** É o único item com ganho na casa do segundo, e cai em telas de farmer/gestão. O sinal que faltava (EXPLAIN por persona) veio positivo: ver "Medida por persona".
2. **Os 26 meio embrulhados**, quando alguém tocar essas tabelas, ou numa extensão barata do regex da migration de 02/11 que também case `has_role(( SELECT auth.uid() AS uid), …)`. O ganho de hoje é baixo e não justifica um lote sozinho.
3. **`auth.uid()` cru: nada.**

## Consulta para o founder (SQL Editor, só leitura, desfeita no fim)

```sql
-- D4: custo real da visibilidade da carteira como FARMER (employee sem master). Nada é gravado.
begin;
set transaction read only;
select set_config('request.jwt.claims', json_build_object('role','authenticated','sub',
  (select a.owner_user_id from carteira_assignments a
    where a.eligible and not exists (select 1 from user_roles m where m.user_id = a.owner_user_id and m.role = 'master')
    group by 1 order by count(*) desc limit 1))::text, true);
set local role authenticated;
explain (analyze, buffers) select customer_user_id from carteira_assignments where eligible is true;
explain (analyze, buffers) select farmer_id, status from farmer_recommendations;
explain (analyze, buffers) select customer_user_id from farmer_client_scores;
rollback;
```

A comparação se faz contra os 5,7 ms do predicado inlinado (`farmer_client_scores`). Ler os **buffers** antes do tempo (lição do v4).

## Medida por persona (2026-11-04 ~22 UTC)

A consulta acima foi rodada pela sessão, a pedido do founder, pelo conector Lovable (`query_database`, que entra como `postgres`), uma tabela por chamada. Cada texto começou com `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s'`. Antes dos EXPLAIN, uma chamada de atestação com a mesma trava devolveu `somente_leitura=on`, `papel=authenticated`, `uid_ok`, `eh_employee=true` e `eh_master=false`, ou seja, um farmer real sem master, o da maior carteira. A resposta trouxe só planos, nenhum dado de negócio.

| Leitura do farmer | Linhas lidas → vistas | Tempo | Buffers |
|---|---|---|---|
| `farmer_client_scores` (frio) | 16.991 → 1.570 | **2.393 ms** | 159.586 (677 do disco) |
| `farmer_client_scores` (quente) | 16.991 → 1.570 | **1.333 ms** | 159.584 |
| `farmer_recommendations` | 17.316 → 1.655 | **1.902 ms** | 164.200 |
| `carteira_assignments` (`eligible`) | 17.707 → 1.570 | **1.519 ms** | 148.155 |
| mesmo predicado inlinado (`psql-ro`, `farmer_client_scores`) | 16.991 | 5,7 ms | — |

- A conta que fecha é por linha: a cada linha do scan, `private.carteira_visivel_para(customer_user_id, …)` aparece no `Filter` e custa ~9 buffers. O curto-circuito do master (`InitPlan`) é falso para o farmer, que paga os ~16 mil descartes. O custo é de **230× a 400×** o inlinado, e **~1,2 GB de buffer** por leitura.
- Em `carteira_assignments`, o `auth.uid()` vai **cru** para dentro da função: o `Filter` mostra o corpo do `auth.uid()` (parse do jsonb) por linha. Na de `farmer_*`, ele já chega como InitPlan.
- `dirtied=2` no frio são hint bits gravados pela leitura, não escrita da sessão (transação READ ONLY atestada).

O sinal da fase N chegou: o lote de **visibilidade por conjunto** (§Recomendação 1) tem ganho medido de ~1,3–2,4 s → ~ms por leitura de farmer, nas 3 tabelas que telas reais varrem inteiras.

## Lições

- **Conte chamadas por linha na ÁRVORE da policy, não no texto.** `has_role` dentro de `( SELECT (… OR …) )` roda 1×, e `has_role(( SELECT auth.uid() ), …)` roda por linha. O texto inverte as duas leituras.
- **"Embrulhar o `auth.uid()`" não embrulha a função que o recebe.** O SECDEF continua por linha. Uma pós-condição de "zero cru" só vale para a forma que o regex dela procura.
- **SECDEF com coluna no argumento nunca vira InitPlan.** Quando o custo importa, o caminho é devolver o conjunto 1× e filtrar por `IN`.
