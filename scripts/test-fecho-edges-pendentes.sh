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
  "edge-lote-1": "$SHA_NOVO",
  "edge-lote-2": "$SHA_NOVO",
  "edge-lote-3": "$SHA_NOVO",
  "edge-lote-4": "$SHA_NOVO",
  "edge-lote-5": "$SHA_NOVO",
  "edge-lote-6": "$SHA_NOVO",
  "edge-lote-7": "$SHA_NOVO",
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
  # quebra SO a sonda `SELECT 1` e responde normal a consulta: isola a assercao da SONDA POSITIVA
  # da trava de FORMA do resultado. Sem este modo as duas se cobrem — o wrapper mudo de verdade
  # e mudo para tudo, entao a trava de forma pegaria o defeito e a sabotagem da sonda ficaria
  # VERDE: cobertura redundante em prod, ausencia de medicao no teste.
  mudo-sonda) [ "$sql" = "SELECT 1" ] && { echo SET; echo SET; exit 0; } ;;
esac
# o wrapper REAL emite os `SET` da sessao read-only ANTES do resultado (medido em prod 2026-08-28):
# quem exigir a saida inteira == "1" reprova o wrapper BOM e o gate nasce sempre em fail-closed.
echo SET; echo SET
if [ "$sql" = "SELECT 1" ]; then echo 1; exit 0; fi
printf '%s' "$sql" > "${STUB_SQL_ECO:-/dev/null}"
[ "${STUB_MODO:-ok}" = "erro-query" ] && { echo "ERROR: relation net._http_response" >&2; exit 1; }
cat "${STUB_PARES:-/dev/null}" 2>/dev/null
# a contagem de sondas ANONIMAS (sem eco de slug) viaja na MESMA resposta; `sem-anonimas` simula a
# DERIVA — SQL de uma versao lido por um classificador de outra.
[ "${STUB_MODO:-ok}" = "sem-anonimas" ] || echo "#anonimas ${STUB_ANONIMAS:-0}"
exit 0
STUB
chmod +x "$tmp/psql-stub"

