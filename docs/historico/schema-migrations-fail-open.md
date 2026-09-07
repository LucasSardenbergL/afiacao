# `schema_migrations` mente nas DUAS direções — prove o OBJETO, e só se o auditor CONHECE o tipo dele

**Episódio:** 2026-08-30/31 · constraint `sales_orders_hash_omie_canonico` · PROD `fzvklzpomgnyikkfkzai`

## O que aconteceu

Em **2026-08-30 ~23h UTC** um diagnóstico via `psql-ro` concluiu, com prova, que a constraint
`sales_orders_hash_omie_canonico` **não existia** em produção, e que a versão `20260829081556` já
constava em `supabase_migrations.schema_migrations` com um único statement de 38 caracteres — o
literal `-- aplicada manualmente via SQL Editor`, sem nenhum `ADD CONSTRAINT`. Conclusão do
diagnóstico: a migration seria pulada para sempre por colisão de versão.

Em **2026-08-31 15:09 UTC** (≈16h depois) a constraint **existia e estava VALIDADA**.

A query do diagnóstico, re-rodada **verbatim**, passou a retornar 1 linha. **A query nunca enganou —
a diferença foi o TEMPO.** Alguém colou o arquivo no SQL Editor no intervalo. Descartadas as
armadilhas estruturais: `public.sales_orders` é tabela real (`relkind='r'`) e é a **única** relação
com esse nome em qualquer schema, então não houve view homônima nem ambiguidade de `search_path`.

## Por que sabemos que foi colado o arquivo INTEIRO

O `COMMENT ON CONSTRAINT` da migration está no banco (`pg_description`). Como o comentário é a
**última** instrução do arquivo, e o bloco `DO $post$` de pós-condição vem **antes** dele e `RAISE`
se a constraint não existir ou não estiver validada, a presença do comentário indica que a
pós-condição rodou e **passou**. Isso é corroboração, não a prova principal: a prova independente é
`convalidated = t` lido direto do catálogo, que afirma exatamente o que o `DO $post$` exigia. A definição gravada bate com o arquivo:

```
CHECK ((hash_payload IS NULL) OR (hash_payload !~~ 'omie\_%') OR
       ((omie_pedido_id IS NOT NULL) AND (hash_payload = 'omie_'||account||'_'||omie_pedido_id::text)))
```

## Datação: 30/08 23:47 UTC — minutos DEPOIS do diagnóstico

Usando a técnica que o próprio `docs/agent/database.md` §3 prescreve (não há `created_at` em
`pg_constraint`, e `track_commit_timestamp` está `off`): correlacionar o **`xmin` da tupla do
catálogo** com linhas **datadas** de `cron.job_run_details`, que escreve de minuto em minuto.

`xmin` da constraint = **9644048**. O intervalo:

```
último  ANTES  (xmin ≤ 9644048)   2026-08-30 23:47:00 UTC
primeiro DEPOIS (xmin ≥ 9644048)  2026-08-30 23:48:00 UTC
```

⇒ **a constraint foi criada entre 23:47 e 23:48 UTC de 2026-08-30** — ou seja, **minutos depois** de
o diagnóstico ter sido escrito ("~23h UTC"). O diagnóstico era **verdadeiro quando escrito** e foi
atendido quase imediatamente; a sessão que o recebeu abriu ~15h mais tarde e encontrou o mundo já
mudado. É o caso-livro do bullet "**evidência de banco tem VALIDADE**" do §2.

`net._http_response` **não** conseguiu fechar o lado "antes" (retenção curta: as linhas mais velhas
que esse `xmin` já foram expurgadas). Isso é **limite de retenção, não evidência** — por isso o
intervalo veio de `cron.job_run_details`.

**Não foi a mesma colagem da migration vizinha.** `xmin` igual provaria mesma transação; aqui eles
diferem:

| objeto | `xmin` | OID |
|---|---|---|
| `cockpit_itens_snapshot` (migration `20260830123820`) | 9641840 | 5104114 |
| `reconciliar_pedidos_omie` (migration `20260830190000`) | 9643295 | 5104303 |
| **`sales_orders_hash_omie_canonico`** | **9644048** | **5104315** |

753 xids depois da função de reconciliação — coladas em transações separadas, na mesma noite. A
ordem por OID (contador global e crescente do Postgres) corrobora a ordem por `xmin`.

`created_by` e `idempotency_key` das linhas do registro são `NULL`, então **não há atribuição de
autor** — a datação é o teto do que o catálogo permite provar.

## O achado que generaliza: o registro erra nos DOIS sentidos

- **Fail-open (o do diagnóstico):** versão **registrada**, DDL **ausente**. `20260829081556` continua
  oca até hoje — conteúdo literal `-- aplicada manualmente via SQL Editor`.
