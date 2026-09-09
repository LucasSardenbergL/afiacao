#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — db/claude-rw-bootstrap.sql + scripts/db-aplicar.sh                        ║
# ║  Rode:  bash db/test-db-aplicar.sh > /tmp/t.log 2>&1; echo $?                           ║
# ║         bash db/test-db-aplicar.sh --falsificar    (3 sabotagens, exige VERMELHO)       ║
# ║                                                                                        ║
# ║  Prova, EXECUTANDO (PL/pgSQL e psql são late-bound; criar não é rodar):                 ║
# ║   A1 apply inédito aplica e vira recibo 'aplicada' na MESMA transação;                  ║
# ║   A2 re-apply dos MESMOS bytes é no-op (exit 3) — a trava é o sha, não o nome;          ║
# ║   A3 migration que falha no meio NÃO deixa meia-tabela e sai 4;                         ║
# ║   A4 a TENTATIVA sobrevive ao rollback (vira 'falhou') — as duas metades do contrato;   ║
# ║   A5 --ensaio roda inteiro e não grava NADA (nem tabela, nem linha de ledger);          ║
# ║   A6 arquivo não-commitado é recusado (exit 2) antes de tocar no banco;                 ║
# ║   A7 sonda fail-closed: wrapper que responde como OUTRO papel sai 6, não 0.             ║
# ║  Falsifica: (S1) marcador deixa de ser emitido → exit 0 com SQL incompleto vira sucesso;║
# ║             (S2) ON_ERROR_STOP removido → A3 troca 4 por 5 (erro vira desconhecido);    ║
# ║             (S3) checagem de 'já aplicada' removida → A2 aplica duas vezes.             ║
# ╚═══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
BOOT="$REPO_ROOT/db/claude-rw-bootstrap.sql"
APLICAR="$REPO_ROOT/scripts/db-aplicar.sh"
FIX_OK="db/fixtures/db-aplicar-ok.sql"
FIX_ERRO="db/fixtures/db-aplicar-erro.sql"
WORK="$(mktemp -d "/tmp/pgtest-db-aplicar.XXXXXX")"
DATA="$WORK/data"
# Locale é PARÂMETRO, não constante: `db-aplicar.sh` distingue falha-limpa (4) de
# desconhecido (5) casando a palavra do psql, que em pt_BR é ERRO e em C é ERROR. Falsificar
# num locale só aprovaria um casamento pela metade (#1483). Rode os DOIS:
#   LC_TESTE=C bash db/test-db-aplicar.sh --falsificar
#   LC_TESTE=pt_BR.UTF-8 bash db/test-db-aplicar.sh --falsificar
export LC_ALL="${LC_TESTE:-C}" LANG="${LC_TESTE:-C}"

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
nok()  { FAIL=$((FAIL+1)); printf '  ❌ %s — %s\n' "$1" "$2"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1" "esperado '$3', veio '$2'"; fi; }

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$BOOT" ] || { echo "bootstrap ausente: $BOOT"; exit 1; }

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── cluster ─────────────────────────────────────────────────────────────────────────────
"$PGBIN/initdb" -D "$DATA" -U postgres --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost" -l "$WORK/pg.log" -w start >/dev/null 2>&1

PSQL="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h localhost -p $PORT -U postgres -d postgres"
q() { $PGBIN/psql -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null | tr -d ' \n'; }

# ─── fixture: o mínimo do Supabase que o bootstrap referencia ─────────────────────────────
$PSQL >/dev/null 2>&1 <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
SQL

echo "▶ bootstrap"
BOOT_OUT="$WORK/boot.log"
if $PSQL -f "$BOOT" > "$BOOT_OUT" 2>&1; then
  if grep -q 'BOOTSTRAP_OK' "$BOOT_OUT"; then
    ok "bootstrap aplica e devolve BOOTSTRAP_OK"
  else
    nok "bootstrap" "sem marcador BOOTSTRAP_OK: $(tail -c 300 "$BOOT_OUT")"
  fi
else
  nok "bootstrap" "falhou: $(tail -c 400 "$BOOT_OUT")"
fi
eq "claude_rw nasce NOINHERIT (estado default é baixo)" \
   "$(q "select not rolinherit from pg_roles where rolname='claude_rw'")" "t"
# Produção recusou `GRANT postgres TO claude_rw` (42501). O desenho não pode depender disso:
# esta asserção existe para que reintroduzir a dependência quebre o teste na hora.
eq "claude_rw NÃO é membro de postgres (o desenho não depende do GRANT recusado)" \
   "$(q "select pg_has_role('claude_rw','postgres','MEMBER')")" "f"
eq "a função é SECURITY DEFINER" \
   "$(q "select prosecdef from pg_proc where oid='public.aplicar_sql(text,text,bigint)'::regprocedure")" "t"
eq "a função tem search_path fixo (SECURITY DEFINER sem isso é escalada)" \
   "$(q "select proconfig is not null from pg_proc where oid='public.aplicar_sql(text,text,bigint)'::regprocedure")" "t"
eq "claude_rw EXECUTA a função" \
   "$(q "select has_function_privilege('claude_rw','public.aplicar_sql(text,text,bigint)','EXECUTE')")" "t"
eq "anon NÃO executa a função" \
   "$(q "select has_function_privilege('anon','public.aplicar_sql(text,text,bigint)','EXECUTE')")" "f"
eq "PUBLIC NÃO executa a função (a 2ª ponta do REVOKE)" \
   "$(q "select has_function_privilege('public','public.aplicar_sql(text,text,bigint)','EXECUTE')")" "f"
eq "anon NÃO lê o ledger" \
   "$(q "select has_table_privilege('anon','public.db_aplicacoes','SELECT')")" "f"
eq "ledger nasce com RLS" \
   "$(q "select relrowsecurity from pg_class where oid='public.db_aplicacoes'::regclass")" "t"

echo "▶ re-aplicar o bootstrap (idempotência)"
if $PSQL -f "$BOOT" > "$WORK/boot2.log" 2>&1; then
  if grep -q 'BOOTSTRAP_OK' "$WORK/boot2.log"; then
    ok "re-colar o bootstrap é seguro"
  else
    nok "idempotência" "2ª aplicação sem marcador"
  fi
else
  nok "idempotência" "2ª aplicação falhou: $(tail -c 300 "$WORK/boot2.log")"
fi

# ─── shim: o "psql-rw" que aponta pro cluster local, como claude_rw ───────────────────────
SHIM="$WORK/psql-rw"
{ echo '#!/usr/bin/env bash'
  echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost -p $PORT -U claude_rw -d postgres \"\$@\""
} > "$SHIM"
chmod +x "$SHIM"

# Sabotagens operam numa CÓPIA — o arquivo real nunca é tocado, então não há restauração
# que possa apagar trabalho (a armadilha do `git checkout --` em arquivo não-commitado).
ALVO="$APLICAR"
if [ "$FALSIFICAR" -eq 1 ]; then
  ALVO="$WORK/db-aplicar-sabotado.sh"
  cp "$APLICAR" "$ALVO"
fi

aplicar() { ( cd "$REPO_ROOT" && AFIACAO_PSQL_RW="$SHIM" bash "$ALVO" "$@" ); }
rc_de()   { local r=0; aplicar "$@" > "$WORK/out.log" 2>&1 || r=$?; echo "$r"; }

# Uma sabotagem cujo padrão não CASA com o código é um no-op silencioso — e no-op silencioso
# aprova tudo: o alvo roda intacto, o veredito não muda, e isso é indistinguível de "a
# proteção existe". Aconteceu de verdade aqui: o apply passou de `-f -` para `-f "$APPLY_SQL"`
# e o padrão do S2 virou letra morta sem nada avisar. Esta guarda exige que o arquivo tenha
# MUDADO antes de a sabotagem valer como sabotagem.
sabota() {
  cp "$APLICAR" "$ALVO"
  perl -0pi -e "$1" "$ALVO"
  if cmp -s "$APLICAR" "$ALVO"; then
    nok "sabotagem inerte" "o padrão não casou com o código — nada foi sabotado: $1"
    return 1
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════════════════════
if [ "$FALSIFICAR" -eq 0 ]; then
echo "▶ A1 — apply inédito"
eq "A1 exit 0" "$(rc_de "$FIX_OK")" "0"
eq "A1 tabela criada" "$(q "select to_regclass('public.fixture_aplicar_ok') is not null")" "t"
eq "A1 recibo 'aplicada'" "$(q "select estado from public.db_aplicacoes where arquivo='$FIX_OK'")" "aplicada"

echo "▶ A2 — re-apply dos mesmos bytes"
eq "A2 exit 3 (no-op)" "$(rc_de "$FIX_OK")" "3"
eq "A2 continua 1 linha só" "$(q "select count(*) from public.db_aplicacoes where arquivo='$FIX_OK'")" "1"

echo "▶ A3/A4 — migration que falha no meio"
eq "A3 exit 4 (falhou, rollback limpo)" "$(rc_de "$FIX_ERRO")" "4"
eq "A3 NÃO sobrou meia-tabela" "$(q "select to_regclass('public.fixture_aplicar_meia') is null")" "t"
eq "A4 a tentativa sobreviveu ao rollback" \
   "$(q "select estado from public.db_aplicacoes where arquivo='$FIX_ERRO'")" "falhou"

echo "▶ A5 — ensaio não grava nada"
ANTES="$(q "select count(*) from public.db_aplicacoes")"
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_ok" >/dev/null 2>&1
eq "A5 ensaio exit 0" "$(rc_de "$FIX_OK" --ensaio)" "0"
eq "A5 nada no ledger" "$(q "select count(*) from public.db_aplicacoes")" "$ANTES"
eq "A5 nada no schema" "$(q "select to_regclass('public.fixture_aplicar_ok') is null")" "t"

echo "▶ A6 — arquivo não-commitado é recusado"
SUJO="db/fixtures/.sujo-$$.sql"
echo "SELECT 1;" > "$REPO_ROOT/$SUJO"
eq "A6 exit 2" "$(rc_de "$SUJO")" "2"
rm -f "$REPO_ROOT/$SUJO"

echo "▶ A8 — sha divergente é recusado ANTES de executar"
# A propriedade que o desenho recusado (GRANT) não daria: o corpo viaja como parâmetro, então
# a função reconfere o hash. Chamada com sha mentiroso não pode executar nada.
$PSQL -c "DROP TABLE IF EXISTS public.fixture_sha_mentiroso" >/dev/null 2>&1
SHA_OUT="$WORK/sha.log"
"$SHIM" -X -A -t -c "select public.aplicar_sql(
   \$x\$CREATE TABLE public.fixture_sha_mentiroso(i int);\$x\$,
   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 1)" > "$SHA_OUT" 2>&1 || true
if grep -q 'sha divergente' "$SHA_OUT"; then
  ok "A8 sha mentiroso é rejeitado com mensagem própria"
else
  nok "A8" "esperava 'sha divergente', veio: $(head -c 200 "$SHA_OUT")"
fi
eq "A8 e NADA foi executado" \
   "$(q "select to_regclass('public.fixture_sha_mentiroso') is null")" "t"

echo "▶ A9 — tentativa JÁ FECHADA não pode ser reusada (nem executa)"
# `WHERE id = p_id` sozinho aceitava um id já 'aplicada': o corpo rodava DE NOVO e a mesma
# linha era reescrita, sem violar unicidade. Agora a validação trava ANTES do EXECUTE.
$PSQL -c "DROP TABLE IF EXISTS public.fixture_reuso" >/dev/null 2>&1
ID_FECHADO="$(q "select id from public.db_aplicacoes where estado='aplicada' order by id limit 1")"
REUSO="$WORK/reuso.log"
"$SHIM" -X -A -t -c "select public.aplicar_sql(
   \$y\$CREATE TABLE public.fixture_reuso(i int);\$y\$,
   encode(sha256(convert_to(\$y\$CREATE TABLE public.fixture_reuso(i int);\$y\$,'UTF8')),'hex'),
   ${ID_FECHADO:-0})" > "$REUSO" 2>&1 || true
