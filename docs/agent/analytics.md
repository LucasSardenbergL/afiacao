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

- **Em janela CURTA o controle sem filtro de evento não controla nada.** O corolário da armadilha
  acima, e ele morde na direção oposta. Um controle numa janela **maior** que a da série não
  compartilha nada com ela e não prova exposição; um controle na **mesma** janela de minutos é
  vazio por construção — passar do tempo é o que falta, não o sinal — e devolve "sensor não
  chegando" para um app perfeitamente saudável. Os dois erram, em sentidos contrários.
  O que separa é trocar a pergunta: não *"houve evento na janela?"*, e sim **"este silêncio é
  anômalo?"** — o que se responde pelo **padrão histórico**, não por um count. Medido em
  2026-08-24 (`toDayOfWeek`, 1=seg, 60 dias): seg 207/4d · ter 381/8d · qua 309/7d · qui 229/6d ·
  sex 227/6d · **sáb 32/5d** · **dom 72/5d**. Uma manhã de segunda sem evento algum, precedida de
  um domingo, é o esperado — e não evidência de ingestão morta.
  **A regra:** o controle só controla pelo eixo que ele **não** compartilha com a série; em janela
  curta esse eixo é a sazonalidade, e por isso a janela igual é justamente a que não serve.
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

### `dashboard.visita_tentativa` — como ler (2026-08-24, #1945 + #1949)

O sensor que separa **"não gravou"** de **"não tentou"** em `dashboard_visits`. Emitido no cleanup do
`useEffect` de `useRegistrarVisitaDashboard` **e** no `pagehide`, **antes de qualquer `return`** — por
isso `count()` dele é o denominador de saídas do dashboard, não só das que gravaram.

⚠️ **Contrato de duas entregas, no mesmo dia.** O #1945 instalou o evento com 3 motivos e sem `via`;
o #1949 acrescentou o caminho `pagehide` (`fetch` com `keepalive`, que aceita os headers do
PostgREST — `sendBeacon` não), a guarda de idempotência e os motivos `ja_gravado`/`lente_ativa`/
`sem_token`. Uma leitura que cruze a fronteira das 11:37Z de 2026-08-24 mistura os dois contratos:
antes disso **não existe** `via`, e `motivo` só assume 3 valores. Filtre por janela ou trate a
ausência de `via` como `unmount`.

Duas dimensões, e nenhuma das duas é opcional na leitura:

| propriedade | valores | o que responde |
|---|---|---|
| `motivo` | `gravou` · `sessao_curta` · `sem_usuario` · `ja_gravado` · `lente_ativa` · `sem_token` | por que a visita virou (ou não) linha |
| `via` | `unmount` · `pagehide` | por qual caminho a pessoa saiu do dashboard |

```sql
-- distribuição das saídas: o breakdown que era invisível até 2026-08-24
SELECT properties.motivo, properties.via, count()
FROM events
WHERE event = 'dashboard.visita_tentativa' AND timestamp > toDateTime('<deploy do sensor>')
GROUP BY 1, 2 ORDER BY 3 DESC;
```

⚠️ **O par que fecha a conta é evento × TABELA, não evento sozinho.** `motivo='gravou'` diz que o
INSERT foi **despachado**, não que ele chegou. Compare sempre com a fonte:

```sql
-- no Postgres, mesma janela:
SELECT count(*) FROM dashboard_visits WHERE visited_at > '<deploy do sensor>';
```

| `gravou` vs. linhas | leitura |
|---|---|
| iguais | caminho saudável de ponta a ponta |
| `gravou` > linhas, **com** `dashboard.visita_erro` | o banco recusou — ver a RLS de INSERT |
| `gravou` > linhas, **sem** `dashboard.visita_erro` | requisição perdida na rede (o `keepalive` do `pagehide` não é garantido) — antes deste sensor, indistinguível de tudo o mais |
| `gravou` = 0 e o resto > 0 | o dashboard é aberto, mas nenhuma sessão qualifica: leia o `motivo` |
| **evento ausente por completo** | **terceiro estado: a ingestão pode ter RECUSADO** — ver abaixo |

⚠️ **Série vazia tem um terceiro estado que só a TABELA distingue.** "Não emitiu" e "emitiu e a
ingestão recusou" são o mesmo silêncio no PostHog. Em 2026-08-24 o POST para `us.i.posthog.com/i/v0/e/`
voltou **503** com três retries, e nenhum evento entrou — nem `$pageview`. Um `GET` no mesmo host
devolve `400` (host vivo), então **sondar o host não desmente o 503 do POST autenticado**. A tabela
`dashboard_visits` é o lado **imune**: o INSERT vai direto ao Supabase e não passa pelo PostHog. Daí a
assimetria útil — **linha sem evento** é telemetria caída com o app são; **evento sem linha** é o app
falhando com a telemetria sã. Quando os dois zeram, comece pela tabela: ela tem menos partes móveis.

⚠️ **E o zero pode nem ser zero: a CONSULTA também falha, por outro endpoint.** No mesmo 2026-08-24,
a query de breakdown por `properties.motivo` voltou **504** de `us.posthog.com` com
`"Query has hit the max execution time"` — agregação por propriedade em `events` é cara. Um
`count()` simples na mesma janela respondeu `[[0]]`, exit 0. São **três** resultados distintos
chegando pelo mesmo cano, e só um é medição:

| o que voltou | é dado? |
|---|---|
| `{"results":[[0]]}` com exit 0 | **sim** — zero medido |
| **503** na ingestão (`us.i.posthog.com/i/v0/e/`) | não — o evento nunca entrou |
| **504** na consulta (`us.posthog.com`) | não — a query não terminou |

**Antes de ler um zero do PostHog como ausência de uso, prove que a query TERMINOU** — e prefira
`count()` simples ao `GROUP BY` de propriedade quando só precisar do denominador. Um `GET` no host de
ingestão devolve `400` mesmo com a ingestão recusando POSTs, então **sondar o host não é sonda de
saúde**.

⚠️ **`via='pagehide'` ainda não tem exercício real.** A prova de 2026-08-24 (`dashboard_visits`
`id=1`) veio com `keepalive: false`, ou seja, pelo caminho do **unmount**. O `emitirComKeepalive` do
#1949 é código no ar sem observação — trate `via='pagehide'` como não-verificado até aparecer o
primeiro.

⚠️ **`sessao_curta` domina por desenho, não por defeito.** O guard de 5 min (`MIN_SESSION_MS`) existe
para um F5 não anular os deltas — uma proporção alta dele é o guard funcionando. Ele só vira sintoma
se `gravou` for **zero** por muitos dias com o dashboard sendo aberto.

⚠️ **`lente_ativa` e `sem_token` são recusas DELIBERADAS do caminho `pagehide`** (write-guard da lente
"ver como" e fetch cru sem como autenticar). Contá-los como falha inverte o sinal: são o gate
funcionando, e no caso do `sem_token` a visita ainda pode gravar pelo unmount.
