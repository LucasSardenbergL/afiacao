#!/usr/bin/env bash
# Teste PG17 da função tint_marcar_bases_mixmachine (cobertura do mapeamento tintométrico).
# Valida: marca base/concentrado faltante, CORRIGE drift de tint_type, ignora
# inativo/não-tint/account-alheio, normaliza caixa, e é idempotente.
# (O cron/REVOKE da migration não entram aqui — exigem pg_cron/roles; são sintaxe padrão.)
# Base: boilerplate de db/test-data-health-familia-ausente.sh.
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5471
DATA="$(mktemp -d /tmp/pgtest-tintcob.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-tintcob.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres tintcob
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d tintcob -v ON_ERROR_STOP=1 "$@"; }

P <<'SQL'
create table omie_products (
  id uuid primary key default gen_random_uuid(),
  account text, ativo boolean, familia text,
  is_tintometric boolean, tint_type text, updated_at timestamptz
);

-- função idêntica à migration (corpo)
create or replace function public.tint_marcar_bases_mixmachine()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with alvo as (
    select op.id,
      case lower(btrim(op.familia))
        when 'bases mixmachine' then 'base'
        when 'concentrados mixmachine' then 'concentrado'
      end as tipo_esperado
    from public.omie_products op
    where op.account = 'oben' and op.ativo = true
      and lower(btrim(op.familia)) in ('bases mixmachine', 'concentrados mixmachine')
  )
  update public.omie_products op
  set is_tintometric = true, tint_type = alvo.tipo_esperado, updated_at = now()
  from alvo
  where op.id = alvo.id
    and (op.is_tintometric is not true or op.tint_type is distinct from alvo.tipo_esperado);
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end; $$;

insert into omie_products (account, ativo, familia, is_tintometric, tint_type) values
  ('oben',    true,  'Bases MixMachine',        false, null),          -- A: marca base
  ('oben',    true,  'Bases MixMachine',        true,  'concentrado'), -- B: corrige drift -> base
  ('oben',    true,  'Concentrados MixMachine', false, null),          -- C: marca concentrado
  ('oben',    false, 'Bases MixMachine',        false, null),          -- D: inativo -> ignora
  ('oben',    true,  'Outra Familia',           false, null),          -- E: nao-tint -> ignora
  ('oben',    true,  'BASES MIXMACHINE',        false, null),          -- F: caixa -> marca
  ('colacor', true,  'Bases MixMachine',        false, null),          -- G: account alheio -> ignora
  ('oben',    true,  'Bases MixMachine',        true,  'base');        -- H: ja correto -> nao conta

-- 1a passada: A,B,C,F marcados/corrigidos = 4 (H ja correto; D/E/G nao-elegiveis)
do $$ declare n int; begin
  n := public.tint_marcar_bases_mixmachine();
  if n <> 4 then raise exception 'FALHA A1: 1a passada marcou % (esperado 4)', n; end if;
end $$;

-- todos os 5 elegiveis (A,B,C,F,H) corretos
do $$ begin
  if (select count(*) from omie_products
        where account='oben' and ativo
          and lower(btrim(familia)) in ('bases mixmachine','concentrados mixmachine')
          and is_tintometric = true
          and tint_type = case lower(btrim(familia)) when 'bases mixmachine' then 'base' else 'concentrado' end
     ) <> 5
  then raise exception 'FALHA A2: nem todos os 5 elegiveis ficaram corretos'; end if;
end $$;

-- nao-elegiveis (inativo/nao-tint/account-alheio) intocados
do $$ begin
  if exists (
    select 1 from omie_products
    where (ativo = false
           or account <> 'oben'
           or lower(btrim(familia)) not in ('bases mixmachine','concentrados mixmachine'))
      and is_tintometric is true
  ) then raise exception 'FALHA A3: nao-elegivel foi marcado'; end if;
end $$;

-- 2a passada: idempotente -> 0
do $$ declare n int; begin
  n := public.tint_marcar_bases_mixmachine();
  if n <> 0 then raise exception 'FALHA A4: 2a passada nao-idempotente, marcou %', n; end if;
end $$;

select 'TODOS OS ASSERTS PASSARAM (A1-A4)' as resultado;
SQL
echo "TEST_EXIT_OK"
