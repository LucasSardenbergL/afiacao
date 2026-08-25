# Proxy de ingestão do PostHog — desenho

> **Status:** desenho aprovado (2026-08-25). Implementação em plano separado.
> **Origem:** [`fase-sem-sinal.md`](../../historico/fase-sem-sinal.md) §"A telemetria muda tem causa
> PROVADA" (PR #1984) · [`analytics.md`](../../agent/analytics.md) §"A amostra é CENSURADA".

## 1. O problema, medido

`us.i.posthog.com` está nas listas de bloqueio comuns. Provado em 2026-08-25 com **par de
falsificação** — mesma máquina, rede, alvo e minuto:

| cliente | `fetch('https://us.i.posthog.com/i/v0/e/')` |
|---|---|
| Chromium limpo | `200 {"status":"Ok"}` em **1112 ms** |
| Chrome real do founder (151) | `TypeError: Failed to fetch` em **4 ms** |

No MESMO Chrome bloqueado, `us-assets.i.posthog.com` (547 ms), Supabase (422 ms) e
`fonts.googleapis.com` (154 ms) **passam**. Morre só o endpoint de ingestão.

**A consequência que motiva este trabalho** não é o aparelho do founder: é que a amostra fica
**censurada, não esparsa**, e a censura correlaciona com quem usa mais. Cliente bloqueado e cliente
que não usou produzem **o mesmo zero** — o que envenena toda decisão de "fase N+1 exige sinal da
fase N" lida pelo PostHog.

## 2. Decisões tomadas (e as alternativas recusadas)

| decisão | escolhido | recusado, e por quê |
|---|---|---|
| **Onde hospedar** | Edge function do Supabase | Domínio próprio + Cloudflare Worker (caminho de deploy NOVO, fora de Lovable+Supabase, sem dono no repo) · proxy gerenciado do PostHog (exige domínio próprio **e** plano pago) |
| **Escopo do tráfego** | Tudo que o SDK já manda hoje | Só `track()`+pageview (perderia o denominador do autocapture) · só aparelhos internos (não resolve a população externa, que é o motivo do trabalho) |
| **Se o proxy cair** | Sem fallback; a edge se mede | Fallback pro host direto (reintroduz a ambiguidade recém-eliminada) · fallback carimbado (mais código, e o carimbo só chega quando o evento chega — não mostra a queda) |

⚠️ **`supabase.co` não é literalmente first-party.** Foi escolha consciente: o domínio não está em
lista de bloqueio nenhuma, então derruba o bloqueador na prática, ao custo de o proxy acompanhar o
backend se um dia ele mudar. Um domínio próprio continua sendo o upgrade natural.

## 3. Arquitetura

```
browser ──> fzvklzpomgnyikkfkzai.supabase.co/functions/v1/posthog-proxy/<caminho>
                          │
                          ├─ /static/*, /array/*  ──> us-assets.i.posthog.com
                          └─ resto (allowlist)    ──> us.i.posthog.com
```

### 3.1 Por que o proxy PRECISA rotear dois upstreams

Não é opcional nem "por garantia". Verificado na fonte do `posthog-js` **1.373.4** instalado
(`node_modules/posthog-js/dist/module.js`, `endpointFor`):

```js
if(this.region===Rn)return this.apiHost+e;
```

O trecho é **literal do bundle minificado** (por isso ilegível): `Rn` é a constante `"custom"` e `e`
é o caminho já normalizado com `/` na frente. Um `api_host` que não casa
`/(app|us|us-assets)(\.i)?\.posthog\.com/` faz a região virar `"custom"`,
e aí **todo** tipo de endpoint — inclusive `assets` — resolve para `apiHost + caminho`. Ou seja: ao
apontar o `api_host` pro proxy, o SDK passa a pedir `/static/surveys.js` e
`/array/<token>/config.js` **do proxy também**. Um proxy que só encaminhasse a ingestão deixaria o
SDK sem config remota.

### 3.2 Roteamento

| caminho recebido | upstream | classe (p/ o contador) |
|---|---|---|
| `/static/*` | `us-assets.i.posthog.com` | `assets` |
| `/array/*` | `us-assets.i.posthog.com` | `assets` |
| `/i/v0/e/`, `/e/`, `/batch/` | `us.i.posthog.com` | `ingest` |
| `/flags*`, `/decide*` | `us.i.posthog.com` | `flags` |
| `/s/*` (recorder) | `us.i.posthog.com` | `replay` |
| qualquer outro | — **404** | `recusado` |

Método, query string e corpo passam **crus**. O corpo pode vir `gzip`-ado
(`?compression=gzip-js`) ou como `x-www-form-urlencoded` com `data=<base64>` — o proxy **não
interpreta**, repassa bytes.

### 3.3 O que torna a edge segura (é o risco real, não a latência)

Uma edge pública que encaminha para fora é um **open proxy** se mal feita.

- **O upstream NUNCA vem da requisição.** Dois hosts fixos no código; host vindo do cliente é
  ignorado, não sanitizado.
- **Allowlist de caminho** (tabela acima). Fora dela: `404`, sem encaminhar.
- **Headers de entrada descartados**, exceto `content-type` e `content-encoding`. Em especial o
  `Authorization` do cliente **não sobe** — senão o JWT do Supabase vaza pro PostHog.
