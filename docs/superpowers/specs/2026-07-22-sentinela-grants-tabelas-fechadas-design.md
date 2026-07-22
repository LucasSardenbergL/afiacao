# Sentinela de grants — tabelas deliberadamente fechadas

> Achado do review final da branch `authz-preco-fecha-omie-products` (2026-07-22), fora do escopo daquela entrega.
> Status: desenho aprovado, aguardando plano de implementação.

## 1. O problema

Duas entregas de autorização money-path fecham tabelas **por PRIVILÉGIO**, não por policy:

| Tabela | Fechada por | Estado |
|---|---|---|
| `public.product_costs` | PR #1520 (FU4-F fase 3) | draft |
| `public.omie_products` | branch `authz-preco-fecha-omie-products` | draft |

O desenho das duas é idêntico:

```sql
REVOKE ALL ON TABLE public.<t> FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.<t> TO authenticated;   -- a RLS é que decide QUEM lê
-- policy só de SELECT; escrita exclusiva de service_role (sem policy de escrita)
```

Como o fecho é por privilégio, um `GRANT` futuro reabre o buraco **em silêncio**. Os vetores:
uma migration nova, o sync de schema da plataforma Lovable/Supabase, ou o default privilege do
Supabase agindo sobre objeto recriado.

### 1.1 Medido no review (2026-07-22)

- O CI **não** roda nenhum `db/test-*.sh` — os harnesses PG17 são manuais.
- `scripts/authz-manifest.ts` + `scripts/authz-gate-check.ts` (o gate `authz:check`, step do CI em
  `ci.yml:208`) cobrem **apenas gate em corpo de função `SECURITY DEFINER`**. A estrutura
  `AuthzEntry { sensitive, requiredGate, motivo }` não comporta invariante de grant de tabela.
  Nenhuma das duas tabelas é mencionada lá.
- Nenhum teste vitest ou Deno tem baseline dos grants dessas tabelas.

### 1.2 Medido em prod via `psql-ro` (2026-07-22) — muda a premissa

As duas tabelas estão **totalmente abertas em produção**:

```
product_costs  → anon=arwdDxtm  authenticated=arwdDxtm  rls=true
omie_products  → anon=arwdDxtm  authenticated=arwdDxtm  rls=true
```

Os dois fechos existem só como migration em PR draft — **nunca aplicados no SQL Editor**. Hoje não
há regressão a vigiar; há um fecho *pendente*. Isso não invalida a sentinela: define o comportamento
correto dela no dia 1 (ver §5.1 e §8) — ela nasce **sabendo** que as duas ainda não fecharam, em vez
de nascer verde por acidente e virar carimbo.

Varredura complementar: **29 das 323** tabelas do `public` já têm algum fecho em prod
(`sales_orders`, `regua_preco_log`, `cmc_snapshot`, os `pcp_*`, …). O universo de candidatas existe,
mas cada uma exige curadoria própria do contrato — ver §9.

## 2. Escopo

**É:** uma allowlist **curada** de tabelas deliberadamente fechadas, e duas guardas que vigiam
**só essas**.

**NÃO é** uma varredura em massa. `docs/agent/database.md` §7 é explícito: o grant DML amplo do
Supabase (`arwdDxtm` a anon/authenticated em toda relação nova) é **o modelo da plataforma** e
inócuo por si só — protegido por RLS + `security_invoker`. Revogar em massa quebraria telas anon
legítimas e brigaria com o Supabase. A guarda tem de distinguir:

- **tabela protegida reaberta** → regressão, erro;
- **tabela nova nascendo aberta** → normal, silêncio.

A allowlist é exatamente essa distinção, materializada.

## 3. Arquitetura

Quatro peças, uma fonte de verdade:

| Peça | Arquivo | Papel |
|---|---|---|
| Allowlist curada | `scripts/authz-tabelas-fechadas.ts` | Fonte única, consumida pelo CI **e** pelo audit de prod |
| Lógica pura | `scripts/lib/authz-grants.ts` | `auditGrantsTabelas(migrations, allowlist) → Finding[]`, sem I/O |
| Gate de CI | Parte C em `scripts/authz-gate-check.ts` | Reusa o step `authz:check` existente |
| Audit de prod | `db/audit-grants-tabelas-fechadas.ts` | Sob `psql-ro`, on-demand, exit 0/1/2 |

