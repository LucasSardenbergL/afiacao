# Vigia de PR que dizia "CI VERMELHO" para check não-obrigatório — o 4 passa a vir só do obrigatório

**2026-09-14.** O `scripts/pr-watch.sh` (o vigia que o CLAUDE.md §Merge manda armar a cada PR) saía
**exit 4 = CI VERMELHO** assim que QUALQUER check do rollup reprovava. Obrigatório só existe um — o
`validate`, o único que o `auto-merge.yml` espera — e o `mutation-check` (não-obrigatório, com um
contrato pré-existente vermelho, #2474) pintou o alarme três vezes no mesmo PR, o #2472:

| # | run · head | estado real | o vigia disse |
|---|---|---|---|
| 1 | 34852689923 · dcfad7546 | `validate` success, `mutation-check` failure | exit 4 "checks: mutation-check" |
| 2 | 34858141569 · aa9833d06 | `mutation-check` failure (HTTP 504 no `setup-deno`), `needs` do `validate` ainda rodando | exit 4 ANTES de o `validate` terminar — que terminou success |
| 3 | depois de `gh pr ready 2472` | o PR **mergeou** às 15:31:40Z (squash 94e2dd881) | exit 4 "checks: mutation-check" |

É o falso POSITIVO gêmeo do falso negativo do #1396 (o 5 que era 6), e mata o alarme do mesmo
jeito: a sessão recebe "vermelho", reconsulta à mão, e aprende a ignorar o 4.

## O desenho: vermelho no rollup é GATILHO; quem decide é o obrigatório

- A 1ª consulta segue sendo o `gh pr view` (MERGED/CLOSED/DIRTY intactos). Se o rollup tem check
  vermelho ou sem veredito, uma 2ª consulta pergunta ao GitHub quais são OBRIGATÓRIOS:
  `isRequired(pullRequestNumber:)` via `gh api graphql` — a proteção da branch (e rulesets) avaliada
  contra cada check, pelo mesmo critério que segura o auto-merge. Sem alarme no rollup, nada muda.
- Obrigatório vermelho → 4 `CI VERMELHO [<checks>]`; obrigatório sem veredito → 4
  `CI SEM VEREDITO [<checks>]`. Os nomes entre colchetes: a marca ASCII amarra check e veredito.
- Não-obrigatório → `⚠️ AVISO NAO-OBRIGATORIO [<checks>]` na saída — uma vez por conjunto, não a
  cada poll — e a vigília **segue** até MERGED / fechado / obrigatório vermelho. Nunca calado.

### Por que não `gh pr checks --required` (medido, não suposto)

O `validate` é um job AGREGADOR (`needs:` do fan-out) e o check-run dele só **nasce** depois dos
needs: no head dcfad7546 os check-runs do fan-out têm ids 104004338xxx e o do `validate` é
104007998167, com início às 14:09:39Z — 3s após o fim do último need (`gates-e-falsificacao`,
14:09:36Z); no aa9833d06 ele começa às 14:58:51Z, 8 min depois de o `mutation-check` cair. Nessa
janela não existe obrigatório reportado, e o `--required` sai com **erro** ("no required checks
reported") — indistinguível de rede fora sem ler texto de stderr. No GraphQL, "nenhum obrigatório
ainda" é uma lista sem `isRequired: true`, e erro é rc≠0.

## "Não sei se é obrigatório" é 6, nunca "não é"

Cada jeito de a 2ª consulta não responder vira "não consultei" → cartada final → **6**:

| caso | por que não pode degradar |
|---|---|
| rc≠0, corpo vazio | rede/rate-limit |
| **corpo legível E rc=1** | é assim que o gh entrega resposta PARCIAL do GraphQL — medido: PR inexistente devolve `{"data":…,"errors":[…]}` no stdout com exit 1 |
| corpo ilegível | gh vivo devolvendo lixo |
| `hasNextPage: true` | o obrigatório vermelho pode estar na página 2 (a capa silenciosa) |
| check com alarme sem `isRequired` booleano | ausente ≠ false |

A query é `Int!`, então `<numero-PR>` que não é número sai **64** na entrada: URL ou branch passaria
no `gh pr view` e só quebraria no primeiro vermelho — como 6, justo quando o veredito importa.

## Evidência

- **Vermelho antes do código:** a suíte nova contra o vigia antigo — os `nao-obrig-*` saíam 4
  (queriam 0), os `req-*` saíam 4 (queriam 6), `pr-nao-numerico` saía 0 (queria 64); os controles
  (MERGED/CLOSED/DIRTY/5/6/relógio) verdes. Depois do código: `PASS`, exit 0.
- **Ao vivo, contra o GitHub real:** a query extraída do script no #2472 → `required=[validate]`,
  `mutation-check isRequired=false`, `hasNextPage=false`. E o script INTEIRO com só o `gh pr view`
  forçado a OPEN (GraphQL verdadeiro) → `AVISO NAO-OBRIGATORIO [mutation-check]` e exit 5, onde o
  antigo dizia 4.
- **Falsificação** (`bash scripts/test-pr-watch.sh --falsificar`, que entrou no `test:falsificacao`):
  controle verde na MESMA invocação, 11 sabotagens vermelhas pela marca ASCII certa em `LC_ALL=C` e
  `LC_ALL=pt_BR.UTF-8`, alvo intacto por conteúdo — 63s na M2, 24 execuções da suíte a ~2,6s cada:
  o tempo bate com n×suíte, então ela rodou. A marca fixa até o exit ERRADO esperado
  (`FAIL [nao-obrig-mergeia] exit: want 0, got 4`), então crash de `set -u` (exit 1) não se passa
  pela regressão.
- **Controle negativo do juiz** (script transitório no scratchpad; defeitos plantados no ARNÊS,
  nunca no vigia): marca errada → "vermelho SEM a marca" nos 2 locales; padrão que não casa →
  "sabotagem vazia"; sabotagem inócua (tolerância do salto 5→6) → "passou VERDE" nos 2 locales; as 9
  intactas seguem ok; e a suíte sempre-vermelha faz o controle abortar em 5s sem julgar nenhuma
  sabotagem. O juiz reprova pelos três motivos — não só "fica vermelho".

## A regra

**Alarme só é alarme se o vermelho for do eixo que decide o desfecho.** Um vigia que junta
"obrigatório" e "informativo" no mesmo exit code fabrica falso positivo sempre que o informativo
estiver podre — e o informativo apodrece justamente porque não bloqueia. Separe na FONTE que o
próprio GitHub usa para decidir (`isRequired`), mostre o resto como aviso (nunca calado) e trate
"não consegui classificar" como desconhecido, nunca como "não bloqueia".
