# Sentinela de grants — tabelas fechadas por privilégio

> Diário desta frente. Desenho: `docs/superpowers/specs/2026-07-22-sentinela-grants-tabelas-fechadas-design.md`.
> Plano (7 tasks, 3 entregues): `docs/superpowers/plans/2026-07-22-sentinela-grants-tabelas-fechadas.md`.

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

### Pendente (Tasks 4–7)

Audit de **prod** (`db/audit-grants-tabelas-fechadas.ts` sob `psql-ro`) + harness PG17. O estático
pega a migration nova dentro do PR mas é cego a drift aplicado à mão; o de prod vê a verdade do
banco mas não bloqueia ninguém. **Nenhum dos dois sozinho fecha o buraco.** O audit de prod também
detectaria de graça a armadilha-mãe do projeto: âncora no repo + prod ainda aberta = migration
mergeada e nunca aplicada no SQL Editor (código `NAO_APLICADA`).

Candidata seguinte à allowlist: `sales_orders` (money-path, já fechada em prod). Cada entrada exige
curadoria própria — entrar em massa produziria uma allowlist que ninguém confia.
