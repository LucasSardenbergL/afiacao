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

## Recriar objeto VIVO (função/view): TRAVA → PRE → CREATE → PÓS

`CREATE OR REPLACE` de algo que já existe em prod apaga o que estiver lá, inclusive a mudança que outra sessão aplicou depois do seu pré-voo. A PRE anti-deriva (md5 do corpo vivo ∈ {predecessor revisado, este}) só protege se o objeto estiver **preso desde antes da leitura**. Sem trava, em READ COMMITTED, B troca e commita entre a sua PRE e o seu CREATE, você apaga B e a sua PÓS aprova. Isso foi medido em PG17 (`db/test-pre-anti-deriva-concorrencia.sh`, M0/V0). Instância provada deste template: `db/fixtures/pre-trava-template.sql`.

```sql
-- TRAVA, antes de ler: ALTER sem efeito em CADA objeto que a PRE guarda E que este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('public.<funcao>(<tipos>)') IS NOT NULL THEN
    ALTER FUNCTION public.<funcao>(<tipos>) <VOLATILE|STABLE|IMMUTABLE>;   -- a volatilidade VIVA
  END IF;
  IF to_regclass('public.<view>') IS NOT NULL THEN
    ALTER VIEW public.<view> SET (security_invoker = <on|off>);            -- o valor VIVO
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ABORTA.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('<funcao>(<tipos>)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.<funcao>(<tipos>)')),
         '<md5 do prosrc de PROD>', '<md5 do prosrc deste arquivo>'),
        ('<view>',
         (SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true)) FROM pg_catalog.pg_class c
           WHERE c.oid = to_regclass('public.<view>')),
         '<md5 do viewdef de PROD>', '<md5 do viewdef deste arquivo>')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.<funcao>(<args>) … ;
CREATE OR REPLACE VIEW public.<view> WITH (security_invoker = on) AS … ;   -- repita o WITH em todo replace

-- PÓS: o corpo vivo é ESTE (a mesma régua da PRE).
DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.<funcao>(<tipos>)')) IS DISTINCT FROM '<md5 deste>' THEN
    RAISE EXCEPTION 'POS FALHOU: <funcao>';
  END IF;
END
$pos$;
```

Cada regra abaixo foi medida em PG17; nenhuma é preferência de estilo.

- **A trava vem antes da PRE, na mesma transação.** No `db:aplicar` a transação é do executor, e o arquivo vai sem `BEGIN;`. No SQL Editor ou no MCP, o arquivo leva `BEGIN;` no topo e `COMMIT;` no fim. Ler primeiro e travar depois deixa a janela aberta: é o "guard fora da escrita" de `docs/agent/money-path.md`.
- **Trave cada objeto que a PRE guarda, e só objeto que o arquivo recria.** O ALTER muda o valor durante a transação, e quem fixa o valor final é o `CREATE OR REPLACE`. Uma trava sem CREATE num view-gate `security_invoker = off` (os `selfservice_*`) o deixaria `on` e zeraria o customer.
- **Função:** use `ALTER FUNCTION … <volatilidade viva>`, lida em `pg_proc.provolatile` (`v`/`s`/`i`). Também serve `SET search_path = <o mesmo>` com assert de `proconfig` antes = depois (forma da `20260927195430`).
  - Quem chega depois espera e falha alto com `XX000 tuple concurrently updated` (M1/M2). Se o atrasado também estiver no molde, ele morre no **próprio ALTER da trava**, antes da PRE dele (M5).
  - A trava não impede **chamar** a função.
  - **Procedure** não tem volatilidade: `ALTER PROCEDURE … VOLATILE` dá `42P13`. Use `ALTER PROCEDURE … SET search_path = <o mesmo>`, que trava (medido).
  - **Aggregate** não tem ALTER sem efeito que trave: `OWNER TO <o mesmo dono>` é no-op (medido). Fica só com a fila do `db:aplicar`; fora dele, coordene. Matview não tem `CREATE OR REPLACE`, então não se aplica.
  - `OWNER TO <o mesmo dono>` **não** trava: é no-op que nem toca a linha.
  - `SELECT … FOR UPDATE` em `pg_proc` não serve: o `postgres` da prod não tem `UPDATE` no catálogo.
- **View:** use `ALTER VIEW … SET (security_invoker = <valor vivo>)`. Ele prende a view em ACCESS EXCLUSIVE até o COMMIT.
  - Quem lê a view espera enquanto a migration roda. O próprio `CREATE OR REPLACE VIEW` já faria isso, só que mais tarde.
  - A tabela-base fica livre.
  - Nunca use `LOCK TABLE` numa view: ele trava as tabelas-base também, e aí todo o app espera.
  - ⚠️ Medido em V1/V2: quem chega depois **espera e, se não tiver PRE, aplica por cima** de você quando você termina. Ele não falha. Isso é o regime sequencial ("a última a recriar vence"), não esta corrida.
  - A trava garante que **você** não apaga ninguém. Quem vem depois sem protocolo depende do pré-voo dele e do `deriva:corpo:prod`. Com PRE e trava dos dois lados, o segundo é recusado (V3).
- **Objeto ausente aborta.** Sem objeto não há linha para travar, e um CREATE concorrente que commitasse antes do seu seria apagado.
  - Objeto NOVO não leva PRE: use `CREATE FUNCTION` sem `OR REPLACE`, e a duplicata falha alto.
  - Exceção consciente: objeto que pode faltar num ambiente reconstruído, porque viveu só na prod. Aí use `IS NOT NULL AND NOT IN`, sabendo que nesse ambiente a trava não prende nada.
- **O md5 é EXATO e calculado no banco:** `md5(prosrc)` ou `md5(pg_get_viewdef(oid, true))`, via `~/.config/afiacao/psql-ro -q`. Normalizar espaço ou comentário apaga diferença dentro de literal (`docs/agent/database.md` §2).
- **O `db:aplicar` já serializa por conta própria.** A fila em `aplicar_sql` (advisory `(20260909,1)`) impede que dois `db:aplicar` se cruzem, com ou sem trava no arquivo (E5/E6). A trava continua obrigatória porque a fila **não alcança** quem não passa pela porta: SQL Editor, `query_database` do MCP e o builder do Lovable.
- **Rode em READ COMMITTED,** que é o default da prod: cada comando depois da trava tira um snapshot novo. Em REPEATABLE READ o snapshot nasce no 1º comando e a PRE leria o mundo de antes. O `aplicar_sql` recusa esse caso (E9/E10); no SQL Editor, não mude o isolamento.

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
