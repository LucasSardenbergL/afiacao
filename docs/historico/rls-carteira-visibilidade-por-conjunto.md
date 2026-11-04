# RLS da carteira: visibilidade por conjunto, 1× por consulta (plano v5, D4)

**Data:** 2026-11-04 · **Diagnóstico e medida "antes":** [rls-d4-custo-por-linha.md](rls-d4-custo-por-linha.md) · **Padrão seguido:** [rls-has-role-initplan-classe.md](rls-has-role-initplan-classe.md)
**Migration:** `supabase/migrations/20261104192942_carteira_visibilidade_por_conjunto.sql` · **Prova:** `db/test-rls-carteira-visibilidade-conjunto.sh` (núcleo do CI, eixo autorização)

## O problema

Oito policies chamavam `private.carteira_visivel_para(customer_user_id, uid)`. É SQL `SECURITY DEFINER` com **coluna** no argumento: não inlina e não vira InitPlan, então roda uma vez por linha, com um `has_role` e até dois EXISTS dentro. Medido na prod como `authenticated`, farmer real sem master: `farmer_client_scores` 1.333–2.393 ms, `farmer_recommendations` 1.902 ms, `carteira_assignments` (eligible) 1.519 ms, ~150–164 mil buffers por leitura, contra 5,7 ms do mesmo predicado inlinado.

## O desenho

A regra da função é `uid IS NOT NULL AND (master(uid) OR c ∈ dono-elegível(uid) OR c ∈ cobertura-ativa-vigente(uid))`. Nenhum dos três termos depende da linha, exceto a pertença de `c`. Então:

```sql
( SELECT private.carteira_ve_tudo() AS carteira_ve_tudo)
OR (customer_user_id IN ( SELECT private.carteira_clientes_visiveis() AS carteira_clientes_visiveis))
```

- As duas funções **não recebem uid**: leem `( SELECT auth.uid() )` por dentro, para que ninguém consiga enumerar a carteira de outro usuário chamando-as (achado do Codex). O termo master fica numa função própria, e não em `has_role` direto na policy, para que a policy só chame funções com a ACL da antiga: assim a fronteira de privilégio não muda.
- O termo master é InitPlan. Ele **não** pode ir para dentro da função de conjunto: o master vê também linhas com `customer_user_id` NULL (`farmer_calls`) e clientes fora de `carteira_assignments`, e nenhum conjunto de clientes reproduz isso.
- `private.carteira_clientes_visiveis()` é `SETOF uuid`, `STABLE SECURITY DEFINER`, `search_path=public`, com os dois EXISTS da antiga reescritos como `UNION`. O planejador executa o `IN (SELECT …)` como **hashed SubPlan**: uma chamada por consulta.
- Inlinar o corpo direto na policy não serve: a policy de `carteira_assignments` leria a própria tabela e a RLS entraria em recursão. A função SECDEF (dona `postgres`, BYPASSRLS) lê sem RLS, como a antiga.
- **NULL × false:** com `customer_user_id` NULL, `x IN (…)` dá NULL onde a antiga dava false. Policy só aceita TRUE (no USING e no WITH CHECK) e nenhuma das 8 nega o termo, então o conjunto é o mesmo. A prova compara `IS TRUE` ponto a ponto.
- **ACL:** função nova nasce com EXECUTE para PUBLIC. A migration revoga PUBLIC e anon e copia, via `aclexplode`, os grantees de EXECUTE da antiga (authenticated, service_role, os dois `sandbox_exec*`). A pós-condição exige a mesma ACL, comparando papel e `is_grantable`, e o mesmo dono.
- `carteira_visivel_para` **fica**: 9 funções a chamam.

A regra é **copiada**, não referenciada. Por isso o PRE exige que o corpo vivo de `carteira_visivel_para` seja o provado (md5 do `prosrc` da prod, igual ao do fixture), e que as funções novas, se já existirem, tenham o corpo desta migration. Nesse caso elas não são recriadas; se estiverem ausentes, nascem por `CREATE` sem `OR REPLACE`. Os três md5 são reconferidos no fim (P9). A migration trava cada tabela antes de reler a policy, só reescreve se o texto for **igual ao lido na prod** (anti-deriva), pula se já estiver na forma nova (idempotente) e aborta em qualquer outro texto. As pós-condições P0–P9 rodam na mesma transação: isolamento, cmd/roles/permissive intactos, a outra cláusula intacta, texto gravado = texto provado, 8 de 8, zero policy chamando a antiga, atributos e dono das funções, ACL, os corpos reconferidos e um orçamento global de 3 s. O orçamento é conferido depois das travas e no fim: rejeita quem já estourou nesses pontos, mas não é um teto de quanto tempo as travas ficam seguras.