- **Fail-closed / silencioso (o inverso, descoberto agora):** DDL **aplicada**, **zero** linhas do
  registro a mencionam. `SELECT count(*) ... WHERE statements LIKE '%hash_omie_canonico%'` → **0**.

Placar geral do projeto: **9 migrations no repo desde 2026-08-28, 2 linhas no registro.** Objetos
existem sem linha; linhas existem sem objeto. **Neste projeto o registro é decorativo.**

> **REGRA:** auditoria de migration prova o **OBJETO no banco** (`pg_constraint`, `pg_class`,
> `pg_proc`, …). Consultar `supabase_migrations.schema_migrations` responde "alguém digitou uma
> linha", nunca "a DDL entrou".

## A mina que continua viva

O arquivo `supabase/migrations/20260829081556_sales_orders_hash_omie_canonico.sql` **ainda** carrega
uma versão que já consta no registro. Hoje isso é inócuo — o objeto existe. Mas o arquivo está
**permanentemente inerte**: se a constraint for derrubada (um `DROP CONSTRAINT` futuro, ou restore
de um ponto anterior), **o repo não tem caminho automático para recriá-la**. Reaplicar exige colar à
mão de novo. A migration é idempotente (`IF NOT EXISTS`), então re-colar é seguro.

## Pendência ABERTA: a reconciliação de 3 passos do §3 não foi feita

`docs/agent/database.md` §3 diz que migration aplicada à mão exige **três** passos. Estado medido:

| passo | estado |
|---|---|
| (1) `INSERT` em `supabase_migrations.schema_migrations` | ❌ **não feito** — 0 linhas mencionam a constraint |
| (2) re-gerar `supabase/schema-snapshot.sql` | ❌ **não feito** — `grep` sai **1** (ausente do snapshot) |
| (3) `types.ts` | ✅ **N/A** — CHECK constraint não acrescenta coluna |

