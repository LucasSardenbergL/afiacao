#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  test-padrao-like-contem.sh — prova PG17 da 20260929000234 (classe            ║
# ║  pattern-like-cru, camada SQL). Roda o helper private.padrao_like_contem e as ║
# ║  7 RPCs que passam a usá-lo sobre o schema-snapshot, com os corpos de PROD    ║
# ║  como predecessores (md5 exato conferido em C1-C7).                           ║
# ║                                                                                ║
# ║  C  controle: os 7 predecessores são os de prod.                               ║
# ║  A  anti-vacuidade: nos predecessores, a semente REPRODUZ o bug (curinga e     ║
# ║     termo degenerado). Sem isso, os negativos depois do fix não provariam      ║
# ║     nada.                                                                      ║
# ║  M  a migration sob o executor, em transação única como o db:aplicar: a PRE   ║
# ║     recusa corpo estranho, função ausente e trava que não é no-op, e TRAVA a  ║
# ║     linha (duas conexões, barreira observada); a POS pega DROP+CREATE (ACL),   ║
# ║     corpo editado sem o md5, helper sem o degenerado e helper sem escape;      ║
# ║     aplica e re-aplica.                                                        ║
# ║  H  o helper: degenerado → NULL, escape exato, auto-casamento, curinga não     ║
# ║     interpretado, atributos e EXECUTE.                                         ║
# ║  F  as 7 funções depois do fix: o literal casa, o curinga não, o degenerado   ║
# ║     não casa nada, o gate de staff continua.                                   ║
# ║                                                                                ║
# ║  rode: bash db/test-padrao-like-contem.sh > log 2>&1; echo "exit=$?"           ║
# ║        bash db/test-padrao-like-contem.sh --falsificar > log 2>&1              ║
# ║  matriz: HARNESS_LC=C | pt_BR.UTF-8 (lc_messages do servidor; o cliente fica   ║
# ║  em LC_ALL=C e todo grep aqui é ASCII).                                        ║
# ║  Diário: docs/historico/like-cru-camada-sql.md                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5641}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="padrao-like-contem"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260929000234_padrao_like_contem_escapa_curinga.sql"
# melhoria_clientes_por_produto: o corpo de prod é o desta migration, aplicada DEPOIS do snapshot
MIG_MELHORIA="$REPO_ROOT/supabase/migrations/20260905225613_preco_ausente_nao_e_zero.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
# Denominador: C1-C7 · A1-A8 · M1a M1b M2 M3 M4a M4b M5 M5c M6 M7 M8 M9 M10 · H1-H5 · F1-F26.
# Menos asserts executados é vermelho: FAIL=0 com PASS encolhido é a prova truncada que aprova tudo.
TOTAL_ESPERADO=59

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
  SABOTAGENS="helper_sem_escape:H2,H3,H4,F1,F3,F5,F6,F7,F10,F11,F16,F19,F21,F24:H1,H5,F2,F4,F8,F9,F12,F13,F14,F15,F17,F18,F20,F22,F23,F25
              helper_sem_degenerado:H1,F2,F8,F12,F14,F15,F23:H2,H3,H4,F1,F3,F4,F5,F6,F7,F9,F10,F11,F13,F16,F17,F18,F19,F20,F21,F24,F25
              listar_cru:F1,F2,F3,F5,F6,F10,F12:F4,F7,F8,F9,F11,F13
              expandir_inline_cru:F11:F10,F12,F13
              resolver_cru:F7,F8:F1,F9
              buscar_cadeia:F14,F15:F16,F17
              melhoria_clientes_cru:F18,F19:F20,F21,F22
              melhoria_produtos_cru:F20,F21:F18,F19
              matcher_cru:F23,F24:F25
              melhoria_sem_gate:F22:F18,F19
              melhoria_fuso_utc:F26:F18,F19
              pre_sem_trava:M5:M5c,M1a,M2,M3,M6
              pre_aceita_qualquer:M1a,M1b:M2,M3,M5,M6
              pre_ausente_segue:M2:M1a,M3,M6
              pre_config_nao_confere:M3:M1a,M2,M6
              pos_sem_acl:M4a,M4b:M1a,M6
              pos_sem_md5:M8:M9,M10,M6
              pos_sem_degenerado:M9:M8,M10,M6
              pos_sem_escape:M10:M8,M9,M6"
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
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro do psql ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}
curto() { printf '%s' "$1" | tr '\n' ' ' | head -c 200; }

