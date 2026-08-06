# Piso de contexto — o que REALMENTE o reduz (medido, 2026-07-31)

**Piso de contexto** = o que é relido em TODO request de TODA sessão: system prompt do
harness + schemas das tools + lista de skills + CLAUDE.md + saída dos hooks. É o alvo mais
rentável de otimização (82% do custo de token é ENTRADA de contexto: `cache_read` 58,5% +
`cache_write` 25,0%; gerar resposta é só 16,4%) — cortar 1 token de piso rende em 100% dos
requests, para sempre.

E é também onde as premissas plausíveis mais enganam. **Três hipóteses razoáveis foram
medidas e REFUTADAS** — uma delas chegou a PIORAR o piso. As três teriam virado
"otimização" entregue sem número.

## Réguas (as duas são read-only e ficam no repo)

| ferramenta | mede | precisão |
|---|---|---|
| `scripts/tokens-report.sh` | piso REAL das sessões vividas (lê `~/.claude/projects/**/*.jsonl`) | — |
| `scripts/piso-contexto.sh` | piso de uma CONFIGURAÇÃO (roda uma sonda e lê o 1º request) | **±6 tokens** |
| `scripts/ocupacao-contexto.sh` | de onde vem o contexto ACUMULADO (os 74% — ver seção 🎯) | — |

A sonda é o oráculo: repetições da mesma config deram 43.964 / 43.958 / 43.962 / 43.980 /
43.977. **Delta > ~50 tokens é sinal; abaixo disso é ruído.** O CLI não reproduz o app
(a sessão do app desktop carrega MCPs próprias e os plugins da conta claude.ai, e tem piso
maior) — use a sonda para comparar CONFIGURAÇÕES entre si, e o `tokens-report.sh` para o
piso absoluto.

## Baseline medido (janela de 7 dias, 20.933 requests)

- Piso médio das sessões reais: **68.537 tokens** — o menor contexto visto por sessão.
- Sessão do app desktop: piso **67.244**; sonda equivalente no CLI: **43.9xx**.
  A diferença (~23k) é o ambiente do app: MCPs próprias + 172 skills de plugins da conta.
- Distribuição do contexto por request: p50 258.927 · p90 449.812 · máx 782.883.

## ⚠️ CORREÇÃO nº 2 (2026-08-06) — a RÉGUA contava cada request 2 a 5 vezes

O `tokens-report.sh` somava **toda linha** do JSONL com `message.usage`. Mas uma chamada de
API vira VÁRIAS linhas quando a resposta tem vários blocos (texto + `tool_use` + `tool_use`),
e **todas repetem o mesmo `usage`** — verificado: cada `requestId` tem exatamente 1 valor
distinto de `usage`. Fork/resume de sessão agrava (copia o transcript do pai, o mesmo request
reaparece em outro arquivo).

Medido em 2026-08-06 sobre todo o histórico: **131.605 linhas brutas para 60.376 requests
reais — 2,18×**. Uma semana relatada como US$ 3.347 / 13.488 requests custou de fato
**US$ 1.596 / 6.601 requests**.

**O que muda e o que NÃO muda** (a distinção importa — nem todo número derivava da soma):

| número | efeito |
|---|---|
| custo US$, contagem de requests | **inflados ~2,2×** — reler tudo que dependia disso |
| piso por sessão (68.537) | **intacto** — é um MÍNIMO, duplicata não move mínimo |
| p50/p90 de contexto | levemente enviesados (request duplicado pesa n× no percentil) |
| **razões e percentuais** | **essencialmente intactos** — a duplicação é ~uniforme, então numerador e denominador inflam juntos |

