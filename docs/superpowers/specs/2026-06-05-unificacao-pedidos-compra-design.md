# Unificação da tela de pedidos de compra (Reposição) + comportamento de aprovação seguro

**Data:** 2026-06-05
**Empresa:** OBEN (única com reposição automática)
**Tipo:** money-path (gera pedidos de compra reais a fornecedores Omie + portal Sayerlack/Renner)
**Escopo (founder):** "tudo junto" — UI + backend de idempotência na mesma frente.
**Validação:** Codex consult + agente de confirmação no código + passe adversário de 5 lentes (workflow). Todos os achados abaixo são **confirmados contra o código atual**.

> ⚠️ **Veredito da validação adversária:** a v1 deste spec tinha um furo conceitual — o claim de `status` proposto só cobre o caminho Omie, não o Sayerlack. Esta v2 corrige e incorpora os P1.

---

## 1. Problema

### 1.1 Redundância visual (queixa original)
`/admin/reposicao/sessao/pedidos` (etapa 3 do wizard) renderiza **dois painéis da MESMA lista, empilhados**: `CicloHojePanel` "Pedidos do ciclo" (em cima) + a página inteira `AdminReposicaoPedidos` embutida em `CicloHojePanel.tsx:144-146` "Pedidos do dia" (embaixo). Mesmos pedidos, duas vezes. O painel de baixo faz a **própria query** e **ignora os filtros do topo**. (Confirmado: as duas fontes têm SELECTs diferentes — `useReposicaoSessao.useItensDoDia` SELECT reduzido × `AdminReposicaoPedidos` SELECT `*`.)

### 1.2 Dois "Aprovar" divergentes (armadilha silenciosa)
- **✓ inline** (`cicloHoje/PedidoRow.tsx:54-99`) e **lote/auto** (`cicloHoje/useCicloHoje.ts:88,139`): `update({status:'aprovado_aguardando_disparo'})` **direto**, sem RPC, sem disparo, sem validar condição. Dependem do cron das 13h.
- **"Aprovar" do modal** (`pedidos/useDetalhesModal.ts:181-236`): exige condição (client-side), chama RPC `aprovar_pedido_sugerido`, encadeia a edge de disparo — aprova **E dispara na hora**.

Dá pra aprovar pelo ✓ inline achando que disparou, e o pedido fica parado. Nada avisa.

### 1.3 Terceira tela órfã `/admin/portal-sayerlack`
Painel de monitoramento do portal (Sayerlack-only). Uso real = **conciliar** travado + ver presos (incidente 02/06: 324 presos, ninguém viu 2 dias).

### 1.4 Riscos de idempotência no disparo (CONFIRMADOS)
"Aprovar = sempre dispara" aumenta a frequência de disparos e expõe:
- **R2 — duplicação Omie (não-Sayerlack):** `disparar-pedidos-aprovados/index.ts:672` chama `IncluirPedCompra` e só **depois** grava `status='disparado'`+`omie_pedido_compra_id` (`:686-705`). **Sem claim/lock antes**. Disparo imediato + cron correndo juntos = 2 PVs no Omie. Há `cCodIntPed=AFI-<id>` (`:653`), mas a dedup depende do comportamento do Omie (não verificável no código — ver §8).
- **R1 — duplicação portal Sayerlack:** o `status` do pedido **fica `aprovado_aguardando_disparo`** durante todo o sub-fluxo do portal (`aguardando_portal_sayerlack` é só em memória, `:566-584`). A idempotência é o claim de `status_envio_portal` (`envio_portal_claim_ids`) + pré-checks (`:403-426`). **Há 2 versões** da RPC de claim (`20260604150000` larga × `20260604180000` lista-positiva) — confirmar qual está em prod.
- **R3 — cron/seleção:** `disparar-pedidos-aprovados-oben` (`20260527230000:49`, diário 13h, `data_ciclo=hoje`) filtra só `status='aprovado_aguardando_disparo'`; idempotência delegada aos pré-checks, não ao filtro.

---

## 2. Objetivo

