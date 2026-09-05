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
  "edge-pre-fonte": "$SHA_NOVO",
};
MAPA

# o que o "banco" devolve: a resposta mais recente por edge, formato `<edge> <fonte>`
cat > "$tmp/pares.txt" <<PARES
edge-no-ar $SHA_NOVO
edge-velha $SHA_VELHO
edge-cega nao-mapeada
edge-pre-fonte sem-campo-fonte
PARES

# stub do psql-ro. MODO controla a avaria: ok | mudo | erro-query
cat > "$tmp/psql-stub" <<'STUB'
#!/usr/bin/env bash
sql="${!#}"
case "${STUB_MODO:-ok}" in
  mudo) exit 0 ;;                       # presente-porém-QUEBRADO: responde vazio ao SELECT 1
  so-set) echo SET; echo SET; exit 0 ;; # abre a sessao e nao devolve resultado nenhum
esac
# o wrapper REAL emite os `SET` da sessao read-only ANTES do resultado (medido em prod 2026-08-28):
# quem exigir a saida inteira == "1" reprova o wrapper BOM e o gate nasce sempre em fail-closed.
echo SET; echo SET
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

  # 3b. ...e a saida tem de dizer O QUE FAZER. "nenhuma sonda na janela" NAO se resolve esperando:
  #     medido 2026-09-05, 24 das 54 edges do mapa nao tem cron nenhum (webhook/sob demanda), e
  #     `net._http_response` expira em 6h — para essas, prova passiva e IMPOSSIVEL e a espera nunca
  #     termina. O proprio autor do script leu esse ramo como "espere o proximo tick do cron" horas
  #     depois de escreve-lo; mensagem que engana quem a escreveu engana qualquer um.
  run ok "$tmp/psql-stub" edge-muda
  if tem 'sonda:sql' "$out"
  then ok "ramo 'nenhuma sonda' aponta o remedio (bun run sonda:sql)"
  else bad "ramo 'nenhuma sonda' sem remedio — o leitor conclui 'espere o cron', que nunca vem"; fi

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

  # 5b. respondeu a sonda (200 + eco de probe/versao) mas SEM o campo `fonte`: bundle ANTERIOR ao
  #     #1998, que ainda nao conhecia o campo. Isso e prova POSITIVA de que o ar e velho — o oposto
  #     de "nao observei nada" — e ate 2026-09-05 saia como "nenhuma sonda na janela" (7 das 10
  #     edges sondadas em prod naquele dia). Ramo PROPRIO, e nunca alegando ausencia de sonda.
  run ok "$tmp/psql-stub" edge-pre-fonte
  if tem 'PRE_SONDA_FONTE' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'nenhuma sonda' "$out" && ! tem 'NO_AR' "$out"
  then ok "sonda sem o campo fonte -> PRE_SONDA_FONTE (bundle pre-#1998), exit 1"
  else bad "sonda sem fonte devia ter ramo proprio, nunca 'nenhuma sonda' (rc=$rc): ${out:0:110}"; fi

  # 6. O TESTE-SENTINELA: wrapper PRESENTE porem MUDO. A mesma edge que no caso 1 era NO_AR tem de
  #    voltar a ser pendencia — `command -v` acharia o arquivo e esvaziaria o guard.
  run mudo "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "psql presente-porem-MUDO -> fail-closed: SEM_PROVA, exit 2"
  else bad "psql mudo devia manter a pendencia com exit 2 (rc=$rc): ${out:0:90}"; fi

  # 6b. o wrapper que responde `SET SET 1` e o BOM: exigir a saida inteira == "1" reprovaria ele e
  #     o gate nasceria travado em exit 2 (medido contra o banco real antes de entregar).
  run so-set "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "psql que so abre sessao (SET SET, sem resultado) -> fail-closed, exit 2"
  else bad "psql sem resultado devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

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

  # 13. modo --desde: a UNIAO das duas vias, num repo git de verdade. O que se prova aqui e a
  #     ENUMERACAO (quem entra na lista), nao a classificacao — e o furo caro e o `_shared/`:
  #     nenhuma das duas vias enxerga as edges afetadas por ele sem o mapa de fingerprints.
  # um repo POR PASSADA: o 2o caso deste bloco mutila o repo (remove o mapa), e reusar o mesmo
  # diretorio no 2o locale faria o 1o caso rodar contra um repo ja quebrado — vermelho falso.
  local repo="$tmp/repo-${LC_ALL:-x}"
  if [ ! -d "$repo" ]; then
    mkdir -p "$repo/supabase/functions/_shared" "$repo/supabase/functions/edge-do-shared"
    git -C "$repo" init -q -b main 2>/dev/null
    git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
    printf 'x\n' > "$repo/supabase/functions/_shared/lib.ts"
    printf 'import "../_shared/lib.ts"\n' > "$repo/supabase/functions/edge-do-shared/index.ts"
    cat > "$repo/supabase/functions/_shared/sonda-fingerprints.ts" <<MAPA0
