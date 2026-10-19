#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — identidade Omie por documento aceita CNPJ ALFANUMÉRICO                        ║
# ║  (migration 20261019140000_omie_identidade_cnpj_alfanumerico — follow-up 1 do #3180)          ║
# ║   bash db/test-omie-identidade-cnpj-alfanumerico.sh               (controle)                  ║
# ║   bash db/test-omie-identidade-cnpj-alfanumerico.sh --falsificar  (controle + sabotagens,     ║
# ║                                                                    cada uma numa rodada própria)║
# ║                                                                                               ║
# ║  Mundo: stubs de prod + CASCATA 20260711140000 (PR-1) → 20260821192817 (PR-2/A2, a função     ║
# ║  PREDECESSORA: a PRE da migration exige md5(pg_get_functiondef) = o de PROD, lido por psql-ro  ║
# ║  em 2026-10-19 — repo≠prod fica vermelho aqui, não na mão do founder) → a migration sob prova. ║
# ║   A0  aplica · re-aplicar é no-op (PRE aceita "este") · CHECK vivo é o alfanumérico           ║
# ║   A1  helpers EXECUTADOS: DV (exemplo oficial RFB, DV errado, numérico clássico, minúscula)    ║
# ║       e a chave nos 3 ramos (alnum com máscara/minúscula, anotação+CPF, prefixo "CNPJ:")       ║
# ║   A2  CHECK da evidência: alnum maiúsculo entra; minúscula, máscara, 10 dígitos → 23514;        ║
# ║       numérico ≥ 11 segue entrando                                                            ║
# ║   A3  snapshot (o money-path): profile alnum casa com cliente Omie alnum (client_to_user);      ║
# ║       profile alnum NÃO casa com o numérico de mesma mutilação — o numérico é de OUTRO user e  ║
# ║       vai para ele; o vínculo ANTIGO (evidência mutilada) é REVOGADO; numérico byte-idêntico;  ║
# ║       DV errado não vira chave; 2 users no mesmo alnum → ambíguo                               ║
# ║   A4  ACL: anon/authenticated/PUBLIC sem EXECUTE nas 3 funções; service_role com               ║
# ║  FALSIFICAÇÃO (o vermelho que conta é o do assert DECLARADO em SABOTAGENS), uma camada por vez:║
# ║   chave_so_digitos        normalizar_documento apaga letra (md5 do helper neutralizado) → A3c  ║
# ║   check_so_digitos        CHECK volta a ^[0-9]{11,}$ → A2a                                     ║
# ║   dv_ignorado             DV sempre válido (régua da PÓS neutralizada) → A3g                   ║
# ║   dv_ignorado_pos         DV sempre válido SEM neutralizar a PÓS → A0a (a PÓS executa o helper)║
# ║   rpc_mutila              doc_valid volta ao regexp_replace '\D' (md5 da RPC neutralizado) → A3a║
# ║   corpo_sabotado_md5      corpo sabotado SEM neutralizar o md5 → A0a (a PÓS morde)             ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019140000_omie_identidade_cnpj_alfanumerico.sql"
MIG1="$REPO_ROOT/supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260821192817_omie_identidade_a2_client_to_user.sql"
MD5_PROD="16200d4e779b573dbc88ad5a49f5e4e4"   # md5(pg_get_functiondef) de omie_sync_identity_snapshot(text) em PROD, psql-ro 2026-10-19, search_path=public

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="chave_so_digitos:A3c check_so_digitos:A2a dv_ignorado:A3g dv_ignorado_pos:A0a rpc_mutila:A3a corpo_sabotado_md5:A0a"
  LOGDIR="$(mktemp -d "/tmp/falsifica-omie-alnum.XXXXXX")"
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
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
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
PORT="${PGPORT_TEST:-5503}"
TMPD="$(mktemp -d "/tmp/pgtest-omie-alnum.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

