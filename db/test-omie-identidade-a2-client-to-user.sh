#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — PR-2 / achado A2: prova positiva `client_to_user` no snapshot atômico            ║
# ║  Migrations (CASCATA, nesta ordem):                                                            ║
# ║    supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql        (PR-1, base)      ║
# ║    supabase/migrations/20260821192817_omie_identidade_a2_client_to_user.sql  (PR-2, sob teste) ║
# ║  Rode:  bash db/test-omie-identidade-a2-client-to-user.sh > /tmp/t.log 2>&1; echo "exit=$?"    ║
# ║                                                                                                ║
# ║  TODOS os asserts rodam contra a versão FINAL (PR-2) — o harness não valida a versão            ║
# ║  intermediária de cada fase (armadilha "O HARNESS mente", money-path.md).                       ║
# ║                                                                                                ║
# ║  O que prova: um vínculo só entra em client_to_user com evidência PRESENTE, ÚNICA e             ║
# ║  CONSISTENTE (o dono ATUAL daquele doc é o MESMO user do vínculo), na conta certa, com          ║
# ║  source='document' e dentro do TTL de 7d. Falsificação: cada defesa é sabotada SOZINHA          ║
# ║  (duas defesas sabotadas juntas não provam que qualquer uma tem dente — money-path.md).         ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="omie-identidade-a2"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }
# roda como service_role (o role REAL do edge) e pega a ULTIMA linha (psql ecoa "SET")
RS()  { Pq -c "SET ROLE service_role; $1" | tail -1; }

U1=00000000-0000-0000-0000-000000000001
U2=00000000-0000-0000-0000-000000000002
U3=00000000-0000-0000-0000-000000000003
U4=00000000-0000-0000-0000-000000000004
U5=00000000-0000-0000-0000-000000000005
U6=00000000-0000-0000-0000-000000000006
U8=00000000-0000-0000-0000-000000000008
U9=00000000-0000-0000-0000-000000000009
U10=00000000-0000-0000-0000-000000000010
U11=00000000-0000-0000-0000-000000000011
FN='public.omie_sync_identity_snapshot(text)'
echo "=== setup pronto (PG17 :$PORT) ==="

# ══ ZONA 1 — pré-requisitos: o que as migrations LEEM mas nao criam ══
# omie_customer_account_map FIEL a prod (conferido por psql-ro em 2026-08-21): colunas + os 3 unique
# indexes reais. A UNIQUE(omie_codigo_cliente, account) importa: ela e o motivo de o seed nao poder
# reusar codigo dentro da mesma conta.
P -q <<'SQL'
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
CREATE INDEX idx_ocam_user ON public.omie_customer_account_map (user_id);
SQL

# ══ ZONA 2 — aplicar as migrations REAIS em cascata (Lei #1) ══
MIG1="$REPO_ROOT/supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260821192817_omie_identidade_a2_client_to_user.sql"
P -q -f "$MIG1"
P -q -f "$MIG2"
echo "migrations aplicadas: $(basename "$MIG1") -> $(basename "$MIG2")"

# SENTINELA anti-teatro: se o arquivo sob teste nao tiver mesmo o corpo novo, TUDO abaixo e ruido.
# (Ancora no nome da CTE, que so a PR-2 introduz; a PR-1 tem o placeholder '{}'.)
SENT=$(Pq -c "SELECT (pg_get_functiondef(to_regprocedure('$FN')::oid) LIKE '%client_prova%');")
[ "$SENT" = "t" ] || { echo "SENTINELA VERMELHA: a funcao carregada nao e a do PR-2 (sem client_prova) -- abortando"; exit 1; }

# ══ ZONA 3 — seed ══
# RLS ON em profiles prova o caminho SECURITY INVOKER + service_role BYPASSRLS (Codex challenge PR-1).
P -q <<'SQL'
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
INSERT INTO auth.users(id) SELECT ('00000000-0000-0000-0000-0000000000' || lpad(i::text,2,'0'))::uuid
  FROM generate_series(1,11) i ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, document) VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111111'),  -- unico
  ('00000000-0000-0000-0000-000000000002', '22222222222'),  -- ambiguo com u3
  ('00000000-0000-0000-0000-000000000003', '22222222222'),  -- ambiguo com u2
  ('00000000-0000-0000-0000-000000000004', '333.333.333-33'), -- unico, normaliza da mascara
  ('00000000-0000-0000-0000-000000000005', '44444444444'),  -- unico (dono ATUAL nao bate com o vinculo V4)
  ('00000000-0000-0000-0000-000000000006', '55555555555'),  -- unico, mas o vinculo dele nao tem evidence
  ('00000000-0000-0000-0000-000000000008', '66666666666'),  -- unico, vinculo source='rpc'
  ('00000000-0000-0000-0000-000000000009', '77777777777'),  -- unico, vinculo source='manual'
  ('00000000-0000-0000-0000-000000000010', '88888888888');  -- unico, vinculo STALE (>7d)
