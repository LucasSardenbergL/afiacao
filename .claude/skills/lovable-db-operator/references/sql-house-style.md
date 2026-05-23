# Estilo de SQL da casa — padrões idempotentes por tipo de objeto

Padrões extraídos das migrations reais do repo (ex.: `20260517120000_user_departments.sql`). Seguir isto mantém a migration consistente com o que já existe e **idempotente** — o usuário pode colar e rodar mais de uma vez sem erro, o que importa porque no Lovable o apply é manual e às vezes re-tentado.

## Princípios

- **Header `====`** em toda migration, com uma linha dizendo pra que serve + link pra spec/PR se houver.
- **Idempotência sempre.** `IF NOT EXISTS` em tabela/índice; `DROP … IF EXISTS` antes de `CREATE` em policy/trigger; `DO $$ … $$` com guarda pra enum/type. Rodar 2× = no-op, nunca erro.
- **`public.` explícito** em tudo (`public.<tabela>`, `public.<funcao>`).
- **Colunas-padrão**: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid REFERENCES auth.users(id)`. `updated_at` quando houver edição (+ trigger, abaixo).
- **snake_case português** em nomes (`fin_contas_pagar`, `customer_segments`, `idx_<tabela>_<col>`).

---

## Coluna nova (ALTER TABLE)

```sql
ALTER TABLE public.<tabela>
  ADD COLUMN IF NOT EXISTS <coluna> <tipo> <default/null>;
```

Exemplo real-mundo (soft-delete, débito conhecido da §10):

```sql
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sales_orders_not_deleted
  ON public.sales_orders(id) WHERE deleted_at IS NULL;
```

> Coluna `NOT NULL` em tabela com dados existentes: adicione com `DEFAULT`, ou em dois passos (add nullable → backfill `UPDATE` → `SET NOT NULL`) pra não travar em linhas antigas.

## Índice

```sql
CREATE INDEX IF NOT EXISTS idx_<tabela>_<coluna>
  ON public.<tabela>(<coluna>);

-- parcial (ex.: só linhas ativas) — padrão comum no repo
CREATE INDEX IF NOT EXISTS idx_<tabela>_ativos
  ON public.<tabela>(<coluna>) WHERE <condicao>;

-- único
CREATE UNIQUE INDEX IF NOT EXISTS uniq_<tabela>_<coluna>
  ON public.<tabela>(<coluna>);
```

> `CREATE INDEX CONCURRENTLY` **não** funciona dentro de transação. Como o SQL Editor do Lovable roda o bloco numa transação, use `CREATE INDEX` normal (trava a tabela brevemente). Só use `CONCURRENTLY` se rodar isolado, fora de transação.

## Função

```sql
CREATE OR REPLACE FUNCTION public.<funcao>(<args>)
RETURNS <tipo>
LANGUAGE plpgsql
SECURITY DEFINER          -- se precisa bypassar RLS; senão, omita
SET search_path = public  -- obrigatório com SECURITY DEFINER (evita hijack de search_path)
AS $$
BEGIN
  -- ...
END;
$$;
```

> `SECURITY DEFINER` sem `SET search_path` é vulnerabilidade — sempre pin o search_path. Funções expostas como RPC pro frontend precisam de `GRANT EXECUTE ON FUNCTION public.<funcao> TO authenticated;`.

## Trigger (função + attach)

```sql
-- 1) função do trigger
CREATE OR REPLACE FUNCTION public.<tabela>_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 2) attach (idempotente)
DROP TRIGGER IF EXISTS trg_<tabela>_updated_at ON public.<tabela>;
CREATE TRIGGER trg_<tabela>_updated_at
  BEFORE UPDATE ON public.<tabela>
  FOR EACH ROW EXECUTE FUNCTION public.<tabela>_set_updated_at();
```

## Enum: criar tipo / adicionar valor

```sql
-- criar enum novo (idempotente via guarda no pg_type)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '<enum_type>') THEN
    CREATE TYPE public.<enum_type> AS ENUM ('valor_a', 'valor_b');
  END IF;