## A prova (PG17, C e pt_BR.UTF-8, 67/67)

Tabelas mínimas com tipo e nulidade da prod, as três funções e as 8 policies **verbatim** (pg_get_expr), grants de tabela e função como na prod (inclusive o grant por coluna de `farmer_client_scores`). RLS real: `SET ROLE` + `request.jwt.claims`, com o corpo do `auth.uid()` da prod.

| Camada | O que prova |
|---|---|
| C0 | a sonda distingue chamadores: valores absolutos antes da migration (dono vê só o elegível, master vê cliente NULL, cobertura expirada/inativa não vê, sem `valid_until` vê, anon leva 42501…) |
| A1 | 15 chamadores × (7 SELECT + 29 INSERT candidatos em `visitas_agendadas`) = 540 sondas: o conjunto é o mesmo antes e depois. Inclui os dois `sandbox_exec*` com BYPASSRLS, como na prod |
| A2 | cada cláusula, ponto a ponto, por chamador: `(antiga IS TRUE) IS DISTINCT FROM (nova IS TRUE)` = 0, com 171 pares TRUE/TRUE (não-vazia) |
| A3 | catálogo: SETOF STABLE SECDEF, ACL = a da antiga, sem PUBLIC/anon, cmd/roles intactos, antiga presente |
| A4/A5 | plano com `hashed SubPlan`; contador (`track_functions`): antes 7 chamadas para 7 linhas, depois 1 |
| A6–A9 | idempotente; deriva → PRE e nada aplicado; plano genérico alternando usuário (A8b em `carteira_assignments`, onde nenhum termo cap mascara o master); leitor segurando tabela → 55P03 e nada aplicado |
| S1–S7 | sabotagens depois do apply: conjunto sem `eligible`, cobertura sem validade, sem termo master (A1 e A2), WITH CHECK sem o conjunto, EXECUTE para anon, policy de volta à função por linha (A4 e A5), SRF com `ROWS 1e9` fazendo o planejador desistir do hash (A4): 9 vermelhas |
| M1–M8 | PRE e pós-condições da própria migration, com controle intacto verde: sem REVOKE PUBLIC → P7; termo fora da forma do PG → P3; REPEATABLE READ → P0; corpo da antiga endurecido com as policies intactas → PRE; nova já existente com outro corpo → PRE; reapply com GRANT OPTION → P7; atraso sem contenção de lock → P8; md5 trocado na reconferência final → P9 |

## Codex

- **Desenho e código** (xhigh, 250 s, 133 mil tokens): **APLICAR COM AJUSTES**, sem P0. Todos os ajustes foram feitos e cada um ganhou sabotagem:
  1. *(P1)* A anti-deriva protegia as policies, mas não a regra copiada. Agora há um PRE por md5 do corpo da antiga e da nova (M4, M5).
  2. *(P1)* "500 ms × 8" limita cada espera, não o tempo segurando as travas. Voltou o orçamento global do v4 (P8, M7).
  3. *(P2)* A função de conjunto com `_uid` deixava enumerar a carteira de outro usuário. As funções ficaram sem argumento.
  4. *(P2)* O P7 comparava só os destinatários. Agora compara também `is_grantable` e o dono (M6).
  5. *(P2)* `has_role` direto na policy mudava a fronteira de privilégio para `sandbox_exec`. Na prod os dois sandbox têm BYPASSRLS, então não mordia, mas o master foi para uma função com a ACL espelhada e os sandbox entraram na matriz. A sabotagem específica do hash é a S7.
  6. *(P2)* A busca pontual passa a calcular o conjunto inteiro. Isso foi medido na prod antes e depois, na seção abaixo.
