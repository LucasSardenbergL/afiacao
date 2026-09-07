# O gate de frescura — o manual e a máquina conferem um ao outro, nos dois sentidos

> **A classe (2026-09-07):** um manual que cita seus próprios gates vale a **frescura dos nomes**.
> As afirmações do `CLAUDE.md` sobre a máquina envelhecem, e até hoje **nada verificava que
> envelheceram**. A perda aparece nos dois sentidos e custa o mesmo nos dois: o gate só reprova
> DEPOIS do fato, quando podia ter orientado ANTES.

**Como apareceu:** a triagem de [triagem-armadilhas-por-mecanismo.md](triagem-armadilhas-por-mecanismo.md)
classificou as 23 armadilhas do `CLAUDE.md` pelo teste *"qual comando fica vermelho se eu violar
isso?"* — respondendo a partir do que o próprio manual afirma sobre a máquina. Uma auditoria
independente conferiu no repo: **6 das 17 afirmações eram falsas**. E o PR que trouxe esse registro
ficou vermelho num gate (`docs:indice`) que o manual não cita em lugar nenhum.

## 1. Os dois sentidos, e por que os dois

| sentido | falha | caso medido |
|---|---|---|
| **1 — nome citado que não aponta para nada** | o agente procura, não acha, e conclui que a proteção não existe | `manifesto.gate` é citado como comando e não existe em `package.json` nem em workflow |
| **2 — gate que reprova e o manual não cita** | o agente é reprovado por maquinaria que ninguém nomeou | `docs:indice` reprovou o #2328 |

Um nome morto e um gate invisível são a mesma perda vista de dois lados. O gate
(`bun run gates:frescura`, `scripts/gates-frescura-check.ts`) cobra os dois.

## 2. O número que decidiu a forma do sentido 2

Medido no `ci.yml` de 2026-09-07: **28 steps bloqueantes** (mais 1 informativo, o `sonda:fanout`,
rotulado no próprio arquivo como *"informativo, nunca reprova"*) e **5 hooks** com
`permissionDecision: "deny"`.

| | |
|---|---|
| citados no `CLAUDE.md` | 9 |
| citados em `docs/agent/` com orientação real | 6 |
| citados **só** dentro de um censo datado | **5** |
| sem menção alguma | **5** |

**O achado que mudou o desenho.** Os 5 do "censo datado" viviam todos numa mesma frase de
`docs/agent/deploy.md` — *"Em 2026-08-23 eram 15 steps: …"*. Uma lista congelada em 15 nomes num CI
que já tinha 28, e que era a **única** menção de `docs:indice`, `docs:links`, `bunpin:check`,
`mutcheck:selftest` e `scripts:typecheck` no repo inteiro.

Ela é a própria classe de afirmação que envelhece que o gate existe para pegar. Aceitá-la como
citação faria o sentido 2 nascer **incapaz de pegar o seu próprio caso de origem** — e
**sempre-verde é o espelho de sempre-vermelha: as duas aprovam tudo**.

⇒ Por isso o sentido 2 **não varre prosa**. Ele exige um **censo delimitado**
(`<!--gates:frescura inicio-->` … `<!--gates:frescura fim-->`) que bate EXATO com o inventário do
`ci.yml` + `settings.json`, nos dois lados: gate ausente do censo é vermelho (o manual não avisa) e
nome no censo que não reprova mais também é vermelho (o manual mente). Um censo que não pode
envelhecer em silêncio.

**Nenhum dos dois números era "dezenas"**, então a catraca com baseline (a forma do
`claude-md-secoes-baseline.txt`) foi recusada: ela registraria como dívida 11 buracos que cabiam
numa entrega. Baseline é para quando o vermelho imediato é ruído — não era o caso, e é a decisão
que [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) manda tomar com o número
na mão, não por reflexo.

## 3. O que conta como "gate que reprova"

- step de CI com `run`, **sem** `continue-on-error: true` → conta;
- hook do `settings.json` que emite `permissionDecision: "deny"` → conta;
- hook que só imprime aviso → **não** conta como gate; sai no resumo à parte (13 deles hoje).

A classificação do hook lê o fonte com `removerComentariosShell` do stripper COMPARTILHADO, e não
por elegância: **`read-contexto-nudge.sh` cita `"deny"` três vezes, todas em COMENTÁRIO, explicando
por que decidiu NÃO negar.** Uma varredura crua o promove a bloqueio — falso positivo medido ao
desenhar este gate, e a lição de [gates-textuais-cegos.md](gates-textuais-cegos.md) cobrada na
prática. O `ci.yml` é lido por parser de YAML pelo mesmo motivo: `continue-on-error` é a diferença
entre bloqueio e aviso, e errá-la desliga o gate por qualquer um dos dois lados.

## 4. O eixo POR FORA — um gate que lê o `ci.yml` mora dentro do `ci.yml`

Sensor que consulta a máquina que vigia herda o defeito dela. Três eixos ficam de fora:

1. **`gates-frescura-check.test.ts`** (vitest) — funções puras sobre fixtures sintéticas, sem
   tocar o `ci.yml` real;
2. **`scripts/test-gates-frescura.sh`** (bash) — roda o binário de verdade contra uma raiz
   sintética completa, sob `test:hooks` **e** `test:falsificacao`;
3. o sentido 1 confere existência contra `package.json` e a árvore versionada — fontes que não são
   o `ci.yml`.

## 5. A falsificação, e a falsificação DA falsificação

7 sabotagens, **uma por vez**, cada sentido separado — a direção que ficasse verde sob a própria
sabotagem seria redundante ou inalcançada:

| # | sabotagem | marcador exigido |
|---|---|---|
| S1 | manual cita nome que não existe | `ORFAO` |
| S2 | nome existe mas ninguém invoca | `ORFAO` |
| S3 | gate do `ci.yml` some do censo | `NAO-CITADO` |
| S4 | censo lista nome que não reprova mais | `CENSO-OBSOLETO` |
| S5 | hook `deny` novo não entra no censo | `NAO-CITADO` |
| S6 | bloco do censo sumiu (rc=2) | `FRESCURA-FALHA` |
| S7 | `ci.yml` ilegível (rc=2) | `FRESCURA-FALHA` |

O **controle é remontado e reconferido antes de CADA sabotagem**, na mesma invocação, e a suíte
ABORTA se ele não estiver verde — sem isso, uma raiz nascida vermelha aprovaria as 7.

E o controle foi ele mesmo falsificado: com a fixture nascida vermelha, a suíte **abortou (exit 1)
nomeando a causa certa** (`NAO-CITADO: gate:dois`) e reportou **zero** sabotagens como ok. A
primeira tentativa desse meta-teste não valeu: a cópia rodou de fora do repo e abortou por
`Module not found` — exit 1 pelo motivo ERRADO é ausência de dado, não prova.

Marcadores são ASCII, caixa fixa, casados sem `-i`; a suíte roda sob `LC_ALL=C` **e**
`pt_BR.UTF-8`.

## 6. O que este gate já pegou, no próprio nascimento

- **`CLAUDE.md:62` dizia "Sem cron de sonda ativa"** com **3 migrations** de `cron.schedule` no
  repo (`20260905183314`, `20260906151204`, `20260906180303`) e a allowlist positiva
  `_shared/sonda-cron-alvos.ts`. Corrigido.
- **`CLAUDE.md:42` nomeava o vigia errado:** `psql:errorstop` existe e é real, mas **não é step do
  CI** — quem reprova é `test:hooks` (via `scripts/test-psql-ro-error-stop.sh`) e o vitest. O gate
  o acusou como órfão; a linha passou a citar `test:hooks`.
- **O gate acusou a SI MESMO:** ao virar step do `ci.yml` ficou vermelho por não estar no censo,
  antes de qualquer sabotagem. É a demonstração do sentido 2 no repo real.

As duas correções do `CLAUDE.md` são **fatuais e couberam no orçamento** (2599 → 2598 palavras;
Armadilhas 1228 → 1227). O **corte de ~165 palavras segue BLOQUEADO** até existir a matriz
`obrigação → teste negativo → bloqueio obrigatório` (§6 de
[triagem-armadilhas-por-mecanismo.md](triagem-armadilhas-por-mecanismo.md)) — corrigir um nome
errado não é o corte.

## 7. O que fica de fora, de propósito

Duas allowlists, curtas e justificadas por comentário — a allowlist é o que se revisa no diff:

- **citação:** `psql-ro` (wrapper em `~/.config/afiacao/`, fora do repo por desenho) e
  `pointer:coarse` (media feature do CSS, com forma de script npm por acidente).
- **censo:** `install` e `cache` — infraestrutura de runner, não orienta decisão de código.

**Step bloqueante sem nome de comando fica fora — mas CONTADO.** Hoje são 2 (o download do
shellcheck pinado e o step que converte `exit 2` do carimbo em falha do monitor); nenhum orienta
decisão de código. Um gate futuro escrito em python ou shell puro cairia aí, então o resumo imprime
o número e os nomes **no verde e no vermelho** — exclusão calada é o mesmo veneno do censo datado:
"29 gates conferidos" lê como cobertura total tanto quando é quanto quando não é.

**Skill conta como invocador.** O `CLAUDE.md` cita DE PROPÓSITO comandos que só skill roda —
`pendencias:deploy` vive em `/fecho` e `lovable-deploy-verify`. Exigir workflow/hook para ele seria
falso positivo permanente.

## Ver também

- [triagem-armadilhas-por-mecanismo.md](triagem-armadilhas-por-mecanismo.md) — a triagem que errou
  35% e pediu este gate
- [gates-textuais-cegos.md](gates-textuais-cegos.md) — verde por cegueira em gate de texto
- [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) — sabotar sem controle
  verde é teatro
