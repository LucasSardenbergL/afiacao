# Analytics — ler o PostHog de dentro de uma sessão de agente

> **Regra que este doc serve:** `docs/historico/fase-sem-sinal.md` — *fase N+1 exige ≥1 sinal
> POSITIVO de uso em prod, **com denominador**; "quando medir" é **query**, não recado.*
> Até 2026-08-23 essa regra era **incumprível** para todo sensor de frontend: o repo instalava
> `track()` que ninguém conseguia ler.

## 1. O buraco que existia (medido, PR #1900)

Ao tentar ler a série de `carteira.mixgap_visto`, as **quatro** vias de acesso foram testadas e
as quatro estavam fechadas:

| via | estado medido em 2026-08-22 |
|---|---|
| plugin/MCP PostHog | `"posthog@claude-plugins-official": false`; `ListPlugins` vazio |
| Personal API Key | inexistente — nem `.env`, nem env, nem `~/.config/afiacao/`, nem `~/.config/posthog` |
| navegador logado | `/browse` headless **e** Chrome real caem em `us.posthog.com/login` |
| espelho no banco | nenhuma tabela replica `carteira.*` (só `posthog_error_webhook_log`, do webhook de e-mail) |

**`VITE_POSTHOG_KEY` (`phc_…`) não serve**: é a chave PÚBLICA de **ingestão** — escreve evento,
não consulta. Confundir as duas é o erro mais fácil aqui, e o wrapper barra explicitamente.

## 2. A via escolhida: Personal API Key read-only + wrapper versionado

Optamos pela **Opção A** (key read-only) e não pelo plugin MCP porque: o escopo é **verificável e
mínimo** (só leitura, revogável em 1 clique), funciona **headless** (sessão não-interativa não roda
OAuth), e a lógica fica **versionada e testada** no repo em vez de num plugin opaco.

- **Segredo:** `~/.config/afiacao/posthog-ro`, `0600`, **fora do repo** — mesmo padrão do
  `claude_ro.pgpass`. O wrapper **recusa** permissão mais frouxa que `600`.
- **Wrapper:** [`scripts/posthog-query.sh`](../../scripts/posthog-query.sh) — versionado, `shellcheck`-limpo,
  com suíte hermética em `scripts/test-posthog-query.sh` (roda no `bun run test:hooks`).
- **Chame pelo caminho do repo** (`bash scripts/posthog-query.sh …`), de qualquer worktree com a
  main mergeada. Ao contrário do `psql-ro`, aqui **não** há atalho em `~/.config/afiacao/` — o
  porquê está no passo 3 da instalação.

### Instalar a key (só o founder faz — a key NUNCA passa pelo chat)

1. https://us.posthog.com/settings/user-api-keys → **New personal API key**.
2. Escopos **apenas de leitura** — na UI eles têm nome legível, e **não existe um escopo "Event"
   avulso** (medido em 2026-08-23; a lista traz *Event definition* e *Event filter*). O mínimo que
   faz o `/query/` funcionar é **Query → Read**; os outros só ampliam descoberta:

   | linha na UI | valor | para quê |
   |---|---|---|
   | **Query** | Read | **essencial** — é o escopo do endpoint `/query/` |
   | Insight | Read | ler insights salvos |
   | Event definition | Read | descobrir quais eventos existem de fato |
   | Property definition | Read | descobrir os nomes de propriedade de um evento |

   Todo o resto fica em **No access** — em especial *Session recording* e *Person*, que são os
   pesados em PII. Nenhum **Write**, em lugar nenhum.

   Em "Organization & project access", escolher **Projects** e marcar só o projeto do Afiação
   (`423408`) — não "All access".
3. Com a key ainda na área de transferência (o PostHog só a mostra **uma vez**), mande o clipboard
   direto pro arquivo. Assim o segredo não passa por `argv` (`ps`) nem pelo histórico do shell, e
   não depende de TTY:

```bash
mkdir -p ~/.config/afiacao && umask 077 && pbpaste > ~/.config/afiacao/posthog-ro && chmod 600 ~/.config/afiacao/posthog-ro && awk 'NR==1{print (/^phx_/ ? "OK: key phx_ com " length($0) " chars" : "PROBLEMA: o clipboard nao tem uma key phx_")}' ~/.config/afiacao/posthog-ro
```

   Se o clipboard já tiver sido perdido, o fallback é por prompt — **e note o dialeto**: a forma
   `read -rs "?prompt" var` é **só zsh**. Em bash ela falha (`?prompt` vira nome de variável), o
   `&&` interrompe a cadeia e **nenhum arquivo é criado** — falha silenciosa que já aconteceu aqui
   em 2026-08-23. A forma abaixo roda nos dois:

