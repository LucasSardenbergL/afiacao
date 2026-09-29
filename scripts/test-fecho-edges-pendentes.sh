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

# o `chmod u+w` antes do `rm`: as fixtures compartilhadas são só leitura (ver o fim das fixtures)
tmp="$(mktemp -d)"; trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

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

# stub do `pendencias-deploy.ts --json` (o LEDGER durável). LEDGER_MODO controla a resposta —
# inclusive as QUEBRADAS, que são metade do que este arquivo mede: o alvo é o lado que APAGA
# pendência, e ausência de erro não é resposta.
cat > "$tmp/ledger-stub" <<'LSTUB'
#!/usr/bin/env bash
# O TRAÇO de chamadas, antes de tudo (até a chamada sem `--json` conta): "o ledger NEM é consultado"
# é contrato do alvo (mecânica reprovada; janela viva que já decidiu), e uma consulta que não muda a
# classificação é INVISÍVEL na saída — só o traço a mede.
[ -z "${LEDGER_TRACE:-}" ] || printf '%s\n' "${LEDGER_MODO:-confere}" >> "$LEDGER_TRACE"
# o alvo tem de pedir `--json`: sem a flag, o CLI real imprimiria o relatório HUMANO, e ler texto
# como se fosse dado é o defeito que a marca de formato existe para impedir.
case " $* " in *" --json "*) ;; *) echo "stub: chamado SEM --json" >&2; exit 64 ;; esac
j() { printf '{"formato":"%s","ref":"origin/main","tolerarNunca":false,"totalMapeadas":1,"totalObservadas":1,"totalPendentes":0,"totalUrgentes":0,"foraDoMapaHistoricas":[],"vereditos":[%s]}\n' "${1}" "${2}"; }
v() { printf '{"edge":"%s","estado":"%s","esperado":"%s","observado":"%s","versaoEsperada":"v1","versao":"%s","via":"sonda","criado":"2026-09-06 10:00Z","idadeHoras":%s,"diasPendente":null,"escalada":false}' "$1" "$2" "$3" "$4" "$5" "$6"; }
case "${LEDGER_MODO:-confere}" in
  confere)        j 'pendencias-deploy/1' "$(v edge-muda CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 31.5)"; exit 0 ;;
  fonte-errada)   j 'pendencias-deploy/1' "$(v edge-muda CONFERE "$SHA_NOVO" "$SHA_VELHO" v1 31.5)"; exit 0 ;;
  nunca)          j 'pendencias-deploy/1' "$(v edge-muda NUNCA_ATESTADA "$SHA_NOVO" null null null)"; exit 1 ;;
  diverge)        j 'pendencias-deploy/1' "$(v edge-muda DIVERGE_P1 "$SHA_NOVO" "$SHA_VELHO" v0.9 40)"; exit 1 ;;
  sem-fonte-eco)  j 'pendencias-deploy/1' "$(v edge-muda SEM_FONTE_NO_ECO "$SHA_NOVO" sem-campo v1 2)"; exit 1 ;;
  # todas as edges do fixture CONFEREM — para provar que quem responde na janela viva é julgado
  # por ela, e que edge FORA do mapa não é absolvida por rótulo nenhum.
  confere-tudo)   j 'pendencias-deploy/1' "$(v edge-velha CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 30),$(v edge-no-ar CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 30),$(v edge-pre-fonte CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 30),$(v edge-fora-do-mapa CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 30)"; exit 0 ;;
  # a 2ª chave VAZIA: CONFERE para a edge FORA do mapa com `observado` "" — e TODOS os campos depois
  # dele vazios, porque o `read` do alvo (IFS=tab) colapsa campo vazio (tab é espaço-IFS) e o `l_obs`
  # herdaria o campo seguinte. Sem o `-n "$esperado"` do alvo, "" = "" absolve. Quem puxa a consulta é
  # a `edge-muda` (NUNCA_ATESTADA): edge fora do mapa nunca é candidata ao ledger.
  confere-vazio)  j 'pendencias-deploy/1' "$(v edge-muda NUNCA_ATESTADA "$SHA_NOVO" null null null),"'{"edge":"edge-fora-do-mapa","estado":"CONFERE","esperado":"","observado":"","versaoEsperada":"","versao":"","via":"","criado":"","idadeHoras":"","diasPendente":null,"escalada":false}'; exit 1 ;;
  mudo)           exit 0 ;;                                        # exit 0 e stdout VAZIO
  lixo)           echo "relatorio humano: ✅ confere — 46"; exit 0 ;;  # saída que não é JSON
  sem-marca)      j 'outro-contrato/9' "$(v edge-muda CONFERE "$SHA_NOVO" "$SHA_NOVO" v1 31.5)"; exit 0 ;;
  vereditos-ruins) printf '{"formato":"pendencias-deploy/1","vereditos":"nao-e-lista"}\n'; exit 0 ;;
  exit2)          echo "MECANICA: ledger public.deploy_atestacoes NAO existe" >&2; exit 2 ;;
  exit3)          echo "USO: argumento desconhecido" >&2; exit 3 ;;
  ausente)        exit 127 ;;                                      # bun/arquivo que não roda
  # o DEFEITO de 2026-09-10, VERBATIM (pendencias-deploy.ts, `secaoSondaCron`): o banco já sonda um
  # alvo que a allowlist CARREGADA pelo CLI não tem (onda 5 aplicada, `sonda-cron-alvos.ts` velho no
  # disco) — e o remédio impresso é um UPDATE que desativaria o alvo APROVADO (#2464).
  intruso)        printf '%s\n' "$MSG_INTRUSO" >&2; exit 2 ;;
  # ...e o mesmo DEPOIS do `git fetch origin main` que o CLI real faz antes de julgar
  # (pendencias-deploy.ts, `lerEsperados`): a REF anda DURANTE a chamada.
  intruso-apos-fetch)
                  git -C "$FECHO_LEDGER_RAIZ" update-ref refs/remotes/origin/main "$CORRIDA_NOVO"
                  printf '%s\n' "$MSG_INTRUSO" >&2; exit 2 ;;
esac
LSTUB
chmod +x "$tmp/ledger-stub"

# `bun` presente-porém-QUEBRADO, só no PATH do cenário que o pede: `command -v bun` o acha e o
# auxiliar do grafo de imports (via c) sai ≠0 — o modo de falha que o fail-closed da via (c) nomeia
# e que nenhum cenário alcançava (a sabotagem dele ficava VERDE isolada, 2026-09-27).
mkdir -p "$tmp/bun-quebrado"
printf '#!/usr/bin/env bash\necho "bun-quebrado: saida 1 de proposito" >&2\nexit 1\n' > "$tmp/bun-quebrado/bun"
chmod +x "$tmp/bun-quebrado/bun"

# ---------------------------------------------- a CASA do CLI do ledger (fixtures) ---
# O alvo roda o `pendencias-deploy.ts` do WORKING TREE, e só aceita o veredito dele se o fecho de
# imports desse CLI for byte a byte o da REF. Aqui a casa do CLI é um repo git de FIXTURE
# (`FECHO_LEDGER_RAIZ`), nunca o checkout de quem roda a suíte: medir o repo real deixaria esta
# suíte VERMELHA em todo PR que tocasse o fecho do CLI (~3 commits/dia na main) — gate que reprova
# o trabalho alheio por um estado que não é defeito. Mesmo FORMATO do fecho real: import relativo
# com `..` (a allowlist do cron), `./lib/` e o alias `@/` (tsconfig.scripts.json: `@/*` → `src/*`).
cli_base() { # <dir> — HEAD == origin/main, tree limpo: o CLI desta "worktree" É o da REF
  local d="$1"
  mkdir -p "$d/scripts/lib" "$d/src/lib" "$d/supabase/functions/_shared"
  git -C "$d" init -q -b main 2>/dev/null
  git -C "$d" config user.email t@t; git -C "$d" config user.name t
  printf "import { execFileSync } from 'node:child_process';\nimport { julgar } from './lib/pendencias-deploy';\nimport { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';\n" \
    > "$d/scripts/pendencias-deploy.ts"
  # a cadeia do fecho REAL `sonda-versao-sql.ts` → `await import('./canaria-leitor-do-repo')` →
  # `@/lib/gates/limpeza-fonte`: import DINÂMICO, quebrado em linhas como o Prettier quebra, até o alias.
  printf "export const julgar = 1;\nexport async function carregar() {\n  return await import(\n    './canaria'\n  );\n}\n" \
    > "$d/scripts/lib/pendencias-deploy.ts"
  printf "import { erro } from '@/lib/erro-mensagem';\nexport const canaria = erro;\n" > "$d/scripts/lib/canaria.ts"
  printf "export const erro = 'e';\n" > "$d/src/lib/erro-mensagem.ts"
  printf "export const SONDA_CRON_ALVOS = [{ edge: 'edge-a' }];\n" > "$d/supabase/functions/_shared/sonda-cron-alvos.ts"
  # FORA do fecho, de propósito: o mapa muda a cada merge de edge e o CLI o lê pela REF
  # (`lerNaRev`), nunca do disco — e um script vizinho que o CLI não importa.
  printf 'export const FONTE_SHA256 = {};\n' > "$d/supabase/functions/_shared/sonda-fingerprints.ts"
  printf 'export const outro = 1;\n' > "$d/scripts/outro.ts"
  git -C "$d" add -A >/dev/null; git -C "$d" commit -qm base
  git -C "$d" update-ref refs/remotes/origin/main HEAD
}
# a MAIN anda 1 commit mudando <arquivo> e o working tree fica para trás — o estado NORMAL no
# /fecho (branch da sessão squash-mergeada, main andou). Tree LIMPO.
cli_main_anda() { # <dir> <arquivo> <conteudo>
  local d="$1" base; base="$(git -C "$d" rev-parse HEAD)"
  printf '%s\n' "$3" > "$d/$2"
  git -C "$d" commit -qam "main andou: $2"
  git -C "$d" update-ref refs/remotes/origin/main HEAD
  git -C "$d" checkout -q --detach "$base"
}
ALVOS_ONDA5="export const SONDA_CRON_ALVOS = [{ edge: 'edge-a' }, { edge: 'omie-desconto-backfill' }];"
cli_ok="$tmp/cli-ok";               cli_base "$cli_ok"
cli_defasado="$tmp/cli-defasado";   cli_base "$cli_defasado"
cli_main_anda "$cli_defasado" supabase/functions/_shared/sonda-cron-alvos.ts "$ALVOS_ONDA5"
cli_fora="$tmp/cli-fora-do-fecho"; cli_base "$cli_fora"
cli_main_anda "$cli_fora" supabase/functions/_shared/sonda-fingerprints.ts 'export const FONTE_SHA256 = { "x": "y" };'
cli_alias="$tmp/cli-alias";         cli_base "$cli_alias"
cli_main_anda "$cli_alias" src/lib/erro-mensagem.ts "export const erro = 'mudou na main';"
cli_sem_ref="$tmp/cli-sem-ref";     cli_base "$cli_sem_ref"
git -C "$cli_sem_ref" update-ref -d refs/remotes/origin/main
# O TREE SUJO (16n) e a CORRIDA (16o) NÃO moram aqui: o estado deles é o que se mede e é MUTÁVEL (a
# mudança local sem commit; a REF que o stub move DURANTE a chamada). Nascem na rodada, junto do
# caso que os consome — o isolamento vem da estrutura, não da ordem dos resets (Codex, 2026-09-27).
MSG_INTRUSO="❌ MECÂNICA: o banco sonda edge(s) que o repo NÃO aprovou: omie-desconto-backfill. Só a allowlist do repo teve todos os closures históricos executados (\`bun run sonda:cron-prova\`). Desative no banco: UPDATE public.deploy_sonda_alvos SET ativo = false WHERE edge IN ('omie-desconto-backfill');"
export MSG_INTRUSO

# O que fica FORA da rodada é compartilhado pelas ~100 execuções da suíte sob o --falsificar, e é
# SÓ LEITURA por construção, não por convenção: um caso — ou um alvo sabotado — que escrevesse aqui
# falha alto em vez de vazar estado para a rodada seguinte (a classe do --desde poluído, #2639).
# Tudo o que algum caso ESCREVE nasce na rodada: os repos do --desde/INERTE, o tree sujo, a corrida,
# o eco do SQL e o traço do ledger.
chmod -R a-w "$tmp/mapa.ts" "$tmp/pares.txt" "$tmp/psql-stub" "$tmp/ledger-stub" "$tmp/bun-quebrado" \
  "$cli_ok" "$cli_defasado" "$cli_fora" "$cli_alias" "$cli_sem_ref"

export FECHO_MAPA_FONTE="$tmp/mapa.ts" STUB_PARES="$tmp/pares.txt"
export STUB_ANONIMAS=0
export SHA_NOVO SHA_VELHO
# Por padrão o ledger está INDISPONÍVEL nesta suíte: os casos anteriores ao ledger (2026-09-05)
# medem o comportamento SEM ele, e o fail-closed tem de mantê-los idênticos — a prova de que o
# ledger só ACRESCENTA absolvição, nunca muda o resto.
export FECHO_LEDGER_BIN="$tmp/ledger-stub" LEDGER_MODO=ausente
# ...e a casa do CLI, por padrão, EM DIA com a REF: todo caso de ledger acima do 16i é também o
# controle de que a trava de frescura não fabrica defasagem quando o CLI É o da REF.
export FECHO_LEDGER_RAIZ="$cli_ok"

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
# `n_asserts` conta as linhas de assert da suíte em curso — o RECIBO de término (fim da suíte) a imprime
n_asserts=0; terminou=""
ok()  { printf '  \033[32mok\033[0m   %s\n' "${1//$'\n'/ | }"; n_asserts=$((n_asserts + 1)); }
# um assert = UMA linha (`\n` do alvo no dump forjaria linha de outro assert); e, sob o --falsificar,
# a saída INTEIRA do alvo vai para ERROS_DO_ALVO — o dump da mensagem é truncado, e o erro de
# execução que vem depois do corte ficaria fora da camada 4 (Codex, 2026-09-27).
bad() {
  printf '  \033[31mFALHA\033[0m %s\n' "${1//$'\n'/ | }"; fail=1; n_asserts=$((n_asserts + 1))
  if [ -n "${ERROS_DO_ALVO:-}" ]; then printf '%s\n' "${out:-}" >> "$ERROS_DO_ALVO"; fi
}
# quantas chamadas ao CLI do ledger o traço da rodada registrou. O caso ZERA o traço antes de rodar;
# traço que SUMIU não é "zero chamadas" (ausente ≠ zero): devolve `ausente`, que não casa número.
chamadas() { if [ -f "$LEDGER_TRACE" ]; then wc -l < "$LEDGER_TRACE" | tr -d ' '; else echo ausente; fi; }
# marcador ASCII, caixa fixa, sem -i, via `command grep` (o grep do shell é shim p/ ugrep)
tem() { printf '%s' "$2" | command grep -q -- "$1"; }

