# PR 5 — Gate v2 em modo SOMBRA + sensores (crédito-IA, plano detalhado 2026-11-25)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` (§9/§10 prevalecem) · roteiro `docs/superpowers/plans/2026-11-20-credito-ia.md` (linha do PR 5). Arquivo separado de propósito: o PR 4 (em voo) acrescenta ao fim do plano compartilhado.

## Fatos de prod (psql-ro, 2026-11-25)

- **O app quase não cria pedido.** `sales_orders.created_by` não nulo: 29 em toda a história; nos últimos 120 d, 2 (R$ 767 em ago e um teste de R$ 1,70 em 21/11). `credito_operacao_revisao` = 0 linhas desde o PR 3; `venda_bloqueio_credito_log` = 0 desde sempre. Nos últimos 14 d: **176 pedidos, R$ 213 mil, 106 clientes, todos nascidos no Omie** (oben 142 / R$ 200k; colacor 34 / R$ 13k). `colacor_sc` não tem `sales_orders`.
- **Decisão do Lucas (2026-11-25):** a sombra mede importados **e** app. Redução automática de limite + backtest IA × regra → **fatia 5b**, após o merge do PR 4.
- 100% dos 176 resolvem `(customer_user_id, account)` → par em `omie_customer_account_map` com dono único.
- Pull de pedidos a cada 2 h (`vendas-sync-pedidos-*-2h`); nas últimas 24 h, 21 de 26 pedidos já chegaram **faturados** na 1ª leitura.
- Elo PV→título: `fin_contas_receber.numero_pedido = sales_orders.omie_numero_pedido::text` (mesma empresa). Faturados de 30 d com título achado: oben 174/269 (65%), colacor 58/65. Os sem título: CR ainda não sincronizado (2×/dia) ou venda sem CR (à vista/cartão — não prova).
- Sync CR: `sync_state` `fin_cr_incremental_ok` / `fin_cr_full_ok` por `account` (cron 08:20 e 14:20 UTC; full ≤ 7 d por desenho).
- Pré-voo: corpo de `private.credito_avaliar_reservar` e `venda_gate_credito_grupo` na PROD = migration `20261124170000` (diff vazio).
- `sales_orders` não guarda parcela; importado → prazo **desconhecido** (`NULL`).

## Desenho

**Sem edge, sem Publish.** A sombra é um job SQL em lote, fora do caminho do pedido: `omie-vendas-sync` (arquivo quente, v1.47) não muda. Prova de "a sombra nunca altera a decisão real": nada no caminho do pedido chama a sombra; o único recurso partilhado é o advisory lock por grupo, liberado por COMMIT a cada pedido (o piso do PR 1 não toma esse lock).

### 1. Núcleo `private.credito_avaliar_reservar` (CREATE OR REPLACE, mesma assinatura → ACL preservado)
- **Frescor/cobertura do sync (§9.5):** novo helper `private.credito_sync_ok(p_companies text[]) RETURNS boolean` — `true` só se TODA empresa do escopo (par do pedido ∪ pares do grupo) tem `fin_cr_full_ok` ≤ 8 d **e** `greatest(incremental_ok, full_ok)` ≤ 26 h. Linha ausente → `false` (ausente ≠ fresco). Falso → 🟡 `sync_defasado` (motivo novo no CHECK de `credito_decisao_pedido`), avaliado depois de `piso_vencido_60d` (dívida comprovada prevalece) e de `piso_indeterminado`, antes de qualquer 🟢 (`reserva_existente`/`autorizado`/`dentro_limite`).
- **Títulos do próprio PV fora da exposição:** o pedido já entra como `p_valor`; título com `numero_pedido = omie_numero_pedido` do pedido (mesma empresa) não soma em `v_titulos` (soma-se uma vez). Continua contando no piso e no `v_indet`.
- Resto do núcleo idêntico (prova de regressão: a suíte do PR 2 + fronteira 60 roda contra a função nova).

