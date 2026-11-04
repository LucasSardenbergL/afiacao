# RLS da carteira: visibilidade por conjunto, 1× por consulta (plano v5, D4)

**Data:** 2026-11-04 · **Diagnóstico e medida "antes":** [rls-d4-custo-por-linha.md](rls-d4-custo-por-linha.md) · **Padrão seguido:** [rls-has-role-initplan-classe.md](rls-has-role-initplan-classe.md)
**Migration:** `supabase/migrations/20261104192942_carteira_visibilidade_por_conjunto.sql` · **Prova:** `db/test-rls-carteira-visibilidade-conjunto.sh` (núcleo do CI, eixo autorização)

## O problema

Oito policies chamavam `private.carteira_visivel_para(customer_user_id, uid)`. É SQL `SECURITY DEFINER` com **coluna** no argumento: não inlina e não vira InitPlan, então roda uma vez por linha, com um `has_role` e até dois EXISTS dentro. Medido na prod como `authenticated`, farmer real sem master: `farmer_client_scores` 1.333–2.393 ms, `farmer_recommendations` 1.902 ms, `carteira_assignments` (eligible) 1.519 ms, ~150–164 mil buffers por leitura, contra 5,7 ms do mesmo predicado inlinado.

## O desenho

A regra da função é `uid IS NOT NULL AND (master(uid) OR c ∈ dono-elegível(uid) OR c ∈ cobertura-ativa-vigente(uid))`. Nenhum dos três termos depende da linha, exceto a pertença de `c`. Então:

```sql
( SELECT has_role(( SELECT auth.uid() AS uid), 'master'::app_role) AS has_role)
OR (customer_user_id IN ( SELECT private.carteira_clientes_visiveis(( SELECT auth.uid() AS uid))))
```

- O termo master é InitPlan. Ele **não** pode ir para dentro da função de conjunto: o master vê também linhas com `customer_user_id` NULL (`farmer_calls`) e clientes fora de `carteira_assignments`, e nenhum conjunto de clientes reproduz isso.
- `private.carteira_clientes_visiveis(uid)` é `SETOF uuid`, `STABLE SECURITY DEFINER`, `search_path=public`, com os dois EXISTS da antiga reescritos como `UNION`. O planejador executa o `IN (SELECT …)` como **hashed SubPlan**: uma chamada por consulta.
- Inlinar o corpo direto na policy não serve: a policy de `carteira_assignments` leria a própria tabela e a RLS entraria em recursão. A função SECDEF (dona `postgres`, BYPASSRLS) lê sem RLS, como a antiga.
- **NULL × false:** com `customer_user_id` NULL, `x IN (…)` dá NULL onde a antiga dava false. Policy só aceita TRUE (no USING e no WITH CHECK) e nenhuma das 8 nega o termo, então o conjunto é o mesmo. A prova compara `IS TRUE` ponto a ponto.
- **ACL:** função nova nasce com EXECUTE para PUBLIC. A migration revoga PUBLIC e anon e copia, via `aclexplode`, os grantees de EXECUTE da antiga (authenticated, service_role, os dois `sandbox_exec*`). A pós-condição exige ACL igual.
- `carteira_visivel_para` **fica**: 9 funções a chamam.

A migration trava cada tabela antes de reler a policy, só reescreve se o texto for **igual ao lido na prod** (anti-deriva), pula se já estiver na forma nova (idempotente) e aborta em qualquer outro texto. As pós-condições P0–P7 rodam na mesma transação: isolamento, cmd/roles/permissive intactos, a outra cláusula intacta, texto gravado = texto provado, 8 de 8, zero policy chamando a antiga, atributos da função e ACL.

## A prova (PG17, C e pt_BR.UTF-8, 55/55)

Tabelas mínimas com tipo e nulidade da prod, as três funções e as 8 policies **verbatim** (pg_get_expr), grants de tabela e função como na prod (inclusive o grant por coluna de `farmer_client_scores`). RLS real: `SET ROLE` + `request.jwt.claims`, com o corpo do `auth.uid()` da prod.

| Camada | O que prova |
|---|---|
| C0 | a sonda distingue chamadores: valores absolutos antes da migration (dono vê só o elegível, master vê cliente NULL, cobertura expirada/inativa não vê, sem `valid_until` vê, anon leva 42501…) |
| A1 | 13 chamadores × (7 SELECT + 29 INSERT candidatos em `visitas_agendadas`) = 468 sondas: o conjunto é o mesmo antes e depois |
| A2 | cada cláusula, ponto a ponto, por chamador: `(antiga IS TRUE) IS DISTINCT FROM (nova IS TRUE)` = 0, com 171 pares TRUE/TRUE (não-vazia) |
| A3 | catálogo: SETOF STABLE SECDEF, ACL = a da antiga, sem PUBLIC/anon, cmd/roles intactos, antiga presente |
| A4/A5 | plano com `hashed SubPlan`; contador (`track_functions`): antes 7 chamadas para 7 linhas, depois 1 |
| A6–A9 | idempotente; deriva → PRE e nada aplicado; plano genérico alternando usuário; leitor segurando tabela → 55P03 e nada aplicado |
| S1–S6 | sabotagens depois do apply: conjunto sem `eligible`, cobertura sem validade, sem termo master (A1 e A2), WITH CHECK sem o conjunto, EXECUTE para anon, policy de volta à função por linha (A4 e A5): 8 vermelhas |
| M1–M3 | pós-condições da própria migration, com controle intacto verde: sem REVOKE PUBLIC → P7; termo fora da forma do PG → P3; REPEATABLE READ → P0 |

## Codex

_(preenchido após o parecer)_

## Aplicação e medida "depois"

_(preenchido após o apply)_

## Lições

- **O curto-circuito do master não cabe na função de conjunto.** "Master vê tudo" inclui linhas sem cliente e clientes fora da carteira. Devolver "todos os clientes" para o master mudaria o que ele vê. O termo fica fora, como InitPlan.
- **`IN (SELECT …)` troca false por NULL.** Em policy isso é inócuo só porque nada nega o termo. Prove `IS TRUE` ponto a ponto, não igualdade de booleanos.
