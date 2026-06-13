# Backfill de cadastro Omie → profiles (clientes-fantasma da carteira) — Design

> Data: 2026-06-12. Origem: founder viu `/admin/customers` na lente mostrar 1 cliente (Tatiana) / 7 (Regina), quando a carteira é 571 / 674.

## Problema (root cause confirmado por dados)

A tela `/admin/customers` (modo carteira, PR #763) lista a carteira cruzando `carteira_assignments` (`customer_user_id` → `auth.users`) com `profiles` via **INNER JOIN** (`.in('user_id', ids).eq('is_employee', false)` em `src/lib/carteira/escopo-clientes.ts`). A carteira da vendedora é majoritariamente de **clientes-só-Omie**: têm `auth.users` + `omie_clientes` + `carteira_assignments` + scores, mas **não têm `profiles`**. O join derruba 571→1 / 674→7.

`eligible` (rebuild nunca seta `false`) e `owner` (lente usa o próprio `owner_user_id`) descartados por código. O nome/telefone/documento do cliente vem de `profiles` em **todo** o app (até `customer_metrics_mv` deriva `razao_social` de `p.name`); nenhuma tabela Omie sincronizada guarda a razão social dos vinculados — só o Omie (`ListarClientes`).

## Dados (dry-run em prod, 2026-06-12)

- `omie_clientes` sem `profiles` = **1.633** (não os ~6.900 estimados — a maioria da carteira já tem profile, são os ~5.273 do balde Hunter).
- Desses 1.633: **100% têm email + senha**, mas domínio único **`placeholder.local`**, **`ja_logou=0`**, **`banidos=0`**, todos criados em **2026-03-01** (um import em massa), **`com_role_nao_customer=0`**.
- Leitura: são **contas-fantasma de import** (esqueleto auth+omie_clientes+carteira+score, sem cadastro). Email placeholder não recebe → senha aleatória inalcançável → **login inviável**. Criar profile é seguro (não dá senha, não muda email; só dá nome e torna visível na carteira).

## Decisão

Popular `profiles` para os clientes vinculados (`omie_clientes`) sem profile, puxando o cadastro do Omie (`ListarClientes`). Conserta a tela **e** o app todo (scores/positivação/rota/Customer360 deixam de cair no fallback "Cliente"). Backfill **desacoplado** (só escreve `profiles`; não toca `omie_clientes`/carteira/scores).

Validado com Codex (consult 2026-06-12): direção aprovada, 4 P1 incorporados abaixo.

## Salvaguardas (Codex P1 + dados)

1. **`created_at` = `auth.users.created_at` (março), nunca `now()`.** O `visit-score-recalc-client` trata profile < 30 dias como "prospecção recente" e dá bônus; com `now()` os 1.633 virariam prospect quente falso na rota. Usar a data real (março → > 30d → neutro).
2. **Filtrar `prospect_source='omie_import'` da fila/KPI de aprovação** (`AdminApprovals` + `useSistemaZone`) **antes** do backfill. Senão `is_approved=false` joga 1.633 pendências falsas na fila — e "rejeitar" lá apaga só o profile, deixando auth/carteira/score órfãos. Fase 1 = front-only.
3. **Pular documento == `master_cnpj`.** O trigger `auto_assign_user_role` (AFTER INSERT em `profiles`) cria role `master` se `document` normalizado == `company_config.master_cnpj`. O edge lê `master_cnpj` e **exclui** esses do lote (não toco o trigger money-path). `com_role_nao_customer=0` hoje → o único vetor é esse.
4. **Casar por `(conta, código)`, processar uma conta por vez.** `omie_codigo_cliente` repete entre Oben/Colacor/Colacor SC. `ListarClientes` é por conta → o cadastro de cada conta casa só com clientes daquela conta. Vínculo ambíguo (mesmo código em mais de uma conta apontando user_ids diferentes) → reportar, não adivinhar.

Outras decisões:
- **Colisão de documento:** se o documento já existe em **outro** profile → **pular e reportar** (reapontar carteira/omie_clientes criaria split-brain de identidade — fora de escopo). Dedup também **intra-lote**.
- **Documento inválido/vazio → `NULL`** (nunca `''` nem máscara; não inventar identidade fiscal). `NULL ≠ master_cnpj` no trigger → cai em `customer` corretamente.
- **`is_approved=false`** (defesa em profundidade; o controle real é o email inalcançável). `is_employee=false`, `prospect_source='omie_import'`.
- **Insert-only, `ON CONFLICT DO NOTHING`.** Nunca atualiza profile existente. Idempotente (re-run só insere o que falta).

## Arquitetura

- **Helper puro TDD** `src/lib/clientes-cadastro/backfill-helpers.ts` (espelhado verbatim no edge — Deno não importa de `src/`):
  - `normalizarDocumento(raw): string | null` — só dígitos; 11 (CPF) ou 14 (CNPJ); rejeita todos-iguais; senão `null`.
  - `decidirLinhaProfile(args): { acao: 'inserir', row } | { acao: 'pular', motivo }` — aplica master_cnpj, dedup (existentes + intra-lote via Set acumulado), monta a linha (`name: nome_fantasia||razao_social||'Cliente'`, `phone`, `document`, `customer_type`, `prospect_source:'omie_import'`, `is_employee:false`, `is_approved:false`, `created_at`).
  - `classificarTelefone(ddd, numero): string | null`.
- **Edge** = nova action `start_backfill_cadastro` no `omie-analytics-sync` (reusa `callOmie`/`getCredentials`/`accountToEmpresa`/paginação; desacoplado, igual ao `syncNaoVinculados`):
  1. Por conta: `ListarClientes` todas as páginas → mapa `codigo → cadastro`.
  2. Carrega `omie_clientes` (user_id, codigo) sem profile + `auth.users.created_at` (admin) + `master_cnpj`.
  3. Carrega documentos de `profiles` existentes (dedup).
  4. `decidirLinhaProfile` por user_id → bulk insert `ON CONFLICT DO NOTHING`.
  5. **`dry_run`**: conta inseríveis / pulados-por-motivo / ambíguos, sem escrever.
  6. Lock de execução (não rodar 2x). Relatório de pulados.

## Fases

- **Fase 1 (front):** filtro `omie_import` em `AdminApprovals` + `useSistemaZone`. Sem migration.
- **Fase 2 (edge):** helper TDD + action `start_backfill_cadastro` com `dry_run`.
- **Fase 3 (canário):** `dry_run` → conferir números → 100 → comparar scores/contagens → resto + 1 refresh da `customer_metrics_mv`.
- **Fase 4 (cron):** noturno após o sync do Omie (clientes novos ganham profile). Migration leve do cron.
- **Codex adversarial retroativo** no edge antes do canário (precedente money-path do CLAUDE.md §10).

## Não-objetivos (v1)

- Reapontar `carteira_assignments`/`omie_clientes` em colisão (split-brain — exige merge de identidade).
- Criar `auth.users` (já existem).
- Mexer no trigger `auto_assign_user_role` (blindagem é no edge).
- Atualizar profiles existentes (insert-only).
- Telefone/cidade como fonte canônica (best-effort do cadastro Omie).

## Correções pós-Codex adversarial (2026-06-12) — ✅ APLICADAS

Codex deu **Gate FAIL** no edge v1. As 7 correções abaixo foram aplicadas; CI local verde
(typecheck strict EXIT 0 · 3194 testes vitest · lint 0 errors · `deno check` net-zero = só os 3 erros
pré-existentes `cost_price`/`saldo` em `computeCosts`/`syncInventory`, nenhum nas funções de backfill).
Codex output completo em `/tmp/codex-challenge-out.txt`.

**P1 (bloqueantes) — feitos:**
1. **Casamento por código reescrito** (`fetchAlvosSemProfile` + `syncBackfillCadastro`). `fetchAlvosSemProfile`
   agora retorna `Map<codigo, {userId,createdAt}[]>` (**lista, nunca last-wins**). `syncBackfillCadastro`
   enumera as **3 contas Omie numa invocação** (sem param `account`), monta `candidatosPorUser: Map<userId,
   {account,cadastro}[]>` e decide por user: **0 candidatos → `sem_match`**; **candidatos de >1 conta distinta
   → `ambiguos` (tipo A)**; **código com >1 user_id (`codigosAmbiguos`) → `ambiguos` (tipo B)**; senão decide
   com `cands[0]`. `omie_clientes` é UNIQUE(user_id) → 1 código por user (simplifica). `sync_state` virou
   estado único `account="all"`.
2. **`master_cnpj` fail-CLOSED.** Leitura com `error` capturado → `throw`; normaliza (tira aspas jsonb + só
   dígitos) e **`throw` se length ∉ {11,14}** (ausente/inválido aborta o backfill). + migration
   `20260612120000_auto_assign_role_omie_import_guard.sql`: `CREATE OR REPLACE auto_assign_user_role`
   **verbatim do corpo vivo do snapshot** + `AND COALESCE(NEW.prospect_source,'') <> 'omie_import'` no ramo
   master. (CHECK de `prospect_source` JÁ inclui `'omie_import'` em prod → sem migration de CHECK.)
3. **Canário determinístico.** Action aceita `limite` (validado `>0`, `Math.floor`); `rows` ordenadas por
   `user_id` antes do `slice(0, limite)`. Relatório expõe `seriam_inseridos` vs `inseridos`.
4. **Fila de aprovação server-side** (`AdminApprovals.tsx`). Filtro movido pro PostgREST
   `.or('prospect_source.is.null,prospect_source.neq.omie_import')` (string literal estática → passa o
   `no-restricted-syntax`); removido o filtro client-side `prospect_source` (só sobrou `!employeeIds.has`).

**P2 (importantes) — feitos:**
5. **DV real de CPF/CNPJ** (`cpfDvValido`/`cnpjDvValido` mod 11) no `normalizarDocumento` (helper + espelho
   verbatim no edge). DV inválido → `null` → `document=NULL` (não inventa identidade). Testes: trocados os
   docs por DV-válidos (`123.456.789-09`, `11.222.333/0001-81`) + casos DV-inválido→null; `masterCnpj` de
   teste `99887766000155` (era DV-inválido) → `11222333000181`. 17→19 testes.
6. **Fallback linha-a-linha** (`inserirProfilesComFallback`). Chunk falho (conflito do
   `idx_profiles_document_unique`, não coberto por `ON CONFLICT(user_id)`) → re-insere linha-a-linha,
   conta `conflitos_documento` (23505) sem abortar; erro ≠ 23505 → `throw`.
7. **Relatório rico** — `alvos_total`, `total_omie`, `com_match`, `sem_match`, `ambiguos`, `inseriveis`,
   `seriam_inseridos`, `inseridos`, `conflitos_documento`, `pulados{}`, `created_at_recente` (<35d, sinaliza
   relink), `contas_processadas`/`contas_sem_credencial`, `amostra` (5× `{user_id, document, name}`).

**Aceitos/documentados (não-bloqueantes):** `created_at = omie_clientes.created_at` é OK pro lote de março
(Codex concordou); Fase 4 (cron) deve usar `LEAST(auth.users.created_at, omie_clientes.created_at)` via RPC.
Lock não-atômico/15min é o padrão do repo (`start_nao_vinculados`). `updateSyncState` best-effort.

⚠️ **Pendências do founder após o merge:** (1) **deploy** do `omie-analytics-sync` via chat do Lovable
(verbatim da main, **só após mergear** — senão pega a main velha e responde "Ação desconhecida"); (2) colar a
migration `20260612120000` no **SQL Editor** (defesa em profundidade — não bloqueia o dry_run, mas aplicar
antes da escrita real); (3) rodar o **canário** (dry_run → `sync_state` relatório → `limite:100` → conferir →
lote inteiro), comandos abaixo.

### Comandos de operação (SQL Editor → `net.http_post`, header `x-cron-secret` do Vault)

```sql
-- DRY-RUN (não escreve; lê o relatório em sync_state):
select net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name='CRON_SECRET' limit 1)),
  body := jsonb_build_object('action','start_backfill_cadastro','dry_run',true),
  timeout_milliseconds := 150000);
-- aguardar ~1-2 min, então:
select status, metadata from sync_state where entity_type='backfill_cadastro' and account='all';
```
Canário 100: trocar o `body` por `'dry_run',false,'limite',100`. Lote inteiro: `'dry_run',false` (sem limite).
Após o lote: 1 refresh da `customer_metrics_mv` (Fase 3).

## Critério de pronto

`/admin/customers` na lente da Tatiana/Regina mostra a carteira com **nome** (não "1"/"7"); os scores de visita **não** ganham bônus de "prospect recente" falso (created_at preservado); a fila de aprovação **não** mostra os 1.633.
