# Reconciliação fail-closed de PO excluído no Omie — design (v1 robusta)

> Money-path (reposição/compras). Ver `docs/agent/reposicao.md` e `docs/agent/money-path.md`.
> Status: **design aprovado + revisado pelo Codex (gpt-5.6-sol) 2026-07-11**. Próximo: writing-plans → PG17 falsificado → PRs.
> Caso-origem: SKU `8689733572` (SELADORA NL.9245.00LT, OBEN), PO Omie #1115.

## 1. Problema

Um item pedido pelo app, cujo **pedido de compra é excluído direto no Omie**, some do cockpit de reposição por até 7 dias.

**Causa raiz (confirmada em prod, read-only):** o motor `gerar_pedidos_sugeridos_ciclo` calcula
`estoque_efetivo = fisico + estoque_pendente_entrada(a-caminho do Omie) + em_transito(a-caminho do nosso banco)`.
A CTE `em_transito` (ramo A, `migration 20260708171049:85`) soma `pci.qtde_final` de pedidos com
`status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido') AND data_ciclo >= hoje−7d`
**sem verificar se o PO ainda existe no Omie**. Quando o PO é excluído, o `omie-sync-estoque` remove as unidades do `estoque_pendente_entrada`, mas o `pedido_compra_sugerido` permanece `disparado` → `em_transito` **re-soma as mesmas unidades** por 7 dias → **dupla contagem fantasma** → efetivo inflado acima do ponto → não re-sugere.

**Caso #1115:** efetivo = 0 (físico) + 5 (a-caminho legítimo, PO #1092) + 3 (fantasma #1115) = 8 > ponto 6 → não re-sugere. Correção pontual já aplicada (pedido 1046 → `cancelado`); este doc é o **fix sistêmico**.

## 2. Decisão de abordagem

Escolhida a **Opção 1 (reconciliação)** — detecta que um pedido `disparado` teve o PO excluído no Omie e marca `cancelado`; o motor fica **intocado** e o `em_transito` (ramo A) para de contá-lo. A **fusão 2+3 ("fonte única de on-order")** fica como **v2** (depende de `coverage_check`: a janela `[−365d,+120d]` perde previsão nula/futura>120d → subestima → compra dupla; `reposicao.md:66`).

**Princípio dominante: precisão > recall.** O erro a evitar é o **falso-positivo** — cancelar um PO vivo faz o motor re-sugerir → **pedido duplicado ao fornecedor** (dinheiro real).

## 3. Revisão adversarial (Codex gpt-5.6-sol, 2026-07-11) — o que mudou

A v1 inicial inferia exclusão da **ausência do PO numa busca filtrada** (`PesquisarPedCompra` filtra por `dDtPrevisao`). O Codex mostrou que isso **não é fail-closed** (2 falsos-positivos reais):

- **Previsão editada:** um PO **vivo** cuja previsão é editada no Omie para nula/fora-da-janela some da busca sem ser excluído; o tracking mantém a previsão antiga → os guards por-previsão passam → cancela um PO vivo.
- **"30h" ≠ N runs:** `updated_at < now()−30h` prova só que ninguém tocou a linha, não que houve múltiplos runs ausentes. Uma **única** omissão silenciosa (`PesquisarPedCompra` que retorna `[]` por mudança de shape / página vazia espúria, ainda com `erros=0`) já autorizaria cancelamentos em massa.
- **`updated_at` é multi-writer** (nfe/cte/sku-items) → não significa "visto pelo `PesquisarPedCompra`"; não é evidência confiável de ausência nem permite contar runs.

**Correção central (aceita):** **provar exclusão por consulta direta por ID** (`ConsultarPedCompra` por `nCodPed` — já usado em `disparar-pedidos-aprovados:1047`), não por ausência numa busca filtrada. A ausência gera **candidatos** (barato); a **consulta por ID** dá a **prova positiva**. Isso fecha os 3 pontos acima de uma vez: previsão editada retorna o PO vivo → não cancela; a prova não depende da busca filtrada nem do `updated_at`.

## 4. Arquitetura revisada (2 fases + prova por ID)

