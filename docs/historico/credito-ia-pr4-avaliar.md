# Crédito-IA PR 4 — a IA propõe o limite do grupo; só o Lucas aprova (2026-11-26)

PR [#4197](https://github.com/LucasSardenbergL/afiacao/pull/4197) (merge `9efe21ae2`). Plano: `docs/superpowers/plans/2026-11-20-credito-ia.md` §PR 4.

## O que entrou

- **Ficha do grupo** (`credito_ficha(raiz)`): só números/enums/flags, ausente ⇒ `NULL` + motivo. Tetos e risco
  forçado saem do SQL (K = 3× compra média mensal 180 d; novo comprovado = R$ 5.000 / 28 d; piso ≥ 60 d ⇒ 0 + alto;
  inconclusivo ⇒ 0 + sem evidência; sync > 48 h ⇒ sem evidência). Prazo ≤ degrau seguinte ao maior prazo honrado.
- **Writer único** `credito_registrar_avaliacao`: token de reivindicação (`SKIP LOCKED` + TTL), **recalcula a
  ficha** e recusa a enviada que diverge, reconfere as travas, recusa grupo com vigente, expira a pendente anterior,
  backoff persistido em falha. `credito_propor_limite` sem EXECUTE para ninguém.
- **Aprovação endurecida** (`credito_aprovar_proposta`, guarda md5 do corpo de prod) + **lote**
  (`credito_aprovar_propostas_lote`, ≤ 50, decisão individual por id).
- **Edge `credito-ia-avaliar`** (Anthropic direto, tool-use não-forçado, entrada por lista fechada) e **cron**
  `*/15` (`timeout_milliseconds` 150 s; só acorda com raiz elegível).
- **Tela `/credito/limites`**: fila por faixa, aprovar a faixa em blocos de 50, recusar, "Avaliar agora", progresso.

## Deploy (evidência)

| Camada | Como | Evidência |
|---|---|---|
| Migration `20261126090000` | `db:aplicar` (ensaio → apply) a partir da main | recibo **#1448**, sha256 `6bbd37ca…d83f`; guardas md5 batiam no pré-voo; 2ª testemunha psql-ro: tabela+RLS, índice de pendente única, `aprovar` com `ficha_superada`, ACL allowlist exata, cron ativo |
| Edge | Lovable MCP, pacote `aaebd65515ec` (envio 10:33:01Z) | 11/11 sha256 conferidos pelo agente, `No files were edited.`; sonda (recibo **#1452**) **DEPLOY CONFIRMADO** `v1.0-ficha-claude-travas-writer-unico` |
| Sensor de edição | `lovable-sensor-edicao.ts` 31 min após o envio | **SEM_EDICAO** (0 commits `gpt-engineer-app`) |
| Cron `*/15` | `cron.job_run_details` + `credito_avaliacao` | ticks 10:45Z e 11:00Z `succeeded`; às 11:04Z: **24 grupos avaliados, 23 propostas `pendente`, 1 erro** (`stop_reason=max_tokens`, em backoff de 15 min — falha fechada, sem proposta) de 517 na fila ⇒ 1ª leva completa em ~11 h a 12 grupos/tick |
| Publish | founder | feito 2026-11-26; `credito/limites` presente no bundle servido (`/assets/index-*.js` de `steu.lovable.app`) |
| Fix `max_tokens` ([#4211](https://github.com/LucasSardenbergL/afiacao/pull/4211)) | redeploy Lovable MCP (envio 15:48:28Z), pacote `1da42191fea1` | 11/11 sha256; sonda (recibo **#1475**) **DEPLOY CONFIRMADO** `v1.1-max-tokens-4096`. Às 15:53Z: 242/517 avaliados, 237 pendentes, 5 erros — todos `max_tokens` de ANTES do redeploy (retentam na v1.1) |

**Sensor `EDICAO_DETECTADA` no redeploy, sem revert (decisão):** a resposta do MCP trouxe `edit_id`/`commit_sha`
e o sensor sai 1 por esse sinal, mas o único commit do bot (`2d4dbfc34`) é o `types.ts` **regenerado** (a tabela
`credito_reducao_verificacao` da migration `20261126150000` de outra sessão, já em prod) — o próprio sensor o lista
como "tolerado · 0 fora dos gerados tolerados". Reverter deixaria o `types.ts` defasado da prod.

## Lições

- **Timestamp de migration colide entre PRs paralelos** — o 1º nome (`20261125120000`) já existia em 2 migrations da
  main; renomear antes do merge. Busque `ls supabase/migrations/<prefixo>*` em `origin/main` ao criar.
- **`FILTER` vazio ⇒ `NULL`, não 0**: `sum(x) FILTER (WHERE atrasou) / sum(x)` dá `NULL` para quem paga em dia.
  A prova PG17 pegou; o certo é `COALESCE(sum … FILTER, 0)` só no numerador (o denominador ausente segue `NULL`).
- **Edge nova com `versao.ts` precisa entrar no contrato** `_shared/sonda-versao-contrato_test.ts` — o
  `test:edges` falha no CI ("EDGES cobre TODA pasta com versao.ts"), não no `sonda:nova`.
- Achado à parte (não corrigido aqui): as policies de SELECT do PR 2 chamam `pode_ver_carteira_completa`, sem
  EXECUTE para `authenticated` em prod ⇒ leitura direta nega até o gestor; as telas leem por RPC definer.