if grep -qE 'inexistente ou já fechada' "$REUSO"; then
  ok "A9 tentativa fechada é recusada com mensagem própria"
else
  nok "A9" "esperava recusa por tentativa fechada, veio: $(head -c 200 "$REUSO")"
fi
eq "A9 e o corpo NÃO foi executado" \
   "$(q "select to_regclass('public.fixture_reuso') is null")" "t"

echo "▶ A7 — sonda fail-closed"
SHIM_ERRADO="$WORK/psql-rw-errado"
{ echo '#!/usr/bin/env bash'
  echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost -p $PORT -U postgres -d postgres \"\$@\""
} > "$SHIM_ERRADO"; chmod +x "$SHIM_ERRADO"
R7=0; ( cd "$REPO_ROOT" && AFIACAO_PSQL_RW="$SHIM_ERRADO" bash "$ALVO" "$FIX_OK" ) >/dev/null 2>&1 || R7=$?
eq "A7 papel errado sai 6, não 0" "$R7" "6"

else
# ═════════════════════════════════════════════════════════════════════════════════════════
echo "▶ CONTROLE (sem sabotagem, na cópia) — tem de estar VERDE antes de sabotar"
eq "controle: A1 aplica" "$(rc_de "$FIX_OK")" "0"
eq "controle: A3 sai 4"  "$(rc_de "$FIX_ERRO")" "4"
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_ok; DELETE FROM public.db_aplicacoes" >/dev/null 2>&1

