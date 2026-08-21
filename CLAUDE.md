# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Manual de **regras VIVAS** para agentes de código. O detalhe operacional de cada domínio vive em `docs/agent/*` (índice abaixo, carregado sob demanda); o **diário de PR** em `docs/historico/`; spec/plano profundo em `docs/superpowers/{specs,plans}/`.
> **Política (mantenha enxuto):** só **REGRA/invariante que vale sempre** fica aqui. Histórico → `docs/historico/`; lição de domínio → `docs/agent/`; pendência em voo → PR/issue. Ao concluir uma entrega, registre em `docs/historico/` (ou no doc/agent se for lição nova) — **não engorde este arquivo**. O CI vigia o tamanho (`bun run claude:size` — teto apertado; estourar = mover para `docs/`).

## Preferências do founder (Lucas)

- **🗣️ Idioma:** responda SEMPRE em **português brasileiro** — nesta e em QUALQUER sessão nova ou subagente spawnado. Código/rotas/commits/PRs já são pt-BR.
- **🪟 Contexto:** em sessões longas, **sugira `/compact foco: <próximo passo>` proativamente** (compact sem foco preserva mal; não há auto-compact por %). **No 2º compact da MESMA sessão → proponha split com `/handoff-sessao`** (1 entrega = 1 sessão). Subagentes têm janela própria.
- **🧭 Roadmap:** mantenha um **roadmap vivo no CHAT** (✅ feito · 🔄 andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado · 🧭 aguardando decisão) e re-renderize quando mudar — é como o founder acompanha. **NÃO** criar arquivo compartilhado de roadmap (vira ímã de conflito entre worktrees); se precisar persistir, no worktree da sessão ou no corpo do PR.
- **🗑️ Fecho de sessão:** quando o Lucas perguntar se pode **excluir/apagar a sessão** (qualquer fraseado) → **invoque a skill `/fecho`** (checklist com EVIDÊNCIA: PRs mergeados de verdade · migrations aplicadas via psql-ro · edges/Publish · chips com título exato · resumo padrão · `wt:status` + ofertas de limpeza).
- **🤝 2ª opinião (Codex):** em decisão de arquitetura/metodologia/trade-off não-óbvio — e SEMPRE no money-path — eu proponho e conduzo o ritual `/codex` eu mesmo, sem o founder copiar/colar. **Transporte: `scripts/codex-async.sh` em background** (preflight+retry — NUNCA `codex exec` cru em foreground segurando a sessão). Detalhe em `docs/agent/money-path.md`.
- **💻 Comando pro seu terminal:** entregue sempre com `cd <path do worktree>` ANTES — o terminal do founder não fica no worktree (sem o `cd` → "fatal: not a git repository").
- **🎫 Chip ao criar (`spawn_task`):** anuncie no chat o **título exato** + que **quem clica é o founder** — senão o rastreio se perde depois ("não sei qual é este chip").
- **🔐 Segredo nunca em texto plano no chat** (secret/token/`decrypted_secret`) — a transcrição persiste em disco; use placeholder e o Supabase secrets.

## Índice — `docs/agent/` (referência operacional, LEIA o doc ANTES de tocar o domínio)

| Domínio | Doc |
|---|---|
| banco · migration · RLS · **acesso read-only** · PostgREST | [database.md](docs/agent/database.md) |
| deploy Lovable (3 camadas manuais, verificação) | [deploy.md](docs/agent/deploy.md) |
| sync · cron · Sentinela · assinaturas de incidente | [sync.md](docs/agent/sync.md) |
| **money-path** (precisão>recall, prove-sql, Codex/Caminho B) | [money-path.md](docs/agent/money-path.md) |
| financeiro (engines A1-A4/DRE/funding, data de baixa/DSO-DPO) | [financeiro.md](docs/agent/financeiro.md) |
| reposição/compras (motor, cmc-first, portal Sayerlack) | [reposicao.md](docs/agent/reposicao.md) |
| base de conhecimento (boletim↔SKU, versionamento) | [knowledge-base.md](docs/agent/knowledge-base.md) |
| tintométrico (fórmula↔receita, preço fail-closed, import) | [tintometrico.md](docs/agent/tintometrico.md) |
| lente "Ver como" (impersonação, write-guard) | [impersonation.md](docs/agent/impersonation.md) |
| telefonia (WebRTC, SIP, LGPD) | [telefonia.md](docs/agent/telefonia.md) |
| skills & MCPs (roteamento canônico) | [skills.md](docs/agent/skills.md) |
| **mapa do app** ("onde faço X" · rotas/gates · **3 empresas** · princípios) | [mapa-do-app.md](docs/agent/mapa-do-app.md) |
| worktrees · multi-sessão · RAM/Node · `heavy` | [worktrees.md](docs/agent/worktrees.md) |