END $$;

-- adicionar valor a enum existente
ALTER TYPE public.<enum_type> ADD VALUE IF NOT EXISTS '<novo_valor>';
```

> `ALTER TYPE … ADD VALUE` **não pode rodar dentro de bloco de transação** em Postgres < 12 e, mesmo em versões novas, o valor novo não pode ser usado na mesma transação que o adicionou. Se a migration adiciona valor de enum **e** o usa logo em seguida (ex.: num `UPDATE`), separe em duas migrations (duas colagens no SQL Editor). Avise o usuário disso no handoff.

## Cron job (pg_cron)

```sql
-- agenda idempotente: remove antes de re-criar
SELECT cron.unschedule('<jobname>') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '<jobname>');
SELECT cron.schedule(
  '<jobname>',
  '*/15 * * * *',                       -- cron expression
  $$ SELECT public.<funcao_ou_sql>(); $$
);
```

Cron que invoca edge function via `pg_net` segue o padrão dos arquivos `*_cron.sql` do repo (usa `net.http_post` com header de auth). Olhe um exemplo existente antes de escrever um novo.

---

## Catálogo de policies RLS (estilo do repo)

Toda tabela nova precisa de RLS (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`) + policies. Os padrões abaixo cobrem os casos do projeto. O mapeamento de roles está em `src/contexts/AuthContext.tsx`: `app_role` = `employee | customer | master`; `isStaff = employee || master`.

### Staff lê (employee + master)

```sql
DROP POLICY IF EXISTS "<tabela>_select_staff" ON public.<tabela>;
CREATE POLICY "<tabela>_select_staff"
  ON public.<tabela> FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );
```

### Staff escreve (INSERT/UPDATE)

```sql
DROP POLICY IF EXISTS "<tabela>_insert_staff" ON public.<tabela>;
CREATE POLICY "<tabela>_insert_staff"
  ON public.<tabela> FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

DROP POLICY IF EXISTS "<tabela>_update_staff" ON public.<tabela>;
CREATE POLICY "<tabela>_update_staff"
  ON public.<tabela> FOR UPDATE
  USING (   /* mesma condição staff */ )
  WITH CHECK ( /* mesma condição staff */ );
```

### Só master modifica / deleta

```sql
DROP POLICY IF EXISTS "<tabela>_delete_master" ON public.<tabela>;
CREATE POLICY "<tabela>_delete_master"
  ON public.<tabela> FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND role = 'master'::public.app_role));
```

### Usuário lê só o próprio

```sql
DROP POLICY IF EXISTS "<tabela>_read_own" ON public.<tabela>;
CREATE POLICY "<tabela>_read_own"
  ON public.<tabela> FOR SELECT
  USING (auth.uid() = user_id);
```

### Service role bypass (edge functions / cron)

Quase toda tabela precisa disto pra que edge functions e jobs consigam escrever:

```sql
DROP POLICY IF EXISTS "<tabela>_service_all" ON public.<tabela>;
CREATE POLICY "<tabela>_service_all"
  ON public.<tabela> FOR ALL
  USING (auth.role() = 'service_role');
```

### Escopo por empresa (multi-tenant)

O app tem 3 empresas (`colacor`, `oben`, `colacor_sc`). Se a tabela tem `company_id`/`company`, considere escopar a leitura por empresa do usuário, além do gate de role. Veja como `fin_*` faz (ex.: `fin_categorias_select`) antes de escrever — o padrão exato depende de como a empresa é resolvida pro usuário (hoje via `company_config`/contexto). Na dúvida, comece com gate de role (staff lê) e refine depois.

> **Cobertura**: pense nos 4 comandos (SELECT/INSERT/UPDATE/DELETE). Faltar a policy de um comando = aquele comando fica bloqueado pra todos (exceto service_role). Uma tabela com só `_select_staff` é read-only pro frontend — intencional às vezes, bug outras. Decida conscientemente.
