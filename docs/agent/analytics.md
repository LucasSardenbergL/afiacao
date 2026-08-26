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

   ⚠️ **`No access` gateia o REST, NÃO o `/query/`** (medido em 2026-08-25 — detalhe na §4).
   `/api/projects/423408/persons/` devolve `403 person:read`; `SELECT count() FROM persons`, mesma
   key e mesmo minuto, devolve **5**. O escopo mínimo continua certo — ele corta o REST inteiro e
   todo o Write — mas **não** descreva esta key como incapaz de ler PII: pelo HogQL ela lê.

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
bash scripts/posthog-query.sh "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 30 DAY"
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

### ⚠️ O PostHog serve CACHE para query idêntica — e não avisa (2026-08-24)

`SELECT count(), max(timestamp) FROM events` repetida ao longo de um dia devolveu
`2.630 / 2026-08-23T11:09Z` durante **horas**, enquanto o valor real já era
`2.631 / 2026-08-24T21:59Z`. O cache do PostHog casa a query **byte a byte** e
devolve o resultado velho **sem marcar que é velho** — o JSON compacto do wrapper
não mostra `is_cached`.

O custo foi um diagnóstico inteiro na direção errada: a leitura "a ingestão aceita
com `200 Ok` e DESCARTA o evento" nasceu de comparar um POST novo contra um
`count()` congelado. Não havia descarte nenhum; o evento estava lá.

**Corrigido em `scripts/posthog-query.sh`:** o default agora manda
`refresh: "force_blocking"` (recalcula sempre). Para aceitar cache — mais rápido,
e legítimo quando um valor recente basta — passe `--cache`.

```bash
scripts/posthog-query.sh "SELECT ..."            # recalcula (default, correto p/ medir)
scripts/posthog-query.sh --cache "SELECT ..."    # aceita cache (rápido, pode MENTIR)
scripts/posthog-query.sh --cru "SELECT ..." | jq .is_cached   # confere quem serviu
```

Falsificado: com a mesma query, o default responde `is_cached=false` e `--cache`
responde `is_cached=true`.

**A regra generalizada:** um resultado repetido não é uma segunda medição. Se duas
leituras iguais são a sua evidência de que "nada mudou", confirme que a segunda
foi de fato **executada** — em cache, "estável" e "congelado" são idênticos.

**Irmão disso, mesmo dia:** a API de consulta pode devolver **HTTP 504**
(*"Query has hit the max execution time"*). O wrapper agora sai com **exit 73** e
diz que aquilo é **ausência de dado, não zero** — antes, um 504 e um `[[0]]`
chegavam pelo mesmo cano e só um deles era medição.

### ⚠️ A amostra é CENSURADA, não esparsa — bloqueador de rastreador (2026-08-25)

`us.i.posthog.com` está nas listas de bloqueio comuns (EasyPrivacy/uBlock). Medido no Chrome do
founder, com par de falsificação contra um Chromium limpo na **mesma máquina, rede e minuto**:
`fetch` na ingestão morre em **4 ms** (`TypeError: Failed to fetch`) enquanto o limpo responde
**200 em 1112 ms**. O CDN `us-assets.i.posthog.com`, o Supabase e o Google Fonts **passam** no mesmo
browser — morre só o endpoint de ingestão.

Três consequências para toda leitura daqui:

1. **Cliente bloqueado e cliente que não usou produzem o mesmo zero.** Não há como distinguir na
   série. Sinal que DECIDE não pode morar só no PostHog — é o que torna o par tabela × evento
   obrigatório, não redundante (a tabela sai pelo domínio do app e é imune à lista).
2. **O viés correlaciona com o perfil**: quem bloqueia costuma ser quem usa mais. A censura não é
   ruído aleatório que some no agregado.
3. **Sempre decomponha por aparelho.** Em 2026-08-25 um único iPhone respondia por **97,7%** dos
   eventos de browser dos últimos 30 dias (677 de 693) — 77% na janela total (2027 de 2630). "O
   canal está vivo" queria dizer "**um** cliente está vivo": agregado é soma de clientes que
   falham de forma independente.

```sql
-- o breakdown que precede qualquer leitura de série
SELECT properties.$os AS so, properties.$browser AS nav,
       uniq(properties.$device_id) AS aparelhos, count() AS n, max(timestamp) AS ultimo
FROM events WHERE properties.$lib='web' GROUP BY so, nav ORDER BY ultimo DESC
```

⚠️ **O teste de 1 linha que estava aqui era FALSO NEGATIVO — não o use.** Ele mandava abrir
`https://us.i.posthog.com/i/v0/e/` na barra do navegador e ler o `HTTP 400 request missing data
payload` como "livre". Medido em 2026-08-26 no Chrome 152 do founder — o aparelho cujo bloqueio o
`#1984` provou — a navegação top-level **passa** (`request missing data payload`) enquanto o `fetch`
de dentro de `steu.lovable.app` **falha** (`TypeError: Failed to fetch`, 351 ms e **5 ms** na 2ª),
com o Supabase respondendo `401` na mesma página e no mesmo minuto. Bloqueador casa por **tipo de
request e por parte** (`xmlhttprequest`, `third-party`); digitar a URL é navegação **first-party**,
a classe que a lista não bloqueia.

**O teste que serve** roda com a página do app aberta, no console do aparelho:

```js
const t = performance.now();
fetch('https://us.i.posthog.com/i/v0/e/', { method: 'POST', body: '' })
  .then(r => r.text().then(b => `LIVRE ${r.status} em ${Math.round(performance.now()-t)}ms — ${b}`))
  .catch(e => `BLOQUEADO ${e} em ${Math.round(performance.now()-t)}ms`)
  .then(console.log);
```

E ele dá de graça o diagnóstico da CAMADA: navegação passando + XHR falhando é **extensão de
bloqueio** (casa por tipo de request). DNS, `/etc/hosts` e firewall derrubariam as duas.

