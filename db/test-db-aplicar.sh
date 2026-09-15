#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════╗
# ║   PROVA PG17 — db/claude-rw-bootstrap.sql + scripts/db-aplicar.sh                       ║
# ║   Rode:  bash db/test-db-aplicar.sh > /tmp/t.log 2>&1; echo $?                          ║
# ║          bash db/test-db-aplicar.sh --falsificar    (11 sabotagens, exige VERMELHO)     ║
# ║   Exit:  0 verde · 1 asserção vermelha · 3 SONDA/CONTROLE podre (nada a julgar)         ║
# ║                                                                                         ║
# ║   Prova, EXECUTANDO (PL/pgSQL e psql são late-bound; criar não é rodar):                ║
# ║    A1 apply inédito aplica e vira recibo 'aplicada' na MESMA transação;                 ║
# ║    A2 re-apply dos MESMOS bytes é no-op (exit 3) — a trava é o sha, não o nome;         ║
# ║    A3 migration que falha no meio NÃO deixa meia-tabela e sai 4;                        ║
# ║    A4 a TENTATIVA sobrevive ao rollback (vira 'falhou') — as duas metades do contrato;  ║
# ║    A5 --ensaio roda inteiro e não grava NADA (nem tabela, nem linha de ledger);         ║
# ║    A6 arquivo não-commitado é recusado (exit 2) antes de tocar no banco;                ║
# ║    A7 sonda fail-closed: wrapper que responde como OUTRO papel sai 6, não 0;            ║
# ║    A8 sha mentiroso é recusado pela função ANTES de executar o corpo;                   ║
# ║    A9 tentativa já fechada não pode ser reusada (nem executa);                          ║
# ║    A10 SQL COM envelope é recusado (exit 2) sem criar nada e sem gravar no ledger.      ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════╝
# Falsifica — cada sabotagem com rc EXATO + MARCA lida da saída real, julgada nas TRÊS combinações
# servidor×cliente com o desfecho previsto para cada uma, e contra o seu GÊMEO verde (o mesmo cenário
# sem a sabotagem não pode passar) — o porquê está no bloco da falsificação, lá embaixo:
#   (S1)  marcador E reconciliação cegos → o apply conclui, e o veredito honesto é 5 (não sei);
#   (S2)  ON_ERROR_STOP removido → o erro ACONTECE e o psql sai 0: vira 5, não 4;
#   (S3)  checagem de 'já aplicada' removida → o re-apply chega ao banco e o índice único barra o
#         2º recibo (4). Não aplica duas vezes: deixa de ser o no-op que A2 afirma;
#   (S4)  só o marcador cego → o ledger responde e o script AVISA, não finge;
#   (S5)  recusa do envelope removida → o corpo com BEGIN; chega ao banco, que o barra (4);
#   (S6)  guard de não-transacional desligado → o banco barra o CREATE INDEX CONCURRENTLY (4);
#   (S7)  guard alargado para casar END; → o controle legítimo vira recusa (2);
#   (S8)  transformação no CLIENTE → o banco recusa por sha divergente (4);
#   (S9)  transformação no SERVIDOR → aplica limpo (0) e só o corpo guardado muda;
#   (S10) regex sem ERRO     → só o servidor em pt_BR vira 5;
#   (S11) regex só com ERRO: → só o servidor em inglês vira 5. S10 e S11 provam que as combinações
#         não são cópia uma da outra: cada idioma pega a sua e deixa a outra passar.
set -euo pipefail

# Esta prova está em `db/nucleo-ci.txt` (job `provas-sql`) nos DOIS modos: o normal, com mínimo de
# asserts, e — desde 2026-09-14 — o `--falsificar`, com mínimo de sabotagens (`falsificar=<n>`).
# Encolher qualquer um reprova o CI até alguém baixar aquele número, e aí a perda de cobertura fica
# no diff, que é o ponto.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# PGBIN resolvido por PLATAFORMA (macOS Homebrew / Linux PGDG), com conferência POSITIVA da
# major — não `-x`, que um initdb de outra versão satisfaz. Hardcodar /opt/homebrew era a única
# coisa que mantinha esta prova FORA do CI: o runner é ubuntu e o caminho não existe lá.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT_BASE="${PGPORT_TEST:-5481}"
BOOT="$REPO_ROOT/db/claude-rw-bootstrap.sql"
APLICAR="$REPO_ROOT/scripts/db-aplicar.sh"
FIX_OK="db/fixtures/db-aplicar-ok.sql"
FIX_ERRO="db/fixtures/db-aplicar-erro.sql"
# A classe de entrada que faltava. ok/erro NÃO têm envelope — foi por isso que o #2421 passou
# verde: o desenvelopador que ele instalou era no-op sobre as duas, e a prova exercitava só o
# caso em que a transformação não transformava nada. Fixture que não representa a classe real
# de entrada é teste cego, e o custo foi quebrar TODA migration com envelope sem ninguém ver.
FIX_ENVELOPE="db/fixtures/db-aplicar-envelope.sql"
FIX_CIC="db/fixtures/db-aplicar-cic.sql"
FIX_CORPO="db/fixtures/db-aplicar-corpo-de-funcao.sql"
WORK="$(mktemp -d "/tmp/pgtest-db-aplicar.XXXXXX")"
LOGS="$WORK/logs"
mkdir -p "$LOGS"
# Onde o executor escreve. No modo normal, um log só; na falsificação, um por (sabotagem, combinação).
OUT="$WORK/out.log"

# O SHELL desta prova roda sempre em C — o `pg_ctl` inclusive, que no macOS morre com "became
# multithreaded during startup" sob locale inválido. O idioma sob teste mora em DOIS lugares, e só
# um deles é o que parecia: a palavra de severidade que `db-aplicar.sh` casa para separar falha-limpa
# (4) de desconhecido (5) — ERRO em pt_BR, ERROR em C — vem do SERVIDOR (`lc_messages`); o cliente
# traduz só o que ele mesmo gera (`psql: erro:`) e os rótulos da libpq (`CONTEXTO:`). Por isso o
# idioma entra pelo `lc_messages` do cluster E pelo `LC_ALL` da chamada do executor, nunca pelo shell.
# `LANGUAGE` sai: o gettext o prefere ao `LC_ALL`, e um `LANGUAGE=en` herdado deixaria o "pt_BR" em
# inglês sem erro nenhum.
export LC_ALL=C LANG=C
unset LANGUAGE
# Modo normal: `LC_TESTE` escolhe o idioma do cliente E do servidor (trocar só o cliente não muda a
# palavra que o executor casa). A falsificação o ignora e roda as três combinações — ver o bloco dela.
LOC_CLI="${LC_TESTE:-C}"

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
nok()  { FAIL=$((FAIL+1)); printf '  ❌ %s — %s\n' "$1" "$2"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1" "esperado '$3', veio '$2'"; fi; }

[ -f "$BOOT" ] || { echo "bootstrap ausente: $BOOT"; exit 1; }

# SONDA de `shasum`, com resposta POSITIVA. É a única dependência do `db-aplicar.sh` que este
# teste exerce e que o pg-harness não cobre — e é a que muda de plataforma: no macOS vem com o
# sistema, no Linux vem do pacote `perl`. `command -v` não basta (presente-porém-quebrada
# esvazia o guard igual): exigimos o hash CONHECIDO de uma entrada conhecida. Sem isso, a falta
# apareceria lá dentro como "sha256 com formato inesperado", que culpa o arquivo errado.
SHA_VAZIO="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
[ "$(printf '' | shasum -a 256 2>/dev/null | awk '{print $1}')" = "$SHA_VAZIO" ] || {
  echo "ERRO: 'shasum -a 256' não respondeu o hash conhecido da entrada vazia."
  echo "  O scripts/db-aplicar.sh depende dele para a identidade do que aplica."
  echo "  Debian/Ubuntu: apt-get install -y perl   (shasum vem no pacote perl)"; exit 1; }

cleanup() {
  local d
  for d in "$WORK"/cluster-*/data; do
    [ -d "$d" ] || continue
    "$PGBIN/pg_ctl" -D "$d" -m immediate stop >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── clusters ────────────────────────────────────────────────────────────────────────────────
# Um CLUSTER é um Postgres descartável com o seu `lc_messages`. O modo normal usa um (`n`); a
# falsificação usa dois (`c` e `pt`) e três combinações com o locale do cliente — ver o bloco dela.
seleciona_cluster() { # <n|c|pt> — define CLUSTER, PORT, LOC_SRV, CDIR, DATA, SHIM e PSQL
  case "$1" in
    n)  PORT="$PORT_BASE";       LOC_SRV="${LC_TESTE:-C}" ;;
    c)  PORT="$PORT_BASE";       LOC_SRV=C ;;
    pt) PORT=$((PORT_BASE + 1)); LOC_SRV=pt_BR.UTF-8 ;;
    *)  echo "ERRO interno: cluster desconhecido '$1'"; exit 1 ;;
  esac
  CLUSTER="$1"; CDIR="$WORK/cluster-$1"; DATA="$CDIR/data"; SHIM="$CDIR/psql-rw"
  PSQL="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h localhost -p $PORT -U postgres -d postgres"
}