export FECHO_MAPA_FONTE="$tmp/mapa.ts" STUB_PARES="$tmp/pares.txt" STUB_SQL_ECO="$tmp/sql.txt"
export STUB_ANONIMAS=0

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
  if tem 'sonda:sql' "$out"
  then ok "ramo 'nenhuma sonda' aponta o remedio (bun run sonda:sql)"
  else bad "ramo 'nenhuma sonda' sem remedio — o leitor conclui 'espere o cron', que nunca vem"; fi
  # 3b. ...e a saida tem de dizer O QUE FAZER. "nenhuma sonda na janela" NAO se resolve esperando:
  #     nao ha cron de sondagem (93 jobs em cron.job, ZERO com probe) e, medido 2026-09-05, 24 das
  #     54 edges do mapa nao tem cron NENHUM (webhook/sob demanda) — para essas a prova passiva e
  #     IMPOSSIVEL, e net._http_response ainda expira no TTL. O autor do proprio script leu este
  #     ramo como "espere o proximo tick do cron" HORAS depois de escreve-lo, ao verificar dois
  #     deploys reais; a espera nunca terminaria. Mensagem que engana quem a escreveu engana todos.
  else bad "edge sem sonda devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 3c. o comando sugerido tem de ser COLAVEL. A versao anterior truncava a lista em 6 e colava
  #     `… (+N)` DENTRO do `bun run sonda:sql`: acima de 6 edges o comando saia quebrado, e quem
  #     nao colasse reconstruia a lista na mao (feito em 2026-09-05, com 9 edges). Resumo pode
  #     truncar; COMANDO nao. 7 alvos de proposito — 6 e o antigo limite, entao 7 e o 1o que falha.
  run ok "$tmp/psql-stub" edge-lote-1 edge-lote-2 edge-lote-3 edge-lote-4 edge-lote-5 edge-lote-6 edge-lote-7
  linha_cmd="$(printf '%s' "$out" | command grep 'sonda:sql' || true)"
  faltou=""
  for n in 1 2 3 4 5 6 7; do
    tem "edge-lote-$n" "$linha_cmd" || faltou="$faltou edge-lote-$n"
  done
  if [ -z "$faltou" ] && ! tem '(+' "$linha_cmd"
  then ok "DISPARE emite a lista INTEIRA (7/7), sem truncar o comando"
  else bad "comando truncado — faltou:$faltou · linha: ${linha_cmd:0:150}"; fi

  # 3d. ...e nao pode ser pronto-para-colar CEGO. Bundle PRE-sensor nao conhece `probe`: a sonda
  #     entra como requisicao NORMAL e o handler roda o FLUXO REAL. Medido 2026-09-05 na 12a leva,
  #     3 das 9 eram caras — `process-recurring-orders` CRIA `orders` e AVANCA `next_order_date`,
  #     entao o run legitimo do dia seguinte PULA a data que a sonda consumiu. O `--caro` sai no
  #     comando com valor INVALIDO de proposito (regra do deploy.md: campo que o operador
  #     substitui nunca carrega valor de EXEMPLO), e o sonda:sql aborta sem emitir SQL ate a
  #     triagem acontecer. Recado vira TRAVA — recado que depende de alguem lembrar nao vale.
  #     Invocacao PROPRIA, com 1 alvo: a trava nao pode depender do tamanho da leva. Reaproveitar
  #     o `linha_cmd` do 3c acoplava as duas — medido ao falsificar: sabotar SO o truncamento
  #     derrubou esta asercao junto, e caso que so falha junto com outro nao mede nada sozinho.
  run ok "$tmp/psql-stub" edge-muda
  linha_trava="$(printf '%s' "$out" | command grep 'sonda:sql' || true)"
  if tem '--caro=trie-antes-veja-deploy-md' "$linha_trava" && tem 'TRIE ANTES DE DISPARAR' "$out"
  then ok "DISPARE carrega a trava --caro invalida + o aviso de fluxo REAL"
  else bad "DISPARE saiu pronto-para-colar sem triagem: ${linha_trava:0:150}"; fi

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

  # 5c. O DEFEITO DE 2026-09-05, um degrau ATRAS do 5b: bundle anterior ao #1789 responde
  #     `{ok,probe,versao}` e NAO ecoa `edge` — a resposta existe e nao diz de quem e. As 3 de
  #     5 edges sondadas naquele dia (request_ids 69377, 69379, 69381) sairam como "nenhuma sonda
  #     em 6 hours": ausencia FABRICADA, com a resposta gravada no banco. O veredito segue
  #     INDETERMINADO (identidade ausente nao vira identidade presumida), mas o motivo tem de
  #     dizer que sondaram — e apontar o unico vinculo que determina, o request_id.
  export STUB_ANONIMAS=3
  run ok "$tmp/psql-stub" edge-muda
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ] \
     && tem 'SONDA_ANONIMA' "$out" && tem 'request-ids' "$out" \
     && ! tem 'nenhuma sonda em' "$out" && ! tem 'NO_AR' "$out"
  then ok "sonda ANONIMA na janela -> SEM_PROVA que NAO alega ausencia, e aponta --request-ids"
  else bad "com sonda anonima na janela nao pode dizer 'nenhuma sonda' (rc=$rc): ${out:0:140}"; fi

  # 5d. e o contrario tambem: ZERO anonimas continua sendo ausencia de verdade, dita como tal.
  #     Sem este caso o ramo novo poderia virar mensagem UNICA e a distincao morreria.
  export STUB_ANONIMAS=0
  run ok "$tmp/psql-stub" edge-muda
  if tem 'nenhuma sonda em' "$out" && [ "$rc" -eq 1 ] && ! tem 'SONDA_ANONIMA' "$out"
  then ok "zero anonimas -> segue 'nenhuma sonda na janela' (a ausencia de verdade)"
  else bad "sem anonimas a mensagem devia ser a de ausencia (rc=$rc): ${out:0:140}"; fi

  # 5e. DERIVA entre as duas pontas: o SQL nao devolve a linha `#anonimas` e o classificador a le.
  #     Degradar para zero devolveria justamente a mensagem MENTIROSA — entao e fail-closed.
  run sem-anonimas "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "SQL sem a linha #anonimas -> mecanica nao confiavel, exit 2 (nunca degrada para zero)"
  else bad "linha #anonimas ausente devia dar exit 2 (rc=$rc): ${out:0:140}"; fi

  # 5f. `--request-ids` e o ESCAPE, e toda recusa dele e exit 3 (uso), nunca veredito de deploy.
  #     Par malformado aceito em silencio e o modo de falha caro: o operador acha que colou, a
  #     edge segue sem vinculo, e a saida diz "sem sonda" com a mesma cara de sempre.
  local caso_ruim ruins_ok=1
  for caso_ruim in "edge-muda" "edge muda=1" "edge-muda=abc" "edge-muda=" "=1" "EDGE=1"; do
    run ok "$tmp/psql-stub" edge-muda --request-ids "$caso_ruim"
    [ "$rc" -eq 3 ] || { ruins_ok=0; bad "--request-ids '$caso_ruim' devia ser exit 3 (rc=$rc)"; }
  done
  [ "$ruins_ok" = 1 ] && ok "--request-ids malformado -> exit 3 nos 6 formatos ruins"

  # 5g. slug que nao esta na leva: o typo deixaria a edge de verdade SEM o vinculo que o operador
  #     acha que deu — mesma trava do `--caro` forasteiro do sonda:sql.
  run ok "$tmp/psql-stub" edge-muda --request-ids "edge-mudaa=99"
  if [ "$rc" -eq 3 ] && tem 'SLUG_FORA_DA_LEVA' "$out"
  then ok "--request-ids com slug fora da leva -> exit 3 (typo nao passa calado)"
  else bad "slug forasteiro devia dar exit 3 (rc=$rc): ${out:0:120}"; fi

  # 5h. o par BOM entra no SQL como VALUES, e sem ele a CTE nasce vazia por WHERE false — a FORMA
  #     do SQL e a mesma nos dois caminhos, senao o guardrail textual mede uma consulta que nao roda.
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-muda --request-ids "edge-muda=777" > /dev/null
  if tem "VALUES ('edge-muda', 777::bigint)" "$(cat "$tmp/sql.txt")"
  then ok "--request-ids bom vira VALUES no SQL"
  else bad "o par colado nao chegou ao SQL: $(head -c 120 "$tmp/sql.txt")"; fi
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-muda > /dev/null
  if tem 'SELECT NULL::text, NULL::bigint WHERE false' "$(cat "$tmp/sql.txt")"
  then ok "sem --request-ids a CTE vinculo nasce vazia (mesma FORMA de SQL)"
  else bad "sem colagem a CTE vinculo devia nascer vazia: $(head -c 120 "$tmp/sql.txt")"; fi

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

  # 6c. wrapper que responde a CONSULTA mas nao a sonda `SELECT 1`. A sonda POSITIVA e o guard,
  #     e ele tem de reprovar sozinho — sem depender de o resultado tambem vir malformado.
  run mudo-sonda "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "psql que responde a consulta mas nao a sonda -> fail-closed, exit 2"
  else bad "sonda sem resposta positiva devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

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
    mkdir -p "$repo/supabase/functions/_shared" "$repo/supabase/functions/edge-do-shared" \
             "$repo/supabase/functions/edge-fora-do-mapa"
    git -C "$repo" init -q -b main 2>/dev/null
    git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
    printf 'x\n' > "$repo/supabase/functions/_shared/lib.ts"
    printf 'import "../_shared/lib.ts"\n' > "$repo/supabase/functions/edge-do-shared/index.ts"
    # a classe do buraco: importa `_shared/` e NAO tem versao.ts, logo NAO esta no mapa. A via (a)
    # nao a conhece (so le o mapa) e a via (b) nao a ve (a pasta dela nao foi tocada). 41 edges
    # reais nesta situacao, medidas em 2026-09-05 sobre origin/main.
    printf 'import "../_shared/lib.ts"\n' > "$repo/supabase/functions/edge-fora-do-mapa/index.ts"
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

  # 13b. a via (c): edge FORA do mapa afetada so por `_shared/`. Sem o grafo de imports ela nao
  #      entra por via nenhuma — nao vira chip e a pendencia some por AUSENCIA DE DADO, que e o
  #      modo de falha caro de um script que APAGA pendencia.
  if tem 'edge-fora-do-mapa' "$out"
  then ok "--desde: edge FORA do mapa afetada por _shared/ entra pelo grafo de imports"
  else bad "edge-fora-do-mapa sumiu: _shared/ mudou, ela importa, e nenhuma via a enxergou"; fi

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

  # 14c. GUARD DE FUSO: data absoluta SEM fuso e AMBIGUA e tem de RECUSAR (2026-09-05). O `--desde`
  #      deste script vai para `git rev-list --before=`, que le data nua como hora LOCAL; os scripts
  #      irmaos (verify-edge-eco / verify-edge-escrita) mandam o MESMO flag para o psql, cuja sessao
  #      e UTC — e a doc dos dois prescreve "timestamp do merge, UTC". Quem copia um timestamp UTC
  #      acerta em dois e erra neste. Medido em GMT-3: `--desde "2026-09-05 17:34"` resolveu para o
  #      proprio merge das 19:40Z (excluindo-o) e devolveu `nenhuma edge na janela` com exit 0 sobre
  #      uma janela de DUAS edges. Num script que APAGA pendencia, janela deslocada nao gera um chip
  #      a mais: gera ZERO chips, em verde — a "ausencia fabricada" do PRE_SONDA_FONTE (#2156)
  #      entrando pela porta da JANELA em vez da porta do CAMPO.
  #      Marcador ASCII de caixa fixa de proposito: a suite roda nos DOIS locales (#1483), e casar
  #      "AMBIGUO" com acento casaria a codificacao, nao o ramo.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "2026-08-28 14:00" 2>&1)"; rc=$?
  if [ "$rc" -eq 3 ] && tem 'DESDE_SEM_FUSO' "$out" && ! tem 'nenhuma edge' "$out"
  then ok "--desde: data sem fuso -> DESDE_SEM_FUSO, exit 3, nunca 'nenhuma edge'"
  else bad "data sem fuso devia RECUSAR com exit 3 (rc=$rc): ${out:0:140}"; fi

  # o PAR MINIMO e o que da valor ao caso acima: MESMA data, so o sufixo muda. Sem este lado, um
  # guard que recusasse TUDO passaria no 14c sem guardar coisa nenhuma.
  for _suf in "UTC" "Z" "-0300" "+00:00"; do
    case "$_suf" in
      Z) _d="2026-08-28T14:00:00Z" ;;
      *) _d="2026-08-28 14:00 $_suf" ;;
    esac
    out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
           bash "$ALVO" --desde "$_d" 2>&1)"; rc=$?
    if [ "$rc" -ne 3 ] && ! tem 'DESDE_SEM_FUSO' "$out"
    then ok "--desde: fuso explicito ($_suf) passa pelo guard"
    else bad "fuso explicito ($_suf) nao devia ser recusado (rc=$rc): ${out:0:140}"; fi
  done

  # ...e as formas NAO-absolutas (data relativa, SHA) nunca sao ambiguas: nao podem ser recusadas.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "3 hours ago" 2>&1)"; rc=$?
  if [ "$rc" -ne 3 ] && ! tem 'DESDE_SEM_FUSO' "$out"
  then ok "--desde: data RELATIVA nao e ambigua -> passa pelo guard"
  else bad "data relativa nao devia ser recusada (rc=$rc): ${out:0:140}"; fi

  # 14d. a JANELA EFETIVAMENTE USADA sai impressa. O guard so alcanca a forma ambigua; SHA e data
  #      relativa ainda podem resolver para um base surpreendente (worktree atras, REF errada), e
  #      isso se decidia em SILENCIO — inclusive no ramo "nenhuma edge na janela", o unico que
  #      suprime TUDO. Base impresso = janela auditavel na hora em que o veredito e lido.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         FECHO_MAPA_FONTE="" bash "$ALVO" --desde "$(cat "$tmp/base_sha")" 2>&1)"; rc=$?
  if tem 'janela:' "$out" && tem "$(cut -c1-7 < "$tmp/base_sha")" "$out"
  then ok "--desde: imprime a janela efetiva (REF + commit-base resolvido)"
  else bad "janela efetiva devia sair impressa com o base resolvido (rc=$rc): ${out:0:140}"; fi

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

  # 12c. guardrail de FORMA da 3a classe (casamento por request_id): ela e o unico vinculo que
  #      alcanca o bundle pre-#1789, e as DUAS travas dela nao podem sumir — o eco de probe (senao
  #      um id de resposta de CRON vira "prova de sonda") e a recusa de slug CONTRADITORIO (senao
  #      uma colagem trocada FABRICA identidade, que e o pior erro possivel neste script).
  : > "$tmp/sql.txt"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  sqltxt="$(cat "$tmp/sql.txt")"
  if tem 'JOIN vinculo v ON v.request_id = b.id' "$sqltxt" \
     && tem "COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" "$sqltxt" \
     && tem "(b.content::jsonb) ->> 'probe'  = 'true'" "$sqltxt"
  then ok "SQL casa por request_id exigindo eco de probe e recusando slug contraditorio"
  else bad "3a classe sem trava: id de cron ou colagem trocada viraria prova de sonda"; fi

  # 12d. guardrail de FORMA da contagem de anonimas: sem `NOT (? 'edge')` ela contaria as respostas
  #      que JA casam por eco, e "ha sonda anonima" apareceria em toda janela — aviso que cansa e
  #      some. Sem `NOT EXISTS (vinculo)`, a linha ja atribuida seria contada duas vezes.
  if tem "NOT ((b.content::jsonb) ? 'edge')" "$sqltxt" \
     && tem 'NOT EXISTS (SELECT 1 FROM vinculo v WHERE v.request_id = b.id)' "$sqltxt" \
     && tem "'#anonimas ' || n" "$sqltxt"
  then ok "SQL conta como anonima so o que NAO ecoa slug nem tem vinculo"
  else bad "contagem de anonimas sem os dois filtros — o aviso apareceria sempre"; fi

  # 15. INERTE: edge APOSENTADA (handler responde 410 antes de qualquer logica) tocada por PR — o
  #     caso real e a `tint-import`, que carrega o espelho VERBATIM do parse-decimal-br e entra na
  #     janela a cada PR do parser (#2184), saindo SEM_PROVA/chip por um deploy que NAO muda nada.
  #     A prova e o marcador DECLARADO `// EDGE-APOSENTADA:` no index.ts da REF. Tres edges numa
  #     fixture git, e a assercao que importa e a ARVORE lida (lovable-deploy-verify §Passo 3, "o
  #     closure le a REF"): marcador so no working tree NAO vale; marcador na REF vale mesmo que o
  #     working tree o tenha perdido.
  local repo3="$tmp/repo3-${LC_ALL:-x}"
  if [ ! -d "$repo3" ]; then
    mkdir -p "$repo3/supabase/functions/_shared" "$repo3/supabase/functions/edge-aposentada" \
             "$repo3/supabase/functions/edge-marcador-so-no-wt" "$repo3/supabase/functions/edge-marcador-so-na-ref"
    git -C "$repo3" init -q -b main 2>/dev/null
    git -C "$repo3" config user.email t@t; git -C "$repo3" config user.name t
    printf '// EDGE-APOSENTADA: 410 desde sempre\nDeno.serve(() => new Response(null, { status: 410 }));\n' \
      > "$repo3/supabase/functions/edge-aposentada/index.ts"
    printf 'Deno.serve(() => new Response("viva"));\n' \
      > "$repo3/supabase/functions/edge-marcador-so-no-wt/index.ts"
    printf '// EDGE-APOSENTADA: 410 desde sempre\nDeno.serve(() => new Response(null, { status: 410 }));\n' \
      > "$repo3/supabase/functions/edge-marcador-so-na-ref/index.ts"
    cat > "$repo3/supabase/functions/_shared/sonda-fingerprints.ts" <<MAPA3
