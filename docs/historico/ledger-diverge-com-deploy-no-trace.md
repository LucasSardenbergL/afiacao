# `LEDGER_DIVERGE` com observação velha — o trace do chat provou o deploy, e a sonda devida fechou sem redeploy

> 2026-09-27. Verificação herdada do `/fecho` de uma sessão na nuvem (#2580, 2026-09-26 ~10:15Z) que
> não conseguiu medir prod: sem `psql-ro` nem MCP do Lovable, todos os sensores saíram exit 2 —
> ausência de dado, não "limpo". Refeita numa worktree local, janela `2026-09-26 02:15 UTC` → agora.

## O que foi medido

- **Migrations da janela — 3/3 aplicadas.** `20260925210000_tint_promocao_assincrona` (#2565),
  `20260925225004_reposicao_em_transito_simulado_e_join_grupo_null_safe` e
  `20260926001425_param_auto_em_transito_conta_disparado_simulado` (#2573). As 3 postcondições
  `DO $post$` rodadas em prod pelo `psql-ro` (`ON_ERROR_STOP` + marcador positivo); as 4 funções com
  corpo no arquivo com `md5(prosrc)` = md5 dos bytes do arquivo (são as últimas definidoras);
  o patch por âncora em `tint_promote_sync_run` com as 2 marcas e sem as âncoras velhas; os 2 índices
  válidos; os crons da fila com 0 falha em 24 h; e runs do motor e do param-auto DEPOIS do replace
  (`xmin` da função, exclusivo, menor que o dos runs — [database.md](../agent/database.md) §2).
- **Sentinelas:** `authz:claude-ro:prod` exit 0 (38 asserções) · `deriva:corpo:prod` exit 0 (313).
- **Edges:** `pendencias:deploy` exit 0 às 16:52Z, as 3 do mapa em `CONFERE`. A `tint-sync-agent`
  fica fora do mapa (seção própria abaixo).

## Lição 1 — o `LEDGER_DIVERGE` vale para o instante do `criado`, não para agora

A `omie-sync-estoque` saiu `DIVERGE_P1` (prod v1.1 × main v1.2) com a observação de **2026-09-05**.
O trace do chat (`mcp__lovable__list_messages`, só leitura) tinha `deploy_edge_functions` dela em
2026-09-26 10:03Z, com os 7 `sha256` conferidos contra `314c7bb4` (#2573); desde então, do closure
só mudou `sonda-fingerprints.ts`, e nas entradas de OUTRAS edges. A pendência real era a sonda
pós-deploy daquela leva, que ninguém rodou — não um deploy novo. Sondada: `DEPLOY CONFIRMADO`
(v1.2, `fonte` = main). O redeploy teria gastado crédito e reaberto o risco da lição 2.

⇒ Antes de deployar um `LEDGER_DIVERGE`, compare o `criado` com o trace do chat. Deploy conferido
por hash DEPOIS da observação, com bundle que tem sensor ⇒ a sonda devida daquela leva, não
redeploy. O "não sondar antes do deploy" do `/fecho` pressupõe divergência observada depois do
último deploy.

## Lição 2 — a guarda "nenhum arquivo editado" segurou o agente do Lovable

Em 24/09 e 26/09 o agente, num turno de deploy, editou `whatsapp-inbound` e `sync-reprocess` por
conta própria para calar erro de typecheck do preview (revertidos pelo #2541 e pelo #2579, que
subiu a `VERSAO` das duas). A leva desta sessão era exatamente essas duas — só alinhamento de
`VERSAO`, `index.ts` idêntico ao que já servia. Ao Passo 2 verbatim do `pendencias-pacote` entrou
UM parágrafo, só restritivo (hashes e condições de parada intactos):

> **No file changes in this task.** The files above already match `main` — the hash check proves
> it — so deploying them needs NO edit. Do not edit, create, or delete ANY file in this project
> during this task, including files outside the two functions above. If the preview, the
> build-errors log, or a typecheck reports errors (in these functions or anywhere else), do NOT fix
> them: they are known and tracked in the repository — just list them in your reply. End your reply
> with the exact line `NO FILES EDITED` only if you changed no file at all in this turn; otherwise,
> list every file you changed.

Resultado: 24/24 hashes contra `6bcf9955`, deploy das duas, **nenhuma ferramenta de edição no
trace**, `NO FILES EDITED`, zero commit do bot em `supabase/functions/` depois. De quebra, a cláusula
"não conseguiu conferir ⇒ não deploya" funcionou: o 1º laço de hash do agente devolveu o MESMO valor
para os 24 arquivos, e ele depurou em vez de deployar. É uma amostra, não prova — mas é o insumo que
o item 1 do chip "Blindar o prompt de deploy contra edições do agente" (corpo do #2579) pedia.

## Lição 3 — pelo `db:aplicar`, o PASSO 2 com mapa não volta (2ª ocorrência)

O cabeçalho que o `sonda:sql` escreve manda copiar o PASSO 2 "do log que o `db:aplicar` aponta no
fim" (`scripts/sonda-versao-sql.ts`, as duas emissões do texto). Por esse caminho ele não vem: o
`db:aplicar` embala o arquivo como string e o roda dentro de `public.aplicar_sql(...)`, por `EXECUTE`
no servidor — os `net.http_post` executam, o resultado do SELECT é descartado, e o log só tem o
envelope (`BEGIN`/`SET`/`FIM_APLICACAO_OK`/`COMMIT`). O #2578 já tinha visto
([whatsapp-inbound-sem-prova-edicao-de-tipo.md](whatsapp-inbound-sem-prova-edicao-de-tipo.md)), e as
duas sessões contornaram com o PASSO 2 por eco (`sonda:sql --so-leitura`), que só alcança bundle que
ecoa o slug. O custo apareceria no caso em que o mapa é insubstituível — bundle pré-sensor, 401,
resposta sem eco —, onde o veredito cairia em indeterminado (fail-closed: pendência que continua,
não falso verde).

## `tint-sync-agent` — provada pelo trace; a assinatura comportamental espera o 1º dia útil

Fora do mapa de sondas ⇒ o ledger não a atesta. O trace mostra DOIS deploys conferidos por hash
contra `4af29b7f` (#2565), às 02:38Z e 10:09Z de 26/09; os 3 `sha256` relatados são os da main de
hoje, o closure não tem `_shared/` e o diretório não mudou desde o #2565. A testemunha
comportamental é `tint_sync_runs.promocao_status`: o único agente está em `automatic_primary`, e nesse
modo a edge nova enfileira (`pendente`) o run completo que a velha promovia no HTTP (NULL). Não há run
nenhum desde 2026-09-25 19:53Z (sexta, loja parada no fim de semana). O desenho é retrocompatível:
edge velha + banco novo = comportamento antigo, sem quebra.

Gatilho — no 1º dia útil a partir de 2026-09-28, pelo `psql-ro`:

```sql
SELECT coalesce(promocao_status, '(NULL)') AS promocao, count(*) AS runs, max(started_at) AS ultimo
FROM public.tint_sync_runs
WHERE status = 'complete' AND started_at > timestamptz '2026-09-26 10:09Z'
GROUP BY 1;
```

Qualquer linha preenchida ⇒ bundle novo servindo, fechado. Run completo só com `(NULL)` ⇒ bundle
velho ⇒ deploy pela sessão (`bun scripts/pendencias-pacote.ts tint-sync-agent`) com a guarda da
lição 2. Zero linha ⇒ ainda sem run; repetir no dia útil seguinte.