# ── Extrator de função (python, sem interpolação do bash: `\` e `'` chegam intactos) ────────────
# py_funcao <arquivo> <prefixo depois de "FUNCTION "> <saida> [<sabotagem>]
#   Copia o bloco CREATE [OR REPLACE] FUNCTION <prefixo>… até a tag de dollar que fecha o corpo,
#   como CREATE OR REPLACE. Com <sabotagem>, aplica as trocas dela: cada padrão tem de ocorrer
#   EXATAMENTE n× no bloco (uma troca que não pegou deixaria a suíte verde).
# py_migration <sabotagem> <saida>: a migration inteira com as trocas da sabotagem de PRE/POS.
PY_TROCAS="$TMPD/trocas.py"
cat > "$PY_TROCAS" <<'PY'
import re, sys
H = "private.padrao_like_contem("
TROCAS = {
  # ── corpo (no banco, depois do apply) ──
  "helper_sem_escape": ("private.padrao_like_contem(", [
    (r"""ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'""",
     r"""ELSE '%' || p_termo || '%'""", 1)]),
  "helper_sem_degenerado": ("private.padrao_like_contem(", [
    (r"""WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL""", r"""WHEN false THEN NULL""", 1)]),
  "listar_cru": ("public.listar_skus_por_codigo_fornecedor(", [
    (r"""ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\'""", r"""ILIKE '%' || p_codigo_fornecedor || '%'""", 1)]),
  "expandir_inline_cru": ("public.expandir_promocao_item(p_item_id bigint, p_threshold", [
    (r"""ILIKE private.padrao_like_contem(v_item.sku_codigo_fornecedor) ESCAPE '\'""", r"""ILIKE '%' || v_item.sku_codigo_fornecedor || '%'""", 1)]),
  "resolver_cru": ("public.resolver_sku_por_codigo_fornecedor(", [
    (r"""ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\'""", r"""ILIKE '%' || p_codigo_fornecedor || '%'""", 3)]),
  "buscar_cadeia": ("public.buscar_skus_candidatos(", [
    (r"""private.padrao_like_contem(upper(t)) ESCAPE '\'""",
     r"""'%' || replace(replace(replace(upper(t), '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'""", 1)]),
  "melhoria_clientes_cru": ("public.melhoria_clientes_por_produto(", [
    (r"""ilike private.padrao_like_contem(trim(p_termo)) escape '\'""", r"""ilike '%' || trim(p_termo) || '%'""", 2)]),
  "melhoria_produtos_cru": ("public.melhoria_produtos_relacionados(", [
    (r"""ilike private.padrao_like_contem(trim(p_termo)) escape '\'""", r"""ilike '%' || trim(p_termo) || '%'""", 2)]),
  "matcher_cru": ("public.tarefas_matcher_tick(", [
    (r"""ilike private.padrao_like_contem(t.target_texto) escape '\'""", r"""ilike '%'||t.target_texto||'%'""", 1)]),
  "melhoria_fuso_utc": ("public.melhoria_clientes_por_produto(", [
    (r"""(so.created_at at time zone 'America/Sao_Paulo')::date""", r"""so.created_at::date""", 2)]),
  "melhoria_sem_gate": ("public.melhoria_clientes_por_produto(", [
    (r"""raise exception 'Apenas staff pode consultar';""", r"""null;""", 1)]),
  # ── variantes que o bloco M aplica (asserts de dente da PRE/POS, não sabotagens) ──
  "estranho_listar": ("public.listar_skus_por_codigo_fornecedor(", [
    (r"""ORDER BY op.descricao;""", r"""ORDER BY op.descricao DESC;""", 1)]),
  # ── PRE/POS (na cópia da migration inteira) ──
  "pre_sem_trava": (None, [
    (r"""    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', r.ident, r.sp);""", r"""    NULL;""", 1)]),
  "pre_aceita_qualquer": (None, [
    (r"""IF v_md5 IS NULL OR v_md5 NOT IN (r.md5_prod, r.md5_novo) THEN""",
     r"""IF v_md5 IS NULL OR v_md5 NOT IN (v_md5, r.md5_prod, r.md5_novo) THEN""", 1)]),
  "pre_ausente_segue": (None, [
    (r"""RAISE EXCEPTION 'PRE FALHOU: % ausente.""", r"""CONTINUE; RAISE EXCEPTION 'PRE FALHOU: % ausente.""", 1)]),
  "pre_config_nao_confere": (None, [
    (r"""IF v_antes IS DISTINCT FROM v_depois OR v_depois IS DISTINCT FROM ARRAY['search_path=' || r.sp] THEN""", r"""IF false THEN""", 1)]),
  "pos_sem_acl": (None, [(r"""RAISE EXCEPTION 'POS12 FALHOU""", r"""RAISE NOTICE 'POS12 FALHOU""", 1)]),
  "pos_sem_md5": (None, [(r"""RAISE EXCEPTION 'POS10 FALHOU""", r"""RAISE NOTICE 'POS10 FALHOU""", 1)]),
  "pos_sem_degenerado": (None, [(r"""RAISE EXCEPTION 'POS3 FALHOU""", r"""RAISE NOTICE 'POS3 FALHOU""", 1)]),
  "pos_sem_escape": (None, [(r"""RAISE EXCEPTION 'POS4 FALHOU""", r"""RAISE NOTICE 'POS4 FALHOU""", 1),
                            (r"""RAISE EXCEPTION 'POS5 FALHOU""", r"""RAISE NOTICE 'POS5 FALHOU""", 1)]),
  # ── variantes de migration do bloco M ──
  "var_drop_create": (None, [
    (r"""CREATE OR REPLACE FUNCTION public.melhoria_produtos_relacionados(""",
     "DROP FUNCTION public.melhoria_produtos_relacionados(text);\nCREATE OR REPLACE FUNCTION public.melhoria_produtos_relacionados(", 1)]),
  "var_corpo_editado": (None, [(r"""  ORDER BY op.descricao;""", r"""  ORDER BY op.descricao ;""", 1)]),
  "var_helper_degenerado": (None, [
    (r"""WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL""", r"""WHEN false THEN NULL""", 1)]),
  "var_helper_escape": (None, [
    (r"""ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'""",
     r"""ELSE '%' || p_termo || '%'""", 1)]),
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
            print("   sabotagem %s é de %s, não de %s" % (sys.argv[5], alvo, prefixo), file=sys.stderr); sys.exit(1)
        bloco = trocar(bloco, trocas)
    open(saida, "w", encoding="utf-8").write(bloco)
elif modo == "sabotar_corpo":
    arq, nome, saida = sys.argv[2], sys.argv[3], sys.argv[4]
    alvo, trocas = TROCAS[nome]
    open(saida, "w", encoding="utf-8").write(trocar(bloco_funcao(open(arq, encoding="utf-8").read(), alvo), trocas))
elif modo == "migration":
    arq, nome, saida = sys.argv[2], sys.argv[3], sys.argv[4]
    alvo, trocas = TROCAS[nome]
    open(saida, "w", encoding="utf-8").write(trocar(open(arq, encoding="utf-8").read(), trocas))
PY
py() { python3 "$PY_TROCAS" "$@"; }
# recria uma função a partir de <arquivo> (o snapshot, a migration de melhoria ou a desta prova)
recriar() {   # <arquivo> <prefixo> [<variante>]
  local tmp; tmp="$(mktemp "$TMPD/fn.XXXXXX")"
  py funcao "$1" "$2" "$tmp" ${3:+"$3"} || return 9
  P -q -f "$tmp" >/dev/null || return 9
  rm -f "$tmp"
}

echo "═══ PG17 :$PORT, lc_messages=$HARNESS_LC ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única), e o corpo de prod de
# melhoria_clientes_por_produto (o snapshot de 2026-09-05 é anterior à 20260905225613).
# ══════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
recriar "$MIG_MELHORIA" "public.melhoria_clientes_por_produto(" || { echo "INFRA: corpo de prod de melhoria_clientes não aplicado"; exit 1; }

# O ACL de PROD (psql-ro, 2026-09-28) nos papéis que a POS confere: as 3 invoker abertas a PUBLIC,
# anon e authenticated; as 4 fechadas sem anon. O snapshot vem sem privilégios.
ACL_PROD="
REVOKE ALL ON FUNCTION public.buscar_skus_candidatos(text[]), public.melhoria_clientes_por_produto(text),
  public.melhoria_produtos_relacionados(text), public.tarefas_matcher_tick() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_skus_candidatos(text[]), public.melhoria_clientes_por_produto(text),
  public.melhoria_produtos_relacionados(text), public.tarefas_matcher_tick() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.listar_skus_por_codigo_fornecedor(text,text), public.resolver_sku_por_codigo_fornecedor(text,text),
  public.expandir_promocao_item(bigint,numeric), public.expandir_promocao_item(bigint) TO PUBLIC, anon, authenticated, service_role;"
P -q -c "$ACL_PROD"

# As 7 identidades, na ordem da PRE/POS da migration, e o que cada uma é em prod.
ALVOS="public.listar_skus_por_codigo_fornecedor(text,text) public.resolver_sku_por_codigo_fornecedor(text,text) public.expandir_promocao_item(bigint,numeric) public.buscar_skus_candidatos(text[]) public.melhoria_clientes_por_produto(text) public.melhoria_produtos_relacionados(text) public.tarefas_matcher_tick()"
MD5_PROD="1016c3a5578ad0279b7b5da787ebc1c4 774dfc823a3ac3a736d844502776db85 9f56c82cb202725335680b196cd44ec5 3889779055fe534d9f125f7c3fc50e7f b482c18e67700353359012ca4a027ad6 f9bfbe39ab5bcc35a93bb09ddfb8bc56 be66e0548a5771d0956dca78f24df7ea"
MD5_NOVO="dde6bdf77b96f103c99b2699ac33207f c1ec2e9cdd4899d64563299da4d987a1 bc8f2c0e7a85ccdf89b5e5cd59b84e38 fe6a391c0ed72782d02b3404af6b73c8 fb00b17ac45b38e31a08fe4531c51618 b7ea8d9ef3a5e7cfdcfd4a611956affd 8359601c131e59f8681ba2e4dd228d6b"
# Os prefixos com que py_funcao acha cada predecessor no snapshot (melhoria_clientes: na MIG_MELHORIA).
PRED="$SNAP|public.listar_skus_por_codigo_fornecedor(
$SNAP|public.resolver_sku_por_codigo_fornecedor(
$SNAP|public.expandir_promocao_item(p_item_id bigint, p_threshold
$SNAP|public.buscar_skus_candidatos(
$MIG_MELHORIA|public.melhoria_clientes_por_produto(
$SNAP|public.melhoria_produtos_relacionados(
$SNAP|public.tarefas_matcher_tick("

lista_sql() { local out="" a; for a in $ALVOS; do out="$out${out:+,}'$a'"; done; printf '%s' "$out"; }
# O retrato INTEGRAL dos 7 (corpo exato | proconfig | ACL, ou "ausente") e o corpo do helper: sem o
# md5 dele, um helper sabotado que a POS deixasse passar ficaria de pé sem ninguém ver.
retrato() {
  Pq -c "SELECT string_agg(COALESCE((SELECT md5(p.prosrc) || '|' || COALESCE(array_to_string(p.proconfig, ';'), '') || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(a.f)), 'ausente'), '#' ORDER BY a.o) || '#helper=' || COALESCE((SELECT md5(p.prosrc) || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private.padrao_like_contem(text)')), 'ausente') FROM unnest(ARRAY[$(lista_sql)]) WITH ORDINALITY AS a(f, o);" 2>&1 || true
}
md5s() { Pq -c "SELECT string_agg(COALESCE((SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(a.f)), 'ausente'), ' ' ORDER BY a.o) FROM unnest(ARRAY[$(lista_sql)]) WITH ORDINALITY AS a(f, o);" 2>&1 || true; }
cfg_acl() { Pq -c "SELECT string_agg(COALESCE((SELECT COALESCE(array_to_string(p.proconfig, ';'), '') || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(a.f)), 'ausente'), '#' ORDER BY a.o) FROM unnest(ARRAY[$(lista_sql)]) WITH ORDINALITY AS a(f, o);" 2>&1 || true; }

# De volta aos predecessores de prod: os 7 corpos, a config que eles declaram, o ACL e sem helper.
restaurar_predecessores() {
  local linha
  while IFS= read -r linha; do
    recriar "${linha%%|*}" "${linha#*|}" || { echo "INFRA: predecessor ${linha#*|} não restaurado"; exit 1; }
  done <<< "$PRED"
  P -q -c "DROP FUNCTION IF EXISTS private.padrao_like_contem(text);"
  P -q -c "$ACL_PROD"
  [ "$(retrato)" = "$retrato_pred" ] || { echo "INFRA: predecessores restaurados como [$(retrato)], esperado [$retrato_pred]"; exit 1; }
}
# De volta ao estado que a migration REAL deixa (o helper e os 7 corpos dela). É o que desfaz uma
# variante da POS que passou sob sabotagem — re-aplicar não serve: a PRE recusaria o corpo editado.
restaurar_novo() {
  local pre
  for pre in "private.padrao_like_contem(" "public.listar_skus_por_codigo_fornecedor(" "public.resolver_sku_por_codigo_fornecedor(" \
             "public.expandir_promocao_item(p_item_id bigint, p_threshold" "public.buscar_skus_candidatos(" \
             "public.melhoria_clientes_por_produto(" "public.melhoria_produtos_relacionados(" "public.tarefas_matcher_tick("; do
    recriar "$MIG" "$pre" || { echo "INFRA: $pre não restaurado da migration"; exit 1; }
  done
  [ "$(retrato)" = "$retrato_novo" ] || { echo "INFRA: estado novo restaurado como [$(retrato)], esperado [$retrato_novo]"; exit 1; }
}

# ══════════════════════════════════════════════════════════════════════════════
# C — os predecessores são os corpos de PROD, byte a byte (md5 exato medido por psql-ro).
# ══════════════════════════════════════════════════════════════════════════════
echo "── C: predecessores = prod ──"
retrato_pred="$(retrato)"
atual="$(md5s)"
i=0
for a in $ALVOS; do
  i=$((i+1))
  eq "C$i" "predecessor $a = corpo de prod" "$(printf '%s' "$atual" | cut -d' ' -f$i)" "$(printf '%s' "$MD5_PROD" | cut -d' ' -f$i)"
done

# ══════════════════════════════════════════════════════════════════════════════
# SEMENTES — como postgres, com os gatilhos desligados (push_tarefa_nova chamaria net.*).
# Produtos escolhidos para que o curinga INTERPRETADO case a mais que o literal:
#   AB_12 ~ AB-12 ~ ABX12 · _12 ~ AB_12, XY_12 (literal) · 70% ~ "70 LITROS" · C\D (barra literal).
# ══════════════════════════════════════════════════════════════════════════════
S=00000000-0000-4000-8000-00000000000a   # staff (employee)
N=00000000-0000-4000-8000-00000000000b   # autenticado sem papel
F=00000000-0000-4000-8000-0000000000f1   # farmer
P -q <<SQL
SET session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('$S'), ('$N'), ('$F'),
  ('00000000-0000-4000-8000-0000000000c1'), ('00000000-0000-4000-8000-0000000000c2'), ('00000000-0000-4000-8000-0000000000c3'),
  ('00000000-0000-4000-8000-0000000000c4');
INSERT INTO public.profiles (user_id, name) VALUES ('00000000-0000-4000-8000-0000000000c4', 'CLIENTE FUSO');
INSERT INTO public.user_roles (user_id, role) VALUES ('$S', 'employee'), ('$S', 'master');
INSERT INTO public.omie_products (account, omie_codigo_produto, codigo, descricao, ativo) VALUES
  ('oben', 1001, 'P1', 'VERNIZ AB_12 BRILHO', true),
  ('oben', 1002, 'P2', 'VERNIZ AB-12 FOSCO', true),
  ('oben', 1003, 'P3', 'VERNIZ ABX12 ACETINADO', true),
  ('oben', 1004, 'P4', 'PRIMER XY_12 CINZA', true),
  ('oben', 1005, 'P5', 'ALCOOL 70% GALAO', true),
  ('oben', 1006, 'P6', 'ALCOOL 70 LITROS', true),
  ('oben', 1007, 'P7', 'TINTA C\D PRETA', true),
  ('oben', 1099, 'P9', 'VERNIZ AB_12 INATIVO', false),
  ('colacor', 2001, 'Q1', 'VERNIZ AB_12 OUTRA CONTA', true);
INSERT INTO public.promocao_campanha (id, empresa, fornecedor_nome, nome, tipo_origem, data_inicio, data_fim)
  VALUES (9001, 'oben', 'FORNECEDOR TESTE', 'campanha like-cru', 'outro', current_date, current_date + 30);
INSERT INTO public.promocao_item (id, campanha_id, sku_codigo_fornecedor, desconto_perc) VALUES
  (91001, 9001, 'AB_12', 10), (91002, 9001, '_12', 10), (91003, 9001, '%', 10), (91004, 9001, 'VERNIZ', 10);
INSERT INTO public.tarefas (id, descricao, categoria, customer_user_id, assigned_to, created_by, empresa, modo,
                            interacao_tipo, auto_satisfy_mode, target_texto, status, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'oferecer', 'oferecer', '00000000-0000-4000-8000-0000000000c1', '$F', '$F', 'oben', 'interacao', 'ligacao', 'conteudo', '',      'aberta', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000000e2', 'oferecer', 'oferecer', '00000000-0000-4000-8000-0000000000c2', '$F', '$F', 'oben', 'interacao', 'ligacao', 'conteudo', 'AB_12', 'aberta', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000000e3', 'oferecer', 'oferecer', '00000000-0000-4000-8000-0000000000c3', '$F', '$F', 'oben', 'interacao', 'ligacao', 'conteudo', 'ab_12', 'aberta', now() - interval '2 hours');
INSERT INTO public.farmer_calls (farmer_id, call_type, customer_user_id, created_at, entities_extracted) VALUES
  ('$F', 'follow_up', '00000000-0000-4000-8000-0000000000c1', now() - interval '1 hour', '[{"type":"product","value":"Verniz AB-12","confidence":0.9,"context":"x"}]'),
  ('$F', 'follow_up', '00000000-0000-4000-8000-0000000000c2', now() - interval '1 hour', '[{"type":"product","value":"Verniz AB-12","confidence":0.9,"context":"x"}]'),
  ('$F', 'follow_up', '00000000-0000-4000-8000-0000000000c3', now() - interval '1 hour', '[{"type":"product","value":"VERNIZ AB_12 BRILHO","confidence":0.8,"context":"x"}]');
-- O pedido do dente de fuso: 22:00 em SP no dia d (= d+1 01:00 UTC), sem order_date_kpi, relativo a
-- now() para não envelhecer. Sob sessão UTC, created_at::date sai d+1; no fuso de SP, d.
INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, order_date_kpi, created_at)
  VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c4', '$S', 'enviado', NULL,
          (((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) + time '22:00') AT TIME ZONE 'America/Sao_Paulo');
INSERT INTO public.order_items (sales_order_id, customer_user_id, product_id, quantity, unit_price)
  VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c4',
          (SELECT id FROM public.omie_products WHERE codigo = 'P1'), 2, 10);
SET session_replication_role = origin;
SQL

listar()   { Pq -c "SELECT count(*) || ':' || COALESCE(string_agg(codigo_interno, ',' ORDER BY codigo_interno), '-') FROM public.listar_skus_por_codigo_fornecedor('oben', \$t\$$1\$t\$);" 2>&1 || true; }
resolver() { Pq -c "SELECT (r->>'qualidade') || ':' || COALESCE(r->>'omie_codigo_produto', r->>'total_matches', '-') FROM public.resolver_sku_por_codigo_fornecedor('oben', \$t\$$1\$t\$) r;" 2>&1 || true; }
buscar()   { Pq -c "SET test.uid = '$S'; SELECT count(*) || ':' || COALESCE(string_agg(codigo, ',' ORDER BY codigo), '-') FROM public.buscar_skus_candidatos($1);" 2>&1 || true; }
melhoria() { Pq -c "SET test.uid = '$S'; SELECT jsonb_array_length(r->'produtos_casados') || ':' || COALESCE((SELECT string_agg(x->>'codigo', ',' ORDER BY x->>'codigo') FROM jsonb_array_elements(r->'produtos_casados') x), '-') FROM public.$1(\$t\$$2\$t\$) r;" 2>&1 || true; }
fuso() { Pq -c "SET test.uid = '$S'; SET TimeZone = 'UTC'; SELECT CASE r->'clientes'->0->>'ultima_compra' WHEN ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5)::text THEN 'DATA_SP' WHEN ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 4)::text THEN 'DIA_SEGUINTE' ELSE 'OUTRA:' || COALESCE(r->'clientes'->0->>'ultima_compra', '-') END FROM public.melhoria_clientes_por_produto('AB_12') r;" 2>&1 || true; }
# O que o matcher disse de cada tarefa: MENCAO:<valor casado> ou SEM_MENCAO (o motivo tem acento e
# travessão; o assert compara ASCII).
matcher() {
  Pq -c "SELECT public.tarefas_matcher_tick();" >/dev/null 2>&1 || { echo "ERRO: tarefas_matcher_tick falhou"; return 0; }
  Pq -c "SELECT COALESCE((SELECT CASE WHEN c.motivo LIKE 'Mencionou%' THEN 'MENCAO:' || COALESCE(c.matched_payload->>'value', '?') ELSE 'SEM_MENCAO' END FROM public.tarefa_satisfacao_candidatos c WHERE c.tarefa_id = '$1'), 'SEM_CANDIDATO');" 2>&1 || true
}

# ══════════════════════════════════════════════════════════════════════════════
# A — nos predecessores de PROD a semente reproduz o bug (se não reproduzisse, os negativos de F
# passariam por vacuidade).
# ══════════════════════════════════════════════════════════════════════════════
echo "── A: o bug existe nos predecessores ──"
eq A1 "listar AB_12: o _ é curinga e casa AB-12 e ABX12" "$(listar 'AB_12')" "3:P1,P2,P3"
eq A2 "listar %: o termo degenerado casa todo produto da conta" "$(listar '%')" "7:P1,P2,P3,P4,P5,P6,P7"
eq A3 "resolver AB_12: sai ambíguo (3) em vez de único" "$(resolver 'AB_12')" "ambiguo:3"
eq A4 "buscar [''] casa todo produto ativo (as 2 contas)" "$(buscar "ARRAY['']")" "8:P1,P2,P3,P4,P5,P6,P7,Q1"
eq A5 "melhoria %%%: passa no piso de 3 caracteres e casa 5 produtos arbitrários" "$(melhoria melhoria_clientes_por_produto '%%%' | cut -d: -f1)" "5"
eq A6 "matcher com target vazio: inventa menção" "$(matcher 00000000-0000-4000-8000-0000000000e1)" "MENCAO:Verniz AB-12"
eq A7 "matcher com target AB_12: casa AB-12" "$(Pq -c "SELECT CASE WHEN motivo LIKE 'Mencionou%' THEN 'MENCAO:' || (matched_payload->>'value') ELSE 'SEM_MENCAO' END FROM public.tarefa_satisfacao_candidatos WHERE tarefa_id = '00000000-0000-4000-8000-0000000000e2';" 2>&1 || true)" "MENCAO:Verniz AB-12"
eq A8 "sessão UTC: pedido das 22:00 SP sem order_date_kpi sai com ultima_compra do dia seguinte" "$(fuso)" "DIA_SEGUINTE"
P -q -c "DELETE FROM public.tarefa_eventos; DELETE FROM public.tarefa_satisfacao_candidatos;"

# ══════════════════════════════════════════════════════════════════════════════
# M — a migration em transação única (-1), como o db:aplicar. Partida: os predecessores de prod.
# ══════════════════════════════════════════════════════════════════════════════
echo "── M: a migration sob o executor ──"
MIG_EFETIVA="$MIG"
case "$SABOTAGEM" in
  pre_sem_trava|pre_aceita_qualquer|pre_ausente_segue|pre_config_nao_confere|pos_sem_acl|pos_sem_md5|pos_sem_degenerado|pos_sem_escape)
    MIG_EFETIVA="$TMPD/mig_sabotada.sql"
    py migration "$MIG" "$SABOTAGEM" "$MIG_EFETIVA" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac
aplicar() { P -1 -q -f "$1" 2>&1; }
variante() {   # <nome> → caminho da cópia da migration efetiva com a variante
  local v="$TMPD/var_$1.sql"
  py migration "$MIG_EFETIVA" "$1" "$v" || { echo "INFRA: variante $1 não montada"; exit 1; }
  printf '%s' "$v"
}
# O veredito de um apply que TEM de ser recusado: o exit do psql decide se recusou; a mensagem, POR
# QUEM. Apply que passou é APLICOU (FALHOU no eq); recusa pelo motivo errado é RECUSOU_POR_OUTRO —
# um NOTICE com o mesmo texto não conta, porque um apply que passou não chega a olhar a mensagem.
veredito() {   # <arquivo> <texto esperado na recusa>
  local saida
  if saida="$(aplicar "$1")"; then printf 'APLICOU'; return 0; fi
  case "$saida" in
    *"$2"*) printf 'RECUSOU' ;;
    *)      printf 'RECUSOU_POR_OUTRO %s' "$(printf '%s' "$saida" | grep -E 'FALHOU|ERRO|ERROR' | head -1 | tr -d ':' | head -c 150)" ;;
  esac
}

# M1 — corpo ESTRANHO (outra mudança chegou antes): a PRE recusa e o estranho fica inteiro.
recriar "$SNAP" "public.listar_skus_por_codigo_fornecedor(" estranho_listar || { echo "INFRA: corpo estranho não montado"; exit 1; }
retrato_estranho="$(retrato)"
[ "$retrato_estranho" != "$retrato_pred" ] || { echo "INFRA: o corpo estranho não é estranho"; exit 1; }
eq M1a "corpo estranho em listar_skus: a PRE recusa" "$(veredito "$MIG_EFETIVA" 'PRE FALHOU: o corpo vivo de public.listar_skus_por_codigo_fornecedor(text,text)')" "RECUSOU"
eq M1b "corpo estranho preservado, e nada mais mudou (retrato integral)" "$(retrato)" "$retrato_estranho"
restaurar_predecessores

# M2 — função AUSENTE: a PRE aborta e nada nasce (nem a função, nem o helper).
P -q -c "DROP FUNCTION public.tarefas_matcher_tick();"
v="$(veredito "$MIG_EFETIVA" 'PRE FALHOU: public.tarefas_matcher_tick() ausente')"
eq M2 "matcher ausente: a PRE aborta e nada é criado (veredito|matcher|helper)" \
   "$v|$(Pq -c "SELECT (to_regprocedure('public.tarefas_matcher_tick()') IS NOT NULL) || '|' || (to_regprocedure('private.padrao_like_contem(text)') IS NOT NULL);" 2>&1 || true)" \
   "RECUSOU|false|false"
restaurar_predecessores

# M3 — a trava tem de ser no-op: com a config de melhoria_produtos diferente da esperada, o ALTER da
# trava a mudaria em silêncio. A PRE recusa, e a config diferente fica como estava.
P -q -c "ALTER FUNCTION public.melhoria_produtos_relacionados(text) SET search_path = public, pg_temp;"
v="$(veredito "$MIG_EFETIVA" 'PRE FALHOU: a config de public.melhoria_produtos_relacionados(text)')"
eq M3 "trava não-no-op: a PRE recusa e a config fica (veredito|config)" \
   "$v|$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.melhoria_produtos_relacionados(text)');" 2>&1 || true)" \
   "RECUSOU|search_path=public, pg_temp"
restaurar_predecessores

# M4 — DROP+CREATE no caminho reseta o ACL: a fechada abre para anon. A POS12 pega, e a transação
# desfaz TUDO (o DROP, os 7 CREATE e o helper).
eq M4a "DROP+CREATE de melhoria_produtos: a POS12 reprova" "$(veredito "$(variante var_drop_create)" 'POS12 FALHOU: o ACL de public.melhoria_produtos_relacionados(text)')" "RECUSOU"
eq M4b "POS reprovada desfaz tudo (retrato integral = predecessores)" "$(retrato)" "$retrato_pred"
[ "$(retrato)" = "$retrato_pred" ] || restaurar_predecessores

# M5 — a PRE TRAVA a linha antes de ler o corpo. Duas conexões, ordem OBSERVADA (desenho da
# 20260927195430): C segura uma trava de liberação (advisory de sessão); A roda a PRE numa transação
# aberta, sinaliza com um advisory de TRANSAÇÃO e fica preso na trava de C; B só é lançado quando vê
# o sinal de A e tenta recriar o matcher com lock_timeout. lock_not_available prova que esperou.
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
    ( P -q -c "SELECT pg_advisory_lock(525253); SELECT pg_sleep(600);" ) > "$TMPD/m5-c.log" 2>&1 &
    m5_c=$!
    m5_a=""
    barreira=0
    if esperar_advisory 525253; then
      ( P -q <<SQL
BEGIN;
$pre_sql
SELECT pg_advisory_xact_lock(525252);
SELECT pg_advisory_xact_lock(525253);
ROLLBACK;
SQL
      ) > "$TMPD/m5-a.log" 2>&1 &
      m5_a=$!
      esperar_advisory 525252 && barreira=1
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
      r5="$(tentar "CREATE OR REPLACE FUNCTION public.tarefas_matcher_tick() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$f\$ BEGIN RETURN; END \$f\$")"
      r5c="$(tentar "CREATE OR REPLACE FUNCTION public.m5_controle(uuid) RETURNS int LANGUAGE sql AS 'SELECT 2'")"
      if [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 525252 AND granted;")" != 1 ]; then
        r5="A SAIU DA TRANSACAO ANTES DO FIM DE B: $r5"; r5c="$r5"
      fi
    else
      r5="BARREIRA NAO OBSERVADA: $(head -c 200 "$TMPD/m5-a.log" 2>/dev/null) $(head -c 200 "$TMPD/m5-c.log")"; r5c="$r5"
    fi
    Pq -c "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid IN (525252, 525253) AND granted;" >/dev/null 2>&1 || true
    wait "$m5_c" 2>/dev/null || true
    if [ -n "$m5_a" ]; then wait "$m5_a" 2>/dev/null || true; fi
    P -q -c "DROP FUNCTION public.m5_controle(uuid);"
    case "$r5" in
      *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M5 "sem corrida válida: [$(curto "$r5")]" ;;
      *M5_RESULTADO=BLOQUEADO*)    ok M5 "a PRE trava a linha: um CREATE OR REPLACE concorrente espera" ;;
      *M5_RESULTADO=NAO_BLOQUEOU*) bad M5 "a PRE NÃO trava: outro aplicador recriou a função durante a PRE" ;;
      *)                           erro_exec M5 "sem veredito: [$(curto "$r5")]" ;;
    esac
    case "$r5c" in
      *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M5c "sem corrida válida: [$(curto "$r5c")]" ;;
      *M5_RESULTADO=NAO_BLOQUEOU*) ok M5c "controle: recriar OUTRA função durante a PRE não espera" ;;
      *M5_RESULTADO=BLOQUEADO*)    bad M5c "a PRE trava mais que as linhas das próprias funções" ;;
      *)                           erro_exec M5c "sem veredito: [$(curto "$r5c")]" ;;
    esac ;;
  *) erro_exec M5 "PRE não extraída de $(basename "$MIG_EFETIVA")"
     erro_exec M5c "PRE não extraída" ;;