-- u11 existe em auth.users e NAO tem profile: o doc da evidencia dele sumiu do mundo.
GRANT SELECT ON public.profiles                  TO service_role;
GRANT SELECT ON public.omie_customer_account_map TO service_role;

INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized, updated_at) VALUES
  -- DEVEM entrar em client_to_user('oben')
  ('00000000-0000-0000-0000-000000000001','oben',   101,'document','11111111111', now()),
  ('00000000-0000-0000-0000-000000000004','oben',   104,'document','33333333333', now()),
  -- DEVE entrar em client_to_user('colacor') e NAO em 'oben' (isolamento por conta)
  ('00000000-0000-0000-0000-000000000001','colacor',201,'document','11111111111', now()),
  -- NAO devem entrar:
  ('00000000-0000-0000-0000-000000000006','oben',   106,'document', NULL,         now()),  -- N1 evidencia AUSENTE
  ('00000000-0000-0000-0000-000000000005','oben',   105,'document','11111111111', now()),  -- N2 evidencia TROCADA (o doc e do u1)
  ('00000000-0000-0000-0000-000000000002','oben',   102,'document','22222222222', now()),  -- N3 evidencia AMBIGUA
  ('00000000-0000-0000-0000-000000000008','oben',   108,'rpc',     '66666666666', now()),  -- N5a source rpc
  ('00000000-0000-0000-0000-000000000009','oben',   109,'manual',  '77777777777', now()),  -- N5b source manual
  ('00000000-0000-0000-0000-000000000010','oben',   110,'document','88888888888', now() - interval '8 days'), -- N6 STALE
  ('00000000-0000-0000-0000-000000000011','oben',   111,'document','99999999999', now());  -- N7 profile inexistente
SQL

# ══ ZONA 4 — asserts ══
echo "-- asserts: coluna + CHECK --"
eq "C0 coluna evidence_document_normalized existe" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='omie_customer_account_map' AND column_name='evidence_document_normalized';")" "1"
eq "C0b a coluna e NULLABLE (NULL = sem prova; backfill fail-closed depende disto)" \
   "$(Pq -c "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='omie_customer_account_map' AND column_name='evidence_document_normalized';")" "YES"

# CHECK: captura a SQLSTATE ESPERADA e RE-LANCA o resto (Lei #2). A sentinela NAO contem texto que o
# codigo emita -- e um marcador proprio.
chk_rejeita() { # $1=valor $2=rotulo
  R=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized)
  VALUES ('$U3','zztest', 9001, 'document', '$1');
  RAISE NOTICE 'SENT_PASSOU_INDEVIDO';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'SENT_BARROU_23514';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in
    *SENT_BARROU_23514*) ok "$2" ;;
    *) bad "$2 -- nao veio 23514; saida: $R" ;;
  esac
}
chk_rejeita '123.456.789-01' "C1 CHECK rejeita doc FORMATADO (o writer inerte falharia alto, nao em silencio)"
chk_rejeita '1234567890'     "C2 CHECK rejeita doc com <11 digitos"

echo "-- asserts: prova positiva (o que DEVE entrar) --"
eq "P1 101 -> u1 (evidencia presente, unica e consistente)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'101';")" "$U1"
eq "P2 104 -> u4 (evidencia com mascara normaliza igual ao doc_to_user)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'104';")" "$U4"
eq "P3 DENOMINADOR: client_to_user('oben') tem EXATAMENTE 2 chaves (nada mais vazou)" \
   "$(RS "SELECT count(*) FROM jsonb_object_keys(public.omie_sync_identity_snapshot('oben')->'client_to_user');")" "2"
