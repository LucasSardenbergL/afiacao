# Reconciliação fail-closed de PO excluído no Omie — design (v1)

> Money-path (reposição/compras). Ver `docs/agent/reposicao.md` e `docs/agent/money-path.md`.
> Status: **design aprovado (abordagem)**, aguardando revisão do doc → writing-plans → PG17 falsificado → Codex → PRs.
> Data: 2026-07-11. Caso-origem: SKU `8689733572` (SELADORA NL.9245.00LT, OBEN), PO Omie #1115.

## 1. Problema

Um item pedido pelo app, cujo **pedido de compra é excluído direto no Omie**, some do cockpit de reposição por até 7 dias — não volta a ser sugerido.

**Causa raiz (confirmada em prod, read-only):** o motor `gerar_pedidos_sugeridos_ciclo` calcula
`estoque_efetivo = fisico + estoque_pendente_entrada(a-caminho do Omie) + em_transito(a-caminho do nosso banco)`.
A CTE `em_transito` (ramo A) soma `pci.qtde_final` de pedidos `pedido_compra_sugerido` com
`status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido') AND data_ciclo >= hoje−7d`
**sem verificar se o PO ainda existe no Omie**.

Quando o PO é excluído no Omie, o sync de estoque (`omie-sync-estoque`) corretamente **remove** as unidades do `estoque_pendente_entrada` (a-caminho do Omie cai). Mas o `pedido_compra_sugerido` permanece `disparado` (o app nunca soube da exclusão) → a CTE `em_transito` **re-soma as mesmas unidades** por até 7 dias → **dupla contagem fantasma** → o efetivo fica inflado acima do ponto de pedido → o motor não re-sugere.

**Caso #1115:** efetivo = 0 (físico) + 5 (a-caminho Omie legítimo, PO #1092) + 3 (`em_transito` fantasma do #1115 excluído) = 8 > ponto 6 → não re-sugere. Correção pontual já aplicada (pedido 1046 → `cancelado`); este doc é o **fix sistêmico**.

## 2. Decisão de abordagem

Avaliadas 3 opções (brainstorming 2026-07-11). Escolhida a **Opção 1 (reconciliação no sync de POs)**:

| Opção | O que faz | Veredito |
|---|---|---|
| **1 — Reconciliação (ESCOLHIDA v1)** | Detecta no sync que um pedido `disparado` tem o PO ausente do Omie → marca `cancelado`. Motor intocado; `em_transito` auto-corrige. | Ataca a causa raiz (estado factualmente errado). Menor superfície de risco. |
| 2 — `em_transito` robusto | Motor cruza cada pedido com `purchase_orders_tracking` em runtime. | Acopla o motor ao tracking; mexe na função QUENTE; exige `coverage_check` (`reposicao.md:66`). → subsumida pela v2. |
| 3 — Semântica anti-dupla | `em_transito = max(0, pedido − já_no_Omie)`. | Elimina a sobreposição estrutural, mas a forma correta (por-PO) exige rastreabilidade que só a 2 traz; erra em POs mistos; mexe na função quente. → v2. |

**A fusão 2+3 ("fonte única de on-order") é registrada como v2** — projeto próprio, dependente do `coverage_check` que o `reposicao.md:66` exige (a janela `[−365d,+120d]` perde previsão nula/futura>120d → subestima → compra dupla). Quando a v2 existir, ela **subsume** esta v1 (com o tracking por-PO como fonte, o fantasma nunca aparece). A Opção 1 é o degrau seguro, não um beco.

**Princípio dominante (money-path): precisão > recall.** O erro a evitar é o **falso-positivo** — declarar um PO vivo como excluído faz o motor re-sugerir → **pedido duplicado ao fornecedor** (dinheiro real). Por isso todo o design é **fail-closed**: na dúvida, NÃO cancelar.

## 3. Arquitetura

Dois componentes; o motor **não é tocado**.

1. **RPC SQL-pura** `public.reposicao_reconciliar_pos_excluidos(p_empresa text)` — toda a lógica money-path em SQL (provável no PG17). `SECURITY DEFINER`, `SET search_path`, protegida por **REVOKE anon/authenticated + GRANT service_role** (padrão cron SQL-local — NUNCA gate `auth.role()`, que mataria o cron; ver `reposicao.md`). Retorna `TABLE(reconciliados int, avaliados int)`.
2. **Chamada na edge** `omie-sync-pedidos-compra`: ao fim de um run **completo e saudável** (`modo=completo`, `erros=0`), após gravar o marcador `sync_state('pedidos_compra_full')`, invoca a RPC. Idempotente e barata (varre ~dezenas de pedidos). Se a edge falhar em chamar, o próximo run completo re-tenta (auto-recuperável). A RPC **re-valida** todos os guards internamente (defense-in-depth: não confia no chamador).

   **Enriquecer o marcador (pré-requisito):** hoje `sync_state('pedidos_compra_full')` grava `metadata {}` (só cadência). A edge passa a gravar nele `{erros, total_pedidos, finished_at}` ao fim do run completo — assim o marcador é **auto-suficiente** para o guard de saúde da RPC (senão os `erros` só existem no registro `pedidos_compra`, que é o último run de *qualquer* modo, podendo ser um incremental posterior). Mudança pequena e aditiva.

