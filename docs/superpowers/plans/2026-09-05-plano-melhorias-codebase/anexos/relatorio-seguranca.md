# Auditoria de segurança (estática, read-only) — Afiação · 2026-09-05

Worktree: `/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/intelligent-yalow-39d4e7` (branch `claude/code-improvements-plan-2bc5f9`, HEAD `9fe4e8880`).
Método: só leitura (rg/grep/awk/sed/git log). Nada executado contra prod, banco ou edges. O snapshot (`supabase/schema-snapshot.sql`) é `--no-privileges`: **grants de função NÃO são mensuráveis aqui** — onde isso importa, está marcado como incerteza.

Severidade: P0 = exploração trivial por cliente logado/anônimo · P1 · P2 · P3 higiene. I=Impacto · R=Risco (probabilidade) · E=Esforço, 1–5.

## Panorama

- A fundação está sólida e é DESENHO documentado: 336/336 tabelas com RLS; 703 policies das quais só **2 escritas permissivas** para `authenticated` (as duas viraram o achado A1); os 95 edges têm gate interno (81 via `authorize*` compartilhado, 8 por segredo de webhook/gate local, 3 por JWT de usuário com cota, `mcp` por OAuth próprio, `biometric-auth` pré-login por desenho); zero segredo real versionado (varredura por padrão só achou o JWT anon em `.env`); zero SQL dinâmico concatenado; XSS do popup Leaflet já escapado; open-redirect do `next` allow-listado; escalada por `profiles` self-insert fechada (`WITH CHECK (is_employee = false)` em INSERT e UPDATE).
- O que sobrou é **residual e sistêmico**, não furo trivial: (1) duas policies `WITH CHECK (true)` deixadas para trás; (2) PII de conversa (transcrições) sem retenção; (3) a sentinela de RLS viva não cobre fator de autenticação nem receita nem PII de conversa; (4) o write-guard da lente não intercepta `.rpc()` e depende de disciplina por callsite.
- Não medível estaticamente (fora do repo): config de auth do Supabase (rate-limit/captcha/OTP/senha — `config.toml` não tem `[auth]`), policies de storage (buckets `tool-photos`, `tarefa-comprovacoes`), grants reais de funções, e se a edge `mcp` está deployada.

## Achados

Formato: `ID | Pn | título | categoria | evidência | cenário de abuso | proposta | I·R·E`

### A1 | P2 | INSERT `WITH CHECK (true)` para `authenticated` em duas tabelas de reposição | authz
- **Evidência:** `supabase/schema-snapshot.sql` — `CREATE POLICY reposicao_motor_run_ins ON public.reposicao_motor_run FOR INSERT TO authenticated WITH CHECK (true)`; `CREATE POLICY estoque_nao_confirmado_log_ins ON public.reposicao_estoque_nao_confirmado_log FOR INSERT TO authenticated WITH CHECK (true)`. SELECT das duas é gated por `private.cap_compras_ler`. Escritor legítimo é a RPC `gerar_pedidos_sugeridos_ciclo` (snapshot L11049, **SECURITY INVOKER**, `INSERT INTO public.reposicao_motor_run` em L11484) — não achei `.rpc('gerar_pedidos_sugeridos_ciclo')` em `src/` nem em `supabase/functions/` (provável chamada por cron/service_role), logo a policy `true` é superfície sem consumidor cliente. A `reposicao_estoque_nao_confirmado_log` é lida pelo cockpit staff `src/pages/AdminReposicaoPedidos.tsx:268-278` (últimas 24h, colunas `sku_codigo_omie, sku_descricao, motivo, grupo_codigo, run_id`).
- **Abuso:** qualquer `customer` aprovado faz `POST /rest/v1/reposicao_estoque_nao_confirmado_log` com `empresa`/`sku_descricao`/`motivo` arbitrários e a linha aparece na tela de decisão de compras como "SKU não confirmado" (dado fabricado num fluxo money-path; sem XSS, React escapa). Em `reposicao_motor_run` forja "runs" (`pedidos_gerados`, `skus_incluidos`) que alimentam contadores de ciclo.
- **Proposta:** trocar `WITH CHECK (true)` por `WITH CHECK ((SELECT private.cap_compras_escrever((SELECT auth.uid()))))` (ou remover a policy, se o único escritor for service_role — que bypassa RLS). Provar sob `SET ROLE authenticated` + GUC com `db/test-*.sh` exigindo 42501 para customer; incluir as duas no contrato `scripts/authz-rls-esperado.ts` (ver A3).
- **I=3 · R=3 · E=1**

