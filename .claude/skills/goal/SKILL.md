---
name: goal
description: Use quando o Lucas falar de um objetivo multi-sessão — "continua o goal", "qual o status do goal?", "cria um goal pra isso", "vamos fazer tudo até o final", "retoma o épico" — ou quando uma entrega claramente vai atravessar várias sessões/PRs. NÃO use para tarefa que cabe numa sessão (roadmap no chat basta), para fechar sessão (/fecho) nem para gerar briefing de continuação de contexto (/handoff-sessao — os dois se complementam).
---

# /goal — objetivo multi-sessão rastreável

## Por que esta skill existe

O repo trabalha com "1 entrega = 1 sessão" e ~30 worktrees paralelas, mas objetivos grandes (épicos) atravessam sessões — e **roadmap em arquivo compartilhado é PROIBIDO** pelo CLAUDE.md (ímã de conflito entre worktrees). Sem um lar canônico, cada sessão nova re-deriva o estado do histórico geral e **erra**: no teste-base desta skill, uma sessão sem ela encontrou o goal mas listou como "fases do goal" entregas de PRs antigos do domínio, e não recuperou as fases pendentes. O estado vivo de um goal mora no **GitHub**, nunca em arquivo do repo.

## Onde um goal mora (nesta ordem)

1. **Preferido: issue** com label `goal`, título `GOAL: <objetivo>`. Corpo: objetivo em 1 frase + motivação com evidência + **checklist de fases** (`- [ ] F1 — …`) + invariantes (money-path: o que nunca regredir) + log de sessões.
2. **Fallback:** sessão não-interativa pode ter `gh issue create` **negado por permissão** (aconteceu na sessão que criou esta skill — não insista). Nesse caso o corpo do **PR da 1ª fase** carrega a mesma estrutura numa seção `## 🧭 GOAL: …`. Na primeira oportunidade em sessão interativa, migrar para issue e linkar os PRs.

## Descobrir (status / retomar)

```bash
gh issue list --label goal --state open                            # 1º: issues-goal vivas
gh pr list --search "GOAL in:title,body" --state all --limit 10    # 2º: fallback em PRs
gh issue view <n> --comments        # ou: gh pr view <n> --json body,comments,state
```

**O checklist de fases do goal é a fonte ÚNICA do estado.** Não infira fases de `docs/historico/` nem do git log — o diário conta a história do DOMÍNIO inteiro, não deste goal. Próxima ação = primeira fase desmarcada; leia também os comentários (avanço pós-corpo é registrado lá).

## Avançar (ao concluir uma fase)

1. **Evidência antes do checkbox** — fase só vira `[x]` com o critério dela CUMPRIDO: PR **mergeado de verdade** (`gh pr view`), migration **aplicada** (validada via `psql-ro`), deploy **verificado**. Checkbox sem evidência é o mesmo bug do "diagnosticado ≠ corrigido".
2. Atualizar no GitHub: `gh issue edit`/comentário com a evidência (nº do PR, query de validação e resultado). No fallback-PR: comentar no PR.
3. Fase nova descoberta no meio do caminho vira **checkbox novo** — nunca escopo invisível.

## Criar um goal novo

- **Antes de criar, procure um igual** (comandos acima). Goal duplicado = dois estados divergentes; se existe, retome-o.
- Fases = entregas **PR-áveis pequenas** (padrão do repo), cada uma com dono explícito — deploys manuais do Lovable são **fase do founder**, escrita como tal.
- Money-path → seção **Invariantes** obrigatória (ex.: "varredura nunca escreve no Omie").

## Armadilhas

| Armadilha | Realidade |
|---|---|
| "Vou criar um `ROADMAP.md`" | Proibido pelo CLAUDE.md. Chat mostra o roadmap vivo; GitHub guarda o estado. |
| "O PR está aberto, marco a fase" | PR aberto ≠ mergeado; migration entregue ≠ aplicada. Evidência primeiro. |
| "Reconstruo o estado pelo histórico" | O diário é do domínio, não do goal — foi exatamente o erro do teste-base. |
| "`gh issue create` falhou, tento de outro jeito" | Permissão negada não se contorna: use o fallback-PR. |