A última linha é o que salva as conclusões anteriores. `escolha-de-modelo.md` e o #1664 foram
medidos com a régua torta, mas raciocinam em RAZÃO ("Fable = 34% do custo com 18% dos
requests", "86,7% de cobertura por tráfego") — e razão sobrevive. **O que não sobrevive são as
contagens absolutas** citadas naqueles docs (ex.: "1.260 requests" em 48h, "20.933 requests"
na janela de 7 dias): divida por ~2,2. Nenhuma decisão tomada com base neles muda.

Pós-dedupe a decomposição fica **cache_read 70,3% · cache_write 19,2% · output 10,4% ·
input 0,2%** — ou seja, ~90% do custo é ENTRADA. A conclusão estrutural sempre esteve certa;
só a escala estava errada.

Corrigido com dedupe global por `requestId` (fallback `.uuid`, guard `NF < 9` para TSV
antigo com `--pular-coleta`) + 4 casos em `test-tokens-report.sh`, os dois sentidos fechados
(4 = não deduplicou · 1 = colapsou demais · só o certo dá 2) e falsificados por sabotagem
nos locales `C` e `pt_BR.UTF-8`.

**A lição não é o bug — é que a régua não tinha teste para a própria unidade de medida.**
Havia teste para o recorte por data (#1660) e nenhum para "o que conta como 1 request".

## ❌ Premissa FALSA nº 1 — "encurtar a `description` das skills reduz o piso"

Encurtei as `description` das 13 skills do projeto de **16.041 → 9.659 chars** (−6.382,
preservando todos os gatilhos; a justificativa já vivia no corpo do `SKILL.md`).

| | piso | listing | skills com descrição |
|---|---|---|---|
| antes | 43.964 / 43.958 | 30.446 chars | 55 |
| depois | 43.905 / 43.901 | 30.312 chars | **62** |

**Ganho: 57 tokens (0,13% — ruído).** O `skill_listing` tem **orçamento ~fixo** (~30.4k
chars, batido em dois ambientes independentes: 30.446 e 30.431) e **preenche o espaço
liberado com outras descrições** — 55 → 62. O corte foi revertido: mudança de risco em
skills que o founder usa 86/83/77/70 vezes, com ganho zero, não se entrega.

## ❌ Premissa FALSA nº 2 — "menos skills na lista → lista menor"

Desabilitar `superpowers` tirou 14 skills (186 → 172). O listing **não encolheu**:
29.994 → 30.001 chars. Mesmo mecanismo de orçamento.

## ❌ Premissa FALSA nº 3 — "esconder as skills NÃO USADAS reduz o piso" (piora)

A nº 2 mediu 14 skills a menos. Faltava saber se o mecanismo de orçamento aguentava um
corte de outra ordem de grandeza — a hipótese sobrevivente era "com skills suficientes
fora, o pool não consegue mais preencher os ~30,4k chars e aí encolhe".

Medido o uso REAL de skills em 60 dias de transcript (`tool_use` com `name=="Skill"`):
**43 skills distintas em 784 invocações**, de 130 top-level em `~/.claude/skills` — que,
note-se, **não passa por `enabledPlugins`**: é por isso que as skills de growth/marketing
continuam na listagem mesmo com o plugin `posthog` (105 skills) desabilitado no projeto.

As 115 nunca invocadas — 5 de iOS num repo React, 4 de Sentry, 7 de Adobe, 49 de
marketing — foram para `skillOverrides: "user-invocable-only"` (113 entradas; `auto-ensino`
preservada porque o hook `SessionStart` do repo a invoca por nome).

| | piso |
|---|---|
| antes | 43.908 |
| **controle** (antes, re-medido) | **43.909** — drift +1, ambiente estável |
| depois (113 escondidas) | **44.049** |

**Efeito: +141 tokens — o piso PIOROU**, ~23× o ruído da sonda. Não é só que o orçamento
se refaz: as descrições promovidas para o espaço liberado eram **mais longas** que as
removidas, então o saldo inverte de sinal. Esconder skill do modelo é, em token, pior que
não fazer nada. Revertido.

Fica valendo para roteamento (o modelo deixa de ver 113 skills irrelevantes), mas isso é
uma afirmação NÃO medida — e o mecanismo de preenchimento sugere ceticismo: o que entra no
lugar pode ser tão irrelevante quanto o que saiu.
## ⚠️ CORREÇÃO — o orçamento existe, mas é CONFIGURÁVEL (e eu tinha concluído o contrário)

As três medições acima estavam certas; a conclusão que tirei delas, não. Eu escrevi que o
listing só encolhe removendo o provedor inteiro. **Errado** — o orçamento é uma chave do
`settings.json`, e o schema do Claude Code expõe quatro que importam:

| chave | default | o que faz |
|---|---|---|
| `skillListingBudgetFraction` | `0.01` (1% da janela) | **é o orçamento** que se reabastecia sozinho |
| `skillListingMaxDescChars` | `1536` | teto por descrição (por isso as longas apareciam cortadas) |
| `skillOverrides` | — | por skill: `name-only`, `user-invocable-only`, `off` |
| `disableClaudeAiConnectors` | — | o switch CERTO dos connectors (`ENABLE_CLAUDEAI_MCP_SERVERS` **não** funciona) |

Medido com a sonda (baseline 43.896), e o resultado tem uma inversão útil:

| config | piso | economia | skills c/ descrição | as 8 skills que o founder USA |
|---|---|---|---|---|
| baseline (`0.01` / `1536`) | 43.896 | — | 55 | 8/8 |
| `maxDescChars 300` | 43.273 | 623 | **123** | 8/8 |
| `maxDescChars 300` + `fraction 0.005` | 37.806 | 6.090 | 49 | 8/8 |
| **`maxDescChars 220` + `fraction 0.004`** | **36.720** | **7.176** | 43 | **8/8** ✅ |
| `fraction 0.003` (só) | 35.563 | 8.333 | 13 | **0/8** ❌ |

Cortar só o orçamento é a economia maior e a pior escolha: zera a descrição das 13 skills do
projeto — `fecho`, `prove-sql-money-path`, `lovable-db-operator` viram nome solto e param de
disparar sozinhas. **Capar a descrição é Pareto-superior**: com `maxDescChars 300` cabem 123
skills descritas em vez de 55 (mais que o dobro de roteamento) e ainda sobra token.

O ponto escolhido — `220` + `0.004` — economiza **7.176 tokens (16% do piso do CLI)** mantendo
os gatilhos ("Use SEMPRE que…") de 8/8 das skills usadas. As 3 do projeto que perdem descrição
(`cfo-colacor`, `farmer-industrial`, `goal`) já estavam sem ela no baseline e têm **uso zero em
48 dias** — perda real: nenhuma.

Isto também reabilita, por outro caminho, o corte revertido lá em cima: não era preciso editar
13 `SKILL.md` à mão — uma chave faz o mesmo truncamento, e melhor.

**APLICADO** no `.claude/settings.json` do repo e reconfirmado no ambiente real, com a régua
versionada (`scripts/piso-contexto.sh`):

| | piso | listing | skills c/ descrição | skills USADAS c/ descrição |
|---|---|---|---|---|
| defaults (`1536` / `0.01`) | 43.950 | 30.446 chars | 55 | 8/8 |
| **aplicado (`220` / `0.004`)** | **36.771** | **12.148 chars** | 43 | **8/8** |

**−7.179 tokens**, batendo os 7.176 previstos (erro de 3, dentro do ruído de ±6), e
reprodutível: 36.771 / 36.771 em repetições. O listing caiu 60% sem perder um gatilho sequer
das skills que o founder de fato invoca.

### E isto EXPLICA a premissa falsa nº 3

A nº 3 mediu que esconder 113 skills PIORA o piso em +141 tokens, e diagnosticou a causa:
"as descrições promovidas para o espaço liberado eram **mais longas** que as removidas".
`skillListingMaxDescChars` ataca exatamente essa causa — com um teto por descrição, o que
sobe para o espaço liberado não pode ser mais caro que o que saiu. As duas medições contam
a mesma história por lados opostos: **mexer em QUEM está na lista não resolve (e pode
piorar); mexer no TAMANHO de cada entrada resolve.**

## ✅ O que REALMENTE move o ponteiro: desabilitar o PLUGIN inteiro

O ganho não vem da lista — vem do payload que o plugin injeta por conta própria (system
prompt, hooks, agents, MCP instructions). Medido, baseline 43.962:

| plugin | delta no piso | usos em 48 dias | veredito |
|---|---|---|---|
| `claude-mem@thedotmack` | **−1.438** | 21 chamadas | caro para o uso — decisão do founder |
| `superpowers@…` | −1.016 | ~270 invocações | **manter** (paga-se) |
| `context7@…` | −141 | 3 | irrelevante nos dois sentidos |
| os 4 juntos (com `claude-md-management`) | −2.543 | — | aditivo (2.595 esperado vs 2.543 medido) |

Repetível: `--sem-plugin claude-mem@thedotmack` deu −1.438 e depois −1.440.

## O que sobra é ESTRUTURAL (e não é cortável daqui)

Com tudo desligável desligado (`--safe-mode`), a sonda ainda marca **21.678 tokens**:
system prompt do harness + schemas das tools built-in. No app soma-se o que as MCPs
próprias trazem. **Ordem de grandeza: ~2/3 do piso é do harness/app, não da configuração
do repo.** Cortes locais somam alguns milhares de tokens, não dezenas.

## 🎯 E o piso inteiro é a MENOR metade do problema

Fechada a medição do piso, a pergunta seguinte é quanto ele representa do custo. Separando,
request a request, o piso (o mínimo visto na sessão) do EXCEDENTE (o que a conversa
acumulou), sobre os mesmos 20.933 requests:

| | tokens de contexto | custo de entrada |
|---|---|---|
| piso (relido sempre) | 1,38 bi (24,3%) | US$ 1.181 (**25,9%**) |
| conversa acumulada | 4,30 bi (75,7%) | US$ 3.374 (**74,1%**) |

**Zerar o piso INTEIRO — impossível, 2/3 é harness — teto­aria em 26% do custo de entrada.**
As alavancas locais reais (~4.500 tokens de 67.244) valem ~1,7%. A Fase 1 mirou, de boa-fé,
a menor metade.

### Onde estão os 74%: custo de OCUPAÇÃO

Um `tool_result` não se paga uma vez — fica no histórico e é **relido em todo request
seguinte**. O custo real é `tamanho x (requests que ainda virão depois dele)`. Medido nas 3
sessões mais caras de 7 dias (US$1.209 somados), por duas implementações independentes que
convergiram:

| ferramenta | chamadas | maior saída | % do custo de ocupação |
|---|---|---|---|
| **Read** | 75 | 52.966 chars | **~55%** |
| **Bash** | 769 | 15.583 chars | **~40%** |
| Edit | 211 | 808 chars | ~3% |
| todo o resto | — | — | <1% |

O ponto que inverte a intuição: **Read teve 75 chamadas contra 769 do Bash — e custou
MAIS.** Não é a frequência que manda, é o tamanho por chamada multiplicado pelo tempo que a
saída ainda vai ficar no contexto. Uma leitura grande no início de uma sessão longa é o item
mais caro que existe; a mesma leitura no último request é quase de graça.

Régua: `scripts/ocupacao-contexto.sh --top 3`. O guard de Read do #1647 (nudge por volume e
por releitura) ataca a fatia nº 1; `.claude/hooks/bash-contexto-nudge.sh` ataca a nº 2.

### O erro no Bash não é esquecer o `head`

As maiores saídas medidas **já usavam** `| head -120` e `| head -60` — e ainda despejaram
9.784 e 5.460 chars. `head -n` corta LINHAS; o contexto se paga em BYTES, e em SQL, log e
código a linha passa de 80 chars. Por isso o guard tem dois ramos: quando já havia `head`/
`tail`, ele ensina `head -c` / `cut -c` (a unidade certa) em vez de repetir o conselho que
já tinha sido seguido.

O guard é PostToolUse, não Pre, porque no Pre só existe o comando — e prever volume pela
cara dele é fraco: 46,5% das chamadas medidas caíram em "outros" (compostos, heredoc,
script inline). Só depois de rodar se sabe o tamanho.

## Pendente de medição — só o founder consegue (é na conta, não no repo)

172 das 337 skills da sessão do app vêm de plugins da conta claude.ai **nunca usados em 48
dias** (`legal`, `marketing`, `engineering`, `finance`, `sales`, `data`, `human-resources`,
`operations`, `product-management`, `customer-support`, `common-room`, `brand-voice`,
`enterprise-search`, `design`, `figma`, `postiz`, `productivity`, `anthropic-skills`,
`pdf-viewer`). Eles não existem no marketplace local (`~/.claude/plugins/marketplaces/`) —
vêm do servidor, então **nenhum `settings.json` local os desliga** e a sonda do CLI não os
enxerga. Trazem ainda 6 agents (`brand-voice:*`, `zapier:*` = 9.173 chars de `agent_listing`).

Pela regra medida acima (o custo está no payload do plugin, não na lista), a estimativa é
da ordem de alguns milhares de tokens — **estimativa, não medição**. Como testar de verdade:
desligar na UI do claude.ai → abrir sessão NOVA → `scripts/tokens-report.sh --dias 1` e
comparar o piso com os 67.244 registrados aqui.

## Lição transferível

> O piso não responde a cortes *dentro* de um bloco de orçamento — o orçamento se reabastece.
> Responde a **remover um provedor inteiro** (plugin, MCP, servidor) ou a **mudar o orçamento**
> (ver a CORREÇÃO acima: ele é uma chave de settings, não uma constante do harness).
> E: "encurtei X, logo economizei" é hipótese — o número vem da sonda, antes e depois.
>
> Corolário da nº 3: dentro de um bloco de orçamento fixo, cortar não é neutro — pode
> **piorar**. O espaço liberado é repreenchido, e nada garante que o que entra seja menor
> que o que saiu. "No pior caso não muda nada" é falso aqui, e foi a intuição que mediu
> −0 e entregou +141. O que funciona é limitar o TAMANHO de cada entrada, não escolher
> quais entram.
>
> Antes de concluir "não dá para mexer nisso", **procure a chave**: o schema completo do
> settings sai pela skill `update-config`, e foi lá que apareceram as quatro que faltavam.
>
> E antes de otimizar um alvo, **meça que fração do custo ele é**. O piso parecia o alvo
> óbvio (é relido em 100% dos requests) e é só 26%. Otimizar bem a coisa errada perde para
> medir primeiro.
