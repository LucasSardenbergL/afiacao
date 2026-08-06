# Escolha de modelo — o terceiro fator do custo (medido, 2026-08-03)

Custo de token = `requests × contexto × preço por token`. Os PRs #1647–#1650 atacaram os dois
primeiros (piso e ocupação de contexto — ver [piso-de-contexto.md](piso-de-contexto.md)).
Este registro é sobre o terceiro, que ninguém tinha olhado: **qual modelo roda a sessão**.

Janela: 48 dias, 149.859 requests, via `scripts/tokens-report.sh`.

## O achado

| | share do custo | share dos requests |
|---|---|---|
| **Fable 5** | **34%** (US$ 12.672) | 18% |

A desproporção é aritmética, não anomalia: Fable custa **2x** Opus 5 (US$ 10/50 vs 5/25 por
MTok). O que exige explicação não é o preço — é por que 18% dos requests foram parar nele.

## O teste decisivo: era inércia, não escolha

**Nenhum modelo estava fixado** — nem em `settings.json`, nem em variável de ambiente.
Então "qual modelo abre a sessão" era decidido pelo default do harness, não por desenho.

A hipótese "o founder escolhe Fable deliberadamente quando a tarefa pede" é falsificável, e
foi falsificada: nas **34 sessões que misturaram modelos, 31 COMEÇARAM em Fable** e trocaram
depois (**91%**). Se a escolha fosse deliberada o padrão seria o inverso — começar barato e
**escalar** ao topar com dificuldade. Começar sempre no topo e descer é a assinatura de um
default herdado.

E escalar não tem penalidade: **trocar de modelo no meio da sessão custou US$ 15 no período
inteiro** (~US$ 0,17 por troca). A estratégia "começa barato e sobe" era viável o tempo todo.

## Mas 75% do Fable se justifica — o alvo é a cauda, não o modelo

Auditar o conteúdo das sessões Fable desmonta a leitura fácil de "34% do custo é desperdício":

