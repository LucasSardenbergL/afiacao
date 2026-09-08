# A postcondição embutida reprovou uma migration SÃ — duas vezes, no mesmo bloco (2026-09-08)

> **Por que este arquivo existe:** a postcondição embutida é a defesa contra a falha-mãe do repo
> (migration que não pega e termina em silêncio). Ela funcionou — abortou a transação, nada foi
> escrito, o founder viu a mensagem. Só que a mensagem era **falsa**: a função existia, correta.
> A defesa contra o silêncio ganhou um modo de falha próprio, e ele é o **falso-negativo** — o modo
> que `database.md` já marca como o perigoso, porque empurra para "consertar" o que está são.
> Regra vigente e templates: [`database.md` §4](../agent/database.md) e a skill `lovable-db-operator`.

## O que aconteceu

O founder colou a migration no SQL Editor e recebeu:

```
ERROR:  P0001: POSTCONDICAO FALHOU: analytics_ledger_registrar(text,text,jsonb)
        nao existe — o ledger inteiro fica mudo
```

A função existe em produção desde 2026-08-25. Eu tinha lido `pg_get_functiondef` dela **na mesma
sessão**, minutos antes, para conferir que o corpo da migration batia byte-a-byte com o de prod.

Dois predicados do bloco `DO $post$` estavam errados. Nenhum dos dois era detectável lendo o SQL —
os dois **parecem** certos, e é por isso que valem um arquivo.

## Defeito 1 — o catálogo não devolve o que eu supus

```sql
-- ❌ nunca casa
AND pg_get_function_identity_arguments(p.oid) = 'text, text, jsonb'
```

`pg_get_function_identity_arguments` devolve **com os nomes dos parâmetros**:

```
[p_evento text, p_chave text, p_props jsonb]
```

O `SELECT … INTO v_oid` não achou linha, `v_oid` ficou `NULL`, e o `IF v_oid IS NULL` disparou
anunciando ausência. ⚠️ O agravante: **as outras 13 migrations do repo que usam essa função já usam
o formato com nomes.** A convenção certa estava escrita em treze lugares; eu não olhei nenhum, e
também não rodei o predicado contra prod — o mesmo `psql-ro` que eu tinha usado dois comandos antes
responderia em dois segundos.

**Correção:** `to_regprocedure`, que resolve pela assinatura de **tipos**, devolve `NULL` em vez de
erro quando não acha, e não depende de como o catálogo formata a lista.

```sql
v_oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
```

## Defeito 2 — o guard de PUBLIC casava QUALQUER grantee

```sql
-- ❌ TRUE numa função cujo REVOKE está correto
IF array_to_string(proacl, ',') LIKE '%=X/%' THEN RAISE EXCEPTION 'PUBLIC com EXECUTE'
```

A entrada de PUBLIC no ACL é a de **grantee vazio** — `=X/owner`. Mas `%=X/%` também casa
`postgres=X/postgres`, `authenticated=X/postgres` e todo o resto. O ACL medido em prod é

```
{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_*=X/postgres}
```

— **sem PUBLIC** — e o predicado dava `TRUE`. Ou seja: mesmo com o defeito 1 corrigido, a migration
teria abortado de novo, agora acusando um vazamento de permissão que não existe.

**Correção:** a asserção semântica. `has_function_privilege` aceita `'public'` para o pseudo-role, e
cobre de quebra o caso `proacl IS NULL` (em que o Postgres aplica o default de fábrica, que é
EXECUTE para PUBLIC).

```sql
IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION …
```

Medido em prod na função real: `f`.

## A regra

> **Predicado de postcondição é código não-testado até rodar contra a PROD.** Ele nasce sem
> cobertura: o CI não o executa (não tem banco), o `prove-sql` local não o vê (ele mora na
> migration, não na função), e o primeiro a executá-lo é o **founder**, colando no SQL Editor. É a
> única linha da entrega cuja estreia é em produção, na mão de outra pessoa.
>
> O teste custa um comando: **extraia o bloco `DO $post$` e rode-o via `psql-ro` ANTES de entregar.**
> Contra o estado ANTIGO do banco, ele tem de falhar **em exatamente um predicado** — o que a
> migration muda. Qualquer outra mensagem é um predicado errado, e você acabou de pegá-lo antes do
> founder.

```bash
awk '/^DO \$post\$$/,/^\$post\$;$/' supabase/migrations/<arquivo>.sql > /tmp/post.sql
~/.config/afiacao/psql-ro -f /tmp/post.sql
# esperado: ERROR com a mensagem do ÚNICO predicado que esta migration muda
```

⚠️ **O veredito aqui sai da MENSAGEM, não do exit code:** o wrapper `psql-ro` não passa
`ON_ERROR_STOP`, então `-f` sai **0 mesmo com `ERROR`**. Ler o exit deste comando é ler ausência de
dado como aprovação — a armadilha que `psql-ro-exit-zero-em-sql-que-falhou.md` documenta.

## O que a postcondição acertou, e não se deve perder na leitura

Ela **fez o trabalho dela**: a moldura `BEGIN; … COMMIT;` fez o `RAISE EXCEPTION` reverter a
transação inteira, e o banco ficou **exatamente como estava** — conferido depois: a allowlist
continuava só `'carteira.mixgap_servido'`. Uma postcondição errada custa um round-trip com o
founder. A ausência dela custa uma migration que não pegou e ninguém percebe. **O conserto é medir
o predicado, não remover a defesa.**

## Parentesco

- [`database.md` §4](../agent/database.md) — "validação pós-apply que EXECUTA o objeto mente nos
  DOIS sentidos; leia CATÁLOGO". Este caso é a irmã: **ler o catálogo não basta se o predicado
  sobre o catálogo nunca foi medido.**
- [`psql-ro-exit-zero-em-sql-que-falhou.md`](psql-ro-exit-zero-em-sql-que-falhou.md) — por que o
  veredito do teste acima sai da mensagem.
- [`proxy-posthog-reavaliado.md`](proxy-posthog-reavaliado.md) — a entrega em que isto aconteceu.
  Na mesma sessão, a falsificação já tinha derrubado um guard inalcançável no TypeScript: **duas
  asserções minhas, dois defeitos, ambos invisíveis à leitura e ambos achados por execução.**