# `-k "$CDIR"`: o diretório do socket unix. Sem ele o postmaster usa o default COMPILADO, que
# no PGDG (Ubuntu) é /var/run/postgresql — inexistente para o usuário do runner, e o servidor
# não sobe. Conectamos por TCP, mas o postmaster cria o socket de qualquer jeito e ABORTA se
# não puder. É o que reprovou a 1ª tentativa desta prova no CI; as 16 provas que já rodavam lá
# passam `-k /tmp` pelo mesmo motivo. Aqui vai um diretório por cluster: /tmp é compartilhado e
# duas provas na mesma porta lógica brigariam pelo mesmo arquivo de socket.
#
# E a saída NÃO é descartada. Com `>/dev/null 2>&1` + `set -e`, um cluster que não sobe
# matava o script MUDO: log vazio, exit 1, e o runner do núcleo imprimindo "── últimas linhas ──"
# seguido de nada. Falha silenciosa é a pior classe de todas — a que não deixa nem por onde
# começar. Cada ramo abaixo DIZ o que quebrou, com o que o Postgres respondeu.
sobe_cluster() {
  mkdir -p "$CDIR"
  if ! "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C > "$CDIR/initdb.log" 2>&1; then
    echo "ERRO: initdb falhou (cluster $CLUSTER, PGBIN=$PGBIN)"; tail -c 800 "$CDIR/initdb.log"; exit 1
  fi
  # `lc_messages` pelo `-c`, não pelo `initdb --locale`: o resto do cluster é idêntico nos dois
  # idiomas, e um valor que o sistema não tem derruba o start com FATAL — alto, não silencioso.
  if ! "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $CDIR -c listen_addresses=localhost -c lc_messages=$LOC_SRV" \
         -l "$CDIR/pg.log" -w start > "$CDIR/pgctl.log" 2>&1; then
    echo "ERRO: o cluster $CLUSTER não subiu na porta $PORT com lc_messages=$LOC_SRV (PGBIN=$PGBIN)"
    echo "── pg_ctl ──"; tail -c 400 "$CDIR/pgctl.log"
    echo "── postmaster ──"; tail -c 800 "$CDIR/pg.log" 2>/dev/null
    exit 1
  fi
  # fixture: o mínimo do Supabase que o bootstrap referencia
  if ! $PSQL > "$CDIR/fixture.log" 2>&1 <<'SQL'
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
  then
    echo "ERRO: a fixture do Supabase falhou no cluster $CLUSTER"; tail -c 600 "$CDIR/fixture.log"; exit 1
  fi
  # o "psql-rw" que aponta pro cluster, como claude_rw
  { echo '#!/usr/bin/env bash'
    echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost -p $PORT -U claude_rw -d postgres \"\$@\""
  } > "$SHIM"
  chmod +x "$SHIM"
}

q()         { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null | tr -d ' \n'; }
# q() esmaga espaco e quebra de linha — serve para escalar, nao para corpo de funcao.
q_bruto()   { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null; }
# q_estrito devolve o STATUS do psql: leitura que falhou não pode virar valor vazio que "diverge".
q_estrito() { "$PGBIN/psql" -X -A -t -q -v ON_ERROR_STOP=1 -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null; }
# norm_corpo tira TODA linha em branco (ou só de espaços) — não só a quebra que o $-quote acrescenta
# (parecer Codex 2026-09-14). A indentação conta; uma transformação que mexesse só em linha em branco
# passaria. A fixture de hoje não tem linha em branco no corpo: comparar byte a byte não daria dente
# nenhum sem mudar a fixture junto — registrado como fora da entrega de 2026-09-14.
norm_corpo() { sed '/^[[:space:]]*$/d'; }
CORPO_ARQ="$(awk '/AS \$funcao\$$/{f=1;next} /^\$funcao\$;$/{f=0} f' "$REPO_ROOT/$FIX_CORPO" | norm_corpo)"

aplicar() { ( cd "$REPO_ROOT" && LC_ALL="$LOC_CLI" LANG="$LOC_CLI" AFIACAO_PSQL_RW="$SHIM" bash "$ALVO" "$@" ); }
rc_de()   { local r=0; aplicar "$@" > "$OUT" 2>&1 || r=$?; echo "$r"; }

# ═════════════════════════════════════════════════════════════════════════════════════════
if [ "$FALSIFICAR" -eq 0 ]; then
seleciona_cluster n
sobe_cluster
ALVO="$APLICAR"

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

echo "▶ A10 — SQL com envelope de transação é recusado"
# O exit 2 é COMPARTILHADO por vários ramos de recusa (uso, arquivo ausente, não-commitado, tag
# de quoting). Casar só o número aprovaria a recusa CERTA pelo motivo ERRADO — e o motivo errado
# mais provável é o guard do A6 logo acima: se esta fixture deixar de estar commitada e limpa, o
# script morre antes de chegar ao envelope, com o mesmo 2, e a asserção fica verde sem ter
# exercitado nada. Por isso a MARCA da mensagem também é asserção. `-F` sobre pedaço ASCII de
# caixa fixa: casar acento ou usar `-i` é o casamento pela metade que já migrou de locale (#1483).
LEDGER_ANTES="$(q "select count(*) from public.db_aplicacoes")"
eq "A10 exit 2" "$(rc_de "$FIX_ENVELOPE")" "2"
if grep -qF 'BEGIN/COMMIT/ROLLBACK' "$OUT"; then
  ok "A10 recusou pelo ENVELOPE — não por outro ramo que também sai 2"
else
  nok "A10" "saiu 2 sem a marca do envelope (motivo errado?): $(tail -c 250 "$OUT")"
fi
eq "A10 NADA foi criado" \
   "$(q "select to_regclass('public.fixture_aplicar_envelope') is null")" "t"
# A recusa mora na etapa 2 do script, antes de ler o ledger e antes de gravar a tentativa: o
# ledger tem de ficar do MESMO tamanho. Cicatriz aqui seria ruído permanente em produção, para
# um arquivo que nunca chegou perto do banco.
eq "A10 NADA foi gravado no ledger" \
   "$(q "select count(*) from public.db_aplicacoes")" "$LEDGER_ANTES"

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
R7=0; ( cd "$REPO_ROOT" && LC_ALL="$LOC_CLI" LANG="$LOC_CLI" AFIACAO_PSQL_RW="$SHIM_ERRADO" bash "$ALVO" "$FIX_OK" ) >/dev/null 2>&1 || R7=$?
eq "A7 papel errado sai 6, não 0" "$R7" "6"

echo "▶ A11/A12 — a 2ª classe de incompatibilidade, e o CONTROLE dos dois guards"
# A10 (acima) cobre a MOLDURA, que tem conserto: tirar o envelope. A11 cobre a classe que NÃO
# tem — CREATE INDEX CONCURRENTLY não roda em transação alguma, e o recibo só é atômico porque
# há uma. Casamos o MARCADOR ASCII: "saiu 2" também é arquivo não-commitado, sha torto e sonda.
eq "A11 CREATE INDEX CONCURRENTLY é recusado com exit 2" "$(rc_de "$FIX_CIC")" "2"
if grep -q 'RECUSA_FORA_DE_TRANSACAO' "$OUT"; then
  ok "A11 recusou pelo ramo CERTO (RECUSA_FORA_DE_TRANSACAO)"
else
  nok "A11 marcador" "exit 2 veio de OUTRO ramo — 'recusou' não é 'recusou por isto'"
fi

# A12 — o CONTROLE, e a asserção que mais importa: sem ela, um guard que recusasse TUDO passaria
# em A10 e A11 com louvor. Alarme de guard tem DOIS lados, e só este mede o lado de baixo.
# `BEGIN` (sem `;`) e `END;` em coluna 0 dentro de $$ são fecho de bloco PL/pgSQL — 81 arquivos
# do repo os têm. `REFRESH MATERIALIZED VIEW CONCURRENTLY` não é `CREATE INDEX CONCURRENTLY` —
# 10 migrations o usam e ele roda em transação normalmente.
eq "A12 corpo de função com BEGIN/END; e REFRESH MV CONCURRENTLY APLICA" \
   "$(rc_de "$FIX_CORPO")" "0"

