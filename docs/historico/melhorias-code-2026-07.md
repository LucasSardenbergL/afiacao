# Melhorias no setup Claude Code — diagnóstico (09/jun → 06/jul/2026)

> **Status: candidatos 1–9 EXECUTADOS em 2026-07-06** (grupos aprovados pelo founder; 10–12 e micro-correções ficam pra 2ª leva). Diário da execução: [setup-agente.md](setup-agente.md). Diagnóstico gerado em 2026-07-06 (modelo Fable 5) a partir de **240 sessões-mãe** (880MB de transcrições, +394 transcrições de subagentes) em 214 worktrees + diretório principal.
> **Método:** corpus destilado via jq (4.633 mensagens suas + 2.397 erros de ferramenta) analisado por 8 subagentes em paralelo — 4 deep-dives nas 21 maiores sessões, 3 leituras integrais da sua voz por janela cronológica, 1 taxonomia de erros — cruzado com inventário completo do setup atual (126 skills globais, 10 de projeto, 5 hooks, settings, claude-mem).
> **Classificação por grupo:** `SKILL NOVA` · `AUTOMAÇÃO` · `CORREÇÃO` · `NADA` (manter). Ordenado por impacto (frequência × custo por evento × alcance).

---

## Números do período

| Métrica | Valor |
|---|---|
| Sessões-mãe / ritmo | 240 em ~28 dias (~8/dia, pico ~24-30/dia em 15-16/jun e 23/jun) |
| Mensagens suas | 4.633 — das quais **~450 são só "Retome/Continue/pode seguir"** (na janela 16-26/jun: 16% de tudo que você digitou) |
| Ritual "posso excluir a sessão?" | ~160 mensagens, presente em 75-90% das sessões |
| `/compact` · `/model` | 108 · 33 usos (compact: ~100% reativo, após o estouro) |
| Erros de ferramenta | 2.397 — **65% é uma única classe** (classificador de permissões indisponível) |
| Codex | ~350+ invocações só nas 21 sessões auditadas a fundo, quase todas em foreground (timeouts de 600-1380s) |
| Colagens manuais suas | Centenas (resultado SQL, confirmação de deploy, "fiz o publish") — a classe de mensagem mais volumosa do corpus |
| claude-mem | 331 sessões rastreadas, 5.000 prompts capturados, **0 observações e 0 resumos gerados** (402MB + 2 processos por zero valor) |

---

## Candidatos, por impacto

### 1. Allowlist de permissões + heavy-guard alinhado — `CORREÇÃO` (config + hook) · esforço S · **a fricção nº 1**

**Evidência:** 1.561 dos 2.397 erros (65%) são "claude-opus-4-8 temporarily unavailable, cannot determine safety of Bash/Agent/Skill" — em **117 sessões distintas, 21 dias diferentes** (não é incidente pontual). Pior sessão: 73 falhas ([admiring-diffie, 06/07]); na onda de 05/07, 3 sessões travadas ao mesmo tempo; você trocou `/model` 4× tentando destravar e perguntou "o que é esse bash e como podemos fazer ele estabilizar?". Uma sessão terminou **sem a prova de deploy** por causa disso. Causa estrutural: a allowlist do projeto tem **só 5 regras Bash**, então praticamente todo comando (git, gh, ls, psql-ro, wt:*) consulta o classificador remoto — quando o modelo cai, tudo trava. Este diagnóstico foi atingido pelo mesmo problema 3× na primeira hora.
**Agravante descoberto:** allowlist e heavy-guard estão em **contradição** — ela permite `bun run test*` (que o hook NEGA) e não permite `heavy bun run test*` (que o hook EXIGE) → 58 negações em 48 sessões + o comando corrigido cai no classificador. E Grep/Glob nativos estão ausentes do harness (88 erros "No such tool available"; cada `grep` via Bash cai… no classificador — fricção composta).
**Proposta:** (a) rodar a skill `fewer-permission-prompts` (existe, nunca foi usada) e curar allowlist read-only: `git status/log/diff/show/fetch`, `gh pr view/checks/list`, `ls/rg/wc/jq`, `~/.config/afiacao/psql-ro`, `bun run wt:*`, `bun install`; (b) heavy-guard passa a **reescrever** o comando (`updatedInput`: `bun run test` → `heavy bun run test`) em vez de negar + allowlist estreita das formas com `heavy`; (c) investigar por que Grep/Glob sumiram (não estão nos settings — provável versão/modo do app) e, se irreversível, allowlistar `rg` como substituto oficial; (d) timeout 600000ms como padrão documentado para codex/typecheck/verify (35 mortes em 2min).
**Impacto estimado:** ~1.100-1.500 erros/mês evitados + sessões deixam de travar em dias de outage + parte dos ~450 "retome" desaparece.

