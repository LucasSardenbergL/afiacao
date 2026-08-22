# Dividir o CLAUDE.md — por que a divisão óbvia é a errada, e o sensor que decide

**Quando:** 2026-08-22 · **Como apareceu:** o `claude:size` reportou 2.594/2.600 palavras
(6 de folga). Compactação recuperou 294; a pergunta seguinte do founder foi *"não faz sentido
dividirmos o CLAUDE.md?"*.

## Os 3 mecanismos — e o que cada um custa

Verificado na doc oficial do Claude Code, não presumido:

| Mecanismo | Quando carrega | Economiza contexto? |
|---|---|---|
| `@path` import no CLAUDE.md | no launch, **inline** | ❌ **zero** |
| `CLAUDE.md` aninhado (`src/CLAUDE.md`) | quando o Claude LÊ arquivo daquele dir | ✅ |
| `.claude/rules/*.md` com `paths:` | quando o Claude LÊ arquivo que casa o glob | ✅ |

A doc é explícita sobre imports: *"doesn't reduce context, since imported files load at launch"*.
⇒ **dividir por `@import` é trabalho com aparência de ganho.** Serve para organizar a EDIÇÃO,
nunca para orçamento.

## A inversão: o maior pedaço é o PIOR candidato

Instinto: mover a seção **⚠️ Armadilhas recorrentes** (1.039 palavras, **45%** do arquivo).
Está errado, por três razões específicas deste repo:

1. **Elas falham ABERTO.** Regra de estilo que não carrega custa inconsistência; a regra do
   `WITH (security_invoker=on)` que não carrega custa **RLS bypassada em produção**. Carregamento
   preguiçoso É uma sonda — e a doutrina da casa (`sonda-ausente-em-script-que-apaga.md`) diz que
   sonda de coisa destrutiva é **fail-CLOSED**.
2. **O workflow de banco daqui não TOCA `supabase/`.** Escrita é *"só via SQL Editor do Lovable
   (founder cola)"* — o agente escreve o SQL no CHAT. Uma regra escopada em `supabase/**` **nunca
   dispararia** justamente no fluxo que ela existe para proteger.
3. **Depois do `/compact` elas somem** até algum arquivo casar o glob de novo. O founder usa
   `/compact` com frequência (é preferência declarada no CLAUDE.md).

### O que é seguro mover (baixo raio de explosão)

| Seção | Palavras | Escopo natural | Custo se não carregar |
|---|---|---|---|
| Stack | 156 | `src/**` | inconsistência |
| Design System v3 | 139 | `src/**/*.tsx` | inconsistência |
| Auth & roles | 66 | `src/**` | inconsistência |
| Convenções de código | 52 | `src/**` | inconsistência |
| **Total** | **413 (18%)** | | **nenhum fail-open** |

Núcleo sempre-ligado cairia de 2.306 → **~1.890** sem mover nenhuma regra fail-open.

## O furo no gate atual

`scripts/check-claude-md-budget.sh` mede o **arquivo inteiro**. Isso deixa Armadilhas crescer
sendo paga pelo encolhimento de Stack — ou seja, **encolher a parte segura para financiar a
arriscada**, invisível ao gate. A correção de CLASSE é teto **por seção** (mesmo ratchet do
`manifesto.gate`), não teto maior.

Corolário mais geral: compactação melhora o **nível**, não a **inclinação**. Armadilhas cresce a
cada lição aprendida; só um teto por seção muda a inclinação.

**Fechado em 2026-08-22** (mesmo dia): o gate passou a medir por seção (`## `), com ratchet em
`scripts/claude-md-secoes-baseline.txt` — teto de cada seção = o valor MEDIDO no dia, número
inventado nenhum. Armadilhas ficou travada em **1.083 palavras**. Três saídas de emergência foram
fechadas junto, porque cada uma devolveria o furo por outro caminho: seção **nova** sem teto
(bastaria mover o bullet para `## Armadilhas parte 2`), teto **órfão** por renome do título (o teto
passaria a medir NADA, verde por cegueira), e **encolher sem re-fixar** (a compactação de hoje
viraria crédito silencioso de recrescimento amanhã — de novo nível, não inclinação). O caso que dá
nome à suíte é o furo original: uma seção cresce, outra encolhe o mesmo tanto, o total do arquivo
não muda — verde no gate antigo, vermelho no novo (`scripts/test-claude-md-budget.sh`).

Efeito colateral medido no caminho: `wc -w` conta o `⚠️` do título de Armadilhas como 1 palavra em
`LC_ALL=C` e 2 em `pt_BR.UTF-8` (2337 x 2338). Com teto apertado por seção isso seria vermelho
falso em um dos ambientes — o gate inteiro passou a contar por `awk NF`, que deu o mesmo número
nos dois. É o #1483 aparecendo na própria régua.

## A pergunta que a doc NÃO responde — e o sensor

**Regra `paths:` chega no SUBAGENTE?** O orçamento do `claude:size` se justifica com *"carregado
em TODA sessão + subagente"*. Se regras path-scoped não alcançam subagente, mover as convenções
de frontend **degrada silenciosamente** todo subagente que mexe em `src/`.

Sem esse dado, mover é aposta. Por isso a fase 0 **não é mover — é medir** (a regra
"fase N+1 exige SINAL da fase N", aplicada à própria infraestrutura de agente).

**Instalado:**
- `.claude/hooks/instrucoes-carregadas.sh` — hook `InstructionsLoaded`, grava JSONL em
  `~/.config/afiacao/instrucoes-carregadas.jsonl`. O payload traz `agent_id`/`agent_type` quando
  roda em subagente — **é esse campo que responde a pergunta**. E `load_reason` distingue
  `session_start` · `nested_traversal` · `path_glob_match` · `include` · `compact`.
