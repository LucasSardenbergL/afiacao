# Ocupação de contexto POR ARQUIVO — a linha de base, e o que ela derrubou

**Medido em 2026-09-07** · janela de **30 dias**, **685 sessões**, **1.529 chaves distintas**
(projetos `*afiacao*` em `~/.claude/projects`). Régua:
[`scripts/ocupacao-contexto.sh --por-arquivo`](../../scripts/ocupacao-contexto.sh).
Spec do desenho: `docs/superpowers/specs/2026-09-07-ocupacao-por-arquivo-design.md`.

## 1. A pergunta

`piso-de-contexto.md` já tinha separado piso (25,9% do custo de entrada) de **ocupação** (74,1%),
e `ocupacao-contexto.sh` já media a ocupação **por FERRAMENTA** — Read ~55%, Bash ~40%. Isso diz
que Read é caro. Não diz **qual arquivo** destilar primeiro, que é a decisão que estava na mesa.

A hipótese registrada no spec era: *espera-se `docs/agent/money-path.md` no topo; se o topo for
código (`src/**`), a frente de destilação muda de prioridade.*

**Nenhuma das duas.** O topo não é doc nem código.

## 2. A linha de base

| grupo | % da ocupação | chaves |
|---|---:|---:|
| **chamada sem `file_path`** (Bash, Agent, MCP, TaskStop…) | **81,3%** | 90 |
| `docs/agent/` | 4,2% | 12 |
| outros (`/tmp`, `~/.claude`, raiz…) | 2,9% | 693 |
| `src/` | 1,6% | 221 |
| `.superpowers/` | 1,5% | 26 |
| `scripts/` + `db/` | 1,4% | 187 |
| `supabase/` | 0,9% | 201 |
| `docs/` (fora de `agent/`) | 0,9% | 99 |

> Soma 94,7%: os ~5% que faltam são a cauda de mais de mil arquivos que arredondam para 0,0%
> cada na saída formatada. Os grupos grandes são firmes; a cauda está **sub**contada — nunca o
> contrário.

Top individual:

| chave | n | chars totais | maior | ocupação |
|---|---:|---:|---:|---:|
| `(Bash - sem arquivo)` | 65.754 | 58.873.449 | 28.980 | **77,1%** |
| `docs/agent/money-path.md` | 66 | 1.848.309 | 51.831 | 2,7% |
| `(Agent - sem arquivo)` | 128 | 419.548 | 18.461 | 1,6% |
| `(mcp__claude-in-chrome__computer …)` | 73 | 3.137.679 | 165.329 | 1,4% |
| `docs/agent/database.md` | 34 | 577.394 | 46.668 | 0,7% |
| `docs/agent/deploy.md` | 23 | 166.070 | 41.628 | 0,3% |
| `docs/agent/tintometrico.md` | 18 | 189.885 | 41.544 | 0,3% |

## 3. O que isso derruba

**Bash é 77,1%, não ~40%.** O número antigo veio das 3 sessões mais caras de uma janela de 7 dias;
sobre 685 sessões e 30 dias, ele quase dobra. E `docs/agent` **inteiro** — os doze arquivos, toda a
documentação de agente do repo — vale **4,2%**.

⇒ **Destilar `docs/agent` até o zero absoluto renderia 4,2% da ocupação.** Cortar 10% do volume de
saída de Bash renderia **7,7%** — quase o dobro, sem apagar uma linha de documentação. A frente que
o briefing original queria abrir é real, mas é a **segunda**; a primeira é o tamanho das saídas de
comando, onde o repo já tem o `bash-contexto-nudge` e onde a alavanca está subusada.

Isso não desqualifica destilar `money-path.md`: ele é o arquivo nº 1 e sozinho pesa **mais que
todo o resto de `docs/agent` somado**. Só reordena o valor esperado.

## 4. Uma correção de número: leitura ≠ tamanho do arquivo

O spec estimava **43.586 tokens por leitura** de `money-path.md`, derivando de `157 KB ÷ 3,5`.
Medido: as 66 leituras somam 1.848.309 chars ⇒ **28.005 chars (≈8.000 tokens) por leitura**, e a
**maior de todas** foi 51.831 chars (≈14.800 tokens) — contra os 161.270 bytes que o arquivo tem
hoje. **Nenhuma leitura trouxe o arquivo inteiro.**

