---
name: lovable-db-operator
description: >-
  Ritual obrigatório para QUALQUER mudança de banco neste repo (Afiação/Colacor), que roda em
  Lovable Cloud. Use SEMPRE que a tarefa envolver criar/alterar tabela, coluna, índice, constraint,
  função SQL/Postgres, trigger, RLS policy, enum value, view, cron job ou extensão no Supabase — e
  também backfill/seed de dados que vai virar migration versionada, ou confirmar se uma migration já
  foi de fato aplicada no banco. Vale mesmo quando o usuário não diz "migration" e só descreve o objetivo ("preciso guardar X em vez do localStorage", "adiciona um
  campo Y na tabela Z", "cria um índice pra acelerar essa query", "nova tabela pra segmentos de
  cliente", "instala a extensão pgvector", "popula o catálogo com esses SKUs"). Por quê: o Lovable
  NÃO aplica automaticamente migrations de nome custom — elas ficam só no repo e o banco continua sem
  o objeto, uma falha SILENCIOSA e perigosa; e o dono não tem terminal pro backend, só cola SQL no
  SQL Editor do Lovable. A skill empacota o ritual: gera o arquivo de migration, o bloco pronto pra
  colar no SQL Editor, a query de validação pós-apply, a nota pro PR e regenera o audit. NÃO use
  para: consultas de leitura (SELECT pra ver/exportar dados), UPDATE ad-hoc que não vira migration,
  edge functions (supabase/functions — deploy diferente), regenerar tipos TypeScript do Supabase,
  revisar/auditar policies que já existem, ou debugar erro de build/tipo (TS) ou de auth/client do
  Supabase no frontend.
---

# Lovable DB Operator

## Por que esta skill existe (leia antes de qualquer coisa)

Este repo roda em **Lovable Cloud**. Existe uma armadilha operacional real e silenciosa, documentada na **§5 do CLAUDE.md**:

> **O Lovable Cloud NÃO aplica automaticamente migrations commitadas em `supabase/migrations/`.**
> Só migrations de nome **UUID** (ex.: `_868822bb-….sql`), geradas pelo *builder visual* do Lovable, rodam sozinhas. Migrations de **nome custom** (ex.: `20260523_meu_objetivo.sql`) — que é o que você cria ao escrever SQL à mão — **ficam só no repo e não tocam o banco.**

O resultado é o pior tipo de bug: **a feature compila, o PR mergeia, o código referencia uma tabela que não existe no banco, e ninguém percebe até dar erro em produção.** Já aconteceu neste repo (ver histórico de audits na §5).

Some-se a isso uma restrição dura: **o Lucas (dono) NÃO tem terminal, `curl`, `psql` nem Supabase CLI pro backend.** O único caminho dele pro banco é **colar SQL no SQL Editor do Lovable e clicar Run**. Você não pode aplicar a migration por ele — você só pode preparar o material perfeito pra ele colar, e depois confirmar que funcionou.

Por isso esta skill existe: ela transforma "escrevi um SQL" em "o objeto existe no banco, validado", fechando a lacuna onde as coisas se perdem.

## A Lei de Ferro (guardrail inegociável)

Três regras que você **nunca** quebra, porque quebrá-las recria exatamente o bug que esta skill previne:

1. **Você nunca finge que aplicou.** Você não tem como rodar SQL no banco de produção do Lovable. Não diga "criei a tabela", "apliquei a migration", "o índice está no ar". Diga "preparei o SQL pra você colar e rodar no Lovable". A migration só está aplicada quando o **usuário** rodou e a **query de validação** confirmou.
2. **Toda mudança vem com query de validação.** Você sempre entrega, junto do SQL, uma query read-only que prova que o objeto passou a existir *depois* do Run. Sem ela, o usuário não tem como distinguir "aplicado" de "esqueci de colar". Essa query é a rede de segurança contra a falha silenciosa.
3. **Migration de nome custom (timestamp), nunca UUID.** O timestamp `YYYYMMDDHHMMSS_<slug>.sql` é exatamente o que sinaliza "isto precisa de apply manual" e mantém ordenação. Nunca invente um nome UUID — esse formato é reservado pro builder do Lovable e te faria perder o controle de ordenação.

## O ritual — 6 passos

Quando a tarefa exigir mudança de banco, crie estes 6 todos (TodoWrite) e siga em ordem. Não pule o passo 4 (validação) nem o 6 (audit) — são onde a falha silenciosa é pega.

1. **Nomear** — gerar timestamp + slug do arquivo de migration
2. **Escrever** — o `.sql` idempotente, com RLS se for tabela nova
3. **Empacotar** — o bloco de handoff "🟣 Lovable → SQL Editor → cola → Run"
4. **Validar** — a query read-only de confirmação pós-apply
5. **Documentar** — a nota pro PR description ("ATENÇÃO: migration manual")
6. **Auditar** — rodar `bun run audit:migrations` e commitar os artefatos

---

### Passo 1 — Nomear o arquivo

Formato: `supabase/migrations/YYYYMMDDHHMMSS_<slug_descritivo>.sql`

- `slug` em **snake_case português**, coerente com o domínio (ver §5 do CLAUDE.md): `customer_segments`, `add_deleted_at_to_sales_orders`, `idx_orders_status`.
- Gere o timestamp e **garanta que ele ordena DEPOIS da última migration** (a ordem de execução é alfabética/lexical):

```bash
# timestamp do relógio
TS=$(date +%Y%m%d%H%M%S)
# última migration existente
LAST=$(ls supabase/migrations | sort | tail -1 | grep -oE '^[0-9]{14}')
# se o relógio gerar algo <= a última, use última+1 pra preservar ordenação
echo "candidato=$TS  ultima=$LAST"
```

Se `TS` não for maior que `LAST`, incremente para `LAST + 1` segundo. Isso evita que sua migration "afunde" no meio do histórico e rode fora de ordem.

### Passo 2 — Escrever a migration (idempotente + RLS)

Duas exigências do projeto que não são negociáveis:

- **Idempotente.** O usuário pode colar e rodar mais de uma vez (re-apply após falha parcial, ou re-rodar o audit SQL). Use `IF NOT EXISTS`, `DROP … IF EXISTS` antes de `CREATE`, e `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_type …) $$` pra enums. Rodar duas vezes nunca pode dar erro.
- **RLS em toda tabela nova.** O CLAUDE.md §11 exige RLS em todas as tabelas. Uma tabela criada sem `ENABLE ROW LEVEL SECURITY` + policies é um buraco de segurança que vaza dados entre empresas/usuários. Tabela nova **sempre** sai com RLS.

Template-base de tabela nova (ajuste colunas e policies ao caso). Os padrões de RLS e de coluna seguem o estilo real do repo — o catálogo completo de padrões de policy (staff / master / service_role / por empresa) está em `references/sql-house-style.md`:

```sql
-- ============================================================
-- <nome_tabela> — <uma linha: pra que serve>
-- Objetivo: <link pra spec/PR se houver>
-- ============================================================

CREATE TABLE IF NOT EXISTS public.<nome_tabela> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ... colunas do domínio ...
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_<nome_tabela>_<coluna>
  ON public.<nome_tabela>(<coluna>);

-- RLS (obrigatória)
ALTER TABLE public.<nome_tabela> ENABLE ROW LEVEL SECURITY;

-- Staff lê
DROP POLICY IF EXISTS "<nome_tabela>_select_staff" ON public.<nome_tabela>;
CREATE POLICY "<nome_tabela>_select_staff"
  ON public.<nome_tabela>
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

-- Master escreve tudo
DROP POLICY IF EXISTS "<nome_tabela>_master_all" ON public.<nome_tabela>;
CREATE POLICY "<nome_tabela>_master_all"
  ON public.<nome_tabela>
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid() AND role = 'master'::public.app_role)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid() AND role = 'master'::public.app_role)
  );

-- Service role bypass (edge functions / cron)
DROP POLICY IF EXISTS "<nome_tabela>_service_all" ON public.<nome_tabela>;
CREATE POLICY "<nome_tabela>_service_all"
  ON public.<nome_tabela>
  FOR ALL
  USING (auth.role() = 'service_role');
```

Para **adicionar coluna**, **índice**, **função SQL**, **trigger**, **enum value**, **view**, **extensão** (`CREATE EXTENSION IF NOT EXISTS …`) ou **cron** (não tabela nova), o padrão idempotente de cada caso está em `references/sql-house-style.md`. Para a **query de validação** de cada tipo de objeto, em `references/validation-queries.md`.

**Backfill / seed de dados** (popular catálogo, preencher coluna nova em linhas antigas): mesmo ritual, com duas diferenças. (1) O SQL é `INSERT … ON CONFLICT DO NOTHING` ou `UPDATE … WHERE <coluna> IS NULL` — sempre idempotente e re-rodável, pra colar de novo sem duplicar/estragar. (2) A validação não é `EXISTS` (a linha pode já existir), e sim **contagem ou amostra**: `SELECT count(*) FROM … WHERE <condição do backfill>` deve bater com o esperado, ou um `SELECT … LIMIT 5` mostrando os dados certos. Isso prova que o backfill pegou. Backfill só entra nesta skill quando vira migration versionada (`.sql` commitado); `UPDATE` ad-hoc de uma vez não é tarefa desta skill.

### Passo 3 — Empacotar o bloco de handoff

Este é o artefato central: o que o usuário copia e cola. Entregue **exatamente** neste formato, porque ele já está rotulado com o caminho do Lovable (§5 manda sempre rotular `🟣 Lovable → SQL Editor → cola → Run`):

````markdown
**🟣 Lovable → SQL Editor → cola → Run** — aplica a migration `<arquivo>.sql`:

```sql
<conteúdo INTEIRO do .sql, idêntico ao arquivo commitado>
```

**Depois de rodar, cole também isto pra confirmar que aplicou** (read-only):

```sql
<query de validação do passo 4>
```

Esperado: `✅`. Se vier `❌`, a migration não pegou — me avise o resultado.
````

Regras do handoff:
- O SQL no bloco é **byte-a-byte igual** ao arquivo em `supabase/migrations/`. Nada de "versão resumida". Divergência aqui é como o banco e o repo saem de sincronia.
- Se a migration for grande, não corte — o usuário precisa do conteúdo completo pra colar.

### Passo 4 — Query de validação (a rede de segurança)

Sempre acompanha o handoff. Confirma que o objeto **passou a existir** após o Run. Exemplo para tabela:

```sql
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '<nome_tabela>'
  ) THEN '✅ <nome_tabela> existe' ELSE '❌ FALTANDO — migration não aplicada' END AS status;
```

Exemplo para **coluna nova**:

```sql
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '<tabela>' AND column_name = '<coluna>'
  ) THEN '✅ coluna existe' ELSE '❌ FALTANDO' END AS status;
```

Para índice, função, trigger, RLS policy, enum value, constraint, view e cron job, use o catálogo de queries `pg_catalog`/`information_schema` em **`references/validation-queries.md`**. Se a migration cria vários objetos, valide os principais numa query só (o arquivo tem o padrão de validação múltipla).

**Quando o usuário colar o resultado:** interprete honestamente. `✅` → aplicado, pode seguir. `❌` → não pegou; investigue (erro no Run? colou parcial?) — **não** assuma que está ok. Só depois de `✅` você considera a mudança no banco como real.

### Passo 5 — Nota pro PR description

Toda migration custom precisa avisar quem revisa/mergeia que **o merge não aplica nada no banco**. Inclua este bloco no corpo do PR (§5 do CLAUDE.md exige):

````markdown
## ⚠️ ATENÇÃO: migration manual necessária

Este PR adiciona `supabase/migrations/<arquivo>.sql`. **Lovable não aplica automaticamente** —
mergear NÃO toca o banco. Alguém precisa colar no SQL Editor do Lovable e rodar.

<details><summary>SQL pra aplicar</summary>

```sql
<conteúdo do .sql>
```
</details>

Validação pós-apply:

```sql
<query de validação>
```
````

### Passo 6 — Regenerar o audit e commitar

O repo tem infra de auditoria que rastreia quais custom migrations estão aplicadas (`docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`). Sua migration nova precisa entrar nesse inventário. **Você** (não o usuário) roda isso localmente — é só leitura/escrita de arquivos do repo, não toca o banco:

```bash
bun run audit:migrations
```

Isso reescreve `docs/migrations-audit.md` e `scripts/audit-custom-migrations.sql` incluindo os objetos da sua migration. Commite os dois junto com o `.sql`. Assim o próximo audit (rodado no SQL Editor) já checa o seu objeto.

> Se `bun run audit:migrations` falhar, o regex parser pode não ter reconhecido seu SQL (ele cobre `CREATE TABLE/INDEX/FUNCTION/TRIGGER`, `cron.schedule`, `ALTER TYPE … ADD VALUE`, `CREATE POLICY`). Migrations só de `ALTER TABLE`/`UPDATE` aparecem como "nenhum objeto extraído" — normal; valide manualmente via passo 4.

---

## Depois que o usuário aplicar: registrar no histórico (opcional, recomendado)

Quando o usuário cola SQL cru no SQL Editor, o Supabase **não** registra a migration em `supabase_migrations.schema_migrations` (essa tabela só é escrita pelo runner de migrations). Consequência: a **Section 1** do audit (`scripts/audit-custom-migrations.sql`) vai mostrar `❌ MISSING` pro timestamp, mesmo com os objetos existindo (Section 2 = `✅`).

Pra deixar o audit 100% verde, ofereça ao usuário este `INSERT` opcional no fim do handoff:

```sql
-- (opcional) registra a migration como aplicada, pra não ser re-sugerida
INSERT INTO supabase_migrations.schema_migrations (version, statements)
VALUES ('<timestamp_14_digitos>', ARRAY['-- aplicada manualmente via SQL Editor'])
ON CONFLICT (version) DO NOTHING;
```

Explique que é cosmético (alinha o audit), não muda comportamento.

## Resumo do que entregar ao usuário

Ao final, sua mensagem ao usuário tem sempre estes elementos, nesta ordem:

1. O arquivo de migration criado (caminho).
2. O **bloco de handoff** completo (SQL + validação) — pronto pra colar.
3. A **nota de PR** — pronta pra colar no description.
4. Confirmação de que você rodou `bun run audit:migrations` e o que commitar.
5. Um lembrete honesto: *"Isto ainda NÃO está no banco. Cola no Lovable, roda, e me diz o resultado da validação."*

Nunca encerre dizendo que a mudança "está pronta" sem esse lembrete — porque até o Run acontecer, ela não está.

## Mapa de arquivos do repo (referência rápida)

- `supabase/migrations/` — onde o `.sql` vai (formato `YYYYMMDDHHMMSS_slug.sql`)
- `scripts/audit-custom-migrations.ts` — gera o audit; rode via `bun run audit:migrations`
- `scripts/audit-custom-migrations.sql` — audit pronto pra colar no SQL Editor (cross-check completo)
- `docs/migrations-audit.md` — inventário humano-legível das custom migrations
- `CLAUDE.md` §5 — a fonte da verdade sobre a restrição do Lovable
- Project ref Supabase: `fzvklzpomgnyikkfkzai`

## Arquivos de apoio desta skill

- `references/sql-house-style.md` — padrões idempotentes por tipo de objeto (coluna, índice, função, trigger, enum, cron) + catálogo de policies RLS no estilo do repo.
- `references/validation-queries.md` — query de validação `pg_catalog`/`information_schema` pronta pra cada tipo de objeto, + padrão de validação múltipla numa query só.
