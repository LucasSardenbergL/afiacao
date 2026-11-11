#!/usr/bin/env bash
# Prova PG17 da migration 20261113090000 (clientes MEI: o CPF do titular é gravado mascarado no nome do cliente):
#   M1  o backfill mascara as três formas medidas em prod (colado no fim, com separadores, no meio) e não toca CNPJ,
#       10/12 dígitos nem nome comum, em profiles.name e em venda_items_history.cliente_razao_social.
#   M2  a máscara SQL dá EXATAMENTE as amostras do teste Deno de _shared/razao-fiscal_test.ts (espelho TS).
#   M3  o cliente logado (role authenticated, sem acesso a private) grava o próprio perfil e o CPF sai mascarado.
#   M4  UPDATE do name mascara; UPDATE de outra coluna não reescreve o name.
#   M5  o upsert do sync de itens (ON CONFLICT … DO UPDATE com EXCLUDED) grava mascarado.
#   M6  re-aplicar a migration é inócuo (idempotente, os dados não mudam).
#   M7  a PRE recusa aplicar sobre a máscara ANTIGA (só no fim, sem separador) — o dotted escaparia.
#   V1  o vínculo do Radar lê o mesmo titular do nome cru e do mascarado (private.radar_titular_mascara).
#   G1  as funções de trigger não são executáveis pelo JWT.
# Aplica as definições REAIS da máscara (20261112100000) e do titular (20261111150000), extraídas do arquivo.
#
#   bash db/test-clientes-mei-cpf-mascarado.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-clientes-mei-cpf-mascarado.sh   # tem de ficar VERMELHA
#   bash db/test-clientes-mei-cpf-mascarado.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGS="$REPO_ROOT/supabase/migrations"
MIG="$MIGS/20261113090000_clientes_mei_cpf_mascarado.sql"
MIG_MASCARA="$MIGS/20261112100000_radar_privacidade_cpf_formato_livre.sql"
MIG_TITULAR="$MIGS/20261111150000_radar_privacidade_titular_mei.sql"
MARCA="CLIENTES_MEI_CPF_PROVA_OK"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_trigger:pos so_insert:pos sem_backfill:pos sem_backfill_pos_cega:M1 sem_definer:M3 pre_cega:M7 venda_sem_trigger:pos"
  LOGDIR="$(mktemp -d "/tmp/falsifica-clientes-mei.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "$MARCA" "$LOGDIR/controle.log"; then
    echo "❌ controle sem marcador de fim — falsificação abortada"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; alvo="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: ficou VERDE (o assert $alvo não morde)"; falhas=$((falhas+1)); continue
    fi
    if [ "$alvo" = "pos" ]; then
      if grep -q "FALHOU:" "$LOGDIR/$s.log"; then echo "✅ $s: vermelha na PÓS"; else echo "❌ $s: vermelha, mas não na PÓS (log: $LOGDIR/$s.log)"; falhas=$((falhas+1)); fi
    elif grep -q "^FAIL $alvo\b" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em $alvo"
    else
      echo "❌ $s: vermelha, mas não em $alvo (log: $LOGDIR/$s.log)"; grep -E "^FAIL|ERRO|ERROR" "$LOGDIR/$s.log" | head -3; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5498}"
DATA="$(mktemp -d "/tmp/pgtest-clientes-mei.XXXXXX")/data"
DIR="$(dirname "$DATA")"
MIG_USADA="$DIR/mig.sql"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; tem de ocorrer UMA vez no arquivo)
  python3 - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrao deve ocorrer 1 vez, ocorre %d: %s" % (s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_trigger)  sabotar "  FOR EACH ROW EXECUTE FUNCTION private.cliente_nome_sem_cpf();" "  FOR EACH ROW WHEN (false) EXECUTE FUNCTION private.cliente_nome_sem_cpf();" ;;
  so_insert)    sabotar "  BEFORE INSERT OR UPDATE OF name ON public.profiles" "  BEFORE INSERT ON public.profiles" ;;
  sem_backfill) sabotar "UPDATE public.profiles
   SET name = private.radar_razao_mascarada(name)
 WHERE name ~" "UPDATE public.profiles
   SET name = private.radar_razao_mascarada(name)
 WHERE false AND name ~" ;;
  sem_backfill_pos_cega)
                sabotar "UPDATE public.profiles
   SET name = private.radar_razao_mascarada(name)
 WHERE name ~" "UPDATE public.profiles
   SET name = private.radar_razao_mascarada(name)
 WHERE false AND name ~"
                sabotar "  SELECT count(*) INTO v_n FROM public.profiles WHERE name ~ v_re;
  IF v_n <> 0 THEN" "  SELECT count(*) INTO v_n FROM public.profiles WHERE name ~ v_re;
  IF false THEN" ;;
  sem_definer)  sabotar " RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS \$f\$
BEGIN
  NEW.name :=" " RETURNS trigger LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS \$f\$
