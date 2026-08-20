# Setup do agente — diário de entregas

## 2026-08-19 — Vigia do claude-mem: a mitigação não pode usar a classe que causou o incidente (fora do repo)

**O incidente:** `fork failed: resource temporarily unavailable` em **qualquer** comando na M2 8GB —
a máquina sem tabela de processos. Causa dupla: um loop de recycle por mismatch de versão do plugin
`claude-mem@thedotmack` (cache 13.10.2 × marketplace 13.15.x) somado a **dois hooks que disparam por
AÇÃO**, cada um spawnando login shell + node + bun (~5-8 processos por disparo): `PostToolUse` com
matcher `*` (a cada tool call) e `PreToolUse` com matcher `Read` (a cada leitura de arquivo). Saldo:
**124 processos `chroma-mcp` órfãos com PPID=1**. Fix imediato: plugin em 13.15.3, órfãos mortos, os
dois hooks removidos do `hooks.json` do cache — ficam ativos os 4 baratos (`Setup`, `SessionStart`,
`UserPromptSubmit`, `Stop`).

**A pendência que sobrou:** qualquer `claude plugin update claude-mem@thedotmack` **reescreve o
`hooks.json` e traz os dois de volta em silêncio**. Existia um `~/.claude/reaplicar-desarme-claude-mem.sh`
idempotente e testado — mas rodá-lo dependia do founder **lembrar**. Memória não é controle: uma
pendência cuja única barreira é alguém se recordar já está aberta.

**A entrega:** `~/.claude/hooks/claude-mem-vigia-hooks.sh` — hook `SessionStart` com matcher
`startup` (**1 execução por sessão nova**, timeout 10s), registrado no `~/.claude/settings.json` ao
lado do `concurrent-session-guard` e do `auto-ensino-trigger`.

- **Vale para versão futura:** resolve a mais recente do cache por glob (`"$BASE"/[0-9]*/` +
  `sort -V | tail -1`) — sem `ls | grep` (SC2010; a mesma correção foi aplicada ao script de
  reaplicação, que tinha a linha original).
- **Detecção por CHAVE, não por substring:** `jq '.hooks | keys'`; fallback sem `jq` casa a linha de
  chave ancorada (`^\s*"PostToolUse"\s*:`), então uma menção dentro de um `command` não dispara.
- **Desarmado → silencioso** (0 bytes, nada no contexto). **Rearmado →** roda o reaplicar e injeta
  `additionalContext` com o que voltou, o que foi removido e a ordem de avisar o founder.
- **Kill-switch:** `~/.claude/.claude-mem-permitir-hooks-caros` desliga o vigia — se um dia os hooks
  caros forem desejados de volta, o automático não briga com a decisão.

**Custo:** caminho comum **10–40ms** e saída vazia (não atrasa o startup); o `node` só aparece no
caminho raro do rearme (1,4s).

**Evidência — os 5 testes rodados, não deduzidos:**

| teste | resultado |
|---|---|
| já desarmado | 0 bytes, exit 0, 10–40ms |
| rearme real (`hooks.json.bak-original` por cima) | detectou os 2, reaplicou, voltou aos 4, JSON de saída válido |
| kill-switch ligado **com o arquivo rearmado** | silencioso e **6 chaves intactas** — é o que prova que o teste acima não era falso verde |
| versão futura forjada (`13.20.0`) **sem `jq` no PATH** | resolveu a versão nova e o fallback `grep` detectou e corrigiu |
| `"PostToolUse"` só como texto dentro de um `command` | silencioso com e sem `jq` — sem falso positivo |

**As duas lições:**

1. **A mitigação não pode usar a classe que causou o incidente.** O reflexo para "detectar que um
   arquivo mudou" é um hook `PostToolUse`/`PreToolUse` — exatamente o padrão que esgotou o fork.
   Verificação de estado que muda por *evento externo raro* (um `plugin update`) pertence ao
   **início da sessão**, não a cada ação. A régua: *quantas vezes isso roda por sessão?* Se a
   resposta é "uma por tool call", o custo é o produto, não a parcela.
2. **Detecção tardia ≠ prevenção, e o vigia é honesto sobre isso.** Quando o hook roda, a config de
   hooks do plugin **já foi carregada** — o desarme só vale a partir do próximo restart. O ganho não
   é zero exposição, é **uma sessão em vez de todas as seguintes**; por isso a mensagem manda avisar
   o founder para reiniciar, em vez de declarar o problema resolvido.

**Escopo:** tudo em `~/.claude/` (config pessoal) — nada deste item vive no repo. Continuação natural
do **C6** da entrada de 2026-07-06 abaixo.

## 2026-07-18 — `pr-watch.sh`: exit 6 separa "não consegui consultar" de "sem desfecho"

