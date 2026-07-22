# Fechar a escrita em `public.omie_products` — o preço de tabela sai do alcance do employee

> Spec de desenho. Money-path + autorização. Medido em produção via `psql-ro` em 2026-07-21.
> Contraparte do PR #1520 (FU4-F fase 3), que este achado **bloqueia**.

## 1. O problema

`public.omie_products` tem uma única policy, `FOR ALL`, para `{authenticated}`:

```
"Staff can manage products"
  USING      ( SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee')) )
  WITH CHECK ( idem )
```

`relacl`: `authenticated=arwdDxtm`, `anon=arwdDxtm`.

Qualquer `employee` — hoje 2 vendedoras, ambas `commercial_role=farmer` — pode dar `UPDATE`
em `omie_products.valor_unitario`, o **preço de tabela**. E o `D` do `relacl` é **TRUNCATE**,
que **não passa por RLS**: o mesmo employee pode apagar os 7.966 SKUs do catálogo.

### 1.1 As duas consequências, e a ordem de gravidade real

**(a) Vender abaixo do custo.** Se a vendedora reescreve o preço de tabela, a régua de preço,
o piso de markup e os guards de preço do money-path passam a operar sobre um número que ela
mesma controla. É a consequência de maior impacto financeiro.

**(b) Deriva de custo (oráculo).** A RPC `get_skus_margem_positiva()` do PR #1520 responde
"este SKU tem margem > 0?". Como a comparação é `valor_unitario > custo`, quem controla
`valor_unitario` escolhe o limiar: altera o preço, chama a RPC, observa se o SKU entrou ou saiu
do conjunto, e faz busca binária no custo. Nenhum desenho daquela RPC fecha isso — **o limiar é
a COLUNA, não o parâmetro**.

**Correção de escopo, medida:** `to_regprocedure('public.get_skus_margem_positiva()')` devolve
`NULL` em prod (`0 overloads`). O #1520 é draft e sua migration não foi aplicada. Logo **(b) é
prospectivo** — este trabalho *desbloqueia* o #1520, não estanca um vazamento em curso. **(a) e o
TRUNCATE são atuais.**

### 1.2 Nenhuma prova COMPORTAMENTAL é possível em produção

Terceira limitação, medida: `SET ROLE authenticated` sob `psql-ro` devolve
`ERROR: permission denied to set role "authenticated"` — a role `claude_ro` é membro de
`pg_read_all_data`, não de `authenticated`. E a validação pós-apply lê catálogo de propósito
(#1462: invocar falharia por falta de `EXECUTE`, e o sucesso da migration se apresentaria como
falha dela).

⇒ O coração da entrega — *farmer negado, leitura preservada* — é provado **só no PG17 local**. Em
produção confere-se o **catálogo** e infere-se o comportamento. A inferência é sólida (o catálogo
determina o comportamento), mas é inferência, e o corpo do PR tem de dizer isso.

O que fecha a lacuna é um smoke test do founder: **depois do apply, uma tela com preço tem de
continuar populada**. Catálogo vazio significa que a policy de leitura não ficou como desenhada; a
reversão é `GRANT` mais a policy antiga.

### 1.3 "Já aconteceu?" — irrespondível, e isso é o achado

Não há trilha. Nenhuma das 40 tabelas `%log%`/`%audit%` cobre `omie_products`, e os 3 triggers da
tabela são `tr_sincronizar_ativo_omie`, `trg_preserve_tipo_produto` e `update_omie_products_updated_at`
— nenhum registra histórico de valor.

Isolei os 5 minutos com `≤5` linhas tocadas (um `UPDATE` manual seria outlier no meio de lotes de
milhares): todos são compatíveis com upsert incremental do sync. **Mas isso não é prova de nada** —
`updated_at` guarda só o *último* toque, então uma busca binária, que reescreve o mesmo SKU dezenas
de vezes, seria **invisível retroativamente**.

⇒ Registrar como **limitação declarada**, nunca como "nada encontrado". Ausência de trilha ≠ ausência
de evento (CLAUDE.md: "ausência de sinal NÃO é aprovação").

## 2. Investigação — a policy `FOR ALL` existe por um motivo?

Medido, não suposto. **Não existe motivo vivo.**

