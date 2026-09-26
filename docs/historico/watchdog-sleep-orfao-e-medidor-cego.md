# O watchdog vazava um `sleep` por consulta — e o medidor do conserto era cego nas duas formas da base

> **A classe (2026-09-21 → 25):** `kill` no PAI não é `kill` no FILHO. O hard-stop do
> `scripts/codex-async.sh` era `( sleep "$timeout_s" && kill "$pid" ) &`, encerrado com
> `kill "$watchdog"` — que mata o SUBSHELL. O `sleep` de dentro é reparentado para o init e vive o
> timeout inteiro (1200s). Um processo vazado por consulta, invisível até o `kern.maxproc` estourar:
> daí em diante TODO `fork` falha, e o vermelho que sai disso se disfarça de asserção frouxa.
>
> A segunda regra, mais cara: **consertar o medidor pode trocar um ponto cego pelo complementar.**
> O instrumento que contava `sleep` sobreviventes teve duas versões cegas, cada uma numa FORMA da
> base (a lista "antes"): `awk -v` com lista multi-linha MORRE no awk do BSD; `awk 'NR==FNR{…}' base -`
> não imprime NADA com a base VAZIA — que é a máquina limpa, o caso comum. A sonda do medidor só
> exercitava a forma que tinha mordido por último. ⇒ **a sonda exercita TODAS as formas da entrada
> (vazia · uma linha · várias), não a do último incidente.**

Parente de [sonda-ausente-em-script-que-apaga.md](sonda-ausente-em-script-que-apaga.md) (medidor
cego devolve "vazio", e vazio vira "não vazou"), [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)
e [codex-fan-out-multi-agente.md](codex-fan-out-multi-agente.md) (mesmo bloco do wrapper).

## Defeito 1 — o vazamento

**Sintoma (founder, 2026-09-20, M2 com `kern.maxproc`=2000):** 921 `sleep 1200` vivos, 887 com
`ppid=1`; 1516 processos → `fork: Resource temporarily unavailable` em `lint:shell`, na suíte, em
`git`/`ps`. Só apareceu depois de instrumentar o `--falsificar` para imprimir o MOTIVO do vermelho.

**Reprodução, antes de aceitar o diagnóstico:** a suíte inteira deixou **+42** `sleep 1200`, todos com
`ppid=1` — e terminou VERDE. Isolado: `pkill -P "$w"` DEPOIS de `kill "$w"` devolve 1 (o pai já
morreu, o `-P` não acha ninguém); ANTES, devolve 0 e o `sleep` some.

**Medir exigiu isolar.** Outras worktrees rodavam `--falsificar` com o wrapper da main ao mesmo tempo
(~19 `sleep 1200` a cada 18s) — o delta global medido COM o conserto deu **+69**: era o vazamento
delas. Medida válida só com um default exclusivo (cópia do wrapper com `timeout_s=1199`, via
`CODEX_ASYNC_ALVO`): **main 42 vazados · com conserto 0**.

**Conserto.** No encerramento, `pkill -P "$watchdog"` ANTES de `kill "$watchdog"` — a ordem é metade
do conserto. Roda depois do `wait "$pid"`, com o codex já encerrado: o hard-stop não muda (caso
`trava` segue verde). A sonda do `pkill` exige resposta POSITIVA no preflight: um filho descartável
(`sleep 1 &`) que `pkill -P "$$"` tem de MATAR (`wait` → 128+sinal). `command -v` não bastaria (o
presente-porém-quebrado esvazia o guard igual). Ausente/quebrado → AVISO no stderr e a consulta segue
(é higiene, não o hard-stop) — nunca silêncio. Custo: ~50ms por invocação; suíte 18–20s → 21s.

**Resíduo conhecido:** se o codex responder ANTES de o subshell fazer o fork do `sleep`, o `pkill`
não acha nada e o fork pode cair entre o `pkill` e o `kill`. Não observado (0/42 no A/B com o stub
respondendo em ~10ms; o codex real leva minutos). Fechar de vez pede `kill -STOP` no subshell antes
do `pkill` — não feito.

## Defeito 2 — stdin herdado: hipótese REFUTADA

