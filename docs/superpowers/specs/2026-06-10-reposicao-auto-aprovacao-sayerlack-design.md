# Reposição N3 — auto-aprovação Sayerlack com piloto de veto

> **Data:** 2026-06-10 · **Status:** spec aprovada em brainstorming com o founder (decisões registradas abaixo) · **Origem:** sessão estratégica sobre o relatório Prosus "The Coming Age of AI Colleagues" — primeira função do Colacor OS a cruzar a fronteira da escada de autonomia N2 (IA propõe, humano aprova item a item) → N3 (IA executa por padrão, humano gere exceções).

## 1. Contexto e motivação

O fluxo atual do pedido Sayerlack: motor gera (7×/dia intraday, #711) → pedido cruza R$ 3.000 (mínimo de faturamento da Sayerlack) → e-mail chama o founder → founder abre o app → aprova → dispara (portal + Omie). O founder é o gargalo do caso comum.

A análise do dente de serra (#711, aprovada pelo founder) concluiu que o ótimo econômico é **pedir o mínimo faturável o mais frequente possível** (custo de transação ~zero; estoque médio alto custa capital). O comportamento histórico — deixar o pedido engordar até ~R$ 6.9k (2,3× o mínimo) — é exatamente o que essa política quer eliminar. A auto-aprovação é o instrumento que a implementa: humanos procrastinam de graça; a máquina não.

**Escopo da fase 1: só Sayerlack, só ciclo normal, empresa OBEN** (decisão do founder). Outros fornecedores = fase futura, com a mesma esteira.

## 2. Decisões do founder (2026-06-10)

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Frente da escada 2→3 | Reposição (auto-aprovação por estrato) |
| 2 | Rito de ativação | Baseline retroativa primeiro → resultado levou ao **caminho A: piloto supervisionado medindo VETO** |
| 3 | Piso de valor | **R$ 3.000** = mínimo de faturamento Sayerlack (mesma régua `reposicao_alerta_pedido_valor_minimo` do `company_config` — UMA régua, TRÊS usos: alerta, gate de disparo, piso de auto-aprovação) |
| 4 | Teto superior | **Sem teto** — raio de dano limitado estruturalmente pelo delta ≤30% vs último disparo + fusível + janela de veto |
| 5 | Janela de veto fase 1 | **Corte das 13h existente** (auto-aprova ao cruzar o piso; dispara no cron de corte em lote — zero mecânica nova de disparo). Fase 2 (gated): ~2h (rodada seguinte) |
| 6 | Escopo fornecedor | Só Sayerlack na fase 1 |

## 3. Achados da investigação (importantes além desta feature)

1. **`pedido_compra_sugerido.pedido_anterior_valor` nunca foi populado.** A RPC vigente (`20260609160000`) não grava a coluna (INSERT lista só empresa/fornecedor/grupo/data/valor/num_skus/status/condição). NULL em 100% das linhas.
2. **Consequência: o botão "Aprovar elegíveis (N)" do Cockpit é teatro morto.** `calcApprovalSuggestion` (`src/lib/reposicao/approvalSuggestion.ts`) exige `pedido_anterior_valor > 0` → todo pedido cai em "Primeiro pedido — sem referência histórica" → `eligibleAutoItems` é sempre vazio → o botão mostra (0) desde sempre. Ninguém notou. **Este spec NÃO conserta o botão** (ver §8 follow-ups) — o tick server-side o substitui com vantagem no escopo Sayerlack.
3. **Baseline reconstruída (90d, delta recomputado via LATERAL contra o último pedido disparado do fornecedor):** estrato = 16 pedidos · aprovado sem ajuste 2 · aprovado com ajuste 3 · cancelado 2 · expirado 11 · concordância por linha **12,5%**.
4. **Leitura da baseline (validada com o founder):** a métrica "concordância por linha" mede pedido-dia, não decisão de compra — no corte diário, expirar não custa nada (re-gera amanhã), então a procrastinação estrutural domina (11/16 expirados). O número não diz "o motor erra 87,5%"; diz que o comportamento histórico (engordar) difere da política-alvo (pedir cedo). O sinal de risco real é a **intervenção ativa ~31%** (2 vetos + 3 ajustes em 16) → por isso o piloto mede **taxa de veto com a política nova rodando**, não concordância passiva com o hábito antigo.
5. `fornecedor_nome` real = `RENNER SAYERLACK S/A` → o pattern `%SAYERLACK%` do alerta/gate (#711) casa corretamente (confirmado em prod).

## 4. Desenho

### 4.1 Mecânica central: estender o tick existente (não criar tick novo)

`reposicao_alerta_pedido_minimo_tick()` (migration `20260609150000`, cron `*/30` + hook best-effort na edge de geração) já seleciona exatamente o universo certo: pedido OBEN pendente, `fornecedor ILIKE` pattern, `valor_total ≥` régua. Ele ganha um braço:

```
para cada pedido que cruza a régua (universo atual do tick):
  se fusível ligado E pedido elegível (4.2) E sem alerta ativo de reposição (4.5):
    → auto-aprova (4.3) + log (4.6) + enfileira e-mail INFORMATIVO (4.4)
  senão:
    → comportamento atual (e-mail "vá aprovar", anti-spam por transição inalterado)
```

Por quê estender em vez de criar: mesmo universo, mesma cadência necessária, elimina a corrida de ordem entre "alerta chama humano" × "tick auto-aprova" (um só processo decide qual e-mail sai), zero cron novo. O corpo novo parte do **verbatim da migration de maior timestamp** que define o tick (lição da cascata `_data_health_compute`).

### 4.2 Elegibilidade (subconjunto do universo do tick)

Um pedido `p` é auto-aprovável quando TODOS valem:

1. `p.empresa = 'OBEN'` e `p.fornecedor_nome ILIKE` pattern da config (reusa `reposicao_alerta_pedido_fornecedor_ilike`);
2. `COALESCE(p.tipo_ciclo,'normal') = 'normal'` — **nunca** oportunidade/promoção (lição H5);
3. `p.split_parent_id IS NULL`;
4. `p.status = 'pendente_aprovacao'` (exato) e `p.aprovado_em IS NULL` e `p.cancelado_em IS NULL`;
5. `COALESCE(p.num_skus,0) > 0` e `p.valor_total > 0 AND p.valor_total < 'Infinity'::numeric` (sanidade; `numeric` aceita NaN/Infinity);
6. `p.valor_total ≥` régua (R$ 3.000 via config — piso = mínimo faturável);
7. **Delta ao vivo ≤ `delta_max`** (config nova, default 0.30): existe pedido anterior do mesmo (empresa, fornecedor) com `criado_em < p.criado_em` e evidência de compra real (`omie_pedido_compra_numero IS NOT NULL` OR `status IN ('disparado','concluido_recebido')`), pego o mais recente; `abs(p.valor_total − ant.valor_total) / ant.valor_total ≤ delta_max`. **Sem anterior → NÃO elegível** (primeira compra é sempre humana). Computado no tick — não depende da coluna morta `pedido_anterior_valor` e não congela na geração;
8. **Itens sãos:** `NOT EXISTS` item com `preco_unitario ≤ 0` ou `qtde_final ≤ 0` (espelha o guard de disparo #422/#433 — não auto-aprovar o que o disparo barraria);
9. **Humano não está cuidando dele:** `NOT EXISTS` item do próprio pedido com `ajustado_humano IS TRUE` (se o founder mexeu, a decisão é dele — coerente com o trade-off "ajustou → aprova" do #711);
10. **Cooldown de falha por fornecedor:** `NOT EXISTS` pedido do mesmo (empresa, fornecedor) com `aprovado_por LIKE 'auto:%' AND status = 'falha_envio' AND atualizado_em > now() − cooldown_falha_horas` (config, default 48h) — evita loop diário de auto-aprovar→falhar (ex.: SKU sem de-para no portal); a falha vira exceção humana e a automação só volta depois de resolvida (ou do cooldown expirar).

### 4.3 Efeito da auto-aprovação

`UPDATE ... SET aprovado_em = now(), aprovado_por = 'auto:sayerlack-v1', status = 'aprovado_aguardando_disparo' WHERE id = ... AND status = 'pendente_aprovacao' AND aprovado_em IS NULL` (claim condicional — corrida com aprovação humana simultânea resolve em quem chegar primeiro; `pg_advisory_xact_lock` por empresa já protege tick×tick, padrão [INTRADAY 1/4]).

**Fase 1 NÃO toca o disparo:** o pedido segue o caminho de hoje — cron de corte em lote (`disparar-pedidos-aprovados`) → pré-split ≥3k em filhos → claim lista-positiva do portal → Omie idempotente por `cCodIntPed`. A janela de veto = tempo entre a auto-aprovação e o corte. ⚠️ **Ponto de verificação no plano:** confirmar em prod o horário/escopo do cron de corte (se pedido aprovado após o corte do dia fica pro corte seguinte — aceitável no piloto, janela maior) e que o cancelamento via UI funciona em `aprovado_aguardando_disparo` (higiene #498 já zera `status_envio_portal`).

### 4.4 E-mail informativo (substitui o call-to-action quando auto-aprova)

Mesmo canal (`fornecedor_alerta` → `dispatch-notifications` `*/30`, que envia `titulo`+`mensagem` sem filtro de tipo → **sem mexer no CHECK nem na edge**). Reusa o tipo `reposicao_pedido_minimo` e a tabela de estado anti-spam existente (1 e-mail por transição). Texto: `"Auto-aprovado: pedido Sayerlack #<id> de R$ <valor> (delta <x>% vs último disparo de R$ <ant>). Dispara no corte de <hora>. Para vetar, cancele no app até lá."` + link genérico pra `/admin/reposicao/pedidos` (deep-link por id morre na regeneração — lição #711). ⚠️ **Cuidado de implementação:** o tick atual marca o estado anti-spam como resolvido quando o pedido sai de `pendente_aprovacao` — e a auto-aprovação o tira de pendente no MESMO ciclo; enfileirar o e-mail informativo ANTES do passo de resolve (ou tornar o resolve auto-aprovação-aware) pra não suprimir o aviso da própria transição.

### 4.5 Fusível e auto-suspensão

- **Fusível:** config `reposicao_auto_aprovacao_ativa` (`company_config`, seed `'false'` — nasce DESLIGADO; ligar é um UPDATE separado no rollout, §7). Desligar reverte ao fluxo atual instantaneamente (o braço do alerta volta a chamar o humano).
- **Auto-suspensão pelo vigia:** se existe `fin_alertas` ativo (`dismissed_at IS NULL`) com `tipo IN ('data_health_reposicao_disparo','data_health_reposicao_portal_pipeline','data_health_reposicao_portal_humano','data_health_reposicao_sugestoes')`, o braço de auto-aprovação se suspende (volta a alertar humano). Princípio: **autonomia não roda enquanto o vigia acusa problema no domínio**. (O tipo `reposicao_pedido_minimo` — o próprio alerta informativo — NÃO suspende.)

### 4.6 Auditoria e métrica do piloto

- Tabela nova `reposicao_auto_aprovacao_log` (append-only, **sem FK** — snapshot desacoplado, padrão `nfe_efetivacao_tentativas`): `id, pedido_id, empresa, fornecedor_nome, grupo_codigo, valor_total, valor_anterior, delta_pct, regua, criado_em`. RLS: SELECT staff (employee/master), escrita só `service_role`/definer.
- `aprovado_por = 'auto:sayerlack-v1'` distingue máquina de humano em qualquer query/UI.
- **Métrica de veto:** `vetos = pedidos com aprovado_por LIKE 'auto:%' AND cancelado_em IS NOT NULL` ÷ auto-aprovados, semanal. Query pronta entregue no rollout pro founder colar.

### 4.7 Critérios de promoção e de morte (3 semanas de piloto)

- **Promoção (fase 2):** veto < 10% por 3 semanas consecutivas E zero incidente de compra errada → encurtar a janela: disparo na rodada intraday seguinte (~2h) via invocação `disparar {pedido_id}` agendada (migration própria, com Codex).
- **Morte:** veto > 25% em qualquer semana OU 1 compra errada real (pedido disparado que o founder não teria feito, confirmado) → fusível OFF + post-mortem antes de religar.
- Enquanto o piloto roda, o founder recebe 1 e-mail informativo por auto-aprovação (volume esperado: ~1/dia útil, padrão do mínimo faturável).

### 4.8 Frontend (mínimo, PR pequeno)

Badge "auto" na lista de pedidos (`aprovado_por LIKE 'auto:%'`) — visibilidade de qual compra foi decidida pela máquina. Nada além disso na fase 1.

## 5. Não-objetivos da fase 1

- Outros fornecedores (fase futura, mesma esteira após o piloto provar).
- Disparo na rodada seguinte (~2h) — é a fase 2, gated pelo critério de promoção.
- Consertar o classificador morto do Cockpit (`calcApprovalSuggestion`/botão "Aprovar elegíveis") — follow-up registrado (§8); o tick server-side o substitui no escopo Sayerlack.
- Teto superior de valor (dispensado pelo founder; delta relativo + fusível + janela cobrem).
- Tela de exceções como visão default da Reposição (fase posterior do programa N3).
- Popular `pedido_anterior_valor` na RPC de geração (o delta ao vivo do tick é superior — não congela).

## 6. Interações com o existente (verificadas)

| Sistema | Interação | Status |
|---|---|---|
| Gate <R$3k no disparo (#711) | Auto-aprovados são ≥3k por construção (mesma régua) | ✓ coerente |
| Pré-split pai ≥3k → filhos ~2k | Acontece no disparo, isento do gate | ✓ transparente |
| Regeneração intraday (limpeza) | Só apaga `pendente_aprovacao`; aprovado fica; `em_transito` conta aprovado → rodada seguinte não re-sugere os SKUs | ✓ sem compra dupla |
| SKUs novos engordando após a auto-aprovação | Formam pedido pendente NOVO que espera cruzar 3k — comportamento desejado (mínimo frequente) | ✓ esperado |
| Claim do portal + `cCodIntPed` | Caminho de disparo inalterado na fase 1 | ✓ |
| Higiene de cancelamento (#498) | Veto usa o cancelar existente (zera `status_envio_portal`) | ✓ verificar UI p/ status aprovado |
| Alerta R$3k anti-spam | Mesmo estado/transição; muda só o TEXTO quando auto-aprova | ✓ |
| Sentinela | Auto-suspensão por alerta ativo de reposição (4.5) | ✓ novo elo |

## 7. Entrega e rollout

1. **PR único:** migration `YYYYMMDDHHMMSS_reposicao_auto_aprovacao_piloto.sql` (timestamp alocado na implementação — **checar colisão multi-sessão** via `git ls-tree origin/main supabase/migrations/`, lição §10 do CLAUDE.md) com 2 configs novas + tabela de log + RLS + `CREATE OR REPLACE` do tick partindo do verbatim vigente; + badge front + esta spec.
2. **Validação PG17 local** (`db/test-auto-aprovacao-piloto.sh`, base `verify-snapshot-replay`): elegível aprova e loga e enfileira informativo 1× · delta >30% não · sem anterior disparado não · fusível off não · alerta ativo de reposição suspende · item com preço/qtde inválido não · `ajustado_humano` não · cooldown de falha segura · oportunidade/split não · idempotência (2ª execução não duplica) · corrida com aprovação humana não sobrescreve.
3. **Codex challenge adversarial ANTES do apply** (cota volta 11/06 ~9h24 — money-path merece o rito completo; PG17 hoje, challenge amanhã, apply depois).
4. **Apply manual no SQL Editor** (BLOCO A: migration; valida). **BLOCO B separado:** `UPDATE company_config SET ... reposicao_auto_aprovacao_ativa='true'` — o founder liga quando quiser começar o piloto.
5. Sem deploy de edge. Publish só pro badge (opcional, não bloqueia o piloto).
6. Semanal durante o piloto: query de veto (entregue no rollout) → decisão de promoção/morte na 3ª semana.

## 8. Follow-ups registrados (fora desta entrega)

- **Fase 2:** disparo na rodada seguinte (~2h) gated pelo critério de promoção (§4.7).
- **Classificador do Cockpit:** alimentar `calcApprovalSuggestion` com o delta ao vivo (view com LATERAL ou RPC) OU aposentar o botão — decidir quando a fase 2 chegar; hoje é inerte para todos os fornecedores (achado §3.2).
- **Outros fornecedores:** ACRE CAXIAS etc. têm tíquete médio < R$ 1k — piso próprio por fornecedor a definir (a régua atual é Sayerlack-specific).
- **Painel de outcomes (torre de controle do programa N3):** ruptura zero com ≤X dias de estoque como número-alvo do módulo no GestorBuddy.