Uma **tela única** de pedidos de compra OBEN, **um** comportamento de aprovação seguro, e o **disparo à prova de duplicação**. Aposentar `/admin/portal-sayerlack` absorvendo conciliação + visibilidade de travados.

## 3. Não-objetivos

- Repensar a estrutura do wizard de 7 etapas (item separado, com Codex).
- Esconder a coluna "quem aprovou" (Fase 3 opcional, roadmap §9).
- Mudar a geração (`gerar_pedidos_sugeridos_ciclo`) — exceto o ajuste de `em_transito` (§5).
- Reescrever a automação do portal.

---

## 4. Decisões de design

### 4.1 Tela única — layout

Uma tabela de `pedido_compra_sugerido` (OBEN), **fonte única** (o SELECT `*` de `AdminReposicaoPedidos` é a base canônica; o filtro client-side opera sobre ela). Default: ciclo de hoje. Toolbar: busca + fornecedor + status + chip **"⚠ N precisam de atenção"**.

- **Chip "atenção" = query CROSS-CICLO dedicada** (não a query `data_ciclo=hoje` da lista): traz travados de qualquer ciclo — `status_envio_portal IN (aceito_portal_sem_protocolo, indeterminado_requer_conciliacao)` OU `status='falha_envio'` (de **qualquer** fornecedor, inclusive Omie direto) OU preso em `enviando_portal`/`pendente_envio_portal` antigo. Hoje **nada** mostra um `falha_envio` de ciclo passado — é cobertura nova.
- **Ação contextual por linha:**
  - `pendente_aprovacao` / `bloqueado_guardrail` → **Aprovar** (=dispara) · Cancelar · Detalhes. O motivo do bloqueio (`mensagem_bloqueio`) deve aparecer na linha (tooltip), não só no modal.
  - `aprovado_aguardando_disparo` / `falha_envio` → **Disparar** · Detalhes. O motivo da falha (`resposta_canal.erro`) visível na linha/chip (hoje só no modal).
  - `disparando` → estado em-voo, só "Disparando…" (sem Cancelar/Disparar).
  - `status_envio_portal` em conciliação → **Conciliar** (dialog inline) · Detalhes.
  - `disparado` → **Omie** (link) / protocolo.
  - `disparado_simulado` (dry-run) → badge próprio + ação adequada (ver §8: confirmar modo OBEN).
- **Split:** o **pai** `split_em_filhos` não tem ação útil; esconder/agrupar (senão a lista mostra 1 pai morto + N filhos e o "valor do ciclo" parece inflado).
- **Deep-link `?id=N` abre o pedido N** (e-mails de alerta linkam pra `/admin/reposicao/pedidos?id=`). Aceitar `?pedido=` como alias (alguns links do portal usam — hoje quebrado). **Funcionar nas duas rotas** (sessão + standalone).
- Ciclos anteriores: acesso discreto (filtro de data), não default.

### 4.2 Aprovação canônica + gate de condição

- **Uma trilha canônica:** ✓ inline, lote e modal passam todos por `aprovar_pedido_sugerido` (RPC) → disparo. Acaba o `update` direto. (Extrair a lógica aprovar+disparar de `useDetalhesModal.aprovarMutation` pra helper compartilhado.) ⚠️ O ✓ inline hoje grava `num_skus: qty` (edição na hora) — a RPC não toca `num_skus`; preservar a edição antes da RPC ou decidir descartar.
- **Gate de condição (fail-closed em DOIS pontos):**
  - (a) **Aprovação:** a RPC `aprovar_pedido_sugerido` passa a **rejeitar** aprovar+disparar com `condicao_origem='default_a_vista'`. Hoje ela valida só transição de estado, não condição.
  - (b) **Disparo:** a edge (e o cron) **recusa** pedido com `condicao_origem='default_a_vista'` em vez de mandar À Vista ao Omie. ⚠️ **Não jogar em `falha_envio`** (vira loop/ruído + label cru) — usar um **sinal distinto "condição pendente"** (ver §8, decisão aberta) que o operador vê e resolve.
  - **Micro-confirm "Confirmar À Vista" (1 clique):** grava `condicao_origem='manual_humano'`. ⚠️ Requer que o código `'000'` exista `ativo` no `omie_condicao_pagamento_catalogo` OBEN — verificar antes de oferecer o atalho (senão o disparo falha no Omie de qualquer jeito).
  - Editar itens/qtd/preço **não** re-invalida a condição confirmada — benigno pra À Vista (prazo 0), mas declarar (se for prazo real e o valor dobrar, a decisão foi tomada sobre outro valor).