### A2 | P2 | Transcrições de ligação e WhatsApp sem política de retenção/expurgo | LGPD
- **Evidência:** colunas `public.farmer_calls.transcript jsonb` (snapshot L25845), `farmer_copilot_events.transcript_snippet` (L26022), `farmer_copilot_sessions.transcript_summary` (L26050), `whatsapp_messages.transcript text` (L34687). Escrita viva: `src/contexts/WebRTCCallContext.tsx:86` envia `transcript` para a edge após a chamada. Nenhum job de expurgo: `supabase/migrations/20260527230000_cron_baseline.sql` só tem `purge-cron-job-run-details` (L113) e `call-log-missed-backstop` (L45); zero `DELETE FROM public.(farmer_calls|whatsapp_messages|farmer_copilot_*)` em `supabase/migrations`, `db/` e `supabase/functions/`. O aviso LGPD pré-roll existe (`docs/agent/telefonia.md`, `public/preroll/aviso-gravacao-lgpd.mp3`), mas aviso ≠ base legal para guarda indefinida.
- **Abuso/risco:** conteúdo de conversa com terceiros (clientes, decisores) acumulado sem prazo; qualquer incidente de conta staff (a RLS `wa_msg_staff_all` dá a TODO employee todas as mensagens) expõe o histórico inteiro; pedido de eliminação (LGPD art. 18) não tem rota operacional.
- **Proposta:** definir prazo (ex.: 12 meses para `transcript` bruto, manter só `transcript_summary`) e criar cron `DELETE`/`UPDATE … SET transcript = NULL` com `timeout_milliseconds` explícito; registrar prazo + base legal na política de privacidade interna; considerar restringir `wa_msg_staff_all` a owner/gestor (mesmo split leitura>escrita já usado em `sales_orders`).
- **I=3 · R=3 · E=2**

### A3 | P2 | Sentinela `authz:rls:prod` não cobre fator de autenticação, receita nem PII de conversa | authz (sistêmico)
- **Evidência:** `scripts/authz-rls-esperado.ts` congela 33 tabelas (`profiles`, `user_roles`, `commercial_roles`, `sales_orders`, `order_items`, `fin_*`, `cmc_*`, `customer_contacts`…). Fora do contrato (0 menções): `webauthn_credentials` (policies OWN — `user_id = auth.uid()`; é o segundo fator), `tint_formula_itens` (hoje "Staff can manage" master/employee — a receita que o founder decidiu proteger em `supabase/schema-security-report.md`), `whatsapp_messages`/`whatsapp_conversations`/`farmer_calls` (PII), `reposicao_motor_run`/`reposicao_estoque_nao_confirmado_log` (A1), `company_config` (guarda `master_cpf`, lido por `auto_assign_commercial_super_admin`, snapshot L4757).
- **Abuso/risco:** exatamente o vetor descrito em `docs/historico/rls-viva-fora-do-alcance-dos-audits.md` §1 — um `CREATE POLICY … USING (true)` ou `DISABLE ROW LEVEL SECURITY` colado no SQL Editor nessas tabelas sai verde nos quatro audits.
- **Proposta:** adicionar ao contrato (`tabela` + md5 do predicado) pelo menos `webauthn_credentials`, `tint_formula_itens`, `whatsapp_messages`, `farmer_calls`, `company_config` e as duas de A1 (após corrigir); remover de `LACUNAS_DECLARADAS` no mesmo PR se constarem. Regra do próprio doc: "pergunte se o gate DAQUELA tabela já é congelado por alguém".
- **I=4 · R=2 · E=2**

