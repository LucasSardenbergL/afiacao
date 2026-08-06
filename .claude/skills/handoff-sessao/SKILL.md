---
name: handoff-sessao
description: >-
  Gera o BRIEFING DETERMINÍSTICO pra continuar um trabalho em SESSÃO NOVA (split de sessão)
  neste repo (Afiação/Colacor). Use quando: (a) a sessão atinge o 2º compact (regra do
  CLAUDE.md — propor o split em vez de seguir degradando); (b) o Lucas pergunta como
  continuar/retomar isso em outra sessão ("como coloco na nova sessão?", "puxa isso pra outra
  conversa"); (c) um épico multi-PR vai claramente passar de uma sessão. Por quê: sessões-épico
  pagam caro por compacts em série (14 compacts numa; degradação medida: regressão de idioma,
  releituras, estado perdido) — enquanto a sessão mais eficiente auditada foi curta, de escopo
  único, com handoff de entrada e 0 compacts. NÃO use /context-restore como substituto (com
  várias sessões vivas ele pode restaurar o save de OUTRA sessão). NÃO use para fechar sessão
  sem continuação (use /fecho).
---

# /handoff-sessao — split com briefing determinístico

## Princípio: 1 entrega = 1 sessão

O briefing carrega **estado, não história**: o que a sessão nova precisa pra produzir a PRÓXIMA
entrega, e nada do caminho que levou até aqui. Tudo verificável por comando (a sessão nova
confere em vez de confiar).

## Quando propor o split (gatilhos objetivos)

- **2º compact da mesma sessão** → proponha o split junto com o compact ("em vez de compactar
  de novo, fecho esta fatia e gero o handoff da próxima?").
- Roadmap da sessão tem ≥2 entregas independentes pela frente.
- A próxima fatia muda de domínio (ex.: terminou o banco, começa a UI).

## O briefing — 7 blocos obrigatórios

Monte com evidência fresca (rode os comandos, não cite de memória):

```markdown
# Handoff — <tema da próxima fatia>

## 1. Objetivo desta sessão (UMA entrega)
<frase única e verificável — "entregar X mergeado + validado". Escopo além disso = outra sessão.>

## 2. Estado na main (verificado agora)
- origin/main: <sha curto> — PRs relevantes já mergeados: #A (<o que fez>), #B…
- `git log --oneline -5 origin/main -- <paths do domínio>`

## 3. Arquivos/funções-chave (caminhos exatos)
- <src/... / supabase/... / docs/agent/...> — <1 linha: papel no trabalho>
- Docs de domínio a ler ANTES: docs/agent/<X>.md §<seção>

## 4. Decisões já tomadas (NÃO re-litigar)
- <decisão> — por quê (parecer Codex se houve). Reverter exige dizer explicitamente que reverte.

## 5. Validações a rodar (a prova da entrega)
- <heavy bun run test …> · <psql-ro: query> · <prove-sql / paridade / canária se money-path>

## 6. Pendências do founder (se houver)
- 🟣 SQL Editor: <migration pendente> · 💬 chat Lovable: <edge> · 🖱️ Publish

## 7. Abertura da sessão nova
- `bun run wt <branch-novo>` (NUNCA reusar o worktree de sessão viva)
- 1ª mensagem: colar este briefing inteiro.
```

## Onde persistir (na ordem de preferência)

1. **Corpo do PR** da fatia atual (se existe PR — o briefing vira a seção "Próxima fatia").
2. **Arquivo no worktree NOVO** (`HANDOFF.md` na raiz — o `bun run wt` cria o worktree; escreva
   o arquivo lá ANTES de fechar esta sessão).
3. Chip (spawn_task) com o briefing no prompt — quando a próxima fatia é bem pequena.

**NUNCA** arquivo compartilhado de roadmap no repo (ímã de conflito entre worktrees — CLAUDE.md).

## Fecho do split

Depois de entregar o briefing: rode o **/fecho** da sessão atual (PRs/migrations/chips/wt:status)
— o split não dispensa o ritual de fechamento.