- **Memória de condição por fornecedor (decisão §9.4):** ao confirmar uma condição (`manual_humano`), gravar/atualizar em `fornecedor_condicao_pagamento_padrao`. A geração `gerar_pedidos_sugeridos_ciclo` passa a usar a **última condição confirmada do fornecedor** como default, caindo em `default_a_vista` **só** pra fornecedor SEM histórico → a confirmação vira 1×/fornecedor-novo, não 1×/pedido. ⚠️ Migrations antigas já liam essa tabela; investigar por que hoje cai sempre em default (§8.6) antes de mexer na RPC de geração.
- **Lote = revisão antes de mandar:** resumo (total R$, fornecedores, prazos), dispara só os de condição confirmada; os de default ficam separados como "precisam confirmar".

### 4.3 Idempotência do disparo — confirmado: o Omie deduplica por `cCodIntPed`

⭐ **Descoberta (doc do Omie):** `IncluirPedCompra` com `codigo_pedido_integracao` (`cCodIntPed`) **duplicado é rejeitado** ("Pedido de compra já cadastrado"). O nosso `cCodIntPed=AFI-<id>` é **estável por pedido** → o Omie **não cria PV duplicado**, mesmo sob corrida disparo-imediato × cron. **Isso ELIMINA o estado `disparando` da v2** (que cegava 5 consumidores): confiar na chave de idempotência que o Omie já tem é mais simples e mais seguro que inventar um lock de status.

**(A) Omie (qualquer caminho que cria PV):**
- A chave é o `cCodIntPed=AFI-<id>` (já enviado, `:653`). **Sem estado/lock novo:** o pedido fica `aprovado_aguardando_disparo` durante o disparo síncrono e vira `disparado`/`falha_envio`. Como o status não muda pra um valor novo, o `em_transito` da geração já o conta, o Sentinela já o vigia e o `cancelar` já o trata → **nenhum vigia fica cego**.
- **Tratamento do erro "já cadastrado" (CRÍTICO — novo):** hoje qualquer erro → `falha_envio`. Esse erro específico significa "o PV JÁ existe" → **reconciliar**: buscar o PV por `cCodIntPed` (`ConsultarPedCompra`) e marcar `status='disparado'` com o número, NÃO `falha_envio`. Sem isso, a 2ª tentativa de uma corrida vira falsa-falha. (Mínimo viável se `ConsultarPedCompra` por código não existir: marcar `disparado` sem o número e o sync preenche depois.)
- **Guard barato extra:** `omie_pedido_compra_id IS NULL` antes de chamar (se já tem número, não re-chama).
- **Split:** cada filho tem `cCodIntPed=AFI-<filho_id>` → idempotente por filho; o pai (`split_em_filhos`) não vai ao Omie. Sem claim no pai (que quebraria o `pedido_compra_split`).

**(B) Portal Sayerlack — assíncrono (portal-first):**
- A idempotência é o claim de `status_envio_portal` via **`envio_portal_claim_ids` (lista-positiva)**, que **todas** as rotas já tocam (orquestrador async/sync + `DispararAgoraButton`, que chama o portal direto pulando a edge).
- Pré-requisitos pro claim ser confiável:
  - (i) versão **lista-positiva** (`20260604180000`) em prod — confirmar (§8.3);
  - (ii) **normalizar** `status_envio_portal` → `pendente_envio_portal` antes do claim (a lista-positiva não cobre NULL/`nao_aplicavel` → sumiria silencioso);
  - (iii) o UPDATE de `pendente_envio_portal` em `iniciarEnvioPortalSayerlack:428-440` **condicional** (`.neq('status_envio_portal','enviando_portal')`) pra não rebaixar um envio em voo.

