# Processo VIVO não é processo SÃO — o worker do claude-mem que bloqueou 46 sessões

**Data:** 2026-09-05 · **Custo:** ~2h com TODO prompt de TODA sessão bloqueado (~45 s de espera + `exit 2`) + 1 core a 100% · **Descoberto:** pelo próprio bloqueio ("claude-mem worker unreachable for 31 consecutive hooks") e pela vigia (`orfaos-custosos.sh`) acusando o pid.

Irmã de `vigia-cego-ao-que-mata.md` (o vigia mede o eixo que a decisão serve): aqui quem
mediu o eixo errado foi a **auto-recuperação do plugin**, que só sabe distinguir pid MORTO de
pid VIVO — e um worker vivo-mas-surdo passa por "vivo" para sempre.

## O incidente

O daemon do plugin claude-mem (`worker-service.cjs --daemon`, pid 1465, v13.15.3, PPID=1,
no ar desde 28/08 19:00) parou de responder às **08:22:34** de 05/09 e ficou assim por 2 h:

- `ps`: estado `R`, **93–98 % de CPU**, `TIME` 123 min — praticamente TODO acumulado
  depois das 08:22 (em 7 dias antes disso o processo tinha gasto quase nada).
- Porta 37701 em `LISTEN`, mas `connect()` devolvia **`ECONNRESET` em 0,5 ms** (curl 55/56,
  `nc` e Python iguais): o kernel completava o handshake e resetava — fila de accept CHEIA,
  o processo nunca chamava `accept()`. Um socket cliente em estado `CLOSED` ficou preso no fd 13.
- `sample 1465`: thread principal com **53 % em `kevent64` + 24 % em código JIT (JS)**, as
  outras 6 threads ociosas — event loop **girando** (poll com timeout zero), não travado.
  O mecanismo exato dentro do bun 1.3.14 NÃO foi identificado (binário sem símbolos); a
  amostra ficou guardada no scratchpad da sessão, não aqui.
- Último registro do daemon: `[PROCESS] Pool limit reached (2/2), waiting for slot...`
  (segunda sessão entrando na fila do pool de agentes SDK). Depois disso, silêncio total —
  inclusive das rotas HTTP, que logam toda chamada.

## Por que o plugin NÃO se recupera sozinho (lido no fonte 13.15.3)

1. **Hook bloqueia por desenho.** Cada hook faz `GET /api/health`; falhou → incrementa
   `~/.claude-mem/state/hook-failures.json`; ao atingir `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD`
   (default **3**) imprime "worker unreachable for N consecutive hooks" e sai com **`exit 2`**
   — no `UserPromptSubmit` isso é "hook bloqueou seu prompt". Os hooks registrados são só
   `SessionStart`, `UserPromptSubmit` e `Stop` (nenhum PostToolUse). O contador é global:
   chegou a **74** somando as 46 sessões.
2. **A auto-recuperação decide pelo eixo ERRADO.** Sequência de cada hook (log de 05/09):
   `Worker PID file points to a live process, skipping duplicate spawn` → espera ~30 s →
   `Live PID detected but worker did not become ready before timeout` → `lazy-spawning` →
   o worker novo morre com `Port already in use, refusing to start duplicate` → ~15 s →
   `exit 2`. O critério é `kill -0` (VIVO); o eixo da decisão é RESPONDE (`/api/health`
   dentro do timeout). Um surdo passa por vivo em todos os hooks, para sempre.
3. **`stop`/`restart` do CLI também não servem:** ambos mandam `POST /api/admin/shutdown`
   — o surdo não atende — e `start` só remove o `worker.pid` se o pid estiver MORTO.

Portanto a única saída é matar o pid à mão. Nada no plugin faz isso.

## Receita de recuperação (executada e VERIFICADA em 05/09 10:36)

```bash
# 1. olhar ANTES de matar (a vigia exige; nunca kill às cegas)
ps -p "$(python3 -c 'import json;print(json.load(open("/Users/'"$USER"'/.claude-mem/worker.pid"))["pid"])')" -o pid,ppid,pgid,etime,time,pcpu,stat,command
curl -s -m 4 http://127.0.0.1:37701/api/health || echo "surdo"
```

Só prossiga se: pid é `worker-service.cjs --daemon`, health NÃO responde e o contador em
`~/.claude-mem/state/hook-failures.json` está ≥ 3. Então:

```bash
# 2. matar o GRUPO do worker (leva o chroma-mcp junto, mesmo pgid) + os `claude` headless
#    do SDK (filhos do worker, `--output-format stream-json`, detached — pgid próprio)
kill -TERM -- -<pid>; kill -TERM <pids dos claude filhos>     # 5 s; se sobrar, -KILL
# 3. subir pelo CLI do plugin (limpa o worker.pid morto e spawna)
P=~/.claude/plugins/cache/thedotmack/claude-mem/13.15.3/scripts
node "$P/bun-runner.js" "$P/worker-service.cjs" start
# 4. prova POSITIVA: health 200 + round-trip de hook real (só leitura) + contador zerado
curl -s -m 5 http://127.0.0.1:37701/api/health
printf '{"session_id":"diag","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}' "$PWD" \
  | node "$P/bun-runner.js" "$P/worker-service.cjs" hook claude-code context >/dev/null; echo "rc=$?"
cat ~/.claude-mem/state/hook-failures.json     # {"consecutiveFailures":0,...}
```

Em 05/09 os 5 processos saíram com SIGTERM em < 5 s; o worker novo (pid 56770) respondeu
`status: ready` em 2 s; o hook `context` devolveu 6 KB de contexto com `rc=0` e o contador
foi de 74 → 0. A vigia (`orfaos-custosos.sh --resumo`) passou a sair vazia.

## O achado SECUNDÁRIO — a memória estava morta havia semanas, sem sensor

O pool 2/2 estava ocupado por dois `claude` headless que tinham respondido
`Not logged in · Please run /login`. Olhando os 4 daemons anteriores (logs de 13/08, 22/08,
25/08, 28/08): **`STORING` = 0 em TODOS** — nenhuma observação armazenada desde pelo menos
13/08 — enquanto o SDK "respondia" milhares de vezes: no daemon de 28/08, 1.659×
`Failed to authenticate: OAuth session expired and could not be refreshed` (desde 19:09 do
dia do boot) e depois 244× `Not logged in`. O `/login` de 07/07 (`docs/agent/skills.md`)
expirou e ninguém viu, porque a saída do sensor era "worker saudável" — o health mede o
worker, não a memória. Agravante: o detector de falha de auth do parser não casa o texto
novo "Not logged in · Please run /login", então o lote vai para o ramo "prosa" e é
**descartado** em vez de preservado.

Conserto é do founder (credencial): terminal → `~/.claude-mem/claude-shim.sh` → `/login`,
depois `node "$P/bun-runner.js" "$P/worker-service.cjs" restart` (o worker lê o token do
keychain **no spawn**; sem restart continua com o expirado). Prova: no log do dia, uma
linha `Response received` sem "authenticate"/"Not logged in" e a volta de `STORING |`.

## A lição (classe)

- **Vivo ≠ são.** `kill -0`/pid-file responde "existe"; a decisão de recuperar precisa de
  "responde" — sonda com resposta POSITIVA dentro do timeout (a mesma regra do CLAUDE.md
  para sonda de script destrutivo: `command -v` não basta). Sensor que aceita o proxy
  vira bloqueio permanente exatamente no caso que deveria resolver.
- **Fail-loud global com N=3 sem auto-cura é um botão de desligar todas as sessões.** Se o
  plugin não sabe matar um surdo, o threshold só converte "memória fora" em "trabalho
  parado". Enquanto o upstream não corrigir, a receita acima é o caminho; subir
  `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD` em `~/.claude-mem/settings.json` é paliativo que
  troca bloqueio por silêncio — decisão do founder, não default.
- **A vigia acertou, e a nota irmã previa o contrário.** `vigia-cego-ao-que-mata.md` trata
  o worker do claude-mem como o falso positivo a evitar (9:32 de CPU em 7 dias); com os
  dois eixos (`pcpu ≥ 50 %` E `cputime ≥ 300 s`) ele só aparece quando está de fato
  girando — que foi o caso. O discriminador que faltava na mensagem da vigia está
  instalado (2026-09-05, mesmo dia): quando o órfão acusado tem `worker-service.cjs` no
  comando, a linha do `orfaos-custosos.sh --resumo` (e o relatório do `wt:status`) traz
  `[claude-mem: health ok|SURDO (porta N …); contador=N …]` e, quando é surdo **e** o
  contador ≥ 3, aponta esta receita.

## O discriminador na vigia (instalado 2026-09-05)

O que a linha passa a dizer, e as regras que a fazem honesta (`scripts/orfaos-custosos.sh`,
provado por `scripts/test-orfaos-custosos.sh` — 66 asserções + 18 sabotagens nos 2 locales):

- **Os dois eixos NÃO mudaram e não há allowlist por nome.** O worker são fica em 0–4 % e
  continua invisível; o discriminador só ANOTA o órfão que os eixos já acusaram.
- **Contador:** lido de `$CLAUDE_MEM_DATA_DIR/state/hook-failures.json` (default
  `~/.claude-mem`, o MESMO nome de variável que o plugin honra). Arquivo ausente =
  `sem contador`, **nunca** `contador=0`; chave ausente/não-inteira = `contador ilegivel`.
  Parse com `sed`, não `jq`/`python3`: o PATH do hook é herdado do app e pode não ter
  `/opt/homebrew/bin` — o `jq` viraria "não li" justo no SessionStart.