### A4 | P3 | Write-guard da lente "Ver como" não intercepta `.rpc()` — proteção é por disciplina de callsite | authz (lente)
- **Evidência:** `src/lib/impersonation/lens-write-guard.ts:12-14,80-109` bloqueia `from().insert/update/upsert/delete`, storage mutante e `functions.invoke`; o comentário em L106-109 declara: "`select`, `rpc`, `auth`, realtime … passam" e "NÃO é barreira de segurança". Callsites mutantes que usam identidade da persona: `src/hooks/useCrossSellEngine.ts:1147` e `src/hooks/useBundleEngine.ts:1242` chamam `farmer_recomendacoes_substituir` / `farmer_bundle_recomendacoes_substituir` com `p_farmer_id: effectiveUserId`; ambos se protegem com `if (!isImpersonating)` (L1136 e L1211). A RPC aceita `p_farmer_id = auth.uid() OR cap_carteira_escrever(auth.uid())` (snapshot L7510-7522) — master tem a capability, então **se um callsite futuro esquecer o `if`, o master "vendo como" X regrava as recomendações de X atribuídas a X** (violação da regra-mãe de `docs/agent/impersonation.md`). `useTacticalPlan.ts:770/877` e `useTarefasFase2.ts:167` chamam RPCs mutantes sem guarda a ≤12 linhas, mas com identidade `auth.uid()` real (comentário L298) — não vazam hoje.
- **Proposta:** estender o guard a `rpc` com allowlist de leitura (`get_*`, `*_for`, `*_ler`, `buscar_*`) e bloqueio do resto na lente — ou denylist por sufixo (`_substituir|registrar_|criar_|concluir_|marcar_`); teste-sentinela que sabota um callsite (remove o `if`) e exige bloqueio.
- **I=3 · R=2 · E=2**

### A5 | P3 | Sessão em `localStorage` sem logout por inatividade em dispositivos compartilhados (chão de fábrica) | segurança
- **Evidência:** `src/integrations/supabase/client.ts:16` — `auth: { storage: localStorage, persistSession: true, autoRefreshToken: true }`; nenhuma ocorrência de idle/inatividade/auto-logout em `src/` (grep `inactiv|idle|ociosid|auto.?logout` só acha estados do WebRTC). Personas separador/conferente operam PWA offline-first em tablets compartilhados (CLAUDE.md §Auth & roles).
- **Abuso:** tablet de picking esquecido logado como employee = leitura de TODAS as mensagens WhatsApp (`wa_msg_staff_all`), `profiles` de todos os clientes, cockpits; o refresh token vive no `localStorage` do dispositivo (o doc `revoke-que-nao-revoga.md` já mostrou que refresh token vivo = sessão de master pela API pública).
- **Proposta:** idle-timeout por persona (ex.: 15 min para separador/conferente, com "trocar operador" no `AppShell`) e `sessionStorage` (ou `storage` custom com TTL) para o PWA de chão; `signOut({ scope: 'local' })` ao fechar.
- **I=3 · R=2 · E=2**

### A6 | P3 | Edge `mcp` (scaffold `@lovable.dev/mcp-js`) expõe `search_customers` a qualquer identidade OAuth `authenticated` | authz/superfície
- **Evidência:** `supabase/functions/mcp/index.ts` (auto-gerado; banner "do not edit") a partir de `src/lib/mcp/index.ts:17-19` — `auth.oauth.issuer({ issuer: https://<ref>.supabase.co/auth/v1, acceptedAudiences: "authenticated" })`; tools `echo` e `search_customers` (`.or(name/document/email/phone ilike …)` sobre `profiles`, L47-51). Não declarada em `supabase/config.toml`; `package.json` traz `@lovable.dev/mcp-js ^0.20.0`; nenhum consumidor no repo além do scaffold; `docs/agent/deploy.md` só o cita em contexto de lint. RLS de `profiles` limita: customer só vê a si; **staff vê todos**.
- **Abuso:** se deployada, um app MCP de terceiro que um employee autorize via `/.lovable/oauth/consent` (`src/pages/OAuthConsent.tsx`) consulta CPF/telefone/e-mail de qualquer cliente com o token daquele employee — canal de exfiltração de PII fora do app, sem `track()`/auditoria.
- **Proposta:** remover o scaffold (edge + `src/lib/mcp` + dependência) ou restringir `search_customers` a master e registrar a edge em `config.toml` + manifesto de deploy. **Incerteza:** não medi se está deployada em prod.
- **I=3 · R=2 · E=1**

