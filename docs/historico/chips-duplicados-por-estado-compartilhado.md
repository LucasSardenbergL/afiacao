# Chip de estado COMPARTILHADO duplica por desenho — e falha mecânica não é pendência

**2026-09-08.** O founder mandou uma print de um chip e perguntou: *"Conseguimos automatizar para
não ficar abrindo chips assim?"*. Depois precisou: *"não que eu não quero clicar em chips, eu quero
abrir chips que de fato eu precise clicar visto que você não consegue automatizar durante a
sessão"*. Ou seja: o incômodo não é o clique — é **receber como ordem uma coisa que o agente
deveria ter resolvido sozinho**.

## A medição (828 chips, 13/07 → 08/09)

Extraídos de `~/.claude/projects/*afiacao*/*.jsonl` (`tool_use.name == "mcp__ccd_session__spawn_task"`),
441 sessões criadoras, 759 títulos distintos. Classificados um a um:

| classe | n | % |
|---|---|---|
| D produto/bugfix | 156 | 18,8 |
| G ação externa manual (deploy 86 · migration 40 · migration+edge 9 · Publish 3 · founder 6) | 145 | 17,5 |
| A verificar/provar (deploy no ar **89** · PostHog 20 · dado em prod 8 · resto 13) | 130 | 15,7 |
| B consertar sensor | 119 | 14,4 |
| I construir instrumento | 84 | 10,1 |
| C varrer classe | 61 | 7,4 |
| E doc/meta | 54 | 6,5 |
| F handoff | 46 | 5,6 |
| H investigar/decidir | 33 | 4,0 |

**A manchete:** `A-deploy` + `G` + `A-migration` = **236 chips (28,5%)** eram o laço das 3 camadas
manuais do Lovable. Setembro rodava a **37 chips/dia** contra 15,6 em agosto; a classe G foi
1 → 51 → 93 por mês. Taxa de clique geral: 65% (539/828).

## As duas causas — a mesma doença

**1. Nenhuma sessão enxerga o chip das outras.** Dentro da classe B, o "reincidente" não são 35
defeitos: são **DOIS** — `mutcheck` stale (20 chips, 19 sessões distintas, todos entre 06 e 08/09)
e timeout do `validate` no CI (15 chips, 11 deles em 07–08/09). ~30 worktrees paralelas viram o
MESMO estado compartilhado quebrado e cada uma abriu o seu chip. O mesmo padrão explica a classe G:
109 dos 145 carregam o marcador do `/fecho`, e 80 foram criados a partir de 06/09 com apenas 10
clicados — a mesma leva pendente re-chipada por cada sessão que fechava.

Isto já tinha nome no repo: *"achado COMPARTILHADO colide por DESENHO"* (`worktrees.md`, 23/07), e
a regra "deduplicar antes de abrir" já estava escrita no `CLAUDE.md`. Produziu 35 duplicatas em 3
dias mesmo assim — **contramedida textual reincide; gate estrutural para**, exatamente como no
`pr-duplicata-guard.sh` um andar acima.

**2. Ausência de dado virou ordem de trabalho.** O chip da print — *"Destravar ledger de deploy e
provar 2 edges sem prova"* — nasceu de `pendencias:deploy` em **exit 2**, que no contrato daquele
script quer dizer *"não consegui consultar"*, não *"há pendência"*. Re-executado no mesmo dia, sem
nenhuma correção: **exit 0, cobertura 59/59 edges atestadas, 22/22 disparos da sonda por cron**. A
ordem nasceu morta. O `#2374` tinha acabado de tirar o chip de deploy do `/fecho` deixando UMA
válvula — *"chip volta a ser o certo em UM caso: o braço indisponível"* — e a válvula não tinha
retry. `ausente ≠ zero` vale no TEMPO: uma consulta que não respondeu é **uma tentativa a
repetir**, não trabalho a delegar.

## O que ficou

- **`.claude/hooks/chip-duplicata-guard.sh`** (PreToolUse/spawn_task) — avisa, nunca nega, em três
  eixos: ARTEFATO (alvo compartilhado já chipado por outra worktree), MECÂNICA (o chip se
  justifica por consulta que não respondeu) e TEMPLATE (leva conhecida).
- **`scripts/fila-idade.ts`** + eixo FILA no `pendencias.sh` — idade do item mais antigo **sem
  avanço comprovado**, teto 48h.

### Três decisões que valem além deste caso

1. **A fonte da verdade do guard é um ledger próprio em `$HOME`, não as transcrições.** Varrer
   `~/.claude/projects` custou **12s medidos** em 260 arquivos de 3 dias — caro demais para um
   hook. E não pode ser arquivo versionado: seria sincronizar estado entre ~30 branches, que é
   como se fabrica conflito.
2. **Tirar o chip do caminho troca um modo de falha por outro.** Antes a tarefa EVAPORAVA com a
   sessão; agora ela pode APODRECER num destino durável, e apodrecer é silencioso. Por isso o
   sensor de idade nasceu junto — e ele mede desde a ABERTURA, nunca por `updatedAt`: um bot que
   comenta toda madrugada mantém `updatedAt` fresco para sempre. **Movimentação não é entrega.**
3. **Automatizar o clique nem era construível.** `ccd_session_mgmt` tem `list_sessions` e
   `send_message`, mas **não tem `create_session`**: o `spawn_task` é o único criador programático
   de sessão, e ele produz justamente o card que exige o clique. E seria contraproducente — a
   vazão é ~4 PR/dia contra 167 chips criados na semana 37; auto-abrir encheria uma fila cujo
   gargalo é saída, não entrada (`fila-de-entrega-sem-sensor-de-desfecho.md`).

## A falsificação achou os testes cegos, não o hook

Primeira rodada: **7 mutações, 5 mortas, 2 SOBREVIVERAM**.

- `GENERICOS` esvaziado sobreviveu porque o `package.json` falso da suíte não tinha nenhum script
  genérico com ≥5 letras — `test`/`wt` já morriam antes, no filtro de COMPRIMENTO. A camada que o
  teste achava que exercitava era **inalcançada**.
- A checagem de `tool_name` sobreviveu porque a entrada alheia do teste não tinha `title`: o
  `[ -n "$titulo" ] || exit 0` já a barrava. **Redundante para aquela entrada.**

Corrigidos os dois casos, a segunda rodada matou **7 de 7**. É a doutrina literal: *sabote uma
camada por vez; a que fica VERDE é redundante ou inalcançada* — e aqui ela apontou defeito no
TESTE, que é o resultado mais comum e o mais fácil de não enxergar.

## Parecer do Codex (gpt-6-astra, `max`, 147s)

Duas correções que mudaram o desenho:

- **"Execução" não é uma camada, são três autoridades** — começar trabalho ≠ exercer autoridade ≠
  declarar conclusão. Autorizar diagnóstico não autoriza correção; autorizar PR não autoriza
  produção; merge não encerra obrigação cuja condição é *estar funcionando em produção*.
- **"Persistência sozinha não elimina cliques."** Guardar melhor não resolve: sem consumidor, o
  founder segue sendo o roteador. Foi o que fez o desenho atacar a CRIAÇÃO (dedup + retry) em vez
  de só a durabilidade.

Ele também exigiu o sensor de 48h nestes termos: *"comentários automáticos e tentativas repetidas
não reiniciam esse relógio"* — que é o contrato testado em `scripts/fila-idade.test.ts`.