- **Health:** `curl -s -m 2 --noproxy '*'` em `http://127.0.0.1:<porta de worker.pid>/api/health`.
  Resposta POSITIVA é HTTP 200 → `health ok`. Curl que FUNCIONOU e o worker não respondeu
  (rc 7 recusada · 28 timeout · 52 vazia · 55/56 reset — o incidente deu 55/56) → `health
  SURDO`. Qualquer outro rc, curl ausente, `worker.pid` ausente ou sem porta → `nao sondei`
  — **nunca** `ok`, e **nunca** `SURDO` (que também é afirmação).
- **Receita:** só quando `SURDO` **e** contador ≥ 3 lido — as duas condições que o passo 1
  da receita exige. Sem contador, sem receita.
- **Orçamento:** o vigia impõe `timeout 3` ao script inteiro; o `curl -m 2` só roda quando
  HÁ órfão do claude-mem e UMA vez (a porta é uma, mesmo com dois workers de versões
  diferentes). Medido: 0,07 s sem órfão · 0,22 s com curl real contra porta fechada.
- **O casamento é no comando COMPLETO, dentro do awk, antes do corte de 110 chars:** a
  linha real tem 146 e `worker-service.cjs` fica depois do corte — casar no texto truncado
  seria cego por desenho (sabotagem "casa DEPOIS do corte" fica vermelha).
- **A suíte nunca toca o `~/.claude-mem` real:** `CLAUDE_MEM_DATA_DIR` aponta para
  diretório temporário e o `curl` é stub no PATH (modos ok/surdo/quebrado, cada chamada
  registrada — é o que prova "só roda com órfão" e "`-m` ≤ 2"). Um único caso usa o curl
  REAL contra uma porta que o SO acabou de dar como livre: o stub ignora flags, e só o
  binário prova que `-m/--noproxy/-w/-o` existem (flag inválida = "nao sondei" para sempre,
  verde por cegueira).

## Recorrência em 2026-09-24 — o que o upstream corrigiu, o que não, e o que ficou instalado

**O que aconteceu:** o plugin voltou a bloquear TODO prompt no Mac do founder ("claude-mem
worker unreachable for N consecutive hooks") — a mesma classe de 05/09. O worker atual subiu
às 13:10 de 24/09 (`startedAt` do `worker.pid`) e o contador voltou a 0 no mesmo minuto
(`mtime` de `state/hook-failures.json`). A instalação local segue na **13.15.3** — a mais
bloqueante: no fonte dela (relido em 25/09), cada falha a partir do limiar chama o caminho que
sai com `exit 2`, então o bloqueio vale para TODO prompt enquanto o worker estiver fora.

**O upstream, lido no fonte pela sessão de 24/09 (não reverificado aqui):**

- `≤ 13.24.8`: bloqueia todo prompt enquanto o worker está fora (o comportamento acima).
- `≥ 13.24.18`: bloqueia **uma** vez e depois falha **em silêncio** — nada mais avisa. Troca
  "trabalho parado" por "memória parada sem ninguém saber". (Se o contador continua subindo
  nessas versões NÃO foi lido; por isso o sensor não depende só dele — ver abaixo.)
- **Nenhuma versão, nem a 13.25.3, recupera sozinha um worker vivo-mas-surdo no macOS:** o
  daemon novo se recusa a subir com a porta ocupada, e o *reclaim* de porta fantasma é
  Windows-only. A saída continua sendo matar o pid — agora com script.

**O que ficou instalado (PR de 2026-09-25):**

- `scripts/claude-mem-reanimar.sh` (`bun run claude-mem:reanimar`) — a receita acima
  generalizada para qualquer versão: diagnóstico com evidência positiva; só mata processo do
  PRÓPRIO claude-mem (`worker-service.cjs`, ou `chroma-mcp` com o data-dir dele), só após 3
  sondas falhando de forma interpretável, e com confirmação; `--so-olhar` não toca em nada;
  worker com menos de 60 s nunca é tocado; porta de outro programa, sonda ininterpretável ou
  endereço incoerente = para sem matar; `RECUPERADO` só com health 200 + hook `context` rc=0 +
  contador 0.
- `scripts/lab-claude-mem-reanimar/` — plugin FALSO num HOME descartável: 17 cenários / 109
  asserções, **no Linux (CI) e no macOS** (onde o script roda de verdade), no `test:hooks`;
  falsificação de 12 guardas, cada uma exigida pela FALHA específica, controle verde antes.
  Para caber no CI, os tempos (60/5/2/30/3 s) aceitam override `REANIMAR_TESTE_*` só de teste
  — e override que não é inteiro PARA o script: "abc" na idade mínima faria o ramo SUBINDO
  falhar como falso e derrubar um worker que ainda sobe.
- **Sensor** — bloco 6 do `.claude/hooks/vigia-worktree.sh`, lógica em
  `scripts/claude-mem-saude.sh`: avisa no SessionStart quando o contador de falhas de hook > 0
  ou quando há prompts gravados sem observação; sonda ausente = `NAO MEDI`, nunca ok.

## O achado de 25/09 — o eixo que importa não é o contador

Medido no `claude-mem.db` ao calibrar o sensor: **a última observação é de 2026-07-27 16:42
UTC**, e o banco segue gravando prompts (3.260 depois dela), com contador em 0 e `/api/health`
em 200. A nota de 05/09 dizia "desde pelo menos 13/08" porque media pelos logs disponíveis; o
banco mostra que a memória parou em 27/07. E houve dois apagões **antes**, que ninguém viu:
11–14/07 (232 prompts sem observação) e 21–27/07 (285). Nos 5.250 intervalos entre
observações consecutivas de 07/07–26/07, o maior trecho NORMAL teve 11 prompts.

Um sensor só de contador diria "ok" durante os dois meses. Por isso o sensor tem dois eixos, e
o de gravação é medido contra os PROMPTS, não contra o relógio: "última observação há mais de
N horas" daria alarme falso a cada fim de semana, enquanto "≥ 30 prompts em ≥ 60 min sem
nenhuma observação, o último há ≤ 72 h" separa com folga os dois mundos (≤ 11 no normal;
≥ 232 nos apagões).