**Resultado:** sem estado novo, sem TTL/varredor (e suas races). Os dois mecanismos de idempotência **já existem** (cCodIntPed do Omie + claim do portal); o trabalho é (a) tratar "já cadastrado" como reconciliação, (b) endurecer o claim do portal (i/ii/iii).

### 4.4 Aposentar `/admin/portal-sayerlack`

- Rota → **redirect** pra `/admin/reposicao/pedidos`. ⚠️ **No MESMO PR** em que a conciliação inline existir no destino (o `how_to_fix` do alerta `reposicao_portal_humano` manda "conciliar em /admin/reposicao" — não aposentar antes da ação existir lá).
- **Preserva** (inline): conciliação (extraída de `PortalDetailDrawer.tsx:104-136,350-403`), visibilidade de travados (chip), erro por pedido (Detalhes).
- **Conciliação cuidadosa:** (a) checar `omie_pedido_compra_id IS NULL` antes de re-disparar/criar (a edge `conciliar-pedido-portal` hoje só protege por `portal_protocolo`); (b) distinguir `aceito_portal_sem_protocolo` (PO quase certo existe) de `indeterminado_requer_conciliacao` (ambíguo — verificar no portal ANTES) — hoje usam o mesmo dialog.
- **Remover o "Forçar reenvio" perigoso:** `reposicao/pedidos/PortalDrawer.tsx:145` oferece "Forçar reenvio" pra estados de conciliação → re-POST no portal = PO duplicado. Gatear/remover + substituir por Conciliar.
- **Descarta:** KpiCards, EstatisticasTab, HistoricoTab, PendentesTab, export CSV, **"disparar lote"** (cortado, §9.2).
- **Observabilidade (decisão §9.1):** taxa de sucesso 30d / aging / top-10 erros são a **única** superfície de QUALIDADE do canal, e o Watchdog é binário (parado/andando). → adicionar um **check de taxa de erro do portal** ao Sentinela (não preservar a tela). É a única adição NOVA de vigia; o resto do §5 ajusta vigias existentes.

### 4.5 Roteamento

Um componente canônico usado na etapa 3 do wizard E na rota standalone. `CicloHojePanel` para de embutir `AdminReposicaoPedidos`. ⚠️ `useItensDoDia` alimenta `deriveCurrentStep`/`getStepLocks` do stepper (`useReposicaoSessao.ts:81-197`) — inventariar esse acoplamento antes de trocar a fonte.

---

## 5. Sem estado novo de status (simplificação vs v2)

A v2 introduzia `disparando` e exigia ajustar 5 consumidores (`em_transito`, Sentinela `reposicao_disparo`, `cancelar`, bins do wizard, badges). Como a idempotência do Omie é o `cCodIntPed` (§4.3), **não há estado novo** → esses consumidores **não mudam**. Restam só dois itens triviais:
- **Tratamento "já cadastrado"** na edge `disparar-pedidos-aprovados` (reconciliar, não `falha_envio`) — §4.3 A.
- **Labels faltantes** em `statusMeta` (`pedidos/shared.ts:12`): `falha_envio` e `disparado_simulado` hoje caem em string crua; a tela única os expõe mais. Trivial.

**Mantém-se válido** (independe de estado novo): o check `reposicao_disparo` mede `aprovado_aguardando_disparo` >48h — com "aprovar=dispara" esse estado vira transiente, mas o check **ainda pega o pedido que crashou** sem disparar (fica preso em `aprovado_aguardando_disparo`), então **continua útil** (não esvazia como a v2 temia — sem `disparando`, o crash não escapa do raio do check). ⚠️ Ao adicionar o **check de taxa de erro** (§9.1), partir do corpo de MAIOR timestamp do `_data_health_compute` com TODOS os checks (a `20260604150000` dropou `reposicao_mapeamento_sayerlack`) e recriar `data_health_watchdog`+`fin_sync_heartbeat` JUNTO (CLAUDE.md §10).

