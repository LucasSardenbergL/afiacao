# A venda empurrada entra no universo canônico no ENVIO (kpi da linha do app)

> 2026-10-06 · money-path · PR [#2825](https://github.com/LucasSardenbergL/afiacao/pull/2825) · spec [2026-10-05-app-grava-kpi-no-envio-design.md](../superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md)
> · plano [2026-10-05-app-grava-kpi-no-envio.md](../superpowers/plans/2026-10-05-app-grava-kpi-no-envio.md)
> · antecedente [gemeos-push-pull-contagem-unica.md](gemeos-push-pull-contagem-unica.md)

## O que mudou

- **`20261005220000_sales_orders_kpi_no_envio.sql`** — `sales_orders_gemeo_app_derivar()` deriva
  `order_date_kpi` = dia de SP de `sales_orders_instante_envio()` (= `statement_timestamp()`) quando a
  linha do app PASSA a ter `omie_pedido_id` (write-back) ou nasce com ele, sem gêmea, sem kpi explícito e
  sem outra linha do pedido com kpi. Nenhum escritor TS/edge grava kpi; a regra "kpi só no INSERT ou no
  MESMO UPDATE do write-back" vale por construção.
- **`20261005220100_data_health_venda_empurrada_conta_pelo_app.sql`** — o `probable_cause` de
  `vendas_empurradas_sem_gemeo` (e o comentário do bloco) dizem que a venda conta pela linha do app;
  corpo = v2 + 2 trocas (a detecção não muda).
- **`SalesQuotes.convertToOrder`** — não regrava `'rascunho'` depois do envio (o `'enviado'` da edge basta).
- **Ranking: fora desta entrega.** A spec previa "linha do app → Sem vendedor atribuído" (D1), mas em
  2026-10-06 o founder decidiu, na entrega `claude/atribuicao-vendas-importadas`, que o ranking atribui
  pelo dono da carteira do cliente — o que dá à linha do app e à gêmea importada o mesmo dono. Os arquivos
  do ranking ficaram com aquela entrega.

## Por que assim

- **O trigger deriva (D2, founder):** tira os escritores TS do caminho. Só no ENVIO, porque o UPDATE do
  trigger da importada que zera o kpi do app re-derivaria e o índice único barraria a importada (23505).
- **Duas travas no caminho do import:** além da condição de envio, a guarda "outra linha do pedido com
  kpi" casa a versão velha da PRÓPRIA linha (que ainda tem o kpi) no UPDATE que a zera. Cada uma sozinha
  segura o import; a prova as derruba juntas (sabotagem `sem_envio_nem_autoguarda`) para mostrar o 23505.
  O plano achava essa cláusula inalcançável — a falsificação mostrou que não.
- **A POS confere o dono do trigger (revisão final):** o trigger SECURITY DEFINER roda como o dono dele e
  chama a costura, que perde o EXECUTE público. Na prod o `postgres` não é superusuário: se a costura
  nascesse de outro dono, o write-back cairia em 42501 depois de o Omie aceitar o pedido. A POS recusa esse
  estado, e o A18 roda com as funções num dono sem superusuário.
- **`statement_timestamp()`:** a chegada do UPDATE do write-back; `now()` seria o início da transação,
  `clock_timestamp()` incluiria a espera de lock. A prod roda com `TimeZone=UTC`: `::date` puro erraria
  3 h por dia.

## Provas

- `db/test-sales-orders-kpi-no-envio.sh` — 27 asserts, 13 sabotagens, verde e falsificada em `C` e `pt_BR`.
- `db/test-data-health-venda-empurrada-conta-pelo-app.sh` — 9 asserts, 4 sabotagens, idem.
- vitest: `SalesQuotes.accountGuard.test.tsx` (sucesso sem update; vermelho antes da correção).

## Limites conhecidos

- **Órfã conta pelo app** (venda que nunca volta: cancelada/excluída direto no Omie, cliente não resolvido)
  até alguém marcar a linha do app — a defesa é o sensor (stale em 6 h, broken em 6 dias).
- **Valor da janela:** até a importada chegar conta o `total` do app (5/22 pares divergiam, até R$ 640,90).
- **Meia-noite:** envio que cruza a meia-noite de SP entre o `IncluirPedido` e o write-back dá ao app o
  dia seguinte ao dInc; o import corrige.
- **DELETE de importada** deixa a linha do app sem kpi até o reimport (nenhum caminho de prod apaga).
- **Empurrada antes do apply** não ganha kpi (havia 0); **linha com hash próprio** (não `omie_`) não é
  observada pelo trigger (havia 0).
- **Bundle velho:** o `SalesQuotes` antigo segue regravando `'rascunho'` (a venda volta pela importada) —
  por isso o Publish vem antes do apply. Até a entrega do dono da carteira sair, o card do ranking atribui
  a linha do app pelo `created_by` na janela até a importada chegar (push ~0/mês desde 08/08).

## Deploy

Ordem: Publish do front (founder) → o cliente do founder atualizado → apply A (`--ensaio`, real) →
validação por fora (`psql-ro`) → apply B → validação. Status: **pendente** — o PR fica DRAFT até o Codex
adversarial no diff (cota reabre 09/10 19:30) e a revisão final.

## Quando medir (o 1º envio real depois do apply)

    ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -tA -c "SELECT id, created_at, order_date_kpi,
      (updated_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia_sp_do_envio, gemeo_importado_id IS NOT NULL AS tem_gemeo
      FROM public.sales_orders WHERE hash_payload IS NULL AND omie_pedido_id IS NOT NULL
       AND updated_at > '<instante do apply A>' ORDER BY updated_at DESC LIMIT 5;" -c "SELECT 'FIM-OK';"

Esperado: `order_date_kpi` = `dia_sp_do_envio` enquanto `tem_gemeo` = f; kpi nulo depois que a importada
chega (`tem_gemeo` = t).
