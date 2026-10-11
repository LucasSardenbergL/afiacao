# Picking v2 — separação por bipe no celular (Oben + Colacor)

> Spec de desenho, 2026-10-10. Status: **Fase 0 em andamento** (0.1–0.3 entregues). Etapa de DESTINO no Omie: o founder cria e passa o código; a trava de faturamento é pergunta aberta (§2.1).

## 1. Por que reescrever

Medido em prod (psql-ro, 2026-10-10):

- `picking_tasks`, `picking_task_items`, `picking_events`: **`n_tup_ins = 0`** — o módulo do #567 nunca foi usado. As 4 RPCs da bridge estão aplicadas; o problema não é deploy.
- `listar_pedidos_a_separar` só exclui cancelado/rascunho/orçamento → na Oben (60d) devolve 611 **faturados**, 127 importados, 73 separacao, 3 enviados (LIMIT 100). A fila é inútil.
- `sales_orders` não guarda a etapa crua do Omie: `omieEtapaToStatus` colapsa toda etapa fora de {20,50,60,70,80} — inclusive a **10** — em `importado`. E o `omie-vendas-sync` **descarta** pedidos (cliente fora do cache, desconto ilegível), então a fila não pode nascer de `sales_orders`.
- `omie_products` (8.054 linhas) **não tem EAN**; nenhum código de barras de produto no banco.
- Quantidade por item é alta: Colacor média **73 UN/item** (máx 1.000), Oben 10 (máx 2.000). Fracionário é raro (~1,5%): Colacor M²/M, Oben L.
- Bugs do v1 (sem dano, porque sem uso): `recalcular_picking_task` fecha por **soma global** (A=20,B=0 fecha um pedido A=10,B=10); `confirmar_item_picking` faz UPDATE **absoluto** (evento offline antigo inédito sobrescreve confirmação nova); `ceil` na quantidade; aba Estoque consulta `account='OBEN'` (dado é `oben`) → sempre vazia.

### 1.1 Diagnóstico da Fase 0.1 (edge `picking-fila-omie` v0.1, 2026-10-10 20:39Z, `net._http_response` id 110816)

- **Etapas** (operação 11 — Venda de Produto, iguais nas 2 contas): 00 Proposta (inativa) · **10 Pedido de Venda** · 20 Pedidos Robo · 50 Pedidos Normais · 60 Faturado · 70 Pedidos com Falha · 80 Faturado Robo. Ainda não existe etapa de "separado".
- **A etapa 10 é um acúmulo, não uma fila:** `ListarPedidos{etapa:'10'}` → **Oben 1.637 pedidos (33 páginas), Colacor 6.213 (125 páginas)**; a 1ª página traz pedidos de **2024 (Oben) e 2020 (Colacor)**. "Todo pedido na etapa 10 é separável" geraria milhares de tasks → a fila precisa de **corte por data** (ou limpeza do kanban) — 🧭 decisão do founder.
- **Contrato de linha OK** (50 pedidos/conta): `codigo_item` presente e único em 100% das linhas; quantidade válida em 100%; `dAlt/hAlt` em 100%. Fracionário: Oben 4/107 (L), Colacor 0/141 (1 linha M2).
- **EAN vem no próprio pedido:** `det[].produto.ean` existe na listagem (além de `ListarProdutos.ean`). Amostra do cadastro: Oben 30/50 com EAN (29 EAN-13, 1 EAN-8), Colacor 50/50 (1ª página — não representa os fabricados).

### 1.2 Fase 0.2 — trava compartilhada do Omie (2026-10-10)

- **Banco:** `omie_cota_metodo(conta, metodo)` com lease por token e `bloqueado_ate` (só aumenta); RPCs
  `omie_cota_tentar`/`omie_cota_liberar`/`omie_cota_registrar_fault`, só `service_role`
  (migration `20261010204708`, prova `db/test-omie-cota-metodo.sh` — 44 asserts, 9 sabotagens, no núcleo CI).
- **Edges:** `_shared/omie-cota.ts` coordena **só `ListarPedidos`** em `omie-vendas-sync`, `sync-reprocess`,
  `omie-desconto-backfill` e `picking-fila-omie`. **Fail-closed**: trava sem resposta → a chamada não é feita
  (o consumidor adia, como já adiava rate-limit). Timeout 80 s < lease 150 s; timeout ou "aguarde" não
  registrado retêm a vez até o lease vencer.