### 2. Transferência comprovada reserva→título (§9.2) — `private.credito_reservas_conciliar(p_modo text)`
Por reserva `ativa` do modo, sob o advisory lock da raiz da reserva:
- pedido `cancelado` ou `deleted_at` → `liberada` (`pedido_cancelado`);
- pedido `faturado` **e** ≥ 1 título não cancelado com `numero_pedido` do PV, mesma empresa **e** mesmo código de cliente → `transferida`; residual `valor − Σ valor_documento` > max(R$ 1, 2%) → nova reserva `ativa` do residual (mesma decisão, motivo `residual_faturamento_parcial`);
- `faturado` sem título → **continua ativa** (nunca solta antes do título chegar) e conta no sensor `faturado_sem_titulo` (n, R$, idade) — é o dado que decide a regra do efetivo no PR 6.

### 3. Lote sombra — `private.credito_sombra_lote(p_max integer)` (PROCEDURE, `CALL` pelo pg_cron a cada 10 min)
- `pg_try_advisory_lock` de sessão (1 lote por vez); `SET LOCAL statement_timeout` por pedido.
- Candidatos: `sales_orders` `account IN (oben, colacor)`, `deleted_at IS NULL`, status ∉ (`cancelado`,`rascunho`,`orcamento`), `total > 0`, cuja **revisão corrente** ainda não tem linha no ledger. Revisão: do app → a última `credito_operacao_revisao` (valor/prazo dela); importado → `'omie:' || md5(items::text || total::text)` (valor = `total`, prazo `NULL`). Ordem `created_at`, até `p_max`.
- Janela: pedidos criados desde o marco de ativação **+ carga inicial** dos abertos (`importado/separacao/enviado`) no 1º lote (`carga_inicial=true`, fora da distribuição).
- Cada pedido num sub-bloco `BEGIN … EXCEPTION` (erro vira linha `erro` no ledger, nunca aborta o lote) e `COMMIT` depois de cada pedido (solta o lock do grupo).
- `total` ausente/≤ 0 → não avalia (ledger `pulado='valor_ausente'`). Par não resolvido → o núcleo dá 🟡 `sem_grupo`.
- Depois dos pedidos: `credito_reservas_conciliar('sombra')`.

### 4. Sensores (ledger, não PostHog) — nascem com a superfície
- `credito_sombra_avaliacao` (append-only, guarda/portão do PR 2, RLS gestor): pedido, empresa, origem `app|omie`, revisão, valor, prazo, `decisao_id`, faixa, motivo, `erro`, `pulado`, status na 1ª leitura, `carga_inicial`, `pedido_criado_em`, `avaliado_em`, `lote_id`. UNIQUE (pedido, empresa, revisão).
- `credito_sombra_lote_execucao`: início, fim, avaliados, erros, pulados, transferidas, liberadas, residuais.
- Views `security_invoker=on`: distribuição (dia SP × empresa × origem × faixa × motivo, n e R$), concordância v2 × piso (faixa × `piso.bloqueado`), tempo até decisão (sombra: `avaliado_em − pedido_criado_em` p50/p90; fila: `credito_solicitacao` → `decidida_em`, vazio até o PR 6).
- Query das 2 semanas: `db/medir-credito-sombra.sql`.

### Colacor sem catálogo
Prazo `NULL` (Colacor via app, ou qualquer importado) → 🟡 `prazo_ilegivel` pelo núcleo assim que houver limite; nunca 0, nunca 🟢. A query de medição separa "prazo desconhecido" por empresa e origem.

## Fora do PR 5 (declarado)
Redução automática + backtest → 5b (após o PR 4). Gatilho de evento (sombra no `criar_pedido`) desnecessário: o lote cobre o app. Condições (a) lock no escritor do mapa, (d)/(e) retomada/despacho por revisão, (f) → PR 6 (enforcement); a sombra não reserva nada efetivo.

