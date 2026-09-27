# O gate do gstack não negou nada em 136 dias — e o censo assinava que negava

**2026-09-27.** Instância da classe [gate textual cego](gates-textuais-cegos.md) (Variante 5), com a
assinatura de [validação sem evidência positiva](evidencia-positiva-shell.md): um hook listado como
"que NEGA" desde o nascimento, que nunca negou uma chamada, e um fiscal que o contava pelo TEXTO.

## O que era

`.claude/hooks/check-gstack.sh` (df2bf1288, 2026-05-14), `PreToolUse` sobre `Skill`: se
`~/.claude/skills/gstack/bin` não existisse, imprimia

```json
{"permissionDecision":"deny","message":"gstack is required but not installed. ..."}
```

com exit 0. O CLAUDE.md dizia que ele "bloqueia o uso de skills"; o `docs/agent/deploy.md` o
listava entre os "6 hooks que NEGAM"; o `gates:frescura` conferia essa lista contra a máquina e
ficava verde. Nenhum teste o executava — era o único hook fora do `test:hooks`.

## Como apareceu

Uma sessão cloud (Claude Code 2.1.283, `CLAUDE_CODE_REMOTE=true`, sem gstack) rodou o hook à mão,
viu o deny impresso — e viu `Skill(doc2md)` carregar na mesma sessão. As 14 skills do repo
(`/fecho`, `/handoff-sessao`, `lovable-db-operator`…) funcionavam na nuvem SÓ porque o gate
estava quebrado.

## A prova no Mac (sonda, não leitura de doc)

Hook de sonda temporário em `.claude/settings.local.json` (restaurado byte a byte depois, sha256
conferido), `PreToolUse` sobre `Skill`, variante escolhida pelo `args`, e um log provando que o
hook RODOU nas três chamadas — sem o log, "não negou" seria indistinguível de "nem rodou".
Claude Code **2.1.281** (app desktop):

| JSON emitido | resultado |
| --- | --- |
| `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}` | **negou** (controle) |
| `{"permissionDecision":"deny","message":…}` — o do `check-gstack.sh` | **skill carregou** |
| `{"hookSpecificOutput":{"permissionDecision":"deny",…}}` — sem `hookEventName` | **skill carregou** |

Dois achados de brinde, ambos medidos:

- **Skill inexistente não chega ao PreToolUse** — `Unknown skill` sai da validação da ferramenta, e
  o log da sonda ficou vazio. Sondar com nome inventado não prova nada sobre o hook.
- **A terceira linha era a fixture do próprio fiscal.** O vitest e o `test-gates-frescura.sh`
  usavam `{hookSpecificOutput:{permissionDecision:"deny"}}` como "hook que bloqueia", e a
  sabotagem S5 criava o "hook deny novo" com a forma EXATA do `check-gstack.sh`. O teste do gate
  acreditava no mesmo formato quebrado que o gate deveria reprovar.

## A decisão (founder, 2026-09-27): opção D — sensor, não bloqueio

2ª opinião Codex (`gpt-6-astra · xhigh · 104 s · 62.735 tokens`) e a posição da sessão cloud
convergiram em D; a divergência era manter um deny estreito para as skills que dependem do
gstack. Medido: das skills do repo, só a `benchmark-externo` depende dele, e só para links — um
hook para uma skill, que negaria também os usos sem link. Ficou de fora.

O argumento que decidiu: **quando o gstack falta, as skills dele simplesmente não existem**; um
deny sobre `Skill` só alcança as que NÃO dependem dele. O mecanismo punia o alvo errado. E
`SessionStart` não bloqueia (exit 2 sem efeito) — "aviso fail-closed" não existe; o preço de D é
ser aviso, e é por isso que ele fala alto só onde a ausência é anomalia.

Opções recusadas: **A** (instalar na nuvem via setup script) — roda como root, e o `./setup --team`
grava `auto_upgrade true` e registra um SessionStart próprio, então o pin por tag é ilusório; setup
acima de ~5 min não entra no cache. Visto ao vivo nesta mesma sessão: às 13:02 o gstack do Mac
saltou sozinho de v1.69.0.0 para v1.91.2.0 (`auto_upgrade=true`; o gatilho não foi identificado), e
a lista de skills de uma sessão já aberta mudou junto — a instalação é GLOBAL, e muda por baixo de
todas as ~30 worktrees ao mesmo tempo. **B** (deny corrigido + exceção na nuvem) — no Mac, um upgrade
quebrado do gstack negaria TODA skill, `/fecho` e `lovable-db-operator` incluídos. **C** (aposentar
sem sensor) — perde o diagnóstico.

## O que mudou

- `check-gstack.sh` removido; o `PreToolUse` sobre `Skill` saiu do `settings.json`.
- `vigia-gstack.sh` (SessionStart `startup`): sonda POSITIVA — ≥1 executável em `gstack/bin` **e**
  SKILL.md das 4 canônicas (`review investigate browse qa`); diretório existir não conta. Instalado
  → silêncio. Mac sem gstack → `systemMessage` + contexto com a instalação. Nuvem sem gstack → só
  contexto, com os substitutos (`/code-review`, `WebFetch`) e a ordem de não instalar dali.
- `scripts/test-vigia-gstack.sh` no `test:hooks` e no `test:falsificacao`: HOMEs sintéticos,
  `CLAUDE_CODE_REMOTE` fixado em todo caso (numa sessão cloud ele vem herdado como `true`), e 5
  sabotagens de CÓPIAS do sensor, cada uma exigindo `FAIL` no caso que ela mira, nos dois locales,
  com controle verde antes de cada uma.
- `gates:frescura`: o hook só conta como bloqueio com o deny DENTRO de `hookSpecificOutput` com
  `hookEventName` "PreToolUse"; deny fora disso é vermelho próprio, `DENY-SEM-ENVELOPE`. Sabotagens
  S14 (deny no topo) e S15 (sem `hookEventName`) — uma por camada: sem a S15, tirar a exigência do
  `hookEventName` ficaria verde.
- `benchmark-externo` declara o próprio fallback sem gstack.

## A lição

**Gate que nega precisa de prova de NEGAÇÃO executada, não de texto que se pareça com negação.** A
regex do censo casava o token `permissionDecision…deny` em qualquer lugar do fonte — a mesma
cegueira da classe: o fiscal olha a forma, e a forma estava lá. O que prova um deny é a chamada
não acontecer, com um controle que prove que a sonda estava ligada.

## Assinatura para varredura futura

`bun run gates:frescura` agora reprova `DENY-SEM-ENVELOPE` em todo hook ligado no `settings.json`.
A varredura irmã — linha de envelope (`additionalContext` ou `permissionDecision`) sem
`hookEventName` na mesma linha, em `.claude/hooks/*.sh` — devolveu **0 de 24** linhas em
2026-09-27. Um sensor com envelope incompleto é o mesmo fail-open, só que calando um aviso.