### ⚠️ O aparelho bloqueado é INVISÍVEL no PostHog — a lista de quem liberar não sai daqui (2026-08-26)

O breakdown acima lista **quem já emitiu**. Um aparelho censurado desde o primeiro dia não tem
linha nenhuma: ele não aparece com zero, ele **não aparece**. Levantar "quais aparelhos precisam de
allowlist" pelo PostHog é perguntar à amostra censurada quem ela censurou.

Medido: o `$device_id` que vive no `localStorage` do Chrome do founder **agora** é
`019e6c3b-71b8-77c2-b110-6c1edef31a0f`, e ele tem `count() = 0` **em toda a história do projeto** —
o SDK subiu, cunhou identidade, persistiu, e nenhum evento chegou. Os três `Mac OS X / Chrome` que
o breakdown mostra (`019f1f92` 01/07, `019e7fcc` 31/05, `019e2ec9` 16/05) são **outros** perfis, e
lê-los como "o Mac emite às vezes" é confundir aparelho com identidade de armazenamento.

**A via correta é do lado do cliente, e é uma linha no console do aparelho:**

```js
JSON.parse(localStorage[Object.keys(localStorage).find(k => k.startsWith('ph_'))]).$device_id
```

Esse id, com `count() = 0` no PostHog, é a prova de censura mais limpa que existe — e é também a
**marca pré-registrada** da prova de que a liberação funcionou: qualquer linha desse `$device_id`
depois da mudança fecha o caso, sem depender de "eu liberei".

⚠️ E `count() = 0` só vale com **exit 0**: o `504` do wrapper (exit 73) é ausência de dado. Query
com subconsulta neste eixo estoura o tempo — rode uma pergunta por vez.

### ⚠️ Escopo `No access` não cega o HogQL — logo um `0` dele precisa de PAR (2026-08-25)

O `/query/` autoriza pelo escopo **`query:read` e mais nada**: ele não reaplica o escopo da tabela
que a query toca. Medido, no mesmo minuto e com a mesma key:

| pergunta | REST | HogQL |
|---|---|---|
| pessoas | `403 API key missing required scope 'person:read'` | `SELECT count() FROM persons` → **5** |
| gravações | `403 API key missing required scope 'session_recording:read'` | `SELECT count() FROM session_replay_events` → **0** |

Duas consequências opostas, e as duas mordem:

1. **Para LER, a key alcança mais do que a §2 sugere.** `persons`, `session_replay_events`,
   `raw_session_replay_events` e `sessions` respondem pelo HogQL. Isso é útil (foi o que permitiu
   levantar o passivo de replay sem pedir escopo novo) e é também superfície de PII que a lista de
   escopos não descreve.
2. **Para CONCLUIR, um `0` do HogQL não se prova sozinho.** Se o `/query/` *tivesse* filtrado por
   escopo, ele devolveria exatamente o mesmo `0` — indistinguível. Zero e cegueira chegam pelo
   mesmo cano, como o 504 e o `[[0]]` da armadilha anterior.

**O par que separa os dois** — e nenhum dos três passos é dispensável:

- **par REST × HogQL numa tabela TERCEIRA**: pegue outra tabela igualmente `No access` no REST
  (`persons` serve) e mostre-a **não-vazia** no HogQL. Não-vazio prova que o filtro não existe;
  vazio não prova nada.
- **schema resolve**: `SELECT * FROM <tabela> LIMIT 1` traz o array `columns` mesmo com 0 linhas —
  se as colunas vêm, a tabela é real e foi mesmo consultada, não um alias que resolve para vazio.
- **coluna inventada dá 400**: `SELECT coluna_que_nao_existe FROM <tabela>` tem de reprovar. Se
  reprovar, o schema está sendo checado de verdade; se passar, você não estava lendo aquela tabela.

E prefira, quando existir, a via que **não depende de escopo nenhum**: uma propriedade que o SDK
carimba no próprio evento mora em `events`, que a key lê sem discussão. Foi o que fechou o caso do
replay — `$recording_status` valeu mais que as duas tabelas de gravação juntas.

#### O corolário que morde ao contrário: "403 no REST ⇒ cego no HogQL" é FALSO (medido 2026-08-25)

A inversão tentadora do quadro acima é promover o REST a discriminante: *"a chamada REST é a
honesta — 403 = a key é cega naquela tabela, 200 = ela enxerga"*. É **falsa**, e falha justamente
no caso que a motivou. Quatro famílias de escopo em `No access`, as quatro REST-403, mesma key e
mesmo minuto:

| tabela HogQL | escopo que falta (REST 403) | HogQL |
|---|---|---|
| `persons` | `person:read` | **5** |
| `person_distinct_ids` | `person:read` | **11** |
| `heatmaps` | `heatmap:read` | **98** |
| `session_replay_events` · `raw_session_replay_events` | `session_recording:read` | 0 |
| `error_tracking_issue_fingerprint_overrides` · `logs` | `error_tracking:read` | 0 |

**Três** das cinco linhas voltam NÃO-VAZIAS com o REST em 403. O 403 é **constante na coluna
inteira** — não discrimina nada; a variação mora toda do outro lado. O gate é do **endpoint**:
`/query/` pede `query:read` e não reaplica o escopo da tabela.

Quem escrevesse a regra invertida concluiria, sobre este mesmo caso, *"somos cegos, não dá para
saber se o replay gravou"* — fail-OPEN numa pergunta de LGPD, com a resposta certa ao alcance da
mão. O zero do replay era **real**; quem o prova é o par de terceira tabela acima, não o REST.

`heatmaps` é o **segundo falsificador, e vale mais que o primeiro** por vir de outra família de
escopo: só com `persons`, a explicação alternativa *"a tabela `persons` é que é especial"* seguia
de pé. Os três testes passam nela — 98 linhas, `columns` com 11 campos, e
`SELECT coluna_que_nao_existe FROM heatmaps` → 400 `Unable to resolve field`.

