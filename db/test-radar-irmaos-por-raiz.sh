#!/usr/bin/env bash
# Prova PG17 do selo de FILIAL do Radar (migration 20261021090000): `radar_irmaos_por_raiz(p_cnpjs)` devolve,
# por CNPJ pedido, os outros leads da mesma raiz na fila, os clientes da mesma raiz (profiles + Omie não
# vinculado + radar.ja_cliente) e um nome de cliente — com o gate de carteira da policy da fila (42501),
# teto de 200 CNPJs (22023), sem contar o próprio CNPJ nem descartado, sem escrever nada, ACL sem anon.
# Aplica a migration REAL sobre um esquema mínimo; `radar_docs_clientes()` é o corpo de PROD (pg_get_functiondef
# de 2026-10-21). O gate roda sob SET ROLE authenticated + GUC de JWT, como o PostgREST.
#
#   bash db/test-radar-irmaos-por-raiz.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-irmaos-por-raiz.sh   # tem de ficar VERMELHA
#   bash db/test-radar-irmaos-por-raiz.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021090000_radar_irmaos_por_raiz.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da migration aborta o apply.
  # Sabotagem no corpo muda o md5 (post:A2), então cada uma também cega o A2 (`cegar_md5`).
  SABOTAGENS="sem_gate:A1 conta_descartado:A3 conta_o_proprio:A6 sem_teto:A9 sem_profiles:A4 sem_omie:A5 sem_radar_cliente:A7 conta_cliente_na_fila:A7 anon_executa:post:A3 anon_executa_sem_post:A10 corpo_divergente:post:A2"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-irmaos.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5494}"
DATA="$(mktemp -d "/tmp/pgtest-radar-irmaos.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
cegar_md5() { sabotar "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)              cegar_md5; sabotar "  IF NOT COALESCE(private.cap_carteira_ler(auth.uid()), false) THEN" "  IF false THEN" ;;
  conta_descartado)      cegar_md5; sabotar "        AND NOT r.ja_cliente AND r.prospeccao_status <> 'descartado')," "        AND NOT r.ja_cliente)," ;;
  conta_cliente_na_fila) cegar_md5; sabotar "        AND NOT r.ja_cliente AND r.prospeccao_status <> 'descartado')," "        AND r.prospeccao_status <> 'descartado')," ;;
  conta_o_proprio)       cegar_md5; sabotar "      WHERE left(c.doc, 8) = p.raiz AND c.doc <> p.cnpj)," "      WHERE left(c.doc, 8) = p.raiz)," ;;
  sem_teto)              cegar_md5; sabotar "  IF COALESCE(cardinality(p_cnpjs), 0) > 200 THEN" "  IF false THEN" ;;
  sem_profiles)          cegar_md5; sabotar "    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d" "    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d WHERE d.doc !~ '^1'" ; sabotar "WHERE d.doc !~ '^1'
     WHERE left" "WHERE d.doc !~ '^1'
     AND left" ;;
  sem_omie)              cegar_md5; sabotar "    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d" "    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d WHERE d.doc !~ '^2'" ; sabotar "WHERE d.doc !~ '^2'
     WHERE left" "WHERE d.doc !~ '^2'
     AND left" ;;
  sem_radar_cliente)     cegar_md5; sabotar "     WHERE r.ja_cliente AND left(r.cnpj, 8) IN (SELECT raiz FROM pedidos)" "     WHERE false" ;;
  anon_executa)          sabotar "REVOKE ALL ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.radar_irmaos_por_raiz(text[]) TO anon;" ;;
  anon_executa_sem_post) sabotar "REVOKE ALL ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.radar_irmaos_por_raiz(text[]) TO anon;"
                         sabotar "  IF has_function_privilege('anon', 'public.radar_irmaos_por_raiz(text[])', 'EXECUTE') THEN" "  IF false THEN" ;;
  corpo_divergente)      sabotar "  ORDER BY p.cnpj;" "  ORDER BY  p.cnpj;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE SCHEMA private;