### 2. Codex assíncrono com preflight de auth/quota — `CORREÇÃO` (skill/wrapper) · esforço M

**Evidência:** ~350+ invocações `codex exec` nas sessões auditadas, rodadas em **foreground** com timeouts de 600-1380s (23min!) — o Claude fica parado esperando, e você vira o "botão de retomar". 5+ execuções morreram no timeout de 2min (exit 143). Atrito de credencial no meio do fluxo: "Assinei, tente usar o codex novamente" [condescending-swirles]; um workflow de 6 agentes queimou **142k tokens devolvendo "Rate limited"** [sessão PostHog]. Bug menor: colisão de mktemp no wrapper (3×). O conteúdo do ritual é excelente (bloqueou overcount real de money-path) — o problema é só o transporte.
**Proposta:** no wrapper/skill `/codex`: (a) `run_in_background: true` como default para consultas longas, com o Claude seguindo trabalho paralelo e integrando o parecer ao voltar; (b) preflight de 2s (auth válida? quota disponível?) que falha com instrução clara ANTES de gastar contexto; (c) retry/backoff automático para transitórios (hoje você é acionado: "tente novamente" ~25 msgs); (d) fix do mktemp; (e) modo "arbitragem rápida" para decisões pequenas.
**Impacto:** ataca diretamente a maior classe de espera bloqueante — boa parte do "Retome-driven development" morre aqui.

### 3. Skill `/fecho` — ritual de fechamento de sessão — `SKILL NOVA` (projeto) · esforço M

**Evidência:** "posso excluir a sessão? / falta algo?" é **a pergunta mais frequente do corpus** (~160 msgs, 75-90% das sessões, às vezes 3× na mesma). O ritual já está no CLAUDE.md mas é re-executado ad-hoc, e falha por partes: auto-merge não verificado ("porque o 1148 nao foi feito a auto merge?" — 15+ ocorrências de PR órfão descoberto DEPOIS), publish esquecido, chips sem rastreio ("Não consegui identificar qual é este chip", 8 msgs), wt:status esquecido.
**Proposta:** skill `.claude/skills/fecho` disparada por "posso excluir/fechar a sessão": checklist determinístico — (1) PRs da sessão: mergeado/aguardando CI/conflito (com link), (2) migrations entregues × aplicadas (psql-ro), (3) edges deployadas?, (4) Publish feito/pendente, (5) chips abertos com título exato, (6) resumo de fecho padrão (problema→decisões→entregue→pendências suas), (7) `wt:status` + oferta de wt:clean/reap. Sai um bloco único "o que fica na sua mão".
**Impacto:** ~160 msgs/mês de ritual manual viram 1 comando + elimina a classe "PR órfão descoberto depois".

### 4. Handoff Lovable blindado (SQL que não quebra na sua mão) — `CORREÇÃO` (skills `lovable-db-operator` + `lovable-deploy-verify`) · esforço M · **money-path**