esac
[ "$(retrato)" = "$retrato_pred" ] || { echo "INFRA: a corrida do M5 deixou rastro [$(retrato)]"; exit 1; }

# M6 — o apply de verdade, sobre os predecessores: os 7 corpos passam a ser os da migration, e a
# config e o ACL continuam os de antes.
cfg_acl_pred="$(cfg_acl)"
saida="$(aplicar "$MIG_EFETIVA")" || { printf '%s\n' "$saida"; echo "INFRA: a migration NÃO aplicou sobre os predecessores"; exit 1; }
echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"
eq M6 "apply: corpos = os da migration | config e ACL = os de antes | helper" \
   "$(md5s)|$(cfg_acl)|$(Pq -c "SELECT to_regprocedure('private.padrao_like_contem(text)') IS NOT NULL;")" \
   "$MD5_NOVO|$cfg_acl_pred|t"
# M7 — re-aplicar é seguro: a PRE aceita o próprio corpo e nada muda.
retrato_novo="$(retrato)"
if saida="$(aplicar "$MIG_EFETIVA")"; then v="$(retrato)"; else v="ERRO: $(curto "$saida")"; fi
eq M7 "re-aplicação: a PRE aceita o próprio corpo e o retrato não muda" "$v" "$retrato_novo"

# M8-M10 — o dente da POS contra a migration EDITADA: corpo mudado sem o md5, helper sem o termo
# degenerado, helper sem escape. Cada uma tem de ser recusada pela linha certa, e nada fica.
# Sem sabotagem cada uma é recusada e nada fica; sob sabotagem da POS a variante commita, e é desfeita
# ANTES da próxima — senão a PRE da seguinte recusaria pelo corpo que a anterior deixou.
eq M8 "corpo editado sem atualizar o md5: a POS10 recusa" "$(veredito "$(variante var_corpo_editado)" 'POS10 FALHOU: o corpo instalado de public.listar_skus_por_codigo_fornecedor(text,text)')" "RECUSOU"
[ "$(retrato)" = "$retrato_novo" ] || restaurar_novo
eq M9 "helper sem o termo degenerado: a POS3 recusa" "$(veredito "$(variante var_helper_degenerado)" 'POS3 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_novo" ] || restaurar_novo
eq M10 "helper sem escape: a POS4/POS5 recusa" "$(veredito "$(variante var_helper_escape)" 'POS4 FALHOU')" "RECUSOU"
[ "$(retrato)" = "$retrato_novo" ] || restaurar_novo

