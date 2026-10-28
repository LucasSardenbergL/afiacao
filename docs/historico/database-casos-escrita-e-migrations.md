# Casos do `database.md` — escrita (ENVELOPE), migrations e snapshot (§1 Escrita, §2, §3)

> Narrativa e medições que sustentavam as regras de [`docs/agent/database.md`](../agent/database.md) até o piloto N (2026-10-27, plano v3). Cópia **verbatim** dos blocos do doc em `d850983fa`, feita por script — nenhum caso foi reescrito; só os links relativos ao `docs/agent/` foram reapontados. Cada bloco leva a linha antiga (`L<n>`), o mesmo número que a regra viva cita entre parênteses. A regra (o que fazer) está no doc; aqui fica o porquê e o número medido. Blocos que seguiram idênticos no doc vivo não foram copiados.

## L92

**Mudou em 2026-09-09.** Até então esta seção dizia "SOMENTE via SQL Editor", e a razão era

## L93

tomada como capacidade: a sessão não teria como escrever. Não é (mais) verdade —

## L94

`mcp__lovable__query_database` executa `INSERT`/`UPDATE`/`DDL` contra a prod, e o `psql-ro`

## L95

continua read-only só porque o WRAPPER é. Regra que confunde "não devo" com "não consigo"

## L96

envelhece mal: ninguém a revisa, porque parece lei da física.

## L116

Primeira aplicação por este caminho: `20260908204421_deploy_sonda_alvos_onda3.sql`

## L117

(3 linhas de allowlist), pré-voo 11→14 alvos, validada por fora com `✅`.

## L119

**Dois `db:aplicar` simultâneos do MESMO arquivo** (desde 2026-10-08): a fila os põe em ordem e o 2º é

## L121

benigno: o 1º aplicou. Antes o 2º executava o corpo de novo e só o índice do recibo o revertia

## L124

**Cron pelo `db:aplicar` nasce com dono `postgres` (medido 2026-10-06).** O `aplicar_sql()` é

## L125

SECURITY DEFINER do `postgres`, então dentro dele o `current_user` é o `postgres`. É esse papel que o

## L126

`cron.schedule` grava em `cron.job.username`, e é como o job roda. A nota da `20260924163250` ("cole

## L127

como `postgres` no SQL Editor — o `claude_rw` nem tem USAGE no schema `cron`") vale para o PAPEL, não

## L128

para o caminho. Os objetos criados pelo `db:aplicar` também saem com dono e ACL default do `postgres`.

## L129

Medido no ensaio e no apply da `20261006004500` (jobid 190, `username = postgres`), com a

## L130

postcondição exigindo isso.

## L133

O `db:aplicar` a recusa por desenho, e tirar o envelope no cliente quebra o sha. Pelo MCP, o SQL

## L134

passa pela mão da sessão: feche isso na própria transação, com a postcondição exigindo

## L136

aborta tudo). Antes, faça o **ensaio** com a mesma SQL terminando em `RAISE EXCEPTION 'ENSAIO_OK …'`

## L137

rotulado, o que garante o rollback e ainda dá o veredito positivo. Caso real e medições:

## L140

**O CANAL do founder — para o que a seção acima deixa com ele.** Ele NÃO tem terminal/psql/CLI **de escrita** pro backend: o que vai pra mão dele é colado no **SQL Editor do Lovable** → Run. ⚠️ Este parágrafo dizia "**Toda** DDL/DML/migration é colada" e "**eu nunca** aplico escrita" — as duas caíram em 2026-09-09, junto com a regra acima, e sobreviveram aqui embaixo por serem lidas como lei da física. Mandar colar o que cabe no envelope (`bun run db:aplicar`) é devolver trabalho, não cautela. Quando for handoff de verdade, formate: fenced ` ```sql `, terminando com ` ``` ` numa linha sozinha (o app renderiza o botão Copy), rótulo `🟣 Lovable → SQL Editor → cola → Run`; material preparado via `lovable-db-operator`.

## L142