- **Cookies não sobem** (nem `Cookie`, nem repasse de `Set-Cookie` de volta).
- **Teto de corpo** de 1 MB; acima disso `413`.
- `verify_jwt = false` no `config.toml` — **obrigatório**, não conveniência: o `$pageview` acontece
  antes do login, e o caminho `keepalive` não consegue mandar header de auth.
- CORS: origem do app em allowlist, `POST, GET, OPTIONS`, `access-control-max-age: 3600`.

## 4. A edge se mede (o único sinal honesto de adoção)

Incremento atômico por `(dia, classe, status_upstream)` — **uma linha por dia/classe/status**, não
por requisição. Chamado em **fire-and-forget** (`EdgeRuntime.waitUntil`) para não somar latência à
resposta proxiada.

```sql
create table public.posthog_proxy_stats (
  dia    date     not null,
  classe text     not null,   -- ingest | assets | flags | replay | recusado
  status smallint not null,   -- status do upstream (0 = falha de rede)
  n      bigint   not null default 0,
  primary key (dia, classe, status)
);
```

Escrita por RPC `SECURITY DEFINER` com `on conflict … do update set n = n + 1`, chamada pela edge
com a service role. **`REVOKE` nomeando `anon` e `authenticated`** (a regra do `database.md`:
`REVOKE FROM PUBLIC` não tira as duas). RLS ligada na tabela desde a criação.

**Por que isto existe:** é o contador **imune ao bloqueador e ao próprio PostHog**. Sem ele, "o
proxy quebrou" e "ninguém usou" voltam a ser o mesmo zero — exatamente o defeito que este trabalho
existe para corrigir. Com ele, a queda se lê pelo `psql-ro`, sem depender do canal que caiu.

## 5. Mudança no cliente: zero código

`src/lib/analytics.ts:32` **já** lê a env:

```ts
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
```

Basta definir `VITE_POSTHOG_HOST` no Lovable apontando pra edge. Nenhuma linha de TS muda.

## 6. O que este desenho NÃO resolve — explícito de propósito

**A 4ª camada de deploy.** O efeito só chega depois de env → rebuild → Publish → **o cliente aceitar
o SW** (`registerType: 'prompt'`, `skipWaiting` removido de propósito). Clientes existentes seguem no
host antigo por tempo indefinido.

E o círculo que isso fecha: **os clientes bloqueados são justamente os que não conseguimos ver
aceitando**. Medir a adoção do proxy pelo PostHog seria circular. É por isso que o contador da §4 não
é enfeite — é o **denominador**, e a leitura de sucesso sai dele, não da série de eventos.

### Lacuna conhecida, registrada como tal

No `endpointFor`, `flagsApiHost` é consultado **antes** do ramo `custom`. Se ele não herdar o
`api_host`, feature flags continuariam saindo pelo host bloqueado. Não quebra evento, e o app não
aparenta usar flags. **Verificar na implementação** — não trava o desenho, e registrar aqui evita
que vire descoberta cara depois.

## 7. Teste

- **Lógica de roteamento extraída PURA** (`rotearCaminho(pathname) → {upstream, classe} | null`),
  testada pela suíte Deno. O `test:edges` roda com `--no-remote` ⇒ o teste **não pode ter import
  remoto**; extrair a função pura é o que torna isso possível. **Nunca afrouxar o flag.**
- **Falsificação obrigatória**, e ela é o teste que importa: sabotar a allowlist (aceitar um caminho
  fora dela) e **exigir vermelho**. Um teste de allowlist que passa com a allowlist quebrada é
  teatro. **Commitar antes de falsificar** — `restaurar()` costuma ser `git checkout --`.
- Casos negativos que precisam de asserção própria: host vindo do cliente é ignorado · `Authorization`
  de entrada não aparece na requisição upstream · corpo > 1 MB devolve `413`.
- Lembrar dos **3 gates de edge** que não se cobrem (`test:edges`, `edges:typecheck`, e o vitest que
  lê a edge como TEXTO).

## 8. Deploy — três camadas manuais, nesta ordem

1. **Migration** (tabela + RPC + RLS + REVOKE) — via SQL Editor do Lovable, pelo ritual
   `lovable-db-operator`. Não auto-aplica, e a falha é silenciosa.
2. **Edge** `posthog-proxy` — deploy manual.
3. **Env `VITE_POSTHOG_HOST`** no Lovable + **Publish**.

A ordem importa: env antes da edge existir manda todo evento para um 404.

## 9. Verificação em produção — o mesmo par que provou o problema

Não basta "está no ar". A prova é a assimetria de hoje **invertida**:

1. Contador da §4 subindo (`psql-ro`) — prova que a edge recebe.
2. **`$pageleave` com `$lib='web'` saindo do Chrome BLOQUEADO do founder** — o cliente que hoje
   emite zero. Esse é o sinal que não existe hoje e que nenhum outro substitui.
3. Controle negativo: com a env revertida, o mesmo Chrome volta a não emitir.

## 10. Rollback

Apagar a env `VITE_POSTHOG_HOST` no Lovable e republicar: o `?? 'https://us.i.posthog.com'` do
`analytics.ts:32` devolve o comportamento atual. A edge e a tabela podem ficar — inertes, sem
tráfego. Rollback **não** exige tocar em banco.
