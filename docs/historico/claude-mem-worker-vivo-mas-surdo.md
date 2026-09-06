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