**Por que arquivo separado + mesmo comando:** `AuthzEntry` é sobre gate no *corpo de função*;
invariante de grant de *tabela* é outro tipo de objeto — juntá-los exigiria union type e faria o
`authz-manifest.ts` significar duas coisas (o cabeçalho dele declara seu escopo como "RPCs
SECURITY DEFINER sensíveis"). Mas o **comando** continua um só: `bun run authz:check` já é step do
CI, e a Parte C entra nele sem superfície nova em `ci.yml`.

**Por que o audit de prod é `bun` e não `bash`** (o precedente `db/audit-anon-dml-bypass.sh` é
bash+sql): a allowlist é TypeScript. Um audit em bash teria de duplicar a lista ou fazer ginástica
`bun -e` para extraí-la — duas cópias divergem. Em `bun` ele **importa** a mesma allowlist e invoca
o `psql-ro` como subprocesso. Aceita `PSQL_RO` por env var (como o precedente faz), o que também
permite ao teste PG17 apontá-lo para o banco local.

### 3.1 Reuso

`scripts/lib/authz-contract.ts` já resolve dois problemas do parser, e a Parte C **reusa** em vez de
reimplementar:

- `stripNoise(sql)` — remove comentários. Sem isso, um `GRANT` **dentro de comentário** dispararia
  falso positivo (e as duas migrations de fecho comentam grants no cabeçalho — o falso positivo
  seria imediato).
- o padrão `IDENT` — trata identificador quoted (`"minha tabela"`) além de `\w+`.

## 4. Contrato da allowlist

```ts
type Priv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
          | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN';   // MAINTAIN: PG17

export interface TabelaFechada {
  /** migration que FECHOU a tabela (âncora). null = fecho declarado PENDENTE. */
  fechadaPor: string | null;
  /** privilégios PERMITIDOS por role. Ausente da lista = proibido. */
  permitido: { anon: Priv[]; authenticated: Priv[] };
  motivo: string;
}
```

**Allowlist de privilégio, não denylist.** Listar o *permitido* é o que torna isto fail-closed: um
privilégio novo ou esquecido (o `MAINTAIN` do PG17, por exemplo) nasce barrado, em vez de escapar
por omissão da denylist.

**`service_role` fica fora de vigilância, por desenho.** É o writer — as edges de sync
(`sync-reprocess`, `omie-analytics-sync`, `tint-omie-sync`, …) rodam com `SERVICE_ROLE_KEY`, e as
duas migrations de fecho já asseguram no assert A7 que ele não foi atingido. Vigiar `service_role`
aqui só produziria ruído. Declarado explicitamente para não parecer omissão.

## 5. Gate estático (Parte C)

**A guarda ancora no fecho** em vez de tentar modelar o estado absoluto de privilégio. Migrations
registram só o *delta*; o estado inicial vem do default privilege do Supabase e do baseline
parqueado, que não estão nas migrations. Simular o absoluto seria fabricar uma verdade que o repo
não tem. A âncora contorna isso: só interessa o que aconteceu **depois** do fecho.

Migrations ordenadas por **nome de arquivo** (mesmo modelo last-writer da Parte A) — o timestamp do
nome é a ordem canônica de aplicação no projeto. "Pós-âncora" = nome lexicograficamente maior que o
da âncora. Para cada entrada:

| Situação | Código | Nível |
|---|---|---|
| `fechadaPor: null` **e** nenhum `REVOKE` da tabela no repo | `FECHO_PENDENTE` | **warn** |
| `fechadaPor: null` **mas** existe `REVOKE` da tabela no repo | `ANCORA_NAO_DECLARADA` | **erro** |
| âncora aponta para arquivo inexistente | `ANCORA_AUSENTE` | **erro** |
| pós-âncora: `GRANT` fora do permitido a anon/authenticated | `REABERTURA` | **erro** |
| pós-âncora: `CREATE TABLE` da tabela | `RECRIACAO` | **erro** |
| pós-âncora: `DISABLE ROW LEVEL SECURITY` | `RLS_OFF` | **erro** |
| pós-âncora: `GRANT` menciona a tabela mas não parseia | `GRANT_NAO_PARSEAVEL` | **erro** |

`RECRIACAO` fecha o vetor mais traiçoeiro: `DROP TABLE` + `CREATE TABLE` faz a tabela **renascer com
o default privilege aberto** sem que nenhum `GRANT` explícito apareça no diff. Um gate que só
procurasse `GRANT` passaria batido.

`GRANT_NAO_PARSEAVEL` é fail-closed, no mesmo espírito da Parte A: se o parser não entende um
statement que menciona a tabela protegida, ele **não** pode afirmar que está tudo bem.

### 5.1 Por que `FECHO_PENDENTE` é warn e não erro

É o estado real das duas entradas hoje (§1.2). Como erro, o CI da `main` ficaria **vermelho** até os
dois PRs draft mergearem — e o PR desta sentinela não conseguiria mergear sozinho.

O que **não** se aceita é que "pendente" seja simples *ausência de dado*. `fechadaPor: null` é uma
**declaração consciente**, e é isso que evita a degradação silenciosa: se alguém reverter o fecho, o
campo passa a apontar para um arquivo que não existe → `ANCORA_AUSENTE` → **erro**. O gate não cai
de erro para warn sem alguém editar a allowlist deliberadamente.

### 5.2 `ANCORA_NAO_DECLARADA` — a sentinela vigiando a si mesma

O warn de §5.1 abre um buraco que **reproduz dentro da sentinela o modo de falha que ela existe para
prevenir**: quando o PR do fecho mergear, alguém precisa editar `fechadaPor: null` → nome do
arquivo. Se ninguém editar, a entrada fica em warn **para sempre** — tabela fechada em prod, gate
inerte, e o único sinal é um aviso que já era esperado no dia anterior. Silêncio indistinguível de
tudo-em-ordem, exatamente a assinatura do problema original.

A correção é não depender de ninguém lembrar: o gate **detecta o fecho sozinho**. Se `fechadaPor` é
`null` mas existe no repo uma migration com `REVOKE ... ON <tabela> ... FROM ... authenticated`, a
allowlist está mentindo sobre o estado do repo → **erro**, nomeando o arquivo que fechou e pedindo a
declaração. A transição pendente → vigiado deixa de ser um ato de disciplina e passa a ser exigida
pelo CI, no PR em que o fecho entra.

Isto aplica o princípio do CLAUDE.md — *ausência de sinal não é aprovação* — à própria estrutura do
dado, em vez de confiar na disciplina de quem mantém.

## 6. Audit de prod

Lê a mesma allowlist, consulta `has_table_privilege` no banco real via `psql-ro`, compara com o
`permitido`. Exit `0` limpo · `1` divergência · `2` erro de execução (molde do
`audit-anon-dml-bypass.sh`).

**Efeito colateral valioso:** ele cruza a âncora *no repo* com o estado *aplicado*. Âncora
preenchida + prod ainda aberta = **migration mergeada e nunca aplicada no SQL Editor** — a
armadilha-mãe do projeto (`docs/agent/database.md` §2), detectada de graça e sem trabalho extra.
Achado próprio, com código `NAO_APLICADA`.

Complementaridade declarada: o estático pega a migration nova **dentro do PR**, mas é cego a drift
aplicado à mão; o de prod vê a verdade do banco, mas não bloqueia ninguém. Nenhum dos dois sozinho
fecha o buraco.

## 7. Prova de dente

Uma guarda que sempre diz "limpo" por um bug é **pior que nada** — é falsa segurança. Duas camadas:

**a) vitest — `scripts/authz-grants.test.ts`** (núcleo puro, roda no CI: `vitest.config.ts` já
inclui `scripts/**/*.test.ts`). Dez cenários — quatro deles casos que **devem passar batido**, porque
um gate que grita demais é abandonado tão rápido quanto um que nunca grita:

| # | Cenário | Esperado |
|---|---|---|
| 1 | `GRANT INSERT` a authenticated pós-âncora | `REABERTURA` |
| 2 | `GRANT INSERT` idêntico **antes** da âncora | silêncio (o fecho veio depois e venceu) |
| 3 | `GRANT ALL` a `service_role` pós-âncora | silêncio (é o writer) |
| 4 | `GRANT SELECT` a authenticated pós-âncora | silêncio (dentro do permitido) |
| 5 | `CREATE TABLE` da tabela pós-âncora | `RECRIACAO` |
| 6 | `DISABLE ROW LEVEL SECURITY` pós-âncora | `RLS_OFF` |
| 7 | âncora inexistente | `ANCORA_AUSENTE` |
| 8 | `fechadaPor: null`, sem `REVOKE` no repo | `FECHO_PENDENTE`, nível warn |
| 9 | `GRANT` da tabela **dentro de comentário** | silêncio (`stripNoise`) |
| 10 | `fechadaPor: null` **mas** `REVOKE ... FROM authenticated` no repo | `ANCORA_NAO_DECLARADA` (§5.2) |

**b) PG17 — `db/test-audit-grants-tabelas-fechadas.sh`**, no molde do
`db/test-audit-anon-dml-bypass.sh`: cria a tabela conforme o contrato → audit limpo; concede
`INSERT` a authenticated → audit acusa; **falsifica** — revoga → a acusação some.