O passo (2) é o que dói, e o buraco é **genérico, não pontual**: dos 5 objetos recentes provados
vivos em prod (`analytics_outbox_perda`, `reconciliar_pedidos_omie`, `cockpit_itens_snapshot`,
`apriori_universo_snapshot` e esta constraint), **os 5 estão ausentes** do snapshot — cujo último
re-dump (28/08) já trazia "40 migrations de deriva" na própria mensagem de commit. **O snapshot de
DR não tem a constraint**, e não a tem por deriva recorrente. Um restore a partir dele traz um
`sales_orders` sem o guard — e, como o snapshot é a **única** reprodução de prod (§3: "as migrations
não são uma cadeia restaurável"), não há caminho B que a recrie.

O passo (1) tem uma torção específica deste caso: o `INSERT` de reconciliação **não pode** usar a
versão do arquivo (`20260829081556`), porque essa chave **já está ocupada** por uma linha oca. Teria
de entrar sob versão nova, e aí o registro passa a discordar do nome do arquivo. É a colisão
empurrando para a frente.

## O gap concreto: o auditor é CEGO a constraint

`scripts/audit-custom-migrations.ts` gera duas seções — (1) timestamps do registro e (2) existência
objeto-a-objeto. O vocabulário de `kind` da Seção 2 é exatamente:

```
cron_job · function · index · rls_policy · table · trigger · view
```

**Não existe `constraint`.** A Seção 2 consulta `pg_class`, `pg_proc`, `pg_trigger`, `pg_policies`,
`pg_indexes`, `pg_type`, `pg_enum`, `information_schema.tables` — e **nunca `pg_constraint`**.

Resultado medido: `hash_omie_canonico` aparece **1×** na Seção 1 (linha 545, tupla
`(version, name, filename)` — puro registro) e **0×** na Seção 2. Ou seja, para uma CHECK constraint
o auditor **herda a resposta do registro sem nenhum objeto capaz de contradizê-la**: ele é fail-open
exatamente na classe de bug deste episódio.

> **REGRA (a que dói):** "o auditor não achou problema" só vale se o inventário dele **conhece o tipo
> do objeto**. Auditor que não sabe consultar `pg_constraint` não está dizendo "está tudo certo" —
> está dizendo **nada**. É ausência de dado, não aprovação (mesma doutrina de evidência positiva de
> `docs/historico/evidencia-positiva-shell.md`).

**Correção especificada (revisada pelo ritual `/codex`, 2026-09-05 — a 1ª versão desta seção
estava INCOMPLETA e teria produzido um conserto que não conserta):**

1. **Extrair só `ALTER TABLE … ADD CONSTRAINT <nome explícito>`** (CHECK, FK, UNIQUE, PK, EXCLUDE).
   Excluir CHECK inline de `CREATE TABLE`, constraint auto-nomeada, `NOT NULL` e DDL dinâmica —
   ampliar na v1 é como se recria o episódio dos nove falso-vermelhos.
2. **Identidade é `schema + tabela + nome`, nunca só `conname`.** Medido: **4 nomes de constraint
   aparecem em mais de uma tabela** neste banco. Casar só por nome fabrica match — foi o furo da
   primeira medição desta investigação (ela deu "52/52 existem" casando por `conname` solto).
3. **Adicionar o kind NÃO BASTA.** A Seção 1 dá **precedência absoluta ao registro**
   (`scripts/audit-custom-migrations.ts:191`): o `CASE` testa `schema_migrations` primeiro, então
   uma constraint ausente continuaria `✅ registrado` na tabela principal mesmo com o kind ligado.
   Para `constraint`, o catálogo tem de **preceder** o registro, com estados próprios:
   `🔴 registrado, constraint ausente` · `⚠️ presente, NOT VALID` · `✅ presente e validada` ·
   `🟡 presente sem registro`. Se inverter a precedência global reabrir falso-vermelho antigo,
   inverta **só para `constraint`**, depois de rodar em shadow contra prod.
4. **`convalidated = t` é necessário e INSUFICIENTE.** Um CHECK enfraquecido com o mesmo nome também
   fica validado — é a família do §2 de `docs/agent/database.md` ("para objeto que a migration
   MODIFICA, verifica-se o CORPO, não o nome"), e as sabotagens F1/F2 de
   `db/test-hash-omie-canonico.sh` demonstram a forma. ⇒ compare também um **fingerprint de
   `pg_get_constraintdef`**, ou rotule o resultado apenas como "presente+validada", **nunca**
   "correta". Fingerprint atual desta constraint: `md5 = 1b6b77caec7fcd7a6c882ec80bd0a52f`.
5. Presa por: teste com a migration real; duas tabelas com o mesmo `conname`; múltiplos `ADD` no
   mesmo `ALTER`; negativos para inline/auto-nomeada/NOT NULL/comentário/SQL dinâmica; e um sensor
   de corpus (toda ocorrência suportada é extraída ou consta de exceção explícita).

**O buraco que sobra mesmo depois disso** (achado do Codex): se a constraint existir com o nome
certo e a **definição errada**, o `DO $add$` da migration pula a criação por `IF NOT EXISTS`, a
pós-condição encontra `convalidated=t` e **declara sucesso**. A pós-condição prova nome+validação,
não semântica.

## O teste não é órfão: a classe inteira roda fora do CI, por desenho

`db/test-hash-omie-canonico.sh` (16 KB) existe e é executável. Um `grep -rn 'test-hash-omie-canonico'`
em `.github/`, `package.json`, `db/` e `scripts/` sai com **exit 1**: **zero referências**. Não é
chamado pelo CI nem por glob (`grep -rn 'db/test' .github/workflows/ package.json` também sai 1).
Mas isso **não** é um esquecimento pontual: existem **268** `db/test-*.sh` no repo e **nenhum**
é referenciado no CI, porque o CI **não tem service de Postgres** (`grep` por `services:`/`postgres`/
`initdb` em `.github/workflows/ci.yml` sai 1). O cabeçalho do próprio script diz que é o harness
PG17 rodado à mão. ⇒ pendurar um script no CI não é one-liner: exige subir PostgreSQL 17 como
service e tornar o bootstrap portátil (o harness fixa `/opt/homebrew` e exige `brew`; o runner é
Ubuntu, então ligá-lo direto produz **vermelho de infraestrutura**, não sinal).

## Estado final do dado (2026-08-31 15:09 UTC)

| métrica | valor |
|---|---|
| `sales_orders` total | 31.114 |
| `hash_payload IS NULL` (isentas pela 1ª cláusula) | 28 |
| namespace `omie\_%` | 31.086 |
| `omie_` sem `omie_pedido_id` | 0 |
| `omie_` fora da forma canônica | 0 |
| **violam o CHECK** | **0** |
| **predicado indeterminado (NULL ⇒ CHECK passa, fresta fail-open)** | **0** |
| `convalidated` | **`t`** |

`account` é `NOT NULL` (confirmado no `information_schema`, não presumido), então a concatenação
nunca vira NULL — a fresta de "CHECK que avalia NULL passa" está fechada por construção.

**`convalidated = t` é a prova mais forte disponível** e é mais forte que a contagem acima: significa
que o próprio Postgres varreu as 31.114 linhas no `ADD CONSTRAINT` e nenhuma reprovou. Uma constraint
`NOT VALID` teria sido falso conforto — aceitaria linha nova sem afirmar nada sobre o acervo.
