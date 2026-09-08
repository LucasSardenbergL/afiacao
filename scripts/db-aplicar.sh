#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════╗
# ║  db-aplicar.sh — aplica um .sql do repo em PRODUÇÃO, com trilha atômica.                ║
# ║                                                                                        ║
# ║  Uso:  bun run db:aplicar db/arquivo.sql            (aplica de verdade)                 ║
# ║        bun run db:aplicar db/arquivo.sql --ensaio   (roda e faz ROLLBACK; não grava)    ║
# ║                                                                                        ║
# ║  Substitui a colagem manual no SQL Editor do Lovable. O que ele garante, e por quê:     ║
# ║                                                                                        ║
# ║  1. SONDA FAIL-CLOSED do wrapper. `command -v` não basta: wrapper presente-porém-       ║
# ║     quebrado esvazia o guard igual (docs/historico/sonda-ausente-em-script-que-apaga).  ║
# ║     Exigimos RESPOSTA POSITIVA do banco antes de qualquer coisa.                        ║
# ║  2. ARQUIVO COMMITADO. O que roda em produção precisa existir na história do repo —     ║
# ║     senão o ledger aponta para bytes que ninguém consegue recuperar depois.             ║
# ║  3. SHA-256 dos bytes EXATOS. É a identidade do que foi aplicado, não o nome do arquivo.║
# ║  4. TENTATIVA gravada FORA da transação; RECIBO gravado DENTRO. Apply que falha deixa   ║
# ║     cicatriz; apply que volta atrás não deixa recibo. As duas metades são o contrato.   ║
# ║  5. ON_ERROR_STOP + MARCADOR POSITIVO DE FIM. Sem os dois, `psql -f` sai 0 com ERROR    ║
# ║     no meio — a armadilha que este repo já pagou                                        ║
# ║     (docs/historico/psql-ro-exit-zero-em-sql-que-falhou.md). Ausência de erro NÃO é     ║
# ║     prova de sucesso: só o marcador é.                                                  ║
# ║  6. NUNCA reaplica resultado DESCONHECIDO. Resposta perdida ≠ falha. Reaplicar por      ║
# ║     reflexo é como se aplica uma migration duas vezes.                                  ║
# ║                                                                                        ║
# ║  Exit codes: 0 aplicado · 2 uso/preflight · 3 já aplicado (no-op) · 4 falhou (rollback  ║
# ║              limpo) · 5 DESCONHECIDO (exige humano) · 6 não consegui consultar          ║
# ╚═══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

RW="${AFIACAO_PSQL_RW:-$HOME/.config/afiacao/psql-rw}"
MARCADOR='FIM_APLICACAO_OK'
LOG_DIR="${TMPDIR:-/tmp}"

msg() { printf '%s\n' "$*" >&2; }
morre() { msg "❌ $2"; exit "$1"; }

# ─────────────────────────────────────────────────────────────────────────────────────────
# 0) Uso
# ─────────────────────────────────────────────────────────────────────────────────────────
ARQUIVO="${1:-}"
MODO="${2:-aplicar}"
[ -n "$ARQUIVO" ] || morre 2 "uso: bun run db:aplicar <arquivo.sql> [--ensaio]"
[ -f "$ARQUIVO" ] || morre 2 "arquivo não existe: $ARQUIVO"
case "$MODO" in
  aplicar|--ensaio) ;;
  *) morre 2 "modo inválido: '$MODO' (use --ensaio ou nada)" ;;
esac
ENSAIO=0
[ "$MODO" = "--ensaio" ] && ENSAIO=1