# A12b — o eixo POR FORA. Tudo acima mede o que o SCRIPT decidiu; este mede o que o BANCO
# guardou. Sensor que só consulta a máquina vigiada herda o defeito dela: se alguém reintroduzir
# transformação do corpo (o `desenvelopar-transacao.awk` revertido em #2434 era exatamente
# isso), os guards seguem verdes e só esta comparação vê o corpo mudar. Ver S9.
CORPO_DB="$(q_bruto "select prosrc from pg_proc where oid='public.fixture_corpo_refresca()'::regprocedure" | norm_corpo || true)"
eq "A12b o corpo GUARDADO pelo Postgres é o do arquivo (linhas em branco fora; indentação conta)" "$CORPO_DB" "$CORPO_ARQ"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "FIM_PROVA_OK"; else echo "FIM_PROVA_VERMELHO"; fi
RC_FINAL="$FAIL"

else
# ═════════════════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — uma invocação, TRÊS combinações servidor×cliente sobre DOIS clusters.
#
# Medido em 2026-09-14 (PG 17.10, `psql -f` com `SELECT 1/0`): cluster em C → `ERROR:  division
# by zero` com cliente C E com cliente pt_BR; cluster em pt_BR → `ERRO:  divisão por zero` com os
# dois. Até essa data o 2º locale desta falsificação trocava só o cliente (`LC_TESTE`) sobre um
# cluster `--locale=C`: as linhas de erro saíam IDÊNTICAS nas duas rodadas, e tirar `ERRO` da regex
# do executor dava 4 nas duas (medido) — a falsificação-em-um-ambiente do #1483 com cara de dois.
#
#   c_c    servidor C     · cliente C
#   c_pt   servidor C     · cliente pt_BR   ← o par de PRODUÇÃO: lc_messages=en_US.UTF-8 (medido
#                                             por psql-ro) com o terminal do founder em pt_BR
#   pt_pt  servidor pt_BR · cliente pt_BR   ← a única em que a severidade diz ERRO
#
# c_pt não é redundante com as outras duas (parecer Codex 2026-09-14): a libpq junta rótulo
# traduzido no cliente com conteúdo do servidor — medido, `CONTEXTO:  SQL statement "..."` —, linha
# que nenhum par homogêneo produz. É também a marca de que o EXECUTOR recebeu o locale: a sonda do
# cliente, sozinha, prova o psql, não o encaminhamento em `aplicar()` (2ª rodada do Codex).
#
# Uma sabotagem só conta com CERTO nas três, e CERTO exige o rc EXATO e a MARCA — trecho ASCII de
# caixa fixa lido da saída real, de preferência do próprio script, que não muda com locale, e,
# quando o motivo é "o banco recusou", a mensagem do banco NAQUELE idioma. Nunca texto que também
# esteja numa fixture: num erro dentro do EXECUTE o psql ecoa o corpo inteiro, e a S6 chegou a ter
# `RECUSA_FORA_DE_TRANSACAO` no log com o guard DESLIGADO. S10/S11 são as sabotagens que só um
# idioma pega; sem elas, trocar pt_BR por C.UTF-8 deixaria as três combinações iguais e tudo verde.
#
# Ordem — as etapas de ambiente e de controle ABORTAM (exit 3, sem recibo) antes da seguinte: sondas
# → controle verde nas três → controles negativos do juiz e da agregação → cada sabotagem precedida
# do seu GÊMEO verde (o mesmo cenário na cópia intacta não pode dizer CERTO) → identidade (e um log
# por sabotagem e combinação) → controle de saída → UM recibo.
echo "== falsificacao: 3 combinacoes servidor x cliente sobre uma COPIA do executor =="
ALVO="$WORK/db-aplicar-sabotado.sh"
BOOT_SAB="$WORK/bootstrap-sabotado.sql"

aborta() { # <MARCA> <linha>... — sai 3 SEM recibo: dali para baixo nada seria veredito
  local marca="$1"
  shift
  printf '\n🛑 %s — abortando: nada abaixo daqui seria veredito.\n' "$marca"
  printf '   %s\n' "$@"
  printf 'FIM_FALSIFICACAO_ABORTADA %s\n' "$marca"
  exit 3
}
nota() { printf '  ✅ %s\n' "$1"; }

seleciona_combo() { # <c_c|c_pt|pt_pt> — cluster e locale do cliente; e, À PARTE, o que ela TEM de mostrar
  case "$1" in
    c_c)   seleciona_cluster c;  LOC_CLI=C ;;
    c_pt)  seleciona_cluster c;  LOC_CLI=pt_BR.UTF-8 ;;
    pt_pt) seleciona_cluster pt; LOC_CLI=pt_BR.UTF-8 ;;
    *)     echo "ERRO interno: combinacao desconhecida '$1'"; exit 1 ;;
  esac
  COMBO="$1"
  # O que cada combinação TEM de mostrar é fixado pelo NOME dela — nunca calculado de LOC_SRV/LOC_CLI,
  # que são as variáveis sob teste. Expectativa derivada do que se testa é o oráculo imitando a
  # implementação (docs/historico/prova-que-imitava-o-oraculo.md): trocar o cluster do pt_pt para C
  # mudaria resultado e expectativa JUNTOS, e as três combinações sairiam em inglês, todas verdes.
  # Mensagens lidas da saída real (2026-09-14), com o prefixo de severidade: o psql escreve
  # `ERROR:  msg`, com DOIS espaços, e nenhuma fixture tem isso — a do envelope CITA a inglesa.
  case "$1" in
    pt_pt)
      SRV_ESPERADO=pt_BR.UTF-8
      M_DIV='ERRO:  divis'
      M_ENVELOPE='ERRO:  EXECUTE de comandos de controle de transa'
      M_CIC_SEV='ERRO:  CREATE INDEX CONCURRENTLY'
      M_CIC='pode ser executado dentro de um bloco de transa' ;;
    *)
      SRV_ESPERADO=C
      M_DIV='ERROR:  division by zero'
      M_ENVELOPE='ERROR:  EXECUTE of transaction commands is not implemented'
      M_CIC_SEV='ERROR:  CREATE INDEX CONCURRENTLY'
      M_CIC='cannot run inside a transaction block' ;;
  esac
  # O rótulo de contexto é da LIBPQ, traduzido no CLIENTE que o executor rodou; o conteúdo, do
  # servidor. M_CTX (só o rótulo) vai em toda sabotagem cujo log traz erro do banco; M_CTX_A3 (rótulo e
  # conteúdo — a linha mista do c_pt) no controle. Medido em 2026-09-14: uma ocorrência em cada log com
  # erro do banco, nenhuma nos demais.
  case "$1" in
    c_c)   M_CLIENTE='psql: error:'; M_CTX='CONTEXT:  ';  M_CTX_A3='CONTEXT:  SQL statement' ;;
    c_pt)  M_CLIENTE='psql: erro:';  M_CTX='CONTEXTO:  '; M_CTX_A3='CONTEXTO:  SQL statement' ;;
    pt_pt) M_CLIENTE='psql: erro:';  M_CTX='CONTEXTO:  '; M_CTX_A3='CONTEXTO:  comando SQL' ;;
  esac
}

limpa() { # zera fixtures e ledger do cluster selecionado; o status é conferido por quem chama
  $PSQL -q -c "DROP FUNCTION IF EXISTS public.fixture_corpo_refresca();
    DROP TABLE IF EXISTS public.fixture_aplicar_ok, public.fixture_aplicar_meia,
      public.fixture_aplicar_envelope, public.fixture_aplicar_cic, public.fixture_aplicar_corpo;
    DELETE FROM public.db_aplicacoes" > "$CDIR/limpa.log" 2>&1
}
# A S2 deixa estado `desconhecido` no ledger, e a S3 um recibo `aplicada`: limpeza que falhasse em
# silêncio mudaria o desfecho do cenário seguinte. Preparação que não aconteceu é MOTIVO, não verde.
limpo() { limpa || { printf 'limpeza: o cluster %s nao zerou (%s)' "$CLUSTER" "$(tail -c 120 "$CDIR/limpa.log" | tr '\n' ' ')"; return 1; }; }

md5_aplicar_sql() { q_estrito "select md5(prosrc) from pg_proc where oid='public.aplicar_sql(text,text,bigint)'::regprocedure"; }

# corpo_guardado — o prosrc da função da fixture, normalizado. Status ≠ 0 se a leitura FALHOU ou veio
# vazia. Com o `|| true` antigo, corpo vazio "divergia" do arquivo e a S9 contava uma leitura que não
# aconteceu como corrupção detectada (parecer Codex 2026-09-14).
corpo_guardado() {
  local c=""
  c="$(q_estrito "select prosrc from pg_proc where oid='public.fixture_corpo_refresca()'::regprocedure")" || return 1
  c="$(printf '%s\n' "$c" | norm_corpo)"
  [ -n "$c" ] || return 1
  printf '%s' "$c"
}
# O que a transformação da S9 (tirar 2 espaços depois de cada quebra) deixa guardado.
CORPO_PEEL="$(printf '%s\n' "$CORPO_ARQ" | sed 's/^  //')"