**Evidência:** ≥25 rodadas documentadas de SQL entregue → você cola → **erro em produção** → cola o erro de volta: `42703 column does not exist` (≥6×), `42601 syntax error`, `23505 duplicate key` (dado sujo de prod que o prove-sql local não pega — [great-williamson]), `42P01 relation does not exist` (ordem errada), `23502 NOT NULL`, SQL não-idempotente que falha na re-colada (`_preflight_tint` órfão). Cada erro = um round-trip humano inteiro. Além disso: confusão de destino ("o 3 eu colo onde?", JS/bash colado no SQL Editor 4×, placeholder `<PRECO_QUARTINHO>` não substituído) e prompt de deploy entregue **antes do merge** (Lovable lê da main: "função não existe no repositório").
**Proposta:** tornar obrigatório nas skills: (a) **preflight via psql-ro de todo SQL de handoff** (colunas/tabelas existem? UNIQUE tem duplicata pré-existente? já aplicado?) — em junho não existia psql-ro, hoje é grátis; (b) todo bloco 100% idempotente (re-colada segura); (c) **rótulo de destino na 1ª linha** de cada artefato (`→ SQL Editor` / `→ chat do Lovable` / `→ seu terminal`), zero placeholders; (d) sequência travada: merge → deploy-prompt → publish; (e) validação pós-apply que EU rodo via psql-ro (você só cola 1× — some o "cola o resultado de volta"); (f) fecho de entrega em **bloco único numerado** (1 SQL + 1 prompt de edge + 1 publish), não artefatos soltos pela conversa ("me de em ordem o que eu preciso fazer" ~22 msgs).
**Impacto:** menos erro em PRODUÇÃO (é money-path) + dezenas de round-trips seus eliminados/mês.

### 5. Watcher de PR/auto-merge com notificação proativa — `AUTOMAÇÃO` · esforço S-M

**Evidência:** você virou o poller do auto-merge em pelo menos 8 sessões: "Por que o 868 não deu merge ainda?", "faca o merge do 1193 e 1195 para continuarmos", "porque o merge do 1180 e 1186 nao foi feito?" + 12 ci-monitor-events de conflito que ninguém te avisou proativamente. A frustração é antiga e explícita: "Eu não quero que o cliquezinho fique na minha mão" [14/jun — que gerou o auto-merge.yml; sobrou o buraco da *visibilidade*].
**Proposta:** ao criar/atualizar PR, armar Monitor em background que acompanha `gh pr checks` e **PushNotification** no desfecho: "PR #X mergeado" / "PR #X: conflito — precisa de rebase" / "CI vermelho: <resumo>". Zero pergunta sua.
**Impacto:** fecha o último buraco do fluxo de merge; elimina a classe "descobri depois que não mergeou".

### 6. claude-mem: consertar ou remover — `CORREÇÃO` (config) · esforço M (investigação primeiro)

**Evidência (medida direta no SQLite):** 331 sessões rastreadas, 5.000 prompts capturados, **0 observations, 0 session_summaries** — o pipeline de geração de memória **nunca funcionou**, apesar de worker + Chroma rodando e 402MB em disco. Agravante estrutural: cada worktree é um `project` distinto (`afiacao/admiring-diffie-37ff73`…) — mesmo funcionando, a memória se fragmentaria em 214 silos. O custo da ausência é real e documentado: **2 priceGuards duplicados criados por sessões paralelas**, escapeHtml com 3 cópias, "eu pedi em outra sessão… acho que já excluí", regras de domínio re-ditadas (tabela de embalagens GL/QT/BH inteira por voz).
**Proposta:** decisão em duas etapas — (1) diagnosticar por que observations=0 (worker em modo errado? geração desabilitada? bug do plugin); (2) **ou** conserta (e configura project unificado `afiacao` para todos os worktrees) **ou** desinstala (recupera 402MB + 2 processos + hooks de SessionStart) e assume a memória que JÁ funciona: docs/agent + docs/historico + chips. Meio-termo ruim (rodando sem gerar nada) é o pior estado — é o atual.
**Impacto:** ou memória real entre sessões (mata duplicação de trabalho), ou -402MB/-2 processos numa M2 de 8GB sufocada.