Hipótese: com o prompt por ARGUMENTO, o `codex exec` herdaria o pipe aberto do harness do Claude e
travaria lendo (`Reading additional input from stdin...`) até o watchdog. Reproduzida COM O WRAPPER
(não com o `codex exec` cru): stub que reporta o próprio stdin, depois stub fiel que faz `cat`. Com o
pipe do chamador aberto por 25s, o stub leu **0 bytes** e o wrapper respondeu em **0s**.

Causa da refutação: job assíncrono (`&`) sem redirecionamento de entrada recebe `/dev/null` (POSIX,
shell sem job control) — e o `codex exec` do wrapper é `&`, porque o watchdog precisa disso. O
travamento real foi com o `codex exec` CRU, em foreground.

Confundidor que quase virou "reproduziu": `sleep 25 | wrapper` media 25s — **o pipeline espera o
`sleep 25` também**. Meça o comando, não o pipeline.

O wrapper não mudou: um `</dev/null` explícito seria camada REDUNDANTE (sabotá-la fica verde). Ficou
um caso que FIXA o invariante — FIFO com escritor vivo no fd 7 (= pipe aberto) e stub fiel que lê o
stdin — e a sabotagem `<&0`: redirecionamento explícito desliga a regra do bash, o mesmo efeito de um
refactor que rodasse o codex em foreground (`FAIL [stdin-herdado]`, exit 143 pelo watchdog).

## O medidor, em três versões

| versão | diferença de conjunto | cego quando | como apareceu |
|---|---|---|---|
| v1 | `awk -v pre="$lista"` | base com ≥2 linhas: o awk do BSD morre ("newline in string") | `--falsificar` imprimiu o erro dezenas de vezes e a colheita não colheu (928 → 1193 procs) |
| v2 | `awk 'NR==FNR{p[$0];next} …' base -` | base VAZIA: `NR==FNR` segue verdadeiro na entrada 2, que vira "base" | sabotagem `watchdog_pkill` VERDE 8/8 num laço que limpava os órfãos entre rodadas; vermelha 3/3 fora dele |
| v3 | `getline < ENVIRON["BASE"]` no `BEGIN` | — | sonda cobre as duas formas; cada modo cego é acusado por exatamente uma das duas verificações |

Experimento decisivo da v2: a MESMA sabotagem, mudando só a base — vazia → "ok nenhum sleep
sobreviveu"; uma isca `sleep 977` viva → `FAIL [watchdog-sleep-vazado]`. Os vermelhos "corretos" de
antes dependiam de LIXO de rodadas anteriores povoando a base.

O `sem_eco_do_prompt` do wrapper usa o idioma da v2 com segurança: o 1º arquivo é
`printf '%s\n' "$prompt"`, que nunca é vazio. **`NR==FNR` só é seguro quando a base nunca é vazia** —
e isso tem de estar escrito no ponto de uso.

## Orçamento de CI

`gates-e-falsificacao`: 11m52s de 15m (run 36201289653); o bloco `codex-async` do `--falsificar`
levou 128s para 10 rodadas (~13s/rodada), e cada sabotagem custa 2 rodadas. Entraram duas
(`watchdog_pkill`, `stdin_herdado`) → ~+85s, folga de ~3m para ~1m45. A `watchdog_ordem` (pkill
DEPOIS do kill) saiu: a asserção conta processo sobrevivente e não depende da ordem, então a
sensibilidade à ordem invertida decorre de `watchdog_pkill` + o fato medido de que a ordem invertida
vaza (prova única, medidor v3, base vazia: `FAIL [watchdog-sleep-vazado]`).

## Armadilhas do próprio experimento

- Cópia da SUÍTE rodada de outro diretório resolve `$here/codex-async.sh` → wrapper inexistente →
  toda chamada dá 127 (e parece falta de `fork`). Aponte `CODEX_ASYNC_ALVO`.
- A colheita do `--falsificar` só mata órfãos (`ppid=1`) nascidos na janela da rodada: órfão de
  watchdog é inerte (o pai que rodaria o `&& kill` morreu). Se o `ps` faltar, nada é morto. Num Linux
  com subreaper o órfão pode não ter `ppid=1` — aí a colheita não colhe (VM efêmera; as medições são
  por diferença de base e não dependem dela).