Por que no run **completo**: a reconciliação precisa de **cobertura garantida** (365d passado + 120d futuro). O incremental cobre só 60d passado → um PO fora dessa janela pareceria ausente sem estar. Ancorar no completo elimina essa classe de falso-positivo.

## 4. Lógica da RPC (fail-closed)

Marca `pedido_compra_sugerido` → `status='cancelado'`, `cancelado_por='reconciliacao_auto_po_excluido_omie'`, `cancelado_em=now()`, `justificativa_cancelamento='PO ausente do Omie em run completo saudável (previsão na janela)'` **somente quando TODOS os guards passam**:

**Alvo (quem é elegível):**
- `empresa = p_empresa`
- `status IN ('disparado','aprovado_aguardando_disparo')` — **nunca** `concluido_recebido` (mercadoria chegou) nem status já mortos.
- `omie_pedido_compra_id IS NOT NULL AND omie_pedido_compra_numero IS NOT NULL` — foi ao Omie e não está no ramo B do `em_transito`.
- `data_ciclo >= CURRENT_DATE − 7` — a janela que o `em_transito` conta (fora dela, cancelar não muda nada; escopo mínimo).

**Guards (todos fail-closed — qualquer um falso ⇒ não cancela):**
1. **Saúde do sync (coverage global):** o último `sync_state('pedidos_compra_full', lower(empresa))` tem `status='complete'`, `metadata->>'erros' = '0'` **e** `updated_at > now() − intervalo_saude` (default `26h`). Sem run completo recente e limpo, **não se pode concluir ausência** → RPC retorna 0. (Requer o marcador enriquecido da §3.)
2. **PO ausente do run completo:** a linha em `purchase_orders_tracking` (join por `omie_codigo_pedido::text = omie_pedido_compra_id`) tem `updated_at < sync_state('pedidos_compra_full').updated_at`. O run completo saudável de 365d **não tocou** o PO ⇒ ele não existe no Omie. (Reforço explícito; sob `intervalo_reconciliacao > intervalo_saude` já é implicado pelos guards 1+4, mas ancora direto no marcador sem depender da aritmética dos thresholds.)
3. **Cobertura por-PO (anti-#1072):** `data_previsao_original BETWEEN CURRENT_DATE−365 AND CURRENT_DATE+120`. Previsão **nula ou fora da janela** ⇒ o `PesquisarPedCompra` (filtra por `dDtPrevisao`) legitimamente não cobre o PO ⇒ **não concluir exclusão**.
4. **Anti-transitório (persistência):** `purchase_orders_tracking.updated_at < now() − intervalo_reconciliacao` (default `30h`, cobrindo >1 run completo diário + margem). Uma omissão de página do Omie num único run não dispara cancelamento.
5. **PO não-cancelado no tracking:** se o tracking já marca `status='CANCELADO'` (etapa 90), é caminho separado (o Omie devolveu o PO como cancelado, não excluído) — tratar igual (cancelar o pedido), mas registrar `motivo='po_cancelado_no_omie'` vs `'po_ausente_no_omie'`.

`intervalo_saude`, `intervalo_reconciliacao` e o alvo ficam em `company_config` (calibráveis; defaults conservadores acima). Números finais serão **challengeados pelo Codex**.

## 5. Status: reusar `cancelado` (não criar `cancelado_no_omie`)

`pedido_compra_sugerido.status` é `TEXT` livre. Reusar `cancelado`:
- **Motor 100% intocado** — ramo A do `em_transito` só conta os 3 status vivos; ramo B exclui `cancelado` explicitamente. Um status novo cairia no ramo B (obrigaria mexer no motor) e exigiria auditar ~20 arquivos de UI que consomem `status`.
- **Auditoria preservada** por `cancelado_por='reconciliacao_auto_po_excluido_omie'` (espelha a correção manual `reconciliacao_manual_po_excluido_omie`) + `justificativa_cancelamento`.
- **Reversível manualmente** — o registro **preserva** `omie_pedido_compra_id/numero`; nada é apagado.

Um status dedicado + badge na UI fica como refinamento futuro se o founder quiser distinção visual (não bloqueia v1).

## 6. Observabilidade

- Tabela de auditoria `reposicao_po_reconciliacao_log` (espelha `reposicao_estoque_nao_confirmado_log`): `run_id, empresa, pedido_id, omie_pedido_compra_id, omie_pedido_compra_numero, sku_resumo, po_updated_at, marcador_completo_em, previsao, motivo, criado_em`. RLS = SELECT staff (`pode_ver_carteira_completa`), INSERT authenticated `WITH CHECK true`.
- Telemetria `reposicao.po_reconciliado` (via `track()` no consumidor de fila) — contagem por run.
- A tela de Pedidos ganha, na fila "precisa de atenção", uma linha neutra recolhida quando houver reconciliações no último run (não-vermelho: é auto-resolução benigna, não ação humana).

## 7. Reversibilidade e risco residual

- **Não há reversão automática** na v1 (raro: exclusão no Omie é definitiva). Se um PO "ressuscitar" no Omie após cancelamento, o log + `omie_pedido_compra_id` preservado permitem reverter manualmente. Reversão automática = v2.
- **Risco residual conhecido:** se o Omie omitir um PO vivo por > `intervalo_reconciliacao` **e** o run completo reportar `complete/erros=0` apesar da omissão (paginação silenciosamente incompleta), haveria falso-positivo. Mitigação: o guard 3 (previsão na janela) + o `pagina-até-vazia + fingerprint` da edge (#1076) reduzem; o Codex avaliará se cabe um guard de **volume mínimo** do run completo (ex.: total de POs retornados ≥ X% do histórico) antes de confiar na ausência.

## 8. Casos de aceitação (PG17, com falsificação)

**Positivos (deve cancelar + o item volta a ser sugerido):**
- **A (gabarito #1115):** PO excluído (tracking congelado > 30h, previsão na janela), pedido `disparado` data_ciclo dentro de 7d, run completo saudável recente → pedido vira `cancelado`; rodar o motor → **re-sugere o SKU** (qtde correta, como o pedido 1083 real: `ceil(8−5)=3`).

**Negativos (NÃO pode cancelar):**
- **B (PO vivo — #1092):** PO fresco no tracking (`updated_at` no último batch) → guard 2/4 falham → não cancela.
- **C (falha transitória):** PO congelado há < `intervalo_reconciliacao` (ex.: 10h) → guard 4 falha → não cancela.
- **D (sync não-saudável):** último `pedidos_compra_full` com `status≠complete` OU `updated_at` velho (>26h) → guard 1 falha → **não cancela nada** (mesmo com POs congelados).
- **E (previsão fora da cobertura):** PO com `data_previsao_original` nula ou > hoje+120d → guard 3 falha → não cancela (o sync legitimamente não o cobre).
- **F (recebido):** pedido `concluido_recebido` → fora do alvo → não cancela.

**Falsificação (provar que os asserts têm dente):** sabotar cada guard (ex.: remover o filtro de previsão; baixar o threshold para 0h; ignorar a saúde do sync) e exigir que o teste fique **vermelho** — em especial que B/C/D/E voltem a cancelar indevidamente.

## 9. Segurança

- RPC `SECURITY DEFINER` + `REVOKE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` (a edge chama com service_role; o cron SQL-local passaria como `postgres`). **Sem** gate `auth.role()`/`auth.uid()` interno (mataria o cron — `reposicao.md`).
- A RPC **não** recebe input de usuário além de `p_empresa` (allowlist de empresa; default `'OBEN'`).
- Escrita restrita a `UPDATE pedido_compra_sugerido` dos alvos + `INSERT` no log — nenhuma outra tabela.

## 10. Rollout (Lovable — 3 deploys manuais)

1. **Migration** (SQL Editor): cria `reposicao_po_reconciliacao_log` + RPC `reposicao_reconciliar_pos_excluidos`. Pré-flight: nenhum objeto de mesmo nome; `pg_get_functiondef` não aplicável (função nova). Validação pós-apply: `SELECT * FROM reposicao_reconciliar_pos_excluidos('OBEN')` (dry — deve retornar contadores sem erro).
2. **Edge** `omie-sync-pedidos-compra` (chat do Lovable, verbatim): adiciona a chamada da RPC ao fim do run completo saudável.
3. **Frontend** (Publish): a linha neutra na fila de atenção.
4. **Pós-deploy:** forçar um run completo (ou aguardar o cron 06:17 UTC) e verificar via `psql-ro` que o #1095 latente (e quaisquer outros fantasmas na varredura) foram reconciliados, e re-invocar o motor.

## 11. Escopo explicitamente fora (v2+)

- Fusão 2+3 (fonte única de on-order no motor) — depende do `coverage_check` medido.
- Reversão automática de PO ressuscitado.
- Status dedicado `cancelado_no_omie` + badge de UI.
- Guard de volume mínimo do run completo (a decidir com o Codex).