# ── SABOTAGEM DE CORPO (só no --falsificar) — no BANCO, recriando a função a partir da migration
# com o trecho trocado; o repo nunca é tocado.
case "$SABOTAGEM" in
  helper_sem_escape|helper_sem_degenerado|listar_cru|expandir_inline_cru|resolver_cru|buscar_cadeia|melhoria_clientes_cru|melhoria_produtos_cru|matcher_cru|melhoria_sem_gate|melhoria_fuso_utc)
    tmp="$TMPD/sab.sql"
    py sabotar_corpo "$MIG" "$SABOTAGEM" "$tmp" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    P -q -f "$tmp" >/dev/null || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# H — o helper.
# ══════════════════════════════════════════════════════════════════════════════
echo "── H: private.padrao_like_contem ──"
eq H1 "termo sem conteúdo útil → NULL (nulo, vazio, espaços, tab/quebra, só curinga)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE private.padrao_like_contem(t) IS NULL) || '/' || count(*) FROM unnest(ARRAY[NULL, '', '   ', E'\\t\\n ', '%', '_', '%%%', ' %_ ']::text[]) AS t;" 2>&1 || true)" "8/8"
eq H2 "escape exato: \\ antes, depois % e _" "$(Pq -c "SELECT private.padrao_like_contem('a_b%c\\d');" 2>&1 || true)" '%a\_b\%c\\d%'
# Propriedade: todo termo com conteúdo casa A SI MESMO, por LIKE e ILIKE, dentro de um texto maior.
# Corpus fixo de casos-limite + 300 strings aleatórias (semente fixa) sobre um alfabeto com os 3
# metacaracteres. O piso de 250 não-degenerados impede o verde por vacuidade.
# O universo é o termo útil pela SPEC (o critério do helper, calculado aqui), não o `p IS NOT NULL`:
# um termo útil que o helper passe a anular CONTA como violação (LIKE NULL → IS NOT TRUE) em vez de
# sair da conta — com o recorte pelo `p`, anular só os termos de barra ficava verde.
eq H3 "auto-casamento: todo termo útil casa o próprio texto (LIKE e ILIKE)" "$(Pq <<'SQL' 2>&1 || true
DO $semente$ BEGIN PERFORM setseed(0.42); END $semente$;
WITH corpus AS (
  SELECT unnest(ARRAY['AB_12', '70%', 'C\D', '%_\', '\%', '__x', 'ação_ç%', 'x', ' a b ', 'o''brien', '%%a%%', '\\', '_\_', 'a\', '\_']) AS s
  UNION ALL
  SELECT string_agg(substr('ab%_\ Xy', 1 + floor(random() * 8)::int, 1), '') FROM generate_series(1, 300) g, generate_series(1, 12) k GROUP BY g
), j AS (
  SELECT s, private.padrao_like_contem(s) AS p, btrim(translate(s, '%_', ''), E' \t\r\n') <> '' AS util FROM corpus
)
SELECT CASE WHEN count(*) FILTER (WHERE util) < 250 THEN 'VACUO:' || count(*) FILTER (WHERE util)
            ELSE (count(*) FILTER (WHERE util AND (('<' || s || '>') LIKE p ESCAPE '\' AND ('<' || upper(s) || '>') ILIKE p ESCAPE '\') IS NOT TRUE))::text END
  FROM j;
SQL
)" "0"
eq H4 "o curinga do termo não é interpretado (7 pares que casariam com curinga vivo)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE txt ILIKE private.padrao_like_contem(termo) ESCAPE '\\') || '/' || count(*) FROM (VALUES ('AB_12','ABX12'), ('70%','70 LITROS'), ('C\\D','CD'), ('a%b','aXXb'), ('a_b','a_c'), ('%a','ba'), ('\\%','\\x')) v(termo, txt);" 2>&1 || true)" "0/7"
eq H5 "IMMUTABLE STRICT INVOKER, search_path vazio, EXECUTE para anon/authenticated/service_role" \
   "$(Pq -c "SELECT p.provolatile::text || ':' || p.proisstrict || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ';') || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private.padrao_like_contem(text)');" 2>&1 || true)" \
   'i:true:false:search_path="":truetruetrue'

# ══════════════════════════════════════════════════════════════════════════════
# F — as 7 funções depois do fix.
# ══════════════════════════════════════════════════════════════════════════════
echo "── F: as funções ──"
eq F1 "listar AB_12: só o literal" "$(listar 'AB_12')" "1:P1"
eq F2 "listar %: termo degenerado não casa nada" "$(listar '%')" "0:-"
eq F3 "listar 70%: o % é literal" "$(listar '70%')" "1:P5"
eq F4 "listar verniz: o literal sem curinga casa como antes (caixa ignorada)" "$(listar 'verniz')" "3:P1,P2,P3"
eq F5 "listar C\\D: a barra é literal" "$(listar 'C\D')" "1:P7"
eq F6 "listar _12: o _ é literal" "$(listar '_12')" "2:P1,P4"
eq F7 "resolver AB_12: único, o SKU certo" "$(resolver 'AB_12')" "unico:1001"
eq F8 "resolver %: não encontrado" "$(resolver '%')" "nao_encontrado:-"
eq F9 "resolver verniz: ambíguo como antes" "$(resolver 'verniz')" "ambiguo:3"
# expandir_promocao_item (overload bigint,numeric; o de 1 argumento é AMBÍGUO em prod — 42725 — e
# fica fora). Ele cita similarity() sem qualificar, e o pg_trgm mora em `extensions`: o parse quebra
# com 42883 o ramo de 0 variantes E o laço de ≥2 (o CASE do laço cita a função na mesma consulta) —
# achado lateral, fora desta classe; em prod só o caminho "único" roda. Para medir o LIKE, cada
# chamada roda numa transação com um public.similarity que delega a extensions.similarity (o conserto
# do lateral SIMULADO) e é DESFEITA no ROLLBACK. Sem isso, a sabotagem que muda a contagem (o curinga
# vivo) levaria o assert ao 42883 — erro de execução, não resultado — e o assert perderia o dente.
expandir_tx() {   # <item_id> <consulta do estado, na mesma transação> → status|estado
  Pq 2>&1 <<SQL | paste -sd'|' - || true
BEGIN;
CREATE FUNCTION public.similarity(text, text) RETURNS real LANGUAGE sql IMMUTABLE AS 'SELECT extensions.similarity(\$1, \$2)';
SELECT r->>'status' FROM public.expandir_promocao_item(p_item_id => $1, p_threshold_similaridade => 0.5) r;
$2
ROLLBACK;
SQL
}
variantes() { printf "SELECT COALESCE(string_agg(sku_codigo_omie::text, ',' ORDER BY sku_codigo_omie), '-') FROM public.promocao_item WHERE campanha_id = 9001 AND sku_codigo_fornecedor = '%s' AND id <> %s;" "$1" "$2"; }
eq F10 "expandir AB_12: resolve único no SKU literal e confirma (status|qualidade|sku|confirmado)" \
   "$(expandir_tx 91001 "SELECT mapeamento_qualidade || '|' || sku_codigo_omie || '|' || confirmado FROM public.promocao_item WHERE id = 91001;")" \
   "resolvido_unico|unico|1001|true"
eq F11 "expandir _12: expande só nas 2 variantes literais (status|skus criados)" \
   "$(expandir_tx 91002 "$(variantes _12 91002)")" "expandido|1001,1004"
# O degenerado não resolve nem expande: cai no ramo de similaridade, que com '%' não passa do limiar.
eq F12 "expandir %: o degenerado não resolve nem expande (status|veredito)" \
   "$(expandir_tx 91003 "SELECT CASE WHEN COALESCE(mapeamento_qualidade, 'nao_encontrado') = 'nao_encontrado' AND sku_codigo_omie IS NULL AND (SELECT count(*) FROM public.promocao_item WHERE campanha_id = 9001 AND sku_codigo_fornecedor = '%') = 1 THEN 'NAO_EXPANDIU' ELSE 'EXPANDIU:' || COALESCE(mapeamento_qualidade, '-') || ':' || COALESCE(sku_codigo_omie::text, '-') END FROM public.promocao_item WHERE id = 91003;")" \
   "nao_encontrado|NAO_EXPANDIU"
eq F13 "expandir VERNIZ: o literal com 3 variantes expande como antes" \
   "$(expandir_tx 91004 "$(variantes VERNIZ 91004)")" "expandido|1001,1002,1003"
eq F14 "buscar ['']: nada" "$(buscar "ARRAY['']")" "0:-"
eq F15 "buscar ['  ','%','_']: nada" "$(buscar "ARRAY['  ', '%', '_']")" "0:-"
eq F16 "buscar ['ab_12']: só o literal, nas 2 contas" "$(buscar "ARRAY['ab_12']")" "2:P1,Q1"
eq F17 "buscar ['verniz','alcool']: o literal como antes" "$(buscar "ARRAY['verniz', 'alcool']")" "6:P1,P2,P3,P5,P6,Q1"
eq F18 "melhoria_clientes %%%: nenhum produto casado" "$(melhoria melhoria_clientes_por_produto '%%%')" "0:-"
eq F19 "melhoria_clientes AB_12: só o literal" "$(melhoria melhoria_clientes_por_produto 'AB_12')" "2:P1,Q1"
eq F20 "melhoria_produtos %%%: nenhum produto casado" "$(melhoria melhoria_produtos_relacionados '%%%')" "0:-"
eq F21 "melhoria_produtos AB_12: só o literal" "$(melhoria melhoria_produtos_relacionados 'AB_12')" "2:P1,Q1"
f22="$(P -q 2>&1 <<SQL || true
SET test.uid = '$N';
DO \$f22\$ BEGIN
  BEGIN
    PERFORM public.melhoria_clientes_por_produto('verniz');
    RAISE NOTICE 'F22_VEREDITO=SEM_GATE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'Apenas staff pode consultar' THEN RAISE NOTICE 'F22_VEREDITO=BARRADO'; ELSE RAISE; END IF;
  END;
END \$f22\$;
SQL
)"
case "$f22" in
  *F22_VEREDITO=BARRADO*)  ok F22 "o gate de staff continua: não-staff é barrado" ;;
  *F22_VEREDITO=SEM_GATE*) bad F22 "não-staff consultou clientes por produto" ;;
  *)                       erro_exec F22 "sem veredito: [$(curto "$f22")]" ;;
