# Spec — Fase 2: condição de pagamento por-fornecedor + trilha de aprovação canônica

> Fase 2 do programa de unificação de pedidos de compra
> (`2026-06-05-unificacao-pedidos-compra-design.md` §4.2/§9/§11). Engloba o backend de
> condição que NÃO entrou no sub-PR 1 (que foi só idempotência do disparo, #628).
> Data: 2026-06-05.

## ⏸️ STATUS: FEATURE DE CONDIÇÃO DEFERIDO — só a trilha canônica sobrevive (decisão founder+codex, 2026-06-05)

**Decisão:** **largar** o feature de condição/memória/gate. Promover a **trilha de aprovação
canônica** (§3.4) pra dentro da **Fase 3 (tela única)**. Registro abaixo o porquê + o gatilho de
revisita.

**Por quê:** o founder confirmou que **à vista é universal e PERMANENTE** ("Sayerlack sempre será
à vista"; 119/119 dos últimos 30d já eram à vista; "não é pra preocupar com prazo agora"). Sob essa
premissa, aplicando o próprio framework do codex (*"não construa prazo às cegas; só vale se destrava
valor real ou conserta um problema real"*):

- O **hardcode `000/À Vista` está CORRETO** — produz a condição certa pra todo pedido (não é bug).
- A **capability por-fornecedor (prazos) não tem uso** — nenhum fornecedor diferirá de À Vista.
- O **gate (warn/enforce) não pega nada** — está tudo corretamente À Vista.

→ Construir o substrato de condição/memória/gate seria **valor marginal** (mesma disciplina do
check de taxa do portal, deferido na mesma sessão). O `default_a_vista` "leaking" é benigno porque
o VALOR (À Vista) é o real.

**O que SOBREVIVE:** a **trilha de aprovação canônica** (§3.4) — `aprovar=dispara` em ✓ inline/lote/
modal, consertando o §1.2 (dá pra "aprovar" pelo ✓ inline achando que disparou; o pedido fica parado
esperando o cron 13h). Isso é **condition-independent** e é parte natural da **tela única (Fase 3)**
— não um build separado.

**🔭 Gatilho de revisita:** se um fornecedor OBEN um dia oferecer um prazo (30/60/90) que o founder
queira USAR. Aí o substrato (geração lê memória + confirmar 1-clique + provenance) volta à mesa,
com a UI de prazo dimensionada pro caso real. Até lá: à vista universal = hardcode correto.

**O design abaixo fica como registro** (se revisitado). A peça §3.4 (trilha canônica) migra pro
plano da Fase 3.

---

> Status original (preservado): **EM DESENHO** (reframe pós-código-real + 2º consult codex).

## 0. Reframe (consult codex 2026-06-05 — muda o §4.2 original)

O §4.2 original era um **gate fail-closed bruto** (disparo recusado para `default_a_vista`).
A realidade do código + o consult codex reposicionam:

- **O VALOR não é o gate. É parar o hardcode.** A RPC `gerar_pedidos_sugeridos_ciclo:2565`
  **crava** `'000'/'À Vista'/'default_a_vista'` em TODO pedido → 119/119 dos últimos 30d saem
  `default_a_vista` e disparam À Vista normalmente. O ganho real é (a) **capability nova**:
  condição **por-fornecedor** (prazos), que hoje **não existe** (a geração sempre sobrescreve);
  (b) a geração **parar de sobrescrever** tudo como À Vista; (c) **provenance honesta** da
  condição; (d) **trilha de aprovação canônica** (acaba a divergência dos 2 "Aprovar").
- **O gate é secundário** (catch-rate ~zero hoje — o founder compra à vista de todos). Mas tem
  papel: depois que a memória existe, um `default_a_vista` = "não sabemos a condição real deste
  fornecedor" → o gate **sinaliza o desconhecido**, não vira controle financeiro de alto valor.
  Por isso vira **guardrail FLAGÁVEL** (`off | warn | enforce`), começando em **warn** (não
  bloqueia 100% no deploy), virando `enforce` depois do bootstrap.
- **Construir agora = substrato mínimo.** Adiar a gestão rica de prazos.

## 1. Problema (resumo do §1 da unificação)

1. **Hardcode no money-path:** `gerar_pedidos_sugeridos_ciclo` crava `'000'/'À Vista'/'default_a_vista'`.
   Não há condição por-fornecedor; a memória `fornecedor_condicao_pagamento_padrao` existe mas
   está **vazia** e a geração **não a lê** (BLOCO B: `geracao_le_memoria=false`).
2. **2 "Aprovar" divergentes:** modal (`useDetalhesModal`) chama `aprovar_pedido_sugerido` +
   seta `condicao_origem='manual_humano'` + dispara; ✓ inline/lote (`cicloHoje/*`) fazem
   `UPDATE` direto pra `aprovado_aguardando_disparo` SEM RPC, SEM disparo (dependem do cron 13h).
   → dá pra "aprovar" pelo ✓ achando que disparou.
3. **Armadilha de rollout:** ligar um gate fail-closed sobre memória vazia bloquearia **100%**
   dos disparos no deploy (geração defaulta tudo → gate barra). Hoje tudo dispara liso.

## 2. Escopo

### Construir agora (substrato mínimo)
1. **Geração lê a memória** — `gerar_pedidos_sugeridos_ciclo` deixa de cravar; LEFT JOIN
   `fornecedor_condicao_pagamento_padrao` (empresa+fornecedor): tem memória → usa a condição dela
   + `condicao_origem='memoria_fornecedor'`; sem memória → fallback `'000'/'À Vista'/'default_a_vista'`.
2. **Seed + backfill (bootstrap honesto)** — migration que (a) semeia a memória dos fornecedores
   ativos do motor com `'000'/'À Vista'`, origem **`bootstrap_founder_confirmado`** (campo de
   provenance — NÃO `manual_humano`, ninguém confirmou 1-a-1; o founder confirmou EM BLOCO);
   (b) backfilla os pedidos abertos ainda em `default_a_vista` com a memória recém-criada.
3. **Escrita da memória na confirmação** — confirmar uma condição (1-clique "Confirmar À Vista",
   ou setar um prazo no painel) grava/atualiza `fornecedor_condicao_pagamento_padrao` do fornecedor
   (via RPC dedicada `confirmar_condicao_pedido` — SECURITY DEFINER, gate staff).
4. **Trilha de aprovação canônica** — ✓ inline, lote e modal passam TODOS por
   `aprovar_pedido_sugerido` (RPC) → disparo. Acaba o `UPDATE` direto do `cicloHoje`.
   (Extrair o "aprovar+disparar" do `useDetalhesModal.aprovarMutation` pra helper compartilhado;
   preservar a edição de `num_skus`/qtd do ✓ inline ANTES da RPC.)
5. **Gate de condição FLAGÁVEL** — modo em `company_config` (`reposicao_condicao_gate_mode` ∈
   `off|warn|enforce`, default **`warn`**):
   - `aprovar_pedido_sugerido` + a edge de disparo leem o modo. `enforce` → recusa
     `default_a_vista` (retorna `{error, codigo:'condicao_pendente'}`, **não** `falha_envio`).
     `warn`/`off` → permite, só sinaliza.
   - Kill switch: o founder muda o modo no `company_config` sem deploy.
6. **Sinal "condição pendente" (SEM status novo — §5 da unificação)** — derivado de
   `condicao_origem='default_a_vista'`. UI: badge "condição pendente" + 1-clique "Confirmar À Vista".

### Adiar (codex — não construir às cegas)
Gestão rica de prazos · import/sugestão automática de condição do Omie · UI avançada de parcelas ·
otimização de caixa · workflows de negociação. (O substrato ENABLES prazos; a UI rica entra quando
o founder sinalizar que vai usar prazo de fornecedor.)

## 3. Design por peça

### 3.1 Geração lê memória (money-path — cuidado máximo)
- Substituir o literal `'000', 'À Vista', 1, NULL, 'default_a_vista'` por valores vindos de um
  LEFT JOIN à memória. **Cardinalidade:** a memória é PK `(empresa, fornecedor_nome)` = 1 linha/
  fornecedor → o LEFT JOIN no `GROUP BY fornecedor_nome` não multiplica linha. Validar em PG17
  (anti-regressão: contagem de pedidos/itens idêntica com memória vazia E com memória populada).
- `condicao_origem` resultante: `memoria_fornecedor` (tem memória) | `default_a_vista` (sem).
- ⚠️ Corpo da RPC é grande e tocado por sessões paralelas (CLAUDE.md §10) → partir do corpo de
  MAIOR timestamp, espelhar verbatim + o delta. PG17 obrigatório.

### 3.2 Seed + backfill (migration)
- Seed: `INSERT INTO fornecedor_condicao_pagamento_padrao (empresa, fornecedor_nome,
  ultima_condicao_codigo, ultima_condicao_descricao, ...)` para cada fornecedor ativo do motor
  (`sku_parametros` ativo+habilitado, `fornecedor_nome` não nulo, OBEN). Origem honesta — usar
  uma coluna de provenance (ver §6 dep: a tabela NÃO tem coluna de origem; adicionar
  `origem text` + `confirmado_por`/`confirmado_em`, ou registrar em `fonte_omie_pedido_id` um
  sentinel — decidir no plano). `ON CONFLICT DO NOTHING` (idempotente).
- Backfill: `UPDATE pedido_compra_sugerido SET condicao_origem='memoria_fornecedor', ...`
  para os abertos em `default_a_vista` cujo fornecedor agora tem memória.

### 3.3 Escrita na confirmação — RPC `confirmar_condicao_pedido(pedido_id, codigo, descricao, ...)`
- SECURITY DEFINER, gate staff. Seta a condição no pedido + `condicao_origem='manual_humano'` +
  **upsert** na memória do fornecedor (origem `manual_humano`, `confirmado_por=auth.uid()`).
- "Confirmar À Vista" 1-clique = chamar com `'000'/'À Vista'`.

### 3.4 Trilha canônica
- Helper compartilhado `aprovarEDisparar(pedidoId)` (extrai de `useDetalhesModal.aprovarMutation`,
  reusa `interpretarRespostaDisparo`). ✓ inline/lote passam a chamá-lo. Remove o `UPDATE` direto
  do `cicloHoje/PedidoRow.tsx` + `useCicloHoje.ts`.
- ⚠️ Preservar a edição de `num_skus`/qtd do ✓ inline (a RPC não toca `num_skus`) ANTES da RPC.

### 3.5 Gate flagável
- `company_config.reposicao_condicao_gate_mode` (text, default `'warn'`). Lido pela RPC de
  aprovação e pela edge de disparo. `enforce` recusa `default_a_vista`.

### 3.6 Sinal derivado
- Front: `condicao_origem === 'default_a_vista'` → badge + CTA. Sem status novo.

## 4. Rollout (sequência do codex)
1. Migration: +coluna de provenance na memória · seed fornecedores ativos (`bootstrap_founder_confirmado`)
   · backfill abertos. Config `gate_mode='warn'`.
2. RPC geração lê memória (deploy via SQL Editor — é migration).
3. RPC `aprovar_pedido_sugerido` + `confirmar_condicao_pedido` (gate-aware).
4. Edge `disparar-pedidos-aprovados` lê o modo (deploy Lovable APÓS merge).
5. Front: trilha canônica + confirm 1-clique + sinal.
6. **1 ciclo em `warn`** → lista "pedidos que SERIAM bloqueados". Se só fornecedor-novo → flip
   `gate_mode='enforce'` (config, sem deploy).

## 5. Decomposição sugerida em sub-PRs
- **Sub-PR 2a (backend substrato):** migration (provenance + seed + backfill + config) · geração
  lê memória · `confirmar_condicao_pedido` · gate flagável na `aprovar_pedido_sugerido` + edge.
  Gate default `warn`. PG17 em todas as RPCs.
- **Sub-PR 2b (frontend):** trilha canônica (unifica os 3 caminhos) · "Confirmar À Vista" 1-clique
  · sinal "condição pendente". TDD nos helpers puros.
- **Flip para `enforce`:** config change após 1 ciclo de warn (não é PR).

## 6. Dependências abertas (resolver no plano, antes de codar)
- 🟣 **DB read (founder):** (a) `'000'/'À Vista'` está `ativo` em `omie_condicao_pagamento_catalogo`
  OBEN? (efetivamente sim — a geração já o usa e dispara; confirmar). (b) Lista/contagem de
  fornecedores ativos do motor (pro seed). (c) Valores distintos de `condicao_origem` hoje em
  `pedido_compra_sugerido` (esperado: `default_a_vista`; talvez `manual_humano`/`ia_sugerida`).
- A tabela `fornecedor_condicao_pagamento_padrao` **não tem coluna de origem/provenance** →
  decidir no plano: adicionar `origem`/`confirmado_por`/`confirmado_em`, ou reusar
  `fonte_omie_pedido_id`. (Codex: provenance honesta é requisito.)
- Confirmar o corpo VIVO de `gerar_pedidos_sugeridos_ciclo` (maior timestamp) antes de tocar.

## 7. Validação
- PG17 (`db/verify-snapshot-replay.sh` base): geração com memória vazia (= comportamento atual,
  anti-regressão de contagem) E com memória populada (condição vem da memória) · `confirmar_condicao_pedido`
  faz upsert · gate `warn` permite / `enforce` recusa `default_a_vista`. TDD nos helpers puros do front.

## 8. Não-objetivos
- Gestão rica de prazos / parcelas / negociação / import Omie (adiados — §2).
- Esconder "quem aprovou" (Fase 3 opcional).
- Novo status enum (o sinal é derivado de `condicao_origem`).
- Tela única (Fase 3).