- **2º passe (código, high, 120 s, 110 mil tokens):** nenhuma regressão de autorização. O `auth.uid()` lido dentro da SECDEF é o mesmo valor, porque o SECDEF troca `current_user`, não os GUCs. Funções SECDEF com `proconfig` não inlinam, e InitPlan e hash são refeitos a cada execução do plano genérico. Três ressalvas, todas feitas: *(média)* PRE não atômico com o replace → `CREATE` sem `OR REPLACE` + P9 (M8); *(baixa)* o comentário do P8 prometia mais do que garante → corrigido; *(baixa)* o A8 não isolava o termo master → A8b. O `db:aplicar` já serializa os applies; a janela residual é um DDL concorrente fora dele, entre o P9 e o COMMIT.

## Aplicação e medida "depois"

**Ensaio** (`db:aplicar --ensaio`, commit `5a59d784a`, sha256 `3c135a8e…`): 8 policies reescritas, P0–P9 verdes. O ROLLBACK foi conferido por `psql-ro`: função ausente e as 8 ainda na forma antiga.
**Apply** (`db:aplicar`, **tentativa #898**, recibo na mesma transação), 2026-11-04. Validado de fora por `psql-ro`: 0 policies chamando `carteira_visivel_para`, 8 por conjunto, anon sem EXECUTE nas duas funções, authenticated com, os três md5 iguais aos provados e a antiga preservada.

**Medida por persona**, com o mesmo método da [seção do diagnóstico](rls-d4-custo-por-linha.md): conector Lovable, transação `READ ONLY` atestada, `SET LOCAL ROLE authenticated` e o farmer real sem master da maior carteira. O cache estava quente, salvo onde está marcado.

| Leitura do farmer | Linhas lidas → vistas | Antes | Depois | Buffers antes → depois |
|---|---|---|---|---|
| `farmer_client_scores` | 16.991 → 1.570 | 1.333 ms (2.393 frio) | **10,4 ms** (138 frio) | 159.584 → **840** |
| `farmer_recommendations` | 17.316 → 1.655 | 1.902 ms | **11,7 ms** (483 frio, 502 do disco) | 164.200 → **1.173** |
| `carteira_assignments` (`eligible`) | 17.707 → 1.570 | 1.519 ms | **10,0 ms** | 148.155 → **1.083** |
| `farmer_client_scores` busca de 1 cliente (achado 6 do Codex) | 1 → 1 | 2,1 ms | **6,2 ms** | 278 → **671** |

- As **linhas vistas são as mesmas** de antes (1.570 / 1.655 / 1.570): é a equivalência observada na prod, não só no fixture.
- O plano mostra `(ANY (customer_user_id = (hashed SubPlan N).col1))`. A função de conjunto roda **1×** (`ProjectSet`, 1.570 linhas, ~4,4 ms, ~485 buffers).
- Leituras inteiras: de **130× a 160× mais rápidas**, com ~150× menos buffers.
- **Busca pontual: +4 ms.** Ela agora monta o conjunto inteiro (~4,4 ms) para checar 1 cliente, onde antes era 1 chamada SECDEF. É o preço que o Codex previu. Pesa pouco ao lado do ganho de segundos nas leituras inteiras, e cai se um dia valer um índice cobrindo `(owner_user_id) INCLUDE (customer_user_id) WHERE eligible` (index-only no lugar dos ~485 buffers de heap). Hoje não há sinal de que valha.
- Sobram, fora do escopo, os ~175 buffers (~1,1 ms) do InitPlan de `cap_carteira_ler` em toda leitura.

## Lições

- **O curto-circuito do master não cabe na função de conjunto.** "Master vê tudo" inclui linhas sem cliente e clientes fora da carteira. Devolver "todos os clientes" para o master mudaria o que ele vê. O termo fica fora, como InitPlan.
- **Trocar "por linha" por "conjunto 1×" move o custo, não o elimina.** A leitura inteira cai de segundos para ~10 ms. Já a busca de 1 linha passa a pagar o conjunto inteiro (+4 ms). Meça os dois acessos, não só o que motivou a troca.
- **`IN (SELECT …)` troca false por NULL.** Em policy isso é inócuo só porque nada nega o termo. Prove `IS TRUE` ponto a ponto, não igualdade de booleanos.