# ─────────────────────────────────────────────────────────────────────────────────────────
# 1) Sonda FAIL-CLOSED do wrapper — resposta POSITIVA, não mera existência
# ─────────────────────────────────────────────────────────────────────────────────────────
if [ ! -x "$RW" ]; then
  morre 2 "wrapper de escrita ausente: $RW
   Monte-o uma vez (não contém segredo; a senha vive no .pgpass):
     1. cole db/claude-rw-bootstrap.sql no SQL Editor (a ÚLTIMA colagem manual)
     2. echo 'aws-1-eu-west-1.pooler.supabase.com:5432:postgres:claude_rw.fzvklzpomgnyikkfkzai:<SENHA>' \\
          > ~/.config/afiacao/claude_rw.pgpass && chmod 600 ~/.config/afiacao/claude_rw.pgpass
     3. cp db/psql-rw.template ~/.config/afiacao/psql-rw && chmod +x ~/.config/afiacao/psql-rw"
fi

SONDA_OUT="$LOG_DIR/db-aplicar-sonda.$$.log"
if ! "$RW" -X -A -t -v ON_ERROR_STOP=1 \
      -c "select 'SONDA_RW_OK:'||current_user" > "$SONDA_OUT" 2>&1; then
  msg "$(head -c 600 "$SONDA_OUT")"
  rm -f "$SONDA_OUT"
  morre 6 "não consegui consultar o banco pelo wrapper de escrita (≠ 'está tudo bem')"
fi
grep -q 'SONDA_RW_OK:claude_rw' "$SONDA_OUT" || {
  msg "$(head -c 600 "$SONDA_OUT")"
  rm -f "$SONDA_OUT"
  morre 6 "wrapper respondeu, mas NÃO como claude_rw — não é o canal que eu penso que é"
}
rm -f "$SONDA_OUT"

# ─────────────────────────────────────────────────────────────────────────────────────────
# 2) O arquivo precisa estar COMMITADO e limpo
# ─────────────────────────────────────────────────────────────────────────────────────────
git ls-files --error-unmatch -- "$ARQUIVO" >/dev/null 2>&1 \
  || morre 2 "arquivo não está versionado: $ARQUIVO (commite antes — o ledger guarda o commit)"
[ -z "$(git status --porcelain -- "$ARQUIVO")" ] \
  || morre 2 "arquivo tem alteração não-commitada: $ARQUIVO
   O SHA-256 gravado no ledger precisa apontar para bytes recuperáveis na história."

SHA="$(shasum -a 256 "$ARQUIVO" | awk '{print $1}')"
COMMIT="$(git rev-parse --short HEAD)"
[ -n "$SHA" ] || morre 2 "não consegui calcular o sha256 de $ARQUIVO"

msg "📄 $ARQUIVO"
msg "🔑 sha256 $SHA · commit $COMMIT"

# ─────────────────────────────────────────────────────────────────────────────────────────
# 3) O ledger decide: já aplicado? desconhecido pendente?
# ─────────────────────────────────────────────────────────────────────────────────────────
EST_OUT="$LOG_DIR/db-aplicar-estado.$$.log"
if ! "$RW" -X -A -t -v ON_ERROR_STOP=1 -c "
  select coalesce(string_agg(distinct estado, ','), 'inedito')
  from public.db_aplicacoes where sha256 = '$SHA'" > "$EST_OUT" 2>&1; then
  msg "$(head -c 600 "$EST_OUT")"; rm -f "$EST_OUT"
  morre 6 "não consegui LER o ledger (ausência de resposta ≠ 'nunca foi aplicado')"
fi
ESTADOS="$(head -1 "$EST_OUT" | tr -d ' \n')"; rm -f "$EST_OUT"

# As travas valem só para o apply REAL. O ensaio não grava nada: bloqueá-lo por "já aplicado"
# não protege ninguém e empurra quem quer conferir para o caminho que escreve — o inverso do
# que este script existe para fazer. Ensaiar é sempre permitido, inclusive (e principalmente)
# quando há um DESCONHECIDO pendente, que é justamente a hora de investigar sem escrever.
if [ "$ENSAIO" -eq 0 ]; then
  case "$ESTADOS" in
    *desconhecido*)
      morre 5 "há uma aplicação DESCONHECIDA destes mesmos bytes (sha $SHA).
   Resposta perdida NÃO é falha — reaplicar pode aplicar duas vezes.
   Resolva com leitura independente (psql-ro), decida, e atualize a linha à mão.
   Para investigar sem escrever: bun run db:aplicar $ARQUIVO --ensaio" ;;
    *aplicada*)
      msg "✅ já aplicado (sha $SHA) — nada a fazer."; exit 3 ;;
  esac
