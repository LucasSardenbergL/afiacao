# Sentinela de grants — tabelas fechadas por privilégio

> Diário desta frente. Desenho: `docs/superpowers/specs/2026-07-22-sentinela-grants-tabelas-fechadas-design.md`.
> Plano (7 tasks, **todas entregues**): `docs/superpowers/plans/2026-07-22-sentinela-grants-tabelas-fechadas.md`.

## 2026-08-13 — Tasks 1–3: o gate estático entra no CI

### O que existe agora

`bun run authz:check` (step do `validate`) ganhou uma **Parte C**: além do contrato de gate em RPC
SECDEF (A/B), ele vigia as tabelas fechadas por **PRIVILÉGIO** — as que dependem de
`REVOKE ALL` + `GRANT SELECT` e não só de policy. Fonte única: `scripts/authz-tabelas-fechadas.ts`.

Vetores que ficam vermelhos, todos **provados por falsificação no comando real** (não só em fixture):

| Código | Sabota com | Resultado |
|---|---|---|
| `REABERTURA` | `GRANT INSERT ON public.omie_products TO authenticated` | exit 1 |
| `RECRIACAO` | `DROP TABLE` + `CREATE TABLE` da tabela | exit 1 |
| `RLS_OFF` | `ALTER TABLE … DISABLE ROW LEVEL SECURITY` | exit 1 |

Removida a sabotagem → exit 0, zero achados. O dente some pela causa certa.

`RECRIACAO` é o vetor que um gate ingênuo perde: `DROP`+`CREATE` faz a tabela **renascer com o
default privilege aberto** do Supabase, sem nenhum `GRANT` aparecendo no diff.

### A lição que custou 3 semanas

A allowlist nasceu em 2026-07-22 com `fechadaPor: null` nas duas tabelas — verdade medida naquele
dia. **No dia seguinte o fecho de `omie_products` mergeou** (PR #1558,
`20260727140000_authz_preco_fecha_omie_products.sql`) e foi aplicado em prod. A allowlist não
acompanhou, porque o arquivo estava numa branch órfã que nunca virou PR — e que **só existia no
clone local**, fora de `origin`.

Ou seja: por 3 semanas houve uma tabela money-path fechada em prod, um documento declarando que ela
estava aberta, e **nenhuma vigilância**. É palavra por palavra o `ANCORA_NAO_DECLARADA` que o §5.2
do spec foi escrito para impedir — "warn eterno = gate inerte, silêncio indistinguível de
tudo-em-ordem". O desenho previu o próprio modo de falha e passou 3 semanas demonstrando-o.

⇒ **Um artefato que declara uma pendência precisa de um mecanismo que force sua atualização quando
a pendência resolve.** Aqui esse mecanismo é o próprio gate: se `fechadaPor` é `null` mas existe
`REVOKE … FROM authenticated` da tabela no repo, é **erro** que nomeia o arquivo. A transição
pendente→vigiado deixou de depender de alguém lembrar.