- **Causa provável dos bloqueios de 30 min:** o vendas-sync re-tentava REDUNDANT com espera limitada a 15 s
  mesmo quando o Omie pedia mais. No `ListarPedidos` isso acabou; os demais métodos seguem idênticos à main
  (Codex rodada 1 pegou que estender a regra a todos quebraria edição — exclui→reinclui itens — e
  cancelamento de pedido; rodada 2 confirmou 56 cenários idênticos).
- **Codex:** 3 rodadas — REPROVADO (2 P1 + 2 P2) → REPROVADO (2 P2) → **APROVADO**.
- **Fora de escopo, pré-existente:** `historico_produtos_cliente` grava o prefixo lido quando a paginação
  para no meio (rate-limit ou trava), sem sinalizar incompletude — não apaga nada.

### 1.3 Fase 0.3 — schema v2 + RPCs (2026-10-11)

- **Migration** `supabase/migrations/20261011020000_picking_v2_schema.sql`: tabelas `picking_tarefas`, `picking_linhas`,
  `picking_leituras` (imutável), `picking_codigos_barras` (só lida; cadastro = Fase 1), `picking_eventos`,
  `picking_coleta_estado` + view `picking_linhas_progresso`. RPCs: `picking_sincronizar_fila` (só service_role),
  `picking_pegar_task`, `picking_registrar_leitura`, `picking_marcar_falta`, `picking_retomar`, `picking_concluir`.
  As 3 RPCs de escrita v1 perderam o EXECUTE de authenticated.
- **Prova** `db/test-picking-v2.sh` (núcleo CI): 102 asserts, 16 sabotagens com controle verde e vermelho exato (inclusive cada camada de
  lock e cada camada de filtro de revisão sozinha), 3 cenários de 2 sessões. Codex do código: rodada 1 (1 P1 + 4 P2) e rodada 2 (1 P1: mesmo EAN em UN e CX) corrigidas.
- **Codex — desenho REPROVADO (10 P1 + 2 P2), corrigido antes do código.** O que mudou em relação à §3:
  - **Sem fechamento automático:** `picking_concluir` só fecha quando o servidor já recebeu TODAS as leituras que o
    aparelho emitiu na atribuição — estorno ou bipe em voo deixaria `separado` com o volume diferente. Estorno cujo
    original não chegou devolve `pendente` sem gravar.
  - **Toda volta passa por reconciliação física:** tarefa que já foi pega nunca volta direto a `aguardando` (inclusive
    `aguardando_ajuste` com o pedido alterado → `suspensa_alteracao`, ≠ §3.1); `picking_retomar` sempre exige
    `reconciliacao_fisica`; assumir a tarefa de outro operador também.
  - **`estado_seq`** na tarefa: `pegar`/`retomar` carregam o seq visto — comando atrasado não age sobre outro ciclo.
  - **Corte de data só decide a admissão:** a sync recusa o lote se uma tarefa acompanhada presente na listagem vier
    sem detalhe. **EAN entra no hash da linha** (corrigir EAN no Omie exige reconciliação). Código cadastrado tem
    `unidade` e só aloca em linha da mesma unidade.
  - **Idempotência amarrada ao comando:** o UUID guarda o comando canônico; reuso com outro conteúdo é 22023; a conta é
    validada antes do replay.
  - **Protocolo de ausência:** a edge lista, consulta os ausentes (`ConsultarPedido`, com teto) e faz UMA chamada.
  - `service_role` (BYPASSRLS) também sem DML direto nas tabelas.

### 1.4 Fase 0.5 — coleta da fila (2026-10-11, #2948 + #2961)

