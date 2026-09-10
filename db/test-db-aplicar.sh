#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════╗
# ║   PROVA PG17 — db/claude-rw-bootstrap.sql + scripts/db-aplicar.sh                       ║
# ║   Rode:  bash db/test-db-aplicar.sh > /tmp/t.log 2>&1; echo $?                          ║
# ║          bash db/test-db-aplicar.sh --falsificar    (9 sabotagens, exige VERMELHO)      ║
# ║   Exit:  0 verde · 1 asserção vermelha · 3 CONTROLE podre (a falsificação nem começou)  ║
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
# ║   Falsifica: (S1) marcador E reconciliação cegos → veredito honesto: 5 (não sei);       ║
# ║              (S2) ON_ERROR_STOP removido → A3 troca 4 por 5 (erro vira desconhecido);   ║
# ║              (S3) checagem de 'já aplicada' removida → A2 aplica duas vezes;            ║
# ║              (S4) só o marcador cego → o ledger responde e o script AVISA, não finge;   ║
# ║              (S5) recusa do envelope removida → o corpo chega ao banco e A10 vira 4.    ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# Esta prova está em `db/nucleo-ci.txt` (job `provas-sql`): roda no caminho OBRIGATÓRIO do merge,
# em modo normal, com mínimo de asserts declarado lá. Encolhê-la reprova o CI até alguém baixar
# aquele número — e aí a perda de cobertura fica no diff, que é o ponto. O `--falsificar` continua
# sendo local: ele sabota uma cópia e não é o que o runner executa.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# PGBIN resolvido por PLATAFORMA (macOS Homebrew / Linux PGDG), com conferência POSITIVA da
# major — não `-x`, que um initdb de outra versão satisfaz. Hardcodar /opt/homebrew era a única
# coisa que mantinha esta prova FORA do CI: o runner é ubuntu e o caminho não existe lá.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5481}"
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
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── cluster ─────────────────────────────────────────────────────────────────────────────
"$PGBIN/initdb" -D "$DATA" -U postgres --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost" -l "$WORK/pg.log" -w start >/dev/null 2>&1

PSQL="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h localhost -p $PORT -U postgres -d postgres"
q() { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null | tr -d ' \n'; }
# q() esmaga espaco e quebra de linha — serve para escalar, nao para corpo de funcao.
q_bruto() { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null; }

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

