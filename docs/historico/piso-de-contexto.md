# Piso de contexto — o que REALMENTE o reduz (medido, 2026-07-31)

**Piso de contexto** = o que é relido em TODO request de TODA sessão: system prompt do
harness + schemas das tools + lista de skills + CLAUDE.md + saída dos hooks. É o alvo mais
rentável de otimização (82% do custo de token é ENTRADA de contexto: `cache_read` 58,5% +
`cache_write` 25,0%; gerar resposta é só 16,4%) — cortar 1 token de piso rende em 100% dos
requests, para sempre.

E é também onde as premissas plausíveis mais enganam. **Duas hipóteses razoáveis foram
medidas e REFUTADAS** — as duas teriam virado "otimização" entregue sem número.

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
por releitura) ataca justamente a fatia nº 1.

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

> O piso não responde a cortes *dentro* de blocos de orçamento fixo (lista de skills,
> descrições). Responde a **remover um provedor inteiro** (plugin, MCP, servidor).
> E: "encurtei X, logo economizei" é hipótese — o número vem da sonda, antes e depois.
>
> E antes de otimizar um alvo, **meça que fração do custo ele é**. O piso parecia o alvo
> óbvio (é relido em 100% dos requests) e é só 26%. Otimizar bem a coisa errada perde para
> medir primeiro.