export const FONTE_SHA256: Record<string, string> = {
  "edge-do-shared": "$SHA_VELHO",
};
MAPA0
    git -C "$repo" add -A >/dev/null; git -C "$repo" commit -qm base
    base_sha="$(git -C "$repo" rev-parse HEAD)"
    # 2o commit: mexe SO em _shared/ e o CI regenera o mapa -> o fingerprint da edge muda
    printf 'y\n' > "$repo/supabase/functions/_shared/lib.ts"
    cat > "$repo/supabase/functions/_shared/sonda-fingerprints.ts" <<MAPA1
export const FONTE_SHA256: Record<string, string> = {
  "edge-do-shared": "$SHA_NOVO",
};
MAPA1
    git -C "$repo" add -A >/dev/null; git -C "$repo" commit -qm shared
    git -C "$repo" update-ref refs/remotes/origin/main HEAD
    printf '%s' "$base_sha" > "$tmp/base_sha"
  fi

  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         FECHO_MAPA_FONTE="" bash "$ALVO" --desde "$(cat "$tmp/base_sha")" 2>&1)"; rc=$?
  # a edge afetada SO por _shared/ tem de aparecer: a via (b) nao a ve, a via (a) sim
  if tem 'edge-do-shared' "$out" && ! tem '_shared ' "$out"
  then ok "--desde: _shared/ puxa a edge afetada e _shared NAO entra como edge"
  else bad "--desde devia listar edge-do-shared e nunca _shared (rc=$rc): ${out:0:120}"; fi

  # mapa ilegivel + _shared/ tocado = nao sei quais edges foram afetadas -> exit 2, nunca "nada"
  git -C "$repo" rm -q --cached supabase/functions/_shared/sonda-fingerprints.ts >/dev/null 2>&1
  rm -f "$repo/supabase/functions/_shared/sonda-fingerprints.ts"
  git -C "$repo" commit -qm "sem mapa" >/dev/null 2>&1
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "$(cat "$tmp/base_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ] && ! tem 'nenhuma edge na janela' "$out"
  then ok "--desde: _shared/ sem mapa legivel -> exit 2, nunca 'nenhuma edge'"
  else bad "_shared sem mapa devia dar exit 2 e nao absolver (rc=$rc): ${out:0:120}"; fi

  # 14b. A JANELA ANTERIOR AO MAPA — o caso que travava o Passo 3 do /fecho em exit 2 (medido
  #      2026-09-05 com `--desde "2026-08-21 20:00"`: o commit-base e anterior ao #1998, que criou
  #      `sonda-fingerprints.ts`). As duas pontas do mapa NAO tem o mesmo papel: `mapa_agora` e
  #      indispensavel (sem ele nao ha `esperado` para ninguem), mas `mapa_base` so ESTREITA a
  #      enumeracao. Faltando ele o diff nao casa par nenhum e a via (a) emite o mapa INTEIRO como
  #      alvo — superconjunto SEGURO. Desistir ai joga fora o sinal justamente na janela em que
  #      MAIS edge foi afetada (41 das 95, na janela medida).
  local repo2="$tmp/repo-nasce-${LC_ALL:-x}"
  if [ ! -d "$repo2" ]; then
    mkdir -p "$repo2/supabase/functions/_shared" "$repo2/supabase/functions/edge-do-shared"
    git -C "$repo2" init -q -b main 2>/dev/null
    git -C "$repo2" config user.email t@t; git -C "$repo2" config user.name t
    printf 'x\n' > "$repo2/supabase/functions/_shared/lib.ts"
    printf 'import "../_shared/lib.ts"\n' > "$repo2/supabase/functions/edge-do-shared/index.ts"
    # commit-base SEM o mapa: e exatamente como a main estava antes do #1998
    git -C "$repo2" add -A >/dev/null; git -C "$repo2" commit -qm "base sem mapa"
    git -C "$repo2" rev-parse HEAD > "$tmp/base2_sha"
    printf 'y\n' > "$repo2/supabase/functions/_shared/lib.ts"
    cat > "$repo2/supabase/functions/_shared/sonda-fingerprints.ts" <<MAPA2
