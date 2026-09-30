#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  test-expandir-promocao-item.sh — prova PG17 da 20260930220148 (issue #2665): ║
# ║  expandir_promocao_item com UM overload, similarity qualificada e a expansão  ║
# ║  que não apaga o item. Sobre o schema-snapshot, com os corpos de PROD como    ║
# ║  predecessores (md5 exato em C1-C4).                                          ║
# ║                                                                                ║
# ║  C  controle: predecessores = prod; as sementes de similaridade caem do lado  ║
# ║     certo do limiar (senão F testaria outro caminho).                          ║
# ║  A  anti-vacuidade: nos predecessores os 3 defeitos REPRODUZEM (42725 na      ║
# ║     chamada do front, 42883 nos ramos 0 e >=2, e o conserto SÓ do 2 apaga o   ║
# ║     item com volume). Sem isso, os positivos de F não provariam nada.          ║
# ║  M  a migration como o SQL Editor a roda (o BEGIN/COMMIT é do arquivo): a PRE ║
# ║     recusa corpo estranho nos 2 overloads, sobrevivente ausente, trava não    ║
# ║     no-op e dependência fora do alcance de authenticated, e TRAVA a linha     ║
# ║     (duas conexões, barreira observada); a POS pega overload vivo, chamada    ║
# ║     que não resolve, similarity nua, corpo editado, atributo mudado e         ║
# ║     DROP+CREATE ou ACL mexido; aplica e re-aplica.                             ║
# ║  F  depois: a chamada do FRONT (authenticated, 1 argumento nomeado, como o    ║
# ║     PostgREST monta) nos 3 caminhos — 0 variantes (com e sem similaridade), 1 ║
# ║     e >=2 (com e sem volume, com e sem similaridade) —, a guarda do laço      ║
# ║     vazio, o LIKE literal, a RLS e os guardas antigos.                         ║
# ║                                                                                ║
# ║  rode: bash db/test-expandir-promocao-item.sh > log 2>&1; echo "exit=$?"      ║
# ║        bash db/test-expandir-promocao-item.sh --falsificar > log 2>&1         ║
# ║  matriz: HARNESS_LC=C | pt_BR.UTF-8 (lc_messages do servidor; o cliente fica  ║
# ║  em LC_ALL=C e todo assert casa SQLSTATE ou texto ASCII).                      ║
# ║  Diário: docs/historico/expandir-promocao-item-overload.md                    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5671}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="expandir-promocao-item"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260930220148_expandir_promocao_item_overload_similarity_volume.sql"
# O corpo de PROD do (bigint,numeric), de listar_skus e do helper é o desta migration (aplicada em
# prod em 2026-09-30); o do (bigint) só existe no snapshot.
MIG_LIKE="$REPO_ROOT/supabase/migrations/20260929000234_padrao_like_contem_escapa_curinga.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
# Denominador: C1-C5 · A1-A6 · M1a M1b M2 M3 M4 M5 M5c M6 M7a M7b M8-M15 · F1-F12.
# Menos asserts executados é vermelho: FAIL=0 com PASS encolhido é a prova truncada que aprova tudo.
TOTAL_ESPERADO=41

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas as
# sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar vermelhos
# por RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro de execução
# (sabotagem que não aplicou, SQL quebrado, saída vazia) NÃO mata mutante e reprova a falsificação.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# As de CORPO são aplicadas no banco depois do apply (a POS não as veria); as de PRE/POS, numa cópia
# da migration em tmpdir. O repo nunca é tocado.
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="similarity_nua_max:F2,F3,F4,F7,F12:F1,F5,F6,F9
              similarity_nua_laco:F4,F5,F6,F7,F9:F1,F2,F3,F12
              volume_expande:F6,F7:F4,F5,F8
              sem_guarda:F8:F5,F6
              like_cru_laco:F9:F5,F6
              overload_vivo:F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11:F12
              pre_aceita_qualquer:M1a,M1b:M2,M3,M4,M14
              pre_bigint_qualquer:M2:M1a,M3,M14
              pre_ausente_segue:M3:M1a,M2,M14
              pre_config_nao_confere:M4:M1a,M2,M14
              pre_sem_trava:M5:M5c,M1a,M14
              pre_sem_dependencia:M6:M1a,M14
              pos_sem_overload:M7a:M7b,M8,M14
              pos_sem_resolucao:M8:M7a,M9,M14
              pos_sem_similarity:M9:M8,M10,M14
              pos_sem_md5:M10:M9,M11,M14
              pos_sem_atributos:M11:M10,M12,M14
              pos_sem_identidade:M12,M13:M11,M14"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    # `|| true` DENTRO das chaves: sob pipefail, um grep sem linha derrubaria o laço pelo set -e.
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      { grep -E 'FALHOU|ERRO|ERROR|APLICAVEL|INFRA' "$log" || true; } | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    # A rodada tem de TERMINAR com o denominador inteiro: um vermelho seguido de erro que mata o
    # script deixaria o resto sem rodar, e o vermelho sozinho não prova que o resto seguia verde.
    recibo="$(grep -E '^PASS=[0-9]+  FAIL=[0-9]+$' "$log" | tail -1 || true)"
    if [ -z "$recibo" ]; then
      echo "  ❌ $sab — a rodada NÃO terminou (sem PASS=/FAIL=): vermelho de rodada truncada não é dente"
      { grep -E 'ERROR|ERRO|FATAL|INFRA|❌' "$log" || true; } | tail -2 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    n_ok="${recibo#PASS=}"; n_ok="${n_ok%% *}"
    n_fail="${recibo##*FAIL=}"
    if [ $((n_ok + n_fail)) -ne "$TOTAL_ESPERADO" ]; then
      echo "  ❌ $sab — a rodada executou $((n_ok + n_fail)) asserts, esperado $TOTAL_ESPERADO"
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""
    for x in ${verm//,/ }; do
      grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x"
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    exec_err=0
    grep -q 'ERRO_DE_EXECUCAO' "$log" && exec_err=1
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ "$exec_err" -eq 0 ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ "$exec_err" -eq 1 ] && { echo "  ❌ $sab — houve ERRO DE EXECUÇÃO: vermelho que não é do assert não mata mutante"
                                 { grep 'ERRO_DE_EXECUCAO' "$log" || true; } | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro do psql, erro do próprio bash ("<script>: line N: …") ou vazio não é
# resultado: vira ERRO_DE_EXECUCAO, que o laço de falsificação não aceita como dente. Só um
# resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*|*": line "[0-9]*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}
curto() { printf '%s' "$1" | tr '\n' ' ' | head -c 200; }

# ── Extrator de função e trocas (python, sem interpolação do bash: `\` e `'` chegam intactos) ────
# funcao <arquivo> <prefixo depois de "FUNCTION "> <saida> [<troca>]: o bloco CREATE [OR REPLACE]
#   FUNCTION <prefixo>… até a tag de dollar que fecha o corpo, como CREATE OR REPLACE. Com <troca>,
#   cada padrão dela tem de ocorrer EXATAMENTE n× no bloco (troca que não pegou deixaria verde).
# migration <arquivo> <troca> <saida>: o arquivo inteiro com as trocas (sabotagem de PRE/POS ou
#   variante do bloco M).
PY_TROCAS="$TMPD/trocas.py"
cat > "$PY_TROCAS" <<'PY'
import re, sys
E = "public.expandir_promocao_item(p_item_id bigint, p_threshold"
TROCAS = {
  # ── corpo (no banco, depois do apply) ──
  "similarity_nua_max": (E, [("SELECT MAX(extensions.similarity(", "SELECT MAX(similarity(", 1)]),
  "similarity_nua_laco": (E, [("                THEN extensions.similarity(op.descricao", "                THEN similarity(op.descricao", 1)]),
  "volume_expande": (E, [
    ("    IF v_item.volume_minimo IS NOT NULL THEN\n      v_candidatos", "    IF false THEN\n      v_candidatos", 1),
    ("  IF v_item.volume_minimo IS NOT NULL THEN\n    UPDATE promocao_item\n", "  IF false THEN\n    UPDATE promocao_item\n", 1)]),
  "sem_guarda": (E, [("  IF cardinality(v_novos_ids) = 0 THEN", "  IF false THEN", 1)]),
  "like_cru_laco": (E, [(r"""ELSE op.descricao ILIKE private.padrao_like_contem(v_item.sku_codigo_fornecedor) ESCAPE '\' END)""",
                         r"""ELSE op.descricao ILIKE '%' || v_item.sku_codigo_fornecedor || '%' END)""", 1)]),
  # ── o predecessor com SÓ o conserto 2 (A6: o que o 42725 escondia) ──
  "so_similarity": (E, [("similarity(", "extensions.similarity(", 5)]),
  # ── PRE/POS (na cópia da migration inteira) ──
  "pre_aceita_qualquer": (None, [("IF v_md5 IS NULL OR v_md5 NOT IN ('bc8f2c0e7a85ccdf89b5e5cd59b84e38', '566edd782fb00616c6d658b9562020d2') THEN", "IF false THEN", 1)]),
  "pre_bigint_qualquer": (None, [("IF v_md5 IS DISTINCT FROM '6677fa80de976b37dd784544058ccf4b' THEN", "IF false THEN", 1)]),
  "pre_ausente_segue": (None, [("RAISE EXCEPTION 'PRE FALHOU: expandir_promocao_item(bigint,numeric) ausente.",
                                "RETURN; RAISE EXCEPTION 'PRE FALHOU: expandir_promocao_item(bigint,numeric) ausente.", 1)]),
  "pre_config_nao_confere": (None, [(
    "IF v_antes IS DISTINCT FROM v_depois OR v_depois IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN\n    RAISE EXCEPTION 'PRE FALHOU: a config de (bigint,numeric)",
    "IF false THEN\n    RAISE EXCEPTION 'PRE FALHOU: a config de (bigint,numeric)", 1)]),
  "pre_sem_trava": (None, [("  ALTER FUNCTION public.expandir_promocao_item(bigint, numeric) SET search_path = public, pg_temp;\n", "  NULL;\n", 1)]),
  "pre_sem_dependencia": (None, [("RAISE EXCEPTION 'PRE FALHOU: extensions.similarity", "RAISE NOTICE 'PRE FALHOU: extensions.similarity", 1)]),
  "pos_sem_overload": (None, [("RAISE EXCEPTION 'POS1 FALHOU", "RAISE NOTICE 'POS1 FALHOU", 1)]),
  "pos_sem_resolucao": (None, [("RAISE EXCEPTION 'POS2 FALHOU", "RAISE NOTICE 'POS2 FALHOU", 1)]),
  "pos_sem_similarity": (None, [("RAISE EXCEPTION 'POS3 FALHOU", "RAISE NOTICE 'POS3 FALHOU", 1)]),
  "pos_sem_md5": (None, [("RAISE EXCEPTION 'POS4 FALHOU", "RAISE NOTICE 'POS4 FALHOU", 1)]),
  "pos_sem_atributos": (None, [("RAISE EXCEPTION 'POS5 FALHOU", "RAISE NOTICE 'POS5 FALHOU", 1)]),
  "pos_sem_identidade": (None, [("RAISE EXCEPTION 'POS6 FALHOU", "RAISE NOTICE 'POS6 FALHOU", 1)]),
  # ── variantes da migration que o bloco M aplica (asserts de dente da PRE/POS, não sabotagens) ──
  "var_sem_drop": (None, [("DROP FUNCTION IF EXISTS public.expandir_promocao_item(bigint);\n", "", 1)]),
  "var_sem_default": (None, [(
    "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)",
    "DROP FUNCTION public.expandir_promocao_item(bigint, numeric);\nCREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric)", 1)]),
  "var_similarity_nua": (None, [("SELECT MAX(extensions.similarity(", "SELECT MAX(similarity(", 1)]),
  "var_corpo_editado": (None, [("  v_candidatos jsonb := '[]'::jsonb;\n", "  v_candidatos jsonb := '[]'::jsonb; \n", 1)]),
  "var_secdef": (None, [(" LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\n",
                         " LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\n", 1)]),
  "var_drop_create": (None, [(
    "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)",
    "DROP FUNCTION public.expandir_promocao_item(bigint, numeric);\nCREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)", 1)]),
  "var_revoke_anon": (None, [("NOTIFY pgrst, 'reload schema';\n",
    "NOTIFY pgrst, 'reload schema';\nREVOKE EXECUTE ON FUNCTION public.expandir_promocao_item(bigint, numeric) FROM anon;\n", 1)]),
}

def trocar(texto, trocas):
    for de, para, n in trocas:
        if texto.count(de) != n:
            print("   padrão ocorre %dx, esperado %d: %r" % (texto.count(de), n, de), file=sys.stderr); sys.exit(1)
        texto = texto.replace(de, para)
    return texto

def bloco_funcao(s, prefixo):
    m = re.search(r"CREATE (?:OR REPLACE )?FUNCTION " + re.escape(prefixo), s)
    if not m:
        print("   função não achada: " + prefixo, file=sys.stderr); sys.exit(1)
    t = re.compile(r"\bAS\s+(\$[A-Za-z_0-9]*\$)").search(s, m.end())
    if not t:
        print("   corpo sem dollar-quote: " + prefixo, file=sys.stderr); sys.exit(1)
    fim = s.find(t.group(1), t.end())
    if fim < 0:
        print("   dollar-quote não fecha: " + prefixo, file=sys.stderr); sys.exit(1)
    bloco = s[m.start():fim + len(t.group(1))]
    return re.sub(r"^CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION ", bloco) + ";\n"

modo = sys.argv[1]
if modo == "funcao":
    arq, prefixo, saida = sys.argv[2], sys.argv[3], sys.argv[4]
    bloco = bloco_funcao(open(arq, encoding="utf-8").read(), prefixo)
    if len(sys.argv) > 5:
        alvo, trocas = TROCAS[sys.argv[5]]
        if alvo != prefixo and not prefixo.startswith(alvo):
            print("   troca %s é de %s, não de %s" % (sys.argv[5], alvo, prefixo), file=sys.stderr); sys.exit(1)
        bloco = trocar(bloco, trocas)
    open(saida, "w", encoding="utf-8").write(bloco)
elif modo == "migration":
    arq, nome, saida = sys.argv[2], sys.argv[3], sys.argv[4]
    alvo, trocas = TROCAS[nome]
    open(saida, "w", encoding="utf-8").write(trocar(open(arq, encoding="utf-8").read(), trocas))
PY
py() { python3 "$PY_TROCAS" "$@"; }
# recria uma função a partir de <arquivo> (o snapshot, a 20260929000234 ou a desta prova)
recriar() {   # <arquivo> <prefixo> [<troca>]
  local tmp; tmp="$(mktemp "$TMPD/fn.XXXXXX")"
  py funcao "$1" "$2" "$tmp" ${3:+"$3"} || return 9
  P -q -f "$tmp" >/dev/null || return 9
  rm -f "$tmp"
}

echo "═══ PG17 :$PORT, lc_messages=$HARNESS_LC ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única), os corpos de PROD da
# 20260929000234 (helper, listar_skus e o (bigint,numeric)) e o do (bigint), que só o snapshot tem.
# ══════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
recriar "$MIG_LIKE" "private.padrao_like_contem(" || { echo "INFRA: helper de prod não aplicado"; exit 1; }
recriar "$MIG_LIKE" "public.listar_skus_por_codigo_fornecedor(" || { echo "INFRA: listar_skus de prod não aplicado"; exit 1; }

# O ACL de PROD (psql-ro, 2026-09-30) nos objetos que a função toca, para authenticated/anon: o
# snapshot vem sem privilégios. As duas expandir e o helper ficam com o EXECUTE de fábrica (PUBLIC)
# mais os papéis nominais que prod lista; USAGE em public/private/extensions/auth; omie_products só
# SELECT para authenticated; promocao_*/user_roles com CRUD; USAGE na sequência (o INSERT das
# variantes chama nextval como o CHAMADOR: a função é INVOKER).
ACL_EXPANDIR="GRANT EXECUTE ON FUNCTION public.expandir_promocao_item(bigint,numeric) TO anon, authenticated, service_role;"
ACL_BIGINT="GRANT EXECUTE ON FUNCTION public.expandir_promocao_item(bigint) TO anon, authenticated, service_role;"
P -q <<SQL
GRANT USAGE ON SCHEMA public, private, extensions, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.padrao_like_contem(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_skus_por_codigo_fornecedor(text,text) TO anon, authenticated, service_role;
GRANT SELECT ON public.omie_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promocao_item, public.promocao_campanha, public.user_roles TO anon, authenticated;
GRANT USAGE ON SEQUENCE public.promocao_item_id_seq TO anon, authenticated;
SQL

# Os dois overloads de PROD: o (bigint,numeric) da 20260929000234; o (bigint) do snapshot.
restaurar_expandir() {
  P -q -c "DROP FUNCTION IF EXISTS public.expandir_promocao_item(bigint); DROP FUNCTION IF EXISTS public.expandir_promocao_item(bigint, numeric);"
  recriar "$MIG_LIKE" "public.expandir_promocao_item(p_item_id bigint, p_threshold" || { echo "INFRA: (bigint,numeric) de prod não restaurado"; exit 1; }
  recriar "$SNAP" "public.expandir_promocao_item(p_item_id bigint)" || { echo "INFRA: (bigint) de prod não restaurado"; exit 1; }
  P -q -c "$ACL_EXPANDIR $ACL_BIGINT"
}
restaurar_expandir

# O retrato dos 2 overloads (corpo exato | proconfig | ACL, ou "ausente"), mais o de listar_skus e
# o do helper, que a migration não pode tocar.
retrato() {
  Pq -c "SELECT string_agg(COALESCE((SELECT md5(p.prosrc) || '|' || COALESCE(array_to_string(p.proconfig, ';'), '') || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') || '|' || p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(a.f)), 'ausente'), '#' ORDER BY a.o) FROM unnest(ARRAY['public.expandir_promocao_item(bigint)', 'public.expandir_promocao_item(bigint,numeric)', 'public.listar_skus_por_codigo_fornecedor(text,text)', 'private.padrao_like_contem(text)']) WITH ORDINALITY AS a(f, o);" 2>&1 || true
}
md5_de() { Pq -c "SELECT COALESCE((SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('$1')), 'ausente');" 2>&1 || true; }
retrato_pred="$(retrato)"
restaurar_predecessores() {
  restaurar_expandir
  [ "$(retrato)" = "$retrato_pred" ] || { echo "INFRA: predecessores restaurados como [$(retrato)], esperado [$retrato_pred]"; exit 1; }
}

# ══════════════════════════════════════════════════════════════════════════════
# SEMENTES — como postgres, com os gatilhos desligados. Uma conta por cenário de similaridade: o
# ramo de 0 variantes calcula o MAX sobre TODOS os produtos da conta da campanha.
#   emp_like  (campanha 1): ABC123 ×2 · UNICO77 ×1 · AB_12 ×2 + os vizinhos do curinga AB-12, ABX12
#   emp_sim1  (campanha 2): SELADOR NITRO ×1 parecido com o código SELADORA NITRO + 1 longe
#   emp_sim2  (campanha 3): SELADOR NITRO 0,9L e 3,6L parecidos + 1 longe
# Itens (id > 1000: as variantes que a função insere saem da sequência, abaixo de 1000).
# ══════════════════════════════════════════════════════════════════════════════
M=00000000-0000-4000-8000-00000000000a   # master
N=00000000-0000-4000-8000-00000000000b   # autenticado sem papel
P -q <<SQL
SET session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('$M'), ('$N');
INSERT INTO public.user_roles (user_id, role) VALUES ('$M', 'master');
INSERT INTO public.omie_products (account, omie_codigo_produto, codigo, descricao, ativo) VALUES
  ('emp_like', 3001, 'L1', 'TINTA ABC123 0,9L', true),
  ('emp_like', 3002, 'L2', 'TINTA ABC123 3,6L', true),
  ('emp_like', 3003, 'L3', 'VERNIZ UNICO77 18L', true),
  ('emp_like', 3004, 'L4', 'VERNIZ AB_12 BRILHO', true),
  ('emp_like', 3005, 'L5', 'VERNIZ AB_12 FOSCO', true),
  ('emp_like', 3006, 'L6', 'VERNIZ AB-12 ACETINADO', true),
  ('emp_like', 3007, 'L7', 'VERNIZ ABX12 SEMIBRILHO', true),
  ('emp_sim1', 4001, 'S1', 'SELADOR NITRO', true),
  ('emp_sim1', 4002, 'S2', 'VERNIZ PU BRILHO', true),
  ('emp_sim2', 5001, 'T1', 'SELADOR NITRO 0,9L', true),
  ('emp_sim2', 5002, 'T2', 'SELADOR NITRO 3,6L', true),
  ('emp_sim2', 5003, 'T3', 'VERNIZ PU BRILHO', true);
INSERT INTO public.promocao_campanha (id, empresa, fornecedor_nome, nome, tipo_origem, data_inicio, data_fim) VALUES
  (1, 'EMP_LIKE', 'F', 'like', 'outro', current_date, current_date + 30),
  (2, 'EMP_SIM1', 'F', 'sim1', 'outro', current_date, current_date + 30),
  (3, 'EMP_SIM2', 'F', 'sim2', 'outro', current_date, current_date + 30);
INSERT INTO public.promocao_item (id, campanha_id, sku_codigo_fornecedor, desconto_perc, volume_minimo, confirmado, ativo, observacoes,
                                  mapeamento_qualidade, sku_codigo_omie) VALUES
  (1101, 1, 'UNICO77', 5, NULL, false, true, 'obs 1101', NULL, NULL),
  (1102, 1, 'ABC123',  5, NULL, false, true, 'obs 1102', NULL, NULL),
  (1103, 1, 'ABC123',  5, 10,   false, true, 'obs 1103', NULL, NULL),
  (1104, 1, 'AB_12',   5, NULL, false, true, 'obs 1104', NULL, NULL),
  (1105, 1, 'ZZZ999',  5, NULL, false, true, 'obs 1105', NULL, NULL),
  (1106, 1, 'ABC123',  5, NULL, false, false, 'obs 1106', 'expandido_origem', NULL),
  (1107, 1, 'UNICO77', 5, 5,    true,  true, 'obs 1107', 'manual_confirmado', 3003),
  (2201, 2, 'SELADORA NITRO', 5, NULL, false, true, 'obs 2201', NULL, NULL),
  (3301, 3, 'SELADORA NITRO', 5, NULL, false, true, 'obs 3301', NULL, NULL),
  (3302, 3, 'SELADORA NITRO', 5, 20,   false, true, 'obs 3302', NULL, NULL);
SET session_replication_role = origin;
SQL

# ── A chamada, numa transação desfeita no fim (as sementes ficam intactas entre os cenários) ────
# chamar <uid> <SELECT que devolve 1 jsonb> <projeção sobre r> <estado lido como postgres> [<preparo>]
# O SELECT roda como authenticated com test.uid (RLS e ACL de verdade). Um erro da chamada vira o
# VALOR "SQLSTATE=<código>" (a marca do ramo, invariante ao locale), com ":GUARDA_LACO_VAZIO" quando
# é a guarda desta migration: comparado ao esperado, é resultado, não erro de execução. Erro FORA da
# chamada (preparo, estado) sai como ERROR do psql, e o eq o trata como erro de execução.
chamar() {
  P -qtA 2>&1 <<SQL || true
BEGIN;
${5:-}
SET LOCAL ROLE authenticated;
SET LOCAL "test.uid" = '$1';
DO \$c\$
DECLARE r jsonb;
BEGIN
  EXECUTE \$q\$ $2 \$q\$ INTO r;
  PERFORM set_config('t.saida', COALESCE(($3)::text, '<null>'), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('t.saida', 'SQLSTATE=' || SQLSTATE
    || CASE WHEN SQLERRM LIKE 'expandir_promocao_item: nenhuma das %' THEN ':GUARDA_LACO_VAZIO' ELSE '' END, true);
END
\$c\$;
RESET ROLE;
SELECT current_setting('t.saida') || '|' || ($4);
ROLLBACK;
SQL
}
# A chamada do FRONT: supabase.rpc("expandir_promocao_item", { p_item_id }) — o PostgREST tipa o
# argumento pelo JSON e chama com notação NOMEADA, sem o threshold.
front()   { printf '%s' "SELECT public.expandir_promocao_item(\"p_item_id\" := b.p_item_id) FROM json_to_record('{\"p_item_id\": $1}'::json) AS b(p_item_id bigint)"; }
posic()   { printf '%s' "SELECT public.expandir_promocao_item($1::bigint)"; }
dois()    { printf '%s' "SELECT public.expandir_promocao_item($1::bigint, $2)"; }
ST="COALESCE(r->>'status', 'erro:' || (r->>'erro'))"
# estado de um item: qualidade | confirmado | ativo | sku | observações (em ASCII: o travessão vira '-')
item()    { printf '%s' "(SELECT COALESCE(mapeamento_qualidade, '-') || '|' || confirmado || '|' || ativo || '|' || COALESCE(sku_codigo_omie::text, '-') || '|' || translate(COALESCE(observacoes, '<null>'), '—áàâãéêíóôõúç', '-aaaaeeiooouc') FROM public.promocao_item WHERE id = $1)"; }
# as variantes que a chamada criou na campanha: sku:qualidade:confirmado, ordenadas
novos()   { printf '%s' "(SELECT COALESCE(string_agg(sku_codigo_omie || ':' || mapeamento_qualidade || ':' || confirmado, ',' ORDER BY sku_codigo_omie), '-') FROM public.promocao_item WHERE campanha_id = $1 AND id < 1000)"; }
cands()   { printf '%s' "(SELECT COALESCE(string_agg(c->>'omie_codigo_produto', ',' ORDER BY c->>'omie_codigo_produto'), '-') FROM public.promocao_item, jsonb_array_elements(mapeamento_candidatos) c WHERE id = $1)"; }

# ══════════════════════════════════════════════════════════════════════════════
# C — os predecessores são os corpos de PROD, byte a byte (md5 exato medido por psql-ro), e as
# sementes de similaridade caem do lado certo do limiar 0,5.
# ══════════════════════════════════════════════════════════════════════════════
echo "── C: predecessores = prod ──"
eq C1 "expandir_promocao_item(bigint) = corpo de prod" "$(md5_de 'public.expandir_promocao_item(bigint)')" "6677fa80de976b37dd784544058ccf4b"
eq C2 "expandir_promocao_item(bigint,numeric) = corpo de prod (20260929000234)" "$(md5_de 'public.expandir_promocao_item(bigint,numeric)')" "bc8f2c0e7a85ccdf89b5e5cd59b84e38"
eq C3 "listar_skus_por_codigo_fornecedor = corpo de prod" "$(md5_de 'public.listar_skus_por_codigo_fornecedor(text,text)')" "dde6bdf77b96f103c99b2699ac33207f"
eq C4 "private.padrao_like_contem = corpo de prod" "$(md5_de 'private.padrao_like_contem(text)')" "c8cff40d683ca035791f205d0e83d291"
eq C5 "sementes: parecidos >= 0,5 (e < 0,99), longes < 0,5, e nenhum parecido casa o LIKE" "$(Pq -c "
  SELECT (extensions.similarity('SELADOR NITRO', 'SELADORA NITRO') BETWEEN 0.5 AND 0.98)
     AND extensions.similarity('SELADOR NITRO 0,9L', 'SELADORA NITRO') >= 0.5
     AND extensions.similarity('SELADOR NITRO 3,6L', 'SELADORA NITRO') >= 0.5
     AND extensions.similarity('VERNIZ PU BRILHO', 'SELADORA NITRO') < 0.5
     AND (SELECT max(extensions.similarity(descricao, 'ZZZ999')) FROM public.omie_products WHERE account = 'emp_like') < 0.5
     AND NOT EXISTS (SELECT 1 FROM public.omie_products WHERE account IN ('emp_sim1', 'emp_sim2') AND descricao ILIKE '%SELADORA NITRO%');" 2>&1 || true)" "t"

# ══════════════════════════════════════════════════════════════════════════════
# A — nos predecessores de PROD os 3 defeitos reproduzem (se não reproduzissem, os positivos de F
# passariam por vacuidade).
# ══════════════════════════════════════════════════════════════════════════════
echo "── A: os defeitos existem nos predecessores ──"
eq A1 "a chamada do front (1 argumento, nomeada) é ambígua: 42725, e o item não muda" \
   "$(chamar "$M" "$(front 1101)" "$ST" "$(item 1101)")" "SQLSTATE=42725|-|false|true|-|obs 1101"
eq A2 "posicional também: 42725" "$(chamar "$M" "$(posic 1101)" "$ST" "'x'")" "SQLSTATE=42725|x"
eq A3 "0 variantes (2 argumentos): similarity sem schema, 42883" "$(chamar "$M" "$(dois 1105 0.5)" "$ST" "'x'")" "SQLSTATE=42883|x"
eq A4 ">=2 variantes (2 argumentos): o CASE do laço cita similarity, 42883" "$(chamar "$M" "$(dois 1102 0.5)" "$ST" "'x'")" "SQLSTATE=42883|x"
eq A5 "1 variante (2 argumentos): o único caminho que rodava" "$(chamar "$M" "$(dois 1101 0.5)" "$ST" "$(item 1101)")" "resolvido_unico|unico|true|true|3003|obs 1101"
so_sim="$TMPD/so_similarity.sql"
py funcao "$MIG_LIKE" "public.expandir_promocao_item(p_item_id bigint, p_threshold" "$so_sim" so_similarity || { echo "INFRA: predecessor com só o conserto 2 não montado"; exit 1; }
eq A6 "consertar SÓ a similarity: com volume, 0 variantes, original desativado e observação apagada" \
   "$(chamar "$M" "$(dois 1103 0.5)" "$ST || ':' || COALESCE(r->>'variantes_criadas', '<null>')" "$(item 1103) || '|' || $(novos 1)" "\\i $so_sim")" \
   "expandido:<null>|expandido_origem|false|false|-|<null>|-"

# ══════════════════════════════════════════════════════════════════════════════
# M — a migration como o SQL Editor a roda: o BEGIN/COMMIT é do ARQUIVO (sem -1). Com ON_ERROR_STOP,
# um RAISE aborta o psql e a transação aberta morre com a conexão. Partida: os predecessores de prod.
# ══════════════════════════════════════════════════════════════════════════════
echo "── M: a migration sob o executor ──"
MIG_EFETIVA="$MIG"
case "$SABOTAGEM" in
  pre_*|pos_*)
    MIG_EFETIVA="$TMPD/mig_sabotada.sql"
    py migration "$MIG" "$SABOTAGEM" "$MIG_EFETIVA" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac
aplicar() { P -q -f "$1" 2>&1; }
variante() {   # <nome> → caminho da cópia da migration efetiva com a variante
  local v="$TMPD/var_$1.sql"
  py migration "$MIG_EFETIVA" "$1" "$v" || { echo "INFRA: variante $1 não montada"; exit 1; }
  printf '%s' "$v"
}
# O veredito de um apply que TEM de ser recusado: o exit do psql decide se recusou; a LINHA DE ERRO
# do servidor, POR QUEM. Apply que passou é APLICOU (FALHOU no eq); recusa pelo motivo errado é
# RECUSOU_POR_OUTRO. Casar o rótulo no texto TODO dava verde falso: a sabotagem de uma camada vira
# NOTICE com o MESMO rótulo, e quando uma camada POSTERIOR também recusa, o NOTICE "provava" a recusa
# da sabotada (pego pela 1ª falsificação: POS1, POS2 e POS3 saíram sem dente).
veredito() {   # <arquivo> <texto esperado na recusa>
  local saida linha
  if saida="$(aplicar "$1")"; then printf 'APLICOU'; return 0; fi
  while IFS= read -r linha; do
    case "$linha" in
      *"ERROR: "*"$2"*|*"ERRO: "*"$2"*) printf 'RECUSOU'; return 0 ;;
    esac
  done <<< "$saida"
  printf 'RECUSOU_POR_OUTRO %s' "$(printf '%s\n' "$saida" | grep -E '(ERROR|ERRO): ' | head -1 | tr -d ':' | head -c 150 || true)"
}
existe() { Pq -c "SELECT to_regprocedure('$1') IS NOT NULL;" 2>&1 || true; }

# M1 — corpo ESTRANHO no (bigint,numeric) (outra mudança chegou antes): a PRE recusa, o estranho
# fica inteiro e o (bigint) não é dropado.
P -q -c "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;"
retrato_estranho="$(retrato)"
[ "$retrato_estranho" != "$retrato_pred" ] || { echo "INFRA: o corpo estranho não é estranho"; exit 1; }
eq M1a "corpo estranho no (bigint,numeric): a PRE recusa" "$(veredito "$MIG_EFETIVA" 'PRE FALHOU: o corpo vivo de (bigint,numeric)')" "RECUSOU"
eq M1b "corpo estranho preservado e o (bigint) de pé (retrato integral)" "$(retrato)" "$retrato_estranho"
restaurar_predecessores

# M2 — corpo estranho no (bigint): dropar às cegas apagaria uma mudança que ninguém mediu.
P -q -c "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;"
v="$(veredito "$MIG_EFETIVA" 'PRE FALHOU: o corpo vivo de (bigint)')"
eq M2 "corpo estranho no (bigint): a PRE recusa e ele não é dropado (veredito|existe)" "$v|$(existe 'public.expandir_promocao_item(bigint)')" "RECUSOU|t"
restaurar_predecessores

# M3 — sobrevivente AUSENTE: a PRE aborta, e o (bigint) não sai.
P -q -c "DROP FUNCTION public.expandir_promocao_item(bigint, numeric);"
v="$(veredito "$MIG_EFETIVA" 'PRE FALHOU: expandir_promocao_item(bigint,numeric) ausente')"
eq M3 "(bigint,numeric) ausente: a PRE aborta e nada muda (veredito|(bigint)|(bigint,numeric))" \
   "$v|$(existe 'public.expandir_promocao_item(bigint)')|$(existe 'public.expandir_promocao_item(bigint,numeric)')" "RECUSOU|t|f"
restaurar_predecessores

# M4 — a trava tem de ser no-op: com a config do sobrevivente diferente da esperada, o ALTER da trava
# a mudaria em silêncio. A PRE recusa, e a config diferente fica como estava.
P -q -c "ALTER FUNCTION public.expandir_promocao_item(bigint, numeric) SET search_path = public;"
v="$(veredito "$MIG_EFETIVA" 'PRE FALHOU: a config de (bigint,numeric)')"
eq M4 "trava não-no-op: a PRE recusa e a config fica (veredito|config)" \
   "$v|$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.expandir_promocao_item(bigint,numeric)');" 2>&1 || true)" \
   "RECUSOU|search_path=public"