⚠️ **O SQL Editor não devolve tudo o que o SQL escreve — o canal de saída é parte do desenho** (medido 2026-09-06, `db/sonda-exec-preco-ausente.sql`): ele **não exibe `RAISE NOTICE`** (o founder rodou uma sonda de 6 vereditos e a tela ficou MUDA — sonda muda produz "ausência de dado" lida como aprovação, a falha-mãe do `CLAUDE.md`) e **TRUNCA a mensagem de erro num orçamento pequeno que NÃO é um número fixo** — 4 rodadas medidas: 240 chars / 5 linhas apareceram INTEIROS (marcador de fim incluído); 445 perdeu as 2 últimas linhas; a versão com `jsonb::text` cortou no MEIO de uma linha; e a 4ª rodada cortou já aos **296** — **mais cedo que um relatório de 362 que tinha aparecido inteiro**. ⚠️ Não tente calibrar pelo número (eu tentei: escrevi "~400 chars, limite de caracteres" e a rodada seguinte desmentiu). O que é acionável é o DESENHO, que sobrevive sem conhecer o limite: **≤ ~5 linhas e ~250 caracteres por bloco**, veredito agregado na FRENTE e marcador de fim SEMPRE. ⇒ **Sonda/diagnóstico entregue por handoff reporta por `RAISE EXCEPTION` ROTULADA** — o rótulo diz no próprio texto que o "erro" é o relatório, senão o founder lê como falha —, com o **veredito agregado ANTES do detalhe** (o que trunca é o fim) e um **marcador de fim** (`--- fim ---`) para o truncamento virar SINAL em vez de silêncio; payload **enxuto**: projete só o campo que decide o veredito (`inserted`/`falhas`) e limite o erro (`left(SQLERRM,120)`), nunca o objeto todo; **passou de ~250 caracteres ou 5 linhas, quebre em BLOCOS** (Runs separados — o EXCEPTION do 1º aborta a transação e o 2º nunca rodaria junto), cada um com o próprio veredito agregado e o próprio marcador de fim. Bônus do EXCEPTION: aborta a transação, então a sonda não deixa rastro. **`CREATE TEMP TABLE` + `SELECT` não serve de alternativa** — sob `psql-ro` é `cannot execute CREATE TABLE in a read-only transaction`, ou seja, eu não conseguiria testar o artefato antes de entregar. Isto vale para o que vai para o **SQL Editor**: onde há psql de verdade (harness `db/test-*.sh`, `psql-ro`) o NOTICE aparece normalmente e está certo como está.

## L148

- ✅ **Defesa em profundidade: postcondição EMBUTIDA na migration.** A validação do item (3) só funciona se alguém *lembrar* de rodá-la. Termine o `.sql` com um bloco `DO $post$` que relê o catálogo e dá `RAISE EXCEPTION` se o objeto não existir **ou existir em estado insuficiente** — e envolva tudo em `BEGIN; … COMMIT;`. Ele roda no mesmo Run de quem colou ⇒ **migration que não pegou não termina em silêncio**. Cobre justamente as duas classes cegas dos bullets abaixo: o objeto que a migration *modifica* (o assert é sobre o CORPO/estado, não sobre o nome) e o falso-vermelho/verde do audit (que sai de **regex sobre o `.sql`** e tem 13,4% de classe cega — a postcondição roda **no banco**, sem depender do extrator). Já em 9 migrations; canônica: `20260829081556_sales_orders_hash_omie_canonico.sql`, que checa `pg_constraint.convalidated` e não só a existência — **constraint `NOT VALID` "existe" sem provar nada sobre o acervo**. Templates por tipo de objeto, moldura transacional medida e limites do padrão: `.claude/skills/lovable-db-operator/references/postcondicao-embutida.md`. **Não substitui** a validação por `psql-ro`: a postcondição prova o estado ao fim da transação do apply — não que o founder colou o bloco inteiro, nem que ninguém dropou o objeto depois.

## L149

