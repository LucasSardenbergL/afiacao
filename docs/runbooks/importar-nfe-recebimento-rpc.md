# Runbook — RPC transacional de recebimento de NF-e (`importar_nfe_recebimento`)

**Money-path: entrada de mercadoria.** Fecha as corridas que o PR #3142 (`omie-nfe-webhook` v1.3) deixou abertas por exigirem migration: webhook×sync na mesma chave (2N itens) e `omie-nfe-reconcile` promovendo `pendente→efetivado` no meio da importação. Desenho, parecer Codex e prova: [`docs/historico/nfe-recebimento-rpc-transacional.md`](../historico/nfe-recebimento-rpc-transacional.md).

**O que entra no banco** (`db/2026-10-18-importar-nfe-recebimento-rpc.sql`, idempotente, com PRE anti-deriva e postcondição A1–A10):

| Objeto | Para quê |
|---|---|
| `nfe_recebimentos.origem` (+ CHECK) | denominador "cabeçalhos criados pelo webhook / sync / botão". NULL = antes do sensor (sem backfill) |
| `nfe_recebimentos.reparada_origem` / `reparada_em` | quem COMPLETOU um cabeçalho que ficou sem itens (a origem de criação não muda) |
| `UNIQUE (nfe_recebimento_id, sequencia)` em `nfe_recebimento_itens` | 2 lotes do mesmo recebimento nunca coexistem (0 ou N, nunca 2N) — defesa atrás do lock |
| `nfe_importacao_falhas` (RLS: service_role tudo, staff lê) | registro DURÁVEL de falha de DADO e de IMPEDIMENTO (`bloqueada`/`divergente`), fora da transação abortada; a RPC apaga no sucesso; ≥3 tentativas estaciona a chave na triagem do cron |
| `importar_nfe_recebimento(jsonb, jsonb, text)` | a RPC: lock consultivo por chave + `FOR UPDATE` + cabeçalho e itens no mesmo commit; lote vazio nunca materializa nem certifica (NFE03); compatibilidade de armazém/recebimento antes de qualquer sucesso. Só `service_role` executa |
| `nfe_importacao_falha_registrar(…)` | `tentativas + 1` atômico (um upsert do PostgREST não incrementa). Só `service_role` |

## ⚠️ ORDEM — as etapas irreversíveis

```
(0) DRENAR os writers antigos  →  (1) migration  →  (2) validação psql-ro ✅  →  (3) NOTIFY pgrst  →  (4) deploy das DUAS edges  →  (5) RELIGAR o cron + validação ponta a ponta
```

- **Edge nova sem a migration** responde **500 nomeando a migration** (webhook) / `errors[]` do cron e `erro_gravacao` no botão — fail-closed e barulhento; **não há fallback** para o caminho antigo de 2 requisições (seria um 2º writer em silêncio). Por isso a migration vem PRIMEIRO.
- **Versões mistas** (bundle antigo rodando com a migration aplicada): o caso que importa, apontado pelos 2 pareceres do Codex — o **botão antigo** cria o cabeçalho (1ª requisição), um writer NOVO o repara via RPC e commita, o lote antigo colide na UNIQUE e a compensação antiga **apaga o cabeçalho — em cascata, apaga os itens certos**. "Mesma leva" só encurta a janela; **uma execução antiga em andamento atravessa a publicação**. Daí o passo (0): drenar de forma VERIFICÁVEL.

## (0) Drenar os writers antigos (verificável)

1. **Pausar o cron** da sync (`omie-nfe-recebimento-import-1h`, `50 10-22 * * 1-6`) — 🟣 SQL Editor:

```sql
SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname = 'omie-nfe-recebimento-import-1h';
SELECT jobname, active FROM cron.job WHERE jobname = 'omie-nfe-recebimento-import-1h';  -- esperado: active = false
```