**Falso negativo real (#1396, 2026-07-17):** o watcher saiu **5 (TIMEOUT)** num PR que tinha **MERGEADO** normalmente (auto-merge squash, `validate` verde em 5m16s). Causa: `exit 5` era emitido por DOIS caminhos — a consulta bem-sucedida sem desfecho *e* a consulta que falhou (ramo de erro do `gh pr view`) —, indistinguíveis pelo exit code. Um agente que confiasse no código reportaria "não mergeou" ao founder: exatamente o furo de rastreio que o script existe pra fechar ("PR órfão descoberto dias depois", C5 abaixo).

**Pista que o log dava:** só **2 AVISOs** antes do TIMEOUT — com janela 45min/poll 60s, rede fora daria ~45. Não foi outage: a máquina dormiu e o relógio saltou o deadline, então o script desistiu após 2 tentativas reais, com a rede provavelmente já de volta.

**Fix:**
- **`exit 6` = NÃO consegui consultar** (estado DESCONHECIDO) vs **`exit 5` = consultei e o PR segue sem desfecho**. JSON ilegível/vazio também cai no 6 — antes caía no ramo de SUCESSO e imprimia estado vazio (`ainda /?`), afirmando ter consultado.
- **Cartada final com backoff** (`5 15 45`s; env `PR_WATCH_BACKOFFS`, testes usam `0 0 0`) antes de declarar desconhecido — a falha é quase sempre transitória. Desfecho real encontrado aí **vence o timeout**: é o que teria salvado o #1396 (exit 0, não 5).
- Regra no **CLAUDE.md §Merge**: num 6, confirmar com `gh pr view <nº>` ANTES do PushNotification.
- **A janela passou a contar VIGÍLIA, não relógio de parede** (`dormir`): no suspend o `sleep` não avança mas o `date` sim, então o tempo dormido é devolvido ao deadline. Sem teto de extensão de propósito — cada wake compra ≥1 poll, e é esse poll que acha o desfecho (o watcher morre com a sessão de qualquer forma). Isso ataca o GATILHO; o exit 6 ataca o DEFEITO. Também no **CLAUDE.md §Merge**: o efeito colateral visível é watcher VIVO além dos N min nominais — sem a regra, um agente lê isso como travamento e mata o processo, reabrindo o furo de rastreio pelo outro lado.

**Prova:** `scripts/test-pr-watch.sh` (12 casos, `gh` stubado, sem rede) — testes escritos ANTES do fix e vistos vermelhos; o harness ganhou stub com contador (`GH_STUB_FALHAS=N` falha as N primeiras chamadas e depois volta, reproduzindo o #1396), asserção de SAÍDA (sem ela um exit 5 "não consultei" se disfarça de 5 "consultei") e RELÓGIO VIRTUAL (`date`/`sleep` stubados; `SLEEP_SALTO` simula suspend — determinístico e instantâneo, sem esperar 40min de verdade). No caso do relógio o exit code NÃO discrimina (5 nos dois mundos): o observável é a **contagem de polls** (2 sem o fix, 6 com).

**Falsificado** — cada sabotagem derruba só o que ela guarda:

| sabotagem | vermelho |
|---|---|
| desfaz o `exit 6` | só os 2 casos de "não consegui consultar" |
| remove a cartada final | só os 2 casos de "a rede volta" |
| não estende o deadline | só o caso do relógio (volta aos 2 polls) |
| credita o elapsed inteiro em vez do EXCESSO | deadline recua tanto quanto avança = loop infinito → `exit 143` pelo watchdog do teste (FAIL, não trava) |

**Ponta-a-ponta com `gh`/`date`/`sleep` REAIS:** `#1396 → 0 (MERGEADO)` (era 5) · PR aberto `→ 5` com o estado na mensagem · PR inexistente `→ 6` após 3 tentativas · watcher congelado por `SIGSTOP` 40s com poll de 10s → salto de **33s detectado**, janela estendida, rodou 101s de relógio para uma janela nominal de 60s. `SIGSTOP` é o análogo fiel do suspend **desde que o congelamento seja MAIOR que o poll**: a 1ª tentativa (congelar 25s com poll de 30s) não acusou nada — coube dentro do `sleep` do processo filho, que seguiu correndo, e não somou elapsed nenhum.

## 2026-07-06 — Anti-fricção do setup Claude Code (candidatos 1–9 do diagnóstico)

Origem: [melhorias-code-2026-07.md](melhorias-code-2026-07.md) — diagnóstico sobre 240 sessões/880MB de transcrições (65% dos erros de ferramenta = classificador de permissões; ~450 mensagens "Retome"; claude-mem com 0 observações em 331 sessões).

- **C1 — allowlist + heavy-guard:** `.claude/settings.json` com sintaxe canônica `:*` (as regras antigas `test*` não casavam) + read-only frequente (git/gh/ls/rg/wc/jq/psql-ro/wt/bun install) + formas `heavy`. `heavy-guard.sh` agora **REESCREVE** o comando pesado (`updatedInput`, permissionDecision=allow) em vez de negar — **provado ponta-a-ponta** (comando digitado sem `heavy` rodou com rastro `heavy: ► rodando (slot-1/1)`). Testes: `scripts/test-heavy-guard.sh` (24 casos, inclui composto e preservação de campos).
- **C2 — Codex assíncrono:** `scripts/codex-async.sh` — preflight de auth ANTES de gastar quota, retry/backoff só em transitório, cota esgotada → instrui o Caminho B, hard-stop 20min (codex trava com processo vivo), `mktemp XXXXXX`, sandbox read-only. Regra de transporte no CLAUDE.md §Codex + `money-path.md` (skill `/codex` carrega o ritual 1×/sessão — ~38k tokens por invocação; consultas seguintes vão pelo script em `run_in_background`).
- **C5 — watcher de PR:** `scripts/pr-watch.sh` (sai no desfecho: mergeado/conflito/CI vermelho/fechado/timeout, exit codes distintos) + regra no CLAUDE.md §Merge: armar em background ao criar PR e avisar via PushNotification — o founder deixa de ser o poller do auto-merge.
- **C3 — skill `/fecho`:** fechamento de sessão com EVIDÊNCIA (PRs×gh, migrations×psql-ro, edges/Publish, chips com título exato, resumo padrão, wt:status) — a pergunta mais frequente do corpus (~160 msgs/mês) vira checklist determinístico.
- **C7 — skill `/handoff-sessao`:** briefing de 7 blocos pra split de sessão (estado, não história); regra "2º compact → propor split" + "1 entrega = 1 sessão" no CLAUDE.md §Contexto.
- **C4 — handoff Lovable blindado (money-path):** `lovable-db-operator` ganhou **Passo 2.7 — pré-voo PROD via psql-ro** (referências existem? duplicata em UNIQUE novo? NOT NULL em tabela populada? functiondef/viewdef antes de OR REPLACE? já aplicado?) — ≥25 SQLs haviam quebrado na mão do founder em produção; validação pós-apply agora rodada pelo agente (morreu o "cola o resultado de volta"); entrega em bloco único numerado com destino rotulado. `lovable-deploy-verify` ganhou Lei de Ferro #5 (destino na 1ª linha de todo artefato, zero placeholders, JS/bash nunca no SQL Editor) + ordem travada merge→SQL→edge→Publish.
- **C6 — claude-mem consertado em 2 camadas (fora do repo):** camada 1 ✅ — causa-raiz nos logs, `Claude executable not found` (o app desktop não instala `claude` no PATH; caminho muda por versão): shim `~/.claude-mem/claude-shim.sh` (resolve a versão mais recente a cada chamada) + `CLAUDE_CODE_PATH` em `~/.claude-mem/settings.json` + worker reiniciado — o generator passou a spawnar e o SDK a responder. Camada 2 ✅ — a resposta era `Not logged in · Please run /login` (reproduzido fora do worker: o CLI headless não herda o login do app, que autentica por via própria); resolvida em 2026-07-07 com 1 login interativo do founder (`~/.claude-mem/claude-shim.sh` → `/login`). **Resultado medido: 0 → 214 observações na primeira hora pós-login** (SDK devolvendo `<observation>`/`<summary>`, backlog drenando; fragmentação por worktree confirmada nos dados — 133 no maior `project`). `skills.md` corrigida — dizia "claude-mem DESATIVADO de propósito", mas o estado real era ativo-e-quebrado (e o auto-memory nativo é que está desligado, via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). Limitação conhecida: cada worktree é um `project` distinto no claude-mem (memória fragmentada por sessão) — observar se a v13 agrega por repo antes de mexer mais.
- **C8 — dieta de contexto:** hook `pos-compact-ptbr.sh` (SessionStart matcher `compact`) reinjeta as regras que degradam pós-compact (pt-BR, roadmap, não reler arquivos inteiros, split no 2º compact); `/compact foco: <próximo passo>` vira a forma padrão (CLAUDE.md §Contexto).
- **C9 — worktree pronto + vigia de RAM:** `new-worktree.sh` roda `bun install` na criação; hook `vigia-worktree.sh` (SessionStart matcher `startup`) dispara `bun install` em background quando falta node_modules + alerta swap >6GB e >6 sessões Claude vivas; assinatura do falso-vermelho (`Cannot find module` / `@lovable.dev/*` ausente ≠ CI vermelho → `gh pr checks`) em `worktrees.md` — mordeu de novo nesta própria sessão (typecheck vermelho pós-ff, CI da main verde, `bun install` resolveu).

**Fica pra 2ª leva** (grupos não aprovados desta vez): 10 skill benchmark-externo · 11 skills BI pós-psql-ro + léxico de reposição + mapa de rotas · 12 verify-frontend paralelo/QA visual via Chrome logado (parcialmente suplantado pela evolução do `lovable-deploy-verify` v1.2) · micro-correções do diagnóstico (cd obrigatório, chips anunciados, segredos, receituário CSV-gov, aliases de voz, guard branch-pós-squash).
