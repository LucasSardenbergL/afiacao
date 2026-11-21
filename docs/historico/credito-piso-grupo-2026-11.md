# Trava de crédito vê o grupo inteiro + fail-closed (crédito-IA, PR 1 — 2026-11-20)

Programa: `docs/superpowers/specs/2026-11-20-credito-ia-design.md` · plano `docs/superpowers/plans/2026-11-20-credito-ia.md`.

## O furo (medido em prod, psql-ro, 2026-11-20)

`venda_gate_credito` olhava só o PAR do pedido `(company, omie_codigo_cliente)`. Cliente com vencido
> 60 d na Colacor SC comprava na Oben sem trava. Em 90 dias: **93 pedidos, 26 clientes, R$ 143.507**
enviados/faturados numa conta do grupo para cliente com vencido > 60 d em OUTRA (só vínculo direto
user↔código; aliases fiscais podem somar mais). 125 clientes mapeados com vencido > 60 d.

## O que mudou

| Camada | Antes | Depois |
|---|---|---|
| SQL | `venda_gate_credito(company, codigo, pedido)` | `venda_gate_credito_grupo(pedido, company, codigo)` + `credito_grupo_pares(user)`: a RAIZ é o dono do par comprovado no mapa (nunca o UUID do pedido — pode ser o do vendedor); canônico + aliases `active`; `inactive`/`conflict` não expandem; devolve `pares[]` |
| Edge, gate mudo | liberava com log `gate_indisponivel` | **segura**: erro retentável "Verificação de crédito indisponível — tente de novo em instantes." (erro, não `blocked` novo: bundle antigo trata erro como falha) |
| Edge, edição | gate só se o total sobe; sem `codigo_cliente` liberava com log | também se a **parcela muda** (`edicaoExigeGate`); sem `codigo_cliente` no consult → **segura** |
| Ingestão CR | `valor_documento \|\| 0` | só número/string decimal; sem valor legível → não grava (log); modo estrito lança |
| Tela | "R$ X vencido" | "vencido no grupo: Colacor SC R$ 500,00 · Oben R$ 150,00" |

Exceção continua por (pedido, par do pedido) e libera a dívida do grupo que o gestor vê no painel
(lista os pares — também no fluxo remoto, lidos do `detalhe` do log). Exceção criada ANTES do marco
`credito_virada_grupo.aplicada_em` (gravado quando a migration é aplicada) foi aprovada vendo só o par
→ **não** cobre dívida de outra empresa (`motivo='excecao_anterior_nao_cobre_grupo'`).
A v1 `venda_gate_credito` fica no banco.

Titularidade dos aliases (psql-ro 2026-11-20): 1.633/1.633 `active` têm o MESMO documento do profile
do canônico; nenhum alias tem par próprio no mapa nem título fora dele → a expansão por alias não
transfere dívida entre titulares hoje.

## Risco residual aceito (review Codex P2)

Sync de CR **não estrito** com título sem valor: o título é pulado só com `console.warn` — um título
novo fica invisível e um existente mantém o saldo antigo até o próximo retrato estrito. Hoje há **0**
títulos assim em prod; se aparecer, persistir pendência e condicionar `full_ok` (não feito aqui).

## Ordem de deploy (OBRIGATÓRIA)

1. **Migration `20261121120000_trava_credito_piso_grupo.sql`** — SEM ela a edge nova falha fechado
   e **segura toda venda**.
2. Edges `omie-vendas-sync` (v1.41) e `omie-financeiro` (v1.12).
3. Publish (front: mensagem por empresa).

## Rollback

Edge volta a chamar `venda_gate_credito` (a função v1 está intacta). Não há dado a desfazer.

## Prova

- PG17 `db/test-trava-credito-piso-grupo.sh`: 31 asserts × 2 (controle + re-prova) + 6 falsificações, em `C` e `pt_BR.UTF-8`.
- Deno `gate-credito_test.ts` (13) + 5 sabotagens vermelhas com controle verde; `mapear-titulo_test.ts` (7).
- vitest: invariantes da edge (lê `index.ts` + `gate-credito.ts`), paridade de vocabulário nas 2 migrations, submit com pares.

## Quando medir

24 h após o deploy: `select acao, count(*), count(*) filter (where detalhe not like '%' || company || '/' || omie_codigo_cliente || '=%') as so_outra_empresa from venda_bloqueio_credito_log where created_at > now()-interval '24 hours' and detalhe like 'pares:%' group by 1;` — `so_outra_empresa` > 0 = o furo sendo fechado (bloqueio que a v1 não faria); `gate_indisponivel` > 0 = investigar (agora segura venda).

---

# PR 2 — banco do limite, da reserva e da decisão (2026-11-21)

