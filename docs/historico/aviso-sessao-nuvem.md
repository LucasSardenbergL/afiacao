# A sessão na nuvem agora avisa o founder — num hook próprio, que não depende do gstack

**2026-09-27.** Continuação de [codex-em-sessao-cloud.md](codex-em-sessao-cloud.md). Lá, "o Codex
parou de funcionar" era troca de máquina: sessões abertas como **Cloud** no app desktop rodavam num
container da Anthropic, sem codex, `psql-ro`, heavy e gstack, e o founder não percebeu. A decisão do
mesmo dia foi que o Codex roda só no Mac, e que sessão que precisa dele abre como **Local**. Faltava
o founder **ver** em que máquina está.

## O buraco

O único sensor de boot que falava na nuvem era o `vigia-gstack.sh`, e lá ele emite **só**
`additionalContext`, que só o modelo lê. É de propósito ([gate-gstack-fail-open.md](gate-gstack-fail-open.md)):
na nuvem a ausência do gstack é por desenho e não deve soar como alarme. O efeito colateral é que
nada chegava à tela do founder. Sensor com destinatário errado é sensor mudo.

## A decisão: hook separado, e o `vigia-gstack.sh` intocado

`.claude/hooks/vigia-nuvem.sh`, no `SessionStart` com matcher `startup`, ao lado do `vigia-gstack.sh`.
Estender o sensor do gstack seria errado por dois motivos, e ambos são de comportamento:

- **Acoplamento.** O `vigia-gstack.sh` cala na nuvem quando o gstack **está** lá (caso C6 da suíte
  dele: "o sensor mede, não presume"). Com o aviso de máquina morando nele, no dia em que alguém
  instalasse o gstack na nuvem (a opção A recusada) o aviso sumiria, e codex, `psql-ro` e heavy
  continuariam faltando. O assunto aqui é a **máquina**, e o destinatário é o **founder**.
- **Reversão.** O C5 do `test-vigia-gstack.sh` exige que a nuvem **não** tenha `systemMessage`. Pôr o
  aviso lá seria desfazer a decisão do gstack para resolver outro problema.

O predicado é o **mesmo** do `vigia-gstack.sh` e do `codex-async.sh` (`CLAUDE_CODE_REMOTE` igual a
`"true"`), para o aviso e o wrapper nunca discordarem sobre a máquina.

## O que mudou