| Pergunta | Resposta medida | Como |
|---|---|---|
| Há UI de edição de produto/preço? | **Não.** Todos os hits de `valor_unitario` em `src/` são leitura. O único `onUpdate(...,'valor_unitario',...)` é `OrderItemCard.tsx:69`, que edita o **item do pedido** (`sales_order_items`), tabela diferente. | grep `src/**` |
| Quem escreve em `omie_products`? | **6 edges, todas com `SUPABASE_SERVICE_ROLE_KEY`**: `omie-vendas-sync`, `omie-analytics-sync`, `sync-reprocess`, `tint-omie-sync`, `omie-sync-metadados`, `omie-sync-status-produtos`. | grep `supabase/functions/**` |
| O client ANON do `omie-vendas-sync` escreve? | **Não.** Serve só a `auth.getUser()` para resolver `userId`. O `syncProducts` recebe `supabaseAdmin` (index.ts:2283). | leitura do caller |
| Há função SQL que escreve? | **Uma**: `tint_marcar_bases_mixmachine`, `SECURITY DEFINER` (bypassa RLS de qualquer forma), e toca só `is_tintometric`/`tint_type`/`updated_at`. Não toca `valor_unitario`. | `pg_proc.prosrc ~* 'update.*omie_products'` |
| Customers leem a tabela? | **Não.** 1 policy no total, 0 mencionando customer. | `pg_policy` |

⇒ **Zero writers legítimos rodando como `authenticated`.** Fechar a escrita não quebra nada —
mesmo desfecho que `product_costs` no #1520, e pela mesma evidência (writers são service_role).

### 2.1 Efeito colateral verificado: as 13 views que dependem da tabela

12 estão `security_invoker on/true` → leem com a permissão do caller → dependem da policy de **SELECT**,
que este desenho **preserva idêntica**. Nenhuma quebra.