- 🚨 **O PREDICADO da postcondição estreia em PRODUÇÃO, na mão do founder — teste-o antes.** Ele é a única linha da entrega sem cobertura nenhuma: o CI não tem banco, o `prove-sql` olha a função e não a migration, e o primeiro a executá-lo é quem cola no SQL Editor. Em 2026-09-08 um bloco `DO $post$` abortou uma migration **sã** por DOIS predicados errados de uma vez: (a) `pg_get_function_identity_arguments(oid) = 'text, text, jsonb'` **nunca casa** — o catálogo devolve `'p_evento text, p_chave text, p_props jsonb'`, COM os nomes (as outras 13 migrations do repo já usavam o formato certo) ⇒ use **`to_regprocedure('schema.fn(tipos)')`**, que resolve por tipos e devolve NULL em vez de erro; (b) `array_to_string(proacl,',') LIKE '%=X/%'` casa `postgres=X/postgres` e **todo** grantee — a entrada de PUBLIC é a de grantee **VAZIO** (`=X/owner`) ⇒ use **`has_function_privilege('public', oid, 'EXECUTE')`**, que ainda cobre `proacl IS NULL` (default de fábrica = EXECUTE p/ PUBLIC). O teste custa um comando: `awk '/^DO \$post\$$/,/^\$post\$;$/' <migration> > /tmp/post.sql && ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f /tmp/post.sql` — contra o estado ANTIGO ele tem de falhar em **exatamente um** predicado (o que a migration muda); qualquer outra mensagem é predicado errado. ⚠️ **Veredito pela MENSAGEM, nunca pelo exit** (`-f` sai 0 com ERROR). O falso-negativo é o modo perigoso: empurra para re-aplicar o que está são — mas o conserto é **medir o predicado, não remover a defesa** (a moldura `BEGIN;…COMMIT;` reverteu tudo, e o banco ficou intacto). Detalhe: [`postcondicao-que-reprova-migration-sa.md`](../historico/postcondicao-que-reprova-migration-sa.md).

## L150

- Auditoria de quais migrations estão aplicadas: `scripts/audit-custom-migrations.sql` (cola no SQL Editor, ou rodo via `psql-ro`) + `docs/migrations-audit.md` (regenera com `bun run audit:migrations`). **A Seção 1 reconcilia registro × existência de objeto em 5 estados** (não mais ✅/❌ binário): ✅ registrado · 🟡 **aplicado-sem-registro** (NORMAL — o Lovable não registra nome custom; 363/479 assim em 2026-08-21, **não é dívida**) · ⚠️ parcial (n/m objetos) · ❌ não-aplicado (0 objetos) · ⚪ sem objeto rastreável (ALTER/UPDATE puro). **Só ⚠️/❌ são acionáveis** — objeto que a migration deveria criar não existe em prod: ou apply pendente, ou removido/renomeado por migration POSTERIOR (obsoleto — o audit não modela remoções; expurgar do inventário). Registro retroativo, quando vale, é guardado por existência (`INSERT … SELECT … WHERE md5/EXISTS … ON CONFLICT DO NOTHING`) p/ nunca criar falso-verde.

## L151

- ⚠️ **Migration que ENDURECE objeto já existente é invisível para verificação por EXISTÊNCIA — o audit e o `/fecho` dão falso-verde (caso `20260807223000`, 2026-08-07).** Os 5 estados do bullet acima classificam por *o objeto existe?*; quando o efeito da migration é **modificar** algo que já estava lá (endurecer CHECK, trocar gate, `CREATE OR REPLACE` de função/view), o objeto existe **antes** dela rodar ⇒ conta como aplicada sem nunca ter sido colada. Vivido: `check_finitude_money_path` tem 2 blocos; a verificação conferiu `conname` e leu `cmc_snapshot_cmc_check` como ✅ **existe** — mas prod tinha o guard ANTIGO `CHECK ((cmc > (0)::numeric))`, exatamente a forma que aquele bloco existia para substituir (em `numeric`, `NaN > 0` é TRUE ⇒ guard de sinal aceita NaN). Virou o diagnóstico "migration **parcialmente** aplicada" quando ela estava **zero** aplicada, e o bloco de correção derivado dele cobria só metade — deixando aberto o guard do `cmc`, que alimenta margem e piso de preço da régua. ⇒ **Para objeto que a migration MODIFICA, o que se verifica é o CORPO, não o nome:** `pg_get_constraintdef`/`pg_get_functiondef`/`pg_get_viewdef` de prod × a forma esperada — mesma raiz do §3 ("para o CORPO de um objeto, o repo não é a verdade; prod é"). Marcador barato: um predicado exclusivo da forma NOVA (`def LIKE '%Infinity%'`) — é o teste que o próprio bloco usava internamente para ser idempotente e que a verificação externa não usou.