# --------------------------------------------------------------------- suíte ---
suite() {
  printf '== edges-pendentes (locale=%s) ==\n' "${LC_ALL:-?}"
  # Cada chamada tem o SEU diretório de rodada. Os repos do --desde e do INERTE são MUTADOS pelos
  # casos (o 13c remove o mapa e commita) e eram um por LOCALE, com o base_sha num arquivo comum aos
  # dois: a suíte normal passa uma vez por locale e não sente, mas o --falsificar a chama ~94 vezes
  # no mesmo $tmp — da 3a rodada em diante o --desde caía em TODA rodada, com ou sem sabotagem, e o
  # juiz antigo ("vermelho = dente") aprovava as 46 sabotagens pela poluição (medido 2026-09-27).
  local rodada; rodada="$(mktemp -d "$tmp/rodada.XXXXXX")"
  # ...e o que os STUBS escrevem também: o SQL que o alvo mandou e as chamadas ao CLI do ledger
  export STUB_SQL_ECO="$rodada/sql.txt" LEDGER_TRACE="$rodada/ledger-chamadas"
  n_asserts=0; terminou=""

  # 1. prova POSITIVA: fonte servida == main -> some o chip
  run ok "$tmp/psql-stub" edge-no-ar
  if tem 'NO_AR' "$out" && [ "$rc" -eq 0 ] && ! tem 'RESOLVER_NESTA_SESSAO' "$out"
  then ok "E1 fonte bate com a main -> NO_AR, exit 0, sem chip"
  else bad "E1 fonte batendo devia dar NO_AR/exit 0 (rc=$rc): ${out:0:90}"; fi

  # 2. bundle velho servindo -> chip PROVADO
  run ok "$tmp/psql-stub" edge-velha
  if tem 'DESATUALIZADA' "$out" && [ "$rc" -eq 1 ]
  then ok "E2 fonte diferente -> DESATUALIZADA, exit 1"
  else bad "E2 fonte divergente devia dar DESATUALIZADA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 3. ausencia NAO reprova, mas tambem nao absolve: INDETERMINADO -> chip
  run ok "$tmp/psql-stub" edge-muda
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "E3 sem sonda na janela -> SEM_PROVA, exit 1"
  else bad "E3 edge sem sonda devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi
  # 3b. ...e a saida tem de dizer O QUE FAZER. "nenhuma sonda na janela" NAO se resolve esperando:
  #     nao ha cron de sondagem (93 jobs em cron.job, ZERO com probe) e, medido 2026-09-05, 24 das
  #     54 edges do mapa nao tem cron NENHUM (webhook/sob demanda) — para essas a prova passiva e
  #     IMPOSSIVEL, e net._http_response ainda expira no TTL. O autor do proprio script leu este
  #     ramo como "espere o proximo tick do cron" HORAS depois de escreve-lo, ao verificar dois
  #     deploys reais; a espera nunca terminaria. Mensagem que engana quem a escreveu engana todos.
  #     (Desaninhado de propósito: dentro do `then` do 3, ele SUMIA do log quando o 3 falhava — e a
  #     falsificação exige o mesmo conjunto de asserts executados no controle e na rodada sabotada.)
  if tem 'sonda:sql' "$out"
  then ok "E3b ramo 'nenhuma sonda' aponta o remedio (bun run sonda:sql)"
  else bad "E3b ramo 'nenhuma sonda' sem remedio — o leitor conclui 'espere o cron', que nunca vem"; fi

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
  then ok "E3c DISPARE emite a lista INTEIRA (7/7), sem truncar o comando"
  else bad "E3c comando truncado — faltou:$faltou · linha: ${linha_cmd:0:150}"; fi

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
  then ok "E3d DISPARE carrega a trava --caro invalida + o aviso de fluxo REAL"
  else bad "E3d DISPARE saiu pronto-para-colar sem triagem: ${linha_trava:0:150}"; fi

  # 4. as ~55 edges fora do mapa continuam virando chip como hoje (sem regressao)
  run ok "$tmp/psql-stub" edge-fora-do-mapa
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "E4 edge fora do mapa -> SEM_PROVA, exit 1"
  else bad "E4 edge fora do mapa devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 5. sonda respondeu `nao-mapeada`: a prova nasceu cega, nao e prova
  run ok "$tmp/psql-stub" edge-cega
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ]
  then ok "E5 sonda nao-mapeada -> SEM_PROVA, exit 1"
  else bad "E5 nao-mapeada devia dar SEM_PROVA/exit 1 (rc=$rc): ${out:0:90}"; fi

  # 5b. respondeu a sonda (200 + eco de probe/versao) mas SEM o campo `fonte`: bundle ANTERIOR ao
  #     #1998, que ainda nao conhecia o campo. Isso e prova POSITIVA de que o ar e velho — o oposto
  #     de "nao observei nada" — e ate 2026-09-05 saia como "nenhuma sonda na janela" (7 das 10
  #     edges sondadas em prod naquele dia). Ramo PROPRIO, e nunca alegando ausencia de sonda.
  run ok "$tmp/psql-stub" edge-pre-fonte
  if tem 'PRE_SONDA_FONTE' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'nenhuma sonda' "$out" && ! tem 'NO_AR' "$out"
  then ok "E5b sonda sem o campo fonte -> PRE_SONDA_FONTE (bundle pre-#1998), exit 1"
  else bad "E5b sonda sem fonte devia ter ramo proprio, nunca 'nenhuma sonda' (rc=$rc): ${out:0:110}"; fi

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
  then ok "E5c sonda ANONIMA na janela -> SEM_PROVA que NAO alega ausencia, e aponta --request-ids"
  else bad "E5c com sonda anonima na janela nao pode dizer 'nenhuma sonda' (rc=$rc): ${out:0:140}"; fi

  # 5d. e o contrario tambem: ZERO anonimas continua sendo ausencia de verdade, dita como tal.
  #     Sem este caso o ramo novo poderia virar mensagem UNICA e a distincao morreria.
  export STUB_ANONIMAS=0
  run ok "$tmp/psql-stub" edge-muda
  if tem 'nenhuma sonda em' "$out" && [ "$rc" -eq 1 ] && ! tem 'SONDA_ANONIMA' "$out"
  then ok "E5d zero anonimas -> segue 'nenhuma sonda na janela' (a ausencia de verdade)"
  else bad "E5d sem anonimas a mensagem devia ser a de ausencia (rc=$rc): ${out:0:140}"; fi

  # 5e. DERIVA entre as duas pontas: o SQL nao devolve a linha `#anonimas` e o classificador a le.
  #     Degradar para zero devolveria justamente a mensagem MENTIROSA — entao e fail-closed.
  run sem-anonimas "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "E5e SQL sem a linha #anonimas -> mecanica nao confiavel, exit 2 (nunca degrada para zero)"
  else bad "E5e linha #anonimas ausente devia dar exit 2 (rc=$rc): ${out:0:140}"; fi

  # 5f. `--request-ids` e o ESCAPE, e toda recusa dele e exit 3 (uso), nunca veredito de deploy.
  #     Par malformado aceito em silencio e o modo de falha caro: o operador acha que colou, a
  #     edge segue sem vinculo, e a saida diz "sem sonda" com a mesma cara de sempre.
  #     Todo laço desta suíte imprime UM assert por iteração, com ID próprio (`E5f_<n>`) e nos DOIS
  #     ramos, e fecha com o resumo (`E5f`) também nos dois: a lista de asserts executados é o que o
  #     --falsificar compara com o controle, e um ID que se repete nas iterações perde a multiplicidade
  #     — um aborto que cortasse só iterações não mudaria o CONJUNTO (Codex, 2026-09-27).
  local caso_ruim ruins_ok=1 i=0
  for caso_ruim in "edge-muda" "edge muda=1" "edge-muda=abc" "edge-muda=" "=1" "EDGE=1"; do
    i=$((i + 1))
    run ok "$tmp/psql-stub" edge-muda --request-ids "$caso_ruim"
    if [ "$rc" -eq 3 ]
    then ok "E5f_$i --request-ids '$caso_ruim' -> exit 3"
    else ruins_ok=0; bad "E5f_$i --request-ids '$caso_ruim' devia ser exit 3 (rc=$rc)"; fi
  done
  if [ "$ruins_ok" = 1 ]
  then ok "E5f --request-ids malformado -> exit 3 nos 6 formatos ruins"
  else bad "E5f --request-ids malformado: ao menos um formato passou (acima)"; fi

  # 5g. slug que nao esta na leva: o typo deixaria a edge de verdade SEM o vinculo que o operador
  #     acha que deu — mesma trava do `--caro` forasteiro do sonda:sql.
  run ok "$tmp/psql-stub" edge-muda --request-ids "edge-mudaa=99"
  if [ "$rc" -eq 3 ] && tem 'SLUG_FORA_DA_LEVA' "$out"
  then ok "E5g --request-ids com slug fora da leva -> exit 3 (typo nao passa calado)"
  else bad "E5g slug forasteiro devia dar exit 3 (rc=$rc): ${out:0:120}"; fi

  # 5h. o par BOM entra no SQL como VALUES, e sem ele a CTE nasce vazia por WHERE false — a FORMA
  #     do SQL e a mesma nos dois caminhos, senao o guardrail textual mede uma consulta que nao roda.
  : > "$STUB_SQL_ECO"; run ok "$tmp/psql-stub" edge-muda --request-ids "edge-muda=777" > /dev/null
  if tem "VALUES ('edge-muda', 777::bigint)" "$(cat "$STUB_SQL_ECO")"
  then ok "E5h --request-ids bom vira VALUES no SQL"
  else bad "E5h o par colado nao chegou ao SQL: $(head -c 120 "$STUB_SQL_ECO")"; fi
  : > "$STUB_SQL_ECO"; run ok "$tmp/psql-stub" edge-muda > /dev/null
  if tem 'SELECT NULL::text, NULL::bigint WHERE false' "$(cat "$STUB_SQL_ECO")"
  then ok "E5h2 sem --request-ids a CTE vinculo nasce vazia (mesma FORMA de SQL)"
  else bad "E5h2 sem colagem a CTE vinculo devia nascer vazia: $(head -c 120 "$STUB_SQL_ECO")"; fi

  # 6. O TESTE-SENTINELA: wrapper PRESENTE porem MUDO. A mesma edge que no caso 1 era NO_AR tem de
  #    voltar a ser pendencia — `command -v` acharia o arquivo e esvaziaria o guard.
  run mudo "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "E6 psql presente-porem-MUDO -> fail-closed: SEM_PROVA, exit 2"
  else bad "E6 psql mudo devia manter a pendencia com exit 2 (rc=$rc): ${out:0:90}"; fi

  # 6b. o wrapper que responde `SET SET 1` e o BOM: exigir a saida inteira == "1" reprovaria ele e
  #     o gate nasceria travado em exit 2 (medido contra o banco real antes de entregar).
  run so-set "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "E6b psql que so abre sessao (SET SET, sem resultado) -> fail-closed, exit 2"
  else bad "E6b psql sem resultado devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 6c. wrapper que responde a CONSULTA mas nao a sonda `SELECT 1`. A sonda POSITIVA e o guard,
  #     e ele tem de reprovar sozinho — sem depender de o resultado tambem vir malformado.
  run mudo-sonda "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'NO_AR' "$out"
  then ok "E6c psql que responde a consulta mas nao a sonda -> fail-closed, exit 2"
  else bad "E6c sonda sem resposta positiva devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 7. a consulta estourou -> mecanica nao confiavel, tudo pendente
  run erro-query "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "E7 consulta com erro -> fail-closed, exit 2"
  else bad "E7 erro na consulta devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 8. wrapper AUSENTE
  run ok "$tmp/nao-existe" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "E8 psql ausente -> fail-closed, exit 2"
  else bad "E8 psql ausente devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 9. mapa ilegivel: sem regua nao ha como absolver ninguem
  FECHO_MAPA_FONTE="$tmp/mapa-que-nao-existe.ts" run ok "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "E9 mapa ilegivel -> fail-closed, exit 2"
  else bad "E9 mapa ilegivel devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 10. janela vem de env -> nao pode entrar crua no SQL
  FECHO_JANELA_TTL="6 hours'; DROP TABLE x --" run ok "$tmp/psql-stub" edge-no-ar
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ]
  then ok "E10 janela invalida (injecao) -> recusa, exit 2"
  else bad "E10 janela invalida devia dar exit 2 (rc=$rc): ${out:0:90}"; fi

  # 11. uso invalido
  run ok "$tmp/psql-stub"
  if [ "$rc" -eq 3 ]
  then ok "E11 sem argumentos -> exit 3"
  else bad "E11 sem argumentos devia dar exit 3 (rc=$rc)"; fi

  # 13. modo --desde: a UNIAO das duas vias, num repo git de verdade. O que se prova aqui e a
  #     ENUMERACAO (quem entra na lista), nao a classificacao — e o furo caro e o `_shared/`:
  #     nenhuma das duas vias enxerga as edges afetadas por ele sem o mapa de fingerprints.
  # um repo POR PASSADA (o diretorio da rodada): o 2o caso deste bloco mutila o repo (remove o
  # mapa), e reusar o mesmo diretorio faria o 1o caso rodar contra um repo ja quebrado — vermelho falso.
  local repo="$rodada/repo"
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
    printf '%s' "$base_sha" > "$rodada/base_sha"
  fi

  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         FECHO_MAPA_FONTE="" bash "$ALVO" --desde "$(cat "$rodada/base_sha")" 2>&1)"; rc=$?
  # a edge afetada SO por _shared/ tem de aparecer: a via (b) nao a ve, a via (a) sim
  if tem 'edge-do-shared' "$out" && ! tem '_shared ' "$out"
  then ok "E13 --desde: _shared/ puxa a edge afetada e _shared NAO entra como edge"
  else bad "E13 --desde devia listar edge-do-shared e nunca _shared (rc=$rc): ${out:0:120}"; fi

  # 13b. a via (c): edge FORA do mapa afetada so por `_shared/`. Sem o grafo de imports ela nao
  #      entra por via nenhuma — nao vira chip e a pendencia some por AUSENCIA DE DADO, que e o
  #      modo de falha caro de um script que APAGA pendencia.
  if tem 'edge-fora-do-mapa' "$out"
  then ok "E13b --desde: edge FORA do mapa afetada por _shared/ entra pelo grafo de imports"
  else bad "E13b edge-fora-do-mapa sumiu: _shared/ mudou, ela importa, e nenhuma via a enxergou"; fi

  # 13d. a via (c) FALHANDO: o auxiliar do grafo de imports sai !=0 (`bun` presente-porem-quebrado,
  #      que `command -v` aprova). Lista vazia por ERRO e indistinguivel de lista vazia por merito:
  #      seguir em frente classificaria so o que as vias (a) e (b) viram, e a `edge-fora-do-mapa`
  #      sumiria calada, com exit 1 e chip para as outras. Nenhum cenario fazia o auxiliar falhar, e a
  #      sabotagem deste fail-closed ficava VERDE (medido 2026-09-27). O `bun-quebrado` na saida prova
  #      que o caso CHEGOU ao auxiliar (o stderr dele e repassado): sem essa marca, o exit 2 podia vir
  #      de outro ramo. Antes do 13c, que tira o mapa do repo.
  out="$(PATH="$tmp/bun-quebrado:$PATH" STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         FECHO_MAPA_FONTE="" bash "$ALVO" --desde "$(cat "$rodada/base_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ] && tem 'bun-quebrado' "$out" && ! tem 'SEM_PROVA' "$out" \
     && ! tem 'RESOLVER_NESTA_SESSAO' "$out"
  then ok "E13d --desde: auxiliar do grafo FALHANDO (bun presente-porem-quebrado) -> exit 2, nada classificado"
  else bad "E13d auxiliar do grafo falhando devia dar exit 2 sem classificar (rc=$rc): ${out:0:160}"; fi

  # mapa ilegivel + _shared/ tocado = nao sei quais edges foram afetadas -> exit 2, nunca "nada"
  git -C "$repo" rm -q --cached supabase/functions/_shared/sonda-fingerprints.ts >/dev/null 2>&1
  rm -f "$repo/supabase/functions/_shared/sonda-fingerprints.ts"
  git -C "$repo" commit -qm "sem mapa" >/dev/null 2>&1
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "$(cat "$rodada/base_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ] && ! tem 'nenhuma edge na janela' "$out"
  then ok "E13c --desde: _shared/ sem mapa legivel -> exit 2, nunca 'nenhuma edge'"
  else bad "E13c _shared sem mapa devia dar exit 2 e nao absolver (rc=$rc): ${out:0:120}"; fi

  # 14b. A JANELA ANTERIOR AO MAPA — o caso que travava o Passo 3 do /fecho em exit 2 (medido
  #      2026-09-05 com `--desde "2026-08-21 20:00"`: o commit-base e anterior ao #1998, que criou
  #      `sonda-fingerprints.ts`). As duas pontas do mapa NAO tem o mesmo papel: `mapa_agora` e
  #      indispensavel (sem ele nao ha `esperado` para ninguem), mas `mapa_base` so ESTREITA a
  #      enumeracao. Faltando ele o diff nao casa par nenhum e a via (a) emite o mapa INTEIRO como
  #      alvo — superconjunto SEGURO. Desistir ai joga fora o sinal justamente na janela em que
  #      MAIS edge foi afetada (41 das 95, na janela medida).
  local repo2="$rodada/repo-nasce"
  if [ ! -d "$repo2" ]; then
    mkdir -p "$repo2/supabase/functions/_shared" "$repo2/supabase/functions/edge-do-shared"
    git -C "$repo2" init -q -b main 2>/dev/null
    git -C "$repo2" config user.email t@t; git -C "$repo2" config user.name t
    printf 'x\n' > "$repo2/supabase/functions/_shared/lib.ts"
    printf 'import "../_shared/lib.ts"\n' > "$repo2/supabase/functions/edge-do-shared/index.ts"
    # commit-base SEM o mapa: e exatamente como a main estava antes do #1998
    git -C "$repo2" add -A >/dev/null; git -C "$repo2" commit -qm "base sem mapa"
    git -C "$repo2" rev-parse HEAD > "$rodada/base2_sha"
    printf 'y\n' > "$repo2/supabase/functions/_shared/lib.ts"
    cat > "$repo2/supabase/functions/_shared/sonda-fingerprints.ts" <<MAPA2