### 7. Skill `handoff-sessao` — continuidade entre sessões — `SKILL NOVA` (ou seção CLAUDE.md + template) · esforço S-M

**Evidência:** o padrão já emergiu organicamente 3× — `P0C-BRIEFING.md` + clone dedicado [strange-ramanujan], plano em PR de doc #902 + chip [condescending-swirles], prompt-handoff determinístico com rejeição consciente do `/context-restore` ("com 9 sessões vivas, ele pode pegar o save de OUTRA sessão") [WhatsApp]. Mas é improvisado a cada vez, e você pergunta: "Como que eu coloco na nova sessão para podermos puxar e manter o que estávamos fazendo?". As sessões-épico pagam caro por não fazer isso: 14 compacts numa (radar RFB), 12 noutra (KB), com degradação medida pós-compact (204 erros "File has not been read yet", Claude voltando ao inglês, releituras).
**Proposta:** skill que gera o briefing determinístico (estado na main + docs relevantes + próximo passo + validações) e sugere o corte. Regra objetiva acoplada no CLAUDE.md: **"no 2º compact da mesma sessão, propor split com handoff"** + "1 entrega = 1 sessão" (a sessão mais eficiente das 21 auditadas foi exatamente assim: curta, escopo único, handoff de entrada, 0 compacts).
**Impacto:** menos compacts em série (cada um degrada estado), menos "retome", arcos longos viram cadeias de sessões limpas.

### 8. Dieta de contexto — `CORREÇÃO` (skill gstack + doc) · esforço S

**Evidência:** o preâmbulo da skill gstack (update-check, telemetria, vendoring) foi **re-injetado ~15× numa única sessão** (2.288 ocorrências de texto no transcript!) — puro lastro que acelera o estouro de contexto. `/compact` é 100% reativo (todos os 18 usos da janela central vieram DEPOIS do auto-summary "ran out of context") — a regra do CLAUDE.md de sugerir proativamente **não funciona na prática**. O uso dirigido (`/compact foco: retomar fatia 0c…`) apareceu ~10× e preserva muito mais.
**Proposta:** (a) enxugar o preâmbulo one-time das skills gstack mais chamadas (codex/browse); (b) documentar `/compact <foco>` como forma padrão; (c) guarda de idioma pt-BR pós-compact (1 linha no CLAUDE.md ou hook PreCompact injetando o lembrete — houve regressão ao inglês pós-compact).
**Impacto:** compacts mais tardios e menos destrutivos em TODA sessão longa.

### 9. Worktree pronto-para-uso + vigia de RAM — `AUTOMAÇÃO` (hooks) · esforço S

**Evidência:** worktree novo sem `node_modules` → typecheck "Cannot find module" → 3× `bun install` na mesma sessão + **falso alarme de CI** (dep de registry privado Lovable ausente ≠ CI vermelho — o CI real estava verde). RAM: swap 9,1GB/10GB com 8 sessões vivas, terminal quebrando por esgotamento (`forkpty: Device not configured`), typecheck morto por OOM (exit 137), e o dado-chave: `wt:clean` dry-run = **0MB liberáveis porque tudo pertence a sessões VIVAS** ("a alavanca real é fechar sessões" — e nenhum script atual ataca isso).
**Proposta:** (a) `bun install` automático na criação de worktree (ou hook SessionStart que detecta node_modules ausente e instala); (b) registrar em `worktrees.md` a assinatura "typecheck vermelho por dep `@lovable/*` ausente ≠ CI vermelho — confie no `gh pr checks`"; (c) SessionStart alertar quando swap > X GB ou sessões vivas > N: "considere fechar as sessões A/B (ociosas há 3 dias)".
**Impacto:** menos falso-vermelho + a M2 para de sufocar silenciosamente.

### 10. Skill `benchmark-externo` (artigo → gap-analysis → programa) — `SKILL NOVA` · esforço M

