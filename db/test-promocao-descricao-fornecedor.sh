#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  test-promocao-descricao-fornecedor.sh — prova PG17 da 20261010224755:        ║
# ║  descricao_produto_fornecedor guarda o que o FORNECEDOR ofertou. Nem a        ║
# ║  expansão nem o converter a trocam pela descrição do SKU, e o backfill só     ║
# ║  devolve o original onde ele é PROVADO pelo banco (manifesto de 12 filhas).   ║
# ║                                                                                ║
# ║  C  controle: os predecessores são os corpos de PROD (md5 exato) e a réplica  ║
# ║     da campanha 1 (bytes de prod) satisfaz as provas do manifesto.            ║
# ║  A  anti-vacuidade: nos predecessores o defeito REPRODUZ (filha com a         ║
# ║     descrição do SKU, NULL preenchido pelo SKU, converter com a do SKU).      ║
# ║  M  a migration como o executor a roda (1 transação), cada cenário num CLONE  ║
# ║     do banco-base: a PRE recusa deriva e ausência; o backfill recusa          ║
# ║     manifesto que não vale mais (edição, origem reescrita, observação que não ║
# ║     prova) desfazendo TUDO; a POS pega corpo, atributo, OID/ACL e backfill;   ║
# ║     aplica (só as 12 mudam) e re-aplica sem tocar linha nenhuma.             ║
# ║  F  depois: a chamada do FRONT (authenticated master) e a do converter (staff ║
# ║     e não-staff) — filhas herdam texto e NULL, o ramo único não preenche, o   ║
# ║     converter grava NULL e o gate segue.                                      ║
# ║                                                                                ║
# ║  rode: bash db/test-promocao-descricao-fornecedor.sh > log 2>&1; echo $?      ║
# ║        bash db/test-promocao-descricao-fornecedor.sh --falsificar > log 2>&1  ║
# ║  matriz: HARNESS_LC=C | pt_BR.UTF-8 (lc_messages do servidor; o cliente fica  ║
# ║  em LC_ALL=C e todo assert casa SQLSTATE ou rótulo ASCII da migration).       ║
# ║  Diário: docs/historico/promocao-descricao-fornecedor.md                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5711}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="promocao-descricao-fornecedor"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261010224755_promocao_item_descricao_fornecedor_preservada.sql"
# Os predecessores de PROD (md5 medido por psql-ro em 2026-10-10) vêm das migrations que os criaram:
MIG_EXP="$REPO_ROOT/supabase/migrations/20260930220148_expandir_promocao_item_overload_similarity_volume.sql"
MIG_CONV="$REPO_ROOT/supabase/migrations/20261001083000_converter_campanha_flat_colunas_reais.sql"
MIG_LIKE="$REPO_ROOT/supabase/migrations/20260929000234_padrao_like_contem_escapa_curinga.sql"
# O snapshot é o de 2026-10-09 (re-dump do #2874), lido do histórico: o re-dump seguinte absorverá esta
# migration, e o pré-estado que ela transforma sumiria do snapshot vivo. Sem o histórico (fetch-depth: 0),
# INFRA alto — nunca um snapshot errado em silêncio.
SNAP_COMMIT=990fed2f5
# Denominador: C1-C3 · A1-A3 · M1a M1b M2 M3 M4 M5 M6 M9 Mp1-Mp5 M7a M7b M7c M8 · F1-F8.
# Menos asserts executados é vermelho: FAIL=0 com PASS encolhido é a prova truncada que aprova tudo.
TOTAL_ESPERADO=31

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas as
# sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar vermelhos
# por RESULTADO e os que TÊM de continuar verdes. Vermelho por erro de execução (sabotagem que não
# aplicou, SQL quebrado, saída vazia) NÃO mata mutante e reprova a falsificação.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# As de CORPO são aplicadas no banco DEPOIS do apply (a POS não as veria: o vermelho tem de vir do
# assert de comportamento, não do md5); as de PRE/backfill/POS, numa cópia da migration em tmpdir.
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="laco_desc_sku:F1,F2,F3:F4,F5,F6,F7
              unico_coalesce:F4,F6:F1,F5,F7
              converter_sku_desc:F7:F8,F1
              pre_aceita_qualquer:M1a,M2:M3,M7a
              pre_ausente_segue:M3:M1a,M7a
              backfill_sem_divergencia:M4:M5,M7a
              backfill_sem_prova_origem:M5:M4,M7a
              backfill_sem_prova_obs:M6:M4,M7a
              backfill_regrava_nulo:M8:M7a,M7b
              pos_sem_md5:Mp1:Mp2,M7a
              pos_sem_atributos:Mp2:Mp1,M7a
              pos_sem_oid_acl:Mp3:Mp1,M7a
              pos_sem_backfill:Mp4:Mp1,M7a
              backfill_sem_trava:M9:M4,M7a
              pos_conta_so_texto:Mp5:Mp4,M7a"
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
SAB_APLICADA=0   # cada ramo que reconhece a sabotagem marca 1; a que nenhum ramo reconhece aborta no fim

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SNAP="$TMPD/schema-snapshot-20261009.sql"
git -C "$REPO_ROOT" show "$SNAP_COMMIT:supabase/schema-snapshot.sql" > "$SNAP" 2>/dev/null \
  || { echo "INFRA: snapshot de 2026-10-09 ($SNAP_COMMIT) indisponível — o checkout precisa do histórico (fetch-depth: 0)"; exit 1; }
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
# lc_messages no CLUSTER: o ALTER DATABASE não é copiado para os clones (CREATE DATABASE … TEMPLATE).
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER SYSTEM SET lc_messages = '$HARNESS_LC';" -c "SELECT pg_reload_conf();" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres base
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
Pq() { local db="$1"; shift; Pd "$db" -qtA "$@"; }
clonar() { "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T base "$1"; }

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

# ── Extrator de função e trocas (python, sem interpolação do bash: `\` e `'` chegam intactos) ────
# funcao <arquivo> <prefixo depois de "FUNCTION "> <saida> [<troca>]: o bloco CREATE [OR REPLACE]
#   FUNCTION <prefixo>… até a tag de dollar que fecha o corpo. Com <troca>, cada padrão dela tem de
#   ocorrer EXATAMENTE n× no bloco (troca que não pegou deixaria verde).
# migration <arquivo> <troca> <saida>: o arquivo inteiro com as trocas (sabotagem ou variante).
PY_TROCAS="$TMPD/trocas.py"
cat > "$PY_TROCAS" <<'PY'
import re, sys
E = "public.expandir_promocao_item(p_item_id bigint, p_threshold"
C = "public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint"
TROCAS = {
  # ── corpo (no banco, depois do apply) ──
  "laco_desc_sku": (E, [(
    "      v_item.campanha_id, v_item.sku_codigo_fornecedor, v_item.descricao_produto_fornecedor,\n",
    "      v_item.campanha_id, v_item.sku_codigo_fornecedor, v_variante.descricao,\n", 1)]),
  "unico_coalesce": (E, [(
    "        -- descricao_produto_fornecedor fica como o fornecedor ofertou (NULL inclusive): o SKU se lê pelo código\n",
    "        descricao_produto_fornecedor = COALESCE(descricao_produto_fornecedor, v_variante.descricao),\n", 1)]),
  "converter_sku_desc": (C, [
    ("    campanha_id, sku_codigo_fornecedor, sku_codigo_omie,\n",
     "    campanha_id, sku_codigo_fornecedor, descricao_produto_fornecedor, sku_codigo_omie,\n", 1),
    ("    v_campanha_id, v_codigo, v_sugestao.sku_codigo_omie::bigint,\n",
     "    v_campanha_id, v_codigo, v_sugestao.sku_descricao, v_sugestao.sku_codigo_omie::bigint,\n", 1)]),
  # ── PRE / backfill / POS (na cópia da migration inteira) ──
  "pre_aceita_qualquer": (None, [("    IF r.vivo NOT IN (r.predecessor, r.este) THEN\n", "    IF false THEN\n", 1)]),
  "pre_ausente_segue": (None, [(
    "      RAISE EXCEPTION 'PRE FALHOU: % ausente — a migration parte do corpo de prod', r.alvo;\n",
    "      CONTINUE;\n", 1)]),
  "backfill_sem_divergencia": (None, [
    ("      RAISE EXCEPTION 'BACKFILL FALHOU: a filha % não tem mais a descrição do manifesto — alguém a editou; reconcilie antes', r.filha;\n",
     "      NULL;\n", 1),
    ("     WHERE id = r.filha AND descricao_produto_fornecedor = r.antes;\n", "     WHERE id = r.filha;\n", 1)]),
  "backfill_sem_prova_origem": (None, [(
    "    IF r.o_descricao IS NOT NULL OR r.o_atualizado_em IS DISTINCT FROM r.f_criado_em THEN\n",
    "    IF false THEN\n", 1)]),
  "backfill_sem_prova_obs": (None, [(
    "                IN coalesce(r.f_observacoes, '')) = 0 THEN\n",
    "                IN coalesce(r.f_observacoes, '')) = 0 AND false THEN\n", 1)]),
  "backfill_regrava_nulo": (None, [(
    "    IF r.f_descricao IS NULL THEN\n      CONTINUE;\n    END IF;\n",
    "    IF r.f_descricao IS NULL THEN\n      UPDATE public.promocao_item SET descricao_produto_fornecedor = NULL WHERE id = r.filha;\n      CONTINUE;\n    END IF;\n", 1)]),
  "backfill_sem_trava": (None, [(
    "  PERFORM 1 FROM public.promocao_item\n   WHERE id IN (1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)\n   ORDER BY id\n     FOR UPDATE;\n",
    "", 1)]),
  "pos_conta_so_texto": (None, [(
    "  IF n IS DISTINCT FROM 12 OR n_original IS DISTINCT FROM 12 THEN\n",
    "  IF n - n_original IS DISTINCT FROM 0 THEN\n", 1)]),
  "pos_sem_md5": (None, [("      RAISE EXCEPTION 'POS1 FALHOU", "      RAISE NOTICE 'POS1 FALHOU", 1)]),
  "pos_sem_atributos": (None, [("      RAISE EXCEPTION 'POS2 FALHOU", "      RAISE NOTICE 'POS2 FALHOU", 1)]),
  "pos_sem_oid_acl": (None, [("      RAISE EXCEPTION 'POS3 FALHOU", "      RAISE NOTICE 'POS3 FALHOU", 1)]),
  "pos_sem_backfill": (None, [("    RAISE EXCEPTION 'POS4 FALHOU", "    RAISE NOTICE 'POS4 FALHOU", 1)]),
  # ── variantes que o bloco M aplica (o dente de cada camada da POS, não sabotagens) ──
  "var_corpo_editado": (None, [("  v_candidatos jsonb := '[]'::jsonb;\n", "  v_candidatos jsonb := '[]'::jsonb; \n", 1)]),
  "var_secdef": (None, [(" LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\n",
                         " LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\n", 1)]),
  "var_drop_create": (None, [(
    "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)",
    "DROP FUNCTION public.expandir_promocao_item(bigint, numeric);\nCREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)", 1)]),
  "var_sem_checagem_ausencia": (None, [(
    "      RAISE EXCEPTION 'BACKFILL FALHOU: a filha % ou a origem % não existe', r.filha, r.origem;\n",
    "      CONTINUE;\n", 1)]),
  "var_sem_backfill": (None, [(
    "    UPDATE public.promocao_item\n       SET descricao_produto_fornecedor = r.o_descricao\n",
    "    PERFORM 1;\n    UPDATE public.promocao_item\n       SET descricao_produto_fornecedor = descricao_produto_fornecedor\n", 1)]),
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
        if alvo is None or not prefixo.startswith(alvo):
            print("   troca %s é de %s, não de %s" % (sys.argv[5], alvo, prefixo), file=sys.stderr); sys.exit(1)
        bloco = trocar(bloco, trocas)
    open(saida, "w", encoding="utf-8").write(bloco)
elif modo == "migration":
    arq, nome, saida = sys.argv[2], sys.argv[3], sys.argv[4]
    alvo, trocas = TROCAS[nome]
    open(saida, "w", encoding="utf-8").write(trocar(open(arq, encoding="utf-8").read(), trocas))
PY
py() { python3 "$PY_TROCAS" "$@"; }
recriar() {   # <db> <arquivo> <prefixo> [<troca>]
  local tmp; tmp="$(mktemp "$TMPD/fn.XXXXXX")"
  py funcao "$2" "$3" "$tmp" ${4:+"$4"} || return 9
  Pd "$1" -q -f "$tmp" >/dev/null || return 9
  rm -f "$tmp"
}

echo "═══ PG17 :$PORT, lc_messages=$HARNESS_LC ═══"

# ══════════════════════════════════════════════════════════════════════════════
# BASE — schema de prod (stubs + prelude + snapshot numa transação), os corpos de PROD das 2 funções
# e das 2 dependências da expansão, o ACL medido, e as sementes. Cada cenário roda num clone dela.
# ══════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
Pd base -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
Pd base -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
Pd base -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
Pd base --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
recriar base "$MIG_LIKE" "private.padrao_like_contem(" || { echo "INFRA: helper de prod não aplicado"; exit 1; }
recriar base "$MIG_LIKE" "public.listar_skus_por_codigo_fornecedor(" || { echo "INFRA: listar_skus de prod não aplicado"; exit 1; }
recriar base "$MIG_EXP" "public.expandir_promocao_item(p_item_id bigint, p_threshold" || { echo "INFRA: expandir de prod não aplicado"; exit 1; }
recriar base "$MIG_CONV" "public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint" || { echo "INFRA: converter de prod não aplicado"; exit 1; }

# O ACL de PROD (psql-ro, 2026-10-10) nos objetos tocados: o snapshot vem sem privilégios. A
# expansão é INVOKER (o front chama como authenticated): EXECUTE de fábrica (PUBLIC) + os papéis; o
# converter é DEFINER com PUBLIC/anon fechados. USAGE na sequência: o INSERT das filhas chama nextval
# como o CHAMADOR.
Pd base -q <<'SQL'
GRANT USAGE ON SCHEMA public, private, extensions, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.padrao_like_contem(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_skus_por_codigo_fornecedor(text,text) TO anon, authenticated, service_role;
GRANT SELECT ON public.omie_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promocao_item, public.promocao_campanha, public.user_roles TO anon, authenticated;
GRANT USAGE ON SEQUENCE public.promocao_item_id_seq TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expandir_promocao_item(bigint,numeric) TO anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text) TO authenticated, service_role;
SQL

# ── SEMENTES (postgres, gatilhos desligados) ────────────────────────────────────────────────────
# Campanha 1 = RÉPLICA BYTE A BYTE da prod (psql-ro, 2026-10-10): as 6 origens, o 'unico' 5 e as 12
# filhas do manifesto, com códigos, observações e carimbos; mais as iscas que o backfill NÃO pode
# tocar: as filhas ad-hoc da campanha 23 (138, 139, 143) e a origem dela (129), o 'unico' 133 e
# os 'manual_confirmado' 151/156 da 24. Campanhas 101-103: os cenários F (contas emp_like/emp_sim*).
# Itens criados pelas funções saem da sequência a partir de 5000 (acima de toda semente).
M=00000000-0000-4000-8000-00000000000a   # master
E=00000000-0000-4000-8000-00000000000e   # employee (staff do converter)
N=00000000-0000-4000-8000-00000000000b   # autenticado sem papel
Pd base -q >/dev/null <<SQL
SET session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('$M'), ('$E'), ('$N');
INSERT INTO public.user_roles (user_id, role) VALUES ('$M', 'master'), ('$E', 'employee');
INSERT INTO public.omie_products (account, omie_codigo_produto, codigo, descricao, ativo) VALUES
  ('emp_like', 3001, 'L1', 'TINTA ABC123 0,9L', true),
  ('emp_like', 3002, 'L2', 'TINTA ABC123 3,6L', true),
  ('emp_like', 3003, 'L3', 'VERNIZ UNICO77 18L', true),
  ('emp_sim1', 4001, 'S1', 'SELADOR NITRO', true),
  ('emp_sim1', 4002, 'S2', 'VERNIZ PU BRILHO', true),
  ('emp_sim2', 5001, 'T1', 'SELADOR NITRO 0,9L', true),
  ('emp_sim2', 5002, 'T2', 'SELADOR NITRO 3,6L', true),
  ('emp_sim2', 5003, 'T3', 'VERNIZ PU BRILHO', true);
INSERT INTO public.promocao_campanha (id, empresa, fornecedor_nome, nome, tipo_origem, data_inicio, data_fim, estado) VALUES
  (1, 'OBEN', 'RENNER SAYERLACK S/A', 'replica 1', 'fornecedor_impoe', '2026-04-16', '2026-04-30', 'encerrada'),
  (23, 'OBEN', 'RENNER SAYERLACK S/A', 'replica 23', 'fornecedor_impoe', '2026-05-01', '2026-05-15', 'encerrada'),
  (24, 'OBEN', 'RENNER SAYERLACK S/A', 'replica 24', 'fornecedor_impoe', '2026-06-01', '2026-06-30', 'encerrada'),
  (101, 'EMP_LIKE', 'F', 'like', 'outro', current_date, current_date + 30, 'rascunho'),
  (102, 'EMP_SIM1', 'F', 'sim1', 'outro', current_date, current_date + 30, 'rascunho'),
  (103, 'EMP_SIM2', 'F', 'sim2', 'outro', current_date, current_date + 30, 'rascunho');
INSERT INTO public.promocao_item (id, campanha_id, sku_codigo_fornecedor, descricao_produto_fornecedor, sku_codigo_omie,
                                  mapeamento_qualidade, confirmado, ativo, observacoes, desconto_perc, criado_em, atualizado_em,
                                  volume_minimo) VALUES
(1, 1, 'DR.4403', NULL, NULL, 'expandido_origem', false, false, ' [Item original — expandido em 3 variantes]', 20, '2026-04-21 00:45:00.988907+00', '2026-04-21 13:11:38.752157+00', NULL),
(2, 1, 'FL.6269.02', NULL, NULL, 'expandido_origem', false, false, ' [Item original — expandido em 3 variantes]', 7, '2026-04-21 00:45:01.890614+00', '2026-04-21 13:11:38.752157+00', NULL),
(3, 1, 'FL.6264.02', NULL, NULL, 'expandido_origem', false, false, ' [Item original — expandido em 2 variantes]', 7, '2026-04-21 00:45:02.340301+00', '2026-04-21 13:11:38.752157+00', NULL),
(4, 1, 'YLO1.1118.00', NULL, NULL, 'expandido_origem', false, false, ' [Item original — expandido em 2 variantes]', 5, '2026-04-21 00:45:02.765422+00', '2026-04-21 13:17:44.87425+00', NULL),
(5, 1, 'YLO4.1367.00', 'F ACAB BA SEMI FOSCO YLO4.1367.00QT', 8689876803, 'unico', true, true, NULL, 5, '2026-04-21 00:45:03.181167+00', '2026-04-21 13:11:38.752157+00', NULL),
(6, 1, 'YL.5591.NTR', NULL, NULL, 'expandido_origem', false, false, ' [Item original — expandido em 2 variantes]', 7, '2026-04-21 00:45:03.587551+00', '2026-04-21 13:11:38.752157+00', NULL),
(7, 1, 'DR.4403', 'THINNER DR.4403L5', 8689744102, 'expandido_automatico', true, true, ' [Expandido automaticamente do código DR.4403 — variante: THINNER DR.4403L5]', 20, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:40:30.702755+00', NULL),
(8, 1, 'DR.4403', 'THINNER DR.4403LT', 8689717792, 'expandido_automatico', true, true, ' [Expandido automaticamente do código DR.4403 — variante: THINNER DR.4403LT]', 20, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:40:30.702755+00', NULL),
(9, 1, 'DR.4403', 'THINNER DR.4403QT', 8689723623, 'expandido_automatico', true, true, ' [Expandido automaticamente do código DR.4403 — variante: THINNER DR.4403QT]', 20, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:40:30.702755+00', NULL),
(10, 1, 'FL.6269.02', 'PRIMER PU BRANCO FL.6269.02BD', 8689739288, 'expandido_automatico', true, true, ' [Expandido automaticamente do código FL.6269.02 — variante: PRIMER PU BRANCO FL.6269.02BD]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(11, 1, 'FL.6269.02', 'PRIMER PU BRANCO FL.6269.02GL', 8689723498, 'expandido_automatico', true, true, ' [Expandido automaticamente do código FL.6269.02 — variante: PRIMER PU BRANCO FL.6269.02GL]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(12, 1, 'FL.6269.02', 'PRIMER PU BRANCO FL.6269.02QT', 8689783159, 'expandido_automatico', true, true, ' [Expandido automaticamente do código FL.6269.02 — variante: PRIMER PU BRANCO FL.6269.02QT]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(13, 1, 'FL.6264.02', 'PRIMER PU BRANCO FL.6264.02KGBH', 12025181714, 'expandido_automatico', true, true, ' [Expandido automaticamente do código FL.6264.02 — variante: PRIMER PU BRANCO FL.6264.02KGBH]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(14, 1, 'FL.6264.02', 'PRIMER PU BRANCO FL.6264.02QT', 8689748828, 'expandido_automatico', true, true, ' [Expandido automaticamente do código FL.6264.02 — variante: PRIMER PU BRANCO FL.6264.02QT]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(15, 1, 'YL.5591.NTR', 'PRIMER BA NEUTRO YL.5591.NTRBP', 12042877852, 'expandido_automatico', true, true, ' [Expandido automaticamente do código YL.5591.NTR — variante: PRIMER BA NEUTRO YL.5591.NTRBP]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(16, 1, 'YL.5591.NTR', 'PRIMER BA NEUTRO YL.5591.NTRGL', 12042877848, 'expandido_automatico', true, true, ' [Expandido automaticamente do código YL.5591.NTR — variante: PRIMER BA NEUTRO YL.5591.NTRGL]', 7, '2026-04-21 13:11:38.752157+00', '2026-04-21 13:11:38.752157+00', NULL),
(17, 1, 'YLO1.1118.00', 'F ACAB BASE AGUA YLO1.1118.00GL', 8689724296, 'expandido_automatico', true, true, ' [Expandido automaticamente do código YLO1.1118.00 — variante: F ACAB BASE AGUA YLO1.1118.00GL]', 5, '2026-04-21 13:17:44.87425+00', '2026-04-21 13:17:44.87425+00', NULL),
(18, 1, 'YLO1.1118.00', 'F ACAB BASE AGUA YLO1.1118.00QT', 8689718356, 'expandido_automatico', true, true, ' [Expandido automaticamente do código YLO1.1118.00 — variante: F ACAB BASE AGUA YLO1.1118.00QT]', 5, '2026-04-21 13:17:44.87425+00', '2026-04-21 13:17:44.87425+00', NULL),
(129, 23, 'DR.4403', NULL, NULL, 'expandido_origem', true, false, NULL, 20, '2026-05-13 00:44:01.000000+00', '2026-05-15 01:06:17.000000+00', NULL),
(133, 23, 'DN.4290', 'DILUENTE DN.4290QT', 8690115075, 'unico', true, true, NULL, 5, '2026-05-13 00:44:02.597191+00', '2026-05-13 01:00:57.989206+00', NULL),
(138, 23, 'DR.4403L5', 'THINNER DR.4403L5', 8689744102, 'expandido_automatico', true, true, NULL, 20, '2026-05-13 01:00:43.66676+00', '2026-05-13 01:00:43.66676+00', NULL),
(139, 23, 'DR.4403LT', 'THINNER DR.4403LT', 8689717792, 'expandido_automatico', true, true, NULL, 20, '2026-05-13 01:00:43.66676+00', '2026-05-13 01:00:43.66676+00', NULL),
(143, 23, 'FL.6264.02KGBH', 'PRIMER PU BRANCO FL.6264.02KGBH', 12025181714, 'expandido_automatico', true, true, NULL, 7, '2026-05-13 01:00:43.66676+00', '2026-05-13 01:00:43.66676+00', NULL),
(151, 24, 'DR.4403', 'THINNER DR.4403LT', 8689717792, 'manual_confirmado', true, true, NULL, 20, '2026-06-06 13:41:07.614585+00', '2026-06-06 13:41:58.946418+00', NULL),
(156, 24, 'DR.4403#omie8689723623', 'THINNER DR.4403QT', 8689723623, 'manual_confirmado', true, true, 'Expandido manualmente a partir de DR.4403', 20, '2026-06-06 13:41:58.949272+00', '2026-06-06 13:41:58.949272+00', NULL),
(1101, 101, 'UNICO77', NULL, NULL, NULL, false, true, 'obs 1101', 5, now(), now(), NULL),
(1102, 101, 'ABC123', 'ABC123 - OFERTA DO FORNECEDOR', NULL, NULL, false, true, 'obs 1102', 5, now(), now(), NULL),
(1103, 101, 'ABC123', NULL, NULL, NULL, false, true, 'obs 1103', 6, now(), now(), NULL),
(1104, 101, 'UNICO77', 'UNICO77 - VERNIZ DA OFERTA', NULL, NULL, false, true, 'obs 1104', 5, now(), now(), 12),
(2201, 102, 'SELADORA NITRO', NULL, NULL, NULL, false, true, 'obs 2201', 5, now(), now(), NULL),
(3301, 103, 'SELADORA NITRO', 'SELADORA NITRO 0,9 E 3,6 - OFERTA', NULL, NULL, false, true, 'obs 3301', 5, now(), now(), NULL);
INSERT INTO public.sugestao_negociacao_paralela (id, empresa, sku_codigo_omie, sku_descricao, motivo) VALUES
  (1, 'OBEN', '3003', 'VERNIZ UNICO77 18L', 'candidato_forte_sem_promo_recente');
SELECT setval('public.promocao_item_id_seq', 5000, false);
SELECT setval('public.promocao_campanha_id_seq', 5000, false);
SET session_replication_role = origin;
SQL

# ── A chamada, numa transação desfeita no fim ─────────────────────────────────────────────────────
# chamar <db> <uid> <SELECT que devolve 1 valor> <projeção sobre r> <estado lido como postgres>
# O SELECT roda como authenticated com test.uid (RLS e ACL de verdade). Um erro da chamada vira o
# VALOR "SQLSTATE=<código>" (a marca do ramo, invariante ao locale): comparado ao esperado, é
# resultado, não erro de execução. Erro FORA da chamada sai como ERROR do psql (erro de execução).
chamar() {
  Pd "$1" -qtA 2>&1 <<SQL || true
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "test.uid" = '$2';
DO \$c\$
DECLARE r jsonb;
BEGIN
  EXECUTE \$q\$ $3 \$q\$ INTO r;
  PERFORM set_config('t.saida', COALESCE(($4)::text, '<null>'), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('t.saida', 'SQLSTATE=' || SQLSTATE, true);
END
\$c\$;
RESET ROLE;
SELECT current_setting('t.saida') || '|' || ($5);
ROLLBACK;
SQL
}
# A chamada do FRONT: supabase.rpc("expandir_promocao_item", { p_item_id }) — nomeada, sem threshold.
front() { printf '%s' "SELECT public.expandir_promocao_item(\"p_item_id\" := b.p_item_id) FROM json_to_record('{\"p_item_id\": $1}'::json) AS b(p_item_id bigint)"; }
# O converter como o diálogo da Negociação Paralela o chama (o 6º argumento é o código Sayerlack).
conv() { printf '%s' "SELECT to_jsonb(public.converter_sugestao_em_campanha_flat(1, 8, 10, 'unidades', DATE '2999-12-31', 'VZ.0077'))"; }
ST="COALESCE(r->>'status', 'erro:' || (r->>'erro'))"
# descrição de um item, com NULL legível
desc_de() { printf '%s' "(SELECT COALESCE(descricao_produto_fornecedor, '<null>') FROM public.promocao_item WHERE id = $1)"; }
# as filhas que a chamada criou (id >= 5000): sku:qualidade:confirmado:descrição:desconto:volume
filhas() { printf '%s' "(SELECT COALESCE(string_agg(sku_codigo_omie || ':' || mapeamento_qualidade || ':' || confirmado || ':' || COALESCE(descricao_produto_fornecedor, '<null>') || ':' || desconto_perc || ':' || COALESCE(volume_minimo::text, '-'), ',' ORDER BY sku_codigo_omie), '-') FROM public.promocao_item WHERE campanha_id = $1 AND id >= 5000)"; }
# estado de um item: qualidade | confirmado | ativo | sku | descrição
item() { printf '%s' "(SELECT COALESCE(mapeamento_qualidade, '-') || '|' || confirmado || '|' || ativo || '|' || COALESCE(sku_codigo_omie::text, '-') || '|' || COALESCE(descricao_produto_fornecedor, '<null>') FROM public.promocao_item WHERE id = $1)"; }
# o item que o converter criou (o da campanha nova, id >= 5000)
item_conv() { printf '%s' "(SELECT COALESCE(string_agg(pi.sku_codigo_fornecedor || '|' || COALESCE(pi.descricao_produto_fornecedor, '<null>') || '|' || pi.sku_codigo_omie || '|' || pi.mapeamento_qualidade || '|' || pi.desconto_perc || '|' || pi.confirmado || '|' || pi.ativo, ','), '-') FROM public.promocao_item pi WHERE pi.campanha_id >= 5000)"; }

# O retrato do que a migration toca: corpo|config|secdef|OID|ACL das 2 funções e a impressão digital
# de TODA a tabela de itens (id, descrição, qualidade, ativo, atualizado_em).
EXP_SIG='public.expandir_promocao_item(bigint,numeric)'
CONV_SIG='public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)'
funcs() {
  Pq "$1" -c "SELECT string_agg(COALESCE((SELECT md5(p.prosrc) || '|' || COALESCE(array_to_string(p.proconfig, ';'), '') || '|' || p.prosecdef || '|' || p.oid || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(a.f)), 'ausente'), '#' ORDER BY a.o) FROM unnest(ARRAY['$EXP_SIG', '$CONV_SIG']) WITH ORDINALITY AS a(f, o);" 2>&1 || true
}
dados() {   # <db> [<filtro>]
  Pq "$1" -c "SELECT md5(string_agg(id || '|' || COALESCE(descricao_produto_fornecedor, '<null>') || '|' || COALESCE(mapeamento_qualidade, '-') || '|' || ativo || '|' || atualizado_em::text, ',' ORDER BY id)) FROM public.promocao_item ${2:-};" 2>&1 || true
}
retrato() { printf '%s#%s' "$(funcs "$1")" "$(dados "$1")"; }
md5_de() { Pq "$1" -c "SELECT COALESCE((SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('$2')), 'ausente');" 2>&1 || true; }
MANIFESTO="7,8,9,10,11,12,13,14,15,16,17,18"

# ══════════════════════════════════════════════════════════════════════════════
# C — os predecessores são os corpos de PROD, byte a byte, e a réplica satisfaz as provas do manifesto.
# ══════════════════════════════════════════════════════════════════════════════
echo "── C: predecessores = prod; a réplica prova o original ──"
eq C1 "expandir_promocao_item = corpo de prod" "$(md5_de base "$EXP_SIG")" "566edd782fb00616c6d658b9562020d2"
eq C2 "converter_sugestao_em_campanha_flat = corpo de prod" "$(md5_de base "$CONV_SIG")" "557f962e0355b034097be8cf88c27a1a"
eq C3 "réplica: as 12 filhas têm origem NULL intocada desde a expansão e a observação que registra a variante" "$(Pq base -c "
  SELECT count(*) FROM public.promocao_item f JOIN public.promocao_item o
    ON o.campanha_id = f.campanha_id AND o.sku_codigo_fornecedor = f.sku_codigo_fornecedor AND o.mapeamento_qualidade = 'expandido_origem'
   WHERE f.id IN ($MANIFESTO) AND o.descricao_produto_fornecedor IS NULL AND o.atualizado_em = f.criado_em
     AND position(format('[Expandido automaticamente do código %s — variante: %s]', o.sku_codigo_fornecedor, f.descricao_produto_fornecedor) IN f.observacoes) > 0;" 2>&1 || true)" "12"

# ══════════════════════════════════════════════════════════════════════════════
# A — nos predecessores de PROD o defeito reproduz (senão os positivos de F passariam por vacuidade).
# ══════════════════════════════════════════════════════════════════════════════
echo "── A: o defeito existe nos predecessores ──"
clonar a
eq A1 ">=2 variantes: as filhas nascem com a descrição do SKU, não com o texto do fornecedor" \
   "$(chamar a "$M" "$(front 1102)" "$ST" "$(filhas 101)")" \
   "expandido|3001:expandido_automatico:true:TINTA ABC123 0,9L:5:-,3002:expandido_automatico:true:TINTA ABC123 3,6L:5:-"
eq A2 "1 variante: o NULL do fornecedor é preenchido com a descrição do SKU" \
   "$(chamar a "$M" "$(front 1101)" "$ST" "$(item 1101)")" "resolvido_unico|unico|true|true|3003|VERNIZ UNICO77 18L"
eq A3 "converter: o item nasce com a descrição do SKU da sugestão" \
   "$(chamar a "$E" "$(conv)" "'ok'" "$(item_conv)")" "ok|VZ.0077|VERNIZ UNICO77 18L|3003|manual_confirmado|8|true|true"

# ══════════════════════════════════════════════════════════════════════════════
# M — a migration como o executor a roda: UMA transação (db:aplicar; o SQL Editor cola numa transação
# implícita). Cada cenário num clone da base: recusa = nada muda (retrato integral).
# ══════════════════════════════════════════════════════════════════════════════
echo "── M: a migration sob o executor ──"
MIG_EFETIVA="$MIG"
case "$SABOTAGEM" in
  pre_*|backfill_*|pos_*)
    MIG_EFETIVA="$TMPD/mig_sabotada.sql"
    py migration "$MIG" "$SABOTAGEM" "$MIG_EFETIVA" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    SAB_APLICADA=1
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac
aplicar() { Pd "$1" -1 -q -f "$2" 2>&1; }
variante() {   # <nome> → caminho da cópia da migration efetiva com a variante
  local v="$TMPD/var_$1.sql"
  py migration "$MIG_EFETIVA" "$1" "$v" || { echo "INFRA: variante $1 não montada"; exit 1; }
  printf '%s' "$v"
}
# O veredito de um apply que TEM de ser recusado: o exit do psql decide se recusou; a LINHA DE ERRO do
# servidor, POR QUEM. Apply que passou é APLICOU; recusa pelo motivo errado é RECUSOU_POR_OUTRO.
veredito() {   # <db> <arquivo> <texto esperado na recusa>
  local saida linha
  if saida="$(aplicar "$1" "$2")"; then printf 'APLICOU'; return 0; fi
  while IFS= read -r linha; do
    case "$linha" in
      *"ERROR: "*"$3"*|*"ERRO: "*"$3"*) printf 'RECUSOU'; return 0 ;;
    esac
  done <<< "$saida"
  printf 'RECUSOU_POR_OUTRO %s' "$(printf '%s\n' "$saida" | grep -E '(ERROR|ERRO): ' | head -1 | tr -d ':' | head -c 150 || true)"
}
retrato_pred="$(retrato base)"

# M1 — corpo ESTRANHO na expansão (outra mudança chegou antes): a PRE recusa e nada muda.
clonar m1
Pd m1 -q -c "CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;"
retrato_estranho="$(retrato m1)"
eq M1a "corpo estranho na expansão: a PRE recusa" "$(veredito m1 "$MIG_EFETIVA" 'PRE FALHOU: o corpo vivo de public.expandir_promocao_item')" "RECUSOU"
eq M1b "corpo estranho e dados preservados (retrato integral)" "$(retrato m1)" "$retrato_estranho"

# M2 — corpo estranho no converter: a PRE recusa, e a expansão (que vem antes no arquivo) não muda.
clonar m2
Pd m2 -q -c "CREATE OR REPLACE FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_sku_codigo_fornecedor text, p_responsavel_nome text DEFAULT NULL::text, p_canal text DEFAULT 'ligacao'::text, p_observacoes text DEFAULT NULL::text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$ BEGIN RETURN 0; END \$f\$;"
retrato_estranho="$(retrato m2)"
v="$(veredito m2 "$MIG_EFETIVA" 'PRE FALHOU: o corpo vivo de public.converter_sugestao_em_campanha_flat')"
eq M2 "corpo estranho no converter: a PRE recusa e nada muda (veredito|retrato igual)" "$v|$([ "$(retrato m2)" = "$retrato_estranho" ] && echo igual || echo MUDOU)" "RECUSOU|igual"

# M3 — a expansão AUSENTE: a PRE aborta (sem linha não há trava, e o CREATE a criaria do zero).
clonar m3
Pd m3 -q -c "DROP FUNCTION public.expandir_promocao_item(bigint, numeric);"
eq M3 "expansão ausente: a PRE aborta" "$(veredito m3 "$MIG_EFETIVA" 'PRE FALHOU: public.expandir_promocao_item(bigint,numeric) ausente')" "RECUSOU"

# M4 — uma filha do manifesto EDITADA depois da medição: o backfill recusa e TUDO volta (funções e dados).
clonar m4
Pd m4 -q -c "UPDATE public.promocao_item SET descricao_produto_fornecedor = 'EDITADA A MAO' WHERE id = 8;"
retrato_m4="$(retrato m4)"
v="$(veredito m4 "$MIG_EFETIVA" 'BACKFILL FALHOU: a filha 8 n')"
eq M4 "filha editada: o backfill recusa e nada muda — nem as funções (veredito|retrato igual)" "$v|$([ "$(retrato m4)" = "$retrato_m4" ] && echo igual || echo MUDOU)" "RECUSOU|igual"

# M5 — a ORIGEM escrita depois da expansão: o original da filha não está mais provado.
clonar m5
Pd m5 -q -c "UPDATE public.promocao_item SET desconto_perc = 21 WHERE id = 1;"
eq M5 "origem reescrita (atualizado_em > criado_em da filha): o backfill recusa" "$(veredito m5 "$MIG_EFETIVA" 'BACKFILL FALHOU: a origem 1 foi escrita')" "RECUSOU"

# M6 — a observação da filha não registra a variante do manifesto: sem a prova, não muda.
clonar m6
Pd m6 -q -c "SET session_replication_role = replica; UPDATE public.promocao_item SET observacoes = ' [Expandido automaticamente do código FL.6269.02 — variante: OUTRA COISA]' WHERE id = 10;"
eq M6 "observação que não prova a variante: o backfill recusa" "$(veredito m6 "$MIG_EFETIVA" 'BACKFILL FALHOU: a observa')" "RECUSOU"

# M9 — CORRIDA (Codex P1): outra transação muda a observação da filha 8 SEM tocar a descrição e fica
# aberta enquanto a migration roda. Sem trava, o backfill leria a versão velha, a prova passaria, e o
# UPDATE (que revalida só id e descrição) seguiria sobre a prova vencida quando a outra commitasse. Com
# as linhas travadas ANTES das provas, a migration espera, relê a observação nova e recusa. Ordem
# OBSERVADA, não por tempo (desenho do M5 da 20260930220148): C segura uma trava de liberação; B grava
# a linha 8, sinaliza com um advisory de TRANSAÇÃO e fica preso na trava de C; A (a migration) só é
# lançado quando B sinalizou, e C só solta quando A está ESPERANDO lock (pg_stat_activity).
esperar_advisory() {   # <db> <objid> → 0 quando concedido; 1 se não aparecer em ~10 s
  local _i
  for _i in $(seq 1 100); do
    [ "$(Pq "$1" -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $2 AND granted;")" = 1 ] && return 0
    sleep 0.1
  done
  return 1
}
esperando_lock() {   # <db> <application_name> → 0 quando a sessão está parada esperando um lock
  local _i
  for _i in $(seq 1 100); do
    [ "$(Pq "$1" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$2' AND wait_event_type = 'Lock';")" = 1 ] && return 0
    sleep 0.1
  done
  return 1
}
clonar m9
( Pd m9 -q -c "SELECT pg_advisory_lock(727272); SELECT pg_sleep(600);" ) > "$TMPD/m9-c.log" 2>&1 &
m9_c=$!
m9_a=""; m9_b=""; r9="BARREIRA NAO OBSERVADA (C)"
if esperar_advisory m9 727272; then
  ( Pd m9 -q <<'SQL'
BEGIN;
UPDATE public.promocao_item SET observacoes = ' [Expandido automaticamente do código DR.4403 — variante: OUTRA]' WHERE id = 8;
SELECT pg_advisory_xact_lock(727273);
SELECT pg_advisory_xact_lock(727272);
COMMIT;
SQL
  ) > "$TMPD/m9-b.log" 2>&1 &
  m9_b=$!
  r9="BARREIRA NAO OBSERVADA (B)"
  if esperar_advisory m9 727273; then
    ( PGAPPNAME=m9_aplica Pd m9 -1 -q -f "$MIG_EFETIVA" > "$TMPD/m9-a.log" 2>&1; echo "RC=$?" >> "$TMPD/m9-a.log" ) &
    m9_a=$!
    if esperando_lock m9 m9_aplica; then
      r9="SOLTA"
    else
      r9="A NAO ESPEROU LOCK: $(head -c 200 "$TMPD/m9-a.log" 2>/dev/null)"
    fi
  fi
fi
Pq m9 -c "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 727272 AND granted;" >/dev/null 2>&1 || true
wait "$m9_c" 2>/dev/null || true
if [ -n "$m9_b" ]; then wait "$m9_b" 2>/dev/null || true; fi
if [ -n "$m9_a" ]; then wait "$m9_a" 2>/dev/null || true; fi
case "$r9" in
  SOLTA)
    saida9="$(cat "$TMPD/m9-a.log")"
    if printf '%s' "$saida9" | grep -q '^RC=0$'; then v9="APLICOU"
    elif printf '%s\n' "$saida9" | grep -qE "(ERROR|ERRO): +BACKFILL FALHOU: a observa"; then v9="RECUSOU"
    else v9="RECUSOU_POR_OUTRO $(printf '%s\n' "$saida9" | grep -E '(ERROR|ERRO): ' | head -1 | tr -d ':' | head -c 150)"
    fi
    eq M9 "corrida: observação mudada por outra transação durante o apply — a migration espera, relê e recusa (veredito|funções)" \
       "$v9|$([ "$(funcs m9)" = "$(funcs base)" ] && echo intactas || echo MUDARAM)" "RECUSOU|intactas" ;;
  *) erro_exec M9 "sem corrida válida: [$(printf '%s' "$r9" | tr '\n' ' ' | head -c 200)]" ;;
esac

# Mp1-Mp5 — a POS, uma camada por variante; cada recusa vem da camada CERTA (o rótulo), e desfaz tudo.
clonar mp1; v="$(veredito mp1 "$(variante var_corpo_editado)" 'POS1 FALHOU')"
eq Mp1 "corpo instalado editado (1 espaço): a POS1 recusa e nada muda" "$v|$([ "$(retrato mp1)" = "$retrato_pred" ] && echo igual || echo MUDOU)" "RECUSOU|igual"
clonar mp2; v="$(veredito mp2 "$(variante var_secdef)" 'POS2 FALHOU')"
eq Mp2 "SECURITY DEFINER no CREATE da expansão: a POS2 recusa e nada muda" "$v|$([ "$(retrato mp2)" = "$retrato_pred" ] && echo igual || echo MUDOU)" "RECUSOU|igual"
clonar mp3; v="$(veredito mp3 "$(variante var_drop_create)" 'POS3 FALHOU')"
eq Mp3 "DROP+CREATE da expansão (OID e ACL novos): a POS3 recusa e nada muda" "$v|$([ "$(retrato mp3)" = "$retrato_pred" ] && echo igual || echo MUDOU)" "RECUSOU|igual"
clonar mp4; v="$(veredito mp4 "$(variante var_sem_backfill)" 'POS4 FALHOU')"
eq Mp4 "backfill que não grava: a POS4 recusa e nada muda" "$v|$([ "$(retrato mp4)" = "$retrato_pred" ] && echo igual || echo MUDOU)" "RECUSOU|igual"
clonar mp5; Pd mp5 -q -c "DELETE FROM public.promocao_item WHERE id = 8;"; retrato_mp5="$(retrato mp5)"
v="$(veredito mp5 "$(variante var_sem_checagem_ausencia)" 'POS4 FALHOU')"
eq Mp5 "filha do manifesto AUSENTE e a checagem de existência desligada: a POS4 (presença) recusa e nada muda" "$v|$([ "$(retrato mp5)" = "$retrato_mp5" ] && echo igual || echo MUDOU)" "RECUSOU|igual"

# M7/M8 — aplica e re-aplica. Esperado: os 2 corpos NOVOS com a MESMA config, secdef, OID e ACL; só as
# 12 filhas do manifesto mudam (para NULL); re-aplicar não toca linha nenhuma (atualizado_em igual).
clonar f
acl_antes="$(funcs f)"
fora_antes="$(dados f "WHERE id NOT IN ($MANIFESTO)")"
EXP_NOVO=76b6e55a3d0c419b3ec39ba67cf1795a
CONV_NOVO=73b8588851724e8c2aee0be7f4d3f457
esperado_funcs="$(printf '%s' "$acl_antes" | python3 -c "
import sys
e, c = sys.stdin.read().split('#')
e, c = e.split('|', 1), c.split('|', 1)
print('$EXP_NOVO|' + e[1] + '#$CONV_NOVO|' + c[1], end='')")"
eq M7a "a migration aplica: corpos novos, mesma config/secdef/OID/ACL (veredito|funções)" "$(veredito f "$MIG_EFETIVA" '__nunca__')|$(funcs f)" "APLICOU|$esperado_funcs"
eq M7b "as 12 filhas do manifesto ficam com o original (NULL)" "$(Pq f -c "SELECT count(*) FILTER (WHERE descricao_produto_fornecedor IS NULL) || '/' || count(*) FROM public.promocao_item WHERE id IN ($MANIFESTO);" 2>&1 || true)" "12/12"
eq M7c "nenhuma outra linha muda (origens, 'unico', ad-hoc da 23, manuais da 24, cenários)" "$(dados f "WHERE id NOT IN ($MANIFESTO)")" "$fora_antes"
antes_m8="$(retrato f)"
eq M8 "re-aplicar é no-op: nem corpo, nem dado, nem atualizado_em (veredito|retrato igual)" "$(veredito f "$MIG_EFETIVA" '__nunca__')|$([ "$(retrato f)" = "$antes_m8" ] && echo igual || echo MUDOU)" "APLICOU|igual"

# ── sabotagem de CORPO: aplicada no banco depois do apply (a POS não a veria) ──────────────────
case "$SABOTAGEM" in
  laco_desc_sku|unico_coalesce)
    recriar f "$MIG" "public.expandir_promocao_item(p_item_id bigint, p_threshold" "$SABOTAGEM" \
      || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    SAB_APLICADA=1
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  converter_sku_desc)
    recriar f "$MIG" "public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint" "$SABOTAGEM" \
      || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
    SAB_APLICADA=1
    echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# F — depois do conserto: a chamada do FRONT (authenticated master) e a do converter (staff/não-staff).
# ══════════════════════════════════════════════════════════════════════════════
echo "── F: o texto do fornecedor atravessa a expansão e o converter ──"
eq F1 ">=2 variantes: as filhas herdam o TEXTO do fornecedor (SKU, desconto e confirmação certos); a origem sai intacta" \
   "$(chamar f "$M" "$(front 1102)" "$ST || ':' || (r->>'variantes_criadas')" "$(filhas 101) || '|' || $(item 1102)")" \
   "expandido:2|3001:expandido_automatico:true:ABC123 - OFERTA DO FORNECEDOR:5:-,3002:expandido_automatico:true:ABC123 - OFERTA DO FORNECEDOR:5:-|expandido_origem|false|false|-|ABC123 - OFERTA DO FORNECEDOR"
eq F2 ">=2 variantes com o fornecedor SEM texto: as filhas nascem NULL, não com o SKU" \
   "$(chamar f "$M" "$(front 1103)" "$ST" "$(filhas 101)")" \
   "expandido|3001:expandido_automatico:true:<null>:6:-,3002:expandido_automatico:true:<null>:6:-"
eq F3 "2 parecidos (similaridade): as filhas herdam o texto e ficam para revisar" \
   "$(chamar f "$M" "$(front 3301)" "$ST" "$(filhas 103)")" \
   "expandido_por_similaridade|5001:expandido_por_similaridade:false:SELADORA NITRO 0,9 E 3,6 - OFERTA:5:-,5002:expandido_por_similaridade:false:SELADORA NITRO 0,9 E 3,6 - OFERTA:5:-"
eq F4 "1 variante com o fornecedor SEM texto: resolve o SKU e a descrição FICA NULL" \
   "$(chamar f "$M" "$(front 1101)" "$ST" "$(item 1101)")" "resolvido_unico|unico|true|true|3003|<null>"
eq F5 "1 variante com texto do fornecedor: o texto fica intacto" \
   "$(chamar f "$M" "$(front 1104)" "$ST" "$(item 1104)")" "resolvido_unico|unico|true|true|3003|UNICO77 - VERNIZ DA OFERTA"
eq F6 "1 parecido (similaridade) com o fornecedor SEM texto: resolve sem confirmar e a descrição FICA NULL" \
   "$(chamar f "$M" "$(front 2201)" "$ST" "$(item 2201)")" "resolvido_por_similaridade|unico_por_similaridade|false|true|4001|<null>"
eq F7 "converter (staff): o item nasce SEM descrição do fornecedor; código, SKU, desconto e confirmação certos" \
   "$(chamar f "$E" "$(conv)" "'ok'" "$(item_conv)")" "ok|VZ.0077|<null>|3003|manual_confirmado|8|true|true"
eq F8 "converter (sem papel de staff): o gate segue barrando (42501) e nada é criado" \
   "$(chamar f "$N" "$(conv)" "'ok'" "$(item_conv)")" "SQLSTATE=42501|-"

# Sabotagem com nome que nenhum ramo reconhece (ex.: `pos4_…` não casa `pos_*`) rodaria a suíte LIMPA e
# sairia verde — "sem dente" por erro de digitação, não por assert fraco. Aborta antes do veredito.
if [ -n "$SABOTAGEM" ] && [ "$SAB_APLICADA" != 1 ]; then
  echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM): nenhum ramo a reconheceu"
  exit 9
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executados $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO — prova truncada não é verde"
  exit 1
fi
[ "$FAIL" -eq 0 ]