```bash
mkdir -p ~/.config/afiacao && umask 077 && printf 'Cole a key: ' && IFS= read -rs k && printf '%s\n' "$k" > ~/.config/afiacao/posthog-ro && unset k && chmod 600 ~/.config/afiacao/posthog-ro && printf '\n' && awk 'NR==1{print (/^phx_/ ? "OK: " length($0) " chars" : "PROBLEMA: nao comeca com phx_")}' ~/.config/afiacao/posthog-ro
```

   **Não** criar symlink `~/.config/afiacao/posthog-query` → checkout principal, como o `psql-ro`
   sugeriria. O `psql-ro` é auto-contido; este script vive no git, e o checkout principal passa a
   maior parte do tempo em branch de feature (medido em 2026-08-23: `claude/projeto-verificado-sayerlack`,
   com ~30 worktrees vivas). O link **dangla** sempre que a main não está lá, e falha com
   `No such file or directory` — que não parece problema de caminho.

   Chame pelo caminho do repo, de qualquer worktree que tenha a main mergeada:

```bash
bash scripts/posthog-query.sh "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY"
```

4. O id do projeto já está fixado em `~/.config/afiacao/posthog-project-id` (`423408`, lido da URL
   `us.posthog.com/project/423408/…` — não é segredo). Fixá-lo é o que torna a key **escopada a um
   projeto** segura de usar: sem ele o wrapper cai em `@current`, que resolve pelo `current_team` da
   conta e devolve **403** quando os dois divergem.

## 3. Uso

```bash
~/.config/afiacao/posthog-query "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 30 DAY"
```

Aceita HogQL por argumento **ou** stdin. Saída **compacta por padrão** —
`{"columns":[…],"results":[…],"row_count":N}` — porque o payload cru do PostHog traz
`clickhouse`/`hogql`/`explain`/`metadata` e queima contexto de sessão sem acrescentar dado. Use
`--cru` quando precisar do SQL gerado para depurar.

**Exit codes** (`0` é o único que significa "respondeu"):
`0` respondeu · `64` uso errado · `65` HogQL inválido (400) · `68` rede/HTTP inesperado ·
`69` dependência ausente/quebrada · `75` rate limit (429) · `77` sem auth (key ausente/vazia/`phc_`/
permissão frouxa/401/403).

## 4. Armadilhas

- **Ler a série ANTES de provar exposição fabrica conclusão.** `fase-sem-sinal.md` §5: sem população
  exposta na janela, série vazia é indistinguível de "o estado não ocorre". Sempre rode o **controle
  sem filtro de evento** junto — série do evento vazia **com** controle positivo é dado real; as duas
  vazias é sensor não chegando.
- **`phc_` ≠ `phx_`.** A primeira escreve, a segunda consulta. O wrapper diagnostica a troca.
- **Arquivo de key VAZIO passa despercebido.** `~/.config/afiacao/supabase-pat` existe com **0 bytes**
  desde 2026-07-27 — criado e nunca preenchido. O wrapper trata `-s` (vazio) como falha explícita,
  porque `command -v`/existência de arquivo é sonda **cega** a esse caso.
- **A key não entra em `argv`.** Vai por `curl --config` (arquivo `0600`, apagado no trap): `-H` a
  deixaria visível em `ps` para qualquer processo do usuário. A suíte prende isso, com falsificação.
- **Escapar HogQL à mão erra em silêncio.** O corpo é montado por `jq`, que é dependência
  **obrigatória** — query mal-escapada devolveria número **errado** em vez de falhar, que é
  fabricação de dado (regra do money-path).

## 5. Sensores de frontend já instalados

`carteira.mixgap_visto` (`estado`, `total_com_gap`, `desatualizado`) ·
`carteira.positivacao_vista` · `dashboard.*` e `offline.*` (walkthrough de 2026-05-17).
Convenção de nome: `<area>.<action>`, emitido por `track()` de `@/lib/analytics`.
