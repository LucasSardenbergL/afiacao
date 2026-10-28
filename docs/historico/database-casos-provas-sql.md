# Casos do `database.md` — provas SQL executadas no CI (§2b)

> Narrativa e medições que sustentavam as regras de [`docs/agent/database.md`](../agent/database.md) até o piloto N (2026-10-27, plano v3). Cópia **verbatim** dos blocos do doc em `d850983fa`, feita por script — nenhum caso foi reescrito; só os links relativos ao `docs/agent/` foram reapontados. Cada bloco leva a linha antiga (`L<n>`), o mesmo número que a regra viva cita entre parênteses. A regra (o que fazer) está no doc; aqui fica o porquê e o número medido. Blocos que seguiram idênticos no doc vivo não foram copiados.

## L174

`db/test-*.sh` são **289** provas que sobem um Postgres 17 descartável (`initdb` + `pg_ctl` em porta própria), aplicam a migration REAL do repo e asseveram o comportamento. Até 2026-09-07 **nenhuma** rodava no merge — a única menção no `ci.yml` era comentário. Ficavam sem gate justamente TOCTOU/guard-fora-da-escrita, PL/pgSQL late-bound e `security_invoker` omitido. Histórico: [sql-executado-no-caminho-do-merge.md](../historico/sql-executado-no-caminho-do-merge.md).

## L176

- **O gate é o job `provas-sql`**, e ele roda o **NÚCLEO**, não as 289: a lista é `db/nucleo-ci.txt`. Local: `bash db/roda-nucleo-ci.sh` (`--lista` mostra o que rodaria). Dente: `bash db/falsifica-nucleo-ci.sh`. **Desde 2026-10-01 o job é uma MATRIZ de partes paralelas** (`NUCLEO_PARTE=i/N` vindo de `strategy.job-index`/`job-total`; a prova de posição k vai para a parte k mod N; toda parte valida o manifesto inteiro): serial, o núcleo passou do teto de 20 min, e o #2712 o subiu para 30 como stopgap; com as partes medidas (job de 4m36s a 6m52s), voltou a 20. Folga acabando de novo ⇒ **acrescente uma parte à matriz**, não suba o teto nem tire falsificação do CI. Local: `NUCLEO_PARTE=0/3 bash db/roda-nucleo-ci.sh --lista`. → [provas-sql-em-partes.md](../historico/provas-sql-em-partes.md)

## L183

- ⚠️ **Prova nasce no macOS e roda no Ubuntu — nada de construção BSD-only.** `sed -i '' "expr" arq` quebra no GNU (o `''` vira o SCRIPT e a expressão vira NOME DE ARQUIVO): use `sed "expr" arq > arq.tmp && mv arq.tmp arq`. Foi o 1º defeito que o job `provas-sql` pegou, e o runner agora barra na leitura do manifesto.

## L185

- **Prova que carrega o `schema-snapshot.sql` entra no núcleo** (desde 2026-09-27): o job instala o `postgresql-17-pgvector` que o prelude exige e confere que o servidor CARREGA a extensão. No runner o snapshot inteiro sobe em 1–2s — os ~35s do laptop em swap não projetam o CI. E o motivo que uma prova DECLARA para estar fora é hipótese: nas tint, o pgvector era 1 de 4 camadas ([provas-tint-no-nucleo.md](../historico/provas-tint-no-nucleo.md)).

## L186