# confere <rc-veio> <rc-esperado> <log> <marca>... — ecoa CERTO só com o rc EXATO e TODAS as marcas.
# `grep -F` sobre ASCII de caixa fixa, sem `-i`: acento e caixa são o casamento pela metade que migra
# de locale (#1483). Qualquer outra saída é o MOTIVO da recusa — silêncio nunca é "certo".
confere() {
  local veio="$1" esperado="$2" log="$3" marca="" faltam=""
  shift 3
  [ "$#" -ge 1 ] || { printf 'confere sem marca: o rc sozinho aceita qualquer vermelho'; return 0; }
  if [ "$veio" != "$esperado" ]; then printf "rc '%s', esperado %s" "$veio" "$esperado"; return 0; fi
  [ -s "$log" ] || { printf 'rc %s certo, mas o log esta vazio ou ausente' "$veio"; return 0; }
  for marca in "$@"; do
    grep -qF -- "$marca" "$log" || faltam="$faltam '$marca'"
  done
  if [ -n "$faltam" ]; then printf 'rc %s certo, SEM a marca%s' "$veio" "$faltam"; return 0; fi
  printf 'CERTO'
}

# controle_combo <rotulo> — a linha de base, na combinação selecionada e pelo MESMO caminho das
# sabotagens: a cópia, o shim, o locale do cliente, um log por passo. Um passo por CLASSE de desfecho
# que as sabotagens mexem — sucesso (0), falha-limpa (4, dizendo a severidade no idioma DO SERVIDOR),
# recusa de preflight (2) — e o corpo guardado intacto (A12/A12b), a linha de base da S9.
controle_combo() {
  local rot="$1" r="" m="" c=""
  limpo || return 0
  OUT="$LOGS/$rot-A1.$COMBO.log"; r="$(rc_de "$FIX_OK")"
  m="$(confere "$r" 0 "$OUT" 'APLICADO')"
  [ "$m" = CERTO ] || { printf 'A1: %s' "$m"; return 0; }
  OUT="$LOGS/$rot-A3.$COMBO.log"; r="$(rc_de "$FIX_ERRO")"
  m="$(confere "$r" 4 "$OUT" 'APPLY FALHOU' "$M_DIV" "$M_CTX_A3")"
  [ "$m" = CERTO ] || { printf 'A3: %s' "$m"; return 0; }
  OUT="$LOGS/$rot-A10.$COMBO.log"; r="$(rc_de "$FIX_ENVELOPE")"
  m="$(confere "$r" 2 "$OUT" 'BEGIN/COMMIT/ROLLBACK')"
  [ "$m" = CERTO ] || { printf 'A10: %s' "$m"; return 0; }
  OUT="$LOGS/$rot-A12.$COMBO.log"; r="$(rc_de "$FIX_CORPO")"
  m="$(confere "$r" 0 "$OUT" 'APLICADO')"
  [ "$m" = CERTO ] || { printf 'A12: %s' "$m"; return 0; }
  c="$(corpo_guardado)" || { printf 'A12b: a leitura do corpo guardado falhou'; return 0; }
  [ "$c" = "$CORPO_ARQ" ] || { printf 'A12b: o corpo guardado NAO e o do arquivo'; return 0; }
  printf 'CERTO'
}

# ── a máquina de sabotagem ───────────────────────────────────────────────────────────────────
# RECIBO para o runner (`db/roda-nucleo-ci.sh`): `SABOTAGENS: <v> vermelhas / <f> falhas`, emitido
# UMA vez e só neste modo. O runner exige f = 0 e v ≥ o `falsificar=<n>` do manifesto — ele confere
# formato e contagem, não sabe o que é sabotagem nem idioma: essa obrigação é daqui (Codex 2026-09-14).
SAB_VERMELHAS=0; SAB_FALHAS=0; SAB_IDS=" "; SAB_EXPRS=(); SAB_FALHARAM=""
sab_vermelha() { SAB_VERMELHAS=$((SAB_VERMELHAS + 1)); }
sab_falha()    { SAB_FALHAS=$((SAB_FALHAS + 1)); }
invalida()     { sab_falha; SAB_FALHARAM="$SAB_FALHARAM $1"; printf '  ❌ [%s] %s: %s — falsificacao VAZIA\n' "$1" "$2" "$3"; }

# registra <id> <alvo:expressao> — o recibo conta, não distingue "11 sabotagens" de "10 e uma
# repetida": sem isto, duplicar uma compensaria retirar outra, e o runner seguiria verde.
registra() {
  local e=""
  case "$SAB_IDS" in *" $1 "*) invalida "$1" "(id repetido)" "id DUPLICADO"; return 1 ;; esac
  # Comparação no PRÓPRIO shell, sem processo nem arquivo. `printf | grep -q` perdia a duplicata por
  # SIGPIPE sob `pipefail`; a here-string que o substituiu precisa de arquivo temporário no bash 3.2, e
  # sem ele (`cannot create temp file for here document`) o grep saía 1 — "inédita" — com status 0 no
  # fim (medido pelo Codex, 2026-09-14). Guard que falha para o lado de aceitar não é guard.
  for e in ${SAB_EXPRS[@]+"${SAB_EXPRS[@]}"}; do
    if [ "$e" = "$2" ]; then invalida "$1" "(expressao repetida)" "a MESMA sabotagem ja rodou com outro id"; return 1; fi
  done
  SAB_IDS="$SAB_IDS$1 "
  SAB_EXPRS+=("$2")
}

# prepara_sabotagem <executor|bootstrap> <expressao-perl> — toda sabotagem parte do executor INTACTO
# e muta UMA cópia, cujos MESMOS bytes rodam nas três combinações; o arquivo real nunca é tocado.
# Padrão que não casa é no-op silencioso, e no-op silencioso aprova tudo — aconteceu aqui: o apply
# passou de `-f -` para `-f "$APPLY_SQL"` e o padrão do S2 virou letra morta sem nada avisar. Por
# isso o `cmp` com os três desfechos: 1 (mudou) vale; 0 (inerte) e 2 (não comparou) invalidam.
PREP_MOTIVO=""
prepara_sabotagem() {
  local fonte="" destino="" rc_cmp=0
  case "$1" in
    executor)  fonte="$APLICAR"; destino="$ALVO" ;;
    bootstrap) fonte="$BOOT";    destino="$BOOT_SAB" ;;
    *) PREP_MOTIVO="alvo desconhecido '$1'"; return 1 ;;
  esac
  cp "$APLICAR" "$ALVO" || { PREP_MOTIVO="o cp do executor intacto falhou"; return 1; }
  cp "$fonte" "$destino" || { PREP_MOTIVO="o cp de $fonte falhou"; return 1; }
  perl -0pi -e "$2" "$destino" 2> "$WORK/perl.err" \
    || { PREP_MOTIVO="o perl falhou: $(head -c 120 "$WORK/perl.err")"; return 1; }
  cmp -s "$fonte" "$destino" || rc_cmp=$?
  case "$rc_cmp" in
    1) return 0 ;;
    0) PREP_MOTIVO="o padrao nao casou com o codigo — nada foi sabotado"; return 1 ;;
    *) PREP_MOTIVO="o cmp nao conseguiu comparar (rc=$rc_cmp)"; return 1 ;;
  esac
}

# prepara_gemeo — a cópia do executor E a do bootstrap voltam a ser byte a byte as originais, com o
# `cmp` conferindo: um gêmeo "verde" rodando sobre a sabotagem ANTERIOR mediria outra coisa.
prepara_gemeo() {
  local rc_a=0 rc_b=0
  if ! cp "$APLICAR" "$ALVO" || ! cp "$BOOT" "$BOOT_SAB"; then PREP_MOTIVO="o cp do gemeo intacto falhou"; return 1; fi
  cmp -s "$APLICAR" "$ALVO" || rc_a=$?
  cmp -s "$BOOT" "$BOOT_SAB" || rc_b=$?
  if [ "$rc_a" -ne 0 ] || [ "$rc_b" -ne 0 ]; then
    PREP_MOTIVO="o gemeo nao e identico ao original (cmp executor=$rc_a bootstrap=$rc_b)"; return 1
  fi
}