⇒ o custo real por leitura é **~5,5× menor** que o estimado pelo tamanho. Tamanho de arquivo é
teto, não medida — e a diferença entre os dois é a única coisa que separa "estimei" de "medi".
Vale para todo o resto da tabela: as colunas `n`/`chars tot` são observação, não derivação.

## 5. Por que `Bash` aparece no ranking em vez de sumir

Decisão do founder em 2026-09-07, e a linha de base mostra o tamanho do que estava em jogo: um
ranking "por arquivo" que descartasse o que não tem `file_path` estaria **escondendo 81,3% do
custo** e apresentando `money-path.md` como ~12% do problema quando ele é 2,7%. Ausência
apresentada como medida — o defeito de classe que esta régua existe para achar, cometido pela
própria régua. Por isso `(Bash - sem arquivo)` é uma linha, não uma omissão.

## 6. O sensor de instruções: fase 2 encerrada

Ver [`split-claude-md-sensor.md`](split-claude-md-sensor.md) para o registro completo. Em resumo,
os dois gates abertos desde 2026-08-22 fecharam:

- **gate 1** (regra chega no subagente?): **RESPONDIDO**. O hook `InstructionsLoaded` não é emitido
  para subagente — cegueira **estrutural**, não ausência de caso. Na mesma janela havia 24
  diretórios `subagents/` e 148 arquivos de subagente contra **0** eventos; `b0466403` rodou 34
  subagentes e emitiu 3 eventos. Mas o CLAUDE.md **chega lá**: uma sonda com subagente proibido de
  usar tools (`tool_uses: 0`) citou a primeira linha, listou as 10 seções e acertou três regras
  críticas. ⇒ o orçamento do `claude:size` se justifica.
- **gate 2** (o que sobrevive ao `/compact`): destravou sozinho — 0 eventos `compact` em 22/08,
  **18** hoje.

E o sensor deixou de fabricar em dois pontos: `bytes_arquivo`/`palavras_arquivo` agora são medidos
do disco (o payload nunca traz `file_content` — 0 de 1.741 eventos), e `agente` deixou de ter o
default `"principal"`, que rotulava como observação o que nunca foi observado.

## 7. Como re-medir

```bash
bash scripts/ocupacao-contexto.sh --por-arquivo --dias 30 --linhas 40
```

`--todos` abre para a máquina inteira; `--por-ferramenta` volta à régua antiga (mesma fonte, mesmo
total). Execução completa termina em `OCUPACAO-CONTEXTO-OK`; **sem esse marcador, a tabela na tela
não é um resultado.**

## 8. Duas armadilhas que este levantamento pagou

1. **`xargs -a` não existe no BSD**, e o `2>/dev/null` ao lado converteu `illegal option` em saída
   vazia. O veredito a um passo de ser escrito era "`docs/agent` nunca é lido" — contra 200
   leituras em 17 dias. Catalogada como armadilha #17 em
   [`evidencia-positiva-shell.md`](evidencia-positiva-shell.md).
2. **A saída da régua dependia do locale.** Sob `pt_BR.UTF-8` o `printf` do awk emite `0,2` em vez
   de `0.2` — e como a chave de ordenação é um `%018.3f`, o `sort -rn` do meio do pipeline podia
   **reordenar o ranking** conforme o ambiente de quem rodasse. Pego pela exigência do CLAUDE.md de
   falsificar nos **dois** locales; invisível em qualquer um deles sozinho. Corrigido com
   `export LC_ALL=C`, e coberto por um caso que força os dois locales em vez de esperar que o
   ambiente colabore — com `SKIP` explícito, e não "ok", quando a máquina não tem locale de vírgula
   instalado.

Contar **menção** em vez de leitura foi o terceiro erro, cometido e medido antes do spec: dava 505
ocorrências para `money-path` contra 64 leituras reais (8×), e o contaminante era o índice do
próprio CLAUDE.md. Só `tool_use.input.file_path` conta.