-- Gate de carteira: só o usuário 'aaaaaaaa-…' (gestor) lê.
CREATE FUNCTION private.cap_carteira_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT p = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text,
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  updated_at timestamptz NOT NULL DEFAULT '2026-06-15 00:00+00');
CREATE TABLE public.profiles (document text, razao_social text, name text);
CREATE TABLE public.omie_clientes_nao_vinculados (cnpj_cpf text, razao_social text, nome_fantasia text);
-- Corpo de PROD de radar_docs_clientes() (pg_get_functiondef, 2026-10-21), com a ACL de prod.
CREATE OR REPLACE FUNCTION public.radar_docs_clientes()
 RETURNS TABLE(doc text, nome text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH brutos AS (
    SELECT document AS bruto,
           COALESCE(NULLIF(btrim(razao_social), ''), NULLIF(btrim(name), '')) AS nome
      FROM public.profiles WHERE document IS NOT NULL
    UNION ALL
    SELECT cnpj_cpf,
           COALESCE(NULLIF(btrim(razao_social), ''), NULLIF(btrim(nome_fantasia), ''))
      FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf IS NOT NULL
  ),
  alnum AS (
    SELECT regexp_replace(d, '[-./]', '', 'g') AS doc, nome
      FROM (SELECT btrim(upper(bruto)) AS d, nome FROM brutos) x
     WHERE d ~ '^[0-9A-Z]{12}[0-9]{2}$'
        OR d ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$'
  ),
  candidatos AS (
    SELECT regexp_replace(bruto, '[^0-9]', '', 'g') AS doc, nome FROM brutos
    UNION ALL
    SELECT doc, nome FROM alnum
  )
  SELECT DISTINCT ON (doc) doc, nome
    FROM candidatos
   WHERE doc ~ '^[0-9A-Z]{12}[0-9]{2}$'
   ORDER BY doc, nome NULLS LAST;
$function$;
REVOKE ALL ON FUNCTION public.radar_docs_clientes() FROM PUBLIC, anon, authenticated;
SQL

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

# Raiz 11111111 (só numérico): 3 leads (L1, L2, L3-descartado) + 1 cliente via PROFILES (com máscara).
# Raiz 22222222: lead + cliente via OMIE não vinculado. Raiz 33333333: lead + cliente marcado no RADAR (ja_cliente).
# Raiz 44444444: lead sozinho. Raiz 12ABC345 (alfanumérica): 2 leads + cliente alfanumérico via profiles.
Pq -c "INSERT INTO public.radar_empresas (cnpj, razao_social, ja_cliente, prospeccao_status) VALUES
  ('11111111000101','L1',false,'a_contatar'), ('11111111000202','L2',false,'em_conversa'),
  ('11111111000303','L3',false,'descartado'),
  ('22222222000101','M1',false,'a_contatar'),
  ('33333333000101','N1',false,'a_contatar'), ('33333333000202','RADAR CLIENTE SA',true,'a_contatar'),
  ('44444444000101','S1',false,'a_contatar'),
  ('12ABC34501DE35','A1',false,'a_contatar'), ('12ABC34502FG35','A2',false,'a_contatar');
INSERT INTO public.profiles (document, razao_social, name) VALUES
  ('11.111.111/0009-09','PROFILES CLIENTE LTDA',NULL), ('12.ABC.345/0099-35','ALFA CLIENTE',NULL), ('123.456.789-00',NULL,'Pessoa');
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf, razao_social, nome_fantasia) VALUES
  ('22222222000909','OMIE CLIENTE ME',NULL);" >/dev/null

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
VENDEDOR='{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}'
como() { # $1 = claims, $2 = array literal
  P -qAt <<SQL 2>&1 || true   # a recusa (42501/22023) é esperada em A1/A9: quem julga é o assert, não o set -e
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false);
SELECT string_agg(cnpj||'='||irmaos_na_fila||'/'||irmaos_clientes||'/'||coalesce(cliente_nome,'-'), ' ' ORDER BY cnpj)
  FROM public.radar_irmaos_por_raiz($2);
