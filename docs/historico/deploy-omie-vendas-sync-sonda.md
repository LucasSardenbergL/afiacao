# Deploy da `omie-vendas-sync` — a fatia da sonda (#2026 + #2054)

> Registro do que foi pedido ao Lovable e de como o deploy se prova. **Perecível por natureza**
> (vale até o deploy acontecer), mas fica como AUDITORIA: o que foi pedido, e qual evidência foi
> exigida. Montado em 2026-08-28 com a skill `lovable-deploy-verify`.
> Camadas: **edge = SIM** · migration = não · frontend = já estava no ar (provado pelos bytes).

## Os 4 arquivos — e por que 4, não 1

O prompt canônico de deploy de edge nomeia **um** arquivo (`index.ts`). Ele quebra exatamente na fatia
que INSTRUMENTA a edge, e aqui quebraria de duas formas. A lista sai do `git show --name-status` dos
commits, **nunca da memória**:

```bash
git show --name-status --format='' 231425fa5 -- supabase/functions/ | grep -v '_test\.ts$'
git diff --name-only 97194df1b origin/main -- supabase/functions/omie-vendas-sync/ supabase/functions/_shared/
```

| arquivo | por quê |
|---|---|
| `omie-vendas-sync/index.ts` | modificado |
| `omie-vendas-sync/versao.ts` | **NOVO** — o `index.ts` o importa na linha 3; sem ele a função **não boota** |
| `_shared/sonda-versao.ts` | modificado **desde o último deploy** (#1974) e entra no bundle desta edge |
| `_shared/sonda-fingerprints.ts` | modificado — alimenta o campo `fonte`; sem ele a sonda responde `nao-mapeada` |

⚠️ **O terceiro só apareceu porque a lista foi derivada do intervalo desde o ÚLTIMO DEPLOY, não desde o
PR.** Derivar do PR daria 3 arquivos e um bundle parcial — e o modo de falha do parcial é traiçoeiro: o
`fonte` servido é um **literal do mapa embutido no bundle**, não um hash recalculado em runtime. Se o
mapa subir e outro `_shared/` ficar para trás, o `fonte` responde o valor NOVO com código velho junto:
**falso verde**. O ramo `DEPLOY PARCIAL` do SQL só pega o caso inverso (o mapa é que fica para trás).

🔗 **Este doc cobre a dimensão TEMPO da fatia; a dimensão GRAFO está em**
[closure-de-hash-nao-e-lista-de-deploy.md](closure-de-hash-nao-e-lista-de-deploy.md) (2026-08-29,
sessão paralela): a `fecharGrafo()` de `sonda-fingerprint.ts` é autoritativa para o HASH e ERRADA
para o DEPLOY, porque exclui o `sonda-fingerprints.ts` de propósito — a fatia é o **closure ∪
{mapa}**. As duas dimensões são necessárias e nenhuma cobre a outra: o `_shared/sonda-versao.ts`
desta fatia está no closure, mas só se soube que precisava SUBIR ao comparar com o último deploy.

`_shared/omie-deadline.ts` também mudou no intervalo, mas **não está no fecho transitivo** desta edge
(só outras 5 a importam) — conferido import a import, não presumido.

## 1) 💬 chat do Lovable

> Edit the edge function `omie-vendas-sync` and update it from the `main` branch using the current
> contents of these files. Deploy them **verbatim** — do NOT modify, reinterpret, "improve", or reformat
> the code:
> - `supabase/functions/omie-vendas-sync/index.ts` (modified)
> - `supabase/functions/omie-vendas-sync/versao.ts` (**NEW file** — `index.ts` imports it on line 3; without it the function will not boot)
> - `supabase/functions/_shared/sonda-versao.ts` (modified — shared module this function bundles)
> - `supabase/functions/_shared/sonda-fingerprints.ts` (modified — shared module this function bundles)
>
> After deploying, confirm it shows **Active**.

⚠️ **Só sonde DEPOIS do `Active`.** Bundle pré-sensor ignora o `{"probe":true}` e **roda o fluxo real** —
e esta edge escreve no Omie sem desfazer.

## 2) 🟣 SQL Editor — sonda (prova QUAL BUNDLE subiu)

Gerado por `bun run sonda:sql omie-vendas-sync`, que desde o **#2052** exige o `fonte` no julgamento e
tem ramo próprio de `DEPLOY PARCIAL`.

```sql
-- PASSO 1 — dispara as 1 edge(s) baratas da leva.
WITH alvos(edge) AS (VALUES
  ('omie-vendas-sync')
),
disparos AS (
  SELECT a.edge,
         net.http_post(
           url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/' || a.edge,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                               WHERE name = 'CRON_SECRET' LIMIT 1)),
           body := jsonb_build_object('probe', true),
           timeout_milliseconds := 20000) AS request_id
  FROM alvos a
)
SELECT jsonb_object_agg(edge, request_id)::text AS cole_no_passo_2
FROM disparos;

-- PASSO 2 — lê e julga. Cole o JSON do PASSO 1 no lugar do {}, NA MESMA ABA.
WITH esperado(edge, versao_esperada, fonte_esperada) AS (VALUES
  ('omie-vendas-sync', 'v1.0-sensor-inicial', '47c046a59818384ab1c4415db9e240e5de0a4217471c38d202d0fed0f4c70efd')
),
ids AS (
  -- ⬅️ COLE AQUI, no lugar do {}, a célula única devolvida pelo passo de disparo.
  SELECT chave AS edge, valor::bigint AS request_id
  FROM jsonb_each_text('{}'::jsonb) AS t(chave, valor)
),
lidas AS (
  SELECT e.edge, e.versao_esperada, e.fonte_esperada, i.request_id, r.status_code,
         COALESCE(r.content::jsonb -> 'data', r.content::jsonb) AS corpo
  FROM esperado e
  LEFT JOIN ids i ON i.edge = e.edge
  LEFT JOIN net._http_response r ON r.id = i.request_id
)
SELECT l.edge,
       l.request_id,
       l.status_code,
       l.corpo ->> 'edge'   AS edge_respondida,
       l.corpo ->> 'versao' AS versao_respondida,
       l.versao_esperada,
       l.corpo ->> 'fonte'  AS fonte_respondida,
       CASE
         WHEN l.request_id IS NULL
           THEN 'SEM ID — esta edge não saiu no JSON colado (bloco errado, ou trava fechada)'
         WHEN l.status_code IS NULL
           THEN 'AGUARDE — a resposta HTTP ainda não chegou (leva ~10s); rode este passo de novo'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400
           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'
         WHEN l.corpo ->> 'versao' IS NULL
           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'
         WHEN COALESCE(l.corpo ->> 'fonte', 'nao-mapeada') = 'nao-mapeada'
           THEN 'DEPLOY PARCIAL — subiu index.ts+versao.ts, mas _shared/sonda-fingerprints.ts NAO'
         WHEN l.corpo ->> 'versao' = l.versao_esperada
              AND l.corpo ->> 'fonte' = l.fonte_esperada
              AND l.corpo ->> 'probe' = 'true'
              AND l.corpo ->> 'edge' = l.edge
           THEN 'DEPLOY CONFIRMADO'
         ELSE 'BUNDLE VELHO — respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||
              ', fonte=' || COALESCE(l.corpo ->> 'fonte', '?') ||
              ', edge=' || COALESCE(l.corpo ->> 'edge', '?') ||
              ' (esperado ' || l.versao_esperada || ' / ' || l.fonte_esperada || ')'
       END AS veredito
FROM lidas l
ORDER BY l.edge;
```

## 3) 🟣 SQL Editor — canária (prova o COMPORTAMENTO)

⚠️ **As DUAS chamadas são necessárias nesta fatia** — é o achado do #2054
([codex-canaria-sem-fonte.md](codex-canaria-sem-fonte.md)): a canária **não ecoa `fonte`**, então
sozinha ela não discrimina mudança em `_shared/` — e esta fatia mexe em **dois** arquivos de lá.

```sql
-- 3a) dispara
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('action','identidade_probe'),
  timeout_milliseconds := 20000) AS request_id;
```

```sql
-- 3b) lê e julga — troque o marcador pelo id do 3a (nasce INVÁLIDO de propósito: id de
-- exemplo plausível devolve a linha real de OUTRO emissor — Lei de Ferro #5)
WITH r AS (
  SELECT status_code, COALESCE(content::jsonb -> 'data', content::jsonb) AS corpo
  FROM net._http_response WHERE id = COLE_AQUI_O_REQUEST_ID
)
SELECT status_code,
       corpo ->> 'canary' AS canary, corpo ->> 'contrato' AS contrato,
       corpo ->> 'versao' AS versao, corpo ->> 'ok' AS ok,
       corpo -> 'casos_vermelhos' AS vermelhos,
       CASE
         WHEN status_code IS NULL THEN 'AGUARDE — resposta ainda não chegou; rode de novo'
         WHEN corpo ->> 'canary' IS NULL
           THEN 'BUNDLE VELHO — sem canary: ignorou o param e RODOU O FLUXO REAL'
         WHEN corpo ->> 'contrato' = 'identidade-a2-client-to-user-v3'
              AND corpo ->> 'canary' = 'true' AND corpo ->> 'ok' = 'true'
              AND corpo ->> 'versao' = 'v1.0-sensor-inicial'
           THEN 'CANARIA CONFIRMADA'
         ELSE 'DIVERGENTE — contrato=' || COALESCE(corpo ->> 'contrato','?') ||
              ' versao=' || COALESCE(corpo ->> 'versao','?') ||
              ' ok=' || COALESCE(corpo ->> 'ok','?')
       END AS veredito
FROM r;
```

## Veredito — exige os DOIS verdes

| bloco | verde é |
|---|---|
| 2 (sonda) | `DEPLOY CONFIRMADO` — `versao=v1.0-sensor-inicial` **e** `fonte=47c046a5…` |
| 3 (canária) | `CANARIA CONFIRMADA` — `contrato=identidade-a2-client-to-user-v3`, `ok=true`, `casos_vermelhos` vazio |

- **`DEPLOY PARCIAL`** (`fonte=nao-mapeada`): o Lovable deixou o `_shared/sonda-fingerprints.ts` para
  trás — repita o passo 1 insistindo nos 4 arquivos.
- **`PRE-SENSOR`** (HTTP 200 sem `versao`): bundle velho **e ele já executou o efeito caro**.

## Estado do frontend na mesma data

Verificado pelos bytes em 2026-08-28 (`verify-frontend.sh --pai d7070b6f6^ 'afiacao_telemetria_device_id'`):
**no ar**, entry `/assets/index-BM_UJQwt.js`, 334 chunks (closure ∪ precache), com os três controles
verdes — sentinela exclusiva provada no git, `LIB_SEM_A_SENTINELA` (sem 2º emissor em `node_modules`) e
`CONTROLE_NEGATIVO_OK`. E `d7070b6f6` era o último commit a tocar `src/`, então o ar correspondia à main
inteira, não só àquele commit. **Anote o hash do entry:** hash igual numa verificação futura = bundle
velho, suspeite antes de comemorar.