## Prova (`db/test-credito-sombra.sh`, PG17, `C` e `pt_BR.UTF-8`)
S1 sync defasado/ausente → 🟡 `sync_defasado` (e piso vencido segue 🔴); S2 título do próprio PV não soma 2×; S3 conciliação: cancelado→liberada, faturado+título→transferida, parcial→residual, faturado sem título→ativa; S4 lote: importado e app, revisão nova reavalia, mesma não, erro num pedido não aborta o lote, valor ausente pulado; S5 sombra nunca escreve reserva/solicitação `efetivo`; S6 lote concorrente (try_lock) e lock do grupo solto por pedido (2ª sessão não espera o lote inteiro); S7 regressão das suítes do núcleo. Falsificação (controle verde na mesma invocação): F1 sem checagem de frescor; F2 ausente conta como fresco; F3 título do PV soma; F4 transfere sem título; F5 sem sub-bloco (1 erro aborta o lote); F6 sem COMMIT por pedido (S6 vermelho).

## Revisão pós-Codex (desenho, 2026-11-25, gpt-6.2-astra high — 1 P0 + 6 P1 + 1 P2, todos acatados; substituem o que conflitar acima)

- **P0 — núcleo intocado.** Nada de `CREATE OR REPLACE` em `private.credito_avaliar_reservar` nem `CHECK` novo em `credito_decisao_pedido`: a sombra tem avaliador (`private.credito_sombra_avaliar`, só LÊ) e ledger próprios (`credito_sombra_*`), sem parâmetro de modo. A pós-condição exige corpo + ACL do núcleo e do piso iguais aos de antes. O PR 6 promove esta lógica a efetivo.
- **P1 — residual derivado, nunca gravado.** A reserva guarda o compromisso ORIGINAL; o que ela ocupa = original − Σ títulos vinculados (empresa + cliente + `numero_pedido`, únicos por lançamento, não cancelados), recalculado a cada leitura. Vínculo ambíguo (número repetido na empresa, título sem valor) mantém a cobertura cheia. Transfere só quando os títulos cobrem o compromisso.
- **P1 — `deleted_at` não libera.** Só `status='cancelado'` (vindo do Omie) libera. Conciliação roda ANTES de avaliar, no mesmo lote.
- **P1 — frescor sem `greatest`.** Incremental íntegro ≤ 26 h **e** full ≤ 8 d, cada um por si, por empresa do escopo; marca ausente, duplicada ou futura → 🟡 `sync_defasado`.
- **P1 — sem lock de grupo.** O lote não toma `credito_grupo:<raiz>` (nem a aprovação espera por ele): try-lock de transação com chave própria; o caminho do pedido nunca espera a sombra (provado com sessão concorrente e `statement_timeout 1s`). PROCEDURE com COMMIT por PV descartada: sem lock compartilhado não há o que soltar; orçamento de tempo (45 s) e teto (100 PVs) por lote, o resto fica para o próximo.
- **P1 — distribuição honesta.** Conta PV (última versão), separa `origem`, `status_pedido` na 1ª observação (faturado = coorte retrospectiva), `prazo_dias NULL` (nunca 🟢 — `CHECK`) e guarda `faixa_sem_prazo` como calibração.
- **P1 — carga congelada.** Inventário de todo PV pré-ativação (`credito_sombra_carga`); os abertos são drenados em lotes retomáveis e, até terem reserva, deixam o grupo em 🟡 `exposicao_indeterminada`.
- **P1 — ledger completo.** App: cada revisão (PR 3) com o devedor congelado nela; importado: versão `omie:<n>` por mudança de conteúdo (A→B→A conta). Tentativa (erro/valor ausente/parcial) é tabela separada da decisão; erro tenta 3×; valor é classificado ANTES do filtro.
- **P2 — relógio do importado.** `pedido_data_comercial` guarda a data comercial; `avaliado_em` ≈ 1ª observação. A latência medida é só a do app.