**Evidência:** é o seu **motor de origem de features** e se repete: 7+ sessões no padrão "link/PDF (Prosus, PEGN, Pernambucanas, Panrotas, Brazil Journal) → 'existe isso no nosso app?' → mapa de gaps → 'Vamos atacar todos' → programa multi-PR". Gerou 3 dos maiores programas do mês. Hoje cada rodada remonta o processo à mão (browse + varredura de módulos + priorização).
**Proposta:** skill que padroniza: fetch/browse do artigo → extração de práticas → varredura dos módulos do app (mapa de rotas) → tabela gap/tem-parcial/tem → priorização com Codex → programa em fases com PRs. Não muda o que você faz — tira o atrito de remontagem.
**Impacto:** alavanca ofensiva (velocidade de programa novo), não redução de dor.

### 11. Skills de negócio no mundo pós-psql-ro — `CORREÇÃO` (docs de skill) · esforço S

**Evidência:** `bi-colacor` e `cfo-colacor` ainda se descrevem como "MANUAL-ASSISTIDO / banco só acessível pelo SQL Editor" — mundo de 14/jun, antes do psql-ro. Resultado: pedido de margem média foi respondido com SQL ad-hoc sem skill [stoic-margulis]. O contraste mede o prêmio: sessões de junho = 0 usos de psql-ro (você colava tudo); julho = 84-88 usos/sessão. E ainda há resquício do mundo antigo: o Claude te pedindo `request_id`/status de cron que ele mesmo pode ler em `net._http_response`.
**Proposta:** atualizar as 2 skills (leitura roda direto; só escrita é manual); regra "nunca pedir ao founder o que o psql-ro responde"; despejar o léxico de domínio ditado por voz em `docs/agent/reposicao.md` (tabela de embalagens GL 3,6L/QT 900ml/BH 20L/LT 18L + bases, lead times por grupo, fornecedores especiais — hoje re-explicado a cada sessão); criar mapa de funcionalidades/rotas consultável ("Onde que eu faço isso mesmo? não me recordo onde" — 3+ sessões, inclusive feature que já existia e virou pedido de re-construção).
**Impacto:** menos re-explicação sua + BI volta a ter caminho padronizado.

### 12. verify-frontend rápido + QA visual via Chrome logado — `CORREÇÃO` (script + roteamento) · esforço M

**Evidência:** a prova-por-bytes do Publish enumera ~274 chunks via curl **sequencial** → 4 timeouts + 4 exit 143 numa sessão; browse headless "não renderiza essa SPA" (3 falhas) → o sanity-check visual volta pra você ("Não achei em nenhum lugar nessa tela os 5.1 milhões. Você quer entrar e ver sozinho?"). O caminho bom já foi provado: Claude-in-Chrome logado configurou o PostHog inteiro sozinho [sessão PostHog]; Chrome MCP no app teve timeouts CDP de 45s em outra.
**Proposta:** (a) paralelizar o verify (curl simultâneo + halt-on-hit) ou embutir build-id no index para prova O(1); (b) padrão de QA visual pós-Publish: Claude-in-Chrome com a sua sessão logada (você abre o app 1×, ele confere as telas) em vez de te devolver a verificação.
**Impacto:** o "está REALMENTE no ar?" deixa de depender do seu olho na maioria dos casos.
**✅ Entregue (2026-07-07):** (a) `verify-frontend.sh` varre em **paralelo** (`xargs -P 8` no crawl + halt-on-hit `exit 255` no grep do alvo) — o bundle já passou de 300 chunks (união medida 308–560); no mesmo bundle (308, sentinela ausente) **299s → 61s (~4,9×), mesmo exit code**; o sequencial estourava 600s (exit 124, nem terminava). Enumeração/UNIÃO **inalterada** (worker-por-arquivo, sem intercalação); rede de regressão local nova (`evals/verify-frontend-eval.sh` — 2º nível, precache, exit 0/1/2 + `--falsify`; entra no gate `evals/run.sh`). (b) Padrão de QA visual documentado no **Passo 4b** do SKILL.md (Claude-in-Chrome na sessão logada) + cross-ref em `docs/agent/deploy.md`. O caminho de build-id O(1) foi **descartado** (Lovable builda sem `.git` → `__BUILD_SHA__="dev"`; a sentinela continua obrigatória).