A 13ª, `selfservice_catalogo`, está `security_invoker=off` → lê como OWNER e **bypassa a RLS**
(a armadilha do #1375). É um achado de **leitura**, ortogonal a este gate de **escrita**, e por
isso foi para um chip separado: *"Fechar security_invoker da view selfservice_catalogo"*.
Fora do escopo deste spec de propósito — misturar os dois eixos num PR que já passa por Codex
adversarial em duas rodadas é como se perde a rastreabilidade do que foi provado.

## 3. Decisão de desenho

### 3.1 Por que não gatear só a coluna `valor_unitario`

**RLS não filtra coluna.** As alternativas seriam:

- **Column-level `GRANT`** (`REVOKE UPDATE(valor_unitario)`) — **impossível aqui**: grants são por
  *role*, e employee e master compartilham o mesmo role `authenticated`. O gate precisa ser por
  *usuário*, o que só a RLS (ou um trigger) faz.
- **Trigger `BEFORE UPDATE`** rejeitando mudança nas colunas sensíveis — funciona, mas cria código
  money-path novo, que precisa de prova própria e pode ser esquecido quando uma coluna sensível for
  acrescentada.

Como a medição mostrou **zero writers legítimos como employee**, fechar a tabela inteira não custa
nada e é o corte mais simples de provar. Escolhido.

### 3.2 Escrita: revogar o privilégio, sem policy de escrita

Decidido com o founder em 2026-07-21, entre duas opções mutuamente exclusivas:

- **(i) escolhida** — `REVOKE` do privilégio de escrita, **nenhuma** policy de escrita. Nem employee
  nem master escrevem via API; só `service_role`.
- (ii) descartada — manter o grant + policy `private.cap_preco_escrever` (master-only).

**Elas não se somam:** com o privilégio revogado, a policy nunca é exercida e o gate vira tautologia
— exatamente o P3 que o Codex apontou no #1488.

Razões da (i):

1. **Não existe UI de edição de preço**, então ninguém perde capacidade hoje (YAGNI).
2. **"Quem é master" é menos estável do que parece.** Em 2026-07-20 foi revogada uma role `master`
   órfã da conta alias fiscal COLACOR S.C — senha bcrypt aleatória, email de recuperação que não
   entrega. Sob a (ii), aquela conta teria tido poder de reescrever o preço de tabela durante todo o
   período em que a role ficou pendurada. A (i) não depende de a lista de masters estar sempre correta.
3. **Preço errado se corrige no Omie**, a fonte da verdade, e o sync propaga (medido: 5.832 linhas
   atualizadas em 20/07, 2.128 em 21/07). É como já funciona na prática.
4. **Reversível barato:** se surgir necessidade de edição manual pelo master, é `GRANT UPDATE` + a
   policy com `private.cap_preco_escrever` — que **já existe em prod e já é master-only**.

### 3.3 Leitura: preservada byte a byte

A policy nova de `SELECT` reproduz o gate atual (`master OR employee`) **e o wrap de InitPlan**
`(SELECT ...)` / `(SELECT auth.uid())`. Leitura não muda para ninguém. É o que impede a tela de quebrar,
e é a diferença entre este caso e o #1520 — lá a leitura **foi** apertada (para `cap_custo_ler`) e por
isso exigiu migrar 3 consumidores antes.

### 3.4 Armadilhas evitadas de propósito

- **`USING` + `WITH CHECK` não é a divisão leitura/escrita** (`database.md` §4): `DELETE` consulta só o
  `USING`. Não aplicável aqui — uma policy só de SELECT, escrita fechada no privilégio — mas registrado
  para quem herdar o desenho.
- **Revogação em massa de `anon`/`authenticated` seria errada** (`database.md` §7): o grant amplo é o
  default privilege do Supabase, é o *modelo* da plataforma, e revogar em massa quebra telas anon
  legítimas. O que se faz aqui é revogação **pontual numa tabela money-path**, igual ao #1520.
- **`service_role` não é tocado.** Tem grant próprio e bypassa RLS; as 6 edges de sync continuam
  escrevendo. Coberto por assert.

## 4. A migration

`supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql`
(o maior timestamp em qualquer branch remota é `20260726160000`; ordena depois).

Estrutura, espelhando `20260725130000_authz_custo_fu4f_fase3_fecha_product_costs.sql`:

**Precondição idempotente** — aborta se aparecer policy que este desenho não conhece. Se outra sessão
criou uma policy permissiva em paralelo, o `DROP`+`CREATE` daqui a deixaria viva e o gate **não
fecharia** (permissivas combinam com `OR`). Conta policies cujo nome não seja nem a antiga nem a nova;
`≠ 0` → `RAISE`. Idempotente nas duas direções: na 1ª rodada só a antiga existe, na 2ª só a nova.

**Grants:**
```sql
REVOKE ALL ON TABLE public.omie_products FROM PUBLIC;
REVOKE ALL ON TABLE public.omie_products FROM anon;
REVOKE ALL ON TABLE public.omie_products FROM authenticated;
GRANT SELECT ON TABLE public.omie_products TO authenticated;
```
O `GRANT SELECT` volta porque **a RLS é que decide quem lê**. Sem ele a negação viria do privilégio,
a policy nunca seria exercida e o assert de RLS viraria tautologia.

**Policies:**
```sql
DROP POLICY IF EXISTS "Staff can manage products" ON public.omie_products;
DROP POLICY IF EXISTS omie_products_select_staff  ON public.omie_products;
CREATE POLICY omie_products_select_staff ON public.omie_products
  FOR SELECT TO authenticated
  USING ((SELECT (public.has_role((SELECT auth.uid()),'master'::public.app_role)
               OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))));
ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;
```
Mais `COMMENT ON POLICY` explicando a substituição.

Schema qualificado (`public.has_role`, `public.app_role`) para a migration não depender do
`search_path` do SQL Editor. Não muda o objeto resultante — policies guardam a expressão por **OID**
depois de criadas (#1427) —, muda só a robustez do `CREATE`. O gate em si é **byte a byte o de hoje**,
inclusive o wrap de InitPlan.

**Asserts na própria transação** (A1–A8) — pegam o caso em que prod divergiu do que o arquivo assume:

| # | Assert |
|---|---|
| A1 | policy antiga não sobreviveu |
| A2 | exatamente 1 policy na tabela |
| A3 | `authenticated` sem `TRUNCATE` (não passa por RLS) |
| A4 | `authenticated` sem `INSERT`/`UPDATE`/`DELETE` |
| A5 | `anon` sem `SELECT` e sem `TRUNCATE` |
| A6 | `authenticated` **mantém** `SELECT` — anti-tautologia |
| A7 | `service_role` mantém `INSERT`/`UPDATE` — as 6 edges não podem quebrar |
| A8 | RLS habilitada |

## 5. Harness PG17 — `db/test-authz-preco-omie-products.sh`

Ritual de `prove-sql-money-path`. `SET ROLE` (**nunca** `SET LOCAL` — #1434: em autocommit vira
`WARNING` e segue como superuser, que bypassa RLS e pinta tudo de verde), com guard que aborta se
`current_user ≠ authenticated`.

### 5.1 Baseline ANTES da migration — o detector vendo o mundo vivo

Sem isto, "detectou o fechamento" e "o assert está quebrado" são indistinguíveis (#1488).

| # | Baseline (deve passar **antes**) |
|---|---|
| B1 | farmer dá `UPDATE` em `valor_unitario` **com sucesso** — o buraco existe |
| B2 | master escreve |
| B3 | customer **não** escreve — o gate de identidade já funcionava antes desta entrega |
| B4 | farmer **lê** (leitura a preservar) |
| B5 | master lê |
| B6 | `authenticated` tem `TRUNCATE` (o `D` do `arwdDxtm`) |
| B7 | `anon` tem `SELECT` |
| B8 | `anon` tem `UPDATE` — dimensiona o que o REVOKE fecha |
| B9 | existe exatamente 1 policy (a `FOR ALL`) |
| B10 | **controle positivo**: `service_role` escreve |

⚠️ **O baseline comportamental cobre só `UPDATE`.** Uma versão anterior deste spec previa baselines
de `INSERT` e `DELETE` do farmer; o harness implementado não os tem. O fecho de `INSERT`/`DELETE` é
provado **catalograficamente** (A4b/A4c via `has_table_privilege`), o que é suficiente porque o
`REVOKE ALL` age por privilégio e atinge o role inteiro — mas o corpo do PR **não pode afirmar** que
o baseline provou comportamentalmente o INSERT/DELETE do farmer.

### 5.2 Depois da migration

Os A1–A8 da §4, mais os comportamentais:

| # | Assert |
|---|---|
| A9 | farmer **não** escreve mais (o fecho) |
| A10 | master **não** escreve — prova a opção (i), distinguindo-a da (ii) |
| A11 | farmer **ainda lê** — leitura preservada |
| A12 | master ainda lê |

### 5.3 Controle positivo — obrigatório em toda negação

A9/A10 sozinhos passariam num mundo onde *nada* funciona (linha inexistente, tabela vazia, harness
quebrado). O controle: **`service_role` executa o MESMO `UPDATE` na MESMA linha, com sucesso**, dentro
da mesma rodada. Não `has_table_privilege` — o `UPDATE` de verdade, provando que a linha é atualizável
e que a negação de A9/A10 é do *gate*, não do ambiente.

### 5.4 Falsificação — cada uma exige o vermelho EXATO

Baseline verde explícito antes de cada rodada (contagem de asserts + verde), e conferir **nomes e
contagem** dos vermelhos: têm de ser os que aquela sabotagem mira, e só eles. Exit code não distingue
"pegou o bug" de "não rodou nada" (#1358).

| # | Sabotagem | Vermelho exigido |
|---|---|---|
| S1 | não revogar `TRUNCATE` | A3 |
| S2 | **não dropar a policy antiga** (+ repor o grant de UPDATE) | A9 — permissivas combinam com `OR`, então o fecho comportamental tem de cair |
| S3 | omitir o `GRANT SELECT` de volta | A11 — a leitura quebra (a negação passa a vir do privilégio) |
| S4 | revogar de `service_role` também | A14, o controle positivo §5.3 |
| S5 | **policy intrusa** simulando sessão paralela | a migration inteira tem de **abortar**, e a saída tem de conter a mensagem da precondição |

S2 é a mais importante: é a única que prova que o fecho é **comportamental** e não apenas
catalográfico.

S5 não existia na primeira versão deste spec — a precondição estava desenhada em §4 mas sem
sabotagem própria, o que a deixaria como código não-provado num arquivo money-path. Ela não usa o
helper `falsifica`: captura a saída da migration e exige a string `precondicao FALHOU`, porque só o
exit code não distingue "abortou pela precondição" de "abortou por qualquer outro motivo".

## 6. Fora de escopo (declarado)

- `selfservice_catalogo` com `security_invoker=off` → chip próprio (§2.1).
- Trilha de auditoria de `UPDATE` em `valor_unitario`. Responderia "já aconteceu?" daqui pra frente,
  mas é tabela nova + RLS própria + retenção — entrega separada. Hoje a pergunta segue irrespondível,
  e o spec declara isso em vez de fingir cobertura.
- Canonicalizar quem pode alterar preço **no Omie**. Fora do app.

## 7. Entrega

1. Migration + harness, provados em PG17 local com falsificação.
2. `/codex` adversarial (`gpt-5.6-sol`, `xhigh`) **antes** de tirar do draft; rodada 2 sobre as correções.
   Transporte por `scripts/codex-async.sh` em background. Parecer **cru** apresentado junto da calibração,
   rotulada como decisão minha.
3. PR draft. Re-conferir colisão de migration/policy **imediatamente antes** do `gh pr create` — a
   checagem do início vence numa sessão longa e o auto-merge fecha PR em minutos.
4. Migration aplicada **à mão pelo founder** no SQL Editor do Lovable, com query de validação read-only
   pós-apply que **lê catálogo, não invoca** (#1462: invocar falha sob `psql-ro` por falta de `EXECUTE`,
   e o sucesso da migration se apresenta como falha dela).
5. Sem `Publish` de frontend: não há mudança em `src/`.
