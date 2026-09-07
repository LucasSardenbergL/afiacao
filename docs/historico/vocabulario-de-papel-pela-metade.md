# Migração de vocabulário aditiva: o velho continua GATEANDO, o novo só DESCREVE

> 2026-08-30. Medido em prod via `psql-ro`. Origem: pergunta do founder sobre por que
> `private.cap_carteira_ler` testa três valores de `commercial_role` que ninguém possui.

## O achado

`public.commercial_role` tem 8 valores em **duas transações** (`xmin` 38160 e 2381763):
`operacional/gerencial/estrategico/super_admin` (2026-02-28) e
`farmer/hunter/closer/master` (2026-05-18, migration `20260518100000`, cujo comentário
diz literalmente *"Aditivo — mantém … (legado)"*). A conversão nunca foi agendada.

Prod tem **3 linhas**: `farmer`×2 e `master`×1 — todas do vocabulário NOVO. E **11
consumidores** liam o VELHO:

| Camada | Consumidor |
|---|---|
| capability | `cap_carteira_ler` (23 policies) · `cap_custo_ler` (11 policies, inclui ESCRITA) |
| predicado | `is_super_admin` · `pode_ver_carteira_completa` (0 policies — inerte) |
| escritor | trigger `auto_assign_commercial_super_admin` |
| policy | `call_log team select` · `margin_audit_log` |
| edge money-path | `omie-financeiro` · `fin-valor-cockpit` · `fin-next-best-action` · `disparar-pedidos-aprovados` |

E o vocabulário NOVO era lido só por produto (`useSalespeople`, `useTeamRanking`,
`home-por-persona`, `CommercialDashboard`, impersonação). **Conjuntos disjuntos.**

## A lição

> **Migração de vocabulário ADITIVA sem conversão agendada não é meio-caminho: é uma
> INVERSÃO de papéis silenciosa.** O vocabulário velho fica com a AUTORIZAÇÃO (porque é
> o que os gates já citavam) e o novo nasce só DESCRITIVO (porque só o código novo o lê).
> Quem provisiona escreve o novo; quem autoriza lê o velho; ninguém falha, e a
> autorização passa a depender de um acidente histórico — *"ninguém tem esses valores"*.

Três corolários que valem além deste caso:

1. **`UNIQUE(user_id)` numa coluna que ganhou uma segunda dimensão torna as duas
   mutuamente exclusivas.** Aqui, promover uma `farmer` a `gerencial` apagaria a
   identidade de produto dela (some de `useSalespeople`, do ranking e do Meu Dia) —
   silenciosamente, e sem estado anterior reconstruível. O "provisionamento sob demanda"
   existia no papel e era **inexecutável sem regressão**.
2. **Ramo fail-closed não é ramo morto.** Ele não abre acesso, mas a PRIMEIRA atribuição
   do valor liga tudo de uma vez. O custo de deixá-lo não é exposição — é que a segurança
   passa a repousar sobre a ausência de dado, que nenhum teste vigia.
3. **O gate que perde por omissão é o que ninguém sente.** `margin_audit_log` acumulou
   **12.393 linhas entre 2026-03-02 e 2026-08-30** com policy de SELECT
   `is_super_admin OR = 'estrategico'` e **sem ramo `master`**: log de auditoria
   write-only por ~6 meses, e ninguém reclamou — porque quem reclamaria é exatamente
   quem não conseguia entrar.

## Método que produziu a prova (reutilizável)

- **`xmin` data DDL sem `created_at`.** Correlacione o `xmin` do catálogo com o `xmin` de
  linhas DATADAS (aqui: `company_config`, 2332671→27/04 e 2415431→24/05). Foi assim que o
  ADD VALUE caiu em 18/05.
- **`created_at` mente; a linha do tempo do enum não.** A linha `master` diz
  `created_at = 2026-02-28`, mas `master` **não existia no enum** naquela data ⇒ ela nasceu
  com valor legado e foi reescrita depois (confirmado: `xmin` da linha é POSTERIOR ao das
  `farmer`, com `updated_at` intocado). Inferência virou prova por um invariante de
  catálogo, não por narrativa.
- **`pg_depend` prova referência, não a expressão.** Para saber quem REALMENTE alcança uma
  tabela, extraia `polcmd`/`polpermissive`/`pg_get_expr(polqual)` e reconstrua os `OR`.
  Aqui: das 23 policies, 8 tinham a capability como ÚNICO caminho; nas outras 15 havia
  caminho linha-a-linha (`farmer_id`, `assigned_to`, `carteira_visivel_para`, cobertura) —
  ou seja, "a autorização de carteira é `has_role(master)` e mais nada" era FALSO.
- **Escopo de gate ≠ escopo do achado.** Varrer só o banco daria 7 consumidores; as 4
  edges de money-path (uma delas cria pedido no Omie) só apareceram ao varrer
  `supabase/functions/`. O vocabulário atravessa camadas; a busca também tem de atravessar.

## O que foi feito, e o que NÃO foi (de propósito)

Aplicado em prod 2026-08-30 (validado por `psql-ro`):

- `20260830122701` — `margin_audit_log` ganha o ramo `master`. Ramos legados preservados
  byte-a-byte: removê-los seria decidir o vocabulário, e essa decisão não era dessa migration.
- `20260830122702` — remove o trigger `auto_assign_commercial_super_admin`. **Higiene, não
  incidente:** o `20260613170000` (Codex #802-P1) já havia avaliado este trigger e o
  deixado de pé por não ser alcançável pelo self-insert (a única policy de INSERT em
  `profiles` exige `is_employee = false`; o trigger exige `true`) — confirmado
  empiricamente na Zona 2 de `db/test-remove-trigger-auto-super-admin.sh`. O que se
  acrescentou foi a CARGA, que aquela avaliação não mediu: 31 tabelas, escrita em
  `farmer_algorithm_config`, `FOR ALL` na própria `commercial_roles` e as 4 edges.

**Não** se mexeu em `cap_carteira_ler` / `cap_custo_ler` / nas 4 edges. O conserto real é
estrutural — separar identidade de produto de nível de autorização — e é decisão de
produto. Adicionar `farmer` ao `IN` seria o oposto do #1730 (*"a tela passa a mostrar a
carteira, não a base inteira"*); e, como a 2ª opinião registrou, o #1730 prova
*"não a base inteira"*, **não** *"zero acesso nas 8 tabelas sole-path"* — essa continua
sendo pergunta em aberto.