esac
eq F23 "matcher com target vazio: não inventa menção" "$(matcher 00000000-0000-4000-8000-0000000000e1)" "SEM_MENCAO"
eq F24 "matcher AB_12 contra 'Verniz AB-12': o _ é literal" "$(Pq -c "SELECT CASE WHEN motivo LIKE 'Mencionou%' THEN 'MENCAO:' || (matched_payload->>'value') ELSE 'SEM_MENCAO' END FROM public.tarefa_satisfacao_candidatos WHERE tarefa_id = '00000000-0000-4000-8000-0000000000e2';" 2>&1 || true)" "SEM_MENCAO"
eq F25 "matcher ab_12 contra 'VERNIZ AB_12 BRILHO': o literal casa" "$(Pq -c "SELECT CASE WHEN motivo LIKE 'Mencionou%' THEN 'MENCAO:' || (matched_payload->>'value') ELSE 'SEM_MENCAO' END FROM public.tarefa_satisfacao_candidatos WHERE tarefa_id = '00000000-0000-4000-8000-0000000000e3';" 2>&1 || true)" "MENCAO:VERNIZ AB_12 BRILHO"
eq F26 "melhoria_clientes sob sessão UTC: ultima_compra é a data de SP (trocas de fuso da sessão irmã)" "$(fuso)" "DATA_SP"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executados $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO — prova truncada não é verde"
  exit 1
fi
[ "$FAIL" -eq 0 ]