restaurar_predecessores

# M5 — a PRE TRAVA a linha antes de ler o corpo. Duas conexões, ordem OBSERVADA (desenho da
# 20260927195430): C segura uma trava de liberação (advisory de sessão); A roda a PRE numa transação
# aberta, sinaliza com um advisory de TRANSAÇÃO e fica preso na trava de C; B só é lançado quando vê
# o sinal de A e tenta recriar o sobrevivente com lock_timeout. lock_not_available prova que esperou.
# Depois de B, o sinal de A ainda concedido prova que A seguia na transação. Controle (M5c): recriar
# OUTRA função no mesmo instante não espera. B roda dentro de BEGIN…ROLLBACK.
pre_sql="$(awk '/^DO \$pre\$$/,/^\$pre\$;$/' "$MIG_EFETIVA")"
case "$pre_sql" in
  *"PRE FALHOU"*)
    P -q -c "CREATE FUNCTION public.m5_controle(uuid) RETURNS int LANGUAGE sql AS 'SELECT 1';"
    esperar_advisory() {   # <objid> → 0 quando concedido; 1 se não aparecer em ~10 s
      local _i
      for _i in $(seq 1 100); do
        [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted;")" = 1 ] && return 0
        sleep 0.1
      done
      return 1
    }
    ( P -q -c "SELECT pg_advisory_lock(626263); SELECT pg_sleep(600);" ) > "$TMPD/m5-c.log" 2>&1 &
    m5_c=$!
    m5_a=""
    barreira=0
    if esperar_advisory 626263; then
      ( P -q <<SQL
BEGIN;
$pre_sql
SELECT pg_advisory_xact_lock(626262);
SELECT pg_advisory_xact_lock(626263);
ROLLBACK;
SQL
      ) > "$TMPD/m5-a.log" 2>&1 &
      m5_a=$!
      esperar_advisory 626262 && barreira=1
    fi
    tentar() {   # <CREATE concorrente> → M5_RESULTADO=BLOQUEADO | NAO_BLOQUEOU | erro
      P -tA 2>&1 <<SQL || true
BEGIN;
SET LOCAL lock_timeout = '500ms';
DO \$m5\$ BEGIN
  BEGIN
    EXECUTE \$cria\$ $1 \$cria\$;
    RAISE NOTICE 'M5_RESULTADO=NAO_BLOQUEOU';
  EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'M5_RESULTADO=BLOQUEADO';
  END;
END \$m5\$;
ROLLBACK;
SQL
    }
    if [ "$barreira" = 1 ]; then
      r5="$(tentar "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS \$f\$ BEGIN RETURN NULL; END \$f\$")"
      r5c="$(tentar "CREATE OR REPLACE FUNCTION public.m5_controle(uuid) RETURNS int LANGUAGE sql AS 'SELECT 2'")"
      if [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 626262 AND granted;")" != 1 ]; then
        r5="A SAIU DA TRANSACAO ANTES DO FIM DE B: $r5"; r5c="$r5"
      fi
    else
      r5="BARREIRA NAO OBSERVADA: $(head -c 200 "$TMPD/m5-a.log" 2>/dev/null) $(head -c 200 "$TMPD/m5-c.log")"; r5c="$r5"
    fi
    Pq -c "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid IN (626262, 626263) AND granted;" >/dev/null 2>&1 || true
    wait "$m5_c" 2>/dev/null || true
    if [ -n "$m5_a" ]; then wait "$m5_a" 2>/dev/null || true; fi
    P -q -c "DROP FUNCTION public.m5_controle(uuid);"
    case "$r5" in
      *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M5 "sem corrida válida: [$(curto "$r5")]" ;;
      *M5_RESULTADO=BLOQUEADO*)    ok M5 "a PRE trava a linha: um CREATE OR REPLACE concorrente espera" ;;
      *M5_RESULTADO=NAO_BLOQUEOU*) bad M5 "a PRE NÃO trava: outro aplicador recriou o sobrevivente durante a PRE" ;;
      *)                           erro_exec M5 "sem veredito: [$(curto "$r5")]" ;;
    esac
    case "$r5c" in
      *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M5c "sem corrida válida: [$(curto "$r5c")]" ;;
      *M5_RESULTADO=NAO_BLOQUEOU*) ok M5c "controle: recriar OUTRA função durante a PRE não espera" ;;
      *M5_RESULTADO=BLOQUEADO*)    bad M5c "a PRE trava mais que as linhas das próprias funções" ;;
      *)                           erro_exec M5c "sem veredito: [$(curto "$r5c")]" ;;
    esac ;;
  *)
    erro_exec M5 "a PRE não foi extraída da migration"
    erro_exec M5c "a PRE não foi extraída da migration" ;;