---

## Micro-correções (agrupadas — cada uma ≤ 30min quando autorizadas)

- **`cd` obrigatório em comando para o seu terminal** — 3× "fatal: not a git repository" porque o comando veio sem o cd do worktree. → 1 linha no CLAUDE.md.
- **Chips: anunciar título exato + quem clica** ao criar — 8 msgs de confusão de rastreio. → 1 linha no CLAUDE.md.
- **Segredos nunca em texto plano no chat** — você colou um `decrypted_secret` uma vez; transcrições persistem em disco. → 1 linha no CLAUDE.md (placeholder + Supabase secrets).
- **Receituário "CSV de governo BR"** — 6 versões de script DuckDB até acertar (CP1252, aspas, `parallel=false`); a próxima base pública (RAIS/CNO) redescobriria tudo. → nota em doc ou mini-skill.
- **Aliases de voz no CLAUDE.md** — o ditado vira "Kota/code/geminar/auto-munch/murder(merge)"; mapear os recorrentes ajuda qualquer sessão nova a decodificar de primeira.
- **Hook branch-pós-squash** — quase-acidente de re-commitar fatia já squash-mergeada ("a armadilha que já me mordeu"). → guard leve pré-commit se HEAD contém commits já mergeados na origin/main.

## O que já funciona — decisão: `NADA` (não mexer)

- **Guard-rails destrutivos/migration/heavy**: 28+ disparos auditados, **zero falso-positivo** — sistema imunológico saudável.
- **Fábrica de chips (spawn_task)**: openers técnicos de alta qualidade são o motor da esteira money-path (~50 sessões da janela central abriram assim).
- **Ritual Codex/triagem-3-modelos** (conteúdo): pegou bugs reais que teriam ido a produção (overcount de reposição, P2 frágil rejeitada). Só o *transporte* precisa do item 2.
- **Loop instrução→CLAUDE.md**: suas regras ditadas viram doc em 1-3 dias e param de reaparecer — comprovado na linha do tempo.
- **psql-ro**: o maior case de sucesso do setup (eliminou uma classe inteira de colagem manual) — e o argumento-modelo para os itens 4 e 11.
- **Scheduled tasks** (piloto Sayerlack) e **auto-merge.yml**: rodando sem você.

## Padrões observados sem ação recomendada (descartados)

- "File has not been read yet" (204×) e "modified since read" (41×): guard do harness, autocorrigido; mitigação real é o item 7 (menos compacts).
- Você como mãos-remotas do Windows da loja (fotos HEIC, sc start/stop): natureza do ambiente air-gapped; micro-melhoria já praticada (pacote .bat único auto-logado).
- GitHub API `dial tcp i/o timeout` (7×): transitório de rede; workaround com IP fixo já usado 1×; observar.
- Tools fantasma Grep/Glob chamadas pelo modelo: o erro já redireciona; resolve-se de vez no item 1c.
- Trocas de `/model` (33×): política implícita saudável (opus=execução, fable=revisão/auditoria) — só vale documentá-la se você quiser consistência entre sessões.

## Limitações do diagnóstico

- Erros **dentro** de subagentes não entraram na taxonomia (filtro de sidechain) — fricção de subagente está subcontada; os deep-dives cobrem parcialmente.
- Mensagens truncadas a 600 chars no corpus (pedidos longos = só o início); 21 sessões lidas a fundo, as demais 219 via sua voz + erros.
- Contagens por janela podem se sobrepor entre analistas (nunca somei cegamente entre relatórios; números totais vêm do corpus global).
- `titles.txt` (resumos de sessão) não existia nas transcrições — títulos inferidos do conteúdo.