# combos_completos <vistas> — ecoa OK só se c_c, c_pt e pt_pt aparecem EXATAMENTE uma vez cada. Três
# julgamentos não são três combinações: `c_pt c_pt pt_pt` também soma três (Codex 2026-09-14).
combos_completos() {
  local cb="" x="" n=0 vezes=0 falta=""
  for x in $1; do n=$((n + 1)); done
  for cb in c_c c_pt pt_pt; do
    vezes=0
    for x in $1; do if [ "$x" = "$cb" ]; then vezes=$((vezes + 1)); fi; done
    [ "$vezes" -eq 1 ] || falta="$falta $cb=$vezes"
  done
  if [ -z "$falta" ] && [ "$n" -eq 3 ]; then printf 'OK'; else printf 'combinacoes julgadas [%s ] (%s no total)' "$falta" "$n"; fi
}

# sabotagem <id> <descricao> <executor|bootstrap> <expressao-perl> <cenario> [<combinações-IGUAL>] —
# julga o cenário nas TRÊS combinações, nomeadas aqui e não numa variável: encurtar uma lista seria o
# jeito de pular um idioma sem nada ficar vermelho. Cada julgamento tem de TERMINAR (status 0) E dizer
# a palavra PREVISTA para aquela combinação: IGUAL (não mudou, e era para não mudar) só onde o 6º
# argumento diz — S10 em c_c/c_pt, S11 em pt_pt —, CERTO (vermelha pelo motivo certo) nas outras.
# `printf CERTO; exit 137` numa `$(...)` captura exatamente "CERTO"; e IGUAL aceito em qualquer posição
# dispensaria uma combinação inteira (os dois pelo Codex, 2026-09-14). Antes de sabotar, o GÊMEO verde:
# o MESMO cenário na cópia INTACTA tem de terminar dizendo alguma coisa que NÃO seja CERTO. Marca que
# também sai sem a sabotagem não é marca — "exclusiva da falha" se MEDE contra o verde da mesma
# invocação (#2487); aqui, S4 e S9 terminam com o MESMO rc do verde (0). Uma unidade do recibo por
# sabotagem, só depois de tudo isso.
SAB_JULGADAS=""; FASE=""
sabotagem() {
  local id="$1" desc="$2" alvo="$3" expr="$4" cen="$5" igual_em="${6:-}" cb="" m="" st=0 motivo=""
  local esperado="" vistas="" n_verm=0 combos=""
  SAB_JULGADAS="$SAB_JULGADAS $id"
  registra "$id" "$alvo:$expr" || return 0
  if ! prepara_gemeo; then invalida "$id" "$desc" "$PREP_MOTIVO"; return 0; fi
  FASE=gemeo
  for cb in c_c c_pt pt_pt; do
    seleciona_combo "$cb"
    OUT="$LOGS/$id.$cb.gemeo.log"
    vistas="$vistas $cb"
    st=0; m="$(roda_cenario "$cen")" || st=$?
    if [ "$st" -ne 0 ]; then
      motivo="$motivo [$cb: o GEMEO verde MORREU (status $st)]"
    elif [ -z "$m" ]; then
      motivo="$motivo [$cb: o GEMEO verde saiu sem veredito]"
    elif [ "$m" = CERTO ]; then
      motivo="$motivo [$cb: diz CERTO SEM a sabotagem, a marca nao discrimina]"
    fi
  done
  combos="$(combos_completos "$vistas")"
  [ "$combos" = OK ] || motivo="$motivo [gemeo: ${combos:-sem conferencia das combinacoes}]"
  if [ -n "$motivo" ]; then
    sab_falha
    SAB_FALHARAM="$SAB_FALHARAM $id"
    printf '  ❌ [%s] %s — gemeo verde:%s\n' "$id" "$desc" "$motivo"
    return 0
  fi
  if ! prepara_sabotagem "$alvo" "$expr"; then invalida "$id" "$desc" "$PREP_MOTIVO"; return 0; fi
  FASE=sabotado
  vistas=""
  for cb in c_c c_pt pt_pt; do
    seleciona_combo "$cb"
    OUT="$LOGS/$id.$cb.log"
    vistas="$vistas $cb"
    case " $igual_em " in *" $cb "*) esperado=IGUAL ;; *) esperado=CERTO ;; esac
    st=0; m="$(roda_cenario "$cen")" || st=$?
    if [ "$st" -ne 0 ]; then
      motivo="$motivo [$cb: o cenario MORREU (status $st) depois de dizer '${m:0:60}']"
    elif [ "$m" != "$esperado" ]; then
      motivo="$motivo [$cb: ${m:-o cenario saiu sem veredito} (previsto: $esperado)]"
    elif [ "$m" = CERTO ]; then
      n_verm=$((n_verm + 1))
    fi
  done
  combos="$(combos_completos "$vistas")"
  [ "$combos" = OK ] || motivo="$motivo [${combos:-sem conferencia das combinacoes}]"
  if [ -z "$motivo" ] && [ "$n_verm" -ge 1 ]; then
    sab_vermelha
    printf '  ✅ [%s] %s — vermelha pelo motivo certo (%s/3 vermelhas; as outras, como previsto)\n' "$id" "$desc" "$n_verm"
  else
    sab_falha
    SAB_FALHARAM="$SAB_FALHARAM $id"
    printf '  ❌ [%s] %s:%s\n' "$id" "$desc" "${motivo:- [nenhuma combinacao ficou vermelha]}"
  fi
}