⇒ **Corolário de processo:** branch fora de `origin` é trabalho que não existe. Esta ficou visível
só porque a triagem de órfãs (#1709) a listou.

### Onde o plano de julho envelheceu

A Task 3 mandava injetar a Parte C **dentro** de `auditAuthz`. Funcionava só enquanto todas as
entradas eram `fechadaPor: null`. Com uma âncora declarada, **12 testes pré-existentes** de A/B
quebraram: seus fixtures não contêm a migration-âncora, então cada um disparava `ANCORA_AUSENTE`.

A causa é de fronteira, não de bug: a Parte C julga *quais arquivos existem no repo*; A/B julgam
*definições de função*. Fundidas, todo teste futuro de A/B teria de carregar o contrato de C.
Separadas — `auditGrants` própria, `auditCompleto` compondo as três para o `main()` — o comando de
CI continua sendo um só, sem superfície nova no `ci.yml`.

### Estado medido em prod (`psql-ro`, 2026-08-13 20:51 UTC)

| Tabela | `anon` | `authenticated` | Gate diz |
|---|---|---|---|
| `public.omie_products` | ausente do `relacl` | `r` | vigiada (âncora declarada) |
| `public.product_costs` | `arwdDxtm` | `arwdDxtm` | `FECHO_PENDENTE` (warn) |

`product_costs` segue protegida **só pela RLS** (2 policies staff) — o grant DML amplo é o modelo
da plataforma (`database.md` §7), inócuo sob RLS, mas sem a defesa em profundidade do fecho. O PR
#1520 que a fecha está OPEN+DRAFT desde julho.

**Quando o #1520 mergear, o CI daquele PR fica vermelho** com `ANCORA_NAO_DECLARADA` até a allowlist
declarar a âncora. Isso é o desenho (§8), não um acidente: é o passo que ninguém consegue pular em
silêncio. A correção é uma linha em `scripts/authz-tabelas-fechadas.ts`.

> O desenho do próprio fecho de `product_costs` foi resgatado em paralelo, de outra branch órfã, pelo
> **#1711** (`docs/superpowers/specs/2026-07-20-fechamento-custo-farmer-scoring-design.md`). As duas
> frentes se encontram no dia em que o #1520 sair de draft: uma fecha a tabela, a outra passa a vigiar
> o fecho.

## 2026-08-13 — Tasks 4–7: a segunda camada, que olha o banco

### O que existe agora

`bun run authz:grants:prod` (`db/audit-grants-tabelas-fechadas.ts`, sob `psql-ro`, on-demand — o CI
não tem `psql-ro`) mede `has_table_privilege` no banco real e compara com **a mesma allowlist** que
o CI usa. É TypeScript e não bash exatamente por isso: `import` da fonte única em vez de uma lista
duplicada num `.sql` que envelheceria em silêncio.

| Código | Significa | Ação |
|---|---|---|
| `NAO_APLICADA` | a role ainda tem o **DML completo** (`INSERT+UPDATE+DELETE`, o default do Supabase) e a âncora está no repo | **aplicar** a migration no SQL Editor |
| `DRIFT_PROD` | sobra **parcial** — ninguém escreve isso por default | **revogar** e descobrir quem concedeu |
| `FECHO_PENDENTE` | `fechadaPor: null` | nada a comparar; o texto diz que prod **não** foi comparada |

Exit `0` limpo · `1` divergência · `2` **erro de execução** — audit que não conseguiu medir não pode
sair 0.

### O falso-verde que o dente pegou (a razão de o harness existir)

Na primeira execução, `db/test-audit-grants-tabelas-fechadas.sh` reprovou o audit: com
`GRANT INSERT ON … TO authenticated` aplicado, ele imprimia **"✅ prod bate com o contrato"**. O
achado era real e de uma banalidade perigosa: a query concatena o resultado (`'…'||has_table_privilege(…)`),
e `text||boolean` imprime **`true`/`false`** — o parser esperava `t`/`f`, o formato de *coluna*
boolean. **100% das linhas descartadas ⇒ medição vazia ⇒ nenhuma divergência ⇒ verde.** O run
contra prod que eu havia feito minutos antes estava viciado por isso e parecia perfeito.

Duas correções, e a segunda é a que generaliza:

1. o veredito passa a sair de um `CASE … THEN 'SIM' ELSE 'NAO' END` — o formato do dado é
   responsabilidade da query, não do default de impressão do psql (que `psqlrc`/`\pset` mudam por baixo);
2. a medição ganhou **PISO**: a query devolve `tabelas × roles × privilégios` linhas *sempre*,
   inclusive quando a resposta é "não tem nenhum". Vir menos ⇒ exit 2. Sem isso, **audit que não
   mediu é indistinguível de audit que aprovou** — é a lição "ausência de dado não é aprovação"
   do CLAUDE.md aparecendo dentro da própria ferramenta que existe para dar evidência.

⇒ Um audit **silencioso** e um audit **satisfeito** imprimem a mesma coisa. Toda leitura de saída
externa precisa de um invariante de forma (piso, contagem, marcador), não só do parse feliz.

### Falsificação (o dente do dente)

Nos **dois locales** (`C` e `pt_BR.UTF-8`, lição #1483 — asserções em ASCII, caixa fixa, sem `-i`):

| Sabotagem | Esperado | Obtido |
|---|---|---|
| parser volta a `'t'` (o bug original) | vermelho | 3 ok / **4 fail**, exit 1 |
| prefixo da linha trocado (mata o piso) | vermelho | exit 2 `medição inconsistente`, harness exit 1 |
| nenhuma | verde | **7 ok / 0 fail** nos dois locales |

O harness roda o **executável real** com `PSQL_RO` apontado para um PG17 descartável e a allowlist
injetada por `AUTHZ_GRANTS_TEST_JSON` — query, parser e exit code sob teste, nada reimplementado em
shell, e o contrato real do repo intocado. Cada asserção casa o código que **deve** aparecer **e o
que não pode**: só presença deixaria `NAO_APLICADA` e `DRIFT_PROD` indistinguíveis, e o operador
aplicaria a correção errada.

Prova de vida contra **prod** (read-only): invertendo o contrato só de `omie_products` num run de
teste, o audit acusa `authenticated tem SELECT` — o privilégio que de fato está lá.

### Dois desvios deliberados do plano, ambos por medição

- **Tabela entra QUALIFICADA** em `has_table_privilege` (a chave da allowlist, que já é
  `schema.name`). O plano remontava `'public.'||nome`: uma entrada futura fora de `public` mediria o
  objeto errado e ficaria verde.
- **`MAINTAIN` volta para a medição**, sob `CASE server_version_num >= 170000`. O plano o excluiu por
  "prod pode ser anterior ao 17"; prod é **17.6** (medido) e o `m` de `arwdDxtm` é justamente ele. O
  `CASE` mantém o audit são se um dia apontar para banco mais velho.
- Correção de bug no script do plano: sob `set -e`, `run_audit() { bun …; echo $?; }` **morre** no
  primeiro cenário que sai 1 — isto é, exatamente no que deveria acusar. Vai `|| ec=$?`.

### Estado de prod na entrega (`psql-ro`, 2026-08-13, re-medido)

Inalterado em relação às Tasks 1–3: `omie_products` fechada e **batendo com o contrato**;
`product_costs` aberta, #1520 ainda OPEN+DRAFT ⇒ 1 aviso `FECHO_PENDENTE`, exit 0.

### Ponto cego conhecido

`fechadaPor: null` faz o audit **não comparar** aquela tabela — logo ele não denuncia o caso
"prod fechada à mão, sem migration no repo". Não é falso-verde (a mensagem diz explicitamente que
prod não foi comparada), e o gate estático cobre o caso irmão via `ANCORA_NAO_DECLARADA` assim que
o `REVOKE` entra no repo. Fica registrado por ser um vetor plausível num projeto onde escrita de
banco é manual.

### Próximo passo

Candidata seguinte à allowlist: `sales_orders` (money-path, já fechada em prod). Cada entrada exige
curadoria própria — entrar em massa produziria uma allowlist que ninguém confia.

## 2026-08-13 — `sales_orders` entra: o fecho por COLUNA, e dois achados que a entrada destampou

A anotação acima (“já fechada em prod”) estava certa no rótulo e **errada no modelo** — e o modelo é
o que a ferramenta mede. Re-medido do zero (`psql-ro`, 22:36 UTC, pg 17.6), como manda a validade de
evidência de banco (`database.md` §2).

### O que prod diz

| | table-level (`relacl`) | por coluna (`attacl`) |
|---|---|---|
| `anon` | `ad` — INSERT+DELETE | nenhum |
| `authenticated` | `ad` — INSERT+DELETE | SELECT em 25 col · UPDATE em 11 col |

`has_table_privilege(authenticated,'public.sales_orders','SELECT')` é **FALSE** — e mesmo assim o
front lê a tabela inteira que lhe interessa. É o **terceiro modelo de fecho** da allowlist: não é
`REVOKE ALL`+`GRANT SELECT` (omie_products), nem “só RLS” (product_costs), e sim **REVOKE
table-level + GRANT de COLUNA**, em duas etapas:

1. `20260709163500` (PR0.0-bis) troca o SELECT table-level pelo SELECT de 25 colunas — deixando
   `omie_payload`/`omie_response` de fora, que é o ponto inteiro;
2. `20260724120000` (FU4, **a âncora**) troca o UPDATE table-level pelo UPDATE de 11 colunas e
   revoga TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.

A âncora é a **segunda**, não a primeira: é ela que estabelece o contrato que a entrada declara.
Antes dela `authenticated` ainda tinha UPDATE table-level. Mesmo modelo last-writer da Parte A.

⇒ **`permitido` é table-level, e declarar a partir da leitura efetiva inverteria a entrada.** O
reflexo (“o front lê, logo `authenticated: ['SELECT']`”) permitiria exatamente o vetor que a
migration proíbe por escrito — `NUNCA reemitir GRANT SELECT ON public.sales_orders TO authenticated`
— e proibiria o `INSERT`/`DELETE` que as policies exigem. A entrada correta é o inverso do reflexo:
`anon: []`, `authenticated: ['INSERT','DELETE']`. Está anotado no cabeçalho do arquivo, porque é a
armadilha que a próxima entrada por-coluna vai encontrar.

### Achado 1 — `RECRIACAO` disparava em FK (bug do gate, corrigido)

Com a entrada declarada, o `authz:check` ficou **vermelho em 2 migrations do ATP**
(`20260806101417`, `20260807015000`). Nenhuma recria coisa alguma: as duas criam tabela **nova**
(`estoque_reservas`, `atp_decisoes`) com `sales_order_id uuid REFERENCES public.sales_orders(id)`.
O detector perguntava “o statement MENCIONA a tabela?”, e FK menciona.

Ninguém tinha visto porque nenhuma migration pós-âncora cria tabela com FK para `product_costs` ou
`omie_products`. A entrada nova não causou o bug — **destampou**. Corrigido por TDD (casos 15/16 de
`scripts/authz-grants.test.ts`): passa a julgar o **ALVO** do `CREATE TABLE` (`alvoCreateTable`,
lida com `IF NOT EXISTS` e `"public"."x"`), com fallback para a menção quando a forma não parseia —
o mesmo fail-closed do `GRANT_NAO_PARSEAVEL`. O caso 16 existe para que o fix não vire afrouxamento.

⇒ **Gate calibrado com N entradas só está provado para os modelos dessas N.** A allowlist é curada
uma a uma não só porque o contrato exige medição, mas porque **cada entrada é um teste novo do
próprio gate** — e o custo de errar é o pior possível: o único jeito de calar um falso positivo é
tirar a tabela da vigilância, isto é, o gate pune quem o usa.

### Achado 2 — `anon` tem INSERT+DELETE em `sales_orders` (aberto, alarme de pé)

`bun run authz:grants:prod` sai **1** com `DRIFT_PROD`: `anon` tem `INSERT,DELETE` fora do permitido.
A divergência é real. A causa **não** é a que o código nomeia: nenhum grant foi aplicado à mão. É
**resíduo do default `arwdDxtm` do Supabase que nenhum REVOKE alcançou** — os REVOKEs de `anon`
cobriram SELECT (jul/09) e UPDATE+higiene (jul/24) e nunca miraram INSERT/DELETE.

Inócuo **hoje**: as 5 policies de `sales_orders` são `TO authenticated`, então `anon` casa 0 linhas.
Mas é o mesmo hazard F1 que motivou o `REVOKE SELECT ... FROM anon` naquela migration — uma policy
`anon` futura converte a sobra em escrita real, numa tabela money-path. Fecha com um
`REVOKE INSERT, DELETE ON public.sales_orders FROM anon;`. **Não foi silenciado na allowlist**: o
contrato declara `anon: []` e o alarme fica de pé até o REVOKE ser colado no SQL Editor.

**Limitação conhecida:** nenhum dos dois códigos descreve esta causa. `NAO_APLICADA` exige
INSERT+UPDATE+DELETE (o DML completo) e afirmaria que a migration não foi aplicada — falso, ela foi.
`DRIFT_PROD` manda “descobrir quem concedeu” — não houve quem. A **ação corretiva é a mesma**
(revogar), então o audit não engana sobre o que fazer, só sobre a história. Um terceiro código
(`RESIDUO_DEFAULT`: sobra que nenhum REVOKE mirou) resolveria; não foi feito aqui para não redesenhar
o vocabulário com uma amostra de um caso.

### Prova

| Comando | Exit | O que diz |
|---|---|---|
| `bun run authz:check` | **0** | Partes A+B+C verdes, 0 erros, 2 avisos (os `FECHO_PENDENTE` de `product_costs`) |
| `bunx vitest run scripts/authz-grants.test.ts` | **0** | 26 casos (24 + os 2 novos); RED do 15 visto antes do fix |
| `bun run authz:grants:prod` | **1** | `DRIFT_PROD` do `anon` — acusando com razão (achado 2) |
| `bun run test` (suíte inteira) | **0** | 663 arquivos / 6.133 testes — o fix do `RECRIACAO` não regrediu nada |
| `tsc --noEmit --strict` ad-hoc nos 3 arquivos | **0** | `scripts/` e `db/` não têm gate de tipo próprio (`tsconfig.app.json` só inclui `src`) |

Falsificação da entrada nova contra a allowlist **real** (8 cenários, migrations sintéticas injetadas
na função pura — sem tocar `supabase/migrations/`): `GRANT SELECT` table-level → `REABERTURA`;
`GRANT UPDATE` table-level → `REABERTURA`; `GRANT SELECT` a `anon` → `REABERTURA`; `DROP`+`CREATE` →
`RECRIACAO`; `DISABLE RLS` → `RLS_OFF`. E os três controles em silêncio: FK, `GRANT INSERT` a
`authenticated` (dentro do permitido) e `GRANT ALL` a `service_role`. **8 ok / 0 fail** — a entrada
está viva, não apenas silenciosa.

### O privilégio de COLUNA: o gate estático cobre, o audit de prod não (medido, não deduzido)

O vetor que importa nesta tabela é `GRANT SELECT (omie_payload) ON public.sales_orders TO
authenticated` — reabre exatamente o vazamento que o PR0.0-bis fechou. Medido contra a allowlist
real, o **gate estático pega os dois formatos**, por caminhos diferentes:

| Statement pós-âncora | Código |
|---|---|
| `GRANT SELECT (omie_payload) ON … TO authenticated` | `REABERTURA` — `parsePrivList` descarta a lista de colunas e lê `SELECT`, que não está no permitido |
| `GRANT SELECT (omie_payload, omie_response) ON … TO authenticated` | `GRANT_NAO_PARSEAVEL` — a vírgula interna quebra o split; fail-closed segura |

⚠️ **Essa cobertura é consequência direta de `permitido` NÃO conter `SELECT`.** Tivesse a entrada
seguido o reflexo (`authenticated: ['SELECT']`, “o front lê”), a primeira linha da tabela viraria
silêncio e o vetor principal da tabela passaria batido. A decisão de curadoria e a cobertura do gate
são a mesma decisão.

O **ponto cego real** é o audit de prod: ele mede `has_table_privilege`, que ignora `attacl`. Um
`GRANT SELECT (omie_payload)` colado à mão no SQL Editor não aparece — e é justamente o que o audit
de banco existe para pegar, já que o estático não vê o SQL Editor. Medir
`attacl`/`has_column_privilege` é o próximo incremento natural da sentinela, e agora tem um caso
real que o justifica.

**Nenhum gate type-checa `scripts/` nem `db/`:** `tsconfig.app.json` inclui só `src`, e o `knip` só
olha `src` + `supabase/functions`. `bun run typecheck` verde é **evidência vazia** para o código
destes dois diretórios — quem os cobre hoje é o vitest (runtime) e os harnesses. Verificado aqui com
um `tsc` ad-hoc (0 erros nos 4 arquivos da entrega; 19 pré-existentes em `scripts/`, quase todos
`import.meta.main` sem `bun-types`).
