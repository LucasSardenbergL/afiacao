# Spec — Preço por tier (precedência de preço) · item 5 do "back to basics"

> **Status:** v2.1 — 1º challenge Codex: REPROVADA (14 P1 + 3 P2); verificação da v2: 12/14 fechados,
> P1-4 e P1-12 reabertos e corrigidos nesta v2.1 (P1-4: mitigação explícita cockpit+medição, sem
> repricing automático; P1-12: migration APERTA a RLS da markup_policy para pode_ver_carteira_completa).
> Aguarda: go do founder (§7). NÃO implementar antes do go.
> Mandato: artigo Pernambucanas → 4ª iniciativa ("tabelas de preço por segmento/tier — evolução
> natural da régua de preço"). Ordem decidida com Codex: por último, após estabilizar o crédito
> no wizard — cumprido (Trava Fase 2 em produção, 2026-07-03). Pré-requisito: ESTA spec de
> precedência antes de qualquer código ("quem vence entre preço-cliente, régua, tier e catalisado").

## 1. Estado atual — fatos apurados (2026-07-03, código + psql-ro em prod)

### 1a. Fontes de preço vigentes e a precedência IMPLÍCITA de hoje

| # | Fonte | Onde | Papel hoje |
|---|---|---|---|
| 1 | **Último praticado do cliente** | `sales_price_history` local (hidratado na seleção do cliente — `useCustomerSelection.ts:439-540`) + merge com Omie `ListarPedidos` no edge `analyze-unified-order` (helper espelhado `src/lib/pricing/mergeCustomerPrices.ts`, guard MIRROR + canária `canary:true` — #1089) | **Nascimento do preço** do item: `getProductPrice()` (`useCart.ts:107`) usa se `> 0`, **sem limite de idade** |
| 2 | **Tabela Omie** | `omie_products.valor_unitario` (sync) | Fallback do nascimento |
| 3 | **Catalisado (tint)** | `selectTintPrice()` (`src/lib/tint/select-price.ts:70-115`): cliente > `max(calc CMC base+corantes via get_tint_price, CSV legado)`; **fail-closed** (base sem custo → SEM preço); "never lower silently" | Nascimento do preço de tinta |
| 4 | **Edição livre do vendedor** | `CartItemList.tsx:183` — `parseFloat(...) \|\| 0`, qualquer valor | Sobrepõe tudo |
| 5 | **Guard de submit** | `priceGuard.ts` | Bloqueia SÓ `≤ 0`. Nenhum piso/margem |
| 6 | **Cockpit** (semáforo) | RPC `get_preco_cockpit`: preço digitado vs CMC (inclusive composição catalisada base+corantes) e vs `resolve_markup_policy(empresa, sku, familia)` → vermelho (< custo) / amarelo (< piso) / verde; números derivados de custo ocultos de quem não `pode_ver_carteira_completa` | **Só aviso** |
| 7 | **Régua** (só Oben) | RPC `get_regua_preco`: cmc, `piso_mc = cmc/(1−0,15)`, últimos do cliente, comparáveis **180d** em faixa de qty ±2× | **Só aviso** + botão "Aplicar piso" |

**Precedência vigente (nascimento):** `último praticado > tabela Omie` (produto comum); `cliente > max(calc, csv)` (tint). Depois o vendedor digita livremente; só `≤ 0` é barrado.

### 1b. Política de markup — mecanismo pronto, conteúdo vazio

`markup_policy`: cascata `sku > familia > conta` resolvida por `resolve_markup_policy(text,bigint,text)`. Em prod: **1 linha** (`oben / conta / piso 30% / meta 50%`). Colacor sem política (cockpit → `sem_politica`/neutro).
**RLS vigente (fato):** SELECT staff-wide (`markup_policy_select_staff`) — a política crua JÁ é legível por qualquer employee; escrita só master (`markup_policy_write_master`). `company_config`: idem (SELECT staff / write master).
**Callers de `resolve_markup_policy` (fato):** 1 caller SQL — `get_preco_cockpit` (schema-snapshot linha 6423); nenhum `.rpc('resolve_markup_policy')` no frontend; a função está exposta como RPC PostgREST (types.ts).

### 1c. Classificação de cliente: NÃO existe tier comercial

- `abc_xyz_classification` é **ABC de SKU** (reposição) — não é de cliente.
- `farmer_client_scores` (6.437 clientes) é saúde/churn. `cliente_classificacao` = tags operacionais.
- **Carteira viva** (pedidos 12m, excl. cancelado/orçamento): Oben **384**, Colacor **334** (281 em 90d).

### 1d. Desconto

Campo estrutural no payload Omie existe; UI/fluxo não (`desconto: 0` hardcoded). Fora do escopo.

## 2. A lacuna

1. Nenhum tier/segmento comercial de cliente. 2. Nenhum piso por cliente/segmento (1 linha genérica, só Oben). 3. Edição 100% livre; avisos não medidos. 4. Cliente sem histórico nasce com tabela crua. 5. Último praticado vence PARA SEMPRE (preço de 2024 nunca expira).

## 3. Desenho proposto (v2 — pós-challenge)

### Princípios

- **Precisão > recall:** tier NUNCA inferido automaticamente (não existe ABC de cliente); decisão de gestor, auditada.
- **Ausente ≠ zero:** cliente sem tier → comportamento atual intacto. Conta sem política/config → tier fica só informativo (badge), nada de partida nem piso "fantasma".
- **Fatiamento alerta→bloqueio** (validado 2× no crédito): Fase A = política + visibilidade + medição; Fase B = enforcement na fronteira, decidido por dado.
- **Número firme é server-side e determinístico:** tier resolvido no servidor; medição firme em SQL; nada de piso/percentual computado no browser.

### Fase A (esta entrega)

**A1. Tier por cliente** — tabela `cliente_tier_preco`:
- `(company text CHECK (company IN ('oben','colacor')), customer_user_id uuid REFERENCES auth.users(id), tier text CHECK (tier IN ('A','B','C')), motivo text, definido_por uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company, customer_user_id))`.
- RLS: SELECT staff; INSERT/UPDATE só `pode_ver_carteira_completa` (mesmo gate da exceção de crédito); **sem DELETE** (tirar do tier = UPDATE para NULL? não — remover tier = DELETE só master; default: manter linhas). Trigger BEFORE força `definido_por = auth.uid()` e `updated_at = now()` (anti-forje, padrão Fase 2).
- **Auditoria [P1-11]:** `cliente_tier_preco_log` (de→para, quem, quando) preenchida por trigger AFTER INSERT/UPDATE com função SECURITY DEFINER. RLS do log: SELECT staff; **nenhum grant de INSERT/UPDATE/DELETE a `anon`/`authenticated`** (REVOKE explícito — regra database.md: REVOKE FROM PUBLIC não basta); escrita só pelo trigger.

**A2. Piso/meta por tier** — `markup_policy` ganha coluna `tier text NULL CHECK (tier IN ('A','B','C'))`:
- **[P1-5] Duas cascatas paralelas + MAX (tier nunca é derrubado por linha genérica):**
  - cascata-produto (vigente): `sku > familia > conta` (linhas com `tier IS NULL`)
  - cascata-tier: `(sku,tier) > (familia,tier) > (conta,tier)` (linhas com `tier = tier_do_cliente`)
  - **piso efetivo = GREATEST(piso_produto, piso_tier)** (NULL-safe: um lado ausente → o outro vale); meta idem. Determinístico e sem surpresa: SKU commodity com piso 20% não fura o piso 35% do tier C.
- **[P1-6] Unicidade:** `UNIQUE NULLS NOT DISTINCT (account, escopo, sku_codigo, familia, tier)` + `ORDER BY` estável na resolução (cinto e suspensório).
- **[P1-7] Overload proibido:** assinatura nova = função NOVA no Postgres, e RPC com 3 args ficaria AMBÍGUA entre as duas. A migration faz `DROP FUNCTION public.resolve_markup_policy(text,bigint,text)` + `CREATE FUNCTION resolve_markup_policy(p_empresa, p_codigo, p_familia, p_tier text DEFAULT NULL)` + `CREATE OR REPLACE` do caller único `get_preco_cockpit` **na MESMA migration** (atômico). Pré-flight `pg_get_functiondef` das DUAS funções na prod antes do apply.

**A3. Cockpit tier-aware** — **[P1-8] tier resolvido server-side, jamais do payload:**
- `get_preco_cockpit` ganha `p_customer uuid DEFAULT NULL` (mesmo tratamento anti-overload do A2: DROP + CREATE + atualizar callers na mesma migration; callers do frontend passam a enviar o customer). A função resolve o tier via `cliente_tier_preco` (company do item × customer) e usa `GREATEST` das cascatas. O client NÃO envia tier; enumerar pisos por tentativa morre junto.
- Semáforo continua o canal de aviso; números derivados de custo continuam ocultos de quem não `pode_ver_carteira_completa` (modelo vigente, inalterado).

**A4. Preço de partida por tier** (a "tabela A/B/C" enxuta):
- **[P1-13] Config tipada** — tabela `tier_preco_config(company text, tier text, mult_partida numeric NOT NULL CHECK (mult_partida >= 0.5 AND mult_partida <= 1.5), updated_by uuid, updated_at timestamptz, PRIMARY KEY (company, tier))` com CHECKs de company/tier. RLS: SELECT staff, escrita master (modelo da markup_policy). Nada de `company_config` texto-livre para número money-path.
- **[P1-1] Janela de vigência do último praticado: 180 dias** (par com a janela da régua). Praticado ≤ 180d vence; mais velho vira **contexto exibido** ("último: R$ X em mm/aa"), não partida.
- **[P1-4] Promoção no histórico — resposta completa:** promoção ANTIGA expira pela janela. Promoção/negociação RECENTE continua vencendo a partida **por decisão explícita**: o sistema não tem dado que distinga promoção de negociação legítima (`order_items`/`omie_products` não têm flag) — qualquer detecção automática seria fabricação de classificação (viola precisão > recall), e repricear silenciosamente histórico recente quebraria contrato comercial vivo (pior). A proteção é que o caso **nunca passa despercebido**: (a) o cockpit tier-aware acende amarelo/vermelho quando a partida herdada fica abaixo do piso do tier — na cara do vendedor, ANTES do submit; (b) o item entra na medição A5 (view SQL) se for vendido assim — vira número para o gestor agir (inclusive corrigindo o tier ou negociando o reajuste). O humano decide com o semáforo aceso; a máquina não reprecifica sozinha.
- **[P1-3] Idempotência:** a partida é função pura `precoPartida({tabela, ultimoPraticado, idadeUltimo, tier, mult})` em `src/lib/pricing/`, chamada UMA vez no `addProductToCart`. O carrinho/draft persiste `unit_price` final; re-hidratação NUNCA re-aplica o multiplicador. Teste vitest de idempotência obrigatório (aplicar 2× = mesmo resultado por construção: a função não roda sobre preço de carrinho).
- **[P1-14] Ativação por conta:** a partida só ativa se a conta tem config de mult **E** ao menos uma linha `(conta,tier)` na markup_policy (política de piso presente). Sem os dois → tier é só badge + cockpit. Colacor nasce estruturada e **inativa** até o founder definir política.
- Mult inválido/ausente → ignora tier (tabela pura). CHECK no banco já impede valor absurdo persistido.
- Alternativa DESCARTADA na v1: price list SKU×tier (cadastro que ninguém manterá; a cascata `(sku,tier)` da markup_policy JÁ dá granularidade fina ao PISO quando precisar — [P2-3]).

**A5. Medição da fase** — **[P1-9/P1-10] firme = SQL server-side sobre pedidos efetivados (todas as vias por construção):**
- View analítica `v_pedidos_abaixo_piso_tier` (ou query documentada no doc de domínio): `order_items` dos últimos N dias × CMC (`inventory_position`) × piso efetivo → itens vendidos abaixo do piso, por conta/tier/vendedor. **Cobre wizard, conversão, edição, programado e retry por construção** (mede o que foi VENDIDO, não o que a UI mostrou) — imune a spoof e a dupla contagem de retry ([P2-2]).
- **Requisito (ressalva do challenge):** a view calcula o piso efetivo chamando a MESMA `resolve_markup_policy(..., tier)` usada pelo cockpit — 1 fonte de verdade; nunca reimplementar o GREATEST na view.
- Acesso: staff via RPC/view com barreira (`security_invoker` + RLS das bases ou RPC staff-gated) — números de custo só `pode_ver_carteira_completa` (coerente com o cockpit).
- PostHog vira só UX (badge exibido, partida aplicada): `venda.tier_badge_exibido`, `venda.tier_partida_aplicada` — sem valores de piso/percentual no client ([P1-9]).

**A6. UI mínima:**
- Badge do tier no header do cliente no wizard (slot do alerta de crédito).
- Gestão do tier: dialog no detalhe do cliente em `/sales` (gestor define A/B/C + motivo; vendedor vê, não edita).

**[P1-2] Regra explícita por via (nascimento vs documento existente):**
- Partida por tier se aplica **somente ao nascimento de item novo no wizard**.
- **Conversão de orçamento:** preserva os preços do orçamento (compromisso comercial documentado) — sem repricing silencioso.
- **Edição de pedido:** preserva preços dos itens existentes; item ADICIONADO na edição segue a regra de nascimento.
- **Pedido programado:** preços vêm da config do programado (`pedidos_programados_config`) — fora da partida por tier; a MEDIÇÃO (A5) os cobre.
- **Retry idempotente:** reenvia o pedido salvo — preço já nasceu, nada re-aplica.

**[P1-12] Modelo de visibilidade (a migration APERTA o vigente):**
- Política crua (`markup_policy`, `tier_preco_config`): a spec adiciona conteúdo mais sensível (pisos e multiplicadores POR TIER) — expor a vendedor faria o piso virar âncora de negociação. **A migration muda o SELECT da `markup_policy` de staff-wide para `pode_ver_carteira_completa`** (DROP da policy `markup_policy_select_staff` + policy nova) e a `tier_preco_config` já nasce com esse gate. Escrita segue master (vigente).
- **Fato verificado (2026-07-03):** zero leitura direta de `markup_policy` no frontend (grep em src/, fora do types gerado) — todo acesso é via RPCs SECURITY DEFINER (`get_preco_cockpit`), que bypassam RLS e JÁ ocultam números de quem não `pode_ver_carteira_completa`. Apertar a RLS não muda nada para o vendedor: ele segue vendo a FAIXA (verde/amarelo/vermelho), nunca o piso.
- Tier do cliente (`cliente_tier_preco`): SELECT staff (o badge A/B/C em si não é segredo — orienta o vendedor); escrita gestor (`pode_ver_carteira_completa`).
- Números derivados de custo (CMC/markup/folga/piso efetivo no cockpit e na view A5): só `pode_ver_carteira_completa` (vigente).
- prove-sql: assert de que `SET ROLE authenticated` sem carteira completa NÃO lê `markup_policy`/`tier_preco_config` (e falsificação: re-abrir a policy → vermelho).

### Fase B (futura — só com dados da A5)

Enforcement na fronteira `omie-vendas-sync` (todas as vias): item abaixo do piso do tier → bloqueio com exceção por pedido (padrão da trava de crédito: tabela própria, log durável, fail-open só com log). Decisão por dado: se a view A5 mostrar violação relevante e recorrente. Bloquear negociação de balcão sem essa medição = risco de parar venda legítima ([P2] do challenge anotado: adiar enforcement não esvazia a iniciativa — a Fase A já muda o DEFAULT do preço e a visibilidade; o enforcement é a catraca final, não o produto).

## 4. Precedência canônica (a resposta da spec)

**Nascimento do preço (partida do item novo no wizard):**
1. Último praticado do cliente **com ≤ 180 dias** — se `> 0`
2. **[NOVO]** Tabela Omie × `mult_partida(tier)` — se cliente tem tier E conta ativa (config + política presentes)
3. Tabela Omie pura
4. Tint: `selectTintPrice` **inalterado** (cliente > max(calc, csv), fail-closed). Multiplicador NÃO se aplica a tint na v1; **o PISO por tier cobre tint automaticamente** via cockpit (o cockpit já avalia tint com CMC composto base+corantes) — tint não é rota de fuga do piso ([P2-1]).

**Piso (cockpit hoje; enforcement só na Fase B):**
`piso_efetivo = GREATEST(cascata_produto(sku > familia > conta), cascata_tier((sku,tier) > (familia,tier) > (conta,tier)))` — NULL-safe; sem tier → cascata-produto (= vigente); sem custo/política → neutro com motivo (degradação honesta vigente).

**Régua** segue evidência. **Edição do vendedor** segue livre na Fase A; o que muda: o semáforo fica específico do cliente e a violação vira número medido em SQL.

## 5. Fora do escopo (anti-creep)

Price list SKU×tier (a cascata `(sku,tier)` cobre piso fino quando precisar) · UI de desconto · enforcement no edge (Fase B) · tier automático por faturamento (v2: sugestão via Pareto 12m) · mudanças em `selectTintPrice` · Colacor SC.

## 6. Artefatos e prova

- **Migration** (1): `cliente_tier_preco` + log + triggers anti-forje/auditoria + RLS/REVOKEs · `tier_preco_config` · `ALTER markup_policy ADD tier` + UNIQUE NULLS NOT DISTINCT · **DROP + CREATE** `resolve_markup_policy(4 args)` + `get_preco_cockpit(p_customer)` na mesma migration (anti-overload/anti-ambiguidade RPC) · view/RPC da medição A5. **Pré-flight** `pg_get_functiondef` das 2 funções vigentes.
- **prove-sql PG17** (`db/test-preco-tier.sh`): GREATEST das duas cascatas (um assert por nível + ausências + empate barrado pela UNIQUE), RLS sob `SET ROLE authenticated` + GUC (vendedor não escreve tier/config; gestor escreve tier; log inescrevível direto), anti-forje, cockpit resolve tier server-side (payload não influencia), **falsificação** (sabotar GREATEST → vermelho; restaurar → verde).
- **Vitest**: `precoPartida` pura (janela 180d; histórico velho não vence; mult inválido ignora; sem tier = hoje; idempotência) + guardião de `selectTintPrice` intocado (hash/snapshot do arquivo ou teste de comportamento).
- **Deploy**: migration + Publish (2 camadas — **sem deploy de edge** nesta fase).

## 7. Decisões do founder — TOMADAS (2026-07-03, gate humano)

1. **Janela do último praticado: 180 dias** (par com a régua).
2. **Multiplicadores de partida (AMBAS as contas): A=1,00 · B=1,00 · C=1,05.**
3. **Pisos por tier (AMBAS as contas): A=25% · B=30% · C=35%** (meta por tier não diferenciada na largada — meta segue a da conta).
4. **Colacor ATIVA desde o dia 1, espelhando a Oben** (decisão do founder — diverge da proposta "estruturada e inativa"). Isso inclui a **primeira política de conta da Colacor: piso 30% / meta 50%** na `markup_policy` — efeito colateral VISÍVEL e desejado: o cockpit da Colacor sai do neutro (`sem_politica`) para TODOS os pedidos dela, mesmo cliente sem tier. O mecanismo de ativação-por-conta (§A4) permanece como invariante estrutural; a migration SEEDA as duas contas.
5. **Quem define tier:** `pode_ver_carteira_completa` (default confirmado sem objeção).

**Seed da migration (consequência):** `tier_preco_config`: 6 linhas (oben×A/B/C, colacor×A/B/C com mults acima) · `markup_policy`: +6 linhas (conta,tier) com os pisos acima (meta = a da conta) + 1 linha (colacor, conta, 30/50).

## 8. Registro do challenge (Codex, 2026-07-03, xhigh)

**1º challenge: REPROVADA — 14 P1 + 3 P2.** Todos endereçados na v2:
P1-1 histórico eterno → janela 180d (§A4) · P1-2 vias sem regra → regra explícita por via (§A) · P1-3 mult 2× → função pura no nascimento + teste (§A4) · P1-4 promoção contamina → v2.1: janela (antiga) + cockpit aceso e medição A5 (recente); repricing automático rejeitado por fabricação (§A4) · P1-5 SKU genérico derruba tier → GREATEST de duas cascatas (§A2) · P1-6 empate → UNIQUE NULLS NOT DISTINCT + ORDER estável (§A2) · P1-7 overload/ambiguidade RPC → DROP+CREATE atômico + caller na mesma migration (§A2) · P1-8 tier forjável no cockpit → resolvido server-side por customer (§A3) · P1-9 telemetria vaza/spoofável → medição firme em SQL server-side; PostHog só UX (§A5) · P1-10 amostra enviesada → medição sobre pedidos efetivados, todas as vias por construção (§A5) · P1-11 RLS do log → fail-closed, escrita só por trigger, REVOKEs explícitos (§A1) · P1-12 vazamento de política → v2.1: migration APERTA SELECT da markup_policy para pode_ver_carteira_completa (zero leitura direta no frontend — verificado; cockpit SECURITY DEFINER inalterado) (§A) · P1-13 mult permissivo → tabela tipada com CHECK 0,5–1,5 (§A4) · P1-14 Colacor partida sem piso → ativação por conta exige config+política (§A4).
P2-1 tint como fuga → piso cobre tint via cockpit; explicitado (§4) · P2-2 retry infla telemetria → medição por pedidos efetivados é imune; PostHog=UX (§A5) · P2-3 mult não escala → `(sku,tier)`/`(familia,tier)` já dão piso fino; price list = v2 (§5).