**Pendências (do founder):** a causa da memória morta é de credencial (o `/login` do CLI via
`~/.claude-mem/claude-shim.sh`, seção acima) — no log de 27/07 o gerador respondia prosa em vez
do XML esperado ("SDK returned non-XML prose response — ignoring queued batch") e o keychain
falhava; e atualizar o plugin para ≥ 13.25.3 reduz o bloqueio a 1 prompt por queda, ao preço
de a falha ficar silenciosa — que é o que o bloco 6 do vigia passa a denunciar.

## 26/09 — o flake do laboratório: o rc era do HELPER, não do script

**Sintoma:** no `test:hooks` cheio, na M2 em swap (carga 51 em 8 núcleos), o caso
`REANIMAR_TESTE_SONDA_S=0` do `c_tempo_invalido` disse o `PAREI` certo e voltou **rc=1** em vez
de 2 — 1 falha em 4 execuções; isolado, passou 2/2. O script só tem um caminho depois do `PAREI`:
`exit 2`. O 1 vinha de outro lugar.

**Causa (medida):** o rc que o lab lê é o do `com_tty.py`, o helper que dá TTY ao script. O `printf`
do `roda()` entrega a resposta antes de o Python existir, e o helper a repassa ao TTY no 1º
`select` — normalmente antes de o filho sequer virar bash. Sob carga, o helper pode ficar sem CPU
durante a vida INTEIRA do comando (o caminho `PAREI` dura milissegundos) e acordar com a saída **e**
a resposta prontas no mesmo `select`. No macOS, o filho (líder de sessão) só termina de sair quando
o pai drena a saída dele (`ps`: estado `E` → `Z` só depois do read); o read o libera, e o write da
resposta logo em seguida toma **EIO** — 26 em 30 direto, 30 em 30 com 0,3 s de folga. A exceção não
tratada matava o Python com **1**, o mesmo número do "não consegui" do script. Por isso só os casos
`PAREI`: os outros levam segundos ou param para ler a confirmação, com o TTY ainda aberto.

**Reproduzir por sorte não deu:** 0 em 450 no pipeline exato do `roda()` (3 cópias, `nice 19`,
carga 51). A janela é estreita demais — o `entrada_tardia.py` IMPÕE a ordem (1º `select` só depois
de o comando escrever tudo; a resposta só depois de ele estar em `Z`), e a prova ficou vermelha
10/10 com o EIO **real** do kernel.

**Conserto:** (a) EIO ao entregar a resposta = o comando já saiu: o helper descarta, **diz**
(`COM_TTY: entrada descartada`), segue drenando e devolve o exit DO COMANDO; (b) erro do próprio
helper sai **125** com `COM_TTY: erro interno` — fora da faixa 0/1/2 do script, como o 124 do teto.
`prova_com_tty.sh` roda no `test:hooks`; o `--falsificar` (controle verde na mesma invocação, 3
sabotagens, C e pt_BR.UTF-8) no `test:falsificacao`. No Linux, pela leitura do `pty.c`, a escrita
tardia é ACEITA (o EIO de lá é só na leitura): a prova mede o que o kernel fez e, onde ele aceita,
emula o EIO do macOS **dizendo isso** — sem o que o CI nunca veria a guarda regredir. Classe: §7 de
[evidencia-positiva-shell.md](evidencia-positiva-shell.md).