**Risco residual mínimo:** cancelar um pedido na janela de ms entre aprovar e o disparo síncrono completar — a UI de aprovar+dispara não dá essa janela na prática, e cron-13h × cancelar-manual é raríssimo. Não justifica um estado novo; registrar e, se incomodar, adicionar guard no `cancelar` depois.

---

## 6. Reuso (~90% é montagem, não construção)

- **Base da tabela:** `AdminReposicaoPedidos.tsx` (adaptar: virar componente, +chip cross-cycle, +toolbar do `cicloHoje/FiltersToolbar`).
- **Linha contextual:** `pedidos/PedidoRow.tsx` já tem ação-por-estado — +Conciliar, +gate condição.
- **Trilha:** adaptar a camada de escrita de `cicloHoje/{PedidoRow,useCicloHoje}` (UI fica).
- **Reuso direto:** `DetalhesModal`/`useDetalhesModal`, `CancelarModal` (já usa a RPC), `interpretarRespostaDisparo` (helper puro), `dispararMutation`.
- **Conciliação:** extrair de `PortalDetailDrawer` pra componente inline.
- **Badges:** consolidar a duplicata `PortalStatusBadge` (portalSayerlack) × `PortalBadge`/`portalStatusMeta` (pedidos) — ficar com o clicável.
- **Descartar:** KpiCards, EstatisticasTab, HistoricoTab, PendentesTab, CSV, "Forçar reenvio".

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| 2ª tentativa de disparo bate "já cadastrado" no Omie e vira falsa-falha | Tratar como reconciliação (busca o PV, marca `disparado`) — §4.3 A |
| Cancelar na janela de ms do disparo síncrono | Risco residual mínimo; guard no `cancelar` só se incomodar (§5) |
| Editar `_data_health_compute` (pro check de taxa de erro) consolida o drift (perde `reposicao_mapeamento_sayerlack`) | Partir do corpo de maior timestamp com TODOS os checks |
| Pedido `aprovado_aguardando_disparo` de ciclo passado fica órfão (cron só vê hoje) | Decidir varredura/aging dos legados (§8) |
| Aposentar portal cega qualidade/tendência | Check de taxa de erro no Sentinela (§9) |
| Deploy de edge antes do merge pega main velha | Deploy só após merge; confirmar por comportamento |

## 8. Dependências abertas (resolver no plano, antes de codar)

1. ✅ **Comportamento do Omie com `cCodIntPed` duplicado — RESOLVIDO (doc do Omie):** `IncluirPedCompra` com código de integração repetido é **rejeitado** ("já cadastrado"). O `cCodIntPed=AFI-<id>` é a chave de idempotência → sem PV duplicado; simplificou o §4.3 (sem `disparando`). **Resta confirmar (menor):** `ConsultarPedCompra` por `cCodIntPed` existe? (pra reconciliar o número na 2ª tentativa; se não, o tratamento mínimo marca `disparado` e o sync preenche).
2. ✅ **Modo OBEN = `producao`** (confirmado founder): disparo real Omie/Renner. `disparado_simulado` só em teste → a tela trata como caso raro (badge), não estado dominante.
3. ✅ **Claim do portal = LISTA-POSITIVA (`20260604180000`) já em prod** (BLOCO A: `WHERE status_envio_portal IN ('pendente_envio_portal','erro_retentavel')`). Nada a aplicar. ⚠️ Não cobre `NULL`/`nao_aplicavel` → os pré-reqs (ii) normalizar e (iii) UPDATE condicional (§4.3 B) **seguem necessários**.
4. ✅ **Órfãos de ciclos passados = ZERO** (BLOCO C vazio): o cron pega tudo no dia → o fail-closed de condição **não precisa de varredura** de legados.
5. **Drift de `_data_health_compute`** — confirmar em prod qual conjunto de checks está vivo antes de editar.
6. ✅ **Memória por fornecedor (BLOCO B):** a RPC de geração **NÃO lê** `fornecedor_condicao_pagamento_padrao` (`geracao_le_memoria=false`) **e** a tabela está **vazia** (0 linhas) → preciso de **escrita** (gravar na confirmação) **+ leitura** (a RPC consultar; default só sem histórico). ⚠️ **Insight money-path:** **119/119 pedidos/30d = `default_a_vista`** (0 confirmados manualmente) → 100% das compras OBEN saem "À Vista" no Omie hoje. **Founder confirmou: compra à vista mesmo** → NÃO distorce o financeiro. **Calibração:** o gate fica LEVE — "Confirmar À Vista" (1 clique) domina, a memória elimina a repetição (1×/fornecedor), e o valor do gate vira a rede pro caso RARO de fornecedor com prazo (não fricção de rotina). O bloqueio fail-closed (§4.2) continua barato e correto.