SQL
}
linha() { como "$GESTOR" "$1" | tail -1; }

eq "A0 corpo vivo = o do arquivo aplicado (a migration, ou a cópia sabotada)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.radar_irmaos_por_raiz(text[])');")" \
   "$(python3 -I -c 'import sys,hashlib;s=open(sys.argv[1],encoding="utf-8").read();a=s.index("AS $function$")+13;print(hashlib.md5(s[a:s.index("$function$;",a)].encode()).hexdigest())' "$MIG_USADA")"

SAIDA1="$(como "$VENDEDOR" "ARRAY['11111111000101']")"
case "$SAIDA1" in *"forbidden: carteira"*) M1="negado";; *) M1="LIBEROU";; esac
case "$SAIDA1" in *"11111111000101="*) V1="vazou";; *) V1="sem-dado";; esac
eq "A1 sem permissão de carteira: 42501 e nenhum dado" "$M1 $V1" "negado sem-dado"

eq "A2 gestor lê" "$(linha "ARRAY['44444444000101']")" "44444444000101=0/0/-"

eq "A3 irmãos na fila: L1 vê L2 (L3 descartado e o cliente não contam)" \
   "$(linha "ARRAY['11111111000101']")" "11111111000101=1/1/PROFILES CLIENTE LTDA"

eq "A4 cliente via profiles (documento com máscara) conta na raiz" \
   "$(linha "ARRAY['11111111000202']" | cut -d/ -f2-)" "1/PROFILES CLIENTE LTDA"

eq "A5 cliente via Omie não vinculado conta na raiz" "$(linha "ARRAY['22222222000101']")" "22222222000101=0/1/OMIE CLIENTE ME"

eq "A6 o próprio CNPJ não conta como irmão nem como cliente (o cliente pedido vê 0 clientes além dele)" \
   "$(linha "ARRAY['33333333000202']")" "33333333000202=1/0/-"

eq "A7 cliente marcado no radar (ja_cliente) conta na raiz" "$(linha "ARRAY['33333333000101']")" "33333333000101=0/1/RADAR CLIENTE SA"

eq "A8 CNPJ fora do formato é ignorado; repetido sai uma vez; alfanumérico funciona" \
   "$(linha "ARRAY['12ABC34501DE35','12ABC34501DE35','xx','123']")" "12ABC34501DE35=1/1/ALFA CLIENTE"

SAIDA9="$(como "$GESTOR" "(SELECT array_agg(lpad(g::text,12,'0')||'00') FROM generate_series(1,201) g)")"
case "$SAIDA9" in *"no máximo 200"*) M9="recusou";; *) M9="aceitou";; esac
eq "A9 mais de 200 CNPJs: recusa com 22023" "$M9" "recusou"

eq "A10 anon NÃO executa; authenticated e service_role executam" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.radar_irmaos_por_raiz(text[])','EXECUTE')::text||' '||has_function_privilege('authenticated','public.radar_irmaos_por_raiz(text[])','EXECUTE')::text||' '||has_function_privilege('service_role','public.radar_irmaos_por_raiz(text[])','EXECUTE')::text;")" \
   "false true true"

eq "A11 nada foi escrito (função de leitura)" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE updated_at <> '2026-06-15 00:00+00';")" "0"

eq "A12 índice por raiz existe e o planner o usa para a raiz pedida" \
   "$(Pq -c "SET enable_seqscan = off; EXPLAIN SELECT 1 FROM public.radar_empresas WHERE left(cnpj,8) = '11111111';" | grep -c idx_radar_empresas_raiz)" "1"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_IRMAOS_PROVA_OK"
[ "$FAIL" -eq 0 ]