# ── cenários: um por sabotagem; cada um ecoa CERTO só no fim, e o motivo em qualquer outra saída ──
cen_s1() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_OK")"
  confere "$r" 5 "$OUT" 'RESULTADO DESCONHECIDO (rc=0,' "marcador 'NUNCA_APARECE' ausente"
}
cen_s4() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_OK")"
  confere "$r" 0 "$OUT" 'COMMIT CHEGOU'
}
cen_s2() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_ERRO")"
  # a severidade do banco ESTÁ no log (o erro aconteceu) e mesmo assim o psql saiu 0
  confere "$r" 5 "$OUT" "$M_DIV" 'RESULTADO DESCONHECIDO (rc=0,' "marcador 'FIM_APLICACAO_OK' ausente" "$M_CTX"
}
cen_s3() {
  local r="" m="" n=""
  limpo || return 0
  r="$(rc_de "$FIX_OK")"
  m="$(confere "$r" 0 "$OUT" 'APLICADO')"
  [ "$m" = CERTO ] || { printf 'preparo, 1a aplicacao: %s' "$m"; return 0; }
  n="$(q_estrito "select count(*) from public.db_aplicacoes where estado='aplicada'")" \
    || { printf 'preparo: a leitura do ledger falhou'; return 0; }
  [ "$n" = 1 ] || { printf "preparo: esperava 1 recibo 'aplicada', veio '%s'" "$n"; return 0; }
  r="$(rc_de "$FIX_OK")"
  # leu 'aplicada', seguiu mesmo assim (tentativa registrada), e o ÍNDICE ÚNICO barrou o 2º recibo
  confere "$r" 4 "$OUT" 'ledger: aplicada' 'tentativa #' 'APPLY FALHOU' 'db_aplicacoes_sha_aplicada_uniq' "$M_CTX"
}
cen_s5() {
  local r="" m="" t=""
  limpo || return 0
  r="$(rc_de "$FIX_ENVELOPE")"
  m="$(confere "$r" 4 "$OUT" 'tentativa #' 'APPLY FALHOU' "$M_ENVELOPE" "$M_CTX")"
  [ "$m" = CERTO ] || { printf '%s' "$m"; return 0; }
  # E a transação do script voltou atrás: envelope quebrado no meio é a meia-migration que o desenho
  # inteiro existe para impedir.
  t="$(q_estrito "select to_regclass('public.fixture_aplicar_envelope') is null")" \
    || { printf 'a leitura da tabela do envelope falhou'; return 0; }
  [ "$t" = t ] || { printf "a tabela do envelope NASCEU (veio '%s')" "$t"; return 0; }
  printf 'CERTO'
}
cen_s6() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_CIC")"
  confere "$r" 4 "$OUT" 'tentativa #' 'APPLY FALHOU' "$M_CIC_SEV" "$M_CIC" "$M_CTX"
}
cen_s7() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_CORPO")"
  confere "$r" 2 "$OUT" 'BEGIN/COMMIT/ROLLBACK'
}
cen_s8() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_CORPO")"
  confere "$r" 4 "$OUT" 'APPLY FALHOU' 'APLICAR_SQL: sha divergente' "$M_CTX"
}
# S10/S11 — a regex por idioma. O desfecho DEPENDE da combinação, e o lado que NÃO muda é tão parte
# da captura quanto o que muda: se c_c também virasse 5 na S10, a sabotagem estaria pegando outra
# coisa. O lado que não muda responde IGUAL (o desfecho de controle, com a marca dele), nunca CERTO:
# a `sabotagem` exige ≥1 vermelha observada, e sem essa separação pular o pt_pt deixaria a S10
# "capturada" sem nenhuma combinação ter ficado vermelha.
igual_se_certo() { if [ "$1" = CERTO ]; then printf 'IGUAL'; else printf '%s' "$1"; fi; }
cen_s10() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_ERRO")"
  case "$COMBO" in
    pt_pt) confere "$r" 5 "$OUT" 'RESULTADO DESCONHECIDO (rc=3,' "$M_DIV" "$M_CTX" ;;
    *)     igual_se_certo "$(confere "$r" 4 "$OUT" 'APPLY FALHOU' "$M_DIV" "$M_CTX")" ;;
  esac
}
cen_s11() {
  local r=""
  limpo || return 0
  r="$(rc_de "$FIX_ERRO")"
  case "$COMBO" in
    pt_pt) igual_se_certo "$(confere "$r" 4 "$OUT" 'APPLY FALHOU' "$M_DIV" "$M_CTX")" ;;
    *)     confere "$r" 5 "$OUT" 'RESULTADO DESCONHECIDO (rc=3,' "$M_DIV" "$M_CTX" ;;
  esac
}
# restaura_bootstrap — devolve a função verdadeira e CONFERE pela definição instalada (o md5 do
# prosrc gravado depois do bootstrap original), não pelo exit do psql: "restaurei" sem asserção é a
# mesma família de ausente ≠ zero (docs/historico/falsificacao-sem-linha-de-base.md).
restaura_bootstrap() {
  local md5=""
  $PSQL -f "$BOOT" > "$CDIR/boot-restaura.log" 2>&1 || return 1
  grep -q 'BOOTSTRAP_OK' "$CDIR/boot-restaura.log" || return 1
  md5="$(md5_aplicar_sql)" || return 1
  [ -n "$md5" ] && [ "$md5" = "$(cat "$CDIR/aplicar_sql.md5")" ]
}
# S9 — o sha é conferido DENTRO de aplicar_sql. Uma transformação aplicada DEPOIS dessa conferência
# passa por todos os guards do cliente, pelo ledger e pelo próprio sha — e é onde um peel teria de
# morar. Sem ela, A12b seria verde por INALCANÇÁVEL. A transformação some com a indentação: o corpo
# segue VÁLIDO e a função é criada normalmente — a corrupção silenciosa de verdade. Mexe no bootstrap
# do cluster da combinação, e o devolve conferido antes de julgar.
cen_s9() {
  local r="" m="" c="" inst=""
  limpo || return 0
  if ! $PSQL -f "$BOOT_SAB" > "$OUT.boot" 2>&1 || ! grep -q 'BOOTSTRAP_OK' "$OUT.boot"; then
    printf 'o bootstrap sabotado nao aplicou'; restaura_bootstrap || true; return 0
  fi
  inst="$(q_estrito "select position('regexp_replace(p_sql' in prosrc) > 0 from pg_proc where oid='public.aplicar_sql(text,text,bigint)'::regprocedure")" \
    || inst="(leitura falhou)"
  if [ "$inst" != t ]; then
    printf 'a funcao instalada NAO e a sabotada (veio %s)' "$inst"; restaura_bootstrap || true; return 0
  fi
  r="$(rc_de "$FIX_CORPO")"
  m="$(confere "$r" 0 "$OUT" 'APLICADO')"
  if [ "$m" = CERTO ]; then c="$(corpo_guardado)" || m='a leitura do corpo guardado falhou'; fi
  restaura_bootstrap || { printf 'a RESTAURACAO do bootstrap falhou: a aplicar_sql() do cluster %s segue sabotada?' "$CLUSTER"; return 0; }
  [ "$m" = CERTO ] || { printf '%s' "$m"; return 0; }
  [ "$c" != "$CORPO_ARQ" ] || { printf 'o corpo guardado e IGUAL ao arquivo: a transformacao do servidor nao aconteceu'; return 0; }
  [ "$c" = "$CORPO_PEEL" ] || { printf 'o corpo guardado mudou, mas NAO do jeito da sabotagem'; return 0; }
  printf 'CERTO'
}

# roda_cenario <nome> — despacho EXPLÍCITO, não `"$cen"`: o shellcheck enxerga cada chamada, e um
# nome errado cai no `*)`, que diz o motivo em vez de executar outra coisa.
roda_cenario() {
  case "$1" in
    s1) cen_s1 ;;  s2) cen_s2 ;;  s3) cen_s3 ;;  s4) cen_s4 ;;  s5) cen_s5 ;;  s6) cen_s6 ;;
    s7) cen_s7 ;;  s8) cen_s8 ;;  s9) cen_s9 ;;  s10) cen_s10 ;;  s11) cen_s11 ;;
    *) printf "cenario desconhecido '%s'" "$1" ;;
  esac
}

# ── 1. SONDAS — o ambiente que a falsificação promete existe? Resposta POSITIVA, antes de tudo ───
echo "▶ SONDAS do ambiente — ausencia ABORTA, nunca pula"
v_psql="$("$PGBIN/psql" --version 2>/dev/null || true)"
case "$v_psql" in
  *"(PostgreSQL) $PGVER."*) nota "o psql do shim e do executor e PostgreSQL $PGVER ($v_psql)" ;;
  *) aborta PSQL_DE_OUTRA_MAJOR "o psql que o shim usa ($PGBIN/psql) respondeu '$v_psql'; esperado PostgreSQL $PGVER" ;;
esac
# O locale existe e resolve para UTF-8. Sem ele o glibc cai para ANSI_X3.4-1968 e só AVISA no stderr.
charmap="$(LC_ALL=pt_BR.UTF-8 locale charmap 2>/dev/null || true)"
if [ "$charmap" != "UTF-8" ]; then
  aborta LOCALE_PT_BR_AUSENTE \
    "LC_ALL=pt_BR.UTF-8 nao resolve para UTF-8 (veio '$charmap')." \
    "Sem ele, c_pt e pt_pt seriam C disfarcado: o 2o idioma deixaria de existir sem nada ficar vermelho." \
    "Ubuntu: sudo locale-gen pt_BR.UTF-8 (o job provas-sql provisiona antes do nucleo)."
fi
nota "LC_ALL=pt_BR.UTF-8 resolve para UTF-8"
[ "$CORPO_PEEL" != "$CORPO_ARQ" ] || aborta FIXTURE_SEM_INDENTACAO \
  "o corpo de $FIX_CORPO nao tem linha indentada: a transformacao da S9 nao mudaria nada nele"

for cl in c pt; do
  seleciona_cluster "$cl"
  sobe_cluster
  if ! $PSQL -f "$BOOT" > "$CDIR/boot.log" 2>&1 || ! grep -q 'BOOTSTRAP_OK' "$CDIR/boot.log"; then
    aborta BOOTSTRAP_FALHOU "cluster $cl: $(tail -c 300 "$CDIR/boot.log" | tr '\n' ' ')"
  fi
  md5_aplicar_sql > "$CDIR/aplicar_sql.md5" || aborta BOOTSTRAP_ILEGIVEL "cluster $cl: nao consegui ler a aplicar_sql() instalada"
  [ -s "$CDIR/aplicar_sql.md5" ] || aborta BOOTSTRAP_ILEGIVEL "cluster $cl: a aplicar_sql() instalada veio vazia"
  nota "cluster $cl no ar (lc_messages=$LOC_SRV), bootstrap aplicado"
done

for cb in c_c c_pt pt_pt; do
  seleciona_combo "$cb"
  # idioma do SERVIDOR, perguntado como o executor pergunta: sessão do claude_rw, pelo shim
  lcm="$(LC_ALL="$LOC_CLI" LANG="$LOC_CLI" "$SHIM" -X -A -t -v ON_ERROR_STOP=1 -c 'SHOW lc_messages' 2>/dev/null || true)"
  [ "$lcm" = "$SRV_ESPERADO" ] || aborta IDIOMA_DO_SERVIDOR \
    "[$cb] a sessao do claude_rw diz lc_messages='$lcm'; a combinacao $cb exige '$SRV_ESPERADO'"
  # idioma do CLIENTE, numa falha real que ele mesmo gera: um socket que não existe
  cli="$(LC_ALL="$LOC_CLI" LANG="$LOC_CLI" "$PGBIN/psql" -X -h "$WORK" -p 9 -U postgres -d postgres -c 'select 1' 2>&1 || true)"
  case "$cli" in
    *"$M_CLIENTE"*) ;;
    *) aborta IDIOMA_DO_CLIENTE "[$cb] o psql com LC_ALL=$LOC_CLI nao disse '$M_CLIENTE' numa conexao recusada:" \
         "$(printf '%s' "$cli" | head -c 200 | tr '\n' ' ')" ;;
  esac
  nota "[$cb] a sessao do servidor diz lc_messages=$lcm; o cliente diz '$M_CLIENTE' numa conexao recusada"
