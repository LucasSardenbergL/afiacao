# Audit de migrations — o vermelho que sobrou era do EXTRATOR, não do banco

> **A classe (2026-08-21):** um detector que classifica por *o objeto existe em prod?* herda todos os
> pontos cegos do **extrator** que decidiu quais objetos esperar. Quando o extrator é regex sobre o
> `.sql`, três coisas viram vermelho permanente sem que nada falte no banco: **DDL gerada por
> `format()`** (a regex captura o placeholder `%I` como se fosse nome de objeto — objeto que nunca
> vai existir), **objeto que migration posterior MOVEU de schema** (o esperado ficou preso no schema
> do arquivo antigo), e **objeto superseded** (o audit não modela remoção). E uma quarta coisa vira
> verde permanente: sintaxe que a regex não casa **some do inventário** — nem vermelha, nem verde,
> ausente.
>
> A regra: **antes de tratar um ❌ do audit como dívida de banco, pergunte se o objeto esperado é
> derivável por regex.** `CREATE POLICY "Nome Com Espaços"`, `EXECUTE format('CREATE …')` e
> `REVOKE`/`GRANT` **não são** — e são justamente as formas do money-path de segurança.

Origem: ao aplicar o chip do fence de `farmer_association_rules` (#1840), o fence estava aplicado em
prod e o audit não sabia. A investigação do "por quê" apontou para 202 linhas `❌ MISSING` — número
que, medido hoje, **não existe mais** (ver §"Reconciliação").

## Como foi medido

Prod, **2026-08-21 23:34–23:40 UTC**, via `~/.config/afiacao/psql-ro` (read-only, `claude_ro`).
As duas seções de `scripts/audit-custom-migrations.sql` foram separadas e rodadas inteiras:

```bash
sed -n '1,/SECTION 2/p' scripts/audit-custom-migrations.sql > s1.sql
sed -n '/SECTION 2/,$p'  scripts/audit-custom-migrations.sql > s2.sql
~/.config/afiacao/psql-ro --csv -f s1.sql > s1.csv 2> s1.err; e1=$?   # exit=0, stderr vazio
~/.config/afiacao/psql-ro --csv -f s2.sql > s2.csv 2> s2.err; e2=$?   # exit=0, stderr vazio
```

Exit code capturado **colado** (`> log 2>&1; e=$?`), não por `| tail` — que o engoliria.
Section 1 devolveu 479 linhas de dado; Section 2, 1.605.

## Reconciliação — os números da premissa estavam STALE

O diagnóstico de partida descrevia o audit **anterior ao #1105**, que era binário ✅/❌. O script
em `main` hoje já reconcilia em **5 estados** (`#1105`, `refactor(audit): Seção 1 reconcilia
registro × existência em 5 estados`). Medido × premissa:

| | premissa | medido em 2026-08-21 |
|---|---|---|
| arquivos em `supabase/migrations/` | 394 | **657** |
| nome UUID (auto-aplicam) | 178 | **178** ✔ |
| nome custom (apply manual) | 216 | **479** |
| rows em `supabase_migrations.schema_migrations` | 224 | **224** ✔ |
| custom com version registrada | 14 | **52** |
| custom marcadas ❌ | 202 | **1** |

Distribuição real dos 479 custom (Section 1):

| estado | n | leitura |
|---|---|---|
| 🟡 aplicado (sem registro) | **363** | NORMAL — o Lovable não registra nome custom. Não é dívida. |
| ⚪ sem objeto rastreável | **55** | o audit não consegue opinar (ver §Ponto cego) |
| ✅ registrado | **52** | tem row em `schema_migrations` |
| ⚠️ PARCIAL (n/m) | **8** | acionável em tese |
| ❌ NÃO aplicado | **1** | acionável em tese |

**Não há 202 falsos-vermelhos.** O alarme saturado foi consertado no #1105; o que sobrou são 9
linhas — e nenhuma delas é apply pendente.

## A lista curta — e por que ela é ZERO

As 9 acionáveis, com o objeto que falta e o veredito checado objeto-a-objeto em prod:

| version | slug | falta | veredito |
|---|---|---|---|
| `20260720160000` | `authz_cap_compras_ler_alertas_auto_aprovacao_fu4h` | `rls_policy public.%I` | **fantasma** — `EXECUTE format('CREATE POLICY %I ON public.%I', …)` |
| `20260704160000` | `fin_dividas` | `%I_select_master`, `%I_write_master` | **fantasma** — mesmo `format()` |
| `20260524120000` | `carteira_omie_fase1` | `function public.carteira_visivel_para` | **moveu de schema** → existe como `private.carteira_visivel_para(uuid,uuid)` (`20260718150000_fu7_helpers_rls_schema_privado`) |
| `20260717181500` | `carteira_visivel_para_filtra_eligible` | idem | idem |
| `20260614180000` | `markup_policy` | `uq_markup_policy_{conta,fam,sku}`, `markup_policy_select_staff` | **obsoleto** — modelo conta/fam/sku virou escopo/tier (`20260704120000_preco_por_tier`); prod tem `markup_policy_escopo_tier_uq` + `markup_policy_select_carteira`/`_write_master` |
| `20260616120000` | `regua_preco` | `regua_preco_log_staff_all` | **obsoleto** — substituída por `regua_preco_log_select_custo` (`20260723150000_authz_custo_fu4f_fase2_regua`) |
| `20260623140000` | `recencia_mv_order_date_kpi` | `idx_customer_metrics_mv_uid` | **obsoleto** — `customer_metrics_mv` hoje é `relkind='v'` (view-gate, `20260629120000`/`20260717120000`); índice é impossível por construção |
| `20260708202033` | `selfservice_pr01_allowlist_gate` | `ss_allowlist_gestor_iud` | **obsoleto** — policy IUD única foi partida em insert/update/delete (`20260718190000_authz_capability_matrix_e2`) |
| `20260712150000` | `carteira_membership_ledger_fatia0` | `trg_omie_clientes_to_ledger` | **obsoleto** — a tabela `omie_clientes` **não existe mais** (quarentena concluída) |

⇒ **Zero migrations custom faltam aplicar em produção.** 2 são fantasma do extrator, 5 são
obsoletas, 2 são mudança de schema. As 14 linhas ❌ da Section 2 se resolvem todas em falso-vermelho.

### Backfill: NÃO

Nenhum `INSERT` em `schema_migrations` é proposto aqui. As 363 🟡 são o estado **normal** deste repo
(o SQL Editor do Lovable não escreve em `schema_migrations`), não dívida — registrar em massa trocaria
202 falsos-vermelhos por 363 falsos-VERDES e destruiria o detector. O verde que interessa é o
**objeto-a-objeto**, e ele já está lá.

## Mapeamento slug↔version: **0 slugs não mapeados**

O medo de junção silenciosa não se materializa, e vale registrar por quê: `scripts/audit-custom-migrations.ts`
deriva **os dois** identificadores do MESMO parse de nome de arquivo (`TIMESTAMP_PATTERN =
/^(\d{14})_(.+)\.sql$/`), emite `expected (version, slug, filename)` e faz o join dentro do próprio
SQL (`LEFT JOIN obj_status os ON os.migration = e.slug`). Medido no arquivo gerado:

- 479 rows em `expected` — **slugs únicos, 0 duplicados** (duplicata faria fan-out silencioso: o
  status de uma migration mascarando outra);
- **0 slugs órfãos** em `expected_objects` (todo slug com objeto tem sua version);
- 64 migrations sem NENHUM objeto extraído — é a classe cega abaixo, não falha de mapeamento.

## O ponto cego — veredito

**Hipótese (a) — "o `bun run audit:migrations` não foi re-rodado" — FALSIFICADA.** O commit
`55dea3f71` (#1840), que entregou a migration, tocou `scripts/audit-custom-migrations.sql` e
`docs/migrations-audit.md` no mesmo diff. A migration **está** no inventário (Section 1, linha 523).

**Hipótese (b) — CONFIRMADA, e maior do que parecia.** `20260820225840_farmer_assoc_rules_escritor_unico`
gera **0 objetos esperados**. Quatro causas somadas, cada uma uma classe:

1. **A regex de policy quebra em nome citado com espaço.** O extrator usa
   `/CREATE\s+POLICY\s+"?([^\s"]+)"?\s+ON\s+…/gi` — a classe `[^\s"]+` para no primeiro espaço,
   então `CREATE POLICY "Staff can read association rules"` **não casa nada** (não é problema de
   multi-linha: `\s` cobre `\n`; é o espaço DENTRO do identificador citado). Medido rodando a regex
   viva sobre os 479 arquivos custom: **450 `CREATE POLICY` no corpus, 400 casados, 50 perdidos
   (11,1%), em 20 arquivos.** Policy perdida não vira vermelho — some do inventário.
2. **`REVOKE`/`GRANT` não têm objeto.** O `REVOKE EXECUTE … FROM authenticated` desta migration é o
   efeito de segurança principal e não é verificável por existência de nada.
3. **`format()` vira fantasma.** Onde a policy É extraída de um `EXECUTE format(…)`, o que entra no
   inventário é o literal `%I` — vermelho eterno (as 2 migrations fantasma acima).
4. **`✅ registrado` curto-circuita a verificação de objeto.** O `CASE` da Section 1 testa
   `schema_migrations` **primeiro**; migration registrada nunca é conferida objeto-a-objeto. Foi o
   que aconteceu aqui: alguém registrou a version `20260820225840` (é a mais nova das 224) e a
   migration ficou **✅ registrado** — verde por REGISTRO, com zero objeto conferido.

**Tamanho da classe cega: 64 das 479 (13,4%)** — 55 ⚪ + 9 ✅-registrado-sem-objeto. Para essas, o
audit não tem opinião: nem a Section 1 nem a Section 2 conseguem afirmar nada sobre prod.

### E mesmo consertando a regex, ESTA migration continuaria mal verificada

Vale separar: consertar a regex faria a policy entrar no inventário, mas a verificação seria por
**nome**, e o nome `"Staff can read association rules"` **já existia antes** da migration (ela faz
`DROP POLICY` + `CREATE POLICY` do mesmo nome). É exatamente a armadilha já documentada em
`docs/agent/database.md` §2 ("migration que ENDURECE objeto já existente é invisível para verificação
por EXISTÊNCIA"). O sinal real desta migration é uma **remoção** (`"Staff can manage association
rules"`, a policy `ALL`, deixou de existir) e um **ACL** (`REVOKE EXECUTE`) — nenhum dos dois é
modelado. ⇒ **Fence de permissão não se prova por existência; prova-se por `pg_policies.cmd`/`qual` e
por `proacl`.** Foi o `/fecho` (que confere o OBJETO com query própria) que pegou o fence, não o audit
— e isso não é acidente, é a consequência do desenho.

## Resíduo acionável (NÃO feito aqui)

- Corrigir a regex de policy em `scripts/lib/migration-objects.ts` para aceitar identificador citado
  com espaço (`"([^"]+)"|(\w+)`) — **não há teste** para esse arquivo hoje (`scripts/lib/__tests__/`
  não existe), então o conserto pede teste antes, com os 20 arquivos perdidos como corpus.
- Regenerar o audit depois disso é o de sempre: ímã de conflito sob auto-merge (§2), então em PR
  próprio e curto.