# O CONTROLE ABORTA — não reporta e segue. Sabotagem só prova algo contra uma linha de base
# VERDE: se a CÓPIA já não reproduz o original NEM SABOTADA, toda sabotagem passa a "mudar o rc"
# por acidente e fica verde. Sabotagem sempre-vermelha APROVA TUDO
# (docs/historico/falsificacao-sem-linha-de-base.md).
#
# Aconteceu aqui, e é a razão de este bloco existir: o #2421 fez `db-aplicar.sh` resolver um
# helper por `dirname "$0"` — caminho que, na cópia dentro de $WORK, não existe. A cópia morria
# no preflight ANTES da primeira sabotagem, e as quatro sabotagens seguintes "mudaram o rc" sem
# tocar em nada. O bloco de controle DETECTOU (`esperado '0', veio '2'`) e mesmo assim seguiu,
# imprimindo seis linhas verdes antes do veredito. Detectar e seguir é quase não detectar: o
# sinal chega depois de o ruído já ter ensinado a coisa errada, e quem lê o log de cima para
# baixo vê a falsificação "funcionando".
#
# O #2434 removeu AQUELA dependência. Este aborto é a defesa contra a PRÓXIMA — qualquer coisa
# que a cópia sabotada não encontre ao lado de si.
controle() {
  local nome="$1" veio="$2" esperado="$3"
  if [ "$veio" = "$esperado" ]; then ok "controle: $nome"; return 0; fi
  nok "controle: $nome" "esperado '$esperado', veio '$veio'"
  cat <<FIM

🛑 CONTROLE VERMELHO — abortando ANTES da primeira sabotagem.
   A cópia sabotável ($ALVO) não reproduz o
   original NEM SABOTADA. Nesse estado toda sabotagem muda o rc por acidente e fica
   verde: sabotagem sempre-vermelha APROVA TUDO. Seguir daqui imprimiria linhas
   verdes que não provam nada — foi o que este teste já fez uma vez.
   Suspeite, nesta ordem: (1) dependência que a cópia não acha ao lado de si (helper
   resolvido por \`dirname "\$0"\`), (2) cluster de teste caído, (3) fixture alterada.
   O que a cópia respondeu:
FIM
  tail -20 "$WORK/out.log" | sed 's/^/     | /'
  printf '\nPASS=%s FAIL=%s\nFIM_PROVA_VERMELHO\n' "$PASS" "$FAIL"
  exit 3
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

echo "▶ A10 — SQL com envelope de transação é recusado"
# O exit 2 é COMPARTILHADO por vários ramos de recusa (uso, arquivo ausente, não-commitado, tag
# de quoting). Casar só o número aprovaria a recusa CERTA pelo motivo ERRADO — e o motivo errado
# mais provável é o guard do A6 logo acima: se esta fixture deixar de estar commitada e limpa, o
# script morre antes de chegar ao envelope, com o mesmo 2, e a asserção fica verde sem ter
# exercitado nada. Por isso a MARCA da mensagem também é asserção. `-F` sobre pedaço ASCII de
# caixa fixa: casar acento ou usar `-i` é o casamento pela metade que já migrou de locale (#1483).
LEDGER_ANTES="$(q "select count(*) from public.db_aplicacoes")"
eq "A10 exit 2" "$(rc_de "$FIX_ENVELOPE")" "2"
if grep -qF 'BEGIN/COMMIT/ROLLBACK' "$WORK/out.log"; then
  ok "A10 recusou pelo ENVELOPE — não por outro ramo que também sai 2"
else
  nok "A10" "saiu 2 sem a marca do envelope (motivo errado?): $(tail -c 250 "$WORK/out.log")"
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
R7=0; ( cd "$REPO_ROOT" && AFIACAO_PSQL_RW="$SHIM_ERRADO" bash "$ALVO" "$FIX_OK" ) >/dev/null 2>&1 || R7=$?
eq "A7 papel errado sai 6, não 0" "$R7" "6"

echo "▶ A11/A12 — a 2ª classe de incompatibilidade, e o CONTROLE dos dois guards"
# A10 (acima) cobre a MOLDURA, que tem conserto: tirar o envelope. A11 cobre a classe que NÃO
# tem — CREATE INDEX CONCURRENTLY não roda em transação alguma, e o recibo só é atômico porque
# há uma. Casamos o MARCADOR ASCII: "saiu 2" também é arquivo não-commitado, sha torto e sonda.
eq "A11 CREATE INDEX CONCURRENTLY é recusado com exit 2" "$(rc_de "$FIX_CIC")" "2"
if grep -q 'RECUSA_FORA_DE_TRANSACAO' "$WORK/out.log"; then
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
norm_corpo() { sed '/^[[:space:]]*$/d'; }   # só a quebra que o $-quote acrescenta; indentação NÃO
CORPO_DB="$(q_bruto "select prosrc from pg_proc where oid='public.fixture_corpo_refresca()'::regprocedure" | norm_corpo || true)"
CORPO_ARQ="$(awk '/AS \$funcao\$$/{f=1;next} /^\$funcao\$;$/{f=0} f' "$FIX_CORPO" | norm_corpo)"
eq "A12b o corpo GUARDADO pelo Postgres é byte-a-byte o do arquivo" "$CORPO_DB" "$CORPO_ARQ"

else
# ═════════════════════════════════════════════════════════════════════════════════════════
echo "▶ CONTROLE (sem sabotagem, na cópia) — tem de estar VERDE antes de sabotar"
# Um controle por CLASSE de desfecho que as sabotagens vão mexer: sucesso (0), falha-limpa (4) e
# recusa de preflight (2). O de recusa é o mais barato e o que teria pego o #2421 primeiro — ele
# nem chega a abrir conexão, então falha nele grita "a cópia não roda", não "o banco está ruim".
controle "A1 aplica"              "$(rc_de "$FIX_OK")"       "0"
controle "A3 sai 4"               "$(rc_de "$FIX_ERRO")"     "4"
controle "A10 recusa o envelope"  "$(rc_de "$FIX_ENVELOPE")" "2"
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
$PSQL -c "DROP TABLE IF EXISTS public.fixture_aplicar_ok; DELETE FROM public.db_aplicacoes" >/dev/null 2>&1

echo "▶ S5 — recusa do envelope removida (o corpo com BEGIN; chega ao banco)"
# A alternância literal só existe no regex da checagem (linha única em db-aplicar.sh); a mensagem
# e o comentário escrevem com barras, BEGIN/COMMIT/ROLLBACK, e não casam. Trocá-la por um nome
# que nunca aparece em SQL deixa o `grep` sintaticamente vivo e semanticamente morto.
sabota 's/\(BEGIN\|COMMIT\|ROLLBACK\|START TRANSACTION\)/(JAMAIS_CASA_ENVELOPE)/'
S5="$(rc_de "$FIX_ENVELOPE")"
# Exigir o 4 EXATO, não "≠ 2". 4 é o banco recusando por conta própria — `EXECUTE of transaction
# commands is not implemented` —, e é isso que prova que A10 mede a recusa DO SCRIPT e não uma
# barreira que existiria de qualquer jeito. Aceitar "qualquer coisa ≠ 2" deixaria passar a cópia
# morrendo no preflight, que é exatamente a falha que o controle acima existe para pegar.
if [ "$S5" = "4" ]; then
  ok "S5 vermelho: sem a recusa o corpo vai ao banco, que o barra e devolve 4 (≠ 2)"
else
  nok "S5" "esperava 4 (o banco barrando); veio '$S5' / $(tail -c 200 "$WORK/out.log")"
fi
# E a transação do script tem de ter voltado atrás: envelope quebrado no meio é a meia-migration
# que o desenho inteiro existe para impedir.
eq "S5 e a tabela do envelope NÃO nasceu nem assim" \
   "$(q "select to_regclass('public.fixture_aplicar_envelope') is null")" "t"

echo "▶ S6 — guard de não-transacional desligado: CREATE INDEX CONCURRENTLY vai ao banco"
$PSQL -c "DELETE FROM public.db_aplicacoes" >/dev/null 2>&1
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE do script
if sabota 's/^if \[ -n "\$FORA_TX" \]; then/if false; then/m'; then
  S6="$(rc_de "$FIX_CIC")"
  if [ "$S6" = "4" ]; then
    ok "S6 vermelho: sem o guard, o PG recusa o CONCURRENTLY dentro de transação (4 ≠ 2)"
  else
    nok "S6" "esperava exit 4 (o banco barrando); veio '$S6'"
  fi
fi

echo "▶ S7 — guard ALARGADO para casar END; (a SOBRE-recusa) — o CONTROLE tem de cair"
# S5/S6 provam que os guards PEGAM o que devem. Só S7 prova que A12 morde quando um guard passa
# a pegar o que NÃO deve. `END;` é sinônimo de COMMIT no top level, mas fecha bloco PL/pgSQL e
# aparece em coluna 0 dentro de $funcao$ — incluí-lo recusaria 81 arquivos legítimos do repo.
# Se A12 seguisse verde aqui, ela não estaria medindo nada.
$PSQL -c "DELETE FROM public.db_aplicacoes" >/dev/null 2>&1
if sabota 's/\(BEGIN\|COMMIT\|ROLLBACK\|START TRANSACTION\)/(BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)/'; then
  S7="$(rc_de "$FIX_CORPO")"
  if [ "$S7" = "2" ]; then
    ok "S7 vermelho: guard alargado RECUSA o controle legítimo (2) — A12 mede de verdade"
  else
    nok "S7" "esperava exit 2 (controle recusado por END;); veio '$S7'"
  fi
fi

echo "▶ S8 — transformação no CLIENTE: o BANCO é o freio, e é por isso que peel não mora aqui"
# aplicar_sql() RE-CALCULA o sha256 do corpo recebido e compara com o declarado. Qualquer
# transformação feita pelo cliente quebra a cadeia — foi o que derrubou o desenvelopamento do
# #2421. Exigimos a marca ASCII 'sha divergente': "falhou" sozinho não diz por quê.
$PSQL -c "DELETE FROM public.db_aplicacoes" >/dev/null 2>&1
# shellcheck disable=SC2016  # aspas simples de proposito: o perl casa com o TEXTO-FONTE do script
if sabota 's/^  cat "\$SNAP"$/  sed "\/^END;\$\/d" "\$SNAP"/m'; then
  S8="$(rc_de "$FIX_CORPO")"
  if [ "$S8" = "4" ] && grep -q 'sha divergente' "$WORK/out.log"; then
    ok "S8 vermelho: o banco recusou a transformação do cliente (sha divergente, exit 4)"
  else
    nok "S8" "esperava exit 4 COM 'sha divergente'; veio '$S8' (marca ausente = outra falha)"
  fi
fi

echo "▶ S9 — transformação SERVER-SIDE: a única que o sha NÃO pega, e que só A12b enxerga"
# O sha é conferido DENTRO de aplicar_sql. Uma transformação aplicada DEPOIS dessa conferência
# passa por todos os guards do cliente, pelo ledger e pelo próprio sha — e é onde um peel teria
# de morar. S8 mostra que nenhuma sabotagem do cliente derruba A12b; sem S9, A12b seria verde
# por INALCANÇÁVEL. A transformação escolhida some com a indentação: o corpo segue VÁLIDO e a
# função é criada normalmente. É a corrupção silenciosa de verdade.
cp "$APLICAR" "$ALVO"   # esta sabotagem é no BOOTSTRAP; $ALVO ainda carrega a do S8
BOOT_SAB="$WORK/bootstrap-sabotado.sql"
perl -pe 's/^  EXECUTE p_sql;$/  EXECUTE regexp_replace(p_sql, E\x27\\n  \x27, E\x27\\n\x27, \x27g\x27);/' "$BOOT" > "$BOOT_SAB"
if cmp -s "$BOOT" "$BOOT_SAB"; then
  nok "S9 sabotagem inerte" "o padrão não casou com 'EXECUTE p_sql;' no bootstrap"
else
  $PSQL -c "DROP FUNCTION IF EXISTS public.fixture_corpo_refresca();
            DROP TABLE IF EXISTS public.fixture_aplicar_corpo;
            DELETE FROM public.db_aplicacoes" >/dev/null 2>&1
  $PSQL -f "$BOOT_SAB" >/dev/null 2>&1
  S9="$(rc_de "$FIX_CORPO")"
  C_DB="$(q_bruto "select prosrc from pg_proc where oid='public.fixture_corpo_refresca()'::regprocedure" | sed '/^[[:space:]]*$/d' || true)"
  C_ARQ="$(awk '/AS \$funcao\$$/{f=1;next} /^\$funcao\$;$/{f=0} f' "$FIX_CORPO" | sed '/^[[:space:]]*$/d')"
  if [ "$S9" = "0" ] && [ "$C_DB" != "$C_ARQ" ]; then
    ok "S9 vermelho: peel no servidor aplica LIMPO (0) e só A12b vê o corpo ter mudado"
  else
    nok "S9" "esperava apply 0 com corpo DIFERENTE; veio rc='$S9', corpo $([ "$C_DB" = "$C_ARQ" ] && echo IGUAL || echo diferente)"
  fi
  $PSQL -f "$BOOT" >/dev/null 2>&1   # devolve a função verdadeira
fi
fi

# ═════════════════════════════════════════════════════════════════════════════════════════
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "FIM_PROVA_OK" || echo "FIM_PROVA_VERMELHO"
[ "$FAIL" -eq 0 ]