done

# ── 2. CONTROLE VERDE nas três, antes da primeira sabotagem ─────────────────────────────────────
# O CONTROLE ABORTA — não reporta e segue. Sabotagem só prova algo contra uma linha de base VERDE: se
# a CÓPIA já não reproduz o original NEM SABOTADA, toda sabotagem passa a "mudar o rc" por acidente e
# fica verde. Aconteceu aqui: o #2421 fez `db-aplicar.sh` resolver um helper por `dirname "$0"` —
# caminho que, na cópia, não existe. A cópia morria no preflight ANTES da primeira sabotagem, e as
# sabotagens seguintes "mudaram o rc" sem tocar em nada. O bloco de controle DETECTOU e seguiu,
# imprimindo linhas verdes antes do veredito: detectar e seguir é quase não detectar. O #2434
# removeu AQUELA dependência; este aborto é a defesa contra a PRÓXIMA.
echo "▶ CONTROLE (sem sabotagem, na COPIA, nas 3 combinacoes) — tem de estar VERDE antes de sabotar"
cp "$APLICAR" "$ALVO"
for cb in c_c c_pt pt_pt; do
  seleciona_combo "$cb"
  st=0; m="$(controle_combo controle)" || st=$?
  if [ "$st" -ne 0 ] || [ "$m" != CERTO ]; then
    passo="${m%%:*}"
    aborta CONTROLE_VERMELHO "[$cb] ${m:-o controle saiu sem veredito} (status $st)" \
      "A copia nao reproduz o original NEM SABOTADA: toda sabotagem mudaria o rc por acidente, e" \
      "sabotagem sempre-vermelha APROVA TUDO. Suspeite, nesta ordem: dependencia que a copia nao acha" \
      "ao lado de si (#2421), cluster caido, fixture alterada, idioma que nao veio. A copia respondeu:" \
      "$(tail -c 700 "$LOGS/controle-$passo.$cb.log" 2>/dev/null | tr '\n' ' ')"
  fi
  nota "[$cb] A1 aplica · A3 sai 4 dizendo '$M_DIV' e '$M_CTX_A3' · A10 recusa o envelope · A12 aplica com o corpo intacto"
done

# ── 3. CONTROLES NEGATIVOS DO JUIZ, também antes da primeira sabotagem ─────────────────────────
# O controle acima prova que o laço sabe dizer VERDE; estes, que o juiz sabe dizer NÃO. Sem eles um
# `confere` que sempre dissesse CERTO aprovaria toda sabotagem — o sempre-vermelho um nível acima.
echo "▶ CONTROLES NEGATIVOS DO JUIZ — ele sabe recusar o vermelho errado?"
recusa_ou_aborta() { # <descricao> <veredito-que-o-juiz-deu>
  [ "$2" != CERTO ] || aborta JUIZ_ACEITA_VERMELHO_ERRADO "o juiz ACEITOU $1: sem este dente ele aprovaria qualquer vermelho"
  nota "o juiz recusa $1 (${2:0:70})"
}
L_C="$LOGS/controle-A3.c_c.log"; L_PT="$LOGS/controle-A3.pt_pt.log"
recusa_ou_aborta "rc certo SEM a marca"                        "$(confere 4 4 "$L_C" 'MARCA_QUE_NENHUMA_SAIDA_TEM')"
recusa_ou_aborta "a marca certa com o rc ERRADO"               "$(confere 4 5 "$L_C" 'APPLY FALHOU')"
recusa_ou_aborta "a severidade pt_BR numa saida do servidor C" "$(confere 4 4 "$L_C" 'ERRO:  divis')"
recusa_ou_aborta "a severidade C numa saida do servidor pt_BR" "$(confere 4 4 "$L_PT" 'ERROR:  division by zero')"
recusa_ou_aborta "o rotulo pt_BR numa saida do cliente C"      "$(confere 4 4 "$L_C" 'CONTEXTO:  ')"
recusa_ou_aborta "o rotulo C numa saida do cliente pt_BR"      "$(confere 4 4 "$LOGS/controle-A3.c_pt.log" 'CONTEXT:  ')"
recusa_ou_aborta "um log que nao existe"                       "$(confere 4 4 "$LOGS/nao-existe.log" 'APPLY FALHOU')"

# A agregação também tem de saber dizer NÃO. Oito formas que um laço de sabotagem aceitaria como
# captura — cinco no julgamento da sabotagem: a morte calada, a palavra seguida de morte, o silêncio
# numa combinação só, o "nada mudou em lugar nenhum" (IGUAL previsto e visto nas três) e o IGUAL numa posição em que a
# sabotagem prevê vermelho; e três no GÊMEO verde: o cenário que diz CERTO também sem a sabotagem, o
# gêmeo que fala e morre, e o gêmeo calado. Roda o `sabotagem` DE VERDADE num subshell, com o DESPACHO
# de cenário trocado e os desfechos virando códigos de saída: 42 = creditou (o defeito), 43 = recusou
# (o certo). Custo ~0: nem PG, nem executor. Nas cinco primeiras o gêmeo responde o que um cenário
# honesto responderia sem a sabotagem — um motivo —, para cada controle atacar uma camada só.
for caso in morre_calado diz_certo_e_morre calado_numa so_igual igual_numa sempre_certo gemeo_morre gemeo_calado; do
  rc_m=0
  ( sab_vermelha() { exit 42; }; sab_falha() { exit 43; }; invalida() { exit 44; }
    registra() { return 0; }; prepara_sabotagem() { return 0; }; prepara_gemeo() { return 0; }
    case "$caso" in
      morre_calado)      roda_cenario() { [ "$FASE" = gemeo ] && { printf "rc '4', esperado 5"; return 0; }; exit 137; } ;;
      diz_certo_e_morre) roda_cenario() { [ "$FASE" = gemeo ] && { printf "rc '4', esperado 5"; return 0; }; printf 'CERTO'; exit 137; } ;;
      calado_numa)       roda_cenario() { [ "$FASE" = gemeo ] && { printf "rc '4', esperado 5"; return 0; }; [ "$COMBO" = c_pt ] || printf 'CERTO'; } ;;
      so_igual)          roda_cenario() { printf 'IGUAL'; } ;;
      igual_numa)        roda_cenario() { [ "$FASE" = gemeo ] && { printf "rc '4', esperado 5"; return 0; }; if [ "$COMBO" = c_pt ]; then printf 'IGUAL'; else printf 'CERTO'; fi; } ;;
      sempre_certo)      roda_cenario() { printf 'CERTO'; } ;;
      gemeo_morre)       roda_cenario() { [ "$FASE" = gemeo ] && { printf "rc '4', esperado 5"; exit 137; }; printf 'CERTO'; } ;;
      gemeo_calado)      roda_cenario() { [ "$FASE" = gemeo ] && return 0; printf 'CERTO'; } ;;
    esac
    # `so_igual` PREVÊ IGUAL nas três: passa pela checagem de posição, e só a guarda de ≥1 vermelha o
    # recusa — é o controle próprio dela. Os outros não preveem IGUAL em lugar nenhum.
    if [ "$caso" = so_igual ]; then igual_em="c_c c_pt pt_pt"; else igual_em=""; fi
    sabotagem "juiz-$caso" "controle: $caso" executor 'x' s1 "$igual_em" ) >/dev/null 2>&1 || rc_m=$?
  case "$rc_m" in
    43) nota "a agregacao recusa um cenario $caso" ;;
    42) aborta JUIZ_CREDITA "o laco CREDITOU um cenario $caso" ;;
    *)  aborta JUIZ_SEM_DECISAO "o controle '$caso' nao chegou a decisao (rc=$rc_m)" ;;
  esac
done

# ── 4. SABOTAGENS — uma camada por vez, na cópia; cada uma julgada nas três combinações ─────────
echo "▶ SABOTAGENS — cada uma com rc EXATO + marca, nas 3 combinacoes"
# S1: a 1ª versão forçava TEM_MARCADOR=1 e rodava a fixture de ERRO — e ficava VERDE, porque com
# rc≠0 o marcador não decide nada. O cenário em que o marcador é a ÚNICA testemunha é o de psql saindo
# 0 SEM ele. A sabotagem não interrompe nada — o apply conclui de verdade (Codex 2026-09-14) —: ela cega
# as DUAS testemunhas de que concluiu, o marcador E a reconciliação pelo ledger, e com as duas cegas o
# veredito honesto é "não sei". Cegar só uma deixa a outra responder certo (é a S4). E o código EXATO:
# a versão frouxa aceitou exit 1, que era o script MORRENDO por `set -e` com o ramo DESCONHECIDO
# inalcançável logo abaixo.
sabotagem S1 "marcador E reconciliacao cegos (o apply conclui; as duas testemunhas nao veem)" executor \
  "s/^MARCADOR='FIM_APLICACAO_OK'\$/MARCADOR='NUNCA_APARECE'/m; s/^  EST_POS=.*\$/  EST_POS=''/m" s1