- **~75% se justifica**: money-path, handoffs de fase, auditoria ampla ("revê todo o código
  procurando bugs", "auditoria de 52 páginas"), motor de compra / ciclo financeiro. Isso é
  exatamente long-horizon autônomo, onde Fable é indicado.
- **~25% (US$ 3.176) não**: brainstorm (um deles custou US$ 689, com Codex junto), leitura de
  artigo do Brazil Journal para gap analysis (US$ 621), e uma sessão de US$ 382 / 630 requests
  cujo pedido foi *"me explique como se fosse para uma criança o que eu posso fazer pelo
  aplicativo"*.

**53% do desperdício está em TRÊS sessões.** É cauda longa concentrada, não padrão difuso —
o que decide qual mecanismo funciona (ver adiante).

### ❌ Estimativa refutada: "economia de US$ 6.336/mês"

Uma primeira conta assumiu que **metade** do uso de Fable era desperdício. A auditoria mediu
~25%. Trocar esses 25% para Opus economiza **metade** deles (Opus custa metade), ou seja
US$ 1.588 em 48 dias ≈ **US$ 800–990/mês** — 4x menos que a estimativa original.

E **não é desembolso**: o founder está em assinatura. O número é custo-equivalente de API e
serve para **priorizar desperdício**; o ganho real é headroom de cota, e só vale alguma coisa
na medida em que a cota aperte.

## A decisão: NÃO virou regra no CLAUDE.md

Três motivos, em ordem crescente de força:

1. **Não cabe.** O CLAUDE.md estava em 19.493/20.480 bytes e 2.584/2.600 palavras — 16
   palavras de folga. Entrar exigiria remover outra regra, e as que estão lá são armadilhas
   que já materializaram prejuízo.
2. **Alvo errado.** O CLAUDE.md instrui o **agente**. Quando ele é lido, o modelo já foi
   escolhido — e o agente não pode trocar o próprio modelo. Uma regra ali seria
   estruturalmente incapaz de agir sobre o que quer mudar.
3. **O próprio dado refuta o mecanismo.** O achado é que a escolha é *inércia*. Regra escrita
   = pedir disciplina contra um default. Se disciplina bastasse, os 91% não existiriam.
   **O conserto de um default é outro default, não um texto.**

Também descartado: **nudge no turno 1** ("classifique a tarefa e sugira trocar"). Gastaria
meta-conversa em 100% das sessões para acertar 25%, e o turno 1 é justamente quando menos se
sabe sobre a tarefa. Contra uma cauda concentrada em 3 sessões, um gatilho por custo
acumulado acerta essas 3 sem incomodar as outras 200.

## O que virou, então

### 1. Default invertido — `"model": "opus"` em `.claude/settings.json`

Uma linha, commitada, valendo em todas as worktrees. Ataca a causa medida (o default vazio)
sem custar contexto nem disciplina. `/model fable` continua sobrepondo na sessão — e o hábito
de trocar já existe (34 sessões o provam), a um custo de ~US$ 0,17.

**Risco assumido:** abrir uma auditoria ampla e esquecer de subir para Fable. Mitigação: o
modelo aparece na UI ao abrir, e a troca é barata e reversível.
**Reverter:** apagar a linha `"model": "opus"` do `.claude/settings.json`.

### 2. O alerta de contexto passou a medir CUSTO, não token

`.claude/hooks/stop-contexto-caro.sh` (do #1649) comparava o contexto cru contra degraus fixos
(250/350/500/700k) — tratando 250k em Fable e 250k em Opus como o mesmo aviso, **quando o
primeiro já gastou o dobro**. O hook já lia o modelo e já tinha o preço por família; só não
usava isso no gatilho.

Agora o degrau é em **"tokens-Opus"**: `contexto × preço_do_modelo / preço_do_Opus`.

| modelo | fator | avisa a partir de (contexto real) |
|---|---|---|
| Opus 5 (referência) | 1,0 | 250k — **calibração original intacta** |
| Fable 5 | 2,0 | **125k** — metade do caminho |
| Sonnet | 0,6 | ~417k |
| Haiku | 0,2 | 1,25M (na prática, nunca) |

Em Fable o aviso ainda ganha uma linha oferecendo `/model opus` — **com a ressalva de NÃO
descer** quando o que resta é auditoria ampla / money-path / long-horizon. Os 75% que se
justificam não podem virar dano colateral da correção dos 25%.

### 3. O que fica com o agente (e é onde ele decide de fato)

O agente não escolhe o próprio modelo, mas **escolhe o dos subagentes** (`Agent`, e `opts.model`
em workflows). É lá que "long-horizon → Fable" é decisão dele, não do founder.

## Como saber se funcionou (evidência positiva, não impressão)

```bash
scripts/tokens-report.sh --dias 45 --desde 2026-09-03
```

A asserção falsificável: **a fatia de Fable no custo cai de 34% sem que o share de requests
de Fable caia abaixo de ~13%.** Se o share de requests despencar junto, o default estará
sequestrando as sessões long-horizon que legitimamente precisam de Fable — e aí o certo é
reverter, não celebrar.

O `--desde` (e o `--dias` largo) não são detalhe: ver "Achado 1" abaixo — sem eles a
asserção é intestável.

---

# Verificação pós-entrega — 2026-08-04

**Veredito: INCONCLUSIVA.** Nem confirmada nem refutada — e a tentativa devolveu dois
achados que valem mais que o veredito que ela não pôde dar.

## Por que não deu para testar: a verificação rodou 6 minutos depois do merge

Foi agendada para ~30 dias após o merge; disparou no mesmo instante dele (merge
`aadb96ee` às 2026-08-04T02:27:09Z, medição às 02:33). Requests estritamente posteriores
ao merge: **280, US$ 50** — 0,2% dos requests e 0,15% do custo da janela. E parte deles é
a própria sessão de verificação, que roda em Opus por estar numa worktree coberta: a
amostra não é só minúscula, é **contaminada pelo observador**.

Qualquer número apresentado como "resultado" aqui seria o baseline com outro nome. O
`--dias 30` rodado devolveu Fable em **31,8% do custo / 16,5% dos requests** (140.601
requests, US$ 34.231) — parece a asserção passando, e não é: é pré-intervenção medida
sobre janela deslocada (ver Achado 1). **Não conte isso como vitória.**

## Achado 1 — a asserção era INTESTÁVEL como escrita (corrigido)

`--dias N` não delimita a janela de requests: filtra por mtime do **arquivo**
(`find -mtime`). Um JSONL de sessão retomada tem mtime de hoje e requests de meses atrás.

Medido: `--dias 30` (nominal desde 07-04) devolveu requests **desde 2026-05-20** — 76 dias
de span, 49 dias com dados, **7.669 requests (5,1%) fora da janela nominal**.

Consequência para a verificação: a janela sempre arrasta meses de dados pré-mudança, que
diluem o efeito. Uma intervenção que funcionasse perfeitamente apareceria abafada — e o
resultado seria lido como "não mudou nada". **A asserção não podia ser satisfeita nem se
a hipótese estivesse certa.**

Corrigido no `tokens-report.sh`: `--desde`/`--ate` recortam pela data do **request**; o
relatório passa a imprimir a **JANELA REAL** de datas presentes (o que impede ler
"`--dias 30`" como "30 dias"); e `POR MODELO` ganhou **`%reqs` ao lado de `%custo`** —
a asserção tem duas metades e o relatório mostrava só uma. Teste:
`scripts/test-tokens-report.sh` (falsifica sob 2 sabotagens, em `C` e `pt_BR.UTF-8`).

> Sub-lição, 3ª ocorrência da classe do #1483: a primeira versão do teste casava
> `50\.0%` e passava só sob `LC_ALL=C` — o `awk` formata `%.1f` pelo `LC_NUMERIC`, e sob
> `pt_BR.UTF-8` sai `50,0`. Verde no shell de quem escreveu, vermelho no do founder.
> Agora é `50[.,]0`. **Toda asserção sobre número formatado é suspeita de locale**, não
> só as sobre acento.

## Achado 2 — ❌ "valendo em todas as worktrees" é FALSO (refuta uma premissa do #1654)

O registro acima diz: *"Uma linha, commitada, valendo em todas as worktrees."* Medido, não
vale. `.claude/settings.json` é versionado — a linha só existe onde o **branch contém o
commit**. Worktrees em branches anteriores ao merge seguem sem ela, e não há
`model` no `~/.claude/settings.json` (user-level) para servir de rede.

Estado em 2026-08-04: **9 de 47 worktrees** têm a linha. E as 38 sem não são zumbis —
cruzando com os requests dos últimos 7 dias:

| | worktrees c/ tráfego | requests em 7d |
|---|---|---|
| **sem** a linha | 6 | **5.109 (77%)** |
| **com** a linha | 6 | 1.560 (23%) |

As três maiores produtoras de request do período (`eager-lovelace-3bfd80` 2.063,
`dazzling-chatelet-1210d1` 1.303, `gallant-heisenberg-05b2d1` 1.038) estão **todas sem o
default**. O diretório principal também: parado em `claude/projeto-verificado-sayerlack`
desde 2026-06-18, sem o commit.

Ou seja: a correção alcança hoje ~1/4 do tráfego real. Isso não refuta a hipótese do
#1654 — refuta a premissa de **cobertura** com que ela seria medida. Medir daqui a 30 dias
sem consertar isso mistura worktrees tratadas e não-tratadas no mesmo número, e o
resultado não responde nada.

**Correção estruturalmente certa (decisão do founder, não executada aqui):** `model` no
`~/.claude/settings.json` (user-level) vale em toda worktree independente de branch. O
custo é sair do versionamento — some do repo e do DR. A alternativa versionada é
rebasear/recriar as worktrees ativas, que expira sozinha conforme worktrees velhas morrem.

### ✅ Reavaliado 48h depois: o Achado 2 estava certo no número e ERRADO na implicação

O que a medição de 08-04 não sabia: **o parque de worktrees rotaciona em dias, não em
semanas.** Remedido em 2026-08-06, sem que nada fosse feito a respeito:

| das 5 worktrees "sem a linha" que dominavam o tráfego em 08-04 | |
|---|---|
| recicladas (`dazzling-chatelet`, `gallant-heisenberg`, `musing-knuth`) | 3 |
| ganharam a linha sozinhas (`eager-lovelace`, ao sair de um branch velho) | 1 |
| seguem sem (`adoring-ptolemy`) | 1 |

E o tráfego, que é a métrica que importa (2026-08-04→06, 1.260 requests):

| worktree | requests | |
|---|---|---|
| **com** a linha | 1.093 | **86,7%** |
| **sem** a linha | 0 | 0,0% |
| já reciclada (eram as "sem" de 08-04) | 167 | 13,3% |

De 23% para **86,7% de cobertura efetiva em 48 horas, sem intervenção**. A contagem crua
de worktrees piorou no mesmo período (9/47 → 6/41) e é justamente a métrica errada: as
~34 "AUSENTE" são worktrees paradas que **não geram request**. Ponderar por tráfego era o
certo desde o começo.

**Consequência prática:** a "correção estruturalmente certa" acima virou desnecessária —
mexer no `~/.claude/settings.json` (com o custo de sair do versionamento) resolveria um
problema que expira sozinho. A recomendação passa a ser **não fazer nada**.

**A exceção real, que não rotaciona:** o **diretório principal** é permanente e segue
parado em `claude/projeto-verificado-sayerlack` desde 2026-06-18. É o único caso que a
rotação não cura — e é pequeno (14 requests em 7 dias). Vale um `git checkout main` lá,
não uma mudança de arquitetura de configuração.

> **Lição:** "77% do tráfego está descoberto" e "a cobertura converge sozinha em 48h" são
> a mesma medição lida em dois horizontes. Uma medição pontual de um sistema que rotaciona
> mede o **estado**, não a **tendência** — e a decisão dependia da tendência. Antes de
> propor conserto estrutural para um número ruim, meça se ele anda sozinho.

### Sinal preliminar sobre a asserção (2 dias — NÃO é o veredito)

Nas worktrees que têm o default, 1.093 requests em 48h: **Fable = 37,2% dos requests e
55,3% do custo** — *acima* dos 16,5%/31,8% do baseline. Duas leituras cabem, e 2 dias não
separam as duas: (a) o default não sequestrou nada e a troca deliberada para Fable segue
viva — o que a asserção quer; (b) o período foi dominado por poucas sessões long-horizon,
e o número é da amostra, não da política.

Registrado como **sinal, não resultado**, justamente para não repetir o erro que este
documento acabou de catalogar: ler janela curta como tendência. O veredito continua sendo
o de ≥ 2026-09-03.

## O que NÃO foi feito: reverter

O cenário de reversão previsto ("custo e requests despencam juntos") não se materializou —
**e não podia**, sem dados. Reverter agora por precaução seria descartar a intervenção com
base em ruído. `"model": "opus"` fica.

## Como refazer a medição na data certa (≥ 2026-09-03)

```bash
scripts/tokens-report.sh --dias 60 --desde 2026-08-04 --tsv /tmp/pos.tsv
scripts/tokens-report.sh --dias 0  --ate 2026-08-03 --tsv /tmp/pre.tsv
```

`--dias` largo (só escolhe QUAIS ARQUIVOS ler) + `--desde/--ate` (recorta os requests).
Compare a linha `claude-fable-5` em `POR MODELO`: `%custo` deve cair de 34%, `%reqs` deve
ficar em ~13-18%. **Antes de comparar, confira a cobertura** — sem ela o número é média de
tratados com não-tratados:

```bash
git worktree list --porcelain | awk '/^worktree /{print $2}' \
  | while read -r w; do printf '%s %s\n' \
      "$(jq -r '.model // "AUSENTE"' "$w/.claude/settings.json" 2>/dev/null)" \
      "$(basename "$w")"; done | sort | uniq -c | sort -rn
```

## Lição transferível desta verificação

> **Uma verificação pós-entrega precisa ser ensaiada antes da data.** O que quebrou aqui
> não foi a hipótese — foi o instrumento (`--dias` media outra coisa) e a cobertura (a
> mudança alcançava 1/4 do que se ia medir). Ambos eram descobríveis no dia 1, e ambos
> teriam invalidado silenciosamente a medição no dia 30, devolvendo um número que parece
> resposta e não é.
>
> Corolário do "ausente ≠ zero" do CLAUDE.md, aplicado a experimento: **janela errada ≠
> efeito ausente**, e **default não aplicado ≠ default que não funciona**.

## Lição transferível

> Antes de escrever uma regra contra um comportamento, pergunte se ele é **escolha ou
> default**. O teste é barato: se a escolha fosse deliberada, qual padrão os dados
> mostrariam? (Aqui: começar barato e escalar. O medido foi o inverso, em 91% dos casos.)
>
> Contra um default, regra escrita é o mecanismo errado — perde para o default que ela pede
> para o humano vencer todo dia. Troque o default.
>
> E cuidado com a correção que atropela o caso legítimo: 75% do uso "caro" aqui se pagava.
> Uma regra que mirasse "Fable é caro" teria destruído mais valor do que economizou.