for f in "$MIG" "$MIG1" "$MIG2"; do [ -f "$f" ] || { echo "migration nao encontrada: $f"; exit 1; }; done
cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; troca TODAS as ocorrências)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# A régua de md5 "este" da PRE/PÓS da RPC: o literal de 32 hex em `IS DISTINCT FROM '<md5>'`.
ESTE_MD5="$(grep -oE "IS DISTINCT FROM '[0-9a-f]{32}'" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1)"
MD5_VIVO="(SELECT md5(pg_get_functiondef(q.oid)) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.omie_sync_identity_snapshot(text)'))"
RAMO_ALNUM="    THEN regexp_replace(btrim(upper(p_bruto)), '[-./]', '', 'g')"
case "${SABOTAGEM:-}" in
  "") ;;
  chave_so_digitos)   sabotar "$RAMO_ALNUM" "    THEN regexp_replace(p_bruto, '\\D', '', 'g')" ;;
  check_so_digitos)   sabotar "~ '^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})\$'" "~ '^[0-9]{11,}\$'"
                      sabotar "~ ''^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})\$''" "~ ''^[0-9]{11,}\$''" ;;
  # a PÓS EXECUTA o helper (DV errado tem de dar false): nas duas sabotagens de DV, uma neutraliza
  # essa régua para alcançar o assert FUNCIONAL (A3g) e a outra a deixa viva para provar que a PÓS morde.
  dv_ignorado)        sabotar "RETURN substr(p_doc, 13, 2) = v_d1::text || v_d2::text;" "RETURN true;"
                      sabotar "OR public.cnpj_alfanumerico_valido('12ABC34501DE36')" "OR false" ;;
  dv_ignorado_pos)    sabotar "RETURN substr(p_doc, 13, 2) = v_d1::text || v_d2::text;" "RETURN true;" ;;
  rpc_mutila)         sabotar "SELECT public.normalizar_documento(p.document) AS doc, p.user_id" "SELECT regexp_replace(p.document, '\\D', '', 'g') AS doc, p.user_id"
                      sabotar "AND length(public.normalizar_documento(p.document)) >= 11" "AND length(regexp_replace(p.document, '\\D', '', 'g')) >= 11"
                      sabotar "strpos(v_fn, 'normalizar_documento(p.document)') = 0 OR strpos(v_fn, '\\D') > 0" "false"
                      sabotar "'$ESTE_MD5'" "$MD5_VIVO" ;;
  corpo_sabotado_md5) sabotar "SELECT public.normalizar_documento(p.document) AS doc, p.user_id" "SELECT public.normalizar_documento(btrim(p.document)) AS doc, p.user_id" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prova
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1 $2"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1 $2"; }
# eq ID descrição valor esperado
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
# Mensagem de erro de um INSERT que deve falhar (vazia se passou). Casa a constraint NOMEADA.
erro_de() { P -c "$1" 2>&1 >/dev/null | grep -oE 'violates check constraint "[a-z_]+"' | head -1 || true; }
# roda como service_role (o role REAL do edge) e pega a ULTIMA linha (psql ecoa "SET")
RS()  { Pq -c "SET ROLE service_role; $1" | tail -1; }
SNAP="public.omie_sync_identity_snapshot('oben')"

P -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
-- omie_customer_account_map FIEL a prod (conferido por psql-ro em 2026-08-21 no harness do A2): colunas + uniques reais.
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text);
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account text NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_vendedor bigint,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ocam_user_account   ON public.omie_customer_account_map (user_id, account);
CREATE UNIQUE INDEX uq_ocam_codigo_account ON public.omie_customer_account_map (omie_codigo_cliente, account);
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
SQL
P -f "$MIG1" >/dev/null
P -f "$MIG2" >/dev/null
P -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;"
echo "=== setup pronto (PG17 :$PORT): stubs + PR-1 + PR-2/A2 ==="

# Seeds ANTES da migration: o mundo como o escritor VELHO (mutilador) o deixou — inclusive o vínculo
# ERRADO que o snapshot mutilador fabricava (U3 alnum provado pela evidência 12345678909, que é o CPF de U2).
P <<'SQL'
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', '12.abc.345/01de-35'),   -- U1 alfanumérico MINÚSCULO com máscara (exemplo oficial RFB) → 12ABC34501DE35
  ('00000000-0000-0000-0000-000000000002', '123.456.789-09'),       -- U2 CPF numérico com máscara → 12345678909
  ('00000000-0000-0000-0000-000000000003', 'AEG12345678909'),       -- U3 alfanumérico VÁLIDO cuja mutilação só-dígitos é o CPF de U2 (Codex ALTO #3180)
  ('00000000-0000-0000-0000-000000000004', '11.222.333/0001-81'),   -- U4 CNPJ numérico com máscara → 11222333000181 (byte-idêntico)
  ('00000000-0000-0000-0000-000000000005', '12ABC34501DE36'),       -- U5 alfanumérico com DV ERRADO → só-dígitos 123450136 (9) → fora
  ('00000000-0000-0000-0000-000000000006', 'aeg 987.654.321-00'),   -- U6 CPF com ANOTAÇÃO (espaço interno) → 98765432100, nunca AEG98765432100
  ('00000000-0000-0000-0000-000000000007', 'a1b2c3d4e5f668'),       -- U7 alfanumérico minúsculo cru → A1B2C3D4E5F668
  ('00000000-0000-0000-0000-000000000008', '1234567800A126'),       -- U8 ┐ mesmo alfanumérico em 2 users → ambíguo
  ('00000000-0000-0000-0000-000000000009', '1234567800A126');       -- U9 ┘
-- Vínculos como o escritor os grava (source='document', evidência = a chave que casou):
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source) VALUES
  ('00000000-0000-0000-0000-000000000002', 'oben', 200, 'document'),   -- U2 ← cliente Omie numérico 12345678909
  ('00000000-0000-0000-0000-000000000003', 'oben', 300, 'document'),   -- U3 ← vínculo ANTIGO: evidência mutilada 12345678909 (errado: é o doc de U2)
  ('00000000-0000-0000-0000-000000000004', 'oben', 400, 'document');   -- U4 ← numérico