export const FONTE_SHA256: Record<string, string> = {
  "edge-do-shared": "$SHA_NOVO",
};
MAPA2
    git -C "$repo2" add -A >/dev/null; git -C "$repo2" commit -qm "shared + mapa nasce"
    git -C "$repo2" update-ref refs/remotes/origin/main HEAD
  fi
  printf 'edge-do-shared %s\n' "$SHA_NOVO" > "$rodada/pares-shared.txt"

  # o SINAL tem de sobreviver: com a fonte servida batendo, a edge sai NO_AR e o chip some
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo2" \
         STUB_PARES="$rodada/pares-shared.txt" FECHO_MAPA_FONTE="" \
         bash "$ALVO" --desde "$(cat "$rodada/base2_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && tem 'NO_AR' "$out" && tem 'mapa_base ausente' "$out"
  then ok "E14b --desde: janela anterior ao mapa -> enumera pelo mapa INTEIRO e preserva o NO_AR"
  else bad "E14b janela anterior ao mapa devia classificar, nao exit 2 (rc=$rc): ${out:0:140}"; fi

  # e o fail-closed CONTINUA: sem fonte servida, a MESMA edge cai para SEM_PROVA, nunca NO_AR
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo2" \
         STUB_PARES=/dev/null FECHO_MAPA_FONTE="" \
         bash "$ALVO" --desde "$(cat "$rodada/base2_sha")" 2>&1)"; rc=$?
  if [ "$rc" -eq 1 ] && tem 'SEM_PROVA' "$out" && ! tem 'NO_AR' "$out"
  then ok "E14b2 --desde: janela anterior ao mapa, sem sonda -> SEM_PROVA (fail-closed intacto)"
  else bad "E14b2 sem sonda devia cair para SEM_PROVA, nunca NO_AR (rc=$rc): ${out:0:140}"; fi

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
  then ok "E14c --desde: data sem fuso -> DESDE_SEM_FUSO, exit 3, nunca 'nenhuma edge'"
  else bad "E14c data sem fuso devia RECUSAR com exit 3 (rc=$rc): ${out:0:140}"; fi

  # o PAR MINIMO e o que da valor ao caso acima: MESMA data, so o sufixo muda. Sem este lado, um
  # guard que recusasse TUDO passaria no 14c sem guardar coisa nenhuma.
  local lote_ok=1; i=0
  for _suf in "UTC" "Z" "-0300" "+00:00"; do
    i=$((i + 1))
    case "$_suf" in
      Z) _d="2026-08-28T14:00:00Z" ;;
      *) _d="2026-08-28 14:00 $_suf" ;;
    esac
    out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
           bash "$ALVO" --desde "$_d" 2>&1)"; rc=$?
    if [ "$rc" -ne 3 ] && ! tem 'DESDE_SEM_FUSO' "$out"
    then ok "E14c2_$i --desde: fuso explicito ($_suf) passa pelo guard"
    else lote_ok=0; bad "E14c2_$i fuso explicito ($_suf) nao devia ser recusado (rc=$rc): ${out:0:140}"; fi
  done
  if [ "$lote_ok" = 1 ]
  then ok "E14c2 --desde: fuso explicito passa pelo guard nas 4 formas"
  else bad "E14c2 --desde: ao menos uma forma com fuso explicito foi recusada (acima)"; fi

  # ...e as formas NAO-absolutas (data relativa, SHA) nunca sao ambiguas: nao podem ser recusadas.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "3 hours ago" 2>&1)"; rc=$?
  if [ "$rc" -ne 3 ] && ! tem 'DESDE_SEM_FUSO' "$out"
  then ok "E14c3 --desde: data RELATIVA nao e ambigua -> passa pelo guard"
  else bad "E14c3 data relativa nao devia ser recusada (rc=$rc): ${out:0:140}"; fi

  # 14c'. GUARD DE HORA: data absoluta SEM HORA tem de RECUSAR, com ou sem fuso (2026-09-27). O
  #       `approxidate` do git completa a hora que falta com a hora ATUAL do relogio, nao com a
  #       meia-noite, e o fuso nao salva: `"2026-09-27 UTC"` virou 2026-09-27 23:09:39Z. Medido
  #       executando este script num fixture com um merge de edge as 00:00:30Z: base = o proprio
  #       merge, `nenhuma edge na janela`, exit 0. O guard de fuso deixava a forma passar (tem
  #       `UTC`), e o remedio que ele imprimia para a data NUA era `"<data> UTC"` — a propria forma
  #       do bug. Os IDs `H<n>` abrem a mensagem porque o --falsificar exige o vermelho DESTE assert,
  #       nao "a suite ficou vermelha" (docs/historico/falsificacao-exit-nao-e-dente.md).
  # H1: data COM fuso e SEM hora — a forma que passava pelo guard de fuso.
  lote_ok=1; i=0
  for _d in "2026-09-27 UTC" "2026-09-27 +0000" "2026-09-27Z" "2026/09/27 GMT"; do
    i=$((i + 1))
    out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
           bash "$ALVO" --desde "$_d" 2>&1)"; rc=$?
    if [ "$rc" -eq 3 ] && tem 'DESDE_SEM_HORA' "$out" && ! tem 'DESDE_SEM_FUSO' "$out" \
       && ! tem 'nenhuma edge' "$out"
    then ok "H1_$i --desde: data com fuso e SEM hora ($_d) -> DESDE_SEM_HORA, exit 3"
    else lote_ok=0; bad "H1_$i data com fuso e sem hora ($_d) devia RECUSAR com DESDE_SEM_HORA (rc=$rc): ${out:0:140}"; fi
  done
  if [ "$lote_ok" = 1 ]
  then ok "H1 --desde: data com fuso e SEM hora -> DESDE_SEM_HORA nas 4 formas"
  else bad "H1 --desde: ao menos uma data com fuso e sem hora passou pelo guard (acima)"; fi

  # H2: `±hh:mm` sem hora antes NAO e fuso para o git: `"2026-09-27 -03:00"` virou 06:00Z (leu
  #     `03:00` como HORA LOCAL) e `"2026-09-27 +00:00"`, 03:00Z. Um detector de hora ingenuo
  #     (`[0-9]:[0-9][0-9]` solto) casa o proprio offset e deixa a forma passar pelos dois guards.
  lote_ok=1; i=0
  for _d in "2026-09-27 -03:00" "2026-09-27 +00:00"; do
    i=$((i + 1))
    out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
           bash "$ALVO" --desde "$_d" 2>&1)"; rc=$?
    if [ "$rc" -eq 3 ] && tem 'DESDE_SEM_HORA' "$out" && ! tem 'nenhuma edge' "$out"
    then ok "H2_$i --desde: offset sem hora ($_d) nao conta como hora -> DESDE_SEM_HORA"
    else lote_ok=0; bad "H2_$i offset sem hora ($_d) devia RECUSAR com DESDE_SEM_HORA (rc=$rc): ${out:0:140}"; fi
  done
  if [ "$lote_ok" = 1 ]
  then ok "H2 --desde: offset sem hora nao conta como hora nas 2 formas"
  else bad "H2 --desde: ao menos um offset sem hora passou como hora (acima)"; fi

  # H3: data NUA (sem hora e sem fuso): a HORA se diagnostica primeiro, e o remedio impresso e
  #     `"<data> 00:00 UTC"` — nunca `"<data> UTC"`, que o git le como a hora de agora.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         bash "$ALVO" --desde "2026-09-27" 2>&1)"; rc=$?
  if [ "$rc" -eq 3 ] && tem 'DESDE_SEM_HORA' "$out" && tem '"2026-09-27 00:00 UTC"' "$out" \
     && ! tem '"2026-09-27 UTC"' "$out"
  then ok "H3 --desde: data nua -> DESDE_SEM_HORA, remedio '<data> 00:00 UTC' (nunca '<data> UTC')"
  else bad "H3 data nua devia recusar pela HORA e sugerir '<data> 00:00 UTC' (rc=$rc): ${out:0:160}"; fi

  # H4: o PAR MINIMO — a MESMA data COM hora passa pelos DOIS guards. Sem este lado, um guard que
  #     recusasse toda data passaria no H1-H3 alegando que guarda. Hora de 1 digito, `T`/`t` do ISO
  #     e offset colado na hora sao formas que o detector de hora tem de reconhecer.
  lote_ok=1; i=0
  for _d in "2026-09-27 00:00 UTC" "2026-09-27T00:00:00Z" "2026-09-27 9:05 UTC" \
            "2026-09-27t14:00z" "2026-09-27 14:00-03:00"; do
    i=$((i + 1))
    out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
           bash "$ALVO" --desde "$_d" 2>&1)"; rc=$?
    if [ "$rc" -ne 3 ] && ! tem 'DESDE_SEM_HORA' "$out" && ! tem 'DESDE_SEM_FUSO' "$out"
    then ok "H4_$i --desde: data COM hora e fuso ($_d) passa pelos dois guards"
    else lote_ok=0; bad "H4_$i data com hora e fuso ($_d) nao devia ser recusada (rc=$rc): ${out:0:140}"; fi
  done
  if [ "$lote_ok" = 1 ]
  then ok "H4 --desde: data COM hora e fuso passa pelos dois guards nas 5 formas"
  else bad "H4 --desde: ao menos uma data com hora e fuso foi recusada (acima)"; fi

  # 14d. a JANELA EFETIVAMENTE USADA sai impressa. O guard so alcanca a forma ambigua; SHA e data
  #      relativa ainda podem resolver para um base surpreendente (worktree atras, REF errada), e
  #      isso se decidia em SILENCIO — inclusive no ramo "nenhuma edge na janela", o unico que
  #      suprime TUDO. Base impresso = janela auditavel na hora em que o veredito e lido.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo" \
         FECHO_MAPA_FONTE="" bash "$ALVO" --desde "$(cat "$rodada/base_sha")" 2>&1)"; rc=$?
  if tem 'janela:' "$out" && tem "$(cut -c1-7 < "$rodada/base_sha")" "$out"
  then ok "E14d --desde: imprime a janela efetiva (REF + commit-base resolvido)"
  else bad "E14d janela efetiva devia sair impressa com o base resolvido (rc=$rc): ${out:0:140}"; fi

  # 12. guardrail de FORMA do SQL: o stub nao executa SQL, entao o que da para provar aqui e que a
  #     consulta pede a resposta MAIS RECENTE por edge. Sem isso, um deploy no meio da janela deixa
  #     o bundle velho no resultado e ele seria lido como prova (o caso do omie-vendas-sync).
  : > "$STUB_SQL_ECO"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  if tem 'DISTINCT ON (edge)' "$(cat "$STUB_SQL_ECO")" && tem 'created DESC' "$(cat "$STUB_SQL_ECO")"
  then ok "E12 SQL pede a resposta mais recente por edge (DISTINCT ON + created DESC)"
  else bad "E12 SQL sem DISTINCT ON (edge)/created DESC — deploy no meio da janela viraria prova falsa"; fi

  # 12b. guardrail de FORMA do ramo pre-#1998: a consulta tem de ADMITIR a resposta sem `fonte`
  #      (com `? 'fonte'` cru ela some antes de ser classificada, e a edge cai em "nenhuma sonda"),
  #      e ao admiti-la tem de exigir o eco POSITIVO de sonda — sem o `probe`, QUALQUER 200 com um
  #      campo `edge` entraria como se fosse resposta de sonda, e isso afrouxaria o fail-closed.
  : > "$STUB_SQL_ECO"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  #      Apertado em 2026-09-27: `->> 'probe'` e `'sem-campo-fonte'` SOLTOS casavam também a 3a
  #      classe (o JOIN por request_id e o CASE dela) — tirar a trava ou trocar o sentinela SÓ da 2a
  #      classe deixava este assert verde. O juiz antigo do --falsificar não via (a poluição entre
  #      rodadas pintava tudo de vermelho); com a rodada isolada, as duas sabotagens ficavam verdes.
  if tem "NOT ((content::jsonb) ? 'fonte')" "$(cat "$STUB_SQL_ECO")" \
     && tem "AND (content::jsonb) ->> 'probe'  = 'true'" "$(cat "$STUB_SQL_ECO")" \
     && tem "'sem-campo-fonte'  *AS fonte" "$(cat "$STUB_SQL_ECO")"
  then ok "E12b SQL admite a resposta sem \`fonte\`, exige o eco de probe e emite o mesmo sentinela"
  else bad "E12b SQL sem o ramo 'sem fonte' + probe — 200 sondado voltaria a virar 'nenhuma sonda'"; fi

  # 12c. guardrail de FORMA da 3a classe (casamento por request_id): ela e o unico vinculo que
  #      alcanca o bundle pre-#1789, e as DUAS travas dela nao podem sumir — o eco de probe (senao
  #      um id de resposta de CRON vira "prova de sonda") e a recusa de slug CONTRADITORIO (senao
  #      uma colagem trocada FABRICA identidade, que e o pior erro possivel neste script).
  : > "$STUB_SQL_ECO"; run ok "$tmp/psql-stub" edge-no-ar > /dev/null
  sqltxt="$(cat "$STUB_SQL_ECO")"
  if tem 'JOIN vinculo v ON v.request_id = b.id' "$sqltxt" \
     && tem "COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" "$sqltxt" \
     && tem "(b.content::jsonb) ->> 'probe'  = 'true'" "$sqltxt"
  then ok "E12c SQL casa por request_id exigindo eco de probe e recusando slug contraditorio"
  else bad "E12c 3a classe sem trava: id de cron ou colagem trocada viraria prova de sonda"; fi

  # 12d. guardrail de FORMA da contagem de anonimas: sem `NOT (? 'edge')` ela contaria as respostas
  #      que JA casam por eco, e "ha sonda anonima" apareceria em toda janela — aviso que cansa e
  #      some. Sem `NOT EXISTS (vinculo)`, a linha ja atribuida seria contada duas vezes.
  if tem "NOT ((b.content::jsonb) ? 'edge')" "$sqltxt" \
     && tem 'NOT EXISTS (SELECT 1 FROM vinculo v WHERE v.request_id = b.id)' "$sqltxt" \
     && tem "'#anonimas ' || n" "$sqltxt"
  then ok "E12d SQL conta como anonima so o que NAO ecoa slug nem tem vinculo"
  else bad "E12d contagem de anonimas sem os dois filtros — o aviso apareceria sempre"; fi

  # 15. INERTE: edge APOSENTADA (handler responde 410 antes de qualquer logica) tocada por PR — o
  #     caso real e a `tint-import`, que carrega o espelho VERBATIM do parse-decimal-br e entra na
  #     janela a cada PR do parser (#2184), saindo SEM_PROVA/chip por um deploy que NAO muda nada.
  #     A prova e o marcador DECLARADO `// EDGE-APOSENTADA:` no index.ts da REF. Tres edges numa
  #     fixture git, e a assercao que importa e a ARVORE lida (lovable-deploy-verify §Passo 3, "o
  #     closure le a REF"): marcador so no working tree NAO vale; marcador na REF vale mesmo que o
  #     working tree o tenha perdido.
  local repo3="$rodada/repo3"
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
     && [ "$rc" -eq 0 ] && ! tem 'RESOLVER_NESTA_SESSAO' "$out"
  then ok "E15 marcador EDGE-APOSENTADA na REF -> INERTE, exit 0, sem chip, e diz para nao pedir ao founder"
  else bad "E15 edge aposentada devia dar INERTE/exit 0 sem chip (rc=$rc): ${out:0:120}"; fi

  # 15b. o INERTE nao depende do banco: mecanica quebrada continua nao tendo nada a dizer sobre um
  #      handler que responde 410 antes de executar — o veredito vem do git, nao da sonda.
  out="$(STUB_MODO=mudo AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo3" FECHO_MAPA_FONTE="" \
         bash "$ALVO" edge-aposentada 2>&1)"; rc=$?
  if tem 'INERTE' "$out" && [ "$rc" -eq 0 ]
  then ok "E15b INERTE sobrevive a mecanica quebrada (a prova e o git, nao o banco)"
  else bad "E15b INERTE devia valer com banco mudo (rc=$rc): ${out:0:120}"; fi

  # 15c. a ARVORE: marcador so no working tree NAO absolve; marcador so na REF absolve.
  out="$(STUB_MODO=ok AFIACAO_PSQL="$tmp/psql-stub" CLAUDE_PROJECT_DIR="$repo3" FECHO_MAPA_FONTE="" \
         bash "$ALVO" edge-marcador-so-no-wt edge-marcador-so-na-ref 2>&1)"; rc=$?
  linha_wt="$(printf '%s' "$out" | command grep -- 'edge-marcador-so-no-wt')"
  linha_ref="$(printf '%s' "$out" | command grep -- 'edge-marcador-so-na-ref')"
  if tem 'SEM_PROVA' "$linha_wt" && ! tem 'INERTE' "$linha_wt" \
     && tem 'INERTE' "$linha_ref" && [ "$rc" -eq 1 ]
  then ok "E15c marcador so no working tree -> SEM_PROVA; so na REF -> INERTE (o closure le a REF)"
  else bad "E15c marcador devia ser lido da REF e nunca do working tree (rc=$rc): ${out:0:160}"; fi

  # ---------------------------------------------------------------- LEDGER ---
  # 16. O LEDGER durável (`deploy_atestacoes`, #2199), lido pelo `pendencias:deploy --json`.
  #     O DEFEITO medido em 2026-09-06: a janela viva morre no `pg_net.ttl` (6 h), então edge
  #     deployada e ATESTADA há mais de 6 h saía SEM_PROVA -> chip -> sessao nova que rodava
  #     `pendencias:deploy` e descobria que ja estava ✅. Cada chip falso custa uma sessao, e com
  #     fan-out (um chip por sessao que fecha na janela) as sondas duplicadas viram risco REAL:
  #     bundle pre-sensor ignora `probe` e executa o fluxo real, uma vez por colagem.
  #     `edge-muda` e a edge do fixture que NAO tem linha na janela viva — exatamente a que caia
  #     em "nenhuma sonda em 6 hours".
  LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_CONFERE' "$out" && [ "$rc" -eq 0 ] && ! tem 'RESOLVER_NESTA_SESSAO' "$out" \
     && ! tem 'SEM_PROVA' "$out"
  then ok "E16 ledger CONFERE com fonte == REF -> LEDGER_CONFERE, exit 0, SEM chip (prova alem da janela)"
  else bad "E16 ledger conferindo devia suprimir o chip (rc=$rc): ${out:0:160}"; fi

  # 16b. A SABOTAGEM DO ENUNCIADO, virada teste: o ledger diz CONFERE para uma edge cujo `fonte`
  #      NAO e o do mapa da REF. Ler so o ROTULO do CLI herdaria qualquer defeito dele
  #      (gates-textuais-cegos.md: >=1 eixo POR FORA); a 2a chave e esse eixo. Sem ela, um CLI
  #      julgando contra outra ref — ou mentindo — apagaria chip legitimo em verde.
  LEDGER_MODO=fonte-errada run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_DISCORDA' "$out" && tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'LEDGER_CONFERE' "$out"
  then ok "E16b ledger CONFERE com fonte != REF -> LEDGER_DISCORDA + chip (a 2a chave e o eixo de fora)"
  else bad "E16b CONFERE com fonte divergente NAO pode absolver (rc=$rc): ${out:0:200}"; fi

  # 16c. NUNCA_ATESTADA continua chip — o ledger nao inventa prova, so guarda a que houve. E o
  #      diagnostico entra na linha: o chip nasce dizendo o que o ledger sabia.
  LEDGER_MODO=nunca run ok "$tmp/psql-stub" edge-muda
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ] && tem 'NUNCA_ATESTADA' "$out" \
     && tem 'sonda:sql' "$out" && ! tem 'LEDGER_CONFERE' "$out"
  then ok "E16c ledger NUNCA_ATESTADA -> segue SEM_PROVA/chip, com o diagnostico e o remedio (1a sonda)"
  else bad "E16c NUNCA_ATESTADA devia continuar virando chip (rc=$rc): ${out:0:200}"; fi

  # 16d. O FAIL-CLOSED, um modo de avaria por vez. Exigir resposta POSITIVA e nao "ausencia de
  #      erro": `exit 0` com stdout vazio e o caso classico do presente-porem-quebrado, e a marca
  #      de formato e o que separa "o CLI respondeu" de "algo saiu no stdout".
  local modo ruins_ledger_ok=1
  for modo in mudo lixo sem-marca vereditos-ruins exit2 exit3 ausente; do
    LEDGER_MODO="$modo" run ok "$tmp/psql-stub" edge-muda
    # um ID por avaria (E16d_sem_marca…): sob o E16d só, a sabotagem de UMA avaria aceitaria a
    # quebra de qualquer outra
    id_av="E16d_$(printf '%s' "$modo" | tr -c 'A-Za-z0-9' '_')"
    if { tem 'SEM_PROVA' "$out" && [ "$rc" -eq 1 ] && tem 'LEDGER_NAO_CONSULTADO' "$out" \
           && ! tem 'LEDGER_CONFERE' "$out"; }; then
      ok "$id_av ledger '$modo' -> LEDGER_NAO_CONSULTADO + chip"
    else
      ruins_ledger_ok=0; bad "$id_av ledger '$modo' devia ser LEDGER_NAO_CONSULTADO + chip (rc=$rc): ${out:0:160}"
    fi
  done
  # o resumo sai nos DOIS ramos: o conjunto de asserts executados não pode depender do veredito
  if [ "$ruins_ledger_ok" = 1 ]
  then ok "E16d ledger quebrado (7 avarias: mudo/lixo/sem-marca/vereditos/exit2/exit3/ausente) -> fail-closed, chip"
  else bad "E16d ledger quebrado: ao menos uma avaria absolveu (acima)"; fi

  # 16e. DIVERGE do ledger e pendencia PROVADA — e NAO entra no DISPARE. Sondar antes do deploy
  #      nao confirma nada e, em edge cara com bundle pre-sensor, EXECUTA o fluxo real: a ordem e
  #      deploy antes, sonda depois (a mesma assimetria do `--caro`).
  LEDGER_MODO=diverge run ok "$tmp/psql-stub" edge-muda
  linha_cmd="$(printf '%s' "$out" | command grep 'sonda:sql' || true)"
  if tem 'LEDGER_DIVERGE' "$out" && [ "$rc" -eq 1 ] && tem 'RESOLVER_NESTA_SESSAO' "$out" \
     && ! tem 'edge-muda' "$linha_cmd"
  then ok "E16e ledger DIVERGE -> pendencia PROVADA, chip, e FORA da lista do DISPARE"
  else bad "E16e DIVERGE devia ser chip provado e nunca convidar a sondar (rc=$rc): ${out:0:200}"; fi

  # 16f. A JANELA VIVA VENCE: ela e a evidencia mais FRESCA, e o ledger do CLI e `ledger ∪ janela`
  #      — nao pode ter nada mais novo. Sem esta trava, um CONFERE historico apagaria o
  #      DESATUALIZADA de um bundle velho servindo AGORA, que e a falha silenciosa que este script
  #      existe para pegar (o caso `omie-vendas-sync`).
  #      DUAS edges de proposito: a `edge-muda` (sem resposta na janela) e quem PUXA a consulta. So com
  #      a `edge-velha` o ledger nem era chamado — a janela ja decidira tudo —, e o caso media o pulo
  #      dos candidatos (16f2) em vez do `-z "$servido"`: as duas travas pareciam redundantes uma com
  #      a outra (2026-09-27), e era o CENARIO que nao separava. O "sem veredito" da `edge-muda` prova
  #      que o ledger FOI lido.
  LEDGER_MODO=confere-tudo run ok "$tmp/psql-stub" edge-velha edge-muda
  if tem 'DESATUALIZADA *edge-velha ' "$out" && [ "$rc" -eq 1 ] && ! tem 'LEDGER_CONFERE' "$out" \
     && tem 'ledger: sem veredito' "$out"
  then ok "E16f janela viva VENCE o ledger: bundle velho servindo segue DESATUALIZADA (com o ledger lido)"
  else bad "E16f ledger nao pode apagar o DESATUALIZADA da janela viva (rc=$rc): ${out:0:200}"; fi

  # 16f2. ...e quem a janela viva JA decidiu nem chega a ser perguntado. Com todas as edges
  #       respondendo na janela o ledger nao tem o que dizer, e chama-lo nao e inocuo: o CLI real faz
  #       `git fetch` + consulta, e o desfecho dele sai no TOPO da lista — com a worktree defasada, o
  #       "ANTES DE AGIR: sincronize e rode de novo" em cima de um DESATUALIZADA ja PROVADO pela janela
  #       (medido 2026-09-28). A chamada nao muda a classificacao, entao so o TRACO do stub a ve; o
  #       controle (1 chamada para a `edge-muda`, que a janela NAO decidiu) prova que o traco registra.
  local n_ctl n_cham
  : > "$LEDGER_TRACE"; LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  n_ctl="$(chamadas)"
  : > "$LEDGER_TRACE"
  FECHO_LEDGER_RAIZ="$cli_defasado" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-velha edge-no-ar
  n_cham="$(chamadas)"
  if [ "$n_ctl" = 1 ] && [ "$n_cham" = 0 ] && tem 'DESATUALIZADA *edge-velha ' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out" && ! tem 'ANTES DE AGIR' "$out"
  then ok "E16f2 janela viva decidiu TODAS as edges -> o CLI do ledger NEM e chamado (sem aviso de defasagem)"
  else bad "E16f2 com a janela decidindo tudo o ledger nao podia ser chamado (chamadas=$n_cham, controle=$n_ctl, rc=$rc): ${out:0:200}"; fi

  # 16f3. A OUTRA METADE do mesmo contrato ("so pergunta quando ha a quem"): edge FORA do mapa nao tem
  #       `esperado`, o ledger nao tem o que dizer dela, e a janela so com ela nao chama o CLI — senao a
  #       worktree defasada poe o "ANTES DE AGIR" em cima de uma edge que o ledger nem julgaria (medido
  #       2026-09-28). A trava ficava fora da lista E sem caso: a chamada nao muda a classificacao.
  : > "$LEDGER_TRACE"; LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  n_ctl="$(chamadas)"
  : > "$LEDGER_TRACE"
  FECHO_LEDGER_RAIZ="$cli_defasado" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-fora-do-mapa
  n_cham="$(chamadas)"
  if [ "$n_ctl" = 1 ] && [ "$n_cham" = 0 ] && tem 'SEM_PROVA *edge-fora-do-mapa ' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out" && ! tem 'ANTES DE AGIR' "$out"
  then ok "E16f3 so edge FORA do mapa na janela -> o CLI do ledger NEM e chamado (sem aviso de defasagem)"
  else bad "E16f3 edge fora do mapa nao tem o que perguntar ao ledger (chamadas=$n_cham, controle=$n_ctl, rc=$rc): ${out:0:200}"; fi

  # 16g. ...e o mesmo vale para a resposta que PROVA bundle velho sem `fonte` (pre-#1998) e para a
  #      edge FORA do mapa, que nao tem `esperado` com que casar a 2a chave. A `edge-muda` puxa a
  #      consulta, como no 16f: sem ela o ledger nem era chamado e o caso nao lia veredito nenhum.
  LEDGER_MODO=confere-tudo run ok "$tmp/psql-stub" edge-pre-fonte edge-fora-do-mapa edge-muda
  if tem 'PRE_SONDA_FONTE *edge-pre-fonte ' "$out" && tem 'SEM_PROVA *edge-fora-do-mapa ' "$out" \
     && [ "$rc" -eq 1 ] && ! tem 'LEDGER_CONFERE' "$out" && tem 'ledger: sem veredito' "$out"
  then ok "E16g ledger nao absolve PRE_SONDA_FONTE nem edge fora do mapa (sem esperado, sem 2a chave)"
  else bad "E16g ledger absolveu quem nao podia (rc=$rc): ${out:0:200}"; fi

  # 16g2. A 2a chave nao pode ser VAZIA. Edge fora do mapa tem `esperado` vazio; um CLI que diga
  #       CONFERE para ela com `observado` "" faria a dupla chave casar "" = "" — absolvicao sem
  #       regua, e so o `-n "$esperado"` do alvo barra. Com um `observado` de verdade (o 16g) a propria
  #       dupla chave ja barrava, e a trava ficava sem caso proprio (verde isolada, 2026-09-27). O
  #       NUNCA_ATESTADA da `edge-muda` prova que o ledger FOI lido.
  LEDGER_MODO=confere-vazio run ok "$tmp/psql-stub" edge-muda edge-fora-do-mapa
  if tem 'SEM_PROVA *edge-fora-do-mapa ' "$out" && ! tem 'LEDGER_CONFERE' "$out" && [ "$rc" -eq 1 ] \
     && tem 'NUNCA_ATESTADA' "$out"
  then ok "E16g2 CLI com CONFERE de campos VAZIOS p/ edge fora do mapa -> segue SEM_PROVA ('' = '' nao e 2a chave)"
  else bad "E16g2 a 2a chave vazia absolveu edge fora do mapa (rc=$rc): ${out:0:200}"; fi

  # 16h. PRECEDENCIA: mecanica quebrada nao consulta o ledger. O wrapper mudo e o mesmo caminho ate
  #      o banco que o CLI usaria — confiar no ledger com o psql reprovado seria contornar o
  #      proprio fail-closed por uma porta lateral.
  LEDGER_MODO=confere run mudo "$tmp/psql-stub" edge-muda
  if tem 'SEM_PROVA' "$out" && [ "$rc" -eq 2 ] && ! tem 'LEDGER_CONFERE' "$out"
  then ok "E16h psql mudo -> ledger NEM e consultado (fail-closed do banco tem precedencia)"
  else bad "E16h com mecanica quebrada o ledger nao pode absolver (rc=$rc): ${out:0:200}"; fi

  # 16h2. ...e "NEM e consultado" e LITERAL. O 16h so enxerga a absolvicao, que a leitura do veredito
  #       ja barra sozinha (com a mecanica reprovada o laco nem le o `esperado`): a chamada em si era
  #       invisivel, e a trava que a impede ficava VERDE isolada (2026-09-27 — nao porque "o CLI cai
  #       junto": o 16h ja e banco quebrado com CLI sao). Chamar o CLI com o banco reprovado custa o
  #       `git fetch` + a consulta, e com a worktree defasada o "sincronize e rode de novo" apontaria a
  #       causa ERRADA — o problema e o banco (medido 2026-09-28). Traco + controle, como no 16f2.
  : > "$LEDGER_TRACE"; LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  n_ctl="$(chamadas)"
  : > "$LEDGER_TRACE"
  FECHO_LEDGER_RAIZ="$cli_defasado" LEDGER_MODO=confere run mudo "$tmp/psql-stub" edge-muda
  n_cham="$(chamadas)"
  if [ "$n_ctl" = 1 ] && [ "$n_cham" = 0 ] && [ "$rc" -eq 2 ] \
     && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out" && ! tem 'ANTES DE AGIR' "$out"
  then ok "E16h2 psql mudo -> o CLI do ledger NEM e chamado (traco vazio; nenhum aviso de defasagem com o banco reprovado)"
  else bad "E16h2 com a mecanica reprovada o ledger foi chamado (chamadas=$n_cham, controle=$n_ctl, rc=$rc): ${out:0:200}"; fi

  # ----------------------------------------------- FRESCURA do CLI do ledger ---
  # 16i. O DEFEITO DE 2026-09-10, reproduzido: /fecho numa worktree 11 commits ATRAS da main, com
  #      a onda 5 do cron (#2461) ja aplicada no banco e ausente do `sonda-cron-alvos.ts` do working
  #      tree. O CLI sai exit 2 ("o banco sonda edge(s) que o repo NAO aprovou") e o diagnostico
  #      dizia MECANICA + "DISPARE sonda" — numa edge que ESCREVE. A causa e a defasagem, e o
  #      remedio e sincronizar: a edge segue pendente (fail-closed), mas NAO vai para o DISPARE
  #      (o ledger pode ja ter a resposta) e o remedio sai exato para o tree LIMPO.
  FECHO_LEDGER_RAIZ="$cli_defasado" LEDGER_MODO=intruso run ok "$tmp/psql-stub" edge-muda
  linha_edge="$(printf '%s' "$out" | command grep 'SEM_PROVA' | command grep -- 'edge-muda' || true)"
  linha_cmd="$(printf '%s' "$out" | command grep 'sonda:sql' || true)"
  if tem 'LEDGER_WORKTREE_DEFASADA' "$out" && tem 'supabase/functions/_shared/sonda-cron-alvos.ts' "$out" \
     && tem 'git checkout --detach origin/main' "$out" && ! tem 'commit WIP' "$out" \
     && [ "$rc" -eq 1 ] && tem 'RESOLVER_NESTA_SESSAO' "$out" && tem 'worktree defasada' "$linha_edge" \
     && ! tem 'edge-muda' "$linha_cmd" && ! tem 'LEDGER_NAO_CONSULTADO' "$out" && ! tem 'LEDGER_CONFERE' "$out" \
     && tem 'ANTES DE AGIR' "$out" \
     && ! tem 'aprovou: omie-desconto-backfill' "$out" && ! tem 'UPDATE public.deploy_sonda_alvos' "$out"
  then ok "E16i worktree atras da REF com alvo novo do cron -> LEDGER_WORKTREE_DEFASADA + remedio, pendente e FORA do DISPARE"
  else bad "E16i defasagem devia nomear a CAUSA e o remedio, sem mandar sondar (rc=$rc): ${out:0:260}"; fi
  # ...e sem REPETIR a saida do CLI defasado: o remedio dela e de OUTRA versao, e o de 2026-09-10 era
  #    um UPDATE que desativaria o alvo APROVADO (desfaria a migration aplicada, #2464). Hoje ele so
  #    nao aparece porque o corte em 200 bytes cai antes — sorte, nao desenho; por isso as duas
  #    asserções negativas acima: o trecho do slug (dentro do corte) e o UPDATE (fora dele).

  # 16j. ESTRITO: o veredito de um CLI que nao e o da REF nao vale nem quando ABSOLVE. CLI velho
  #      tambem julga com logica velha (o #2221 era exatamente "a resposta sem `edge` lida como
  #      nunca atestada" -> re-sondar quem ja respondeu), e o remedio seria o de outra versao.
  FECHO_LEDGER_RAIZ="$cli_defasado" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_WORKTREE_DEFASADA' "$out" && ! tem 'LEDGER_CONFERE' "$out" && [ "$rc" -eq 1 ] \
     && tem 'RESOLVER_NESTA_SESSAO' "$out"
  then ok "E16j worktree defasada + CLI dizendo CONFERE -> veredito DESCARTADO (so vale o CLI da REF), chip"
  else bad "E16j CLI defasado nao pode absolver (rc=$rc): ${out:0:220}"; fi

  # 16k. O PAR MINIMO do 16i: o MESMO exit 2 com o CLI EM DIA e mecanica DE VERDADE — o banco sonda
  #      um alvo que a MAIN nao aprovou. Sem este lado, uma trava que chamasse todo exit 2 de
  #      "defasada" passaria no 16i e esconderia o achado que o CLI existe para dar.
  LEDGER_MODO=intruso run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_NAO_CONSULTADO' "$out" && tem 'aprovou: omie-desconto-backfill' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out"
  then ok "E16k CLI em dia + banco sondando alvo fora da main -> segue MECANICA (LEDGER_NAO_CONSULTADO), nunca 'defasada'"
  else bad "E16k exit 2 com o CLI em dia nao e defasagem (rc=$rc): ${out:0:220}"; fi

  # 16l. PRECISAO: a main andou FORA do fecho do CLI (o mapa de fingerprints, que muda a cada merge de
  #      edge e o CLI le pela REF). Isso NAO e defasagem — medir o mapa, ou o repo inteiro,
  #      trocaria o ruido de "mecanica" pelo de "defasada" em quase todo /fecho.
  FECHO_LEDGER_RAIZ="$cli_fora" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_CONFERE' "$out" && [ "$rc" -eq 0 ] && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out"
  then ok "E16l main andou so FORA do fecho do CLI (mapa) -> ledger consultado normalmente (LEDGER_CONFERE)"
  else bad "E16l mudanca fora do fecho do CLI nao pode bloquear o ledger (rc=$rc): ${out:0:220}"; fi

  # 16m. A CADEIA FUNDA: o fecho real entra em `src/lib/` pelo alias `@/`, e parte dele so e alcancada
  #      por import DINAMICO (`sonda-versao-sql.ts` -> `await import('./canaria-leitor-do-repo')`). O
  #      levantamento feito a mao para este PR era cego ao dinamico e achou 9 arquivos; eram 11.
  #      Aqui o arquivo divergente so se alcanca por: relativo -> import( quebrado em linhas ) -> @/.
  FECHO_LEDGER_RAIZ="$cli_alias" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_WORKTREE_DEFASADA' "$out" && tem 'src/lib/erro-mensagem.ts' "$out" \
     && ! tem 'LEDGER_CONFERE' "$out"
  then ok "E16m divergencia alcancada so por import dinamico (em linhas) + alias @/ -> DEFASADA nomeando o arquivo"
  else bad "E16m fecho do CLI devia seguir import dinamico e o alias @/ (rc=$rc): ${out:0:220}"; fi

  # 16n. TREE SUJO: o checkout pelado falharia ou carregaria a mudanca local junto (e a defasagem
  #      voltaria). O remedio muda — e sem `git stash` pelado, que e pilha COMPARTILHADA entre as
  #      worktrees. O par minimo do remedio e o 16i (tree limpo). O tree sujo nasce AQUI, na rodada: a
  #      mudanca sem commit e o que se mede, e nenhuma outra rodada pode herda-la (nem perde-la).
  local cli_sujo="$rodada/cli-sujo"; cli_base "$cli_sujo"
  printf "export const julgar = 'editado, sem commit';\n" >> "$cli_sujo/scripts/lib/pendencias-deploy.ts"
  FECHO_LEDGER_RAIZ="$cli_sujo" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_WORKTREE_DEFASADA' "$out" && tem 'scripts/lib/pendencias-deploy.ts' "$out" \
     && tem 'commit WIP' "$out" && ! tem 'LEDGER_CONFERE' "$out"
  then ok "E16n mudanca LOCAL no fecho do CLI -> defasada, e o remedio manda guardar num commit WIP antes"
  else bad "E16n tree sujo devia pedir commit WIP antes de sincronizar (rc=$rc): ${out:0:220}"; fi

  # 16o. A CORRIDA: em dia ANTES da chamada, defasada DEPOIS — o `git fetch origin main` do CLI trouxe
  #      a onda nova. A comparacao que vale e contra a REF que o CLI julgou, que so existe depois que
  #      ele volta; uma trava ANTES da chamada leria a mensagem de 2026-09-10 de novo.
  #      A corrida nasce na rodada e EM DIA (origin/main = HEAD), com o commit novo guardado em
  #      `futuro`; o stub `intruso-apos-fetch` move a origin/main para ele DURANTE a chamada, como o
  #      `git fetch origin main` do CLI real faria. Um repo comum as rodadas dependia de um reset aqui.
  local cli_corrida="$rodada/cli-corrida" corrida_novo
  cli_base "$cli_corrida"
  cli_main_anda "$cli_corrida" supabase/functions/_shared/sonda-cron-alvos.ts "$ALVOS_ONDA5"
  corrida_novo="$(git -C "$cli_corrida" rev-parse refs/remotes/origin/main)"
  git -C "$cli_corrida" update-ref refs/heads/futuro "$corrida_novo"
  git -C "$cli_corrida" update-ref refs/remotes/origin/main HEAD
  CORRIDA_NOVO="$corrida_novo" FECHO_LEDGER_RAIZ="$cli_corrida" LEDGER_MODO=intruso-apos-fetch \
    run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_WORKTREE_DEFASADA' "$out" && tem 'sonda-cron-alvos.ts' "$out" \
     && ! tem 'LEDGER_NAO_CONSULTADO' "$out" && ! tem 'aprovou: omie-desconto-backfill' "$out"
  then ok "E16o REF andou DURANTE a chamada (fetch do CLI) -> a frescura e medida depois, contra a REF julgada"
  else bad "E16o a frescura devia ser medida contra a REF depois do fetch do CLI (rc=$rc): ${out:0:220}"; fi

  # 16p. NAO VERIFICAVEL e fail-CLOSED: sem a REF na casa do CLI nao ha como provar que ele e o
  #      da main — e prova de frescura ausente nao vira "fresco" (nem "defasada": nao foi medido).
  FECHO_LEDGER_RAIZ="$cli_sem_ref" LEDGER_MODO=confere run ok "$tmp/psql-stub" edge-muda
  if tem 'LEDGER_NAO_CONSULTADO' "$out" && ! tem 'LEDGER_CONFERE' "$out" && [ "$rc" -eq 1 ] \
     && ! tem 'LEDGER_WORKTREE_DEFASADA' "$out"
  then ok "E16p frescura do CLI nao verificavel (REF ausente) -> LEDGER_NAO_CONSULTADO, nunca absolve"
  else bad "E16p sem provar a frescura o ledger nao pode absolver (rc=$rc): ${out:0:220}"; fi

  # O RECIBO de término — a ÚLTIMA coisa da suíte, com o locale e o nº de linhas de assert. Um
  # `return` ou aborto no meio pula os asserts seguintes sem vermelho nenhum (o `fail` só conta o que
  # rodou): quem lê o recibo — a execução normal, abaixo, e a camada 2 do --falsificar — sabe que
  # a suíte chegou ao FIM, e com quantos asserts.
  terminou="${LC_ALL:-?}"
  printf 'FIM_DA_SUITE locale=%s asserts=%s\n' "$terminou" "$n_asserts"
}