export const FONTE_SHA256: Record<string, string> = {
  "edge-do-shared": "$SHA_NOVO",
};
MAPA2
    git -C "$repo2" add -A >/dev/null; git -C "$repo2" commit -qm "shared + mapa nasce"
    git -C "$repo2" update-ref refs/remotes/origin/main HEAD
  fi
  printf 'edge-do-shared %s\n' "$SHA_NOVO" > "$tmp/pares-shared.txt"

  # o SINAL tem de sobreviver: com a fonte servida batendo, a edge sai NO_AR e o chip some
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo2" \
         STUB_PARES="$tmp/pares-shared.txt" FECHO_MAPA_FONTE="" \
         bash "$ALVO" --desde "$(cat "$tmp/base2_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && tem 'NO_AR' "$out" && tem 'mapa_base ausente' "$out"
  then ok "--desde: janela anterior ao mapa -> enumera pelo mapa INTEIRO e preserva o NO_AR"
  else bad "janela anterior ao mapa devia classificar, nao exit 2 (rc=$rc): ${out:0:140}"; fi

  # e o fail-closed CONTINUA: sem fonte servida, a MESMA edge cai para SEM_PROVA, nunca NO_AR
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo2" \
         STUB_PARES=/dev/null FECHO_MAPA_FONTE="" \
         bash "$ALVO" --desde "$(cat "$tmp/base2_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 1 ] && tem 'SEM_PROVA' "$out" && ! tem 'NO_AR' "$out"
  then ok "--desde: janela anterior ao mapa, sem sonda -> SEM_PROVA (fail-closed intacto)"
  else bad "sem sonda devia cair para SEM_PROVA, nunca NO_AR (rc=$rc): ${out:0:140}"; fi

  # 12. guardrail de FORMA do SQL: o stub nao executa SQL, entao o que da para provar aqui e que a
  #     consulta pede a resposta MAIS RECENTE por edge. Sem isso, um deploy no meio da janela deixa
  #     o bundle velho no resultado e ele seria lido como prova (o caso do omie-vendas-sync).
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  if tem 'DISTINCT ON (edge)' "$(cat "$tmp/sql.txt")" && tem 'created DESC' "$(cat "$tmp/sql.txt")"
  then ok "SQL pede a resposta mais recente por edge (DISTINCT ON + created DESC)"
  else bad "SQL sem DISTINCT ON (edge)/created DESC — deploy no meio da janela viraria prova falsa"; fi

  # 12b. guardrail de FORMA do ramo pre-#1998: a consulta tem de ADMITIR a resposta sem `fonte`
  #      (com `? 'fonte'` cru ela some antes de ser classificada, e a edge cai em "nenhuma sonda"),
  #      e ao admiti-la tem de exigir o eco POSITIVO de sonda — sem o `probe`, QUALQUER 200 com um
  #      campo `edge` entraria como se fosse resposta de sonda, e isso afrouxaria o fail-closed.
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  if tem "NOT ((content::jsonb) ? 'fonte')" "$(cat "$tmp/sql.txt")" \
     && tem "->> 'probe'" "$(cat "$tmp/sql.txt")" \
     && tem "'sem-campo-fonte'" "$(cat "$tmp/sql.txt")"
  then ok "SQL admite a resposta sem \`fonte\`, exige o eco de probe e emite o mesmo sentinela"
  else bad "SQL sem o ramo 'sem fonte' + probe — 200 sondado voltaria a virar 'nenhuma sonda'"; fi
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
  sabota "presenca do wrapper basta (sem exigir resposta positiva)" \
    "s%! \"\$PSQL\" -Atc 'SELECT 1' 2>/dev/null | command grep -Fxq -- '1'%false%"
  # (a2) a sonda volta a exigir a saida INTEIRA == "1": reprova o wrapper bom (o defeito de prod)
  sabota "sonda exigindo saida inteira == 1 (ignora os SET do wrapper)" \
    "s%| command grep -Fxq -- '1'%| tr -d '[:space:]' | command grep -Fxq -- '1'%"
  # (a3) o fail-closed do `_shared/` sem mapa vira aviso: enumeracao voltaria a absolver por ausencia
  sabota "_shared sem mapa deixando de ser exit 2" \
    's%      exit 2$%      :%'
  # (a4) a assimetria de papel entre as duas pontas do mapa some, e `mapa_base` volta a valer por
  #      cegueira — o defeito medido em 2026-09-05: janela cujo base e anterior ao #1998 (que criou
  #      o mapa) desistia por atacado, sem veredito nenhum, justo quando `_shared/` afetou 41 das
  #      95 edges. Sem esta sabotagem o caso 14b passaria a ser decorativo.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "mapa_base ausente voltando a ser tratado como cegueira" \
    's%if \[ ! -s "$tmp/mapa_agora" \]; then%if [ ! -s "$tmp/mapa_agora" ] || [ ! -s "$tmp/mapa_base" ]; then%'
  # (a5) o remedio some do rodape: o ramo "nenhuma sonda" volta a dizer so "INDETERMINADO", e o
  #      leitor conclui "espere o cron" — que para 24 das 54 edges do mapa NUNCA vem (webhook/sob
  #      demanda, sem cron nenhum). Foi o erro cometido ao vivo pelo autor do proprio script.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "registro do ramo 'nenhuma sonda' indo para o vazio (rodape sem remedio)" \
    's#>> "$tmp/sem_sonda"#>> /dev/null#'
  # (b) o fail-closed some da classificacao: mecanica quebrada passaria a absolver
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "classificar como NO_AR mesmo com mecanica quebrada" \
    's%if \[ "$mecanica_ok" = 1 \] && \[ -n "$esperado" \] && \[ "$servido" = "$esperado" \]; then%if [ -n "$esperado" ]; then%'
  # (c) presenca vira prova: qualquer fonte servida absolveria, inclusive a velha
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "aceitar qualquer fonte servida como prova" \
    's%\[ "$servido" = "$esperado" \]%[ -n "$servido" ]%'
  # (e) o ramo pre-#1998 some da classificacao: a mesma resposta 200 sem `fonte` que ele nomeia
  #     voltaria a cair no ramo generico, e a prova positiva de bundle velho perderia o nome
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "ramo PRE_SONDA_FONTE neutralizado na classificacao" \
    's%\[ "$servido" = "sem-campo-fonte" \]%false%'
  # (f) o SQL volta a filtrar por `? 'fonte'` cru: a resposta sem o campo e DESCARTADA antes de
  #     ser classificada, e a edge sondada reaparece como "nenhuma sonda na janela" (o defeito)
  sabota "SQL voltando a descartar a resposta sem o campo fonte" \
    "s%WHERE NOT ((content::jsonb) ? 'fonte')%WHERE ((content::jsonb) ? 'fonte')%"
  # (g) a 2a classe deixa de exigir eco POSITIVO de sonda: qualquer 200 com um campo `edge` viraria
  #     "resposta de sonda", e o fail-closed que este ramo NAO pode afrouxar cairia junto
  sabota "2a classe sem exigir o eco de probe" \
    "s%           AND (content::jsonb) ->> 'probe'  = 'true'%%"
  # (h) DERIVA entre as duas pontas: o SQL passa a emitir um sentinela que o classificador nao
  #     compara — nenhuma das duas metades falha sozinha, e o ramo novo fica inalcancavel
  sabota "sentinela do SQL divergindo do que o classificador compara" \
    "s%'sem-campo-fonte'           AS fonte%'sem-campo-fonte-x'         AS fonte%"
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
