#!/usr/bin/env bash
# test-fecho-edges-pendentes.sh — suíte do gate do Passo 3 do /fecho.
#
# O alvo é `.claude/skills/fecho/scripts/edges-pendentes.sh`, o script que decide se uma edge da
# janela AINDA precisa de chip. Ele é o lado que APAGA pendência, então a asserção que mais importa
# aqui não é "sabe dizer NO_AR" — é **sabe continuar dizendo pendente quando a mecânica falha**
# (`docs/historico/sonda-ausente-em-script-que-apaga.md`: `command -v` não basta, exige-se resposta
# POSITIVA; sonda quebrada que esvazia o guard é o modo de falha caro).
#
# O banco entra por STUB: a suíte prova o SCRIPT, não o PostgREST. O que não dá para provar sem
# banco (a query pegar a resposta MAIS RECENTE por edge) vira guardrail de FORMA sobre o SQL.
#
#   bash scripts/test-fecho-edges-pendentes.sh              # suíte
#   bash scripts/test-fecho-edges-pendentes.sh --falsificar # sabota o alvo e EXIGE vermelho
#
# Roda nos DOIS locales de propósito (#1483): falsificar em UM ambiente não prova a asserção.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ALVO="$RAIZ/.claude/skills/fecho/scripts/edges-pendentes.sh"
[ -f "$ALVO" ] || { echo "VERMELHO — alvo não encontrado: $ALVO"; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# ------------------------------------------------------------------ fixtures ---
SHA_NOVO="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_VELHO="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

cat > "$tmp/mapa.ts" <<MAPA
export const FONTE_SHA256: Record<string, string> = {
  "edge-no-ar": "$SHA_NOVO",
  "edge-velha": "$SHA_NOVO",
  "edge-muda": "$SHA_NOVO",
  "edge-cega": "$SHA_NOVO",
};
MAPA

# o que o "banco" devolve: a resposta mais recente por edge, formato `<edge> <fonte>`
cat > "$tmp/pares.txt" <<PARES
edge-no-ar $SHA_NOVO
edge-velha $SHA_VELHO
edge-cega nao-mapeada
PARES

# stub do psql-ro. MODO controla a avaria: ok | mudo | erro-query
cat > "$tmp/psql-stub" <<'STUB'
#!/usr/bin/env bash
sql="${!#}"
case "${STUB_MODO:-ok}" in
  mudo) exit 0 ;;                       # presente-porém-QUEBRADO: responde vazio ao SELECT 1
esac
if [ "$sql" = "SELECT 1" ]; then echo 1; exit 0; fi
printf '%s' "$sql" > "${STUB_SQL_ECO:-/dev/null}"
[ "${STUB_MODO:-ok}" = "erro-query" ] && { echo "ERROR: relation net._http_response" >&2; exit 1; }
cat "${STUB_PARES:-/dev/null}" 2>/dev/null
exit 0
STUB
chmod +x "$tmp/psql-stub"

export FECHO_MAPA_FONTE="$tmp/mapa.ts" STUB_PARES="$tmp/pares.txt" STUB_SQL_ECO="$tmp/sql.txt"

# roda o alvo: `run <modo-do-stub> <psql> <args...>` publica a saida em $out e o codigo em $rc.
# NAO devolve a saida por stdout de proposito: `run ...` executaria a funcao num SUBSHELL
# e o `rc` morreria com ele — o veredito voltaria 0 SEMPRE, que e a fabricacao de exit code do
# CLAUDE.md em forma de harness de teste (foi exatamente o que a 1a versao desta suite fez).
rc=0
out=""
run() {
  local modo="$1" psql="$2"; shift 2
  out="$(STUB_MODO="$modo" AFIACAO_PSQL="$psql" bash "$ALVO" "$@" 2>&1)"; rc=$?
}

fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }
# marcador ASCII, caixa fixa, sem -i, via `command grep` (o grep do shell é shim p/ ugrep)
tem() { printf '%s' "$2" | command grep -q -- "$1"; }