echo "▶ S1 — o marcador de fim deixa de ser emitido (psql sai 0 e o SQL não terminou)"
# A 1ª versão desta sabotagem forçava TEM_MARCADOR=1 e rodava a fixture de ERRO — e ficava
# VERDE, porque com rc≠0 o marcador não decide nada. Sabotagem no cenário errado aprova
# qualquer coisa. O cenário em que o marcador é a ÚNICA testemunha é o inverso: exit 0 com
# a transação incompleta. Tirar a emissão do marcador simula exatamente isso.
# O marcador agora é o RETURN da função, não um literal no script. Trocar a constante que o
# script PROCURA simula "o marcador não chegou": rc=0, apply de fato ocorreu, e mesmo assim o
# veredito não pode ser sucesso — é o que separa "exit 0" de "terminou".
sabota "s/^MARCADOR='FIM_APLICACAO_OK'\$/MARCADOR='NUNCA_APARECE'/m; s/^  EST_POS=.*\$/  EST_POS=''/m"
S1="$(rc_de "$FIX_OK")"
# Exigir o código EXATO, não "≠ 0". A versão frouxa aceitou exit 1 — que era o script MORRENDO
# por `set -e` na captura do erro (grep sem match ⇒ 1 ⇒ pipefail ⇒ morte), com o ramo
# DESCONHECIDO inalcançável logo abaixo. A sabotagem ficava verde por cima de um ramo morto.
#
# Duas sabotagens juntas de propósito: some o marcador E some a reconciliação pelo ledger.
# São as DUAS testemunhas independentes de que o apply terminou; cegar só uma deixa a outra
# responder certo (foi o que aconteceu — com só o marcador cego, o script leu 'aplicada' no
# ledger e concluiu, corretamente, que o COMMIT tinha chegado). Cegar as duas é o único
# estado em que o veredito honesto é "não sei".
if [ "$S1" = "5" ]; then
  ok "S1 vermelho: cegas as DUAS testemunhas, o veredito é DESCONHECIDO (5) — ramo ALCANÇÁVEL"