Motor **intocado**. Quatro componentes, escala ~11 candidatos/ciclo (custo irrelevante frente ao risco financeiro):

```
[run completo do omie-sync-pedidos-compra]
   └─(1) coleta os IDs vistos durante o run; SÓ no fim LIMPO + não-filtrado chama a RPC de PUBLICAÇÃO
        └─ reposicao_publicar_run_completo (advisory lock + service_role): grava marcador IMUTÁVEL
           E carimba last_seen nos POs vistos, ATÔMICO (1 transação). Cadência só avança se a RPC ok.
[edge dedicada: reposicao-reconciliar-pos-excluidos]  (chamada pelo orquestrador após o sync completo)
   ├─(2) CANDIDATOS (SQL, não muta): pedidos disparado/aprovado c/ PO NÃO visto no último completo válido
   ├─(3) PROVA por ID: ConsultarPedCompra(nCodPed) de cada candidato → classifica evidência
   └─(4) MUTAÇÃO (RPC): cancela só com evidência suficiente + run_id válido + advisory lock + log atômico
```

Edge **dedicada** (não sobrecarregar `omie-sync-pedidos-compra`, síncrona com budget de 25s): isola a lógica money-path, budget próprio, testável, e as N chamadas `ConsultarPedCompra` (paralelizáveis com limite de concorrência).

## 3b. Revisão adversarial do CÓDIGO (Codex challenge gpt-5.6-sol xhigh, 2026-07-11) — bloqueou o PR1 v1

A 1ª implementação do PR1 carimbava `last_seen` **durante o upsert de cada página** e gravava o marcador no fim, pela edge, em 2 operações separadas. O Codex achou **6 P1 estruturais** que envenenariam a base de verdade:

1. **Sinal publicado antes do run ser válido** — completo que aborta no meio deixa POs com `last_seen` de um run sem marcador (candidatos espúrios no PR2/3).
2. **Run manual filtrado por fornecedor** carimba um subset com run_id sem marcador (`gravaHeartbeat=!fornecedorCodigo` impede o marcador) → sinal envenenado.
3. **`gravarRunCompleto` não fail-closed** — erro do PostgREST → `return null` ignorado pelo caller; `marcarCompletoOk` já avançou a cadência → cron não re-tenta completo por ~20h.
4. **Concorrência** — 2 completos concorrentes = mosaico de run_ids; a serialização tem de cobrir a **publicação** (last_seen + marcador), não só a mutação do PR3.
5. **`volume_ok` se autoenvenena** — baseline incluía runs `volume_ok=false`; e bootstrap `[0,0,0]` → `0 >= 0.9·0` = **`true`** (libera reconciliação total num shape que pareça página vazia).
6. **Base de verdade falsificável** — `INSERT ... WITH CHECK(true)` + `GRANT INSERT authenticated` deixa um cliente forjar um marcador (`volume_ok=true`, `finalizado_em` futuro) → todos os POs parecem ausentes.

**Correção estrutural (v2, aceita):** **deferir a publicação** — coletar os IDs durante o run e, **só após o fim limpo**, gravar marcador **E** carimbar `last_seen` numa **RPC SQL atômica, serializada por empresa (advisory lock), service_role-only**. `volume_ok` robusto. É o que a §5 abaixo descreve.

## 5. Componentes (novos objetos)