- ⚠️ **Prova fora do núcleo que carrega o snapshot e RE-APLICA a migration da sua fase morre no próximo re-dump** (medido 2026-09-28: 9 das 12 apodrecidas das 261; o re-dump #1509 matou 7 sem tocar prova nenhuma; 33 verdes seguem armadas). Assinatura: `schema-snapshot.sql` + `supabase/migrations/<ts anterior ao último re-dump>` no mesmo `db/test-*.sh`, sem `db/lib/data-health-vivo.sh`. O re-dump ABSORVE a migration: `CREATE POLICY` não-idempotente aborta, objeto dropado depois some, CHECK/trigger novo rejeita o seed, corpo velho REVERTE o vivo. Prova revivida vai para o núcleo; o sensor das demais é decisão de custo pendente ([provas-db-mortas-fora-do-nucleo.md](../historico/provas-db-mortas-fora-do-nucleo.md)).

## L187

- ⚠️ **Re-dump do snapshot: o replay recusa o que nasceu em prod depois do último dump — e consertar o
  stub tem efeito colateral em ~290 provas** (2026-10-08, 3 runs até instalar). Antes de relançar
  (12 min cada), levante TUDO do tipo de uma vez pelo catálogo: referências a `auth.*` em
  views/matviews/constraints, e roles citadas em **POLICY** — só elas: o dump é `--no-owner
  --no-privileges`, GRANT e owner nunca chegam a ele (eu pus `claude_ro` à toa por contar grantees).
  Ao mexer em `db/stubs-supabase.sql`: (a) role que alguma prova cria com atributos (`LOGIN BYPASSRLS`)
  sob `EXCEPTION WHEN duplicate_object THEN NULL` **não pode** nascer antes no stub — o `CREATE` dela
  vira no-op calado; (b) tabela que alguma prova também define tem de ter o **mesmo formato** (DEFAULTs
  inclusos) — `IF NOT EXISTS` faz quem carrega primeiro decidir calado. `grep` as provas que criam o
  mesmo objeto antes. E toda prova do núcleo que carrega o snapshot pode apodrecer no re-dump: trigger
  `ENABLE ALWAYS` (coerência pedido × itens) dispara **mesmo** sob `session_replication_role = replica`
  — semente que quer pular gatilho tem de desligá-lo por nome e religar como ALWAYS.
  **Checklist do PR de re-dump (cada item custou um vermelho no CI em 2026-10-09):** (1) avance
  `CV_INICIO` em `db/lib/corpo-vivo.sh` — **medindo** contra prod qual a 1ª migration que o dump não
  absorveu (audit 🟡 + catálogo para as ALTER/GRANT/cron), e tem de ser migration **existente** (o guard
  aborta sentinela); `DHV_INICIO` não, lá cadeia vazia é defeito. (2) Prova que prova a TRANSFORMAÇÃO de
  uma migration já absorvida perde o pré-estado: carregue o snapshot contra o qual ela foi escrita via
  `git show <sha>:supabase/schema-snapshot.sql` (padrão em `db/test-padrao-like-contem.sh`) — fixture só
  de corpos não basta quando o pré-estado inclui coluna/cron. (3) Calibração que afirma "prod ainda tem o
  bug X" lendo o snapshot vira falsa quando o conserto chega — inverta para provar o conserto, com
  contagem de leitura > 0. (4) Mexeu em auditor/contrato de authz ⇒ `bun run authz:carimbo:gravar`. (5) **Re-meça `db/lib/corpo-vivo-acl.sql` junto** (a consulta está no rodapé dele): o dump é
  `--no-privileges`, então migration só de GRANT/REVOKE **nunca** é absorvida por ele — avançar o
  `CV_INICIO` sem re-medir o ACL tirou da cadeia o GRANT por coluna da 20261001100000 e derrubou o
  `test-whatsapp-funil` (42501). "O dump absorveu a migration" vale para DDL, não para ACL.
  ⚠️ O auditor de deriva OFICIAL é `bun run deriva:corpo:prod` (tokens, patches, baseline aceita em
  `db/deriva-corpo-baseline.json`) — patch programático por envelope entra lá como `EDICAO_MANUAL`, md5 do
  `prosrc` cru + `md5DeTokens`. A Seção 3 do audit de migrations é a visão para o SQL Editor; eu dupliquei
  nela um reconhecimento que o oficial já fazia (2026-10-08) — procure o artefato antes.

## L215

- ⚠️ **Prova sobre o trio de data-health (`_data_health_compute` + `data_health_watchdog` + `fin_sync_heartbeat`) monta o CORPO VIVO com `db/lib/data-health-vivo.sh`**: snapshot, MV populada, ACL medido em prod e a cadeia DINÂMICA das migrations que redefinem o trio (md5 igual ao de prod, medido em 2026-09-27). Re-aplicar a migration da SUA fase sobre o snapshot mais novo REVERTE o trio no banco de teste, e a prova passa a medir uma versão que ninguém executa. E como o watchdog vivo ENGOLE o erro do compute, negativo ("o B não entra") sem a pré-condição "rodada completa" passa por vacuidade ([provas-tint-apodrecidas.md](../historico/provas-tint-apodrecidas.md)). **Função que a prova lê ALÉM do trio entra em `DHV_GUARDADAS`** (ex.: `get_data_health`, a RPC do app): fora da lista, a próxima redefinição fica fora da cadeia e a prova segue medindo a do snapshot — provado por contrafactual ([provas-data-health-revividas.md](../historico/provas-data-health-revividas.md)).

## L216

- ⚠️ **Prova que lê ou escreve como `authenticated`/`anon` reproduz o ACL MEDIDO de prod — nunca `GRANT ALL ON ALL TABLES`.** O snapshot é `--no-privileges`; o ACL vive em `db/lib/corpo-vivo-acl.sql` (default do Supabase + as exceções medidas por `psql-ro`, tabela → coluna → função, + o DEFAULT PRIVILEGES de prod — sem ele, o objeto que a cadeia recria por DROP+CREATE nasce sem o EXECUTE explícito que prod dá ao anon; consultas de re-medição no rodapé), montado com snapshot e cadeia dinâmica por `db/lib/corpo-vivo.sh`. O `GRANT ALL` das provas de julho as impedia de ver o funil do canal dando `permission denied` para todo staff em prod: **coluna nova não herda o GRANT por coluna** de `sales_orders` (consertado pela `20261001100000`; o `authz:check` só aceita GRANT por coluna dentro do `colunasPermitidas` da tabela fechada). E 42501 é o mesmo código para GRANT de função, de tabela e policy — o assert nomeia a camada (`prova.sqlstate`), senão sabotar a 1ª fica verde pela 2ª ([provas-canal-revividas.md](../historico/provas-canal-revividas.md)).

## L218

- ⚠️ **Fixture com volume espelha os ÍNDICES de prod, e o plano não pode depender do autovacuum.** Sem os índices, view correlacionada vira laço aninhado: a `fase5-watchdog` levava 64–80s numa varredura de 1004 chaves (7–25ms com os índices de prod) e o total oscilava 185s × 252s com o autovacuum. `ANALYZE` não é conserto de graça: com os índices, ele trocou o plano por um ~7× mais lento a partir da 3ª suíte — medido por ablação; saiu, e o cluster da prova sobe com `autovacuum=off`. Prova lenta demais para o núcleo? Meça no runner onde está o tempo antes de mexer em fixture ou asserção — [fixture-sem-indices-de-prod.md](../historico/fixture-sem-indices-de-prod.md).
