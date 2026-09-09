# `db:aplicar` — a colagem manual de SQL vira UM comando (2026-09-07/08)

**Entrega:** o founder não cola mais SQL no SQL Editor do Lovable a cada migration. Roda
`bun run db:aplicar <arquivo.sql>` e o corpo versionado é aplicado em produção numa transação,
com recibo. A colagem sobrevive **uma vez só**, no bootstrap.

## O que motivou

A pergunta original era outra: *"você consegue colar o que precisa no SQL Editor do Lovable?"*.
Um piloto medido 24h antes já respondia ([piloto-deploy-mcp-lovable.md](piloto-deploy-mcp-lovable.md)).
O re-teste acrescentou um dado novo — o classificador de auto-mode **bloqueia `query_database`
mesmo em SELECT puro** — e derrubou duas afirmações do piloto. Mas a decisão do founder foi
adiante da pergunta: *"quero automatizar isso, não quero colar eu mesmo"*.

## O desenho — e por que NÃO foi o desenho óbvio

O óbvio seria um papel `claude_rw` membro de `postgres`. **Produção recusou:**

```
ERROR: 42501: permission denied to grant role "postgres"
DETAIL: Only roles with the ADMIN option on role "postgres" may grant this role.
```

Não é configuração faltando: no PG16+ **um papel não tem ADMIN sobre si mesmo** — só quem o criou
tem. No Supabase gerenciado quem criou `postgres` é `supabase_admin`, superusuário fora do alcance.
Medido: `postgres` tem **zero** membros e é dono de 425/425 objetos de `public`. A escalada por
pertencimento simplesmente **não existe** nessa plataforma.

O caminho que existe é uma **função `SECURITY DEFINER`** (`public.aplicar_sql`), dona `postgres`,
`search_path` fixado, `EXECUTE` só para `claude_rw` (`REVOKE` das duas pontas: `PUBLIC` **e**
`anon`/`authenticated`). Ela é a porta mais poderosa do banco, então é fechada por três coisas ao
mesmo tempo: o ACL, o ledger `public.db_aplicacoes` (com RLS), e a exigência de que o corpo recebido
**case por sha256** com a tentativa aberta — a função recusa `id` já fechado ou de outro corpo.

## As lições (o que custou caro descobrir)

### 1. O ramo `DESCONHECIDO` era MORTO — e o teste era cúmplice

```bash
ERRO="$(grep -iE '...' "$APPLY_OUT" | head -3 | ...)"   # sem match → grep sai 1
```

Sob `set -euo pipefail`, `grep` sem ocorrência mata o script **naquela atribuição**. O ramo que
existe justamente para "nenhum erro reconhecível" era inalcançável **exatamente no cenário que ele
serve**. Fix: `|| true`.

O agravante é o teste: ele aceitava *"qualquer coisa ≠ 0"*, recebeu o `1` da morte do script e
chamou de aprovação. **Asserção frouxa não é rigor de menos — é rigor fingido.** Case a marca do
ramo, nunca "saiu diferente de zero".

### 2. O tratamento de falha podia APAGAR um `COMMIT` que aconteceu

Se a resposta se perde depois do `COMMIT` (rede, failover), o recibo fica `aplicada`. O `UPDATE`
de pós-falha reescrevia para `falhou` — apagando a prova **e**, por tabela, tirando a linha do
índice único parcial `WHERE estado = 'aplicada'`, o que **reabria a reaplicação dos mesmos bytes**.
Fix: reconciliar por leitura ANTES de escrever falha, e todo `UPDATE` de falha carrega
`AND estado = 'tentativa'`.

Efeito colateral bom: a reconciliação virou uma **segunda testemunha**. Cegar só o marcador de fim
não engana mais o veredito — o que exigiu reescrever a falsificação para cegar as duas, e abriu uma
sabotagem nova que prova que, com só o marcador cego, o ledger ainda responde certo.

### 3. `commit_sha` no ledger é evidência mais fraca do que parece

Os recibos deste teste gravaram `commit_sha=7a261deac`. O rebase antes do PR **destruiu esse SHA**:
ele nunca existiu em `origin`. O que amarra o recibo ao corpo é o **sha256 do conteúdo**, que
sobrevive a rebase; o `commit_sha` é pista de proveniência, não âncora. Quem for auditar o ledger
precisa saber disso.

## O teste de fumaça em produção (2026-09-08, ordem ditada pelo Codex)

Cada passo conferido por **conexão independente** (`psql-ro`), nunca pelo que o script diz de si:

| Passo | Esperado | Medido |
|---|---|---|
| pré | tabela ausente · ledger 0 · função é a nova | `NAO_EXISTE` · `0` · `true` |
| aplicar `db-aplicar-ok.sql` | exit 0 + marcador | `RC=0`, recibo #2 |
| conferir | `(1,'aplicou')` · 1 recibo `aplicada` · 0 sessão pendurada | tudo confere, `ator=claude_rw` |
| repetir o MESMO arquivo | exit 3, ledger intacto | `RC=3`, ledger `1`, **nenhuma tentativa aberta** |
| aplicar `db-aplicar-drop.sql` | exit 0 | `RC=0`, recibo #3 |
| conferir | tabela sumiu · 2 recibos · sessões limpas | `SUMIU` · `2` · `0` |

Os ids são #2 e #3, não #1 e #2: o ensaio anterior consumiu o `IDENTITY` e o `ROLLBACK` **não
devolve sequência**. O Codex previu isso — id fora de sequência não é sintoma.

## O que a prova em PG17 estruturalmente NÃO atesta

O `db/test-db-aplicar.sh` sobe um cluster real, mas com `initdb -U postgres` — um superusuário
local. Ele **não** prova: as restrições do `postgres` gerenciado do Supabase, o comportamento do
pooler/TLS e do wrapper de produção, perda de resposta durante `COMMIT` ou failover, nem ACL/RLS/
extensões/gatilhos/dados/contenção reais. O teste de fumaça acima cobre parte disso **uma vez**;
não é vigilância contínua.

## O que continua manual (de propósito)

`db/claude-rw-bootstrap.sql` é colado no SQL Editor **uma vez** — é o único jeito de criar o papel
e a função sem já ter o canal. É `CREATE OR REPLACE` e idempotente; mudar a função exige re-colar.
E o arquivo carrega um placeholder de senha: **conferir que o placeholder voltou antes de commitar**
(aconteceu duas vezes de a senha real ficar na árvore de trabalho; nenhuma foi commitada).

## Ponteiros

- Canal: [`scripts/db-aplicar.sh`](../../scripts/db-aplicar.sh) · [`db/claude-rw-bootstrap.sql`](../../db/claude-rw-bootstrap.sql)
- Prova executada: [`db/test-db-aplicar.sh`](../../db/test-db-aplicar.sh) (28 asserções + 4 sabotagens, dois locales)
- Sentinela de ACL: `public.aplicar_sql` está em [`scripts/authz-funcoes-fechadas.ts`](../../scripts/authz-funcoes-fechadas.ts) — sem fecho declarado, o audit é a **única** guarda dela
- Contexto da pergunta original: [piloto-deploy-mcp-lovable.md](piloto-deploy-mcp-lovable.md)