1. **`reposicao_pedidos_compra_run`** (insert-only, imutável) — 1 linha por run completo: `run_id uuid`, `empresa`, `janela_de/janela_ate date` (janela REAL, não `CURRENT_DATE`), `ids_distintos int`, `volume_baseline int`, `volume_ok bool`, `status`, `finalizado_em`. Marcador "último completo válido" = linha mais recente `status='ok' AND volume_ok IS TRUE`. **RLS: SELECT staff; INSERT/UPDATE NEGADOS a authenticated/anon — só `service_role`/a RPC SECURITY DEFINER escreve** (Codex P1 #6: senão a base de verdade é forjável).
2. **`reposicao_po_last_seen`** (empresa, omie_codigo_pedido → run_id, visto_seq, visto_em) — **tabela DEDICADA service_role-only** (RLS SELECT staff; SEM policy de escrita + `REVOKE INSERT,UPDATE,DELETE`). ⚠️ **ENTREGUE ASSIM, não como colunas em `purchase_orders_tracking`**: o Codex mostrou que aquela tabela é staff-writable, então um staff podia copiar o `run_id` do marcador atual para um PO excluído → ele deixava de ser candidato → **a prova por ID nunca rodava e o fantasma sobrevivia** (falso-negativo que fura a rede do PR2). Escrita SÓ pela RPC de publicação, no mesmo commit do marcador.
2b. **RPC `reposicao_publicar_run_completo(p_empresa text, p_run_id uuid, p_seq bigint, p_janela_de date, p_janela_ate date, p_ids bigint[])`** — publicação diferida atômica (SECURITY DEFINER, service_role-only). `p_seq` é um **FENCING TOKEN** da sequence `reposicao_run_seq`, alocado pela edge (via `reposicao_alocar_run_seq()`) **ANTES da 1ª página**, sem nenhum `await` de rede no meio: a ordem entre runs é a de **INÍCIO da coleta**, não a de publicação — senão um coletor que começa antes e publica depois recebe seq maior, vira o marcador e carimba o PO já excluído (falso-negativo). Numa transação: advisory lock por empresa → `volume_ok` (baseline = mediana dos últimos 5 runs `status='ok' AND ids_distintos>0 AND volume_ok IS NOT FALSE`, **mesma largura de janela** + últimos 10d; `ids=0` em run limpo = empresa vazia legítima → `true`; baseline nulo → `null` bootstrap) → INSERT marcador (`seq=p_seq`) → UPSERT `last_seen` **só se `volume_ok IS TRUE`**, com guard anti-regressão `visto_seq < EXCLUDED.visto_seq`. A cadência (`marcarCompletoOk`) avança se a RPC **não deu erro** (desacoplada do `volume_ok`, senão volume baixo starva o completo). **EM PROD desde 16/07** (validado: bootstrap null → 2º run baseline 512 → 512 POs carimbados).
3. **`reposicao_po_reconciliacao_candidato`** — acumula as confirmações por-ID através de runs: `run_id`, `empresa`, `pedido_id`, `omie_codigo_pedido`, `resultado` (`cancelado_explicito` | `nao_encontrado` | `vivo` | `ambiguo`), `previsao_no_omie`, `confirmado_em`. Permite exigir 2 confirmações para "não-encontrado".
4. **`reposicao_po_reconciliacao_log`** — auditoria dos cancelamentos efetivos (espelha `reposicao_estoque_nao_confirmado_log`): `run_id, empresa, pedido_id, omie_codigo_pedido, omie_numero, evidencia, criado_em`. RLS: SELECT staff (`pode_ver_carteira_completa`), INSERT authenticated `WITH CHECK true`.
5. **RPC `reposicao_pos_candidatos(p_empresa, p_run_id)`** — não-mutante; retorna os candidatos: pedidos `disparado`/`aprovado_aguardando_disparo`, `omie_pedido_compra_id/numero NOT NULL`, `data_ciclo >= hoje−7d`, cujo PO **não foi visto no marcador atual** — i.e. `reposicao_po_last_seen` (empresa, omie_codigo_pedido) tem `run_id <> p_run_id` **OU não tem linha** (nunca carimbado). ⚠️ O vínculo é `pedido_compra_sugerido.omie_pedido_compra_id`(text) = `reposicao_po_last_seen.omie_codigo_pedido`(bigint)::text. `p_run_id` tem de ser o **marcador atual** (maior `seq` com `status='ok' AND volume_ok IS TRUE`) — a RPC valida e aborta se for stale (§8). PO nunca-carimbado vira candidato de propósito (fail-closed): a prova por ID resolve — PO novo volta `vivo` e não é cancelado.
6. **RPC `reposicao_reconciliar_pos_excluidos(p_empresa, p_run_id, p_dry_run bool DEFAULT true)`** — a mutação final (§6).

## 6. Guards e evidência (a lógica de cancelamento)

A **fase 3** (edge) classifica cada candidato via `ConsultarPedCompra(nCodPed)`:
- **PO retornado com etapa 90 (CANCELADO):** `cancelado_explicito` — evidência positiva forte.
- **Fault "pedido não encontrado" (código específico do Omie):** `nao_encontrado` — evidência de exclusão.
- **PO retornado vivo (etapa ≠ 90):** `vivo` — o PO existe (previsão editada etc.) → **NÃO cancelar**; re-sincroniza a linha do tracking. Reseta a contagem.
- **Rate-limit / fault genérico / timeout / shape ambíguo:** `ambiguo` → **NÃO age** (fail-closed).

A **fase 4** (RPC `reposicao_reconciliar_pos_excluidos`) cancela `pedido_compra_sugerido` → `status='cancelado'`, `cancelado_por='reconciliacao_auto_po_excluido_omie'`, `justificativa=<evidência+run_id>` **só quando**:
- **`cancelado_explicito`:** ≥1 confirmação basta.
- **`nao_encontrado`:** ≥2 confirmações em **runs completos distintos** (sem `vivo` no meio) — anti-transitório real (conta observações, não tempo).
- **Concorrência (§8):** `p_run_id` = marcador atual (`expected_run_id`) e advisory lock por empresa; senão aborta.
- **Alvo:** `status IN ('disparado','aprovado_aguardando_disparo')`, `omie_pedido_compra_id/numero NOT NULL` (não cai no ramo B do `em_transito`), nunca `concluido_recebido`.

`p_dry_run=true` (default) retorna o que **seria** cancelado sem mutar (o §12 usa isso; nunca chamar a versão mutante para "preview").

## 7. Status: reusar `cancelado`

`pedido_compra_sugerido.status` é `TEXT` livre. Reusar `cancelado` (não criar `cancelado_no_omie`): motor 100% intocado (ramo A conta só os 3 vivos; ramo B exclui `cancelado`, `motor:91`) e evita auditar os ~20 arquivos de UI que consomem `status`. Auditoria via `cancelado_por='reconciliacao_auto_po_excluido_omie'` + `justificativa`.

**Ressalva do Codex [P2] (aceita):** reusar o status **não** dispensa auditar os *consumidores* — o risco não é visual, são consumidores que tratem a transição para `cancelado` como comando (cancelar no Omie, notificar, liberar retry, alterar relatório). O plano **audita cada consumidor** de `status='cancelado'` e usa `cancelado_por` como subtipo obrigatório.

## 8. Concorrência e atomicidade

Cron completo + botão manual + retry podem competir. Medidas (Codex [P1]):
- **`pg_advisory_xact_lock`** por empresa na RPC de mutação.
- **`run_id` imutável** na `reposicao_pedidos_compra_run`; a RPC recebe `expected_run_id` e **aborta** se não for o marcador válido mais recente (não reconcilia contra o run de outra execução).
- **Update + log na MESMA transação**, log alimentado **só** pelo `RETURNING` do `UPDATE ... WHERE status IN (...)` (idempotente; sem log duplicado).
- **`marcarCompletoOk` fail-closed:** a RPC de publicação (2b) retorna sucesso/falha; a cadência (`marcarCompletoOk`) só avança se a publicação teve sucesso — senão o próximo ciclo re-tenta o completo (não perde ~20h; Codex P1 #3).
- **A publicação do PR1 também é serializada por empresa** (o mesmo `advisory_xact_lock` da RPC 2b) — o marcador + o `last_seen` saem no MESMO commit, então dois completos concorrentes não deixam mosaico de run_ids (Codex P1 #4). Não basta lockar só a mutação do PR3.

## 9. Observabilidade

- `reposicao_po_reconciliacao_log` (cancelamentos) + `reposicao_po_reconciliacao_candidato` (trilha de confirmações por-ID).
- Telemetria `reposicao.po_reconciliado` (contagem por run) + `reposicao.po_candidato_vivo` (falso-positivo evitado — candidato que a consulta por ID salvou).
- Fila "precisa de atenção": linha neutra recolhida quando houver reconciliações no último run (auto-resolução benigna, não-vermelho).

## 10. Casos de aceitação (PG17, com falsificação)

**Positivos (cancela + item volta):**
- **A (gabarito #1115):** PO `nao_encontrado` por ID em 2 runs distintos, pedido `disparado` na janela 7d, marcador válido → cancela; motor re-sugere (qtde correta, como o pedido 1083 real: `ceil(8−5)=3`).
- **A2 (cancelado explícito):** `ConsultarPedCompra` retorna etapa 90 → cancela em 1 confirmação.

**Negativos (NÃO cancela):**
- **B (previsão editada — o furo que o Codex achou):** PO ausente da busca filtrada MAS `ConsultarPedCompra` retorna vivo → **não cancela**; re-sincroniza. Este é o caso que a v1 inicial errava.
- **C (1 run só):** `nao_encontrado` em 1 run apenas → não cancela (aguarda 2º).
- **D (volume baixo):** `volume_ok=false` (run completo truncado, poucos IDs) → marcador inválido → não cancela nada.
- **E (ambíguo):** `ConsultarPedCompra` retorna rate-limit/timeout/fault genérico → não cancela.
- **F (run_id stale):** `p_run_id` ≠ marcador atual → aborta.
- **G (recebido / vivo):** pedido `concluido_recebido`, ou PO etapa ≠ 90 → fora do alvo / não cancela.

**Falsificação (provar dente):** sabotar cada guard (aceitar 1 confirmação p/ não-encontrado; ignorar `volume_ok`; tratar `ambiguo` como exclusão; ignorar `expected_run_id`) e exigir **vermelho** — em especial que B/C/D/E/F voltem a cancelar indevidamente.

## 11. Segurança

- RPCs `SECURITY DEFINER` + `REVOKE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role`. **Sem** gate `auth.role()`/`auth.uid()` interno (mataria o cron — `reposicao.md`).
- A edge `reposicao-reconciliar-pos-excluidos` é `authorizeCronOrStaff` (padrão das edges de reposição).
- Escrita restrita: `UPDATE pedido_compra_sugerido` dos alvos + INSERT nos logs/candidatos. Nada mais.

## 12. Rollout (Lovable — PRs pequenos)

1. **PR1 — infra de run (não muta pedido):** tabela `reposicao_pedidos_compra_run` (RLS SELECT staff, escrita **só service_role**) + colunas `last_seen_pedidos_full_*` + **RPC `reposicao_publicar_run_completo`** (publicação diferida ATÔMICA: advisory lock + marcador + `last_seen` no mesmo commit; `volume_ok` robusto) + edge `omie-sync-pedidos-compra` **coleta os IDs e chama a RPC 1× no fim do completo LIMPO e não-filtrado** (não carimba no upsert; cadência só avança se a RPC ok). Migration (SQL Editor) + edge (chat Lovable). **PG17 falsifica os 6 P1 do Codex:** publicação parcial em abort, run filtrado, fail-closed da cadência, concorrência/lock, autoenvenenamento do `volume_ok` (baseline + bootstrap `[0,0,0]`), e a RLS service_role-only (INSERT authenticated deve FALHAR).
2. **PR2 — candidatos + prova por ID (dry-run):** RPC `reposicao_pos_candidatos` + tabela de candidatos + edge `reposicao-reconciliar-pos-excluidos` com `ConsultarPedCompra` + `reposicao_reconciliar_pos_excluidos(p_dry_run=true)`. **Não muta pedido ainda** — só popula candidatos e loga o que *seria* cancelado. Observa em prod por ≥2 ciclos.
3. **PR3 — mutação real:** liga `p_dry_run=false` (via `company_config`), com todos os guards de evidência + concorrência + auditoria. Só após PR2 provar (candidatos batem com a realidade, zero `vivo` cancelado).
4. **PR4 — UI:** linha neutra na fila de atenção + selo.
5. **Pós-deploy:** rodar o motor e verificar via `psql-ro` que os fantasmas (ex.: pedido 409/PO #1073 latente) foram reconciliados; re-invocar o recompute.

Cada PR tem PG17 falsificado próprio + Codex challenge no diff (money-path).

## 13. Escopo explicitamente fora (v2+)

- Fusão 2+3 (fonte única de on-order no motor) — depende do `coverage_check` medido.
- Reversão automática de PO ressuscitado.
- Status dedicado `cancelado_no_omie` + badge de UI.