# ---------------------------------------------------------------- falsificação ---
if [ "${1:-}" = "--falsificar" ]; then
  falhou=0
  printf '== falsificacao (sabota o alvo e EXIGE vermelho NO ASSERT que a sabotagem declara) ==\n'

  # Os logs das rodadas saem SEM cor (`sem_cor`), para o ID casar logo depois da palavra.
  esc="$(printf '\033')"
  sem_cor() { LC_ALL=C sed "s/${esc}\[[0-9;]*m//g" "$1"; }
  # A LISTA dos asserts executados numa rodada — ordenada e COM repetição. Até 2026-09-28 era o
  # CONJUNTO (`sort -u`), porque os laços repetiam o ID a cada iteração e o 5f só imprimia o `bad`:
  # a multiplicidade se perdia, e um aborto que cortasse só iterações não mudava o conjunto (Codex).
  # Hoje cada assert imprime UMA linha com um ID SÓ DELE, nos dois ramos (os laços numeram a
  # iteração e fecham com o resumo) — a lista É o conjunto, e o controle prova isso (ID repetido lá
  # é FALHA: a premissa do juiz quebrou).
  executados() { { LC_ALL=C grep -Eo '^  (ok +|FALHA )[EH][0-9]+[a-z0-9_]* ' "$1" || true; } | LC_ALL=C awk '{ print $2 }' | LC_ALL=C sort | tr '\n' ' '; }
  # O RECIBO de término que a suíte imprime por último: "<locale> <nº de asserts>" (vazio sem recibo)
  recibo() { LC_ALL=C sed -n 's/^FIM_DA_SUITE locale=\([^ ]*\) asserts=\([0-9][0-9]*\)$/\1 \2/p' "$1" | tail -1; }
  # Erro de execução do bash no ALVO, no que a suíte despeja da saída dele (`${out:0:N}` dos `bad`).
  erros_exec() { cat "$1" "$1.stderr" 2>/dev/null | LC_ALL=C grep -cE 'unbound variable|command not found|syntax error|bad substitution' || true; }
  vermelhos() { { LC_ALL=C grep -Eo '^  FALHA [EH][0-9]+[a-z0-9_]* ' "$1" || true; } | LC_ALL=C awk '!v[$2]++ { printf "%s ", $2 }'; }
  logs="$tmp/falsificacao"; mkdir -p "$logs"

  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  [ -n "$utf8" ] || { printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 — metade da cobertura fingindo ser inteira\n'; exit 1; }

  ALVO_REAL="$ALVO"

  # ARVORE-ESPELHO -- a copia sabotada NAO pode morar em "$tmp" raso. O `edges-pendentes.sh` deriva
  # o BINARIO auxiliar (`scripts/edges-afetadas.ts`) de `$0` e nao de `$RAIZ`, de proposito (o
  # `$RAIZ` ja aponta para o repo-fixture; ver o comentario dele). Uma copia em "$tmp" faz esse
  # caminho apontar para fora do repo, o `[ ! -f "$AFETADAS_TS" ]` fecha fail-closed com exit 2, e
  # a suite fica VERMELHA sem sabotagem nenhuma -- com isso TODA sabotagem "era detectada" de graca
  # e este bloco inteiro anunciava "todas as sabotagens ficaram vermelhas" sem ter medido nada.
  # Nao era visivel pelo `test:hooks`: la a suite roda sobre o alvo REAL, no lugar certo.
  # Medido pelo CONTROLE logo abaixo, que existe exatamente para isto.
  espelho="$tmp/espelho"
  mkdir -p "$espelho/.claude/skills/fecho/scripts"
  ln -s "$RAIZ/scripts" "$espelho/scripts"
  DIR_COPIA="$espelho/.claude/skills/fecho/scripts"
  copia="$DIR_COPIA/sabotado.sh"
  aplica() {  # escreve a cópia sabotada; 1 = falsificação VAZIA (já acusada), nada a julgar
    local erro
    erro="$(sed "$expr" "$ALVO_REAL" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:50}"; falhou=1; return 1
    fi
    if cmp -s "$ALVO_REAL" "$copia"; then
      printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, alvo intacto — falsificacao vazia\n' "$desc"; falhou=1; return 1
    fi
    # Sintaxe quebrada pintaria TODO caso de vermelho sem ter sabotado a camada.
    if ! bash -n "$copia" 2>/dev/null; then
      printf '  \033[31mFALHA\033[0m "%s": quebrou a SINTAXE do shell — vermelho pelo motivo errado\n' "$desc"; falhou=1; return 1
    fi
    chmod +x "$copia"
  }

  # (a) a sonda positiva vira `command -v` de mentira: presente passa a valer por respondendo
  # -- CONTROLE: a suite tem de estar VERDE antes de qualquer sed --------------------
  # "Ficou vermelho" so e informacao se existir um verde do qual sair. Sem esta trava, um arnes
  # incondicionalmente vermelho (fixture podre, stub quebrado, assercao nova mal escrita) APROVA
  # com louvor: toda sabotagem produz o vermelho exigido e o gate anuncia "toda sabotagem foi
  # detectada" -- falsificacao sem linha de base, que prova que o teste REAGE, nao que ele estava
  # certo antes de reagir. Mesma familia de `ausente != zero`.
  #
  # O controle roda a MESMA invocacao do laco de sabotagem (copia em $tmp, LC_ALL forcado, a mesma
  # variavel de override) e so troca a sabotagem por NADA. Por isso ele NAO e redundante com o
  # `bun run test:hooks` do step anterior do CI: la a suite roda no locale AMBIENTE e sobre o alvo
  # REAL. Se for justamente essa invocacao (copia + LC_ALL) que esta vermelha por motivo alheio,
  # o `test:hooks` fica verde e todo este bloco vira teatro.
  # Abortamos ANTES do primeiro sed: com a base vermelha nenhum veredito de (B) e legivel.
  controle="$DIR_COPIA/controle.sh"
  cp "$ALVO_REAL" "$controle"; chmod +x "$controle"
  # O LOG do controle é a régua das camadas do laço: o conjunto de asserts que a suíte executa, e
  # que o assert declarado SABE ficar verde nesta invocação.
  for loc in C "$utf8"; do
    ctl="$logs/controle.$loc.log"
    : > "$ctl.stderr"
    # shellcheck disable=SC2030,SC2031
    ( export LC_ALL="$loc"; ALVO="$controle"; ERROS_DO_ALVO="$ctl.stderr"; fail=0; suite; [ "$fail" -eq 0 ] ) > "$ctl.cru" 2>&1; rc=$?
    sem_cor "$ctl.cru" > "$ctl"
    ids_ctl="$(executados "$ctl")"
    n_ids="$(printf '%s' "$ids_ctl" | wc -w | tr -d ' ')"
    # shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
    dup="$(printf '%s\n' $ids_ctl | uniq -d | tr '\n' ' ')"
    if [ "$rc" -ne 0 ] || [ "$n_ids" -eq 0 ]; then
      printf '  \033[31mFALHA\033[0m [%s] controle SEM sabotagem ja esta VERMELHO — sem linha de base, falsificar nao prova nada\n' "$loc"
      falhou=1
    elif [ -n "$dup" ]; then
      printf '  \033[31mFALHA\033[0m [%s] controle com ID de assert REPETIDO (%s) — a lista de executados perde a multiplicidade\n' "$loc" "$dup"
      falhou=1
    elif [ "$(recibo "$ctl")" != "$loc $n_ids" ]; then
      # o recibo conta as chamadas de ok()/bad(); as linhas com ID contam o que o juiz ENXERGA — se
      # divergem, há assert sem ID (invisível às camadas 2 e 3) ou a suíte não chegou ao fim
      printf '  \033[31mFALHA\033[0m [%s] controle sem o RECIBO de termino coerente (esperado [%s %s], veio [%s])\n' "$loc" "$loc" "$n_ids" "$(recibo "$ctl")"
      falhou=1
    else
      printf '  \033[32mok\033[0m   [%-11s] controle (sem sabotagem) -> VERDE (%s asserts, recibo de termino, IDs unicos)\n' "$loc" "$n_ids"
    fi
  done
  if [ "$falhou" -ne 0 ]; then
    printf '\033[31m== falsificacao ABORTADA: sem verde de partida ==\033[0m\n'
    printf '   Conserte a suite primeiro; sabotar sobre vermelho produz veredito fabricado.\n'
    exit 1
  fi

  # <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E (cada um tem de virar), `|` = OU
  # (basta um). O ID é o 1º token que o assert imprime (`FALHA E16i …`). Exit≠0 NÃO é dente: até
  # 2026-09-27 este laço contava como vermelha QUALQUER rodada com `fail≠0` — assert alheio, aborto,
  # sintaxe quebrada (não havia `bash -n`). Colaterais ficam de fora de propósito.
  # docs/historico/falsificacao-exit-nao-e-dente.md
  SABOTAGENS="presenca_wrapper_basta:E6c sonda_saida_inteira:E1 shared_sem_mapa_ok:E13c
              mapa_base_cegueira:E14b rodape_sem_remedio:E3b via_c_muda:E13b grafo_falho_segue:E13d
              mecanica_fora_da_classificacao:E5e qualquer_fonte_prova:E2
              pre_sonda_fonte_neutro:E5b sql_descarta_sem_fonte:E12b segunda_classe_sem_probe:E12b
              sentinela_diverge:E12b anonima_neutra:E5c anonimas_ausente_zero:E5e slug_forasteiro_calado:E5g
              request_ids_sem_flag:E5h par_fora_do_sql:E5h aposentada_ignorada:E15 marcador_do_wt:E15c
              sql_sem_distinct_on:E12 ledger_pelo_rotulo:E16b ledger_sem_marca:E16d_sem_marca
              ledger_exit_anomalo:E16k ledger_sem_gate_da_mecanica:E16h2 ledger_pergunta_a_janela:E16f2
              ledger_pergunta_fora_do_mapa:E16f3
              janela_viva_sem_z_servido:E16f,E16g ledger_segunda_chave_vazia:E16g2
              divergencia_generica:E16e ledger_sem_json:E16
              ledger_sem_diagnostico:E16c frescura_sempre_em_dia:E16i,E16j defasada_vale:E16j
              frescura_nao_verificavel_ok:E16p defasada_no_dispare:E16i fecho_sem_imports:E16i
              fecho_sem_alias:E16m fecho_sem_import_dinamico:E16m fecho_por_linha:E16m
              remedio_ignora_tree_sujo:E16n frescura_antes_da_chamada:E16o frescura_repo_inteiro:E16l
              rodape_sem_sincronizar:E16i defasada_repete_cli:E16i fuso_frouxo:E14c fuso_apertado:E14c2 hora_frouxo:H1,H3 hora_apertado:H4
              hora_ingenuo:H2 hora_remedio_ensina_bug:H3
              janela_nao_impressa:E14d"

  # registra <nome> <descricao> <expressao-sed> — a TABELA das sabotagens. Nome da lista sem
  # registro e registro fora da lista são FALHA (no fim do laço): o primeiro não sabotaria nada, o
  # segundo nunca rodaria.
  registradas=""
  registra() {
    case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1) — o 2o registro sobrescreveria o 1o" >&2; exit 2 ;; esac
    registradas="$registradas $1"; printf -v "desc_$1" '%s' "$2"; printf -v "expr_$1" '%s' "$3"
  }

  registra presenca_wrapper_basta "presenca do wrapper basta (sem exigir resposta positiva)" \
    "s%! \"\$PSQL\" -Atc 'SELECT 1' 2>/dev/null | command grep -Fxq -- '1'%false%"
  # (a2) a sonda volta a exigir a saida INTEIRA == "1": reprova o wrapper bom (o defeito de prod)
  registra sonda_saida_inteira "sonda exigindo saida inteira == 1 (ignora os SET do wrapper)" \
    "s%| command grep -Fxq -- '1'%| tr -d '[:space:]' | command grep -Fxq -- '1'%"
  # (a3) o fail-closed do `_shared/` sem mapa vira aviso: enumeracao voltaria a absolver por ausencia
  #      SÓ o `exit 2` do mapa da MAIN ilegível (faixa a partir do `if` dele): o sed antigo, sem
  #      endereço, trocava os TRÊS `exit 2` de 6 espaços — o do `bun` ausente e o da via (c) junto —, e
  #      derrubava o E13d de tabela (medido 2026-09-28: 3 linhas; das 52 sabotagens, a única conflada
  #      sem querer — as outras de 2 linhas são pares de propósito).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra shared_sem_mapa_ok "_shared sem mapa deixando de ser exit 2" \
    '/if \[ ! -s "$tmp\/mapa_agora" \]; then/,/^      exit 2$/s/^      exit 2$/      :/'
  # (a4) a assimetria de papel entre as duas pontas do mapa some, e `mapa_base` volta a valer por
  #      cegueira — o defeito medido em 2026-09-05: janela cujo base e anterior ao #1998 (que criou
  #      o mapa) desistia por atacado, sem veredito nenhum, justo quando `_shared/` afetou 41 das
  #      95 edges. Sem esta sabotagem o caso 14b passaria a ser decorativo.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra mapa_base_cegueira "mapa_base ausente voltando a ser tratado como cegueira" \
    's%if \[ ! -s "$tmp/mapa_agora" \]; then%if [ ! -s "$tmp/mapa_agora" ] || [ ! -s "$tmp/mapa_base" ]; then%'
  # (a6) o remedio some do rodape: o ramo "nenhuma sonda" volta a dizer so "INDETERMINADO" e o
  #      leitor conclui "espere o cron" — que para 24 das 54 edges do mapa NUNCA vem (sem cron
  #      nenhum: webhook/sob demanda). Foi o erro cometido ao vivo pelo autor do proprio script.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra rodape_sem_remedio "registro do ramo 'nenhuma sonda' indo para o vazio (rodape sem remedio)" \
    's#>> "$tmp/sem_sonda"#>> /dev/null#'
  # (a5) a via (c) para de contribuir alvos: a edge FORA do mapa afetada so por `_shared/` volta a
  #      ser invisivel — exatamente a classe de 41 edges medida em 2026-09-05. Sem esta sabotagem o
  #      caso 13b poderia estar verde por outro motivo (a via (b) pegando a pasta, p.ex.).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra via_c_muda "via (c) sem contribuir alvos (grafo de imports mudo)" \
    's%    cat "$tmp/afetadas" >> "$tmp/alvos"%    :%'
  # (a6) a via (c) deixa de ser fail-closed: erro do auxiliar vira seguir-em-frente, e lista vazia
  #      por ERRO volta a ser indistinguivel de lista vazia por merito. SÓ o `exit 2` desse ramo: o sed
  #      antigo (`if false && ! bun`) impedia o bun de RODAR, e o que caía era o E13b da vizinha. O
  #      13d é o cenário que faltava — nenhum outro faz o auxiliar FALHAR (bun presente-porém-quebrado).
  registra grafo_falho_segue "via (c) seguindo em frente quando o auxiliar do grafo FALHA" \
    '/lista vazia por ERRO/,/^      exit 2$/s/^      exit 2$/      :/'
  # (b) o fail-closed some da classificacao: mecanica quebrada passaria a absolver. São DUAS travas
  #     no laço do veredito — o `esperado`/`servido` só é lido com a mecânica OK, e o NO_AR exige
  #     `mecanica_ok = 1` — e cada uma torna a outra INALCANÇÁVEL: nenhuma entrada isola uma delas
  #     (medido 2026-09-28: cada uma sozinha fica verde nos 2 locales). Juntas, o E5e cai com exit 0 e
  #     NO_AR — a mecânica que o próprio script reprovou (a linha `#anonimas` sumiu) absolvendo tudo.
  #     Decisão do founder (2026-09-28): as duas ficam como defesa em profundidade, provadas em PAR.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra mecanica_fora_da_classificacao "classificacao ignorando a mecanica (leitura E condicao do NO_AR)" \
    's%^  if \[ "$mecanica_ok" = 1 \]; then$%  if true; then%;s%if \[ "$mecanica_ok" = 1 \] && \[ -n "$esperado" \] && %if [ -n "$esperado" ] \&\& %'
  # (c) presenca vira prova: qualquer fonte servida absolveria, inclusive a velha
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra qualquer_fonte_prova "aceitar qualquer fonte servida como prova" \
    's%\[ "$servido" = "$esperado" \]%[ -n "$servido" ]%'
  # (e) o ramo pre-#1998 some da classificacao: a mesma resposta 200 sem `fonte` que ele nomeia
  #     voltaria a cair no ramo generico, e a prova positiva de bundle velho perderia o nome
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra pre_sonda_fonte_neutro "ramo PRE_SONDA_FONTE neutralizado na classificacao" \
    's%\[ "$servido" = "sem-campo-fonte" \]%false%'
  # (f) o SQL volta a filtrar por `? 'fonte'` cru: a resposta sem o campo e DESCARTADA antes de
  #     ser classificada, e a edge sondada reaparece como "nenhuma sonda na janela" (o defeito)
  registra sql_descarta_sem_fonte "SQL voltando a descartar a resposta sem o campo fonte" \
    "s%WHERE NOT ((content::jsonb) ? 'fonte')%WHERE ((content::jsonb) ? 'fonte')%"
  # (g) a 2a classe deixa de exigir eco POSITIVO de sonda: qualquer 200 com um campo `edge` viraria
  #     "resposta de sonda", e o fail-closed que este ramo NAO pode afrouxar cairia junto
  registra segunda_classe_sem_probe "2a classe sem exigir o eco de probe" \
    "s%           AND (content::jsonb) ->> 'probe'  = 'true'%%"
  # (h) DERIVA entre as duas pontas: o SQL passa a emitir um sentinela que o classificador nao
  #     compara — nenhuma das duas metades falha sozinha, e o ramo novo fica inalcancavel
  registra sentinela_diverge "sentinela do SQL divergindo do que o classificador compara" \
    "s%'sem-campo-fonte'           AS fonte%'sem-campo-fonte-x'         AS fonte%"
  # ---- as 5 abaixo guardam o ramo da SONDA ANONIMA (2026-09-05). O bundle anterior ao #1789 responde
  #      {ok,probe,versao} e NAO diz de quem e: a resposta existe e nao e atribuivel. O erro caro
  #      nao e o veredito (segue INDETERMINADO nos dois desenhos) — e o MOTIVO: "nenhuma sonda na
  #      janela" manda sondar de novo o que ja foi sondado, e some com o chip que importava.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra anonima_neutra "ramo da sonda anonima neutralizado (volta a alegar ausencia)" \
    's%elif \[ -z "$servido" \] && \[ "$n_anonimas" -gt 0 \]; then%elif false; then%'
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra anonimas_ausente_zero "linha #anonimas ausente degradando para zero em vez de exit 2" \
    's%""|\*\[!0-9\]\*) mecanica_ok=0%""|*[!0-9]*) n_anonimas=0; :%'
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra slug_forasteiro_calado "slug forasteiro em --request-ids passando calado" \
    's%if ! command grep -Fxq -- "$_slug" "$tmp/alvos"; then%if false; then%'
  # `--request-ids` deixando de ser extraido dos args vira "slug" e depois chip fantasma
  registra request_ids_sem_flag "--request-ids deixando de ser reconhecido como flag" \
    's%    --request-ids)   REQ_IDS=%    --xxxxxxxxxxxx)  REQ_IDS=%'
  # o par validado que nao chega ao SQL: o vinculo vira decorativo e o escape nao escapa
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra par_fora_do_sql "par colado nao chegando ao SQL (CTE vinculo sempre vazia)" \
    's%\[ -n "$vinculo_values" \] && vinculo_sql="VALUES $vinculo_values"%:%'

  # (i) o marcador de aposentadoria deixa de ser lido: a edge aposentada volta a SEM_PROVA/chip —
  #     o deploy inerte volta a ser pedido ao founder a cada PR do parser (o custo do #2184)
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra aposentada_ignorada "marcador EDGE-APOSENTADA ignorado (edge aposentada volta a SEM_PROVA)" \
    's%| command grep -qF -- "$MARCADOR_APOSENTADA"; then%| false; then%'
  # (j) o marcador passa a ser lido do WORKING TREE em vez da REF: fatia nao mergeada absolveria e
  #     marcador mergeado que o wt perdeu voltaria a chip — o furo de arvore do lovable-deploy-verify
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra marcador_do_wt "marcador lido do working tree em vez da REF" \
    's%git -C "$RAIZ" show "$REF:supabase/functions/$slug/index.ts" 2>/dev/null%cat "$RAIZ/supabase/functions/$slug/index.ts" 2>/dev/null%'

  # (d) a query perde o "mais recente por edge\"
  registra sql_sem_distinct_on "SQL sem DISTINCT ON (edge)" \
    's%SELECT DISTINCT ON (edge) edge%SELECT edge%'

  # ---- LEDGER (2026-09-06). Uma camada por vez: cada sabotagem tira UMA trava, e a que ficar
  #      verde é redundante ou inalcançada. O alvo continua sendo o lado que APAGA pendência, e
  #      agora ele apaga com prova de OUTRO programa — então as travas que importam são as que
  #      impedem esse programa de virar autoridade cega.
  # (l1) a DUPLA CHAVE some: basta o rótulo `CONFERE` do CLI para absolver, sem casar o `fonte`
  #      com o mapa da REF. Um CLI julgando contra outra ref — ou mentindo — apagaria chip real.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_pelo_rotulo "ledger absolvendo pelo ROTULO, sem casar o fonte com a REF" \
    's%if \[ "$l_estado" = "CONFERE" \] && \[ "$l_obs" = "$esperado" \]; then%if [ "$l_estado" = "CONFERE" ]; then%'
  # (l2) a MARCA de formato deixa de ser exigida: stdout vazio, relatório humano e JSON de outro
  #      contrato passariam por resposta. É o `command -v` do ledger — presença valendo por prova.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_sem_marca "marca de formato do ledger deixando de ser exigida" \
    's%      if \[ "$marca_lida" != "$LEDGER_FORMATO" \]; then%      if false; then%'
  # (l3) exit fora de {0,1} vira resposta: exit 2 (mecânica do CLI) e 127 (bun ausente) entrariam
  #      como se o ledger tivesse julgado.
  registra ledger_exit_anomalo "exit anomalo do ledger tratado como resposta" \
    's%    0|1)%    0|1|2|127)%'
  # (l4) a PRECEDÊNCIA some: com o psql reprovado, o ledger seria consultado assim mesmo — o
  #      fail-closed do banco contornado por uma porta lateral (o CLI usa o MESMO wrapper). A
  #      absolvição, a leitura do veredito já barra sozinha (o laço não lê `esperado` com a mecânica
  #      reprovada); o que SÓ esta trava impede é a CHAMADA — e o aviso de defasagem que ela imprime
  #      com a causa errada. O 16h2 a mede pelo traço do stub.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_sem_gate_da_mecanica "ledger consultado com a mecanica do banco reprovada" \
    's%if \[ "$mecanica_ok" = 1 \]; then  # ledger: mesmo gate do banco%if true; then%'
  # (l5) quem a JANELA VIVA já decidiu vira candidato: o ledger é chamado sem ter a quem responder, e
  #      com a worktree defasada o "sincronize antes de agir" sai sobre uma prova da janela. A
  #      classificação segue certa (quem a guarda é o `-z "$servido"`, abaixo); o 16f2 mede a chamada.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_pergunta_a_janela "ledger perguntado sobre edge que a janela viva ja decidiu" \
    's%    command grep -q -- "\^$slug " "$tmp/ar"   2>/dev/null && continue%    :%'
  # (l5c) a outra metade do "só pergunta quando há a quem": edge FORA do mapa vira candidata — o CLI é
  #      chamado para uma edge sem `esperado`, sobre a qual o veredito dele nem seria lido (16f3).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_pergunta_fora_do_mapa "ledger perguntado sobre edge fora do mapa (sem esperado)" \
    's%    command grep -q -- "\^$slug " "$tmp/mapa" 2>/dev/null || continue   # fora do mapa: nada a perguntar%    :%'
  # (l5b) a JANELA VIVA deixa de vencer: o veredito do ledger é lido para quem respondeu na janela, e
  #      uma atestação histórica apaga o `DESATUALIZADA` de um bundle velho servindo AGORA (16f) e o
  #      `PRE_SONDA_FONTE` (16g). Só aparece quando OUTRA edge puxa a consulta — sozinha, a edge da
  #      janela nem é candidata (l5) —, e por isso as duas travas pareciam redundantes (2026-09-27).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra janela_viva_sem_z_servido "ledger passando por cima da janela viva (mais fresca)" \
    's%  if \[ "$ledger_ok" = 1 \] && \[ -n "$esperado" \] && \[ -z "$servido" \]; then%  if [ "$ledger_ok" = 1 ] \&\& [ -n "$esperado" ]; then%'
  # (l6) o ledger passa a opinar sobre edge FORA do mapa, onde não há `esperado` com que casar a
  #      2ª chave — absolvição sem régua. Com um `observado` de verdade a dupla chave barra sozinha;
  #      o caso desta trava é o CLI que diz CONFERE com `observado` VAZIO: "" = "" (16g2).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_segunda_chave_vazia "ledger opinando sobre edge fora do mapa (2a chave vazia)" \
    's%  if \[ "$ledger_ok" = 1 \] && \[ -n "$esperado" \] && \[ -z "$servido" \]; then%  if [ "$ledger_ok" = 1 ] \&\& [ -z "$servido" ]; then%'
  # (l7) a divergência do ledger perde o nome e cai no ramo genérico: além de sumir a marca, a
  #      edge volta para a lista do DISPARE — convidando a sondar bundle pré-sensor, que EXECUTA
  #      o fluxo real (deploy antes, sonda depois).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra divergencia_generica "divergencia do ledger caindo no ramo generico (e voltando ao DISPARE)" \
    's%  case "$1" in DIVERGE_P1|DIVERGE_P2|INCOERENTE|SEM_MAPA_NO_BUNDLE) return 0 ;; esac%  case "$1" in __nunca_casa__) return 0 ;; esac%'
  # (l8) o `--json` some da invocação: o CLI real imprimiria o relatório HUMANO e o shell leria
  #      texto como dado. O stub recusa (exit 64) — que é o comportamento certo do consumidor.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra ledger_sem_json "invocacao do ledger sem --json (texto humano lido como dado)" \
    's%  (cd "$LEDGER_RAIZ" && PSQL_RO="$PSQL" "$@" --json)%  (cd "$LEDGER_RAIZ" \&\& PSQL_RO="$PSQL" "$@")%'
  # (l9) o DIAGNÓSTICO some da linha indeterminada: o chip volta a nascer sem dizer o que o ledger
  #      sabia, e "nenhuma sonda" deixa de distinguir NUNCA_ATESTADA de ledger mudo.
  registra ledger_sem_diagnostico "diagnostico do ledger sumindo da linha SEM_PROVA" \
    's%    NUNCA_ATESTADA)   printf%    NUNCA_ATESTADA)   : printf%'

  # ---- FRESCURA do CLI (2026-09-10). Uma camada por vez, e cada uma com o caso que SÓ ela pega:
  #      a trava existe porque o CLI roda do working tree e a worktree do /fecho está quase sempre
  #      atrás da main — a defasagem trocava o veredito E o remédio ("DISPARE sonda" numa edge que
  #      escreve). O alvo segue sendo o lado que APAGA pendência: nenhuma destas pode absolver.
  # (f1) a detecção some: o CLI defasado volta a ser lido como se fosse o da REF — o 16i volta a
  #      dizer MECÂNICA + DISPARE, e o 16j volta a absolver com veredito de outra versão.
  registra frescura_sempre_em_dia "frescura do CLI sempre 'em dia' (deteccao da defasagem desligada)" \
    's%  cli_frescura; frescura_rc=\$?%  frescura_rc=0%'
  # (f2) a defasagem é detectada mas a resposta BOA do CLI defasado continua valendo (só a falha
  #      ganharia a causa certa) — a trava vira diagnóstico, não mais gate.
  registra defasada_vale "defasagem detectada sem descartar o veredito do CLI defasado" \
    's%    1) ledger_defasada=1; ledger_ok=0 ;;%    1) ledger_defasada=1 ;;%'
  # (f3) frescura NÃO verificável lida como "em dia": prova ausente virando aprovação.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra frescura_nao_verificavel_ok "frescura nao verificavel tratada como em dia (fail-open)" \
    's%    \*) if \[ "$ledger_ok" = 1 \]; then%    *) if false; then%'
  # (f4) a edge da leva defasada perde o ramo próprio e cai no "nenhuma sonda" — volta ao DISPARE,
  #      que é o ruído caro de 2026-09-10 (sonda numa edge que ESCREVE).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra defasada_no_dispare "edge da leva defasada voltando ao DISPARE (ramo proprio neutralizado)" \
    's%  elif \[ "$ledger_defasada" = 1 \] && \[ -z "$servido" \]; then%  elif false; then%'
  # (f5) o fecho deixa de ser TRANSITIVO (só a entrada): a allowlist do cron é um IMPORT, não o CLI.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra fecho_sem_imports "fecho do CLI sem seguir imports (so o arquivo de entrada)" \
    's%        if \[ -f "$LEDGER_RAIZ/$c" \]; then fila="${fila:+$fila }$c"; break; fi%        if [ -f "$LEDGER_RAIZ/$c" ]; then break; fi%'
  # (f6-f8) as três portas por onde o fecho REAL chega a `src/lib/`: o alias `@/`, o import
  #      DINÂMICO e o `import(` que o Prettier quebra em linhas — o levantamento à mão deste PR era
  #      cego à 2a e achou 9 arquivos onde havia 11.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra fecho_sem_alias "fecho do CLI ignorando o alias @/" \
    's%        @/\*)      _caminho="src/${imp#@/}" ;;%        @/*)      continue ;;%'
  registra fecho_sem_import_dinamico "fecho do CLI sem reconhecer import dinamico" \
    's%(from|import|require)\[\[:space:\]\]\*\[(\]?%(from|import|require)%'
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra fecho_por_linha "fecho do CLI lendo por linha (import quebrado em linhas some)" \
    's%    done < <(tr .\\n. . . < "$LEDGER_RAIZ/$f"%    done < <(cat < "$LEDGER_RAIZ/$f"%'
  # (f9) o remédio perde o par mínimo: tree SUJO recebe o checkout pelado, que falharia ou levaria
  #      a mudança local junto — e a defasagem voltaria na próxima medição.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra remedio_ignora_tree_sujo "remedio ignorando tree sujo (checkout pelado sempre)" \
    's%     && \[ -z "$st" \]; then%     || true; then%'
  # (f10) a comparação sai de DEPOIS para ANTES da chamada: a REF que o `git fetch` do CLI trouxe
  #      fica fora da medição — a corrida do 16o volta a imprimir a mensagem de 2026-09-10.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra frescura_antes_da_chamada "frescura medida ANTES da chamada (cega ao fetch do CLI)" \
    's%^  invocar_ledger > "$tmp/ledger.json"%  cli_frescura; frescura_antes=$?; invocar_ledger > "$tmp/ledger.json"%;s%^  cli_frescura; frescura_rc=\$?%  frescura_rc=$frescura_antes%'
  # (f11) PRECISÃO: a comparação vira o repo inteiro — o mapa, que muda a cada merge de edge, e
  #      qualquer script vizinho passariam a bloquear o ledger em quase todo /fecho.
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra frescura_repo_inteiro "frescura comparando o repo inteiro (e nao o fecho do CLI)" \
    's%--exit-code "$REF" -- "${arqs\[@\]}"%--exit-code "$REF"%'
  # (f12) o rodapé para de segurar a mão de quem pula do aviso direto para o deploy.
  registra rodape_sem_sincronizar "rodape deixando de mandar sincronizar antes de agir" \
    '/ANTES DE AGIR: esta lista foi medida SEM o ledger/d'
  # (f13) o aviso volta a REPETIR a saída do CLI defasado — o remédio de outra versão, que em
  #      2026-09-10 era um UPDATE desativando o alvo aprovado (#2464).
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra defasada_repete_cli "defasada repetindo a saida do CLI de outra versao (remedio alheio)" \
    's%    exit dele: $ledger_rc)"%    exit dele: $ledger_rc) $ledger_motivo"%'

  # guard de fuso: as duas sabotagens sao SIMETRICAS de proposito, porque o guard erra dos DOIS
  # lados e cada lado tem um caso diferente para pegar. Frouxo demais (aceita tudo) devolve o bug
  # original — janela deslocada suprimindo chip em verde. Apertado demais (recusa tudo) quebraria o
  # /fecho inteiro, e so o PAR MINIMO do 14c enxerga isso: sem ele, um guard que recusasse toda
  # data passaria na suite alegando que "guarda".
  registra fuso_frouxo "fuso: sufixo aceitando QUALQUER coisa (guard frouxo, volta o bug)" \
    '/\*gmt\*/s/.*/          *) ;;/'
  registra fuso_apertado "fuso: sufixo nao casando NADA (guard apertado, recusa UTC legitimo)" \
    '/\*gmt\*/s/.*/          __nunca_casa__) ;;/'
  # guard de HORA (#2625): a mesma simetria, mais os dois modos de errar que so ele tem. Cada uma
  # declara na lista SABOTAGENS o assert que TEM de acusa-la (os IDs H<n> que o #2625 escolheu).
  registra hora_frouxo "hora: detector aceitando QUALQUER coisa (guard frouxo, volta o bug)" \
    '/# tem hora$/s/.*/          *) ;;/'
  registra hora_apertado "hora: detector nao casando NADA (guard apertado, recusa data COM hora)" \
    '/# tem hora$/s/.*/          __nunca_casa__) ;;/'
  # o detector ingenuo: `:` solto casa o offset `-03:00`, que o git le como HORA LOCAL (06:00Z)
  registra hora_ingenuo "hora: detector ingenuo lendo o offset +-hh:mm como hora" \
    '/# tem hora$/s/.*/          *[0-9]:[0-9][0-9]*) ;;/'
  # o remedio volta a ser "<data> UTC" — a forma que o git le como a hora de agora
  # shellcheck disable=SC2016  # a expressao sed e PADRAO literal do alvo
  registra hora_remedio_ensina_bug "hora: remedio sugerindo '<data> UTC' (o guard volta a ensinar o bug)" \
    's/\$dia 00:00 UTC/$dia UTC/'
  # e a janela impressa: sem ela o ramo que suprime TUDO volta a decidir em silencio.
  registra janela_nao_impressa "janela efetiva deixando de ser impressa" \
    '/echo "janela:/d'

  # As 5 que ficaram SEM DENTE com a rodada isolada (2026-09-27) voltaram à lista em 2026-09-28:
  # quatro com o cenário que as isola (13d, 16f2, 16g2, 16h2) e a da mecânica provada em PAR, por
  # decisão do founder (as duas travas dela se tornam inalcançáveis uma à outra). O PAR da janela viva
  # (l5 + `-z "$servido"`) se desfez: com duas edges no 16f, cada trava cai sozinha no SEU assert — o
  # que as fazia parecer redundantes era o cenário. E a outra metade do contrato da l5 (edge FORA do
  # mapa não é candidata), que nem estava na lista, ganhou o 16f3. docs/historico/falsificacao-exit-nao-e-dente.md

  # A rodada só conta como vermelha com as QUATRO camadas (as do sync-reprocess):
  #   1. a sabotagem APLICOU e não quebrou a sintaxe (as travas de aplica());
  #   2. a suíte rodou INTEIRA: o RECIBO de término (locale e nº de asserts) e a LISTA de asserts
  #      executados — um ID por linha, com repetição — iguais aos do controle;
  #   3. CADA assert declarado está VERDE no controle e VERMELHO aqui (o mesmo assert virou);
  #   4. nenhum erro de execução do bash no alvo que o controle não tem — o alvo que morre no ramo
  #      do assert derruba o assert certo por CRASH, não por julgamento.
  # Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
  # suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
  # shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
  repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
  [ -z "$repetidos" ] || { printf '  \033[31mFALHA\033[0m SABOTAGENS com nome repetido: %s\n' "$repetidos"; falhou=1; }
  case "$SABOTAGENS" in *'|'*) printf '  \033[31mFALHA\033[0m SABOTAGENS com | (OU): declare por , (E)\n'; falhou=1 ;; esac
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    v="desc_$sab"; desc="${!v-}"; v="expr_$sab"; expr="${!v-}"
    if [ -z "$expr" ]; then
      printf '  \033[31mFALHA\033[0m "%s": na lista SABOTAGENS e SEM registro — nada foi sabotado\n' "$sab"; falhou=1; continue
    fi
    aplica || continue
    for loc in C "$utf8"; do
      ctl="$logs/controle.$loc.log"; log="$logs/sabotada-$sab.$loc.log"
      # subshell de proposito: a sabotagem e o locale morrem com ela, e o ALVO global fica intacto
      : > "$log.stderr"
      # shellcheck disable=SC2030,SC2031
      ( export LC_ALL="$loc"; ALVO="$copia"; ERROS_DO_ALVO="$log.stderr"; fail=0; suite; [ "$fail" -eq 0 ] ) > "$log.cru" 2>&1; rc=$?
      sem_cor "$log.cru" > "$log"
      if [ "$rc" -eq 0 ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": suite ficou VERDE — assercao frouxa\n' "$loc" "$desc"; falhou=1; continue
      fi
      # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
      faltam=""
      for exigido in ${exigidos//,/ }; do
        if ! LC_ALL=C grep -Eq "^  ok +($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^  FALHA ($exigido) " "$log"; then
          faltam="$faltam $exigido"
        fi
      done
      if [ "$(recibo "$log")" != "$(recibo "$ctl")" ] || [ "$(executados "$log")" != "$(executados "$ctl")" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": a suite NAO rodou inteira (recibo [%s] x controle [%s], ou asserts ausentes/repetidos no log) — vermelho de aborto, nao de assert\n' \
          "$loc" "$desc" "$(recibo "$log")" "$(recibo "$ctl")"
        falhou=1
      elif [ "$(erros_exec "$log")" != "$(erros_exec "$ctl")" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": vermelha com ERRO de execucao no alvo — o assert caiu por crash, nao por julgamento\n' "$loc" "$desc"
        falhou=1
      elif [ -n "$faltam" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": vermelha, mas o assert declarado NAO virou (verde no controle -> vermelho aqui):%s · vermelhos: %s\n' \
          "$loc" "$desc" "$faltam" "$(vermelhos "$log")"
        falhou=1
      else
        printf '  \033[32mok\033[0m   [%-11s] "%s" -> vermelho no assert declarado (%s) · vermelhos: %s\n' \
          "$loc" "$desc" "$exigidos" "$(vermelhos "$log")"
      fi
    done
  done
  for r in $registradas; do
    case " $SABOTAGENS " in
      *[[:space:]]"$r:"*) ;;
      *) printf '  \033[31mFALHA\033[0m "%s": registrada e FORA da lista SABOTAGENS — nunca roda\n' "$r"; falhou=1 ;;
    esac
  done

  [ "$falhou" -eq 0 ] && { printf '\n== falsificacao: todas as sabotagens ficaram vermelhas NO assert que declaram ==\n'; exit 0; }
  printf '\n== falsificacao REPROVOU ==\n'; exit 1
fi

# ------------------------------------------------------------------- execução ---
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
[ -n "$utf8" ] || { echo "FALHA: nenhum locale UTF-8 disponivel"; exit 1; }

total=0; contagens=""
for loc in C "$utf8"; do
  # shellcheck disable=SC2031
  export LC_ALL="$loc"
  fail=0
  suite
  total=$((total + fail))
  # o RECIBO: `terminou` só é escrito na última linha da suíte — um `return` no meio pularia os
  # asserts seguintes EM VERDE, porque o `fail` só conta o que rodou
  if [ "$terminou" != "$loc" ]; then
    printf '  \033[31mFALHA\033[0m a suite NAO chegou ao fim em %s (sem recibo de termino)\n' "$loc"; total=$((total + 1))
  fi
  contagens="${contagens:+$contagens }$n_asserts"
done
# ...e o MESMO nº de asserts nos dois locales: assert que só roda num deles é metade da cobertura
# fingindo ser inteira (#1483)
if [ "$contagens" != "$n_asserts $n_asserts" ]; then
  printf '  \033[31mFALHA\033[0m nº de asserts difere entre os locales (%s)\n' "$contagens"; total=$((total + 1))
fi
[ "$total" -eq 0 ] || { printf '\n\033[31m== REPROVOU ==\033[0m\n'; exit 1; }
printf '\n\033[32m== verde nos 2 locales ==\033[0m\n'