esac
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores

# M6 — dependência late-bound fora do alcance de quem chama: sem USAGE em `extensions`, o corpo
# novo daria 42501 no 1º uso pelo front. A PRE recusa antes de trocar qualquer coisa.
P -q -c "REVOKE USAGE ON SCHEMA extensions FROM authenticated;"
eq M6 "authenticated sem USAGE em extensions: a PRE recusa" "$(veredito "$MIG_EFETIVA" 'PRE FALHOU: extensions.similarity')" "RECUSOU"
P -q -c "GRANT USAGE ON SCHEMA extensions TO authenticated;"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores

# M7-M13 — a POS, uma camada por variante; cada recusa tem de vir da camada CERTA (o rótulo).
eq M7a "sem o DROP: os 2 overloads seguem e a POS1 reprova" "$(veredito "$(variante var_sem_drop)" 'POS1 FALHOU')" "RECUSOU"
eq M7b "POS reprovada desfaz tudo (retrato integral = predecessores)" "$(retrato)" "$retrato_pred"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M8 "sobrevivente recriado sem o DEFAULT: a chamada do front não resolve e a POS2 reprova" "$(veredito "$(variante var_sem_default)" 'POS2 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M9 "similarity sem schema no corpo instalado: a POS3 reprova" "$(veredito "$(variante var_similarity_nua)" 'POS3 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M10 "corpo editado (1 espaço): o md5 da POS4 reprova" "$(veredito "$(variante var_corpo_editado)" 'POS4 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M11 "SECURITY DEFINER no CREATE (corpo igual): a POS5 reprova" "$(veredito "$(variante var_secdef)" 'POS5 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M12 "DROP+CREATE do sobrevivente (OID e ACL novos): a POS6 reprova" "$(veredito "$(variante var_drop_create)" 'POS6 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores
eq M13 "REVOKE de anon no caminho (ACL mexido): a POS6 reprova" "$(veredito "$(variante var_revoke_anon)" 'POS6 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores

# M14/M15 — a migration aplica, e re-aplicar é seguro. O retrato esperado: o (bigint) some; o
# sobrevivente tem o corpo novo com a MESMA config e o MESMO ACL; listar_skus e o helper intactos.
acl_sobrevivente="$(Pq -c "SELECT COALESCE(proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.expandir_promocao_item(bigint,numeric)');")"
retrato_novo="ausente#566edd782fb00616c6d658b9562020d2|search_path=public, pg_temp|$acl_sobrevivente|false#$(printf '%s' "$retrato_pred" | cut -d'#' -f3,4)"
eq M14 "a migration aplica (veredito|retrato)" "$(veredito "$MIG_EFETIVA" '__nunca__')|$(retrato)" "APLICOU|$retrato_novo"
eq M15 "re-aplicar é seguro e não muda nada (veredito|retrato)" "$(veredito "$MIG_EFETIVA" '__nunca__')|$(retrato)" "APLICOU|$retrato_novo"

# ── sabotagem de CORPO: aplicada no banco depois do apply (a POS não a veria) ──────────────────
case "$SABOTAGEM" in
  similarity_nua_max|similarity_nua_laco|volume_expande|sem_guarda|like_cru_laco)
    recriar "$MIG" "public.expandir_promocao_item(p_item_id bigint, p_threshold" "$SABOTAGEM" \
      || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  overload_vivo)
    recriar "$SNAP" "public.expandir_promocao_item(p_item_id bigint)" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    P -q -c "$ACL_BIGINT"
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# F — depois do conserto, pela chamada do FRONT (authenticated master, 1 argumento nomeado).
# ══════════════════════════════════════════════════════════════════════════════
echo "── F: a chamada do front nos 3 caminhos ──"
eq F1 "1 variante: resolve in-place, confirmado" "$(chamar "$M" "$(front 1101)" "$ST" "$(item 1101)")" "resolvido_unico|unico|true|true|3003|obs 1101"
eq F2 "0 variantes, nada parecido: nao_encontrado, com a melhor similaridade abaixo do limiar" \
   "$(chamar "$M" "$(front 1105)" "$ST || ':' || ((r->>'melhor_similaridade')::numeric < 0.5)" "$(item 1105)")" \
   "nao_encontrado:true|nao_encontrado|false|true|-|obs 1105"
eq F3 "0 variantes, 1 parecido: resolve por similaridade SEM confirmar, e anota para revisar" \
   "$(chamar "$M" "$(front 2201)" "$ST" "$(item 2201)")" \
   "resolvido_por_similaridade|unico_por_similaridade|false|true|4001|obs 2201 [Resolvido por similaridade - revisar]"
eq F4 "0 variantes, 2 parecidos, sem volume: expande por similaridade (sem confirmar) e desativa o original" \
   "$(chamar "$M" "$(front 3301)" "$ST || ':' || (r->>'variantes_criadas') || ':' || (r->>'requer_revisao')" "$(item 3301) || '|' || $(novos 3)")" \
   "expandido_por_similaridade:2:true|expandido_origem|false|false|-|obs 3301 [Item original - expandido em 2 variantes (similaridade)]|5001:expandido_por_similaridade:false,5002:expandido_por_similaridade:false"
eq F5 ">=2 variantes, sem volume: expande (confirmado) e desativa o original" \
   "$(chamar "$M" "$(front 1102)" "$ST || ':' || (r->>'variantes_criadas')" "$(item 1102) || '|' || $(novos 1)")" \
   "expandido:2|expandido_origem|false|false|-|obs 1102 [Item original - expandido em 2 variantes]|3001:expandido_automatico:true,3002:expandido_automatico:true"
eq F6 ">=2 variantes, COM volume: não expande; fica ativo, ambiguo, com os candidatos e a observação" \
   "$(chamar "$M" "$(front 1103)" "$ST || ':' || (r->>'total_matches') || ':' || (r->>'motivo')" "$(item 1103) || '|' || $(cands 1103) || '|' || $(novos 1)")" \
   "ambiguo:2:volume_minimo_impede_expansao|ambiguo|false|true|-|obs 1103|3001,3002|-"
eq F7 "2 parecidos, COM volume: também não expande (ambiguo com os parecidos)" \
   "$(chamar "$M" "$(front 3302)" "$ST || ':' || (r->>'total_matches')" "$(item 3302) || '|' || $(cands 3302) || '|' || $(novos 3)")" \
   "ambiguo:2|ambiguo|false|true|-|obs 3302|5001,5002|-"
eq F8 "laço sem nenhuma inserção (UNIQUE NULLS NOT DISTINCT): aborta pela guarda e o original fica" \
   "$(chamar "$M" "$(front 1102)" "$ST" "$(item 1102) || '|' || $(novos 1)" \
      "DELETE FROM public.promocao_item WHERE id = 1106; ALTER TABLE public.promocao_item DROP CONSTRAINT uq_item_na_campanha; ALTER TABLE public.promocao_item ADD CONSTRAINT uq_item_na_campanha UNIQUE NULLS NOT DISTINCT (campanha_id, sku_codigo_fornecedor, volume_minimo);")" \
   "SQLSTATE=P0001:GUARDA_LACO_VAZIO|-|false|true|-|obs 1102|-"
eq F9 "AB_12: o _ é literal no laço (não casa AB-12 nem ABX12)" \
   "$(chamar "$M" "$(front 1104)" "$ST || ':' || (r->>'variantes_criadas')" "$(novos 1)")" \
   "expandido:2|3004:expandido_automatico:true,3005:expandido_automatico:true"
eq F10 "autenticado sem papel: a RLS esconde o item e nada muda" "$(chamar "$N" "$(front 1101)" "$ST" "$(item 1101)")" "erro:item_nao_encontrado|-|false|true|-|obs 1101"
eq F11 "guardas antigos: item já expandido e item já confirmado" \
   "$(chamar "$M" "$(front 1106)" "$ST" "'-'"),$(chamar "$M" "$(front 1107)" "$ST" "'-'")" "erro:ja_expandido|-,erro:ja_confirmado|-"
eq F12 "2 argumentos com threshold 0,99: o parecido (0,81) não passa e sai nao_encontrado" \
   "$(chamar "$M" "$(dois 2201 0.99)" "$ST" "$(item 2201)")" "nao_encontrado|nao_encontrado|false|true|-|obs 2201"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executados $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO — prova truncada não é verde"
  exit 1
fi
[ "$FAIL" -eq 0 ]