## L152

- ⚠️ **Um `❌` do audit é do EXTRATOR antes de ser do banco — em 2026-08-21 as 9 acionáveis (1 ❌ + 8 ⚠️) eram TODAS falso-vermelho: zero apply pendente.** O inventário `expected_objects` sai de **regex sobre o `.sql`** (`scripts/lib/migration-objects.ts`), e a regex não vê: (a) `CREATE POLICY "Nome Com Espaços"` — a classe `[^\s"]+` para no primeiro espaço ⇒ **50 das 450 policies do repo somem do inventário** (11%, 20 arquivos) — não viram vermelho, viram **ausência**; (b) `REVOKE`/`GRANT`, que não têm objeto nenhum; (c) DDL por `EXECUTE format('CREATE POLICY %I ON public.%I', …)` ⇒ o literal **`%I`** entra como nome esperado = vermelho ETERNO. Somem-se **objeto que migration POSTERIOR moveu de schema** (`public.carteira_visivel_para` → `private.`, pelo `fu7_helpers_rls_schema_privado`) e **objeto superseded** (o audit não modela remoção), e todo ❌/⚠️ passa a exigir checagem objeto-a-objeto antes de virar dívida. Pior: **`✅ registrado` CURTO-CIRCUITA a verificação** (o `CASE` testa `schema_migrations` primeiro) ⇒ verde por REGISTRO, com zero objeto conferido — foi assim que o fence de `farmer_association_rules` (#1840) ficou ✅ sem nada ser verificado. **Classe cega: 64/479 (13,4%)** = 55 ⚪ + 9 ✅-sem-objeto, sobre as quais o audit não tem opinião. ⇒ **Fence de permissão não se prova por EXISTÊNCIA** (o nome da policy costuma existir antes e depois; o sinal real é uma *remoção* + um ACL) — prova-se por `pg_policies.cmd`/`qual` e `proacl`, que é o que o `/fecho` faz e o audit não. Detalhe: `docs/historico/audit-migrations-falso-vermelho.md`.

## L153

  - **Faxina de 2026-10-08 — 39 vermelhos-falsos a zero, e duas classes mortas na Seção 3:** (a)
    `funcoesRemovidas()` modela `DROP FUNCTION` / `ALTER FUNCTION … SET SCHEMA|RENAME TO` — último evento é
    remoção sem recriar ⇒ a função sai da seção (era `❌ AUSENTE em prod` eterno); (b) `DERIVA_RECONHECIDA`
    reconhece deriva **pelo md5 do corpo vivo, nunca pelo nome** — mudou o corpo, volta a 🔴 (falsificado:
    hash sabotado ⇒ exatamente 1 acusada). Antes de pôr deriva no mapa: diff corpo vivo × última migration
    + `prosecdef`/`proconfig`/EXECUTE de anon/authenticated. ⚠️ O hash é do `prosrc` com espaço colapsado:
    **comentário SQL conta**, e corpo recriado sem um comentário vira "deriva" (medido). E **não registre**
    as "aplicadas sem registro" em `schema_migrations` para o audit ficar verde: `✅ registrado`
    curto-circuita a conferência de objeto — o 🟡 é o estado em que ele confere.

## L162

- ⚠️ **O inventário não tem o kind `constraint` — CHECK/FK são uma classe 100% cega, e aí o registro decide sozinho.** `scripts/lib/migration-objects.ts` extrai `table · view · index · function · trigger · rls_policy · cron_job`; a string `ADD CONSTRAINT` aparece **0 vezes** nele, e a Seção 2 do SQL nunca consulta `pg_constraint`. Logo, para migration cujo efeito é uma constraint, a Seção 1 responde pelo `schema_migrations` e **não existe objeto capaz de contradizê-la** — o curto-circuito do bullet acima, só que sem saída. Caso vivo: `sales_orders_hash_omie_canonico` aparece 1× na Seção 1 (linha 545, tupla `(version, name, filename)`) e **0×** na Seção 2. Some-se a isto que **o registro erra nos DOIS sentidos** — a versão `20260829081556` esteve *registrada com a DDL ausente*, e depois a constraint ficou *aplicada sem nenhuma linha que a mencione* (9 migrations no repo desde 28/08 × **2** linhas no registro). ⇒ ao entregar constraint, a validação é `pg_constraint` + **`convalidated`** (uma `NOT VALID` existe e não prova nada sobre o acervo), e a reconciliação do §3 inclui **re-gerar o snapshot** — o DR não tinha essa constraint. Detalhe: `docs/historico/schema-migrations-fail-open.md`.

## L163

- ⚠️ **"Sem linha em `schema_migrations`" NÃO é "não aplicada" — o ledger cobre 13% e atrasa 12 dias (medido 2026-10-08).** `count(*)` dá **245** linhas contra **767** `.sql` na `main` (708 `version` numéricas únicas), e `max(version)` = `20260925210332` (25/09) com a `main` já em 08/10 ⇒ o passo (1) do §1 (`INSERT` no ledger) **não é cumprido na prática** — e não por descuido: o apply normal aqui é colar no SQL Editor, que não registra nada. Pior, 245/767 ≈ 32% é o número OTIMISTA: o ledger grava o timestamp **1–2 s à frente** do nome do arquivo (delta repo−ledger: 0 s em 94 · +1 s em 127 · +2 s em 18), então o casamento por `version` **EXATA** — que é como toda query de ledger pergunta — cobre só **94/708 = 13,4%** (±1 s → 31,4%; ±2 s → 34,0%), e **145 migrations que ESTÃO registradas** somem de um `JOIN` por igualdade. ⇒ **a autoridade é a tabela (B) do audit (existência do objeto); a (A)/o ledger NÃO responde "está aplicada?"** — falso negativo em ~6 de cada 7 casos pelo caminho exato, ~2 de 3 dando tolerância de graça. Mesmo erro do `✅ registrado` que curto-circuita a verificação (bullet acima), pelo outro lado: lá o registro dava verde sem conferir objeto, aqui a **ausência** dá vermelho sem conferir objeto. Vivido no fecho de 08/10: uma query de ledger acusou **43 de 45** migrations do último mês como não-aplicadas; a (B) mostrou os **125 objetos TODOS presentes** (zero ausentes), e as 6 sem linha em (B) saíram aplicadas uma a uma por query dedicada — alarme **100% falso**. **(B) não inventaria** `UPDATE`/`INSERT` de dados, `ADD COLUMN`, `GRANT`/`REVOKE`, constraint (bullet acima) e cron por `cron.alter_job`/`unschedule` (só `cron.schedule('nome',…)` entra no extrator) ⇒ aí a prova é query dedicada, e isso é DESENHO, não lacuna: a migration mais nova da `main` (`20261008010000`) usa `cron.alter_job` ⇒ **0 objetos** em (B). **Não reconcilie o ledger com `INSERT` em massa** (~522 linhas): é escrita em prod sem ganho — a (B) já responde a pergunta, e o ledger re-atrasa na próxima colagem; se valer, é decisão do founder, guardada por existência. Detalhe: [`ledger-de-migrations-cego.md`](../historico/ledger-de-migrations-cego.md).

## L167

  - **O `db:aplicar` serializa sozinho desde 2026-10-01 (no ar às 08:16 BRT, tentativa #222):** fila em `aplicar_sql` (advisory `(20260909,1)`, READ COMMITTED exigido), e dois applies nunca se cruzam, com ou sem trava no arquivo. A trava segue obrigatória para o que não passa pela porta (SQL Editor, MCP, builder). Prova ponta-a-ponta nos dois níveis (a corrida existe sem, fecha com): `db/test-pre-anti-deriva-concorrencia.sh`. → [pre-anti-deriva-corrida-e-fila.md](../historico/pre-anti-deriva-corrida-e-fila.md)

## L168

- ⚠️ **Evidência de banco tem VALIDADE — re-meça antes de agir sobre pendência HERDADA.** O apply é manual e assíncrono, então prod muda entre "o handoff mediu" e "a sessão nova lê o handoff": a medição não é estado, é **retrato datado**. Caso `20260807223000` (2026-08-08): o `/fecho` de outra sessão mediu `tint_formula_itens` com **0 CHECKs** e abriu pendência "migration não aplicada" — **verdadeiro no instante da medição** (o PR #1691 mergeou 00:31 UTC); a re-medição ~10 min depois, já na sessão seguinte, achou a constraint presente **e `convalidated=true`** — colada 01:36–01:37 UTC, dentro da janela entre a medição e a abertura da sessão. Executar o roteiro herdado às cegas teria re-entregado SQL já aplicado (aqui inócuo — os 2 blocos são idempotentes; **nem toda migration é**: ver o bullet de re-colar no §3, que REVERTE hardening em silêncio). ⇒ **Passo 0 de toda pendência de banco herdada: re-rodar a query de evidência do próprio handoff** — antes de escrever SQL, antes de aceitar o diagnóstico. E ao ENTREGAR pendência, carimbe a evidência com a **hora UTC da medição**; sem isso quem recebe não tem como saber o que envelheceu.

## L169

- 🔎 **Datar um DDL aplicado à mão** (não há `created_at` em `pg_constraint`/`pg_proc`, e `track_commit_timestamp` está **`off`** em prod, então `pg_xact_commit_timestamp` não serve): correlacione o **`xmin` da tupla do catálogo** com o `xmin` de linhas **datadas** de `cron.job_run_details`/`net._http_response` (escrevem de minuto em minuto) → resolução ~1 min. Bônus: **`xmin` igual em 2 objetos prova que a MESMA transação os criou** — foi o que mostrou que a migration acima foi colada inteira de uma vez, e não em apply parcial. ⚠️ **O `xmin` data a ÚLTIMA escrita da tupla, não o corpo:** `GRANT`/`REVOKE`/`ALTER FUNCTION` reescrevem a linha de `pg_proc`. Em **2026-08-14 00:16–02:15Z** um GRANT em massa (papel `sandbox_exec_*` do Lovable) reescreveu **504 funções + 83 relações** numa transação só (`xmin` 9106714) ⇒ função anterior a essa data tem o `xmin` do lote, não o do seu apply. **Antes de atribuir um `xmin`, conte quantos objetos o compartilham** ([deriva-so-de-comentario-no-corpo.md](../historico/deriva-so-de-comentario-no-corpo.md)). E a tabela que data tem de ser SÓ-DE-INSERÇÃO para o limite SUPERIOR (`pg_stat_user_tables.n_tup_upd = 0`): o `sync_reprocess_log` sofre UPDATE e só dá o INFERIOR ([deriva-corpo-sem-sensor.md](../historico/deriva-corpo-sem-sensor.md)).

## L170

- ⚠️ **O audit é ímã de conflito sob auto-merge.** `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` são regenerados por **toda** migration → com o fluxo de auto-merge do repo, o teu PR reconflita neles a cada nova migration que mergeia na `main` (loop — reconflitou 2× no PR #1243/F3 v2). O **CI não valida o audit** e ele é **derivável** (`bun run audit:migrations`). Ao reconflitar em loop: **não regenere** (reconflita de novo) — **tome a versão de `main`** no merge (`git checkout origin/main -- docs/migrations-audit.md scripts/audit-custom-migrations.sql`), tirando o audit do teu diff; o PR para de reconflitar e o audit se re-inventaria na próxima regeneração de qualquer sessão. Regenerar+commitar o audit só compensa quando o PR **não** compete com outros merges.

## L226

- **Reconciliar migration/RPC aplicada à mão (SQL Editor) exige TRÊS passos, não um:** (1) `INSERT` em `supabase_migrations.schema_migrations` (senão o audit §1 do `audit-custom-migrations.sql` marca `❌ MISSING` com o objeto **já existindo** em prod) — conserta o *audit*; (2) **re-gerar o `schema-snapshot.sql`** — conserta o *DR*. Registrar no `schema_migrations` ≠ reproduzir prod. Caso `20260626150457` (colunas em prod fora do snapshot até o re-dump → o bot do Lovable regenerou `types.ts` de um estado sem elas e **quebrou o typecheck da `main`**). E o **snapshot é um retrato DATADO, prod é alvo móvel:** o dump de 26/06 20:20 UTC já nasceu stale (às 00:13 UTC o #1090 recriou `gerar_pedidos_sugeridos_ciclo` via `db/embalagem-motor-rpc.sql`, **sem migration formal** em `supabase/migrations/` → essa versão do motor só existe no DR pelo snapshot). Quando o motor money-path importa, confira `md5(pg_get_functiondef())` **prod × snapshot** antes de confiar no dump. E (3) **os TIPOS** — `src/integrations/supabase/types.ts` é gerado pelo **Lovable** (não há geração local: nenhum script no `package.json`, nenhuma CLI do Supabase no repo), e ele só regenera quando **ELE** aplica a migration pelo builder. Migration de nome custom colada à mão no SQL Editor — o caminho NORMAL aqui, porque nome custom não auto-aplica — muda o **banco** e **não toca os tipos**. A bomba é de efeito retardado: nada quebra enquanto ninguém referencia a coluna nova, e então o **primeiro PR que a referenciar deixa a `main` VERMELHA** — travando o auto-merge de TODOS os PRs abertos, inclusive os que nada têm a ver com a mudança. Mordido 2× por caminhos diferentes: `20260626150457` (o bot regenerou de um snapshot sem as colunas, bullet acima) e `preco_csv_legado` em `v_tint_formula_canonica` (#1439 → 17 erros TS2339/TS2352, destravado no #1450 adicionando a coluna à mão em ordem alfabética — a convenção do gerador, p/ o diff ser mínimo quando o Lovable regenerar). ⇒ Ao entregar migration que ACRESCENTA coluna/view que o front vai consumir, trate a regeneração dos tipos como parte da entrega, não como consequência automática; e diagnostique pelo par **banco × `types.ts`** (`psql-ro` no `information_schema` vs `grep` no arquivo), porque o erro do TS aponta para o consumidor e esconde a causa.

## L228

- ⚠️ **Migration committada é IMUTÁVEL — logo o arquivo pode carregar um gate que prod já não tem. RE-COLAR uma migration antiga REVERTE o hardening posterior, em silêncio (achado do re-dump, #1509).** O §4 documenta o padrão de trocar o gate de uma RPC grande por **substituição programática** (`DO $$ … pg_get_functiondef → replace → EXECUTE $$`), justamente para não recopiar um corpo de centenas de linhas. O efeito colateral é que o `.sql` original **fica com o gate velho para sempre** — e não pode ser corrigido (o hook `migration-immutability-guard.sh` bloqueia, e a pasta é fonte de DR). Caso vivo: `20260721190000_reposicao_pos_candidatos.sql` contém `pode_ver_carteira_completa`; **prod tem `cap_compras_ler`** desde o #1472. Colar aquele arquivo hoje desfaz o #1472 sem erro nenhum — é a irmã da armadilha do `CREATE OR REPLACE` sem `WITH`: falha **ABERTA**, muda autorização e não comportamento, e nenhum teste de "a função funciona" pega. ⇒ **Antes de re-colar QUALQUER migration que recrie função/view, faça pré-flight do `pg_get_functiondef`/`pg_get_viewdef` de PROD** (via `psql-ro`) e cole a versão VIVA, não a do repo. Regra geral: para o CORPO de um objeto, **o repo não é a verdade — prod é**; o repo é a verdade do *histórico*, e as duas divergem toda vez que um hardening entra por substituição programática.

## L229

- ⚠️ **`supabase/migrations/` não replaya nem em ordem lexicográfica — não sirva de plano B num incidente.** `20260720120000_…fu4g.sql` **aborta de propósito** se `public.reposicao_pos_candidatos(text)` não existir, e quem a cria é `20260721190000` — timestamp POSTERIOR (efeito colateral benigno da convenção de "ordene depois do último", que produz timestamps futuros: em 21/07 já existiam migrations nomeadas 22–24/07). Some-se ao drift do §"Schema não-rebuildável" e o veredito é: **a única reprodução de prod é o snapshot**. Se ele estiver stale, não há caminho B — foi exatamente o estado entre 27/06 e 21/07 (#1509).