sabotagem S4 "so o marcador cego: o LEDGER responde e o script avisa, nao finge" executor \
  "s/^MARCADOR='FIM_APLICACAO_OK'\$/MARCADOR='NUNCA_APARECE'/m" s4
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE do script
# alvo, onde $APPLY_SQL aparece literalmente. Expandir aqui faria o padrao procurar o caminho do
# arquivo temporario — que nao existe no codigo — e a sabotagem viraria inerte.
sabotagem S2 "ON_ERROR_STOP removido (o erro deixa de ser erro)" executor \
  's/-X -v ON_ERROR_STOP=1 -f "\$APPLY_SQL"/-X -f "\$APPLY_SQL"/; s/set ON_ERROR_STOP on//' s2
sabotagem S3 "checagem de 'ja aplicada' removida (re-apply deixa de ser no-op)" executor \
  's/\*aplicada\*\)/*JAMAIS_CASA*)/' s3
# S5: a alternância literal só existe no regex da checagem (linha única em db-aplicar.sh); a mensagem
# e o comentário escrevem com barras, BEGIN/COMMIT/ROLLBACK, e não casam. Trocá-la por um nome que
# nunca aparece em SQL deixa o `grep` sintaticamente vivo e semanticamente morto. O 4 é o BANCO
# recusando por conta própria: é o que prova que A10 mede a recusa DO SCRIPT, e não uma barreira que
# existiria de qualquer jeito.
sabotagem S5 "recusa do envelope removida (o corpo com BEGIN; chega ao banco)" executor \
  's/\(BEGIN\|COMMIT\|ROLLBACK\|START TRANSACTION\)/(JAMAIS_CASA_ENVELOPE)/' s5
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE do script
sabotagem S6 "guard de nao-transacional desligado (CREATE INDEX CONCURRENTLY vai ao banco)" executor \
  's/^if \[ -n "\$FORA_TX" \]; then/if false; then/m' s6
# S7: S5/S6 provam que os guards PEGAM o que devem. Só S7 prova que A12 morde quando um guard passa a
# pegar o que NÃO deve: `END;` fecha bloco PL/pgSQL em coluna 0 dentro de $funcao$, e incluí-lo
# recusaria 81 arquivos legítimos do repo.
sabotagem S7 "guard ALARGADO para casar END; (a SOBRE-recusa derruba o controle)" executor \
  's/\(BEGIN\|COMMIT\|ROLLBACK\|START TRANSACTION\)/(BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)/' s7
# S8: aplicar_sql() RE-CALCULA o sha256 do corpo recebido e compara com o declarado. Qualquer
# transformação feita pelo cliente quebra a cadeia — foi o que derrubou o desenvelopamento do #2421.
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE do script
sabotagem S8 "transformacao no CLIENTE (o banco e o freio)" executor \
  's/^  cat "\$SNAP"$/  sed "\/^END;\$\/d" "\$SNAP"/m' s8
sabotagem S10 "regex sem ERRO (so o servidor pt_BR deixa de ser reconhecido)" executor \
  's/\(ERRO\|ERROR\|FATAL\|PANIC\)/(ERROR|FATAL|PANIC)/' s10 "c_c c_pt"
sabotagem S11 "regex so com ERRO: (so o servidor em ingles deixa de ser reconhecido)" executor \
  's/\(ERRO\|ERROR\|FATAL\|PANIC\)/(ERRO:|FATAL|PANIC)/' s11 pt_pt
# S9 por último: é a única que muda a função instalada nos clusters.
sabotagem S9 "transformacao SERVER-SIDE (so o corpo guardado a enxerga)" bootstrap \
  's/^  EXECUTE p_sql;$/  EXECUTE regexp_replace(p_sql, E\x27\\n  \x27, E\x27\\n\x27, \x27g\x27);/m' s9

# Identidade, não contagem: cada sabotagem prevista foi julgada exatamente UMA vez, e nenhuma além
# delas. O recibo só conta — duplicar uma e apagar outra daria o mesmo 11. O `registra` barra a
# duplicata; esta conferência não depende dele.
IDS_ESPERADOS="S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11"
n_esp=0; n_julg=0
for x in $IDS_ESPERADOS; do n_esp=$((n_esp + 1)); done
for x in $SAB_JULGADAS;  do n_julg=$((n_julg + 1)); done
for esperado in $IDS_ESPERADOS; do
  vezes=0
  for x in $SAB_JULGADAS; do if [ "$x" = "$esperado" ]; then vezes=$((vezes + 1)); fi; done
  if [ "$vezes" -ne 1 ]; then
    sab_falha; SAB_FALHARAM="$SAB_FALHARAM $esperado"
    printf '  ❌ [%s] julgada %s vez(es): a lista de sabotagens nao bate com a prevista\n' "$esperado" "$vezes"
  fi
done
if [ "$n_julg" -ne "$n_esp" ]; then
  sab_falha
  printf '  ❌ %s julgamento(s) de sabotagem para %s previstas: ha sabotagem fora da lista\n' "$n_julg" "$n_esp"
fi
# Um log por (sabotagem, combinação), conferido pelo DISCO e não pela contagem do laço: se o laço
# julgasse `c_pt` duas vezes e `c_c` nenhuma, a conta de julgamentos seguiria fechando — o arquivo de
# `c_c` é que não existiria (2ª camada do "três julgamentos não são três combinações").
for esperado in $IDS_ESPERADOS; do
  for cb in c_c c_pt pt_pt; do
    if [ ! -s "$LOGS/$esperado.$cb.log" ]; then
      sab_falha; SAB_FALHARAM="$SAB_FALHARAM $esperado"
      printf '  ❌ [%s] sem log da combinacao %s: ela nao foi julgada\n' "$esperado" "$cb"
    fi
  done
done

# ── 5. CONTROLE DE SAÍDA — a cópia e o bootstrap voltaram, e o verde voltou nas três? ──────────
echo "▶ CONTROLE DE SAIDA — copia e bootstrap de volta ao original, e o verde de volta nas 3"
cp "$APLICAR" "$ALVO"
rc_cmp=0; cmp -s "$APLICAR" "$ALVO" || rc_cmp=$?
[ "$rc_cmp" -eq 0 ] || aborta SAIDA_COPIA_NAO_VOLTOU "a copia do executor nao voltou ao original (cmp rc=$rc_cmp)"
for cb in c_c c_pt pt_pt; do
  seleciona_combo "$cb"
  md5="$(md5_aplicar_sql)" || md5="(leitura falhou)"
  [ "$md5" = "$(cat "$CDIR/aplicar_sql.md5")" ] \
    || aborta SAIDA_BOOTSTRAP_SABOTADO "[$cb] a aplicar_sql() do cluster $CLUSTER nao e a original (md5 $md5)"
  st=0; m="$(controle_combo saida)" || st=$?
  if [ "$st" -ne 0 ] || [ "$m" != CERTO ]; then
    aborta SAIDA_VERMELHA "[$cb] ${m:-o controle de saida saiu sem veredito} (status $st)" \
      "as sabotagens deixaram o ambiente diferente do que o controle de entrada mediu: nenhum recibo vale"
  fi
  nota "[$cb] verde de volta"
done

# ── 6. RECIBO — exatamente um, e só aqui ──────────────────────────────────────────────────────
echo
[ -z "$SAB_FALHARAM" ] || echo "  ❌ sabotagens sem o vermelho certo:$SAB_FALHARAM"
printf 'SABOTAGENS: %s vermelhas / %s falhas\n' "$SAB_VERMELHAS" "$SAB_FALHAS"
if [ "$SAB_FALHAS" -eq 0 ]; then echo "FIM_FALSIFICACAO_OK"; else echo "FIM_FALSIFICACAO_VERMELHO"; fi
RC_FINAL="$SAB_FALHAS"
fi

# O veredito é a ÚLTIMA instrução, fora dos dois ramos — e não um `exit` no fim de cada um: com os
# dois ramos terminando em `exit`, o shellcheck 0.11 conclui que o fim do script é inalcançável e
# que a `cleanup` do `trap ... EXIT` nunca roda (SC2329 — falso positivo, medido em 2026-09-14).
[ "$RC_FINAL" -eq 0 ]