## 28/09 — 3ª recorrência: o gatilho é a HIBERNAÇÃO, não a auth

**O que aconteceu:** worker 13.28.0 (pid 1551, bun **1.3.14** — o mesmo de 05/09) surdo: `curl` 28
(timeout; em 05/09 era 55/56), duas conexões do health presas no backlog em `CLOSE_WAIT` com 88 B
não lidos (o processo nunca chamou `accept()`), 100 % de CPU, `sample`: thread principal 52 % em
`kevent64` + o laço do bun, demais threads paradas — a assinatura de 05/09. O bloco 6 do vigia avisou
no SessionStart ("4 FALHAS DE HOOK"); `claude-mem:reanimar` deu `RECUPERADO`.

**Quando o giro começou — medido pela CPU acumulada, não pela última linha do log.** O processo tinha
136,9 min de CPU às 19:57. `pmset -g log`: 02:38:29 `Low Power Sleep … TCPKeepAlive=inactive …
Charge:1%` → 07:09:59 `Wake from Hibernate`. Acordado desde então: 07:09:59→08:08:55 + 18:44:36→19:57
= 131 min, mais 50 DarkWakes de segundos e o CPU normal das 6 h anteriores — **bate**. Se tivesse
começado às 01:01 seriam +97 min (o Mac ficou acordado até 02:38) ≈ 228 min; às 18:44, ≈ 72 min.
Mesmo gatilho e mesma assinatura (`kevent64` com timeout zero, só a thread principal, sem autocura) em
[anthropics/claude-code#67664](https://github.com/anthropics/claude-code/issues/67664), outro processo
bun, fechada como *not planned*; o mecanismo que ela propõe (fd de socket morto na hibernação deixa um
handle/timer que zera o timeout do poll) é DELA — aqui não foi medido. 05/09 (08:22 da manhã) é
compatível, mas não verificável: o `pmset` só guarda desde 21/09.

**A hipótese que caiu.** A última linha do worker (01:01:18) era `Generator paused for auth; preserving
buffered work {pendingCount=1}`, e a pausa anterior (0 pendentes) não tinha silenciado nada — parecia o
gatilho. Refutada por observação: depois do restart houve duas pausas por auth com `pendingCount=1`
(20:06:41 e 20:06:56) e o worker seguiu respondendo. **Última linha antes do silêncio é vizinhança,
não causa** — o silêncio pode começar horas depois (aqui, o Mac dormiu). Meça o INÍCIO do giro (CPU
acumulada × tempo acordado) antes de culpar a linha.

**O achado secundário (de novo): memória parada desde 00:39 — token que o Desktop nunca renova.** O
plugin relê `Claude Code-credentials` (conta = usuário) no keychain a cada spawn do SDK e recusa token
vencido (`Refusing to inject expired CLAUDE_CODE_OAUTH_TOKEN`, grava `~/.claude-mem/oauth-stale.marker`).
As sessões do app Desktop se autenticam pelo host (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`,
`ANTHROPIC_BASE_URL` no ambiente) e **nunca tocam nesse item** — a sessão ativa às 01:00 não o renovou,
nem as 36 de hoje. Quem renova é o `claude` de **terminal**. Token de 8 h: renovado 27/09 16:39, venceu
28/09 00:39. Armadilha que eu caí: o `mdat` do item mudou às 18:42 e o token continuou o de 00:39 — o
JSON guarda mais que o token do Claude.ai. **Item modificado ≠ token renovado** (medi o contêiner, não o
conteúdo). A prova é o `expiresAt` que o próprio worker loga ao recusar — sem ler segredo. Conserto é
do founder: `claude` no terminal (renova pelo refresh token; se não der, `/login`).

**Confirmar o kill sem TTY (agente):** o script lê `/dev/tty`; sem TTY ele cancela sem tocar em nada
(fail-closed, correto). O `script(1)` do macOS perde a resposta (o `read` lê vazio — já previsto no
`com_tty.py`). O que funciona, depois de ver a evidência: `printf 's\n' | python3
scripts/lab-claude-mem-reanimar/com_tty.py 240 bash scripts/claude-mem-reanimar.sh`.

**Upstream:** [thedotmack/claude-mem#4129](https://github.com/thedotmack/claude-mem/pull/4129)
(reclaim do worker travado + hooks de prompt em fail-open) está em draft com 3 achados P1 em 28/09 —
quando entrar, a receita vira automática. Até lá: **Mac que morreu de bateria acorda com o worker
surdo** — o bloco 6 do vigia acusa e `bun run claude-mem:reanimar` resolve.

**Decisão (28/09, founder): plugin DESLIGADO até o #4129 entrar** (`enabledPlugins` false no
`~/.claude/settings.json`). O que se perde, medido no mesmo dia: 0 observações em 13 dos 14 dias
anteriores (só 27/09, na janela do token renovado); contexto injetado pelo hook `context` do
SessionStart = 0 bytes (repo principal e worktree com histórico — a memória é fragmentada por
worktree, 87 `project` distintos); 5 de 933 transcripts de 30 dias usaram a busca MCP do plugin
(todos 19–21/09) e nenhum usou skill `claude-mem:*`. O acervo (5.274 observações, 1.556 resumos,
56 MB em `~/.claude-mem/claude-mem.db`) fica no disco. Sessões abertas antes da mudança mantêm os
hooks até reiniciar e tentam subir o worker se ele cair (lazy-spawn, visto no log) — pare o worker
(`worker-service.cjs stop`) só depois que elas reiniciarem.

## 29/09 — o sensor sabe do desligamento (`enabledPlugins`)

**O ruído:** desligar o plugin não desliga as sessões que já estavam abertas — elas mantêm os hooks
e seguem gravando prompts no banco. O eixo "gravação" (≥ 30 prompts sem observação, espalhados por
≥ 60 min, o último há ≤ 72 h) passou a acusar em todo SessionStart novo — medido no desta sessão:
`a memoria NAO GRAVA ha 1d: 40 prompts desde a ultima observacao (2026-09-28)`, sugerindo o `/login`
que a decisão de 28/09 tornou inútil. Duraria até ~3 dias (72 h depois do último prompt das sessões
velhas); o eixo "contador" acusaria igual se os hooks delas falhassem.

**Conserto — seção 0 do `scripts/claude-mem-saude.sh`:** `"claude-mem@<marketplace>": false` no
objeto `enabledPlugins` = não mede (`--resumo` mudo, relatório `DESLIGADO (enabledPlugins)`, exit 0).

- **Precedência por chave, como o Claude Code:** `.claude/settings.local.json` >
  `.claude/settings.json` (os do projeto, relativos ao diretório corrente — o hook e o `bun run`
  rodam na raiz) > `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Olhar só o do usuário calaria o
  sensor com o plugin RELIGADO num projeto — sensor mudo com memória viva, a direção perigosa. O
  merge por chave foi conferido na própria sessão: `github`, `posthog`, `serena` e `zapier` do
  marketplace oficial (true no usuário, false no projeto) ficam fora, e `superpowers`/`context7` (só
  no usuário) seguem ativos.
- **Só o literal `false` desliga.** `true`, chave ausente, arquivo ausente ou ilegível não declaram
  nada → mede (ausente ≠ desligado). Ilegível = o Claude Code, com o mesmo uid, também não o lê.
- **Só o objeto `enabledPlugins` e só a chave `claude-mem@` exata** — outro plugin em false,
  `claude-mem-extra@…` ou uma chave futura que também mapeie plugin → bool não desligam.
- **Texto, não parser** (`sed`/`tr`, nunca `jq` — o PATH do hook). Fora do alcance: managed-settings
  (não existe nesta máquina) e o `--settings` da linha de comando (só o processo do Claude o vê).
- **Custo medido:** a 1ª versão (`cat` + `tr` + `sed` por arquivo, ~18 processos) deixou o caminho
  que SAI CEDO em 2,2× o tempo do `main` medindo de verdade (0,187 s × 0,084 s) — num hook que existe
  por pressão de RAM, com teto de 2 s. Com leitura builtin (`$(<arq)`) e o pipeline só no arquivo que
  cita `"claude-mem@`, ficou abaixo do `main` nas duas rodadas seguintes.

**Prova:** a suíte ficou hermética nos settings (diretório corrente, `CLAUDE_CONFIG_DIR` e `HOME`
temporários — o `~/.claude` real desliga o plugin e, lido, calaria a suíte inteira) e ganhou 15
casos (Y1–Y14 e o Z, no hook), todos com fixture que ACUSA nos dois eixos: o silêncio só pode vir da
guarda. RED antes do código: caíram exatamente os 7 casos de "mudo". No `--falsificar`, 19
sabotagens novas, cada uma derrubando o caso certo, com controle verde na mesma invocação, em C e
pt_BR.UTF-8. Uma delas mostrou camada invisível: o filtro por `case` (só roda o pipeline no arquivo
que cita `"claude-mem@`) escondia do caso "outro plugin em false" a restrição de chave do regex —
quem a prova é o caso do formato real (`superpowers: true` ao lado do `false`), não o que parecia
feito para ela. No ambiente real: `--resumo` mudo com rc 0, e o hook de SessionStart num sandbox com
settings e banco reais sem nenhuma menção ao claude-mem.

**Ao religar (`true` + reiniciar as sessões):** o sensor volta a medir sozinho. Aviso que apareça
nas primeiras horas é MEDIDO — prompts das sessões antigas sem observação, ainda dentro das 72 h — e
some na 1ª observação nova.

**Desfecho (30/09 18:56): worker PARADO** — 0 sessões anteriores a 28/09 22:06 (as 10 vivas eram de
30/09 18:51); `curl` rc 7, 37701 sem LISTEN, `chroma-mcp` foi junto. **Com o plugin desligado,
`node bun-runner.js worker-service.cjs stop` sai 0 SEM RODAR** (o launcher faz `exit(0)` se
`enabledPlugins` diz false, antes de ler os argumentos; o `worker-service.cjs` só barra `start`/`hook`/
`restart`/`--daemon`): o stop é `~/.bun/bin/bun …/13.28.0/scripts/worker-service.cjs stop` direto — que
também sai 0 com a porta presa (só loga `warn`), então o juiz é o `curl` rc 7.

## 05/10 — a causa raiz do apagão de 27/07, medida só lendo

**O pedido (briefing de 25/09):** por que nada grava desde 27/07, com a hipótese de o problema estar
ANTES do gerador, já que `pending_messages` também parava em 27/07. Só leitura: logs, banco em
`-readonly`, fonte do plugin (cache 13.15.3/13.28.0, clone do marketplace e tags do upstream).

**1. Causa raiz — o observador não tem credencial válida.** O `claude` headless que o worker spawna
autentica com o token OAuth do item `Claude Code-credentials` do keychain. O plugin assume que o app
o mantém fresco (o cabeçalho do `oauth-token.ts` diz "keychain entries are always current because
Claude Desktop refreshes them in place"). Aqui isso é falso: o Code tab autentica pelo host (seção de
28/09) e só o `claude` de **terminal** renova o item. O token dura 8 h. O upstream chegou ao mesmo
depois ([#4150](https://github.com/thedotmack/claude-mem/issues/4150), fechada em 04/10; o fonte da
v13.31.0 diz "re-logging into Claude Desktop never repairs it").

| quando (hora local) | evidência no log/banco |
|---|---|
| 27/07 13:17 | boot do worker com o token do item vencido desde 26/07 00:48 (`Refusing to inject … expiresAt=1785037733164`) |
| 27/07 13:18–13:38 | token renovado (14× `Injected fresh`, vence às **21:18:06**); 57 `STORING`, o último às 13:42 = a última observação do banco |
| 27/07 21:17:21 | o item **sumiu** do keychain (`SecKeychainSearchCopyNext: The specified item could not be found`), 45 s antes de vencer — quem apagou não ficou registrado; até 08/08, 12.132× `Not logged in · Please run /login`, e o parser da 13.10.2 descartou 6.066 lotes desses como "prosa" |
| 25/09 (dia do briefing) | 180 resumos enfileirados, 1.064× `Failed to authenticate: OAuth session expired and could not be refreshed`, 0 `STORING` |
| 27/09 16:39:32 | `/login` no terminal → `Injected fresh`, vence 28/09 00:39:04; nas 8 h, 162 resumos e 23 observações |
| 28/09 01:00 | `Refusing to inject expired` com o MESMO `expiresAt`: 8 h de sessões no app e nenhuma renovação |

Prova cruzada de quem renova: o `~/.local/bin/claude` (instalador nativo, que só se atualiza quando
roda) ficou na 2.1.202 de **07/07** (o `/login` original) até **27/09 16:41** (2 min depois do
`/login` novo). O CLI de terminal não rodou no intervalo inteiro.

**2. A hipótese da fila caiu — `pending_messages` deixou de ser fila.** As 79 linhas são sobras (75+3
de 07/07, 1 de 27/07). A última (id 78850, 27/07 13:17:58) é o 1º `ENQUEUED` do boot em que 13.2.0 e
13.10.2 subiram juntas; 25 min depois o mesmo log numera `messageId=398`, contador do processo. O
fonte upstream: `SessionMessageBuffer`, "Per-session in-RAM observation buffer. This replaces the
durable `pending_messages` SQLite queue". O worker de 27/07 enfileirou 12.926 mensagens até 08/08, e
27–28/09 gravou 23 observações sem deixar linha na tabela. O `max()` de tabela que ninguém mais
escreve é fóssil, não sintoma.

**3. Fator independente desde 20/08 — o desarme tirou a fonte das observações.** O incidente de fork
de 19/08 ([setup-agente.md](setup-agente.md)) tirou do `hooks.json` o `PostToolUse` (`hook claude-code
observation`, a captura por ferramenta) e o `PreToolUse(Read)`; o `~/.claude/hooks/claude-mem-vigia-hooks.sh`
reaplica o desarme a cada update (27/09 15:27, 1 min depois da 13.28.0; há `hooks.json.bak-original`
nas duas versões). Por worker: a 13.10.2 enfileirava `observation` (11.455 no de 27/07); **todo
worker 13.15.3 (21/08–26/09) enfileirou 0 `observation`**, só `summarize`. Com login válido a
observação ainda nasce, mas incidental — o modelo às vezes responde ao pedido de resumo com
`<observation>`: as 23 de 27–28/09 vieram de 12 sessões só-`summarize`, e as duas com `PostToolUse`
vivo (1364/1372, abertas na janela de 1 min antes do re-desarme) não gravaram nenhuma.

**Consequência para o sensor:** o eixo "gravação" do `claude-mem-saude.sh` conta só `observations`,
calibrado com julho (PostToolUse vivo, ≤ 11 prompts entre observações). Com o desarme, a janela
SAUDÁVEL de 27/09 teve 33 prompts em 149 min sem observação (19:41Z–22:10Z), com 15 resumos gravados
no mesmo trecho — um `[ACHADO] NAO GRAVA` falso. Religar mantendo o desarme exige o sensor contar
`session_summaries` também.

**Armadilha de leitura — por que 25/09 viu "nenhuma linha de processamento":** o worker escreve no
arquivo do dia em que SUBIU; os processos de hook, no do dia corrente. `claude-mem-2026-09-24.log`
tem 7.406 linhas datadas de 25/09 (e 1.839 de 26/09) — os erros estavam lá, e o "log de hoje" só
tinha os hooks. Filtre por `grep '^\[AAAA-MM-DD'` em todos os arquivos, nunca pelo nome.

**Bloqueio novo, medido hoje:** o app mudou o layout em 02/10 para
`claude-code/<versão>/<hash>/claude.app/Contents/MacOS/claude`, e o glob do shim
(`claude-code/*/claude.app/…`) não casa mais: ele sai 127 ("binário do app não encontrado"). Religar
hoje voltaria à falha de 07/07 ("Claude executable not found"). Alternativa estável ao shim:
`~/.local/bin/claude` (link do instalador nativo, 2.1.283). Os `pgrep -f 'claude.app/Contents/MacOS/claude'`
do repo casam por substring e seguem valendo.

**Upstream hoje:** #4129 e #4154 mergeados em 30/09, contidos a partir da **v13.29.0** (a 13.28.0
instalada não tem nenhum dos dois); a mais nova é a v13.31.0. Nela os hooks de prompt falham aberto
("your prompts are not blocked") e o `consecutiveFailures` segue incrementado e persistido — o eixo
"contador" do bloco 6 continua valendo. O #4154 leva a falha de auth do SDK ao `observer-health.json`
(aqui ele marcava `consecutiveFailures=0` com tudo falhando). Nada disso resolve o token de 8 h: o
`~/.claude-mem/.env` aceita `ANTHROPIC_API_KEY`, gateway, Gemini e OpenRouter, e um
`CLAUDE_CODE_OAUTH_TOKEN` só vale como reserva se estiver no ambiente do PRÓPRIO worker (herdado de
quem o sobe).

**Conserto — decisão do founder, o plugin segue desligado:** (a) shim no layout novo, ou
`CLAUDE_CODE_PATH` apontando para `~/.local/bin/claude`; (b) plugin ≥ 13.29.0; (c) credencial:
`/login` no Terminal dá 8 h, e a durável é `ANTHROPIC_API_KEY` no `~/.claude-mem/.env` (cobrada por
token; modelo padrão `claude-haiku-4-5`; custo não medido); (d) religar e reiniciar as sessões; (e)
mantido o desarme, o sensor passa a contar resumos. **Prova:** `bash scripts/claude-mem-saude.sh`
com `gravacao: [LIMPO] gravando: … (<data de hoje>)`, e `max(created_at)` de `observations` e de
`session_summaries` com a data de hoje. `[LIMPO]` com a data 2026-09-28 só quer dizer "ainda não
juntou 30 prompts".

**A lição (classe):**

- **Desligar um componente exige dizer o que ele PRODUZ, não só o que ele CUSTA.** O desarme mediu
  processos por disparo e chamou o que sobrou de "os 4 baratos"; nenhum registro disse que o
  `PostToolUse` era a captura de observações — nem a nota de 05/09 acima, que anotou "nenhum
  PostToolUse" sem ligar à memória morta. Um sensor calibrado ANTES do desligamento herda o mundo
  errado.
- **Antes de ler a parada de uma tabela como sintoma, prove que alguém ainda escreve nela** (o writer
  no fonte da versão que roda). Troca de arquitetura transforma fila em fóssil.
- **"Log de hoje" ≠ log do processo que importa:** arquivo nomeado pelo dia em que o processo subiu
  esconde o erro do daemon de quem abre o arquivo do dia.
- **Premissa do fornecedor também é hipótese.** O fonte afirmava que o app renova o item; o que
  fechou a causa foi medir QUEM renova (28/09) e quando o binário de terminal rodou pela última vez
  (`~/.local/share/claude/versions/`).