BEGIN
  NEW.name :=" ;;
  pre_cega)     sabotar "  IF private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM" "  IF false AND private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM" ;;
  venda_sem_trigger) sabotar "  FOR EACH ROW EXECUTE FUNCTION private.venda_item_razao_sem_cpf();" "  FOR EACH ROW WHEN (false) EXECUTE FUNCTION private.venda_item_razao_sem_cpf();" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DIR/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Q()  { P -qAt -c "$1"; }

# Bloco "CREATE OR REPLACE FUNCTION <nome>(...) … $f$;" copiado do arquivo de migration real.
extrair_funcao() { # $1 = arquivo, $2 = nome qualificado
  python3 - "$1" "$2" <<'PY'
import sys, re
s = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"CREATE OR REPLACE FUNCTION " + re.escape(sys.argv[2]) + r"\(.*?\$f\$;", s, re.S)
if not m:
    sys.exit("função não encontrada: " + sys.argv[2])
print(m.group(0))
PY
}

{
  cat <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE,
  name text NOT NULL,
  document text,
  phone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
CREATE TABLE public.venda_items_history (
  id bigserial PRIMARY KEY,
  nfe_chave_acesso text NOT NULL,
  sku_codigo_omie text NOT NULL,
  cliente_razao_social text,
  quantidade numeric,
  UNIQUE (nfe_chave_acesso, sku_codigo_omie)
);
GRANT ALL ON public.venda_items_history TO service_role;
GRANT USAGE ON SEQUENCE public.venda_items_history_id_seq TO service_role;
SQL
  extrair_funcao "$MIG_MASCARA" "private.radar_razao_mascarada"
  extrair_funcao "$MIG_TITULAR" "private.radar_titular_mascara"
  cat <<'SQL'
REVOKE ALL ON FUNCTION private.radar_razao_mascarada(text) FROM PUBLIC, anon, authenticated;
INSERT INTO public.profiles (id, name, document) VALUES
  ('00000000-0000-0000-0000-000000000001', 'PEDRO ALVES COSTA 12345678901', '12345678000195'),
  ('00000000-0000-0000-0000-000000000002', 'MARIA SOUZA 123.456.789-01', '22345678000195'),
  ('00000000-0000-0000-0000-000000000003', 'JOAO 12345678901 ME', '32345678000195'),
  ('00000000-0000-0000-0000-000000000004', 'ACME LTDA 12345678000195', '42345678000195'),
  ('00000000-0000-0000-0000-000000000005', 'LOJA 1234567890', '52345678000195'),
  ('00000000-0000-0000-0000-000000000006', 'LOJA 123456789012', '62345678000195'),
  ('00000000-0000-0000-0000-000000000007', 'MARCENARIA BOA VISTA', '72345678000195');
SET session_replication_role = replica;  -- o seed fixa o updated_at sem o trigger reescrevê-lo
UPDATE public.profiles SET updated_at = '2026-01-01T00:00:00Z';
SET session_replication_role = origin;
INSERT INTO public.venda_items_history (nfe_chave_acesso, sku_codigo_omie, cliente_razao_social) VALUES
  ('NF1', 'SKU1', 'PEDRO ALVES COSTA 12345678901'),
  ('NF2', 'SKU1', 'MARIA SOUZA 123.456.789-01'),
  ('NF3', 'SKU1', 'ACME LTDA'),
  ('NF4', 'SKU1', NULL);
SQL
} > "$DIR/setup.sql"
P -q -f "$DIR/setup.sql" >/dev/null

FAIL=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; FAIL=$((FAIL+1)); }
igual() { # $1 = id, $2 = obtido, $3 = esperado
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "esperado [$3], veio [$2]"; fi
}