fi
msg "📋 ledger: $ESTADOS"

# ─────────────────────────────────────────────────────────────────────────────────────────
# 4) TENTATIVA — fora da transação, para sobreviver ao rollback
# ─────────────────────────────────────────────────────────────────────────────────────────
ID=""
if [ "$ENSAIO" -eq 0 ]; then
  ID_OUT="$LOG_DIR/db-aplicar-id.$$.log"
  # `-q` porque psql imprime o TAG do comando junto da linha: sem ele, `1` + `INSERT 0 1`
  # colam e viram o id "1INSERT01". Pego pela prova PG17 na primeira execução.
  if ! "$RW" -X -A -t -q -v ON_ERROR_STOP=1 -c "
    insert into public.db_aplicacoes (arquivo, sha256, commit_sha, estado)
    values ('$ARQUIVO', '$SHA', '$COMMIT', 'tentativa') returning id" > "$ID_OUT" 2>&1; then
    msg "$(head -c 600 "$ID_OUT")"; rm -f "$ID_OUT"
    morre 6 "não consegui gravar a tentativa — abortei ANTES de tocar no banco"
  fi
  # Cinto E suspensório: só a 1ª linha, só dígitos. Um id não-numérico vira SQL quebrado lá
  # na frente, DEPOIS de o apply já ter rodado — exatamente o momento em que falhar é mais caro.
  ID="$(head -1 "$ID_OUT" | tr -dc '0-9')"
  ID_CRU="$(head -c 120 "$ID_OUT")"; rm -f "$ID_OUT"
  [ -n "$ID" ] || morre 6 "o insert da tentativa não devolveu id numérico (veio: '$ID_CRU')"
  msg "🧾 tentativa #$ID registrada"
fi

# ─────────────────────────────────────────────────────────────────────────────────────────
# 5) O APPLY — uma transação, elevação explícita e efêmera, recibo DENTRO
# ─────────────────────────────────────────────────────────────────────────────────────────
# O corpo viaja como PARÂMETRO dollar-quoted. Se o próprio arquivo contiver a tag, o quoting
# se fecha cedo e o resto do arquivo vira SQL solto — fail-closed antes de qualquer conexão.
TAG="aplicar_${SHA:0:12}"
if grep -qF "\$${TAG}\$" "$ARQUIVO"; then
  morre 2 "o arquivo contém a tag de quoting \$${TAG}\$ — recuso para não quebrar o corpo"
fi

FECHO="COMMIT;"
[ "$ENSAIO" -eq 1 ] && FECHO="ROLLBACK;"

# No ensaio não há tentativa commitada lá fora: cria-se uma DENTRO da transação, só para dar
# um id à função, e o ROLLBACK leva tudo embora. `\gset` captura o id sem sair do psql.
ABERTURA="SELECT $ID AS eid"
if [ "$ENSAIO" -eq 1 ]; then
  # sha prefixado: a linha do ensaio também vira 'aplicada' dentro da transação, e colidiria
  # com o índice único de sucesso quando o arquivo JÁ foi aplicado de verdade. O prefixo some
  # no ROLLBACK junto com a linha; o hash conferido pela função continua sendo o real.
  ABERTURA="INSERT INTO public.db_aplicacoes (arquivo, sha256, commit_sha, estado)
     VALUES ('$ARQUIVO', 'ensaio:$SHA', '$COMMIT', 'tentativa') RETURNING id AS eid"
fi