2. **Esperar a última rodada TERMINAR** (a edge dura segundos; o teto é o `timeout_milliseconds` do job). Prova positiva de que não há execução em voo: a última resposta HTTP do cron já chegou:

```sql
SELECT r.created, r.status_code, left(r.content::text, 80)
FROM net._http_response r
WHERE r.content::text LIKE '%por_armazem%'
ORDER BY r.created DESC LIMIT 1;   -- esperado: created < agora - 2 min (a rodada que o cron pausado disparou já respondeu)
```

3. **Botão "Importar NF-e"**: avise a equipe para não usá-lo até o passo (5). Prova de que ninguém usou na janela (rode depois do deploy): `SELECT count(*) FROM public.nfe_recebimentos WHERE created_at > '<hora do passo 0 em UTC>' AND origem IS NULL;` → esperado `0` (cabeçalho com `origem` NULL depois da migration = bundle antigo escreveu).
4. **Webhook**: hoje sem chamador (0/72). Se um dia o Omie estiver apontado para ele, a drenagem é desligar o webhook no painel do Omie antes do passo (1) e religar no (5) — os eventos ficam na fila/DLQ dele.

Só depois: (1) migration.

## (1) Aplicar a migration

**Caminho A — `bun run db:aplicar` (a sessão aplica; exige o arquivo COMMITADO na main):**

```bash
cd /Users/lucassardenberg/Projetos/afiacao && git pull --ff-only && bun run db:aplicar db/2026-10-18-importar-nfe-recebimento-rpc.sql --ensaio && bun run db:aplicar db/2026-10-18-importar-nfe-recebimento-rpc.sql
```

Exit `0` = aplicado · `3` = já aplicado (no-op) · `4` = falhou (rollback; a mensagem `A<n> FALHOU: …` diz o quê).

**Caminho B — 🟣 Lovable → SQL Editor → cola → Run:** `BEGIN;` + o arquivo `db/2026-10-18-importar-nfe-recebimento-rpc.sql` **inteiro, byte a byte** + `COMMIT;`. O SQL Editor **não mostra `RAISE NOTICE`**: tela muda = aplicou; qualquer `A<n> FALHOU` = nada foi aplicado (a transação reverteu).

## (2) Validar (read-only — eu rodo via `psql-ro`; o founder pode colar no SQL Editor)

```sql
SELECT
  CASE WHEN to_regprocedure('public.importar_nfe_recebimento(jsonb, jsonb, text)') IS NOT NULL
        AND NOT has_function_privilege('anon', 'public.importar_nfe_recebimento(jsonb, jsonb, text)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.importar_nfe_recebimento(jsonb, jsonb, text)', 'EXECUTE')
        AND has_function_privilege('service_role', 'public.importar_nfe_recebimento(jsonb, jsonb, text)', 'EXECUTE')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfe_recebimento_itens_recebimento_sequencia_key' AND contype = 'u' AND convalidated)
        AND (SELECT count(*) FROM information_schema.columns WHERE table_name = 'nfe_recebimentos' AND column_name IN ('origem','reparada_origem','reparada_em')) = 3
        AND to_regclass('public.nfe_importacao_falhas') IS NOT NULL
        AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.nfe_importacao_falhas'::regclass)
        AND to_regprocedure('public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)') IS NOT NULL
       THEN '✅ importar_nfe_recebimento aplicada (RPC só-service_role · UNIQUE validada · origem/reparada_* · falhas com RLS)'
       ELSE '❌ FALTANDO — migration não aplicada (ou parcial): me avise' END AS status;
```

## (3) Cache do PostgREST

Função nova no catálogo **não prova** disponibilidade via PostgREST (`PGRST202` também é cache). No SQL Editor:

```sql
NOTIFY pgrst, 'reload schema';
```

## (4) Deploy das duas edges (mesma leva)