eq "P4 conta colacor ve o SEU vinculo (201 -> u1)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('colacor')->'client_to_user'->>'201';")" "$U1"
eq "P5 DENOMINADOR: client_to_user('colacor') tem EXATAMENTE 1 chave" \
   "$(RS "SELECT count(*) FROM jsonb_object_keys(public.omie_sync_identity_snapshot('colacor')->'client_to_user');")" "1"
eq "P6 conta desconhecida -> objeto VAZIO (nunca NULL: o parser do edge exige objeto)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('conta_que_nao_existe')->>'client_to_user';")" "{}"

echo "-- asserts: fail-closed (o que NAO pode entrar) --"
eq "N1 evidencia AUSENTE (NULL) fica FORA -- e o estado das 16.118 linhas de hoje" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '106';")" "f"
eq "N2 evidencia TROCADA fica FORA -- ACHADO A2: o doc migrou de dono e o vinculo velho morre" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '105';")" "f"
eq "N2b e o codigo 105 nao aparece apontando pro dono NOVO do doc tampouco" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'105') IS NULL;")" "t"
eq "N3 evidencia AMBIGUA fica FORA (design 6: doc ambiguo MATA o vinculo, nao o preserva)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '102';")" "f"
eq "N4 vinculo de OUTRA conta nao vaza para 'oben' (codigo Omie e numerado por conta)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '201';")" "f"
eq "N5a source='rpc' fica FORA (v1 so document)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '108';")" "f"
eq "N5b source='manual' fica FORA (v1 so document)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '109';")" "f"
eq "N6 vinculo STALE (>7d) fica FORA -- espelha o TTL da view omie_customer_account_map_fresco" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '110';")" "f"
eq "N7 profile do dono sumiu -> evidencia sem lastro fica FORA" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '111';")" "f"

echo "-- asserts: nao-regressao do PR-1 (as outras 2 chaves) --"
eq "R1 doc_to_user segue resolvendo doc unico" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'11111111111';")" "$U1"
eq "R2 doc ambiguo segue FORA de doc_to_user" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;")" "t"
eq "R3 doc ambiguo segue LISTADO em ambiguous_docs" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"22222222222\"]';")" "t"
eq "R4 as 3 chaves do contrato continuam presentes" \
   "$(RS "SELECT (s ? 'doc_to_user') AND (s ? 'ambiguous_docs') AND (s ? 'client_to_user') FROM (SELECT public.omie_sync_identity_snapshot('oben') s) t;")" "t"

echo "-- asserts: gate (PII: documento + user_id) --"
eq "G1 service_role TEM execute"           "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"
eq "G2 anon SEM execute"                   "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
eq "G3 authenticated SEM execute"          "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "G4 PUBLIC SEM execute"                 "$(Pq -c "SELECT has_function_privilege('public','$FN','EXECUTE');")" "f"
eq "G5 segue SECURITY INVOKER (prosecdef=false)" \
   "$(Pq -c "SELECT prosecdef FROM pg_proc WHERE proname='omie_sync_identity_snapshot';")" "f"
eq "G6 segue STABLE (provolatile='s') -- snapshot atomico depende disto" \
   "$(Pq -c "SELECT provolatile FROM pg_proc WHERE proname='omie_sync_identity_snapshot';")" "s"

# ══ ZONA 5 — FALSIFICACAO (Lei #3) ══
# Cada defesa e sabotada SOZINHA, por `sed` cirurgico sobre a migration REAL -- assim o mutante e
# provadamente "a versao que vai a producao MENOS uma defesa", nao uma reescrita a mao que poderia
# divergir em outra coisa. Sabotar duas juntas nao provaria que qualquer uma tem dente.
echo "-- falsificacao (cada defesa sozinha) --"
MUT="$(mktemp /tmp/mut-a2.XXXXXX.sql)"
trap 'rm -f "$MUT"; cleanup' EXIT