## 9. Decisões de produto (fechadas pelo founder, 2026-06-05)

1. ✅ **Observabilidade:** adicionar um **check de taxa de erro do portal** ao Sentinela (`_data_health_compute`) — vigia "degradando sem travar" (falhas/total nos últimos N dias > limiar), complementando o Watchdog binário. NÃO preservar a tela.
2. ✅ **"Disparar agora em lote":** **cortar** — o motor `sayerlack_retry_orfaos` (*/15) + Disparar por linha cobrem; remove um botão que re-POSTa e duplica PO se mal usado.
3. ✅ **Estado "condição pendente":** criar um **sinal/estado distinto de `falha_envio`** pro pedido cujo disparo foi recusado por `default_a_vista` — o operador vê na fila e resolve (confirma condição). Não vira loop de retry nem ruído de `falha_envio`.
4. ✅ **Memória de condição por-fornecedor:** **fazer agora** (não follow-up). Ver §4.2.

## 10. Critérios de pronto

- Uma tela, sem painel duplicado; filtros valem pra lista inteira; deep-link `?id=` abre o pedido nas 2 rotas.
- Aprovar por qualquer caminho passa pela trilha canônica; `default_a_vista` não dispara sem confirmação (testado).
- **Sem duplicação no Omie:** o `cCodIntPed=AFI-<id>` é a chave (Omie rejeita duplicado — confirmado); a edge trata "já cadastrado" como reconciliação (testado).
- **Sem duplicação no portal** (claim lista-positiva + normalização + UPDATE condicional).
- `falha_envio`/`disparado_simulado` ganham label em `statusMeta` (não há estado `disparando` a tratar).
- Conciliação inline funciona (com guard `omie_pedido_compra_id`); "Forçar reenvio" perigoso removido; chip "atenção" mostra travados cross-ciclo.
- `/admin/portal-sayerlack` redireciona **no mesmo PR** da conciliação inline.
- CI verde; migrations validadas (PG local pros claims/RPCs); edges redeployadas após merge.

## 11. Faseamento sugerido

- **Fase 1 — Backend seguro:** tratamento "já cadastrado" → reconciliação no Omie (§4.3 A) + endurecer o claim do portal (i/ii/iii, §4.3 B) + validação de condição na RPC + sinal "condição pendente" + memória por fornecedor (escrita+leitura, §4.2) + **check de taxa de erro do portal** no Sentinela (§9.1). Pré: §8.3/§8.6. **Sem estado/migration novo de status** (idempotência = `cCodIntPed`, não `disparando`).
- **Fase 2 — Trilha canônica + gate de condição no frontend:** ✓ inline/lote pela RPC+disparo; micro-confirm que grava a memória por fornecedor; exibição do sinal "condição pendente".
- **Fase 3 — Tela única:** layout, conciliação inline (+guard `omie_pedido_compra_id`), chip cross-cycle, deep-link `?id=`, aposenta portal-sayerlack (mesmo PR), remove duplicação + "Forçar reenvio" + "disparar lote".

(Ordem/tamanho dos PRs ficam pro `writing-plans`.)
