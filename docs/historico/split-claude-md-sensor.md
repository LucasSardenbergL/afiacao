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

Fase 0 (sensor) instalada. Fase 1 (mover as 413 palavras) **bloqueada até haver medição** —
deliberadamente. Zero regra movida até agora.
