# O passo seguinte da sonda não voltava pelo `db:aplicar` — agora volta por NOTICE (2026-09-27)

**Entrega:** o bloco de disparo do `sonda:sql` (sonda e canária) devolve o passo de leitura por DOIS
canais — a célula, que o SQL Editor mostra, e um NOTICE com o MESMO texto, que é o que chega ao log do
`db:aplicar`. O cabeçalho diz o canal de cada via e o comando que extrai o passo do log.

## O defeito (2 ocorrências)

O PASSO 1 dispara e devolve o passo 2 já escrito, com o mapa `edge → request_id` embutido, numa célula
de SELECT. O cabeçalho mandava copiar "a célula do SQL Editor, ou o log que o db:aplicar aponta no
fim". Pelo `db:aplicar` isso era falso: ele embala o arquivo em `SELECT public.aplicar_sql($TAG$…$TAG$,
sha, :eid)`, e o `aplicar_sql()` faz `EXECUTE p_sql` sem `INTO` — os `net.http_post` executam, o
resultado do SELECT morre no servidor, e o log traz só `BEGIN`/`SET`/`SET`/`FIM_APLICACAO_OK`/`COMMIT`.

Visto no #2578 ([whatsapp-inbound-sem-prova-edicao-de-tipo.md](whatsapp-inbound-sem-prova-edicao-de-tipo.md))
e no #2593 ([ledger-diverge-com-deploy-no-trace.md](ledger-diverge-com-deploy-no-trace.md), Lição 3).
As duas sessões contornaram com o passo 2 por eco (`sonda:sql --so-leitura`), que não alcança bundle
pré-sensor, 401 nem resposta sem eco. No modo **canária** não havia contorno: a resposta não ecoa o
slug, o `--so-leitura` é recusado, e o disparo pela sessão saía cego.

## Decidido medindo

1. **O defeito, reproduzido.** Prova nova com o `scripts/db-aplicar.sh` e o `db/claude-rw-bootstrap.sql`
   REAIS contra PG17 (stubs de `net.http_post`/`vault`): o disparo acontece, o log é só o envelope, e
   o texto dos passos 2 e 4 aparece **0 de 2** vezes — sonda e canária. Antes da correção a prova saía
   `6 ok / 21 fail`.
2. **O canal existe em prod.** Por `psql-ro`, sem efeito nenhum (`DO` com `RAISE NOTICE`): um NOTICE de
   15,7 KB em 300 linhas atravessou inteiro o pooler que o `psql-rw` usa
   (`aws-1-eu-west-1.pooler.supabase.com:5432`), prefixo `psql:<arq>:<linha>: NOTICE:` só na 1ª linha.
   `client_min_messages = notice`, sem override por papel ou banco; `postgres` tem TEMP; o
   `aplicar_sql` é SECURITY DEFINER de `postgres`.
3. **A alternativa "o `db:aplicar` imprimir o resultado" quebra.** Só daria mudando o `aplicar_sql`
   (SECURITY DEFINER de prod, re-colagem do bootstrap pelo founder) para `EXECUTE … INTO`. Medido no
   PG17: `EXECUTE 'SELECT 1; CREATE TEMP TABLE t(a int)' INTO v` →
   `ERROR: INTO used with a command that cannot return data`. Toda migration que não termina em SELECT
   passaria a falhar. Descartada.

## A forma

- Cada bloco de disparo declara `pg_temp.sonda_passo_tambem_por_notice(inicio, fim, texto)`: devolve o
  texto INTACTO (é a célula) e o repete num NOTICE entre `SONDA_PASSO_<n>_INICIO` e `…_FIM`.
  Temporária: o `sonda:sql` não cria objeto em produção. NOTICE só sai de PL/pgSQL, e o texto só
  existe dentro do SELECT que dispara — um `DO` antes não o conhece, e um depois tiraria a célula do
  último statement.
- O `format()` vira subconsulta escalar, e as linhas `SELECT format($sonda$` e `$sonda$, m.ids)` ficam
  intactas: são as âncoras do recorte de `db/test-canaria-veredito.sh`.
- O comando do cabeçalho é `awk '…' <log> | ~/.config/afiacao/psql-ro`. O awk só imprime depois de ver
  abertura E fechamento (recorte truncado emite zero byte) e sai 3 DIZENDO que o passo não veio.
- ⚠️ **O log do `--ensaio` também traz o NOTICE** (ele sai antes do ROLLBACK), mas nada foi disparado —
  o passo daquele log fica em `AGUARDE` para sempre. O cabeçalho manda usar o log do apply de verdade.

## Premissa declarada: o SQL Editor com dois statements

Cada bloco passou a ter dois statements (`CREATE FUNCTION` + o SELECT da célula), e **não há medição
direta** de como o SQL Editor exibe lote multi-statement. Há duas indiretas, e as duas mostram a célula:
o conector Lovable roda `SET …; SET …; WITH … SELECT` como UM lote e devolve as linhas do SELECT final
([deploy.md](../agent/deploy.md) §"Leitura por um canal de escrita"); e o `db/claude-rw-bootstrap.sql` —
dezenas de DDLs e um SELECT final com `BOOTSTRAP_OK`, colado com a instrução "se não vir, não deu
certo" — foi colado e seguido no SQL Editor ([db-aplicar-colagem-manual-vira-comando.md](db-aplicar-colagem-manual-vira-comando.md)).
Se o Editor divergir, a falha é VISÍVEL (sem célula), não um veredito falso. Medição direta, zero
efeito (a função é temporária), para a próxima vez que o founder abrir o Editor:

```sql
CREATE OR REPLACE FUNCTION pg_temp.eco_da_sonda(t text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN RETURN t; END $f$;
SELECT pg_temp.eco_da_sonda('SE ESTA FRASE APARECE NA CELULA, O EDITOR MOSTRA O SELECT FINAL') AS celula;
```

## O que a prova da canária pegou no caminho

A 1ª versão da função tinha `BEGIN` e `END` sozinhos na linha. A sabotagem (g2) de
`db/test-canaria-veredito.sh` tira o envelope inerte apagando `^BEGIN$`/`^END$` **no arquivo
inteiro** — e levava junto o corpo da função: o disparo morria antes de sair, a sentinela não via
"DISPAROU" e a g2 falhava (`17 vermelhas / 1 falha`). Linha `BEGIN`/`END` isolada se lê como moldura
ou controle de transação para qualquer ferramenta de linha; a função passou a abrir e fechar na linha
do `$notice$`, e um teste pina que nenhuma linha emitida é `BEGIN`/`END`/`DECLARE` sozinha.

E o comando de extração ganhou `-v ON_ERROR_STOP=1`: o `psqlrc-ro` liga read-only, timeout e QUIET,
mas não o ON_ERROR_STOP — sem ele, um passo extraído que falhe imprime ERROR e o `psql` sai 0.

## Evidência

- `db/test-sonda-passo-pelo-db-aplicar.sh` — antes da correção `6 ok / 21 fail` (o defeito, com o
  executor real); depois `RESULTADO: 27 ok / 0 fail`; `--falsificar`: controle verde (27) nos dois
  idiomas do servidor e `SABOTAGENS: 14 vermelhas / 0 falhas` (44 s no laptop). No núcleo de CI.
- `scripts/sonda-versao-sql.test.ts` — vermelho de ASSERÇÃO antes da implementação
  (`11 failed | 207 passed`), verde depois (`218 passed`).
- mutcheck: as 8 mutações novas, `8 pegas · 0 sobreviventes`; `--seco` com os 39 contratos cirúrgicos.
- eval `sonda-veredito-401`: 11 vereditos + cardinalidade; typecheck, eslint e shellcheck verdes.