UPDATE public.omie_customer_account_map SET evidence_document_normalized = '12345678909'    WHERE omie_codigo_cliente IN (200, 300);
UPDATE public.omie_customer_account_map SET evidence_document_normalized = '11222333000181' WHERE omie_codigo_cliente = 400;
SQL

echo "── A0 aplicação"
eq A0p "predecessor local = PROD (md5 pg_get_functiondef)" "$(Pq -c "SET search_path = public; SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=to_regprocedure('public.omie_sync_identity_snapshot(text)')" | tail -1)" "$MD5_PROD"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok A0a "migration aplica"; else bad A0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-200)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok A0b "re-aplicar é no-op (PRE aceita 'este')"; else bad A0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-200)"; fi
eq A0c "CHECK vivo da evidência é o alfanumérico" "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.omie_customer_account_map'::regclass AND conname='ocam_evidence_document_normalizado_chk'")" "CHECK (((evidence_document_normalized IS NULL) OR (evidence_document_normalized ~ '^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})\$'::text)))"

echo "── A1 helpers executados"
eq A1a "DV: exemplo oficial RFB 12ABC34501DE35 válido" "$(RS "SELECT public.cnpj_alfanumerico_valido('12ABC34501DE35')")" "t"
eq A1b "DV: 12ABC34501DE36 (DV errado) inválido" "$(RS "SELECT public.cnpj_alfanumerico_valido('12ABC34501DE36')")" "f"
eq A1c "DV: numérico clássico 11222333000181 válido (mesma regra)" "$(RS "SELECT public.cnpj_alfanumerico_valido('11222333000181')")" "t"
eq A1d "DV: minúscula é inválida (fail-closed)" "$(RS "SELECT public.cnpj_alfanumerico_valido('12abc34501de35')")" "f"
eq A1e "DV: AEG12345678909 válido (o literal do Codex ALTO é um CNPJ alnum legítimo)" "$(RS "SELECT public.cnpj_alfanumerico_valido('AEG12345678909')")" "t"
eq A1f "chave: alnum minúsculo com máscara → maiúsculo sem separadores" "$(RS "SELECT public.normalizar_documento('12.abc.345/01de-35')")" "12ABC34501DE35"
eq A1g "chave: anotação + CPF (espaço interno) → só-dígitos" "$(RS "SELECT public.normalizar_documento('aeg 123.456.789-09')")" "12345678909"
eq A1h "chave: prefixo 'CNPJ:' + numérico → só-dígitos (acervo intocado)" "$(RS "SELECT public.normalizar_documento('CNPJ: 22.333.444/0001-81')")" "22333444000181"
eq A1i "chave: numérico com máscara byte-idêntico ao regexp_replace '\\D'" "$(RS "SELECT public.normalizar_documento('11.222.333/0001-81') = regexp_replace('11.222.333/0001-81', '\\D', '', 'g')")" "t"
eq A1j "chave: alnum com DV errado → só-dígitos (não se fabrica documento)" "$(RS "SELECT public.normalizar_documento('12ABC34501DE36')")" "123450136"