- `.claude/hooks/vigia-nuvem.sh`: na nuvem, `systemMessage` com o aviso para o founder (127
  caracteres, o texto dele), mais `additionalContext` para o modelo, com a marca `SESSAO-NUVEM` e a
  instrução: não instalar nem contornar daqui; ler prod pelo conector Lovable (`--sql-nuvem`, do
  #2601, que entrou na main no mesmo dia), nunca por chip para o Mac; e dizer logo no início da
  resposta que money-path e 2ª opinião pedem sessão Local (ou o Caminho B), porque dependem do
  Codex. Fora da nuvem, `{}` exato.
- `.claude/settings.json`: o hook no grupo `startup` do `SessionStart`.
- `scripts/test-vigia-nuvem.sh` no `test:hooks` e no `test:falsificacao`.

Não entra no censo do `gates:frescura`: ele conta só hook que **nega** (deny dentro do envelope de
`PreToolUse`), e este é sensor.

## A suíte

Oito casos. Os três primeiros cobrem o que uma suíte só de **saída** deixaria passar:

| caso | o que prova |
| --- | --- |
| C1 | o `settings.json` liga o hook no `SessionStart` com matcher `startup` (sensor que ninguém liga nunca roda) |
| C2 | o arquivo é executável: o `settings.json` o chama direto, sem `bash`, e o Write cria 100644 |
| C3 | no Mac a saída é `{}` **exato**, nem aviso nem contexto |
| C4 | na nuvem, UM objeto JSON com `hookSpecificOutput.hookEventName = "SessionStart"` |
| C5 | na nuvem, o `systemMessage` traz NUVEM, Codex, psql-ro, heavy, gstack e Local |
| C6 | na nuvem, o contexto do modelo traz `SESSAO-NUVEM`, money-path e Local |
| C7 | o aviso tem de 1 a 200 caracteres (o `jq` conta caractere, então vale igual nos dois locales) |
| C8 | `CLAUDE_CODE_REMOTE=false` é Mac: só `"true"` é nuvem |

A suíte executa o hook **direto**, como o harness, e não com `bash "$HOOK"`. Rodar com `bash` esconde
um arquivo sem bit de execução, justamente o defeito do C2.

**Falsificação:** 13 sabotagens, uma por camada, cada uma exigindo `FAIL` no caso que ela mira, nos
dois locales. Entre elas: sensor mudo; aviso em qualquer máquina; contexto vazando no Mac (prova que o
C3 exige `{}` exato, e não só "sem aviso"); envelope sem `hookEventName`; um JSON a mais no stdout;
**aviso só para o modelo**, que é o desenho do gstack na nuvem e o defeito que esta entrega corrige;
aviso sem a saída "Local"; predicado frouxo; aviso inchado; `settings.json` sem o hook; hook no
matcher errado; hook sem bit de execução. O controle é a **mesma** invocação da sabotagem (cópia em
`$tmp`, `chmod +x`, os dois overrides, o mesmo `LC_ALL`) com a sabotagem trocada por nada, e roda
antes de cada uma ([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)).

Medido no Mac: 26 de 26, com o arnês externo tanto em `LC_ALL=C` quanto em `pt_BR.UTF-8`, em ~12,5 s.
Uma execução da suíte leva 0,241 s, e 52 execuções dão os mesmos ~12,5 s: o arnês roda a suíte em
cada passo. E o controle tem dente: com a suíte sabotada para ficar sempre vermelha (`ok()` marcando
`fail=1`), o `--falsificar` sai 1 pela marca do controle, com **0** sabotagens aprovadas, nos dois
locales. A cópia limpa, no mesmo lugar, aprova as 26.

## A prova no harness real (sonda, não leitura de doc)

Teste unitário prova o JSON que eu acho certo. Quem decide é o harness, e foi exatamente essa
distância que deixou o `check-gstack.sh` 136 dias sem negar nada. O ramo `systemMessage` +
`hookSpecificOutput` do `vigia-gstack.sh` nunca tinha disparado de verdade: no Mac o gstack existe.

Sonda no binário do app desktop (**Claude Code 2.1.281**), headless, com um `settings.json` temporário
que liga **só** este hook (`--setting-sources local` num diretório sem settings, `--strict-mcp-config`).
O `CLAUDE_CODE_REMOTE=true` vai só na linha de comando do hook, então o CLI não se acha na nuvem. O
transcript ficou num `CLAUDE_CONFIG_DIR` descartável, fora do `~/.claude` do founder. Cada disparo de
hook grava seus `attachment` no transcript, e foi isso que se leu:

| modo | attachments gravados pelo harness |
| --- | --- |
| nuvem | `hook_success` + **`hook_system_message`** com o texto exato do aviso + `hook_additional_context` com `SESSAO-NUVEM` |
| Mac (controle) | só `hook_success`: nenhum aviso, nenhum contexto |
| envelope sem `hookEventName` | **`hook_non_blocking_error`**, e a saída inteira descartada, `systemMessage` junto |

A 3ª linha é achado novo. O [doc do gstack](gate-gstack-fail-open.md) tinha medido que o envelope
incompleto anula o `permissionDecision`. Agora está medido que ele derruba também o `systemMessage` de
**topo**: o harness não aproveita metade de uma saída inválida.

Dois detalhes de método que valem para a próxima sonda:

- **`--include-hook-events` mostra o stdout CRU, não o que o harness fez com ele.** O
  `hook_response` do stream traz o JSON e `outcome: success`, e não diz se o `systemMessage` virou
  aviso. A prova de parse é o attachment no transcript (`hook_system_message`,
  `hook_additional_context`, `hook_non_blocking_error`).
- **O modelo não precisa responder.** O CLI headless do Mac está sem login ("OAuth session expired",
  e "Not logged in" no config descartável). Os attachments de SessionStart são gravados antes da
  chamada à API, então a sonda não gasta cota.

## O que ainda não foi medido

O desenho de tela da sessão cloud. A sonda prova que o harness gera o `hook_system_message`, que é o
que a interface desenha, mas no Mac e na 2.1.281, e a nuvem roda a 2.1.283. A prova final é do
founder: abrir uma sessão **Cloud** nova depois do merge e ver o aviso no boot.

## Lições

- **Aviso tem destinatário.** `additionalContext` fala com o modelo, e `systemMessage` fala com o
  humano. "Existe um sensor na nuvem" não provava que o founder era avisado, porque o único sensor
  falava com a pessoa errada.
- **O teste roda o alvo do jeito que a produção roda.** `bash "$HOOK"` passa por cima do bit de
  execução, que é exatamente o que o harness exige.
- **Harness decide, suíte não.** Envelope se prova com sonda no binário real, lendo o que ele
  **gravou** (o attachment), não o que o hook imprimiu.
