# Plano — Redesign do "a caminho" (on-order) da OBEN (caminho MÉDIO: reconciliação como garantia)

**Data:** 2026-06-14 · **Escopo:** OBEN (money-path) · **Status:** PLANEJADO (não iniciado) · **Spec/arquitetura:** `docs/superpowers/specs/2026-06-14-reposicao-onorder-redesign-blueprint.md` (ler antes — invariante, achados do Codex, correção do físico-last).

## Decisões já travadas (não re-litigar)
- **Sem worker >400s no stack** (confirmado 2026-06-14) → arquitetura = edge fatiada + `pg_cron` reinvoca (template `fin_sync_cursor`).
- **EXISTE PO manual no Omie** (founder) + **webhook caiu mudo 5 semanas** → a **RECONCILIAÇÃO PERIÓDICA é a GARANTIA**; webhook/bump são só aceleradores.
- **INVARIANTE:** `pendente` subestimado → COMPRA DUPLA; superestimado → ruptura. NUNCA subestimar; fail-closed (não-completou = não-grava) é aceitável; gravar incompleto NÃO.
- **Ordem de leitura:** pendente PRIMEIRO, **físico POR ÚLTIMO** (recebimento no meio vira overcount seguro).
- **Réplica permanente por `nCodPed`** é o modelo (não scan diário que recomputa tudo).
- **Q1 morto:** o Omie NÃO filtra por `cEtapa=15`/saldo>0 (só por categoria operacional) → não há atalho que encolha o universo.

## Fase 0 — SONDA da semântica de data (GATE de tudo) · read-only, baixo risco · PRÓXIMO PASSO
Sem isso, particionar a reconciliação por data é chute no money-path.
- Adicionar action read-only **`probe_pedcompra`** numa edge (provavelmente `omie-sync-estoque` ou uma `omie-debug`): zero writes; recebe `nCodPed[]` conhecidos; pra cada um, chama `PesquisarPedCompra` com janelas de 1 dia em torno de **`dIncData` (emissão)** × **`dDtPrevisao` (entrega)** × janela de **alteração**, cada uma com `lApenasAlterados` false/true, **todos os 7 estados** habilitados, testando **D-1/D/D+1** (inclusividade); retorna {params, `nTotalRegistros`, IDs}.
- Rodar via SQL Editor (`net.http_post` + `x-cron-secret` do Vault) com POs reais cuja emissão e previsão sejam BEM distintas.
- **Saída:** o que `dDataInicial/dDataFinal` filtra (emissão? entrega? alteração?) + inclusividade dos limites. Se inconclusivo → **tratar data como NÃO-confiável** e a reconciliação NÃO pode depender só de janela de data (ver Fase 2, plano B).
- Codex (xhigh) no desenho da sonda + na leitura do resultado.

## Fase 1 — Réplica permanente por-PO (schema)
- Tabelas `reposicao_po` (1 linha/`nCodPed`: empresa, etapa, status terminal?, datas, `cCodIntPed`, saldo-derivado, `last_consulta_at`, `last_run_id`) + `reposicao_po_item` (por SKU: `nQtde`, `nQtdeRec`, saldo). RLS staff; escrita só service_role.
- Snapshot AGREGADO por SKU + ponteiro `run_id` (UI/motor lêem só o último run COMPLETO — padrão `v_clientes_nao_vinculados_atual`).
- Migration manual (SQL Editor) + validação PG17 com falsificação.

## Fase 2 — Motor de reconciliação (a GARANTIA) · cursor + pg_cron
Desenho final depende da Fase 0. Dois sub-caminhos:
- **2A (se a data for confiável):** particionar por janelas de data COMPLETAS (cada janela varrida start-to-finish numa invocação ≤~80-100s), **todos os 7 estados** (não só abertas — assim fechar/receber não desloca offset), cursor de janela em tabela, `pg_cron` `*/5`–`*/10` reinvoca até cobrir 2010→hoje. NUNCA remover PO por "sumiu da listagem"; só zerar após `ConsultarPedCompra` confirmar terminal.
- **2B (se a data NÃO for confiável):** reconciliação sem depender de janela de data — varrer por página com de-dup global por `nCodPed` (helper `pendente-entrada-po.ts` já tem isso, 11 rounds de Codex), aceitando que o full-cycle leva muitos ticks; OU consultar individualmente as POs que a réplica já conhece como abertas + um sweep de descoberta. (Detalhar com Codex após a Fase 0.)
- **Apply atômico no fim:** drenar eventos → `ConsultarPedCompra` de TODAS as abertas conhecidas → derivar pendente → **ler físico POR ÚLTIMO** → aplicar físico+pendente+markers numa transação (RPC `aplicar_snapshot_pendente` já existe, `20260611195000`, dormente — reusar/endurecer). Qualquer falha de consulta → BLOQUEIA (fail-closed).
- Claim/lease + fencing (RPCs `claim/finalizar_estoque_full_sync`, `20260611220000`, dormentes — reusar).
- Codex xhigh adversarial + PG17 com falsificação.

## Fase 3 — Webhook fast-path (ACELERADOR, não garantia)
- Diagnosticar por que o webhook caiu em 09/05 (secret? config no Omie? edge?) — ver `omie_webhook_events` (192 eventos, mudos desde 09/05) + qual `topic` (confirmar que `CompraProduto.*` estava entre eles).
- Ligar o processamento `TODO` do `omie-webhook` (~L142): webhook só PERSISTE o evento; cron curto drena `omie_webhook_events` pendentes + `ConsultarPedCompra` → atualiza a réplica. NÃO depender de `waitUntil`.
- Reconfigurar/validar o webhook no painel do Omie (founder).

## Fase 4 — App fast-path / bump (ACELERADOR)
- O bump `ConsultarPedCompra(cCodIntPed)` pós-`IncluirPedCompra` (#743) passa a atualizar a **réplica** (não o sync inteiro). O modo `only_pending` atual (que varre tudo) é aposentado.

## Fase 5 — Motor + Sentinela
- Motor `gerar_pedidos_sugeridos_ciclo`: `efetivo = fisico + pendente` (da réplica/snapshot), barreira fail-closed se o snapshot não estiver COMPLETO/fresco (migration `20260611200000` tem a barreira pronta — reusar). Remover de-dup dual-source.
- Sentinela: check `estoque_reposicao` via marcador do run completo (migration `20260611210000` pronta — reusar) + check do webhook mudo (alerta se `omie_webhook_events` parar de receber).

## Ordem de execução
Fase 0 (sonda) → decide 2A vs 2B → Fase 1 (schema) → Fase 2 (reconciliação) → Fase 5 (motor+Sentinela) → Fase 3/4 (aceleradores, podem vir depois, a reconciliação já garante correção). Cada fase money-path: Codex xhigh + PG17 com falsificação + deploy verbatim via Lovable + migration manual no SQL Editor.

## Interino (em prod AGORA)
O **#752** segura a OBEN (com furos conhecidos: `nTotalPaginas` sub-reporta, janela 180d, de-dup dual-source). É o estado bom-conhecido até o redesign entrar.