# --------------------------------------------------------------------- suíte ---
suite() {
  printf '== edges-pendentes (locale=%s) ==\n' "${LC_ALL:-?}"

  # 1. prova POSITIVA: fonte servida == main -> some o chip
  run ok "$tmp/psql-stub" edge-no-ar
  if tem 'NO_AR' "$out" && [ "$rc" -eq 0 ] && ! tem 'abra chip' "$out"
  then ok "fonte bate com a main -> NO_AR, exit 0, sem chip"
  else bad "fonte batendo devia dar NO_AR/exit 0 (rc=$rc): ${out:0:90}"; fi

  # 2. bundle velho servindo -> chip PROVADO
  run ok "$tmp/psql-stub" edge-velha
  if tem 'DESATUALIZADA' "$out" && [ "$rc" -eq 1 ]
  then ok "fonte diferente -> DESATUALIZADA, exit 1"
  else bad "fonte divergente devia dar DESATUALIZADA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 3. ausencia NAO reprova, mas tambem nao absolve: INDETERMINADO -> chip
  run ok "$tmp/psql-stub" edge-muda
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "sem sonda na janela -> SEM_PROVA, exit 1"
  else bad "edge sem sonda devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 4. as ~55 edges fora do mapa continuam virando chip como hoje (sem regressao)
  run ok "$tmp/psql-stub" edge-fora-do-mapa
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "edge fora do mapa -> SEM_PROVA, exit 1"
  else bad "edge fora do mapa devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 5. sonda respondeu `nao-mapeada`: a prova nasceu cega, nao e prova
  run ok "$tmp/psql-stub" edge-cega
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "sonda nao-mapeada -> SEM_PROVA, exit 1"
  else bad "nao-mapeada devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 6. O TESTE-SENTINELA: wrapper PRESENTE porem MUDO. A mesma edge que no caso 1 era NO_AR tem de
  #    voltar a ser pendencia — `command -v` acharia o arquivo e esvaziaria o guard.
  run mudo "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "psql presente-porem-MUDO -> fail-closed: SEM_PROVA, exit 2"
  else bad "psql mudo devia manter a pendencia com exit 2 (rc=$rc): ${out:0:90}"; fi

  # 7. a consulta estourou -> mecanica nao confiavel, tudo pendente
  run erro-query "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "consulta com erro -> fail-closed, exit 2"
  else bad "erro na consulta devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 8. wrapper AUSENTE
  run ok "$tmp/nao-existe" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "psql ausente -> fail-closed, exit 2"
  else bad "psql ausente devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 9. mapa ilegivel: sem regua nao ha como absolver ninguem
  FECHO_MAPA_FONTE="$tmp/mapa-que-nao-existe.ts" run ok "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "mapa ilegivel -> fail-closed, exit 2"
  else bad "mapa ilegivel devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 10. janela vem de env -> nao pode entrar crua no SQL
  FECHO_JANELA_TTL="6 hours'; DROP TABLE x --" run ok "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "janela invalida (injecao) -> recusa, exit 2"
  else bad "janela invalida devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 11. uso invalido
  run ok "$tmp/psql-stub"
  if [ "$rc" -eq 3 ]
  then ok "sem argumentos -> exit 3"
  else bad "sem argumentos devia dar exit 3 (rc=$rc)"; fi

  # 12. guardrail de FORMA do SQL: o stub nao executa SQL, entao o que da para provar aqui e que a
  #     consulta pede a resposta MAIS RECENTE por edge. Sem isso, um deploy no meio da janela deixa
  #     o bundle velho no resultado e ele seria lido como prova (o caso do omie-vendas-sync).
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  if tem 'DISTINCT ON (edge)' "$(cat "$tmp/sql.txt")" && tem 'created DESC' "$(cat "$tmp/sql.txt")"
  then ok "SQL pede a resposta mais recente por edge (DISTINCT ON + created DESC)"
  else bad "SQL sem DISTINCT ON (edge)/created DESC — deploy no meio da janela viraria prova falsa"; fi
}

# ---------------------------------------------------------------- falsificação ---
if [ "${1:-}" = "--falsificar" ]; then
  falhou=0
  printf '== falsificacao (sabota o alvo e EXIGE vermelho) ==\n'

  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  [ -n "$utf8" ] || { printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 — metade da cobertura fingindo ser inteira\n'; exit 1; }

  ALVO_REAL="$ALVO"
  sabota() { # <descricao> <expressao-sed>
    local desc="$1" expr="$2" copia="$tmp/sabotado.sh" erro
    erro="$(sed "$expr" "$ALVO_REAL" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:50}"; falhou=1; return
    fi
    if cmp -s "$ALVO_REAL" "$copia"; then
      printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, alvo intacto — falsificacao vazia\n' "$desc"; falhou=1; return
    fi
    chmod +x "$copia"
    local viu_vermelho=0 loc
    for loc in C "$utf8"; do
      # subshell de proposito: a sabotagem e o locale morrem com ela, e o ALVO global fica intacto
      # shellcheck disable=SC2030,SC2031
      if ! ( export LC_ALL="$loc"; ALVO="$copia"; fail=0; suite >/dev/null 2>&1; [ "$fail" -eq 0 ] ); then
        viu_vermelho=$((viu_vermelho + 1))
      fi
    done
    if [ "$viu_vermelho" -eq 2 ]; then
      printf '  \033[32mok\033[0m   "%s" -> suite vermelha nos 2 locales\n' "$desc"
    else
      printf '  \033[31mFALHA\033[0m "%s": suite ficou VERDE (%d/2 vermelhos) — assercao frouxa\n' "$desc" "$viu_vermelho"; falhou=1
    fi
  }

  # (a) a sonda positiva vira `command -v` de mentira: presente passa a valer por respondendo
  sabota "aceitar psql mudo (sem exigir resposta positiva)" \
    's%!= "1"%!= "IMPOSSIVEL"%'
  # (b) o fail-closed some da classificacao: mecanica quebrada passaria a absolver
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "classificar como NO_AR mesmo com mecanica quebrada" \
    's%if \[ "$mecanica_ok" = 1 \] && \[ -n "$esperado" \] && \[ "$servido" = "$esperado" \]; then%if [ -n "$esperado" ]; then%'
  # (c) presenca vira prova: qualquer fonte servida absolveria, inclusive a velha
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "aceitar qualquer fonte servida como prova" \
    's%\[ "$servido" = "$esperado" \]%[ -n "$servido" ]%'
  # (d) a query perde o "mais recente por edge"
  sabota "SQL sem DISTINCT ON (edge)" \
    's%SELECT DISTINCT ON (edge) edge%SELECT edge%'

  [ "$falhou" -eq 0 ] && { printf '\n== falsificacao: todas as sabotagens ficaram vermelhas ==\n'; exit 0; }
  printf '\n== falsificacao REPROVOU ==\n'; exit 1
fi

# ------------------------------------------------------------------- execução ---
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
[ -n "$utf8" ] || { echo "FALHA: nenhum locale UTF-8 disponivel"; exit 1; }

total=0
for loc in C "$utf8"; do
  # shellcheck disable=SC2031
  export LC_ALL="$loc"
  fail=0
  suite
  total=$((total + fail))
done
[ "$total" -eq 0 ] || { printf '\n\033[31m== REPROVOU ==\033[0m\n'; exit 1; }
printf '\n\033[32m== verde nos 2 locales ==\033[0m\n'