echo "── A2 CHECK da evidência"
if P -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized) VALUES ('00000000-0000-0000-0000-000000000001','oben',100,'document','12ABC34501DE35')" >/dev/null 2>&1; then ok A2a "alfanumérico maiúsculo entra"; else bad A2a "alfanumérico maiúsculo recusado"; fi
eq A2b "minúscula → check_violation" "$(erro_de "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized) VALUES ('00000000-0000-0000-0000-000000000005','oben',500,'document','12abc34501de35')")" 'violates check constraint "ocam_evidence_document_normalizado_chk"'
eq A2c "com máscara → check_violation" "$(erro_de "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized) VALUES ('00000000-0000-0000-0000-000000000005','oben',500,'document','12.ABC.345/01DE-35')")" 'violates check constraint "ocam_evidence_document_normalizado_chk"'
eq A2d "10 dígitos → check_violation (o piso numérico de 11 segue)" "$(erro_de "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized) VALUES ('00000000-0000-0000-0000-000000000005','oben',500,'document','1234530135')")" 'violates check constraint "ocam_evidence_document_normalizado_chk"'
if P -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized) VALUES ('00000000-0000-0000-0000-000000000006','oben',600,'document','98765432100')" >/dev/null 2>&1; then ok A2e "numérico 11 dígitos segue entrando"; else bad A2e "numérico 11 dígitos recusado"; fi

echo "── A3 snapshot (money-path)"
U1=00000000-0000-0000-0000-000000000001; U2=00000000-0000-0000-0000-000000000002; U3=00000000-0000-0000-0000-000000000003
U4=00000000-0000-0000-0000-000000000004; U6=00000000-0000-0000-0000-000000000006; U7=00000000-0000-0000-0000-000000000007
eq A3a "profile alnum AEG12345678909 é chave COM letras em doc_to_user → U3" "$(RS "SELECT $SNAP->'doc_to_user'->>'AEG12345678909'")" "$U3"
eq A3b "profile alnum casa com cliente Omie alnum (código 100 → U1)" "$(RS "SELECT $SNAP->'client_to_user'->>'100'")" "$U1"
eq A3c "numérico 12345678909 NÃO é ambíguo: vai para U2 (a mutilação de U3 não colide mais)" "$(RS "SELECT $SNAP->'doc_to_user'->>'12345678909'")" "$U2"
eq A3d "cliente Omie numérico 200 → U2 (não ao profile alnum)" "$(RS "SELECT $SNAP->'client_to_user'->>'200'")" "$U2"
eq A3e "vínculo ANTIGO de U3 (evidência mutilada) fica FORA de client_to_user" "$(RS "SELECT $SNAP->'client_to_user' ? '300'")" "f"
eq A3f "…e é REVOGADO (a evidência já não sustenta o user)" "$(RS "SELECT $SNAP->'revoked_client_codes' @> '[\"300\"]'::jsonb")" "t"
eq A3g "alnum com DV errado (U5) não vira chave (nem alnum nem 9 dígitos)" "$(RS "SELECT ($SNAP->'doc_to_user' ? '12ABC34501DE36') OR ($SNAP->'doc_to_user' ? '123450136')")" "f"
eq A3h "numérico com máscara byte-idêntico: 11222333000181 → U4 e código 400 → U4" "$(RS "SELECT ($SNAP->'doc_to_user'->>'11222333000181' = '$U4') AND ($SNAP->'client_to_user'->>'400' = '$U4')")" "t"
eq A3i "anotação + CPF (U6) chaveia pelos dígitos, nunca AEG98765432100" "$(RS "SELECT ($SNAP->'doc_to_user'->>'98765432100' = '$U6') AND NOT ($SNAP->'doc_to_user' ? 'AEG98765432100')")" "t"
eq A3j "alnum minúsculo cru (U7) → chave maiúscula" "$(RS "SELECT $SNAP->'doc_to_user'->>'A1B2C3D4E5F668'")" "$U7"
eq A3k "2 users no mesmo alnum → ambíguo (fora de doc_to_user)" "$(RS "SELECT ($SNAP->'ambiguous_docs' @> '[\"1234567800A126\"]'::jsonb) AND NOT ($SNAP->'doc_to_user' ? '1234567800A126')")" "t"
eq A3l "disjunção: nenhum doc em doc_to_user E ambiguous_docs" "$(RS "SELECT count(*) FROM jsonb_object_keys($SNAP->'doc_to_user') k WHERE ($SNAP->'ambiguous_docs') ? k")" "0"

echo "── A4 ACL"
for fn in 'omie_sync_identity_snapshot(text)' 'normalizar_documento(text)' 'cnpj_alfanumerico_valido(text)'; do
  tag="${fn%%(*}"
  eq "A4a-$tag" "anon/authenticated/PUBLIC sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.$fn','EXECUTE') OR has_function_privilege('authenticated','public.$fn','EXECUTE') OR has_function_privilege('public','public.$fn','EXECUTE')")" "f"
  eq "A4b-$tag" "service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','public.$fn','EXECUTE')")" "t"
done

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-omie-identidade-cnpj-alfanumerico: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