Quem decide é o ledger: `bun run pendencias:deploy` lista `omie-nfe-webhook` (`v1.5-rpc-transacional`) e `omie-nfe-recebimento-sync` (`v1.5-rpc-transacional`). Caminho de deploy e sonda: [`docs/agent/deploy.md`](../agent/deploy.md). Sondas esperadas: `{"probe":true}` → `v1.5-rpc-transacional` / `v1.5-rpc-transacional`.

## (5) Religar o cron e validar ponta a ponta (com denominador)

🟣 SQL Editor, depois que as DUAS edges respondem a sonda nova:

```sql
SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = 'omie-nfe-recebimento-import-1h';
SELECT jobname, active FROM cron.job WHERE jobname = 'omie-nfe-recebimento-import-1h';  -- esperado: active = true
```

1. **Sem escrita:** em `/recebimento` → "Importar NF-e" com a chave de uma NF-e **já importada com itens** → toast "Esta NF-e já foi importada (N itens)". Prova que a triagem lê (não prova a RPC).
2. **Com escrita, consertando um legado:** as 4 NF-e `pendente` sem itens e sem sinais de uso que a prod tem hoje (medido 2026-10-18) são exatamente o que a RPC repara. Liste-as e importe UMA pelo botão:

```sql
SELECT r.chave_acesso, w.code AS armazem, r.omie_id_receb, r.created_at::date
FROM public.nfe_recebimentos r JOIN public.warehouses w ON w.id = r.warehouse_id
WHERE r.status = 'pendente' AND r.conferente_id IS NULL AND r.conferido_at IS NULL
  AND r.efetivado_at IS NULL AND r.efetivacao_lock_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.nfe_recebimento_itens i WHERE i.nfe_recebimento_id = r.id)
ORDER BY r.created_at;
```

Esperado: toast "NF-e importada — N itens" (se a NF-e ainda está aberta no Omie) **ou** "O Omie recusou a consulta…/já recebida" (aí o legado não é reparável por este caminho — fica como passivo). Depois:

```sql
SELECT origem, reparada_origem, count(*) FROM public.nfe_recebimentos GROUP BY 1, 2 ORDER BY 3 DESC;  -- o DENOMINADOR nasce aqui
SELECT count(*) AS falhas_registradas, max(tentativas) FROM public.nfe_importacao_falhas;
SELECT r.status, count(*) FROM public.nfe_recebimentos r
WHERE NOT EXISTS (SELECT 1 FROM public.nfe_recebimento_itens i WHERE i.nfe_recebimento_id = r.id) GROUP BY 1;  -- era 52 efetivado · 4 pendente · 1 falha
```

3. **O cron** (horário, 10–22h) passa a consultar as reparáveis sozinho (1 consulta por conta e rodada, sorteada): em 1–2 dias os 4 `pendente` sem itens devem ter virado `reparada_origem = 'sync'` ou aparecido em `errors[]` do `net._http_response` com o motivo.

## O que este runbook NÃO resolve (passivo visível, não contabilizado como resolvido)

- **52 `efetivado` sem itens + 1 `falha_efetivacao`** (herança do incidente de NCM de 2026-09-26): a RPC responde `bloqueada` para eles (não injeta itens em recebimento efetivado). Decisão de produto: canonicalizar/arquivar é do founder.
- **Chave estacionada** em `nfe_importacao_falhas` (≥3 falhas de dado): o cron não a consulta mais; o botão "Importar NF-e" a reprocessa (ignora o estacionamento), e o sucesso apaga o registro. Apagar a linha à mão também libera.

## Rollback

As edges voltam ao bundle anterior pelo caminho normal de deploy — **com a mesma drenagem do passo (0)** (cron pausado, botão parado), porque a coexistência bundle-antigo × migration tem a janela do DELETE em cascata descrita acima. A migration **fica** (é aditiva: coluna nullable, UNIQUE que só barra defeito, tabela e funções que o bundle antigo não chama). Não há `DROP` neste runbook — se um dia for preciso, é DDL destrutivo e vai pelo SQL Editor do founder.