### A7 | P3 | `.env` versionado sem estar no `.gitignore` | segredos
- **Evidência:** `git ls-files` lista `.env` e `.env.example`; `.gitignore` não tem entrada `.env`. Conteúdo hoje: `VITE_SUPABASE_*` (URL, project id, JWT **anon**) e `VITE_POSTHOG_*` (token público) — varredura por padrões de segredo (`sk-ant-`, `AKIA`, `AIza`, `ghp_`, chave privada, JWT longo) em todo o repo achou **só** o JWT anon em `.env:2`; `git log -S SERVICE_ROLE -- .env*` = vazio.
- **Abuso:** o guard-rail ausente: o próximo `SUPABASE_SERVICE_ROLE_KEY=`/`ANTHROPIC_API_KEY=` colado localmente para "testar" vai para o `git add -A` e para o Lovable sync bidirecional (que já reverteu main uma vez, #1445→#1478).
- **Proposta:** mover as chaves públicas para `.env.example` + injeção em build, ignorar `.env`; se o Lovable exigir `.env` versionado, gate de CI que falha se `.env` contiver chave fora de allowlist (`VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY|VITE_SUPABASE_PROJECT_ID|VITE_POSTHOG_KEY|VITE_POSTHOG_HOST`) ou valor que case padrão de segredo.
- **I=3 · R=2 · E=1**

### A8 | P3 | Payload com PII de cliente em logs de edge | LGPD
- **Evidência:** `supabase/functions/omie-vendas-sync/index.ts:2102` — `console.log('[Omie Vendas] Payload PedidoVenda:', JSON.stringify(payload, null, 2))` (pedido inteiro: CNPJ/CPF, endereço, itens, valores); `omie-nfe-webhook/index.ts:93` — 500 chars do payload NF-e; `omie-sync/index.ts:113` — `JSON.stringify(body.param)`.
- **Abuso/risco:** logs do Supabase são retidos pela plataforma e acessíveis a quem tem o dashboard (Lovable + Supabase), fora do perímetro RLS; dado pessoal duplicado sem prazo.
- **Proposta:** logar só ids/contagens (`codigo_pedido`, `n_itens`) ou redigir `cnpj_cpf`/endereço; helper `redigir()` em `_shared` com teste.
- **I=2 · R=2 · E=1**

### A9 | P3 | Comparação de segredo não constant-time no helper compartilhado e em 1 webhook | segurança
- **Evidência:** `supabase/functions/_shared/auth.ts:33` (`provided === expected` do `CRON_SECRET`), `:52` e `:62` (`token === SERVICE_ROLE`); `gmail-webhook-receiver/index.ts:124` (`auth !== expected`). Contraste: `omie-webhook/index.ts:44,185`, `whatsapp-inbound/index.ts:113,204` e `posthog-error-webhook` usam `timingSafeEq`.
- **Abuso:** oráculo de tempo sobre o segredo do cron/service role. Sobre a internet (jitter do gateway) é impraticável — por isso P3 — mas o helper é usado por 81 edges, então corrigir uma vez fecha tudo.
- **Proposta:** mover `timingSafeEq` para `_shared/auth.ts` e usar nas três comparações + no gmail; teste Deno que exige igualdade só por bytes.
- **I=2 · R=1 · E=1**

### A10 | P3 | `wa_owner_efetivo(p_customer uuid)` SECURITY DEFINER sem gate no corpo nem REVOKE registrado | authz
- **Evidência:** snapshot `CREATE FUNCTION public.wa_owner_efetivo(p_customer uuid) RETURNS uuid … SECURITY DEFINER`, corpo sem `auth.uid()`/`has_role`/`cap_*`/`RAISE` (varredura awk sobre todas as SECDEF com parâmetro `p_<alvo> uuid`: só 4 sem gate — `_carteira_mixgap_for_owner`, `_carteira_positivacao_for_owner`, `_push_enviar` têm `REVOKE` em `supabase/migrations`; **`wa_owner_efetivo` não tem** e não consta das 7 funções auditadas em `docs/historico/revoke-que-nao-revoga.md:472`).
- **Abuso:** com o grant default do Supabase (`EXECUTE` para `anon`/`authenticated`), qualquer logado mapeia `customer uuid → user_id do vendedor dono` — impacto baixo (uuid→uuid), mas é o mesmo padrão que virou IDOR em `_carteira_*_for_owner`. **Incerteza:** grant real não é mensurável no snapshot (`--no-privileges`); confirmar com a query de `schema-security-report.md` via psql-ro.
- **Proposta:** `REVOKE EXECUTE ON FUNCTION public.wa_owner_efetivo(uuid) FROM anon, authenticated, PUBLIC` (nomeando roles) + incluir no contrato `authz-funcoes`.
- **I=2 · R=2 · E=1**

### A11 | P3 | `biometric-auth` (verify_jwt=false, pré-login): rate-limit spoofável e `challenge` grava para qualquer `credential_id` | segurança
- **Evidência:** `supabase/functions/biometric-auth/index.ts:27-33` (`getClientIp` lê `x-forwarded-for`), `:41-46` (rate-limit por esse IP), `:60-84` (ação `challenge` faz `upsert` em `webauthn_challenges` para qualquer `credential_id` ≤500 chars **sem** checar existência em `webauthn_credentials`). A verificação em si é correta (`verifyAuthenticationResponse` com origin allowlist, challenge single-use, counter anti-replay, e **não** emite sessão/magic link — L220-228). Consumo real no app é mínimo (`src/pages/Profile.tsx:43` só `checkRegistration`).
- **Abuso:** anônimo com `x-forwarded-for` rotativo infla `webauthn_challenges` indefinidamente (DoS de tabela/custo), sem ganho de autenticação.
- **Proposta:** gerar challenge só se `credential_id` existir; cron de expurgo de `expires_at < now()`; ou remover a feature se não for adotada.
- **I=2 · R=1 · E=1**

### A12 | P3 | `.or()` com sanitizer próprio, fora do helper canônico e fora do alcance do ESLint | injeção
- **Evidência:** `src/lib/mcp/tools/search-customers.ts:17` (`sanitizeOrTerm` remove `%_,()\"*`), `:45-47` monta `"name.ilike.%${safe}%,…"` num `map` e chama `.or(predicado)`; a regra `no-restricted-syntax` em `eslint.config.js:41-47` só pega template literal **direto** no argumento do `.or(`. Não usa `ilikeOr` de `@/lib/postgrest`. Em `supabase/functions` os 22 `.or(` restantes interpolam só valores calculados no servidor (datas em `omie-financeiro:1710/1728`, ISO em `enviar-pedido-portal-sayerlack:2565`).
- **Abuso:** hoje contido (chars de controle removidos; RLS de `profiles` limita). Risco é de regressão: um `.or(x)` com `x` construído por template passa no lint.
- **Proposta:** usar `ilikeOr`; ampliar a regra ESLint para `.or(<Identifier>)` cujo binding venha de template/concat (ou `no-restricted-syntax` sobre `TemplateLiteral` que contenha `.ilike.`).
- **I=2 · R=1 · E=1**

### A13 | P3 | Três lockfiles coexistem | supply-chain
- **Evidência:** `bun.lock` (347.879 B), `bun.lockb` (198.722 B), `package-lock.json` (469.584 B). CI: `.github/workflows/ci.yml:125,570,667` — `bun install --frozen-lockfile` (honra `bun.lock`). Os outros dois são artefatos stale.
- **Abuso/risco:** o Lovable/npm local resolve por `package-lock.json` e o CI por `bun.lock` → versões diferentes do que foi auditado (os `overrides` de `package.json` — brace-expansion/form-data/js-yaml/nanoid/serialize-javascript/yaml — resolvem para versões corrigidas em `bun.lock`; no `package-lock.json` não verifiquei).
- **Proposta:** apagar `bun.lockb` e `package-lock.json`, adicionar gate no `bun run claude:size`/health que falha se reaparecerem.
- **I=2 · R=1 · E=1**

## Medições

### M1 — Policies por tabela sensível (snapshot; classe do predicado)

Legenda: ROLE = `has_role`/`cap_*`/`pode_*`/`is_super_admin`/`fin_user_can_access`; OWN = `auth.uid() = <col>`; TRUE = `true`; ANYAUTH = `auth.uid() IS NOT NULL`; SVC = `auth.role() = 'service_role'` (redundante). Roles: pub = sem `TO` (todas), auth = `TO authenticated`.

| tabela | SELECT | INSERT | UPDATE | DELETE | ALL | veredito |
|---|---|---|---|---|---|---|
| `profiles` | ROLE (employee/master) + OWN | OWN `AND is_employee=false` | ROLE + OWN `AND is_employee=false` | ROLE master | — | ok (self-escalada fechada; triggers `trg_prevent_self_approval_*`) |
| `user_roles` | ROLE + OWN | — | — | — | ROLE master | ok |
| `commercial_roles` | OWN | — | — | — | ROLE master · ROLE super_admin | ok |
| `webauthn_credentials` | OWN | OWN | OWN | OWN | — | ok, **fora do sentinela** (A3) |
| `webauthn_challenges` | — | — | — | — | `false` (auth+anon) | ok (só service_role) |
| `sales_orders` | OWN + ROLE | ROLE | ROLE | ROLE | — | ok (split por comando, #1477) |
| `order_items` | OWN + ROLE | — | — | — | — | ok |
| `customer_contacts` | ROLE | ROLE | ROLE | ROLE | — | ok |
| `tarefas` | ROLE | ROLE | ROLE | — | — | ok |
| `fin_permissoes` | ROLE | — | — | — | SVC | ok |
| `fin_*` (35 tabelas) | ROLE | ROLE | ROLE | ROLE | SVC | ok |
| `tint_formula_itens` | — | — | — | — | ROLE (master/employee) | ok (hardening entregue), **fora do sentinela** (A3) |
| `tint_bases/colecoes/corantes/embalagens/produtos/subcolecoes`, `warehouses`, `cep_geo`, `municipio_geo` | TRUE (auth) | — | — | — | — | desenho (referência do wizard) |
| `default_prices`, `tool_categories`, `tool_specifications`, `training_modules`, `omie_servicos`, `category_mappings` | TRUE (pub/anon) | — | — | — | — | desenho (storefront) |
| `company_cnpjs` | ANYAUTH | — | — | — | — | ok (dado público) |
| `company_config` | ROLE (employee/master) | — | — | — | ROLE | ok; guarda `master_cpf` — **fora do sentinela** |
| `call_log` | OWN + ROLE | OWN | OWN | — | — | ok |
| `whatsapp_messages` / `whatsapp_conversations` | — | — | — | — | ROLE (qualquer employee/master) | amplo por desenho; sem retenção (A2) |
| `radar_empresas` | ROLE | — | — | — | — | ok |
| `sync_state` | — | RESTRICTIVE ×2 | RESTRICTIVE ×2 | RESTRICTIVE ×2 | ROLE | ok (RESTRICTIVE ANDa com o gate staff) |
| **`reposicao_motor_run`** | ROLE (`cap_compras_ler`) | **TRUE (auth)** | — | — | — | **A1** |
| **`reposicao_estoque_nao_confirmado_log`** | ROLE (`cap_compras_ler`) | **TRUE (auth)** | — | — | — | **A1** |
| `ia_uso_evento`, `ia_uso_limite`, `posthog_error_webhook_log`, `reposicao_param_limbo_log`, `sayerlack_retry_motor_log`, `sku_items_sync_controle`, `whatsapp_sla_digest_log` | (RLS on, zero policy) | | | | | ok (só service_role) |

Totais: 336 tabelas, 336 com RLS; 703 policies — 560 ROLE, 61 OWN, 15 SVC, 17 SELECT `true`, 2 SELECT ANYAUTH, **2 INSERT `true` (A1)**, 9 RESTRICTIVE, 0 escrita ANYAUTH.

### M2 — Edges × `verify_jwt` × gate interno (95 edges com `index.ts`)

| `verify_jwt` (config.toml) | gate interno | n | edges (exceções nominais) |
|---|---|---|---|
| false (50) | `authorizeCronOrStaff`/`authorizeMaster`/`authorizeCron` (`_shared/auth.ts`) | 42 | omie-*, sync-*, fin-cashflow-engine, radar-ingest, whatsapp-send, enviar-push, elevenlabs-scribe-token… |
| false | segredo de webhook `timingSafeEq` | 3 | `omie-webhook` (`x-webhook-secret`), `whatsapp-inbound` (`x-whatsapp-secret`), `posthog-error-webhook` |
| false | JWT de usuário (qualquer logado aprovado) + cota `ia-cota` | 2 | `elevenlabs-transcribe` (`auth.getClaims`), `identify-tool` (`auth.getUser`) — desenho ("customer pode usar") |
| false | JWT + role local | 1 | `tint-sync-agent` |
| false | pré-login por desenho (rate-limit + prova criptográfica) | 1 | `biometric-auth` (A11) |
| true (45) | `authorize*` compartilhado | 39 | fin-*, kb-*, carteira-*, cmc-*, scoring-*… |
| true | `authorizeMaster` **local** (cópia do helper) | 3 | `fin-valor-engine`, `fin-regime-tributario`, `fin-next-best-action` |
| true | segredo `Bearer <GMAIL_WEBHOOK_SECRET>` (`!==`, A9) | 1 | `gmail-webhook-receiver` |
| true | JWT de usuário + cota | 1 | `analyze-services` |
| true | OAuth próprio (`acceptedAudiences: "authenticated"`) | 1 | `mcp` (A6) |

Checks adicionais: 0 edges importam `authorize*` sem chamar; 0 edges com `SERVICE_ROLE` fora de `supabase/functions/` (fora de docs); CORS `*` sem `Allow-Credentials` em todos (Bearer não é credencial CORS); nenhum edge não-cron lê `user_id/customer_id/farmer_id` do body (IDOR por body inexistente nas edges de usuário — as 6 edges user-authed recebem `text/userTools`, `imageBase64/categories`, chunks de tint).

### M3 — Segredos, bundle e supply-chain

| item | medição |
|---|---|
| arquivos env versionados | `.env` (anon JWT + PostHog público), `.env.example` (placeholders) — A7 |
| `VITE_*` usados | `SUPABASE_URL/PUBLISHABLE_KEY/PROJECT_ID`, `POSTHOG_KEY/HOST`, `NVOIP_SIP_PREROLL_URL`, `COMMIT_SHA`, `APP_VERSION` — nenhum segredo |
| padrões de segredo no repo (excl. lockfiles) | 1 hit: JWT anon em `.env:2` |
| `SERVICE_ROLE` fora de edges | só docs (menções, sem valor) |
| `package.json` `overrides` | 6, todos resolvidos em `bun.lock` (brace-expansion 2.0.2, form-data 4.0.6, js-yaml 4.3.0, nanoid 3.3.11, serialize-javascript 7.0.6, yaml 2.9.0) e ainda puxados por transitivos (2–5 dependentes cada) — necessários |
| scripts de ciclo de vida (`postinstall`/`prepare`) | nenhum |
| lockfiles | 3 (A13) |
| `index.html` externos | Google Fonts (`preconnect` + CSS); script inline = recuperação de SW/PWA (sem fetch/eval) |
| `lovable-tagger` | devDependency, só `mode === "development"` (`vite.config.ts:100`) |
| `vite.config.ts` `define` | `__PWA_ENABLED__` + `VITE_COMMIT_SHA/APP_VERSION` — sem segredo |

### M4 — Injeção / XSS / redirect

| vetor | medição |
|---|---|
| `EXECUTE` dinâmico no snapshot | 2 menções, 0 com concatenação (`||`) ou variável — nada a corrigir |
| `.or(` fora do ESLint | 22 em edges/scripts, todos com valores do servidor; 1 com input de usuário sanitizado (A12) |
| `dangerouslySetInnerHTML` | 1 (`src/components/ui/chart.tsx:70`, CSS gerado) |
| `innerHTML =` | `format.ts:50` (decodificação de entidades, não render), `AdminReposicaoCockpit.tsx:201/240` (impressão com `escapeHtml`), popup Leaflet `AdminRoutePlanner.tsx:224-236` com `escapeHtml` em todo campo (#862) |
| `rehype-raw` / `eval` / `new Function` | 0 |
| `window.open`/`href` com variável | `whatsappShare.ts:56`, `RouteActionButtons.tsx:28/33` — URLs montadas a partir de telefone/endereço (`wa.me`, maps), `rel="noopener noreferrer"` presente |
| open redirect | `Auth.tsx:21-22` allow-list `startsWith('/') && !startsWith('//')` + `navigate()` do router; `OAuthConsent.tsx:51-66` segue `redirect_url` vindo do servidor OAuth do Supabase |
| token em URL | `ResetPassword.tsx:40` lê `access_token` da query só para decidir redirecionar; não loga |

## Descartei porque…

1. **Escalada via `profiles` self-insert com `is_employee=true`** (seria P0): INSERT `WITH CHECK ((auth.uid() = user_id) AND (is_employee = false))` e UPDATE idem; `auto_assign_user_role` (L4791) só dá `employee` se `NEW.is_employee` — inatingível pelo próprio usuário; ramo master removido; `auto_assign_commercial_super_admin` (L4757) exige `is_employee = true` + `document = master_cpf`. `trg_prevent_self_approval_ins/upd` cobrem `is_approved` (#1164).
2. **`tint_formula_itens` legível por qualquer logado** (pendência do `schema-security-report.md`): a policy viva é "Staff can manage" (master/employee) — hardening já entregue.
3. **Edges com efeito antes do gate** (heurística linha-do-efeito < linha-do-gate acusou 12): falso positivo — são funções auxiliares declaradas no topo do arquivo, executadas só dentro do handler após o gate.
4. **`sync_state` com predicado `entity_type <> …` "sem gate"**: são policies `AS RESTRICTIVE` (9 no total) que ANDam com "Staff can manage sync state" — desenho de lease.
5. **Edges de IA chamáveis por cliente** (`identify-tool`, `analyze-services`, `elevenlabs-transcribe`): desenho explícito em `_shared/ia-cota.ts:4-6` ("customer pode usar") com cota por usuário/hora/dia; custo controlado.
6. **PostHog `identify(email, name, role)`** (`AnalyticsIdentify.tsx:30-34`): processador de dados padrão; session replay **desligada** (`analytics.ts:100 disable_session_recording: true`, com racional em L83-98); `person_profiles: 'identified_only'`; `track()` sem PII (159 chamadas; único campo `nome` é nome de plano Prime). Vale só registrar o PostHog no ROPA.
7. **Lente escrevendo com `effectiveUserId`** nos motores de cross-sell/bundle: ambos guardam a persistência com `if (!isImpersonating)`; WebRTC guarda `makeCall`/`acceptIncoming` na fonte (`docs/agent/telefonia.md`). O residual virou A4 (o guard não cobre `rpc`).
8. **CORS `*` com `Authorization` no `Allow-Headers`**: sem `Access-Control-Allow-Credentials`; Bearer não é "credential" para CORS; o gate é o token, não a origem.
9. **`_carteira_mixgap_for_owner` / `_carteira_positivacao_for_owner` / `_push_enviar` SECDEF sem gate no corpo**: `REVOKE … FROM anon, authenticated, PUBLIC` presente em `supabase/migrations` (3/2/1 ocorrências) — só `wa_owner_efetivo` sobrou (A10).
10. **`/tool/:toolId` público**: `get_public_tool_history` (L12168, SECDEF) devolve só campos públicos da ferramenta e eventos, "sem user_id" — UUID como capability, desenho do storefront.
11. **Rota pública `RequireStaff` decidindo por `displayIsStaff`**: é o comportamento documentado (`impersonation.md`: a lente esconde o que a persona não veria); a RLS real segue sendo a do master.

## Não medido (fora do alcance estático) — para o subagente de banco / o founder

- Grants reais de `EXECUTE` (snapshot `--no-privileges`) — rodar a query de `supabase/schema-security-report.md` e conferir `wa_owner_efetivo` (A10).
- Config de auth do Supabase (rate-limit de login, captcha, `otp_expiry`, política de senha, `additional_redirect_urls`) — `supabase/config.toml` não tem `[auth]`; vive no dashboard.
- Policies de `storage.objects` (buckets `tool-photos`, `tarefa-comprovacoes`) — schema `storage` não está no snapshot.
- Se a edge `mcp` está deployada (A6) e se `biometric-auth` está em uso real (A11).