# $1=rotulo  $2=expressao do assert  $3=valor com a migration REAL  $4=valor esperado SOB o mutante  $5..=seds
falsifica() {
  local rotulo="$1" expr="$2" real="$3" sob="$4"; shift 4
  cp "$MIG2" "$MUT"
  local s
  for s in "$@"; do sed "$s" "$MUT" > "$MUT.tmp" && mv "$MUT.tmp" "$MUT"; done
  # Guard anti-teatro: sed que nao casou nada produziria um "mutante" identico ao real -- a
  # falsificacao pareceria fraca (ou forte) por acidente. Sem isto o passo nao mede nada.
  if cmp -s "$MIG2" "$MUT"; then bad "$rotulo -- SABOTAGEM NO-OP (o sed nao casou; a falsificacao nao mediu nada)"; return; fi
  P -q -f "$MUT" >/dev/null
  local v; v="$(RS "$expr")"
  if [ "$v" = "$sob" ]; then ok "$rotulo -- sob o mutante a expressao vira [$v] => o assert ficaria VERMELHO"
  else bad "$rotulo -- mutante NAO moveu a expressao (veio [$v], esperado [$sob]) => assert sem dente"; fi
  # restaura a migration verdadeira e reconfirma o verde
  P -q -f "$MIG2" >/dev/null
  local r; r="$(RS "$expr")"
  eq "$rotulo restaurado" "$r" "$real"
}

Q105="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '105';"
Q106="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '106';"
Q102="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '102';"
Q201="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '201';"
Q108="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '108';"
Q110="SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user' ? '110';"

# F1 -- CONSISTENCIA (o achado A2 literal). O mutante e o fail-open do status quo: devolve o dono do
# VINCULO sem exigir que a evidencia ainda aponte para ele. Duas edicoes porque a defesa vive em dois
# pontos do mesmo predicado (o filtro E a escolha da coluna devolvida).
falsifica "F1 consistencia da evidencia (N2)" "$Q105" "f" "t" \
  '/AND d.user_id = m.user_id::text/d' \
  's|SELECT m.omie_codigo_cliente::text AS codigo, d.user_id|SELECT m.omie_codigo_cliente::text AS codigo, m.user_id::text AS user_id|'

# F1b -- o mesmo mutante, medindo o EFEITO e nao so a presenca: 105 passa a apontar para o dono
# OBSOLETO (u5), que e exatamente o pedido atribuido ao cliente errado.
cp "$MIG2" "$MUT"
sed '/AND d.user_id = m.user_id::text/d' "$MUT" > "$MUT.tmp" && mv "$MUT.tmp" "$MUT"
sed 's|SELECT m.omie_codigo_cliente::text AS codigo, d.user_id|SELECT m.omie_codigo_cliente::text AS codigo, m.user_id::text AS user_id|' "$MUT" > "$MUT.tmp" && mv "$MUT.tmp" "$MUT"
cmp -s "$MIG2" "$MUT" && bad "F1b SABOTAGEM NO-OP" || {
  P -q -f "$MUT" >/dev/null
  eq "F1b sob o mutante o codigo 105 aponta pro dono OBSOLETO u5 (o bug A2 em carne e osso)" \
     "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'105';")" "$U5"
  P -q -f "$MIG2" >/dev/null
}

# F2 -- UNICIDADE: sem n_users=1, o doc ambiguo passa a "provar" pelo min(user_id) (last-write-wins
# disfarcado de prova).
falsifica "F2 unicidade da evidencia (N3)" "$Q102" "f" "t" '/AND d.n_users = 1/d'

# F3 -- EVIDENCIA PRESENTE: nao da para isolar removendo o `IS NOT NULL` (o JOIN ja o implica, o sed
# seria no-op semantico e a falsificacao mentiria). O mutante ADICIONA o ramo que faltava: os vinculos
# de evidencia NULA entram pelo user do proprio vinculo -- que e o fail-open do backfill.
falsifica "F3 exigencia de evidencia (N1)" "$Q106" "f" "t" \
  "s|      AND m.updated_at >= now() - interval '7 days'|&\n    UNION ALL SELECT m2.omie_codigo_cliente::text, m2.user_id::text FROM public.omie_customer_account_map m2 WHERE m2.account = p_account AND m2.source = 'document' AND m2.evidence_document_normalized IS NULL AND m2.updated_at >= now() - interval '7 days'|"

# F4 -- ISOLAMENTO POR CONTA: o codigo Omie e numerado por conta; sem o filtro, o 201 da colacor vaza.
falsifica "F4 isolamento por conta (N4)" "$Q201" "f" "t" \
  's|WHERE m.account = p_account|WHERE (m.account = p_account OR true)|'

