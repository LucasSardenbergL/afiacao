# O sensor de custo do consult: por que o `--json` do Codex — o caminho óbvio — trocaria o guard e a régua

> Entrega de **2026-09-05**: `scripts/codex-async.sh` passou a imprimir o CUSTO no cabeçalho do parecer
> (`… · tentativa 1 · 131s · 14.243 tokens`). Contexto: o #2211 fixou os critérios de nível de reasoning
> e criou a obrigação de registrar **nível + segundos + tokens** em cada consult — o sensor de que o
> piloto do `ultra` depende. Ele não existia: o cabeçalho trazia modelo/reasoning/tentativa, e os
> números das medições eram copiados à mão do terminal.

## O caminho óbvio, e por que ele foi recusado

`codex exec --json` emite eventos JSONL e um `turn.completed` com `usage` estruturado. Parece a fonte
certa: dado tipado em vez de parse de texto. Duas medições no worktree (codex-cli 0.153.4, conta paga,
uma execução de sucesso e uma de 400 por modo) mostraram que o custo dele não está no parse:

**1. `--json` reroteia o DIAGNÓSTICO, não só o formato.** No modo textual o stderr carrega o log
inteiro (eco do prompt, warnings, linhas `ERROR:`) e o stdout carrega só a última mensagem. Com
`--json` o stderr encolhe para uma linha (39 bytes: "Reading additional input from stdin…") e o erro
migra para o **stdout**, como `{"type":"error"…}` e `turn.failed`. Toda a classificação do wrapper lê o
stderr: cota→75, modelo→78, permanente, transitório — as regras que custaram dois dias de diagnóstico
em agosto. O sensor é telemetria; a classificação é guard. **Trocar a fonte do guard para instalar um
sensor inverte a hierarquia de risco**, e o CI não veria a inversão: os testes de erro passariam a
medir um caminho que a produção não usa mais.

**2. `--json` muda o EIXO do número.** O `usage` do JSONL conta `input_tokens` (19.985 medidos, com
12.160 de cache); o rodapé textual da mesma classe de execução diz `7.823`, cobrando o não-cacheado.
As medições já publicadas — xhigh 10,0k · max 14,2k · ultra 5,2k, em CLAUDE.md e money-path.md — vieram
do rodapé. Publicar `input_tokens` daria um número maior, tecnicamente defensável e **incomparável com
a série histórica**, justo no sensor cuja função é comparar consumo entre níveis. É a armadilha do
"corte por ranking" em outra roupa: o problema não é a precisão do número, é ele não medir o mesmo eixo
da decisão que serve.

⇒ Lê-se o rodapé textual. Zero mudança no caminho de decisão.

## O que o sensor promete, e o que ele se recusa a prometer

`tokens ?` significa **ausente**, não zero. Rodapé que sumiu (versão futura do CLI) ou valor
não-numérico degradam para `?`. Fabricar `0` registraria no PR um consult que "não custou nada" —
exatamente o dado que envenena a comparação do piloto. Sensor degrada; guard fecha.

Os segundos são os da **tentativa vencedora**, com o backoff fora da conta: o PR registra quanto o
Codex levou para responder, não quanto o wrapper esperou entre tentativas.

## O prompt não pode decidir o número (a mesma lição, num lugar novo)

O stderr do codex reimprime o prompt inteiro sob "user", e o ritual `/codex` cola parecer anterior —
**com rodapé** — dentro do prompt o tempo todo. Duas camadas independentes, cada uma com caso próprio
na suíte e cada uma falsificada em separado:

- **posição**: lê as duas últimas linhas não-vazias, não a última ocorrência do marcador. Buscar o
  marcador acharia a citação colada no prompt sempre que o codex não emitisse rodapé nenhum.
- **cauda do eco**: se o stderr TERMINA exatamente nas duas últimas linhas do prompt, o que está ali é
  eco, não rodapé → `?`. É a única forma de o eco alcançar o fim do arquivo.

Reusar a remoção total de linhas ecoadas (a que a classificação de erro usa) parecia economia de
código e foi medido como **regressão do sensor**: ela apaga também o marcador REAL sempre que o prompt
cita "tokens used", ou seja, perde o dado justamente no consult que discute este wrapper. Camada
compartilhada só serve quando as duas usam o mesmo alvo — lá o alvo é o bloco do eco, aqui é o fim do
arquivo.

## Evidência

| Prova | Resultado |
| --- | --- |
| `bash -n` + `shellcheck` (wrapper e suíte) | exit 0 |
| `bash scripts/test-codex-async.sh` | 51 casos verdes (39 antes), exit 0 |
| Mesma suíte em `LC_ALL=C` e `pt_BR.UTF-8` | 51/51 nos dois |
| Falsificação, uma camada por vez (6 sabotagens) | as 6 ficaram vermelhas, cada uma no caso próprio |
| Execução real (`gpt-6-astra`/`max`, prompt "responda apenas: OK") | `… · tentativa 1 · 8s · 7.889 tokens`, exit 0 |

O número da execução real bate com o rodapé cru medido no mesmo dia com o `codex exec` direto (7.823,
mesmo prompt; a diferença é cache). As 6 sabotagens: segundos constantes, segundos somando tentativas,
`?` virando 0, queda da camada de posição, queda da camada de cauda e queda da validação numérica.