export const FONTE_SHA256: Record<string, string> = {
  "edge-do-shared": "$SHA_NOVO",
};
MAPA3
    git -C "$repo3" add -A >/dev/null; git -C "$repo3" commit -qm base
    git -C "$repo3" update-ref refs/remotes/origin/main HEAD
    # working tree DIVERGE da REF nas duas edges de controle, sem commit:
    printf '// EDGE-APOSENTADA: so aqui, nao mergeado\nDeno.serve(() => new Response("viva"));\n' \
      > "$repo3/supabase/functions/edge-marcador-so-no-wt/index.ts"
    printf 'Deno.serve(() => new Response("ressuscitada no wt"));\n' \
      > "$repo3/supabase/functions/edge-marcador-so-na-ref/index.ts"
  fi

  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo3" FECHO_MAPA_FONTE="" \
         bash "$ALVO" edge-aposentada 2>&1)"; rc=$?
  if tem 'INERTE' "$out" && tem 'edge-aposentada' "$out" && tem 'founder' "$out" \
     && [ "$rc" -eq 0 ] && ! tem 'abra chip' "$out"
  then ok "marcador EDGE-APOSENTADA na REF -> INERTE, exit 0, sem chip, e diz para nao pedir ao founder"
  else bad "edge aposentada devia dar INERTE/exit 0 sem chip (rc=$rc): ${out:0:120}"; fi

  # 15b. o INERTE nao depende do banco: mecanica quebrada continua nao tendo nada a dizer sobre um
  #      handler que responde 410 antes de executar — o veredito vem do git, nao da sonda.
  out="$(STUB_MODO=mudo AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo3" FECHO_MAPA_FONTE="" \
         bash "$ALVO" edge-aposentada 2>&1)"; rc=$?
  if tem 'INERTE' "$out" && [ "$rc" -eq 0 ]
  then ok "INERTE sobrevive a mecanica quebrada (a prova e o git, nao o banco)"
  else bad "INERTE devia valer com banco mudo (rc=$rc): ${out:0:120}"; fi

  # 15c. a ARVORE: marcador so no working tree NAO absolve; marcador so na REF absolve.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo3" FECHO_MAPA_FONTE="" \
         bash "$ALVO" edge-marcador-so-no-wt edge-marcador-so-na-ref 2>&1)"; rc=$?
  linha_wt="$(printf '%s' "$out" | command grep -- 'edge-marcador-so-no-wt')"
  linha_ref="$(printf '%s' "$out" | command grep -- 'edge-marcador-so-na-ref')"
  if tem 'SEM_PROVA' "$linha_wt" && ! tem 'INERTE' "$linha_wt" \
     && tem 'INERTE' "$linha_ref" && [ "$rc" -eq 1 ]
  then ok "marcador so no working tree -> SEM_PROVA; so na REF -> INERTE (o closure le a REF)"
  else bad "marcador devia ser lido da REF e nunca do working tree (rc=$rc): ${out:0:160}"; fi
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
  # (a6) o remedio some do rodape: o ramo "nenhuma sonda" volta a dizer so "INDETERMINADO" e o
  #      leitor conclui "espere o cron" — que para 24 das 54 edges do mapa NUNCA vem (sem cron
  #      nenhum: webhook/sob demanda). Foi o erro cometido ao vivo pelo autor do proprio script.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "registro do ramo 'nenhuma sonda' indo para o vazio (rodape sem remedio)" \
    's#>> "$tmp/sem_sonda"#>> /dev/null#'
  # (a5) a via (c) para de contribuir alvos: a edge FORA do mapa afetada so por `_shared/` volta a
  #      ser invisivel — exatamente a classe de 41 edges medida em 2026-09-05. Sem esta sabotagem o
  #      caso 13b poderia estar verde por outro motivo (a via (b) pegando a pasta, p.ex.).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "via (c) sem contribuir alvos (grafo de imports mudo)" \
    's%    cat "$tmp/afetadas" >> "$tmp/alvos"%    :%'
  # (a6) a via (c) deixa de ser fail-closed: erro do auxiliar vira seguir-em-frente, e lista vazia
  #      por ERRO volta a ser indistinguivel de lista vazia por merito
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "via (c) seguindo em frente quando o auxiliar falha" \
    's%    if ! bun "$AFETADAS_TS"%    if false \&\& ! bun "$AFETADAS_TS"%'
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
  # ---- as 5 abaixo guardam o ramo da SONDA ANONIMA (2026-09-05). O bundle anterior ao #1789 responde
  #      {ok,probe,versao} e NAO diz de quem e: a resposta existe e nao e atribuivel. O erro caro
  #      nao e o veredito (segue INDETERMINADO nos dois desenhos) — e o MOTIVO: "nenhuma sonda na
  #      janela" manda sondar de novo o que ja foi sondado, e some com o chip que importava.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "ramo da sonda anonima neutralizado (volta a alegar ausencia)" \
    's%elif \[ -z "$servido" \] && \[ "$n_anonimas" -gt 0 \]; then%elif false; then%'
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "linha #anonimas ausente degradando para zero em vez de exit 2" \
    's%""|\*\[!0-9\]\*) mecanica_ok=0%""|*[!0-9]*) n_anonimas=0; :%'
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "slug forasteiro em --request-ids passando calado" \
    's%if ! command grep -Fxq -- "$_slug" "$tmp/alvos"; then%if false; then%'
  # `--request-ids` deixando de ser extraido dos args vira "slug" e depois chip fantasma
  sabota "--request-ids deixando de ser reconhecido como flag" \
    's%    --request-ids)   REQ_IDS=%    --xxxxxxxxxxxx)  REQ_IDS=%'
  # o par validado que nao chega ao SQL: o vinculo vira decorativo e o escape nao escapa
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "par colado nao chegando ao SQL (CTE vinculo sempre vazia)" \
    's%\[ -n "$vinculo_values" \] && vinculo_sql="VALUES $vinculo_values"%:%'

  # (i) o marcador de aposentadoria deixa de ser lido: a edge aposentada volta a SEM_PROVA/chip —
  #     o deploy inerte volta a ser pedido ao founder a cada PR do parser (o custo do #2184)
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "marcador EDGE-APOSENTADA ignorado (edge aposentada volta a SEM_PROVA)" \
    's%| command grep -qF -- "$MARCADOR_APOSENTADA"; then%| false; then%'
  # (j) o marcador passa a ser lido do WORKING TREE em vez da REF: fatia nao mergeada absolveria e
  #     marcador mergeado que o wt perdeu voltaria a chip — o furo de arvore do lovable-deploy-verify
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  sabota "marcador lido do working tree em vez da REF" \
    's%git -C "$RAIZ" show "$REF:supabase/functions/$slug/index.ts" 2>/dev/null%cat "$RAIZ/supabase/functions/$slug/index.ts" 2>/dev/null%'

  # (d) a query perde o "mais recente por edge\"
  sabota "SQL sem DISTINCT ON (edge)" \
    's%SELECT DISTINCT ON (edge) edge%SELECT edge%'

  # guard de fuso: as duas sabotagens sao SIMETRICAS de proposito, porque o guard erra dos DOIS
  # lados e cada lado tem um caso diferente para pegar. Frouxo demais (aceita tudo) devolve o bug
  # original — janela deslocada suprimindo chip em verde. Apertado demais (recusa tudo) quebraria o
  # /fecho inteiro, e so o PAR MINIMO do 14c enxerga isso: sem ele, um guard que recusasse toda
  # data passaria na suite alegando que "guarda".
  sabota "fuso: sufixo aceitando QUALQUER coisa (guard frouxo, volta o bug)" \
    '/\*gmt\*/s/.*/          *) ;;/'
  sabota "fuso: sufixo nao casando NADA (guard apertado, recusa UTC legitimo)" \
    '/\*gmt\*/s/.*/          __nunca_casa__) ;;/'
  # e a janela impressa: sem ela o ramo que suprime TUDO volta a decidir em silencio.
  sabota "janela efetiva deixando de ser impressa" \
    '/echo "janela:/d'

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