APPLY_SQL="$LOG_DIR/db-aplicar-corpo.$$.sql"
{
  printf '\\set ON_ERROR_STOP on\nBEGIN;\n'
  # Timeouts via SET LOCAL, não via PGOPTIONS: o pooler do Supabase IGNORA PGOPTIONS
  # (registrado no cabeçalho do psql-ro). Posto aqui, vale — e morre com a transação.
  printf "SET LOCAL statement_timeout = '300s';\nSET LOCAL lock_timeout = '15s';\n"
  printf '%s \\gset\n' "$ABERTURA"
  printf 'SELECT public.aplicar_sql($%s$' "$TAG"
  cat "$ARQUIVO"
  printf '$%s$, %s, :eid) AS controle;\n%s\n' "$TAG" "'$SHA'" "$FECHO"
} > "$APPLY_SQL"

APPLY_OUT="$LOG_DIR/db-aplicar-apply.$$.log"
set +e
"$RW" -X -v ON_ERROR_STOP=1 -f "$APPLY_SQL" > "$APPLY_OUT" 2>&1
RC=$?
set -e
rm -f "$APPLY_SQL"

# ─────────────────────────────────────────────────────────────────────────────────────────
# 6) Veredito — exit 0 SOZINHO não prova nada. O marcador é a prova.
# ─────────────────────────────────────────────────────────────────────────────────────────
TEM_MARCADOR=0
grep -q "$MARCADOR" "$APPLY_OUT" && TEM_MARCADOR=1

if [ "$RC" -eq 0 ] && [ "$TEM_MARCADOR" -eq 1 ]; then
  if [ "$ENSAIO" -eq 1 ]; then
    msg "🧪 ENSAIO ok — rodou inteiro e fez ROLLBACK. Nada foi gravado."
    msg "   log: $APPLY_OUT"
    exit 0
  fi
  msg "✅ APLICADO — tentativa #$ID virou recibo, na mesma transação."
  msg "   log: $APPLY_OUT"
  exit 0
fi

# Falhou. Distinguir rollback LIMPO de resultado DESCONHECIDO é o que evita a dupla aplicação.
ERRO="$(grep -iE '^(psql:)?.*(ERRO|ERROR|FATAL|PANIC)' "$APPLY_OUT" | head -3 | tr '\n' ' ' | cut -c1-400)"
msg "$(tail -c 900 "$APPLY_OUT")"

if [ "$ENSAIO" -eq 1 ]; then
  morre 4 "ENSAIO falhou (nada gravado, como esperado): ${ERRO:-sem mensagem}"
fi

if [ "$RC" -ne 0 ] && [ -n "$ERRO" ]; then
  # O banco RESPONDEU com erro → a transação abortou → rollback limpo, sem meia-migration.
  ERRO_SQL="${ERRO//\'/\'\'}"
  "$RW" -X -A -t -c "update public.db_aplicacoes
     set estado='falhou', concluido_em=now(), erro='$ERRO_SQL' where id=$ID" >/dev/null 2>&1 \
    || msg "⚠️  não consegui marcar #$ID como 'falhou' — corrija a linha à mão"
  morre 4 "APPLY FALHOU e a transação voltou atrás (nada aplicado pela metade): $ERRO"
fi

# Sem erro identificável E sem marcador = não sei o que aconteceu lá dentro. Este é o caso
# que NÃO pode ser reaplicado automaticamente.
"$RW" -X -A -t -c "update public.db_aplicacoes
   set estado='desconhecido', concluido_em=now(),
       erro='sem marcador de fim; rc=$RC' where id=$ID" >/dev/null 2>&1 \
  || msg "⚠️  não consegui marcar #$ID como 'desconhecido' — corrija a linha à mão"
morre 5 "RESULTADO DESCONHECIDO (rc=$RC, marcador '$MARCADOR' ausente).
   NÃO reaplique por reflexo. Confira o efeito por leitura independente (psql-ro) e decida.
   log: $APPLY_OUT"