else
  nok "S1" "esperava exit 5 (desconhecido); veio '$S1'. 'Qualquer coisa ≠ 0' esconde ramo morto"
fi

echo "▶ S4 — só o marcador cego: o LEDGER responde, e o script não finge sucesso limpo"
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_ok; DELETE FROM public.db_aplicacoes" >/dev/null 2>&1
sabota "s/^MARCADOR='FIM_APLICACAO_OK'\$/MARCADOR='NUNCA_APARECE'/m"
S4="$(rc_de "$FIX_OK")"
if [ "$S4" = "0" ] && grep -q 'COMMIT CHEGOU' "$WORK/out.log"; then
  ok "S4 a reconciliação pelo ledger reconhece o COMMIT e AVISA que a resposta se perdeu"
else
  nok "S4" "esperava exit 0 + aviso 'COMMIT CHEGOU'; veio '$S4' / $(tail -c 150 "$WORK/out.log")"
fi
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_ok; DELETE FROM public.db_aplicacoes" >/dev/null 2>&1

echo "▶ S2 — ON_ERROR_STOP removido"
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE
# do script alvo, onde $APPLY_SQL aparece literalmente. Expandir aqui faria o padrao
# procurar o caminho do arquivo temporario — que nao existe no codigo — e a sabotagem
# viraria inerte, que e exatamente a classe que o sabota() existe para pegar.
sabota 's/-X -v ON_ERROR_STOP=1 -f "\$APPLY_SQL"/-X -f "\$APPLY_SQL"/; s/set ON_ERROR_STOP on//'
S2="$(rc_de "$FIX_ERRO")"
if [ "$S2" != "4" ]; then
  ok "S2 vermelho: sem ON_ERROR_STOP o erro deixa de ser erro ($S2 ≠ 4)"
else
  nok "S2" "sabotagem NÃO mudou nada — ON_ERROR_STOP não está segurando"
fi
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_meia; DELETE FROM public.db_aplicacoes" >/dev/null 2>&1

echo "▶ S3 — checagem de 'já aplicada' removida"
sabota 's/\*aplicada\*\)/*JAMAIS_CASA*)/'
rc_de "$FIX_OK" >/dev/null
S3="$(rc_de "$FIX_OK")"
if [ "$S3" != "3" ]; then
  ok "S3 vermelho: sem a checagem o re-apply deixa de ser no-op ($S3 ≠ 3)"
else
  nok "S3" "sabotagem NÃO mudou nada — a checagem de sha é inalcançada"
fi
fi

# ═════════════════════════════════════════════════════════════════════════════════════════
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "FIM_PROVA_OK" || echo "FIM_PROVA_VERMELHO"
[ "$FAIL" -eq 0 ]