Diário de PR/entregas: `docs/historico/` (`bugs-resolvidos.md`, `programas-vendas.md`, `auditoria-ux-redesign.md`, `estoque-picking-recebimento.md`). Runbook passo-a-passo de banco/deploy: `docs/runbooks/lovable-supabase.md`.

## ⚠️ Armadilhas recorrentes (caras — a maioria money-path/banco; detalhe no doc/agent indicado)

- **Lovable = 3 deploys MANUAIS** (Publish frontend · edge pelo chat · migration no SQL Editor) — **merge na `main` ≠ produção**. Migration custom **não** auto-aplica (falha SILENCIOSA). **Nunca** mexer em `supabase/migrations/` (snapshot é a fonte de DR). → `deploy.md`/`database.md`
- **Acesso ao banco:** **leitura/diagnóstico EU rodo direto** via `~/.config/afiacao/psql-ro` (role `claude_ro`, read-only blindado — confiro migration aplicada/frescor/`pg_get_functiondef`/`net._http_response` sem o founder). **Escrita** só via SQL Editor do Lovable (founder cola). → `database.md` §1
- **Sync bidirecional do Lovable pode REVERTER a main:** commit "Changes" empurra o workspace VELHO por cima de arquivo recém-mergeado (#1445→#1478: 3 deploys "verbatim da main" saíram da main JÁ revertida). Após merge que toca `supabase/functions/`, **confira `git log -S <símbolo-novo>` do arquivo** antes de pedir o deploy; se um "Changes" atropelou, restaure por PR. → `deploy.md`
- **PL/pgSQL é late-bound:** `CREATE` passa, a função só falha em RUNTIME → **teste EXECUTANDO** (PG17 `db/test-*.sh` / skill `prove-sql-money-path`), nunca só criando. → `money-path.md`
- **`CREATE OR REPLACE` função/view:** pré-flight `pg_get_functiondef`/`pg_get_viewdef` da PROD (apply manual diverge do repo); a última a recriar **vence**. VIEW só ACRESCENTA coluna no fim. **Repita o `WITH (security_invoker=on)` em TODO replace** — omitir RESETA a opção → a view lê como OWNER e **bypassa RLS** (falha ABERTA que o CI não vê); mas `off` **também é DESENHO** (view-gate `selfservice_*`) — ligar `on` ZERA o customer. **`DROP FUNCTION`+`CREATE` RESETA o ACL** (`REPLACE` preserva) → reemita o `REVOKE` **nomeando as roles**; reescrita por `regexp_replace` é invisível como definição (Parte D do `authz:check`). → `database.md` §4
- **Cron `net.http_post` precisa de `timeout_milliseconds` explícito** (default 5s mata silencioso; `cron.job_run_details=succeeded` só prova o ENQUEUE — a verdade HTTP está em `net._http_response`). `_data_health_compute`+`data_health_watchdog`+`fin_sync_heartbeat` são um conjunto ACOPLADO. → `sync.md`
- **PostgREST:** capa em 1.000 linhas silencioso, **inclusive `.rpc()`** (`.range()` + `.order` estável). **`.or()` quebra em UPDATE** (42703 mesmo a coluna existindo) → RPC SQL-pura; negação é **NULL-blind**. **Nunca** interpolar input em `.or()` cru (ESLint `no-restricted-syntax` barra — usar helpers `@/lib/postgrest`). → `database.md`
- **Supabase RLS:** `REVOKE FROM PUBLIC` **NÃO** tira `anon`/`authenticated` (grant explícito — revogar por nome); SECURITY DEFINER bypassa RLS (gate na fronteira). Tabela nova **sempre** com RLS. → `database.md`
- **Money-path: ausente ≠ zero** (`Number(null)===0` é fabricação) → degradar para `null`/baixa-confiança, **nunca** fabricar número. Sinal money-path **nunca** em coluna jsonb multi-writer (upsert destrutivo) → coluna dedicada + 1 writer. → `money-path.md`
- **Cliente do grupo = 2 cadastros Omie LEGÍTIMOS** (Colacor SC + Oben, CNPJs distintos por vantagem fiscal): os users `@placeholder.local` **sem `profiles`** são **aliases fiscais**, NÃO lixo de import → **nunca deleção ad-hoc** de `auth.users` (o CASCADE cobre só 14 tabelas). Mas **canonicalizar** o histórico é decisão legítima de produto (≠ deleção). Discriminante = **ausência de `profiles`**. Já redescoberto 2×. → `database.md` §5
- **Omie:** não confiar em `total_de_paginas` (paginar até página vazia + guard); enumeração pesada (~10k+) → bulk + `waitUntil` + retry, nunca N+1; após corrigir a FONTE, re-invocar o recompute (snapshots derivados não se regeneram). → `reposicao.md`/`sync.md`
- **Lente "Ver como":** `useAuth()` é SEMPRE real (escrita/identidade/RLS); só LEITURA usa `display*`/`effectiveUserId`. WebRTC fura o write-guard → gatear na fonte. → `impersonation.md`
- **Multi-sessão (worktrees paralelas):** coordene antes de tocar arquivo/função QUENTE — o "como" e o isolamento ficam na §Multi-sessão ao fim. → `worktrees.md`
- **Teste SQL negativo** com `WHEN OTHERS THEN 'OK'` é teatro → capturar a SQLSTATE esperada + re-lançar o resto + **falsificar** (sabotar e exigir vermelho); RLS prova-se sob `SET ROLE authenticated` + GUC. **Falsificar em UM ambiente não prova a asserção** (#1483, locale) → rode nos DOIS (`LC_ALL=C` **e** `pt_BR.UTF-8`) e case string **ASCII, caixa fixa, sem `-i`**. E **COMMITE antes de falsificar** — `restaurar()` costuma ser `git checkout --`. → `money-path.md`
- **Validação só conta com EVIDÊNCIA POSITIVA** — rode o comando autoritativo, confirme que **terminou** e capture `exit 0`. Ausência de sinal NÃO é aprovação: processo enfileirado, log sem linha de conclusão, `grep` sem ocorrência (**confira caixa/acento antes de concluir "não existe"**) e linter que não tem a regra são **ausência de dado**. Armadilhas de shell: `cmd | tail` **ENGOLE o exit code** (`> log 2>&1; e=$?`); `$?` mede o ÚLTIMO comando — um `echo`/`cat` no meio já sobrescreve: capture colado (saída VAZIA de job "verde" = não rodou); no zsh `echo "$json" | jq` **corrompe o JSON** (sempre `printf '%s' "$x" | jq`); o `grep` daqui é shim p/ `ugrep`, que dobra acento em TODO locale (`command grep` ao reproduzir); e **log em `/tmp` não atravessa PAUSA** — `/private/tmp` (o scratchpad da sessão inclusive) morre no reboot, então log ausente depois de pausa longa não distingue "não rodou" de "foi limpo" (desfecho de PR: `gh pr view`, nunca o log do watcher); e **flag homônima entre BSD e GNU não FALHA — faz OUTRA coisa** (`stat -f` é formato no macOS e `--file-system` no Linux, que ainda cospe 5 linhas no stdout ANTES de sair !=0, então `a || b` concatena lixo) ⇒ valide o **FORMATO esperado**, não o exit do 1º ramo, e teste os DOIS contratos por stub. → `worktrees.md`, `deploy.md`
- **Gate textual limpa comentário com o stripper COMPARTILHADO** (`removerComentarios` de `@/lib/gates/limpeza-fonte`, que entende string/template/regex) — **nunca** `replace(/\/\*[\s\S]*?\*\//g,'')` local: regex não sabe o que é string, e um `/*` dentro de string (o `*/*` do header `Accept`) pareia com o `*/` seguinte e apaga o miolo do arquivo ANTES da medição — 85% de uma edge ficou invisível, verde por CEGUEIRA. Gate novo herda o sentinela do maior bloco contíguo descartado. → `docs/historico/gates-textuais-cegos.md`
- **Corte por ranking: o teto é o EIXO, não o tamanho.** `ORDER BY x DESC LIMIT n` só é seguro se `x` for o MESMO eixo da decisão que a tela serve — quando não é, aumentar `n` não corrige, só adia. O seletor de cidades do roteirizador ranqueia por volume de prospects e corta em 500: **52,7% do faturamento** e **19 das 24 cidades do roteiro semanal oficial** (`route_schedule`, no mesmo banco) ficam fora — e nem o teto do SQL (2.000) alcança a cauda. Corrija por **UNIÃO com a fonte que conhece a decisão** (carteira/roteiro), nunca por limite maior. Corte deliberado e revisado **não** é corte inócuo. → `docs/historico/roteirizador-corte-cidades.md`
- **Fase N+1 exige SINAL da fase N** (a de PRODUTO da regra acima): exija ≥1 sinal POSITIVO de uso em prod **com denominador** — "no ar e ninguém reclamou" é ausência de dado; zero sem denominador não julga desenho (o `Number(null)===0` da adoção). Superfície de uso nasce **com o sensor**; sem sensor, a fase N+1 é instalá-lo. "Quando medir" é **query**, não recado. 3× no repo → `docs/historico/fase-sem-sinal.md`
- **Edge tem 3 gates no CI e nenhum cobre o outro:** `test:edges` (suíte Deno, `--no-remote` ⇒ teste de edge **não pode ter import remoto** — extraia a lógica PURA, **nunca afrouxe o flag**: jsr.io na entrega de TODO PR); `edges:typecheck` (a Deno **NÃO** type-checa); e o **vitest**, que vigia a FORMA da edge lendo-a como TEXTO ⇒ refactor sintático reprova no `bun run test`. → `docs/historico/ci-testes-edge-deno.md`
- **Fallback por lista VAZIA troca o ESCOPO — o comentário diz a intenção, a condição diz outra coisa.** `if (!x.length) recarregue SEM filtro` faz do desfecho mais destrutivo o *default de uma falha*: o rótulo dizia "for super_admin", mas só se perguntava se a leitura veio vazia. Nos 2 motores do Farmer gravou **2.676** recomendações sob `farmer_id` que não era o dono (abril: 25,9% dos clientes eram do gravador, que detém 18,8% da base — a assinatura do acaso). Degrade para vazio, e gateie no SERVIDOR. **ERRCODE novo: confira se já está tomado** — SQLSTATE repetida é indistinguível pra quem trata, inclusive pro seu teste. → `docs/historico/fallback-lista-vazia-troca-escopo.md`
- **Manifesto de módulos:** arquivo NOVO em `src/` precisa de dono em `src/lib/modulos/manifesto.ts` (`codigo`/`testes`) — senão `manifesto.gate` falha no CI (órfão, falha SÓ no CI, não no typecheck/lint local). Teste que importa código de OUTRO módulo (ex.: `.test` sob glob de `plataforma` importando `loja-afiacao`) = vazamento de fronteira → co-localize fonte+teste no MESMO módulo, não registre na baseline. → `docs/historico/modularizacao.md`

## Merge (auto)

Todo PR não-draft **auto-mergeia (squash) quando o CI `validate` passa** (`.github/workflows/auto-merge.yml`, zero clique do founder). Para **segurar** um PR, deixe-o **DRAFT**. Nunca `gh pr merge --admin` de rotina. **Ao criar/atualizar PR: arme `scripts/pr-watch.sh <nº>` em background** e, no desfecho, avise via PushNotification. **Exit 6 ≠ 5:** 5 = consultei e segue sem desfecho; **6 = NÃO consegui consultar** → confirme com `gh pr view <nº>` **antes** de avisar. A janela conta **vigília**, não relógio de parede. Exit codes: cabeçalho do `scripts/pr-watch.sh`.

## Stack

React 18 + TS 5.8 (**strict**) + Vite 5 + react-router 6 (lazy). Estado: `@tanstack/react-query` (`staleTime 60s`, sem refetch-on-focus, `retry 2`). UI: shadcn/ui sobre Radix; Tailwind 3 + tokens v3 em `src/index.css`. Tipografia Geist/Newsreader. Forms: react-hook-form + zod. Backend: **Supabase** (prod ref `fzvklzpomgnyikkfkzai`). Analytics PostHog (via `track()` de `@/lib/analytics`). PWA Workbox (offline-first picking/recebimento + fila de mutação). Toasts: **`sonner`** (único — `import { toast } from 'sonner'`). Cmd-K global ativo. Host: Lovable Cloud.

### Scripts

```bash
bun dev · bun build · bun lint
bun run test        # vitest — CANÔNICO (é o que o CI roda); bun test (runner nativo) ≠ disto
bun run typecheck   # tsc --noEmit -p tsconfig.app.json (strict). NÃO usar tsc cru (no-op: root tem files:[])
heavy bun run test  # 'heavy' = semáforo de RAM (M2 8GB); prefixe test/build/typecheck/vitest
```

Health stack (`/health`): typecheck · lint · test · `bunx knip` (deadcode) · `shellcheck scripts/*.sh .claude/hooks/*.sh`. Worktree novo: `bun install` antes.

## Design System (v3 — "fintech premium": Vercel/Mercury/Stripe Dashboard)

Tokens em `src/index.css` (paleta quase-neutra low-fatigue; `--status-*` dessaturadas; radius 6px; motion easing Vercel; dark via `next-themes`; `density-compact` global). Direção, benchmarks (pattern nominal, nunca skin) e anti-referências: `docs/visual-direction/`. **Convenções de código novo:**

- Status colors: `text-status-success/warning/error/info` — **não** `text-emerald-600`/`text-red-600`.
- Filtros de lista: `useUrlState` — não `useState`. Listas grandes: `useInfiniteScroll` + `useInfiniteQuery`.
- Atalhos: `useRegisterShortcuts` (dialog `?` auto-descobre); Cmd-K: `useRegisterCommands` — não listener `keydown` solto.
- Toast: só `sonner`. Skeleton: `<PageSkeleton variant>` — não `<Loader2 spin>` de página inteira. Empty: `<EmptyState tone="operational">`.
- Touch: `<Button size="touch">` (44px) / `balcao` (56px); `pointer:coarse` já dá ≥44px global.
- Ação global (sincronizar/importar/recalcular/gerar): `useMutationComRegistro` + `<UltimaExecucao acao>` (`src/components/execucoes/`) — não `useMutation` cru; edge single-shot com cron registra server-side (`_shared/registro-execucao.ts`). **1 escritor por slug**; ação sobre UM registro: estado no próprio registro.
- Heading hero: `font-display` (Newsreader). Analytics: `track()` com `<area>.<action>` — não `posthog` direto.

## Auth & roles

`AppRole = 'employee' | 'customer' | 'master'`; `isStaff = isAdmin || isEmployee || isMaster` — tudo via **`useAuth()`** (não recriar; `useUserRole` foi consolidado nele). **Fail-closed:** query de role/approval falha → role `null`, approval `false`. Customers precisam de `is_approved`; staff é auto-aprovado. `commercial_roles` (gestor/vendedor) é paralelo ao role principal. Restrição sales-only por CPF: `useSalesOnlyRestriction`. As 5 personas operacionais (separador/conferente/comprador/vendedor externo/gestão) são **recortes de acesso**, não roles novos.

## Convenções de código

Pages PascalCase; hooks `useX` camelCase; rotas **e** código em **pt-BR** (`/recebimento`, `agruparPorMes`); imports absolutos `@/`; tabelas Supabase `snake_case` PT. **LLM em edge:** código novo → Anthropic direto (`ANTHROPIC_API_KEY` + `claude-sonnet-4-6` + prompt caching + forced tool-use + gate `authorizeCronOrStaff`); legado usa o gateway Lovable/Gemini. Roteamento de skills (qual usar por tarefa): `docs/agent/skills.md`.

## gstack (REQUIRED)

Obrigatório para o trabalho assistido. O hook [`check-gstack.sh`](.claude/hooks/check-gstack.sh) **bloqueia o uso de skills** se faltar — com as instruções de instalação no próprio bloqueio. Não contornar. Web browsing → sempre `/browse`.

## Multi-sessão (regra — detalhe em `docs/agent/worktrees.md`)

**Uma sessão Claude por working tree.** NUNCA 2 sessões no diretório principal — o branch-flip vaza entre elas (risco de perda). Worktrees isolam (`bun run wt <branch>`). **Antes de tocar arquivo/função QUENTE:** conferir `origin/main` + `gh pr list` + migrations paralelas — **e RE-conferir imediatamente antes do `gh pr create`** (o auto-merge fecha PR em minutos; um já viveu 6min = 26 arquivos de retrabalho). **Conflito de ARQUIVO é só UM eixo:** a tarefa pode já estar ENTREGUE na main sem colidir com arquivo seu — antes de implementar **e** antes de entregar, procure o ARTEFATO com `git fetch && git grep <símbolo> origin/main`; busca por TÍTULO de PR é CEGA a isso. **Sincronize antes de MEDIR.** Higiene de RAM/Node na M2 8GB: `wt:status`/`wt:clean`/`wt:reap`/`wt:prune`.