# F5 -- SOURCE: v1 so aceita 'document'.
falsifica "F5 restricao a source=document (N5a)" "$Q108" "f" "t" '/AND m.source  = /d'

# F6 -- TTL: espelha a janela da view fresca que este mapa sobrepoe.
falsifica "F6 TTL de 7 dias (N6)" "$Q110" "f" "t" '/AND m.updated_at >= now/d'

# F7 -- CHECK do formato: dropar a constraint faz o doc FORMATADO ser aceito (e ai o JOIN nunca casaria
# -- a correcao inteira viraria INERTE em silencio, que e o risco real desta coluna).
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT ocam_evidence_document_normalizado_chk;"
R7=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized)
  VALUES ('$U3','zztest2', 9002, 'document', '123.456.789-01');
  RAISE NOTICE 'SENT_PASSOU_INDEVIDO';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'SENT_BARROU_23514';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R7" in
  *SENT_PASSOU_INDEVIDO*) ok "F7 sem a constraint o doc FORMATADO entra => C1 ficaria VERMELHO (dente mecanico)" ;;
  *) bad "F7 mutante nao moveu o C1 (saida: $R7) => C1 sem dente" ;;
esac
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='zztest2';"
P -q -f "$MIG2" >/dev/null
chk_rejeita '123.456.789-01' "F7 restaurado: o CHECK volta a barrar o doc formatado"

# F8 -- GATE: REVOKE FROM PUBLIC nao tira grant explicito de anon/authenticated (CLAUDE.md); o mutante
# e exatamente esse grant.
P -q -c "GRANT EXECUTE ON FUNCTION $FN TO anon, authenticated;"
eq "F8 com o grant explicito authenticated PASSA a executar => G3 ficaria VERMELHO" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "t"
P -q -f "$MIG2" >/dev/null
eq "F8 restaurado: authenticated NAO executa" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"

# ══ ZONA 6 — ESCALA (gate de crescimento do design 4.1: o risco futuro e 57014, nao o payload) ══
# Semeia volume ~2x a prod de hoje (16.118 vinculos / 16k profiles) numa conta SEPARADA, para nao
# mexer nos denominadores dos asserts acima. Reporta tempo e pg_column_size com teto GENEROSO: o
# objetivo e pegar explosao (seq scan quadratico, payload de MB), nao cravar performance.
echo "-- escala --"
P -q <<'SQL'
INSERT INTO auth.users(id) SELECT gen_random_uuid() FROM generate_series(1,16000);
INSERT INTO public.profiles(user_id, document)
  SELECT u.id, lpad((70000000000 + row_number() OVER ())::text, 11, '0')
  FROM auth.users u WHERE u.id NOT IN (SELECT user_id FROM public.profiles);
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized, updated_at)
  SELECT p.user_id, 'escala', 500000 + row_number() OVER (), 'document', p.document, now()
  FROM public.profiles p WHERE p.user_id NOT IN (SELECT user_id FROM public.omie_customer_account_map);
ANALYZE public.profiles; ANALYZE public.omie_customer_account_map;
SQL
LINHAS=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map;")
T0=$(Pq -c "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint;")
NKEYS=$(RS "SELECT count(*) FROM jsonb_object_keys(public.omie_sync_identity_snapshot('escala')->'client_to_user');")
T1=$(Pq -c "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint;")
MS=$((T1-T0))
BYTES=$(RS "SELECT pg_column_size(public.omie_sync_identity_snapshot('escala'));")
echo "  escala: ${LINHAS} vinculos, ${NKEYS} provados, ${MS} ms, ${BYTES} bytes de payload"
if [ "$NKEYS" -ge 15000 ]; then ok "E1 a prova positiva escala (>=15000 vinculos provados em ${LINHAS} linhas)"; else bad "E1 so ${NKEYS} vinculos provados -- o JOIN nao esta casando em volume"; fi
if [ "$MS" -lt 10000 ]; then ok "E2 duracao ${MS}ms < 10s (teto de catastrofe; risco futuro e 57014)"; else bad "E2 duracao ${MS}ms >= 10s -- investigar plano antes de aplicar"; fi
if [ "$BYTES" -lt 8000000 ]; then ok "E3 payload ${BYTES}B < 8MB"; else bad "E3 payload ${BYTES}B >= 8MB -- o edge nao aguenta"; fi

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