**Error tracking: zero CONFIRMADO**, e pela via preferida, a que não depende de escopo nenhum —
`$exception` em `events` também é **0**. As duas tabelas e a rota livre de escopo concordam. Um
zero de tabela sozinho continuaria não se provando; o que o promove a fato é o **acordo** com
`events`.

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

⚠️ **`via='pagehide'` não entrega quando a aba FECHA — causa raiz isolada em 2026-08-25.**

Dois testes controlados no mesmo build (`36f7f5be`, que contém o #1949), mesma conta, mesmo caminho
de código. **A única condição que muda é se a página está morrendo:**

| teste | como o `pagehide` foi disparado | despachou? | resposta | linha? |
|---|---|---|---|---|
| 00:17:10Z | **aba fechada** de verdade | sim, `keepalive: true` | **nunca chegou** | ❌ |
| 01:04:48Z | `dispatchEvent` com a **página viva** | sim, `keepalive: true` | **201** em 637ms | ✅ `id=3` |
| 01:18:57Z | `dispatchEvent` com a **página viva** (repetição) | sim, `keepalive: true` | **201** em 605ms | ✅ `id=5` |

O corpo, os headers, o token e a policy são os mesmos nos dois. **O código está correto**: com a
página viva ele grava em 637ms. O que falha é o `fetch` com `keepalive: true` **não sobreviver ao
unload** neste contexto — a flag promete isso e não cumpre.

**Refutadas por medição, não por argumento** (cada uma custaria um fix errado):

| hipótese | como caiu |
|---|---|
| env var errada | `VITE_SUPABASE_PUBLISHABLE_KEY` é a mesma que o client oficial usa |
| bundle velho no browser | `build_sha` = `36f7f5be`, que contém o #1949 |
| RLS / GRANT | ACL de `dashboard_visits` **idêntico** ao da tabela-controle `profiles` (`authenticated=arwdDxtm`, o `a` é INSERT); policy `cmd=a` com `auth.uid() = user_id`, que é o que o payload manda |
| token expirado no `tokenRef` | o `AuthContext` escuta `onAuthStateChange` e faz `setSession`, então o ref segue fresco — e o mesmo token devolveu **201** |
| service worker interceptando | `dashboard_visits` **não aparece** no `sw.js` de produção (0 ocorrências) e o Workbox só registra rotas `"GET"` (8) — o POST vai direto à rede |

⚠️ **A instrumentação teve de ser persistida em `localStorage`**: a aba morre e leva a memória junto,
então um interceptor que só acumula em variável não sobrevive para ser lido. E o `.then()` do próprio
app nunca roda no fecho real — é exatamente por isso que este caminho ficou opaco desde o #1949: ele
**não consegue reportar o próprio fracasso**.

**O que isto implica para o desenho:** gravar no `pagehide` é uma aposta na boa vontade do browser, e
ela não paga. As saídas que o repo consegue capturar com confiança são o **unmount** (navegação SPA,
provado 3×) — fechar a aba continua perdendo a visita. Duas correções possíveis, e a escolha é de
produto porque muda o significado do dado:

- **timer ao cruzar `MIN_SESSION_MS`** — grava assim que a sessão qualifica, independente de como o
  usuário sai. Mais robusto; em troca, `session_minutes` na tabela vira o **limiar** (5), e a duração
  real passa a existir só no evento do PostHog.
- **`visibilitychange` → `hidden`** — dispara antes do unload, com a página ainda viva, então o fetch
  normal entrega. Em troca, uma aba trocada e retomada conta como visita encerrada.

Enquanto nenhuma das duas existir, leia `motivo='gravou'` com `via='pagehide'` como **tentativa**, não
como visita registrada — e confira contra a tabela.

⚠️ **Contar eventos da janela como "a ingestão está viva" soma DOIS canos.** O `posthog-js` preenche
`properties.$lib`; uma captura por `curl` não — e só a decomposição separa os dois. Medido em
2026-08-24 (7 dias): **browser `$lib='web'`: 65 eventos, último 23/08 11:09Z** — *antes* do 503 de
~12:17–12:30Z de 24/08 — contra **API direta: 1 evento, 24/08 21:59Z**. O agregado (66) leu como
saudável um canal que, exercitado no dia seguinte, não entregou nada. **Um POST por `curl` que volta
`200` prova que o servidor aceita, não que o browser emite**: CORS, batch, retry e adblock não são
atravessados por ele — do mesmo modo que o `GET` no host não desmentia o 503. É por esse cano que
saem `dashboard.viewed`, `dashboard.visita_tentativa` e o `build_id` da §6. **A prova específica não
precisa ser fabricada: o primeiro evento com `$lib='web'` é ela.**

```
SELECT toDate(timestamp) AS dia,
       if(isNull(properties.$lib),'API_direta','browser_SDK') AS via,
       count() AS n, max(timestamp) AS ultimo
FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY dia, via ORDER BY dia DESC
```

⚠️ **`sessao_curta` domina por desenho, não por defeito.** O guard de 5 min (`MIN_SESSION_MS`) existe
para um F5 não anular os deltas — uma proporção alta dele é o guard funcionando. Ele só vira sintoma
se `gravou` for **zero** por muitos dias com o dashboard sendo aberto.

⚠️ **`lente_ativa` e `sem_token` são recusas DELIBERADAS do caminho `pagehide`** (write-guard da lente
"ver como" e fetch cru sem como autenticar). Contá-los como falha inverte o sinal: são o gate
funcionando, e no caso do `sem_token` a visita ainda pode gravar pelo unmount.

## 6. Adoção do deploy — qual BUILD o cliente está EXECUTANDO (`build_id`)

Todo evento carrega `build_id` = o hash do chunk do entry que o browser carregou
(ex.: `index-TTF9Kw1g`). Nasce em `src/lib/build-id.ts`, é registrado como **super
property** no `initAnalytics()` (`src/lib/analytics.ts`) e por isso alcança **todo**
evento — inclusive `$autocapture`, `$pageview`, `$pageleave` e `$exception`, que não
passam por `track()`.

**Por que isto existe:** o `verify-frontend.sh` prova o que o servidor **entrega**,
nunca o que o browser **executa** — mede DISPONIBILIDADE, não ADOÇÃO. Com
`registerType: 'prompt'` e `skipWaiting` removido de propósito, o SW novo instala e
**espera indefinidamente** por um clique humano (`docs/agent/deploy.md`). Em
2026-08-24 os #1934/#1945/#1949 estavam todos servidos e nenhum executava; a
descoberta foi acidental. Esta é a instrumentação que faltava.

### A conta

```
adoção = clientes com build_id = <atual> / clientes que emitiram qualquer evento
```

O `<atual>` **não se chuta** — sai do mesmo eixo que o verificador lê do servidor:

```bash
curl -fsS https://steu.lovable.app/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1
```

Distribuição por build nos últimos 7 dias (numerador e denominador na MESMA query —
o denominador é a soma da coluna, não uma segunda leitura):

```bash
./scripts/posthog-query.sh "
SELECT coalesce(properties.build_id, '(sem instrumentacao)') AS build,
       count(DISTINCT distinct_id) AS clientes,
       count() AS eventos,
       max(timestamp) AS ultimo
FROM events
WHERE timestamp > now() - INTERVAL 7 DAY
GROUP BY build ORDER BY clientes DESC"
```

### Armadilhas de leitura

- ⚠️ **Ausente, `'desconhecido'` e um hash são TRÊS estados, não dois.** Propriedade
  **ausente** = cliente executando um build **anterior a esta instrumentação** — é
  sinal legítimo de NÃO-adoção, e é o estado esperado da maioria logo após o Publish
  deste PR. `'desconhecido'` = build atual, mas o entry não foi encontrado no HTML
  (dev, ou o Vite mudou a forma do `index.html` — investigar). Um hash = leitura boa.
  Colapsar os três num só é o que cega a medição. Por isso o `coalesce` acima nomeia
  o ausente em vez de deixá-lo virar `NULL` silencioso.
- ⚠️ **Esta query é o caso clássico do cache da §4**: ela é IDÊNTICA a cada leitura
  (mesmo texto, sempre), então é exatamente onde `--cache` devolveria a medição
  anterior com cara de medição nova. O default do wrapper (`force_blocking`) já
  protege — **não passe `--cache` aqui**. Confira com `--cru | jq .is_cached`.
- ⚠️ **`distinct_id`, não `person_id`:** o SDK roda com `person_profiles:
  'identified_only'`, então quem não logou não tem perfil de pessoa. O denominador
  "clientes que emitiram qualquer evento" precisa incluí-los.
- ⚠️ **Adoção baixa é o comportamento CORRETO, não um defeito.** Com o modelo
  `prompt`, o cliente fica no build velho até clicar "Atualizar". A query responde
  *quantos* e *quem* — a decisão (esperar, avisar, ou forçar) é de produto.
- ⚠️ **O denominador desta query NÃO é a janela de exposição — e por isso `0/N` pode não ser
  adesão nenhuma.** A fórmula divide *clientes com o build atual* por *clientes na janela de 7
  dias*: o numerador só pode existir DEPOIS do Publish, o denominador vem dos sete dias inteiros.
  Se ninguém emitiu evento desde o Publish, `0/3` sai com cara de medição de não-adoção quando é
  **ausência de observação** — e a razão colapsa os dois estados sem avisar. Antes de reportar a
  taxa, meça o denominador PÓS-Publish:

  ```sql
  SELECT count() AS eventos, count(DISTINCT distinct_id) AS clientes
  FROM events WHERE timestamp > toDateTime('<hora do Publish>', 'UTC')
  ```

  Zero ali não é adoção zero: é a taxa ainda sem o que medir.
- ⚠️ **O controle de exposição precisa vir de FORA do cano medido.** Corolário duro do `#1967`:
  ele mostrou que um cano com dois caminhos exige controle POR caminho — mas esse controle ainda
  vive DENTRO do PostHog e emudece junto quando o PostHog inteiro emudece. Um controle que só
  existe no canal sob suspeita não separa *não houve fenômeno* de *o canal não entrega*. O
  controle independente aqui é a tabela `dashboard_visits`, que escreve pelo **PostgREST**: se ela
  ganha linha na mesma janela em que o PostHog não ganha evento, o zero do PostHog é do CANAL, e
  isso se lê sem login com o `psql-ro`. Medido em 2026-08-25 (abaixo).
- ⚠️ **HTTP 504 = ausência de dado, não zero** (exit 73 no wrapper) — vale aqui como
  em toda leitura desta doc.
- ⚠️ **O executável é `scripts/posthog-query.sh`, no repo — `~/.config/afiacao/` guarda só a KEY.**
  O exemplo da §3 chamava `~/.config/afiacao/posthog-query`, que **não existe** (exit 127, medido
  2026-08-24) e que a própria §2 **proíbe criar como symlink**. Corrigido na §3; registrado aqui
  porque o sintoma (`127`) não se parece com "caminho errado" e custa uma ida ao `ls`.

### Baseline no dia da instalação (2026-08-24, ANTES do Publish)

A query acima rodou com `exit 0` e devolveu **uma linha só**:

```
(sem instrumentacao) | 3 clientes | 66 eventos | ultimo 2026-08-24T21:59:38Z
```

Isso é o **controle negativo** do sensor, e vale guardar: pré-Publish, 100% dos eventos têm de cair
em `(sem instrumentacao)`. Um `build_id` com hash aparecendo aqui antes do Publish significaria que a
leitura está medindo outra coisa.

⚠️ **A segunda metade desta nota estava ERRADA, e fica registrada como tal.** Ela dizia que os 66
eventos eram o *controle POSITIVO de ingestão*, e que por isso uma série vazia adiante seria sinal
real e não silêncio de canal morto. O `#1967` decompôs os MESMOS 66 por `properties.$lib`: **65 são
de browser e nenhum é posterior a `2026-08-23T11:09Z`**; o 66º entrou por `curl`. O agregado somava
dois canos e leu como saudável um canal que, exercitado, não entrega. **Um controle positivo que
mistura canos não controla nenhum deles** — e esta frase ficou de pé na doc canônica por um dia
depois de refutada no histórico, que é o jeito mais barato de uma medição errada sobreviver.
### Primeira leitura PÓS-Publish (2026-08-25T01:33Z) — e por que ela ainda NÃO é adoção

O Publish saiu: o entry passou de `index-IM3W0waG` para **`index-D1GiFr1h`**. E o bundle servido
**contém o sensor** — `e.register({build_id:ii()})` aparece literal no `index-D1GiFr1h.js`
(236 KB, `curl` `rc=0`). Isso elimina *publicou sem a instrumentação* pelo método do `#1973`:
mede-se o que o servidor entrega, sem login. Vale sempre — o hash mudar prova que **um** build novo
está no ar, não que é **este**.

A query da §6, `exit 0` e `is_cached=false`, devolveu **a mesma linha do baseline**:

```
(sem instrumentacao) | 3 clientes | 66 eventos | ultimo 2026-08-24T21:59:38Z
```

Aritmeticamente, adoção = **0 de 3 = 0%**. Só que isso **não é adoção 0%**; é medição que ainda não
pode acontecer, e três leituras separam as duas coisas:

| leitura | resultado |
|---|---|
| eventos após `2026-08-25T00:50Z` (servidor ainda no build velho) | **0 eventos, 0 clientes** |
| último evento com `$lib` preenchido — o cano por onde o `build_id` sai | **`2026-08-23T11:09:23Z`** (~38 h) |
| via do único evento recente do denominador | `API_direta` (o próprio `curl`), não cliente |

Decompondo os 3 clientes: **2 de browser** (65 eventos, todos ≤ 23/08) e **1 de API direta** (1
evento). O denominador é inteiramente pré-Publish, e o cano que carregaria o `build_id` está mudo.

**E não é falta de gente usando o app** — aqui entra o controle de fora do cano. Na mesma janela,
`dashboard_visits` ganhou linha, a última em `2026-08-25T01:32:30Z`, **um minuto antes desta
leitura**, com `company_selection='oben'` e 16 min de sessão (o critério de uso real do `#1972`).
App exposto, autenticado, gravando em produção — e PostHog com zero. **O zero é do canal, não do
fenômeno.**

Consequência para a previsão do `#1964`
(`docs/historico/fase-sem-sinal.md:1478` <!--cita: que aqui é o sensor funcionando, não-->) —
*"que aqui é o sensor funcionando, não falhando"*: ela não foi confirmada **nem** refutada. Com o cano mudo, `0%` é compatível com as duas, exatamente como o
`#1967` advertiu. **O gate que destrava a leitura de adoção não é outra query de adoção — é o
primeiro evento com `$lib='web'`:**

```bash
./scripts/posthog-query.sh "SELECT max(timestamp) AS ultimo_browser FROM events
  WHERE timestamp > now() - INTERVAL 2 DAY AND NOT isNull(properties.\$lib)"
```

Enquanto esse valor não passar de `2026-08-23T11:09:23Z`, repetir a query de build só reconfirma o
zero — e cada repetição parece uma medição nova.

### O gate ABRIU — e o numerador da adoção era a SONDA (2026-08-25T09:50Z)

O gate da subseção anterior passou: `max(timestamp)` com `$lib` preenchido foi de
`2026-08-23T11:09:23Z` para **`2026-08-25T02:15:38Z`**. A adoção ficou legível pela primeira vez, e
a leitura ingênua dela é **errada num sentido novo** — pior que o `0/3`, porque `50%` parece um
resultado.

Decomposição pós-Publish (`> 00:50Z`, `exit 0`, `is_cached=false`), por aparelho — o eixo que o
`#1984` provou ser obrigatório:

| distinct_id | SO / navegador | `build_id` | eventos | janela |
|---|---|---|---|---|
| `414a9727` | **iOS / Mobile Safari** | **`(sem instrumentacao)`** | 13 | 09:39:36 → 09:50:09Z |
| `01a036b3` | Mac OS X / Chrome | **`index-D1GiFr1h`** | 1 | 02:15:38Z |

A query canônica desta §6 leria `1 de 2 clientes` = **50% de adoção**. É fabricação, e a causa não
está na fórmula nem nas janelas:

⚠️ **O `01a036b3` é a SONDA.** É o Chromium limpo que o founder abriu *para testar se o canal
entrega* (confirmado por ele). Ele não existe em `profiles.user_id` — sessão sem login, portanto
sem `identify()` — enquanto `414a9727` e `700657a1` existem, o que faz do teste um controle
positivo e não uma sonda cega. Aberto para medir o canal, ele nasceu **no build atual** (browser
limpo, sem SW velho em cache) e por isso entrou no **numerador** da adoção.

**A regra:** um cliente aberto para diagnosticar o canal entra na população que o canal mede.
Numa amostra censurada — onde os clientes reais estão bloqueados (`#1984`) — a sonda pode virar a
**maioria** dos observáveis, e a taxa passa a medir o instrumento. Antes de dividir, exclua do
denominador todo `distinct_id` que você mesmo criou; se o que sobra é `0/1`, a taxa não existe
ainda, e dizê-lo é a leitura correta.

**A adoção real, excluindo o instrumento: `0 de 1` usuário.** O único usuário do parque ativo
pós-Publish (`414a9727`, 12 visitas em `dashboard_visits` até 09:46:31Z, controle de fora do cano)
executa build **anterior** à instrumentação. É o comportamento correto do `registerType: 'prompt'`
— e agora é uma não-adoção **medida**, não uma ausência de observação.

### DECISÃO: o proxy first-party foi RECUSADO — e o gatilho que o reabre (2026-08-25, #1984)

A censura do `#1984` tinha três saídas: **(a)** liberar `us.i.posthog.com` nos aparelhos internos ·
**(b)** reverse proxy first-party (o remédio documentado do PostHog) · **(c)** aceitar a censura e
manter todo sinal que DECIDE em tabela própria. **Decidido: (a) agora, (c) como regra permanente,
(b) recusado atrás de um gatilho nomeado.** O que a medição desfez não foi o custo de (b) — foi a
premissa dele.

⚠️ **A "população externa" que (b) devolveria é VAZIA — e isso se mede, não se supõe.** O
argumento a favor de (b) era ser o único caminho que recupera o cliente que bloqueia. Medido em
2026-08-25, antes de decidir:

| medição | resultado |
|---|---|
| contas com role `customer` (`user_roles`) | **5.664** |
| customers **aprovados** (`profiles.is_approved`) | **0** — e o default da coluna é `false` |
| profiles aprovados no total | **4**, todos internos (Lucas ×2, Tatyana, atendimentocolacor) |
| `selfservice_cliente_allowlist` | **0 linhas** |
| `orders` | **0 linhas, 0 usuários** |
| `distinct_id` com `$lib='web'` em 30 d | **4** — os 3 internos acima + a sonda (`01a036b3`) |

Os 5.664 são cadastro importado da Omie, não usuários: sem `is_approved` o customer não entra. A
população inteira do app cabe em três pessoas, **todas internas** — então (a), descrita como "não
resolve o cliente externo", cobre 100% do que existe, e (b) recuperaria **zero** usuário hoje. A
regra generalizada: *antes de pagar por uma saída que recupera uma população, CONTE a população.*
Um denominador de 5.664 que na verdade vale 0 é a mesma falha de fabricação de `Number(null)===0`.

⚠️ **O first-party de verdade está FORA DO MODELO DE DEPLOY — e o barato não é first-party.**
(Esta frase dizia "é IMPOSSÍVEL"; o ritual Codex de 2026-08-25 derrubou a palavra e ela fica
corrigida aqui, não apagada. O que a medição prova é que não há rewrite no domínio ATUAL — não
que não exista caminho: custom domain + CDN próprio na frente é caminho, e caro.) Medido:
`https://steu.lovable.app/ingest/`, `/ingest/e/` e `/api/health` devolvem os três **HTTP 200,
`text/html`, 8.307 bytes** — o `index.html` do SPA. Não há camada de rewrite: todo path cai no
fallback estático, servido por Cloudflare **da Lovable** (`cf-ray …GRU`, `185.41.148.1/2`), cujo
edge não é nosso. Não há `vercel.json`/`netlify.toml`/`_redirects` no repo, e o Lovable não os
leria. Um proxy na MESMA origem exigiria sair do Lovable Cloud ou pôr CDN próprio na frente —
reescrever o modelo de deploy inteiro, no ponto onde este repo já tem 3 camadas manuais e histórico
de reversão pelo sync bidirecional. A versão barata (edge function Supabase; o código já custaria
zero, `VITE_POSTHOG_HOST` existe desde sempre) **não é first-party**: `*.supabase.co` é outro
domínio, a proteção seria "ainda não está na lista" e não "é o meu domínio". Isso é obscuridade, e
ela expira na próxima atualização de filtro. A latência não é o obstáculo (medido: edge Supabase
**0,49 s** vs PostHog direto **0,55 s**) — o obstáculo é arquitetural, e a edge precisaria ser
pública (`verify_jwt=false`, o SDK não manda JWT), isto é, um **relay aberto** para o nosso projeto.

⚠️ **E há o conflito que não é técnico: (b) contorna uma escolha explícita do titular.** Um proxy
first-party não é otimização de entrega — sua função é fazer com que a recusa técnica do usuário
**deixe de funcionar**. Analytics de produto em app logado costuma se apoiar em legítimo interesse
(LGPD art. 7º, IX), mas o art. 10, II ancora o balanceamento nas *expectativas legítimas do
titular*, e a necessidade/minimização (art. 6º, III) limita o quanto se coleta para a finalidade
declarada. Contornar não é "coletar sob legítimo interesse": é desenhar em volta de uma recusa, e
enfraquece a própria base que justificaria a coleta.

⚠️ **Não force o art. 18, §2º aqui — esta doc já forçou, e fica registrado.** A versão anterior
dizia que aquele dispositivo "dá direito de oposição" e que "instalar bloqueador é a forma mais
inequívoca de exercê-lo". É esticado: o §2º trata de oposição a tratamento fundado em hipótese de
dispensa de consentimento **em caso de descumprimento da lei**, e não equipara automaticamente um
ad blocker a uma manifestação formal ao controlador. O argumento que se sustenta é o de
**expectativa legítima + necessidade + minimização + transparência**, avaliado por finalidade — e
ele basta. Um proxy first-party de telemetria própria também **não** é ilícito por definição: não
muda finalidade, controlador, operador nem transferência internacional. *Postura não é ilegalidade,
e vender uma como a outra enfraquece as duas.*

E o peso sobe quando há gravação de tela — que é justamente o que este PR desligou (ver o bloco
do Session Replay adiante). O fecho do argumento:
**hoje o único bloqueado medido é o próprio founder** — (b) seria construir contorno de opt-out
para contornar o opt-out de si mesmo. Quando houver cliente externo o conflito PIORA, porque os
titulares passam a ser terceiros.

**O gatilho que reabre (b)** — nomeado para que "não fizemos o proxy" seja escolha registrada e não
pendência esquecida. ⚠️ **A primeira versão deste gatilho era TARDIA e CEGA, e as duas falhas foram
achadas pelo Codex, não pela revisão:**

- **Tardia.** Ela disparava em "≥1 customer **já aprovado** e já censurado". Aprovar customer é ato
  administrativo NOSSO, então existe um instante observável ANTES do primeiro uso — e esperar a
  primeira censura garante perder a primeira sessão, que é a mais informativa que existirá. Dado
  histórico não se coleta retroativamente. **O eixo certo é "customer PRESTES a ser aprovado".**
- **Cega.** Ela pedia "linha em `dashboard_visits` sem evento na mesma janela". Isso mede *captura
  client-side ausente*, não *bloqueador*: SDK que não inicializou, `unload`, offline, identidade
  divergente e erro de config produzem o mesmo par. Pior — **`dashboard_visits` não tem coluna de
  aparelho** (`id, user_id, visited_at, persona, company_selection, session_minutes`), então o
  pareamento só existe por USUÁRIO, e um evento do celular "explica" uma visita bloqueada no
  desktop. Isto é a §4 desta mesma doc (*"sempre decomponha por aparelho"*) sendo violada três
  seções abaixo dela: **regra escrita não se aplica sozinha ao texto seguinte.**

**A forma corrigida.** Reabrir (b) só com as duas:

1. um customer está **prestes** a ser aprovado (o gate roda ANTES do `UPDATE`, não depois):

   ```sql
   SELECT count(*) FROM profiles p JOIN user_roles ur ON ur.user_id = p.user_id
   WHERE ur.role = 'customer' AND p.is_approved;   -- hoje 0; >0 = a janela JÁ abriu
   ```

2. a censura está medida por **probe pareado**, não por ausência: um `attempt_id` aleatório gerado
   no boot autenticado, gravado (i) na tabela e (ii) como propriedade de um evento PostHog, e
   reconciliado após atraso fixo. **Dois `attempt_id` sem par, em sessões distintas do MESMO
   aparelho**, tornam censura persistente a explicação plausível. Um só não conclui nada.

Enquanto o probe não existir, a condição (2) é falsificável no papel e inconclusiva na prática —
que é o estado de hoje. **Instalar o probe é pré-requisito de aprovar o primeiro customer**, não
tarefa posterior.

⚠️ **E mesmo com o gatilho aberto, a primeira saída NÃO é o proxy — nem (c) puro.** É a quarta
saída abaixo, que o ritual Codex trouxe e que domina as duas: ela não depende de browser, então
não há o que bloquear, e não contorna a escolha de ninguém.

### A quarta saída: outbox server-side (preferida sobre (c) puro)

**Backend como fonte de verdade + outbox único + PostHog secundário.** Fato de negócio que já é
persistido (pedido criado, aprovado, concluído) sai das tabelas de domínio; **na mesma transação**
uma `analytics_outbox` recebe só os eventos DECISÓRIOS; um worker os envia server-side com
`event_id` idempotente. Interação puramente de UI segue client-side e assumidamente censurável.
Para jornada crítica sem mutação de domínio, um ledger autenticado — **não 111 tabelas**.

Por que isto domina (c) puro: **"sinal que decide" muda DEPOIS da coleta.** Um evento classificado
hoje como conveniência vira métrica decisória amanhã, e aí o histórico dele já nasceu censurado —
retroatividade que nenhuma regra de estilo conserta. Dual-write manual espalhado por N tabelas
produz divergência; a outbox transacional, não. E vale o lembrete que a tabela própria não dispensa:
**dado em tabela nossa continua sendo tratamento de dado pessoal** — (c) resolve censura, nunca
obrigação de LGPD.

⚠️ **(c) é regra, não hábito — e hoje ela está cumprida em 1 de 111.** O app tem **111 sensores
`track()` distintos** e **um** com espelho em tabela (`dashboard_visits`). A regra não é espelhar os
111: é *sinal que DECIDE nasce em tabela própria; PostHog é conveniência*. Sensor novo cujo
resultado vai fundamentar uma fase N+1 (ver [fase-sem-sinal.md](../historico/fase-sem-sinal.md))
nasce com o espelho — senão a decisão herda a censura, e o par tabela × evento do `#1997` vira
exceção em vez de desenho.

### Session Replay: DESLIGADO — e por que o config anterior mentia (2026-08-25)

⚠️ **`maskAllInputs` mascara CAMPO DE FORMULÁRIO, não o texto da TELA.** O `posthog.init()` trazia
`session_recording: { maskAllInputs: true }` com o comentário *"mascarar inputs por padrão pra
privacidade"* — e essa frase induzia ao erro que ela mesma parecia afastar. A máscara de texto
renderizado é outra opção (`maskTextSelector: '*'`), e **ela nunca esteve no config**. Do jeito que
o cliente estava escrito, o replay **gravaria** a tela como ela aparece: razão social, CNPJ, preço,
saldo, nome de cliente — e o parágrafo seguinte mede o que de fato aconteceu. Num app B2B
isso é dado pessoal de TERCEIRO indo para um processador nos EUA sem finalidade escrita —
problema de **necessidade e minimização** (art. 6º, III), que máscara mais forte não resolve
enquanto ninguém souber para que a gravação serve.

Decidido: **desligado** (`disable_session_recording: true`), não "mascarado mais". Replay é a
única superfície de telemetria do app que captura CONTEÚDO de tela; o autocapture já roda com
allowlist de seletor e o `track()` é nominal, então o que decide continua medido sem ele. Para
religar: escrever finalidade + prazo de retenção, voltar com `maskTextSelector: '*'` — **e ligar o
toggle do projeto**, que é o que de fato liga a gravação (abaixo).

✅ **E não gravou nada: o passivo é ZERO, medido em 2026-08-25.** Replay tem **dois** interruptores
e o do PROJETO nunca foi ligado (é o default de projeto novo) — o `posthog.init()` sozinho não
grava. Quatro medições, independentes entre si:

| via | resultado |
|---|---|
| `POST us.i.posthog.com/decide/?v=3` com a chave pública do app | `{"sessionRecording": false}` |
| `properties.$recording_status` em `events` | `disabled` em **2.645 de 2.645** eventos reais — 152 sessões, 11 aparelhos, do 1º evento (2026-05-15) ao dia do desligamento |
| `session_replay_events` e `raw_session_replay_events` | **0** linhas (schema resolve, coluna inventada dá 400 — ver §4) |
| `$snapshot` em `events` · `event_definitions?search=snapshot\|recording` | **0**, com controle positivo (`pageview`→1, 23 definições no total) |

O `/decide` é a leitura **autoritativa**: é literalmente o que o servidor responde ao posthog-js
antes de ele instanciar o rrweb. O `$recording_status` é a confissão do SDK evento a evento, e é a
melhor das quatro porque **não depende de escopo** — mora em `events`. Nada a excluir no painel,
nada correndo em retenção. A janela de exposição CONFIGURADA foi 2026-05-13 (`d2e59973f`) a
2026-08-25 (`#2016`); a de exposição EFETIVA, vazia.

⚠️ **A lição nova: um interruptor de produto pode ser um PAR, e ler só a metade que mora no repo é
meia medição.** O `git grep` mede o que o cliente **pede**; só o servidor diz o que ele **faz**.
Antes de afirmar que uma superfície de coleta esteve ligada — ou desligada — em produção, leia o
lado remoto: `/decide` para a configuração e a propriedade que o SDK carimba no evento para o
efeito. O mesmo `/decide` governa `autocapture_opt_out`, `capturePerformance` e as feature flags,
então a checagem serve para os quatro.

Isto **não** desfaz o desligamento: `disable_session_recording: true` é o cadeado do lado que nós
controlamos, e quem ligar o toggle do projeto daqui a um ano não vai lembrar deste doc. Muda o
registro do fato, que é o que um doc existe para guardar: **não houve vazamento**. Houve exposição
configurada que um segundo cadeado — cuja existência ninguém no #2016 tinha medido — manteve
fechada o tempo inteiro.

⚠️ **A lição que generaliza é sobre o COMENTÁRIO, não sobre a flag.** Aquele config passou por
revisão porque a linha ao lado dizia "privacidade" — o comentário descrevia a INTENÇÃO e foi lido
como se descrevesse o COMPORTAMENTO. Um comentário que afirma uma garantia é uma asserção sem
teste até que exista um gate; `grep -rn session_recording src scripts` devolvia **uma** linha, o
próprio config, e nada no CI olhava para ela. Agora olha:
`src/lib/__tests__/analytics-privacidade.test.ts`, que lê a fonte com o stripper COMPARTILHADO
(`removerComentarios`) — obrigatório aqui e não zelo abstrato, porque o comentário que documenta o
desligamento cita `session_recording` e `maskTextSelector` de propósito, e um regex ingênuo casaria
com a própria explicação em vez do código.

### Heatmaps: a terceira superfície de coleta — e o `grep` do config não a vê (2026-08-25)

Caiu no colo ao falsificar o discriminante de escopo da §4: `SELECT count() FROM heatmaps` → **98**.
Ninguém tinha inventariado essa superfície, e `grep -rni heatmap src scripts supabase` devolve
**zero** — não existe linha de config nossa pedindo heatmap.

⚠️ **O mecanismo é o `capture_pageleave`, não o toggle do projeto.** O `/decide` responde
`heatmaps: false` e a tabela enche assim mesmo. Quem alimenta é o `capture_pageleave: true` do
nosso `posthog.init()`: o SDK carimba `$prev_pageview_max_scroll` /
`$prev_pageview_max_content_percentage` / `$viewport_width` no `$pageleave`, e a ingestão deriva
daí a linha `type='scrolldepth'`. Provado por **igualdade exata**, não por parecença: há 108
`$pageleave` com scroll, dos quais **10** são anteriores à primeira linha de heatmap e **98**
posteriores — e `heatmaps` tem exatamente **98** linhas. O último evento e a última linha batem no
**mesmo milissegundo** (`2026-08-25T09:51:18.165Z`), e não existe evento `$$heatmap` no projeto
(0), que era a única outra origem possível. O flag `heatmaps` do `/decide` governa click/rageclick
— e esses de fato nunca ocorreram: as 98 linhas são **todas** `scrolldepth`.

**O que a linha guarda:** `session_id`, `distinct_id`, `x`/`y`, `scale_factor`, viewport,
`current_url`, `timestamp`, `type`. **Não guarda conteúdo de tela** — é o que separa isto do
replay. As 9 URLs distintas são rotas ESTÁTICAS (`/admin/reposicao/pedidos` 72 · `/sales/new` 8 ·
`/` 8 · `/sales` · `/telefonia` · `/settings` · `/meu-dia` · `/financeiro/cockpit` ·
`/admin/route-planner`), sem id no path nem query string: nenhum identificador de cliente escapa
pela URL. Janela 2026-05-29 → 2026-08-25, 3 `distinct_id`, 75 sessões.

**Veredito: não é exposição nova, e não há o que tratar.** `distinct_id` + rota + horário já estão
no `$pageview`, que capturamos de propósito; o heatmap acrescenta profundidade de rolagem e
tamanho de viewport. Fica registrado porque (a) inventário que só lista o que alguém lembrou de
configurar não é inventário, e (b) se um dia a decisão for cortar esta coleta, o desligamento
**não** é o toggle do projeto nem uma linha com a palavra `heatmap`: é `capture_pageleave: false`,
que levaria junto o `$pageleave` inteiro. Não mexer sem essa conta.

⚠️ **A lição que generaliza:** superfície de coleta não se enumera pelo `grep` do config. Este
config não menciona heatmap e alimenta uma tabela; o config do replay mencionava e não alimentava
nenhuma. **Config é INTENÇÃO; tabela é EFEITO** — inventário de coleta se faz pelo lado que
ARMAZENA, varrendo as tabelas do HogQL, e o lado que PEDE serve para explicar o achado, não para
produzir a lista.