- **0.5a (leitura, #2948):** modo `coleta` da edge mede a listagem filtrada por data, com a prova amostral do filtro (os 100 mais recentes da etapa 10 sem filtro têm de estar na filtrada). Gate para ligar a escrita: listagem completa, `perdidos_pelo_filtro = 0`, cobertura da janela, ordenação confirmada e casos elegíveis — nas duas contas.
- **0.5b (escrita, #2961, Codex r1–r6):** reserva exclusiva por conta (`picking_coleta_reservar`, lease 150 s, intervalo 90 s) com token validado pela sync; `p_listagem_suspeita` veta a ausência; janela da listagem = min(hoje−30, `incluido_em` da tarefa aberta mais antiga) — acompanhada nunca sai por idade.
- **Sem `ConsultarPedido`:** coordenar esse método com o `vendas-sync` fica para depois (risco de bloqueio da app_key, Codex r3). Até lá, ausência **não interrompe** nada: 2 coletas completas seguidas sem o pedido (`ausente_rodadas ≥ 2`) **bloqueiam** pegar/assumir/leitura positiva/retomar/concluir (`ausente_do_omie`); reaparecer desbloqueia. 1 ausência não bloqueia (troca compensada entre páginas). Ausente há ≥ 10 coletas sai da janela e segue bloqueada.
- Cron (0.5c) só depois da 1ª escrita manual conferida por conta.

### 1.5 Fase 1 — leitor e tela (desenho aprovado pelo founder em 2026-10-11)

- **Hardware de referência:** Zebra WT6400 (braço, versão GMS) + RS6100 (anel Bluetooth via DataWedge), hands-free; TC22/TC53e/MC3400 pelo mesmo caminho. App segue **PWA no Chrome**; DataWedge por **keystroke**. Plano B (Capacitor + Intent) só se o piloto medir perda.
- **Protocolo sem heurística de velocidade:** DataWedge envia `~~` + AIM symbology id + código + ENTER. `~~` em ≤ 50 ms arma a captura; sem ENTER em ~300 ms = truncada (descartada com aviso); alfabeto `^(]..)?[0-9A-Za-z\-.]{1,64}$`; mesmo código em ≤ 250 ms = double-decode ignorado. Captura no `window` em fase de captura (fora do React), com qualquer foco; digitação manual só pelo campo dedicado. Perfil exato: `docs/runbooks/datawedge-picking.md`.
- **Fluxo:** captura → `leitura_id` (UUID) gerado NA CAPTURA → fila FIFO em IndexedDB → **previsão local** (mesmos motivos do servidor; o servidor é a autoridade) → som + vibração em < 50 ms → envio em ordem, uma por tarefa, com backoff, para `picking_registrar_leitura` (idempotente pelo UUID). Servidor discordou da previsão = tom de alerta + correção da tela. `picking_concluir` recebe todos os UUIDs da atribuição.
- **Tela "olhar só se der erro":** fundo verde/vermelho/âmbar em tela cheia + número grande; sem `alert()`/`confirm()`/modal no fluxo; Wake Lock. Sons sintetizados (Web Audio) e destravados no toque de "pegar".
- **Medição (`track()`):** `picking.task_pega`, `picking.leitura` (motivo, divergência da previsão, tentativas), `picking.leitura_capturada` (latência captura→feedback), `picking.leitura_duplicata`, `picking.leitura_falhou`, `picking.falta`, `picking.separado`.
- **Cadastro de código com aprovação master:** RPCs próprias (migration da Fase 1), revisadas pelo Codex.

## 2. Decisões do founder (2026-10-10)

| Tema | Decisão |
|---|---|
| Papéis | **Uma pessoa separa e confere** (o bipe é a conferência); gesto: "bipa e coloca no volume do pedido" |
| Fila | **Todo pedido na 1ª etapa do kanban do Omie (10)** está liberado para separar — Oben e Colacor iguais |
| Leitura | **1 bipe por unidade**; caixa/caixa master com código próprio conta N unidades |
| Sem código | Itens fabricados (sobretudo Colacor) sem EAN → confirmação manual (depois: etiqueta Code128 interna) |
| Falta | **O app NÃO permite concluir** com falta: a task trava em "aguardando ajuste comercial"; vendas edita o pedido no Omie; o app reflete a nova versão |
| Edição no Omie | Proibida durante a separação (regra de processo; o app **detecta** e suspende — não consegue travar o Omie) |
| Código de caixa novo | Só **master** aprova |
| Pós-separação | App avança a etapa no Omie (`TrocarEtapaPedido`) para a etapa que o founder vai criar — **Fase 2, modo sombra primeiro** |
| Aparelho | Recomendado: coletor **Zebra TC22** (DataWedge em modo teclado); 1 unidade no piloto. Alternativa: Galaxy A16 + leitor Elgin EL300 |

### 2.1 Decisões de 2026-10-11 (repassadas pela sessão "Análise do módulo de picking")

| Tema | Decisão |
|---|---|
| Corte da fila | **Por data**: só pedidos da etapa 10 **incluídos nos últimos 30 dias** (o acúmulo — Oben 1.637 desde 2024, Colacor 6.213 desde 2020 — fica fora). Sem limpeza do kanban. Destrava o cron da fila (Fase 0.5). O corte decide só a ADMISSÃO (§1.3): tarefa já acompanhada segue recebendo detalhe. |
| Aparelho | O founder compra **1 Zebra TC22 (SE4710)** para o piloto da Fase 1. |
| Destino / faturamento | 🧭 **Pergunta de desenho em aberto, não requisito fechado.** O founder quer uma etapa nova no Omie (só para visualização; ele cria e passa o código), o pessoal usando **só o app** para tirar o pedido, e "o pedido só pode ser faturado se foi conferido antes — uma trava em AMBOS, Omie e app". A investigar **antes de prometer**: (a) trava no app = faturamento bloqueado sem `separado` (direto); (b) trava no Omie = não se sabe se o Omie bloqueia faturamento por etapa ou permissão — talvez só dê para DETECTAR (NF emitida de pedido não conferido → alerta), não impedir. Decide-se com o founder + Codex na Fase 2. |

## 3. Arquitetura

### 3.1 Fila: edge dedicada `picking-fila-omie` (1 escritor)

Fatos da API (doc oficial `produtos/pedido/`, 2026-10-10): `ListarPedidos` aceita filtro **`etapa`** (string 2); `infoCadastro.dAlt`/`hAlt` = última alteração; `TrocarEtapaPedido(codigo_pedido, etapa)` existe; códigos de etapa via `ListarEtapasFaturamento`.

- Cron seg–sáb horário comercial, **deslocado** do `vendas-sync-continuacao-6min` (`*/6`) — minuto ≡ 3 (mod 6) — porque a trava anti-redundância do Omie morde o MÉTODO por conta (incidente do recebimento, 2026-07-16). Sem retry em REDUNDANT.
- Por conta (`oben`, `colacor`): `ListarPedidos{etapa:'10'}` paginando até página vazia (com guard).
- Entrega a lista inteira a UMA RPC transacional `picking_sincronizar_fila(account, pedidos jsonb, listagem_completa bool)`:
  - pedido novo → nasce task `aguardando` com linhas do `det` (qtd **numeric**, unidade, `codigo_item` do Omie como identidade de linha) + `versao_omie` (`dAlt hAlt` + hash do `det`);
  - versão mudou com task aberta → linhas **iguais mantêm o progresso**, linhas alteradas/removidas zeram (evento `linha_revisada`); task `em_separacao` vai a `suspensa_alteracao`; task `aguardando_ajuste` volta a `aguardando`;
  - pedido some da listagem **e** `listagem_completa=true` → task aberta vira `interrompida_externa` (nunca com listagem truncada — fail-closed).
- Item ilegível (sem código, qtd ≤ 0 ou não numérica) → o pedido inteiro fica `bloqueado_dado` com motivo; nunca pula a linha em silêncio.

### 3.2 Leituras: eventos que SOMAM

- `picking_leituras` imutável: `id uuid` (gerado no aparelho = idempotência offline), task, linha, código lido, `unidades` (já convertidas), operador, `atribuicao_id`, `lido_em` (aparelho) e `recebido_em` (servidor).
- `quantidade_separada` = soma das leituras aceitas da linha (derivada, nunca escrita de fora).
- Rejeições no servidor: código fora do pedido, excesso sobre a linha, atribuição antiga (outro operador pegou), task fora de `em_separacao`.
- Desfazer = leitura negativa vinculada (`estorna_leitura_id`), nunca UPDATE.

### 3.3 Estados da task

`aguardando` → (pegar, atômico) `em_separacao` → todas as linhas exatas → `separado` → (Fase 2) `sincronizando_etapa` → `pronto_para_faturar`.
Desvios: `aguardando_ajuste` (falta marcada), `suspensa_alteracao` (pedido mudou no Omie), `interrompida_externa` (saiu da etapa 10 por fora), `bloqueado_dado`.
Fechamento **por linha**: cada linha `separada == pedida` (sem compensação entre produtos; excesso bloqueia).

### 3.4 Códigos de barras

`picking_codigos_barras(codigo, account, omie_codigo_produto, unidades_por_leitura numeric, origem omie|aprendido, status pendente|aprovado|revogado, criado_por, aprovado_por)`. Código desconhecido bipado → separador propõe produto+fator → **não conta** até master aprovar. Fator alterado não reinterpreta leituras passadas (a leitura grava `unidades`). EAN do Omie: popular a partir do cadastro de produtos (fase própria; campo a confirmar no payload).

### 3.5 Fracionário

Linha guarda qtd decimal e unidade do Omie. Item em M²/M/L/KG: entrada **digitada** (sem bipe por unidade), registrada como leitura `manual`. Sem `ceil`.

### 3.6 Contratos adicionados pela revisão Codex (rodada 2, gpt-6-astra xhigh)

Rodada 1 → a spec fecha **soma global**, **UPDATE absoluto** e **falta faturável**; rodada 2 apontou o que segue, todos ADOTADOS:

1. **Cota compartilhada da `app_key`:** minuto deslocado não basta. Cooldown/lease **persistido por (conta, método)** e respeitado por todos os consumidores de `ListarPedidos` (inclusive `vendas-sync-continuacao`) — investigar se já existe trava compartilhada em `_shared` antes de criar. **Nenhum cron novo antes disso.**
2. **Listagem não é fotografia:** comparar com `total_de_registros`; ausência só vira `interrompida_externa` depois de **confirmada individualmente** (`ConsultarPedido`, com teto por rodada).
3. **Coletas concorrentes:** lease por conta + **geração monotônica** (`coleta_iniciada_em`); a RPC rejeita coleta mais velha que a última aplicada.
4. **Revisão por linha:** cada linha tem `revisao`; leitura carrega a revisão; a soma conta **só a revisão vigente**; leitura offline de revisão antiga é registrada e rejeitada. Retomar uma task revisada exige **reconciliação física** (operador confirma que devolveu/reconferiu o volume) — zerar no banco não tira peça do volume. Reabrir `separado` é transição explícita.
5. **Serialização:** `pg_advisory_xact_lock` por task em sincronização, leitura, falta e conclusão (mesma ordem de aquisição); UUID já processado é resolvido ANTES do estado atual; estorno limitado ao saldo da mesma linha/revisão.
6. **Servidor é autoridade da conversão:** o aparelho manda só o código lido; o servidor resolve código aprovado → produto/fator. `picking_sincronizar_fila` é **exclusiva do service_role** (REVOKE de `PUBLIC`, `anon`, `authenticated`) — senão `pedidos=[]` forjado interromperia a conta inteira. Conta validada no servidor em toda RPC; chaves e FKs carregam `account`.
7. **Hash canônico só do que é físico:** `(codigo_item, codigo_produto, quantidade, unidade)` — preço/imposto não forçam recontagem. `codigo_item` ausente/duplicado → `bloqueado_dado`. Mesmo produto em várias linhas: o bipe aloca na primeira linha incompleta por `codigo_item`.
8. **Recuperação explícita:** transições para retomar suspensa, corrigir `bloqueado_dado` e reentrada na etapa 10; pedido sem linhas → `bloqueado_dado` (igualdade vazia nunca conclui).

## 4. Fases

- **Fase 0 — fundação (sem tela), na ordem do Codex:**
  1. Confirmar contratos/payloads nas 2 contas (read-only, 1 chamada por método): `ListarEtapasFaturamento`, paginação de `ListarPedidos{etapa:'10'}`, estabilidade de `codigo_item`, campo do EAN no cadastro de produto.
  2. Coordenação de cota com o `vendas-sync-continuacao` (§3.6.1) — antes de qualquer cron.
  3. ✅ Schema v2 + RPCs (`picking_sincronizar_fila`, `picking_pegar_task`, `picking_registrar_leitura`, `picking_marcar_falta`, `picking_retomar`, `picking_concluir`) com invariantes, revisões, autorização e recuperação; caminhos de escrita v1 desativados (§1.3).
  4. Prova PG17: ✅ RPCs (concorrência, replay offline fora de ordem, revisão, isolamento de conta, REVOKE — §1.3); ✅ coletor testado com páginas mutáveis, resposta atrasada e REDUNDANT (Deno, §1.4).
  5. ✅ Coleta controlada **sem alterar tasks** (modo leitura, #2948); ✅ escrita com reserva (#2961, §1.4); ⏳ cron.
- **Fase 1 — piloto (WT6400/TC22, §1.5):** tela mobile v2 (fila, pegar, bipe, manual, falta, retomar, concluir), `track()`, cadastro de código com aprovação master.
- **Fase 2 — Omie:** modo sombra ("viraria a etapa agora", comparado ao manual), depois `TrocarEtapaPedido` com ledger por passo + reconsulta (money-path, Codex).
- **Depois:** etiqueta interna para itens sem EAN; endereço de prateleira e rota.

## 5. Régua

- Unidade decisória: unidade do item no Omie (decimal), leitura convertida por `unidades_por_leitura`.
- Sinal de produto (denominador): pedidos **observados** entrando na etapa 10 × tasks `separado` pelo app, mesma janela.
- Prova: PG17 executando as RPCs + sabotagem (filtro de etapa, igualdade por linha, idempotência, isolamento de conta, revisão de versão) com controle verde na mesma invocação.
- Irreversível só no fim: escrita no Omie apenas após o modo sombra concordar.

## 6. Fora de escopo agora

FEFO/lote; endereçamento; romaneio; faturamento parcial (falta sempre volta para vendas).