- `scripts/instrucoes-relatorio.sh` (`bun run claude:instr`) — lê o log e separa **três**
  desfechos que não podem ser confundidos: log inexistente = ausência de dado · evento com
  `.erro` = sensor quebrado · seção que falha = `exit != 0` (nunca seção vazia silenciosa).

Log mora em `~/.config/afiacao/` e **não** em `/private/tmp` — aquele morre no reboot, e log
ausente deixaria de distinguir "não carregou" de "foi limpo".

### Como decidir quando houver dado

Rode `bun run claude:instr` depois de alguns dias de uso real e olhe a seção 1:

- `CLAUDE.md ⟵ <algum agent_type>` aparecendo ⇒ CLAUDE.md alcança subagente (esperado).
- Depois de criar a 1ª `.claude/rules/*.md` com `paths:`, se ela **nunca** aparecer com um
  `agent_type` ⇒ regra path-scoped **não** alcança subagente ⇒ **não** mover convenção para lá
  enquanto subagente fizer trabalho de frontend.
- `motivo: compact` mostra o que é reinjetado após `/compact` — o que não reaparecer ali é
  exatamente o que fica AUSENTE no resto da sessão.

## Estado

**Fase 1 (2026-08-22, ~1h depois): decisão = NÃO MOVER NADA. Zero das 413 palavras.**
Não porque a medição reprovou — porque **a medição não tem controle ainda**.

### O que o `claude:instr` mostrou

7 eventos, 0 erro de sensor, **7/7 `session_start` · 7/7 `principal`**. Janela real:
19:40→20:36 UTC do mesmo dia — **56 minutos**, não os "alguns dias de uso real" que a
própria fase 0 prescreveu.

As três perguntas, e o que a coleta responde:

| # | Pergunta | Resposta |
|---|---|---|
| 1 | regra `paths:` chega no subagente? | **sem dado** — 0 evento de subagente |
| 2 | o que sobrevive ao `/compact`? | **sem dado** — 0 evento `compact` |
| 3 | peso de cada arquivo | **sem dado** — era 0 fabricado (abaixo) |

### Por que "0 subagente" NÃO é a resposta negativa

A fase 0 previa `CLAUDE.md ⟵ <algum agent_type>` como **linha de base**. Ela não apareceu.
Isso tem duas leituras opostas — (a) o carregamento não alcança subagente · (b) nenhum
subagente rodou — e confundi-las inverteria a decisão. **É (b), verificado nas transcrições:**
nenhuma das 7 sessões medidas tem diretório `<sessao>/subagents/`. A sonda foi falsificada
antes de valer (57 transcrições do mesmo `~/.claude/projects` **têm** `isSidechain` ⇒ o padrão
casa quando existe o caso) — e a 1ª versão dela procurava no arquivo errado, porque subagente
mora em diretório próprio, não no `.jsonl` da sessão.

⇒ **Criar a `.claude/rules/*.md` de teste agora seria um experimento SEM CONTROLE:** um
negativo ali seria indistinguível de "o sensor nunca observa subagente". O gate da fase 2 é
por isso um sinal **positivo**, não um calendário.

### O sensor fabricava um número (corrigido nesta fase)

`chars: 0` em **todos** os 7 eventos. Falsificado alimentando o hook com payload sintético:
com `file_content` → `chars: 5`; sem → `chars: 0`. O hook está certo; **o payload do
`InstructionsLoaded` não traz `file_content`**, e o `// ""` transformava ausência na medida 0 —
a mesma fabricação que `Number(null)===0` é no money-path, dentro do instrumento que existe
para decidir. Agora: `null` (renderizado `n/d`), e o hook grava **`campos`** = a lista de chaves
do payload, para o contrato parar de ser adivinhado.

O mesmo defeito de classe segue latente em `agente: (.agent_type // "principal")` — subagente
cujo payload omitisse `agent_type` seria rotulado "principal" e responderia a pergunta 1
**errado e calado**. Com `campos` no log isso passa a ser detectável.

E o relatório passou a imprimir o **denominador** (`N sessões · N eventos de subagente`) com
aviso explícito quando é zero: sem denominador, a seção 1 lê-se como resposta negativa. Regra
da casa aplicada ao próprio instrumento — *"exija ≥1 sinal POSITIVO com denominador"*.

### Gate da fase 2 (positivo, não calendário)

Rode `bun run claude:instr`; só destrave quando **ambos** aparecerem:

1. **≥1 linha na seção 1 com um `agent_type`** — prova que o sensor ENXERGA subagente. Só
   então criar a 1ª `.claude/rules/*.md` com `paths:` e reler: se ELA nunca aparecer com
   `agent_type`, aí sim é resposta negativa ⇒ não mover convenção de frontend.
2. **≥1 evento `motivo: compact`** — responde a pergunta 2.

### A inclinação, agora MEDIDA

De quebra, a tese do "nível × inclinação" saiu do argumento e virou número: `CLAUDE.md` em
**2.306 palavras no merge do #1879** e **2.337 quatro horas / quatro PRs depois** (#1880-#1883)
— **+31 palavras**, sem ninguém pretender engordá-lo. No mesmo ritmo, os 294 de folga que a
compactação comprou duram ~38 PRs. O teto por seção continua sendo a correção de CLASSE;
mover as 413 palavras compraria nível de novo, não inclinação — mais um motivo para não
apressar a fase 2 e gastar o esforço no ratchet por seção.

Enquanto isso: núcleo em 2.337 palavras, zero regra movida, zero regra fail-open tocada.