# V1 (antes): o titular que o vínculo lê do nome CRU.
TIT_CRU="$(Q "SELECT private.radar_titular_mascara(substring(name FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)\$')) FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'")"

echo "── apply 1"
P -q -f "$MIG_USADA" > "$DIR/apply1.log" 2>&1 || { cat "$DIR/apply1.log"; echo "ERRO: a migration falhou no 1º apply"; exit 1; }
grep -q "CLIENTES_MEI_CPF_MASCARADO_OK" "$DIR/apply1.log" || { cat "$DIR/apply1.log"; echo "ERRO: apply sem marcador de fim"; exit 1; }

# M1 — backfill
igual M1a "$(Q "SELECT name FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'")" "PEDRO ALVES COSTA ***456789**"
igual M1b "$(Q "SELECT name FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000002'")" "MARIA SOUZA ***.456.789-**"
igual M1c "$(Q "SELECT name FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000003'")" "JOAO ***456789** ME"
igual M1d "$(Q "SELECT string_agg(name, '|' ORDER BY id) FROM public.profiles WHERE id IN ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007')")" "ACME LTDA 12345678000195|LOJA 1234567890|LOJA 123456789012|MARCENARIA BOA VISTA"
igual M1e "$(Q "SELECT string_agg(coalesce(cliente_razao_social, '<nulo>'), '|' ORDER BY nfe_chave_acesso) FROM public.venda_items_history")" "PEDRO ALVES COSTA ***456789**|MARIA SOUZA ***.456.789-**|ACME LTDA|<nulo>"
igual M1f "$(Q "SELECT count(*) FROM public.profiles WHERE updated_at = '2026-01-01T00:00:00Z'")" "4"

# M2 — espelho do teste Deno
igual M2 "$(Q "SELECT string_agg(private.radar_razao_mascarada(s), '|' ORDER BY o) FROM (VALUES
  (1, 'PEDRO ALVES COSTA 12345678901'), (2, 'PEDRO ALVES COSTA 123.456.789-01'), (3, 'PEDRO 12345678901 ALVES'),
  (4, 'PEDRO CPF 123 456 789 01'), (5, 'ACME LTDA 12345678000195'), (6, 'LOJA 1234567890'), (7, 'LOJA 123456789012'),
  (8, 'A1 NOVA LTDA')) v(o, s)")" \
  "PEDRO ALVES COSTA ***456789**|PEDRO ALVES COSTA ***.456.789-**|PEDRO ***456789** ALVES|PEDRO CPF *** 456 789 **|ACME LTDA 12345678000195|LOJA 1234567890|LOJA 123456789012|A1 NOVA LTDA"

# M3 — o cliente logado grava o próprio perfil (sem USAGE em private)
M3="$(P -qAt -c "SET ROLE authenticated;
  INSERT INTO public.profiles (id, user_id, name) VALUES ('00000000-0000-0000-0000-000000000008', gen_random_uuid(), 'ANA LIMA 98765432100') RETURNING name;" 2>&1 | tail -1)" || true
igual M3a "$M3" "ANA LIMA ***654321**"
M3="$(P -qAt -c "SET ROLE authenticated;
  UPDATE public.profiles SET name = 'ANA LIMA 987.654.321-00' WHERE id = '00000000-0000-0000-0000-000000000008' RETURNING name;" 2>&1 | tail -1)" || true
igual M3b "$M3" "ANA LIMA ***.654.321-**"

# M4 — UPDATE de outra coluna não reescreve o name
igual M4 "$(Q "UPDATE public.profiles SET phone = '41999998888' WHERE id = '00000000-0000-0000-0000-000000000007' RETURNING name")" "MARCENARIA BOA VISTA"

# M5 — upsert do sync de itens
igual M5 "$(P -qAt -c "SET ROLE service_role;
  INSERT INTO public.venda_items_history (nfe_chave_acesso, sku_codigo_omie, cliente_razao_social) VALUES ('NF3', 'SKU1', 'CARLOS 11122233344')
  ON CONFLICT (nfe_chave_acesso, sku_codigo_omie) DO UPDATE SET cliente_razao_social = EXCLUDED.cliente_razao_social
  RETURNING cliente_razao_social;" | tail -1)" "CARLOS ***222333**"

# V1 (depois): o titular lido do nome mascarado é o mesmo do cru
igual V1 "$(Q "SELECT private.radar_titular_mascara(substring(name FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)\$')) FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'")" "$TIT_CRU"

# M6 — re-aplicar é inócuo
ANTES="$(Q "SELECT md5(string_agg(id::text || name, ',' ORDER BY id)) FROM public.profiles")"
if P -q -f "$MIG_USADA" > "$DIR/apply2.log" 2>&1 && grep -q "CLIENTES_MEI_CPF_MASCARADO_OK" "$DIR/apply2.log"; then
  igual M6 "$(Q "SELECT md5(string_agg(id::text || name, ',' ORDER BY id)) FROM public.profiles")" "$ANTES"
else
  fail M6 "o 2º apply falhou: $(grep -m1 ERROR "$DIR/apply2.log" || true)"
fi

# G1 — ACL
igual G1 "$(Q "SELECT bool_or(has_function_privilege(r, f, 'EXECUTE')) FROM unnest(ARRAY['anon','authenticated']) r,
  unnest(ARRAY['private.cliente_nome_sem_cpf()','private.venda_item_razao_sem_cpf()']) f")" "f"

# M7 — a PRE recusa a máscara antiga (só no fim, sem separador). Por último: troca a função viva.
Q "CREATE OR REPLACE FUNCTION private.radar_razao_mascarada(p text) RETURNS text LANGUAGE sql IMMUTABLE
   SET search_path TO 'pg_catalog' AS \$f\$ SELECT regexp_replace(p, ' [0-9]{3}([0-9]{6})[0-9]{2}\$', ' ***\1**') \$f\$" >/dev/null
if P -q -f "$MIG_USADA" > "$DIR/apply3.log" 2>&1; then
  fail M7 "a migration aplicou sobre a máscara antiga"
elif grep -q "PRE FALHOU" "$DIR/apply3.log"; then
  ok M7
else
  fail M7 "falhou, mas não na PRE: $(grep -m1 ERROR "$DIR/apply3.log" || true)"
fi

echo "falhas: $FAIL"
[ "$FAIL" -eq 0 ] && echo "$MARCA"
[ "$FAIL" -eq 0 ]