### 7.1 Código ASCII estável, e por quê

Cada achado carrega um **código ASCII em caixa fixa** (`REABERTURA`, `ANCORA_AUSENTE`,
`ANCORA_NAO_DECLARADA`, `RECRIACAO`, `RLS_OFF`, `FECHO_PENDENTE`, `GRANT_NAO_PARSEAVEL`,
`NAO_APLICADA`). Os testes casam o **código**, nunca a mensagem em português.

Isto vem direto do #1483: uma falsificação passou **verde** no shell do founder e **vermelha** no de
quem a escreveu, porque casava string acentuada com `grep -qi` — sob `pt_BR.UTF-8` o `grep` (que
aqui é shim para `ugrep`) dobra `Ã`↔`ã`, e sob `LC_ALL=C` não. A asserção falsificava por acidente
de ambiente, não por desenho.

Casar código ASCII em caixa fixa, sem `-i`, **mata a classe inteira por construção** — em vez de
depender de eu lembrar de rodar a falsificação nos dois locales toda vez. A regra do
`money-path.md` (rodar em `C` **e** `pt_BR.UTF-8`) continua valendo para o harness bash; a diferença
é que aqui ela deixa de ser o único anteparo.

## 8. Estado inicial

As duas entradas nascem com `fechadaPor: null` — a verdade medida em §1.2 — e o `motivo` registra o
PR que vai fechar.

O campo passa a apontar o arquivo da migration **quando o PR do fecho mergeia** — não quando o
founder aplica no SQL Editor. São eventos distintos e a distinção importa: a âncora é um fato do
*repo* (é o que o gate estático varre), enquanto o apply é um fato do *banco* (é o que o audit de
prod mede). Amarrar a âncora ao apply deixaria o gate estático cego durante toda a janela entre
merge e apply — que neste projeto dura dias e é exatamente onde a migration esquecida vive.

Ordem de eventos e o que cada guarda diz:

| Momento | `fechadaPor` | Gate estático | Audit de prod |
|---|---|---|---|
| hoje (PRs draft) | `null` | `FECHO_PENDENTE` (warn) | `FECHO_PENDENTE` |
| PR do fecho mergeia, allowlist **não** atualizada | `null` | `ANCORA_NAO_DECLARADA` (**erro**) | `NAO_APLICADA` (exit 1) |
| allowlist atualizada, migration **não** aplicada | arquivo | vigia reaberturas pós-âncora | `NAO_APLICADA` (exit 1) |
| aplicada em prod | arquivo | vigia reaberturas pós-âncora | limpo (exit 0) |

A segunda linha é o passo que §5.2 torna impossível de pular em silêncio: o CI do próprio PR do
fecho fica vermelho até a allowlist declarar a âncora.

## 9. Fora de escopo

- **As outras 27 tabelas fechadas em prod.** Cada uma precisa de curadoria própria: qual é o
  contrato de grant esperado, quem é o writer, o fecho foi deliberado ou acidental. Entrar em massa
  sem essa curadoria produziria uma allowlist que ninguém confia — o oposto do objetivo.
  `sales_orders` (`auth_sel=false`, money-path) é a candidata seguinte mais forte.
- **Revogar qualquer coisa.** Esta entrega não muda um privilégio sequer; só vigia.
- **Rodar `db/test-*.sh` no CI.** Continua manual (§1.1). Mudar isso é outra decisão.

## 10. Decisões registradas

| Decisão | Alternativa descartada | Razão |
|---|---|---|
| Allowlist em arquivo separado | Estender `authz-manifest.ts` | Tipos não relacionados; o manifest declara escopo "RPCs SECDEF" |
| Mesmo comando `authz:check` | Comando + step novo no CI | Zero superfície nova em `ci.yml` |
| Allowlist de privilégio | Denylist | Fail-closed: privilégio novo nasce barrado |
| Âncora (pós-fecho) | Modelar estado absoluto de grants | Migrations só têm o delta; o absoluto não está no repo |
| `FECHO_PENDENTE` = warn | Erro desde o dia 1 | CI da `main` vermelho até dois PRs draft mergearem |
| Gate detecta o `REVOKE` sozinho | Confiar que alguém atualize `fechadaPor` | Warn eterno = gate inerte sobre tabela fechada (§5.2) |
| Audit de prod em `bun` | `bash` (precedente) | Fonte única: importa a allowlist em vez de duplicá-la |
| Código ASCII no achado | Casar mensagem pt-BR | Lição #1483: matching acentuado falsifica por acidente de locale |