Migration `20261121160000_credito_limite_reserva_decisao.sql`, **sem edge nem Publish**, sem efeito em pedido: nada chama o núcleo do gate (`private.credito_avaliar_reservar`, sem grant) até o PR 5 (sombra), que expõe a RPC por **revisão** (PR 3).

- **Reserva transacional:** `pg_advisory_xact_lock` por raiz do grupo, com a raiz relida sob o lock; reservas somadas pelo **par** (sobrevivem a troca de raiz); exige READ COMMITTED (`25000` fora dele). Prova com 2 `psql` concorrentes e bloqueio **observado** (`pg_blocking_pids`): 2×R$ 7k contra R$ 10k → 1 🟢 + 1 🟡. Sem o lock, o mutante dá 2 🟢 e R$ 14k.
- **Solicitar ≠ autorizar:** o 🟡 abre `credito_solicitacao`; só `credito_autorizar_solicitacao` (cap + allowlist `credito_aprovador` = Lucas) cria `credito_autorizacao`, amarrada a revisão, valor, prazo e validade. Ela não cobre o piso nem o piso indeterminado. Reserva vinda de autorização vencida perde o lastro.
- **Escrita:** REVOKE de DML (inclusive de `service_role` e por coluna) **+** trigger com portão GUC `credito.portao` = id da linha. A GUC sozinha é forjável numa sessão SQL; quem fecha é o REVOKE. O trigger é provado à parte, com um papel que tem DML e BYPASSRLS.
- **Achado medido (psql-ro 2026-11-21):** `fin_contas_receber.status_titulo='PAGTO PARCIAL'` existe em prod (45 títulos, R$ 60,7k, **28 vencidos > 60 d**, 29 pares) e **não** está em `OPEN_TITLE_STATUSES`. O piso do PR 1 não o vê; o `saldo` dele é o valor cheio (`valor_recebido` nunca é preenchido). No gate novo: entra na exposição pelo valor cheio (o lado seguro) e, vencido > 60 d, vira 🔴. **O piso do PR 1 segue cego a isso — follow-up money-path.**
- Prova: `db/test-credito-limite-reserva.sh` (205 asserts em `LC_ALL=C` e `pt_BR.UTF-8`, 12 falsificações com controle verde na mesma invocação; F6 prova o rollback no envelope). Codex: desenho com 11 achados (2 P0), todos incorporados; diff com 1 P0 (escrita do `sandbox_exec_*`, BYPASSRLS, pelo default ACL de `public`) fechado por allowlist `aclexplode` + postcondição por catálogo.
- **Aplicada em prod 2026-11-21 19:22 UTC** pelo envelope (`db:aplicar`, tentativa #1274, sha256 `248bfaf1…`, commit `35d5c84a6` = main com #4066), o mesmo sha do ensaio. 2ª testemunha psql-ro: 7/7 tabelas com RLS e as 2 guardas; 0 grants fora da allowlist; `private.credito_avaliar_reservar` sem EXECUTE para anon/authenticated/service_role/sandbox; funções do aprovador só `authenticated`, as de proposta/grupo só `service_role`; allowlist = {Lucas}; ledger `aplicada`.
- **Fora do PR 2 (declarado):** frescor e cobertura do sync no gate, transferência comprovada reserva→título com residual de faturamento parcial (P0-2 Codex), carga e reconciliação dos PVs abertos antes de ligar (P1-7) → PR 5. Revisão imutável e RPC pública por revisão → PR 3/5.
- Rollback: `DROP` das 7 tabelas e das funções novas (founder, SQL Editor). Não há dado de negócio até o PR 4.

## Correção: o piso enxerga PAGTO PARCIAL e saldo ausente (2026-11-21, migration `20261121200000`)

**O furo (psql-ro 2026-11-21):** `status_titulo = 'PAGTO PARCIAL'` ficava fora do `IN (...)` do piso. Havia 45 títulos (R$ 60,7k), 28 deles vencidos > 60 d, em 22 pares. Em 13 desses pares nenhum outro título bloqueava, então a **venda saía**. O núcleo do PR 2 já lia o status. Além disso, o filtro `saldo > 0` deixava invisível qualquer título de saldo NULL (fail-open; 0 casos hoje).

**Decisões (Codex desenho + diff):**

| Caso | Antes | Depois |
|---|---|---|
| PAGTO PARCIAL vencido > 60 d | invisível | **bloqueia** (o status prova resíduo), com **qualquer** saldo espelhado (0/NULL contradiz o status, não o desmente) |
| Valor dele | — | **indeterminado**: `saldo` é o valor CHEIO (`valor_recebido` nunca é preenchido) → `pares[].vencido = null`; o total sai `null` se algum título for indeterminado; chaves novas `valor_indeterminado`, `titulos_indeterminados`, `titulos_comprovados` |
| Título aberto com saldo NULL (vencido ou sem vencimento), ou saldo > 0 sem vencimento | invisível | **segura**, `motivo='piso_indeterminado'` |
| Exceção com título indeterminado no escopo | — | só cobre se foi aprovada **depois** de um log de bloqueio do (pedido, empresa) gerado **após** a virada (`credito_virada_piso_parcial`). Quem aprovou lendo o log antigo não viu o parcial → `excecao_anterior_nao_cobre_parcial` |
| PR 2 (`private.credito_avaliar_reservar`) | — | corpo de prod (= repo) + 1 condição: piso que segura **só** por indeterminado → amarelo `piso_indeterminado` (não vermelho). Divergência mantida: PAGTO PARCIAL com exceção válida → vendas libera, o PR 2 segue vermelho |
| ACL | EXECUTE para `sandbox_exec_*` (BYPASSRLS) nas 3 funções; `credito_virada_grupo` com ALL para anon/authenticated (TRUNCATE passa por cima da RLS) | allowlist via `aclexplode`: owner + `service_role` (+ SELECT do `claude_ro` nas tabelas de marco); postcondição pelo privilégio **efetivo** |

**Front (Publish):** par de valor indeterminado aparece como "valor a confirmar" (antes sumia), na mensagem do vendedor, no parser do log e no diálogo. A mensagem distingue `piso_indeterminado` e `excecao_anterior_nao_cobre_parcial`. Exceção que o gate recusou (o bloqueio é mais novo que ela) **não esconde** mais o formulário. Isso também desfaz o laço "já aprovada, reenvie" que o PR 1 tinha com `excecao_anterior_nao_cobre_grupo`.

**Lição (pega pelo teste, não pela revisão):** `saldo NULL > 0` vale NULL, não false. NULL some de `count(*) FILTER` e de `bool_and`, então um título de saldo NULL no MESMO par de um título conhecido escondia a indeterminação (total = 300). Corrigido com `COALESCE(..., false)` e sabotado (F2b).

**Prova:** `db/test-credito-piso-pagto-parcial.sh` (144 asserts × controle + re-prova; 14 sabotagens + postcondição F9; executa e falsifica o ensaio de prod V1-V4) e `db/test-credito-limite-reserva.sh` (205, agora aplica a migration nova por cima, inclusive depois de cada sabotagem). Verde em `C` e `pt_BR.UTF-8`. Redundâncias declaradas: SUM→EXISTS na virada do grupo (a virada própria já segura, só muda o `motivo`).

**Deploy:** migration (envelope `db:aplicar`) + Publish, em qualquer ordem. Front velho com banco novo: o par null é descartado (degrada, segura igual). **Sem edge** (a edge decide por `bloqueado` e loga `=null`; o tipo `pares[].vencido: number` dela é só de tipagem). Verificação comportamental de prod: `bun run db:aplicar db/verifica-credito-piso-pagto-parcial.sql --ensaio` (o `claude_ro` não executa o gate, por desenho).

**Fora do escopo:** `PAGTO PARCIAL` segue fora de `OPEN_TITLE_STATUSES` (cashflow/NCG somaria o valor cheio — decisão do domínio financeiro).

**Aplicado em prod (2026-11-21 21:37 UTC):** `bun run db:aplicar` a partir da main mergeada (`8923921d5`, #4081). Ledger `db_aplicacoes` #1283 `aplicada`, sha256 `43cd74d7…`. Pré-voo: `pg_get_functiondef` de `venda_gate_credito_grupo` e de `private.credito_avaliar_reservar` = os corpos do PR 1/PR 2 (md5 iguais aos da medição da manhã). Ensaio antes do apply OK (a postcondição de ACL passou em prod).
- **Comportamental** (`db/verifica-credito-piso-pagto-parcial.sql --ensaio`, ROLLBACK): `VERIFICA OK: 22 pares PAGTO PARCIAL vencido > 60 d · 22 bloqueados · 22 com vencido null`.
- **2ª testemunha psql-ro:**
  - as defs têm `'PAGTO PARCIAL'`, `piso_indeterminado`, a margem de 5 min e `titulos_comprovados`;
  - EXECUTE: `credito_grupo_pares`/`venda_gate_credito_grupo`/`venda_gate_credito` = {postgres, service_role}; `credito_avaliar_reservar` = {postgres};
  - tabelas de marco: só `claude_ro:SELECT` além de owner/service_role;
  - `sandbox_exec`/`sandbox_exec_fzvklzpomgnyikkfkzai` sem escrita em `venda_bloqueio_credito_log`/`venda_excecao_credito`;
  - anon/authenticated sem TRUNCATE;
  - `credito_virada_piso_parcial` com 1 linha.
- **Falta:** Publish (front: "valor a confirmar" + mensagem por motivo + exceção recusada reabre o formulário). Sem ele, o banco já segura; só a tela degrada.
