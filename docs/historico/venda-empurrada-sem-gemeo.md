# Sensor da venda empurrada ao Omie que nunca voltou

**2026-09-30.** Fecha o chip 2 de [positivacao-universo-canonico.md](positivacao-universo-canonico.md).
Migration `20261001011500_data_health_vendas_empurradas_sem_gemeo.sql`, prova
`db/test-data-health-vendas-empurradas.sh` (núcleo do CI). `Máquina meta: 4c19af2a (exposição criada
pela D2 do #2630)`.

## O problema

A linha que o app cria e empurra ao Omie (`criar_pedido` faz UPDATE na própria linha: `omie_payload`,
`omie_pedido_id`, `status='enviado'`) não tem `order_date_kpi` desde 25/05. Quem conta a venda é o
**gêmeo** que o importador (`omie-vendas-sync`, `sync_pedidos`) traz como OUTRA linha, com o mesmo
`(account, omie_pedido_id)` e `omie_payload` nulo. Desde a 20260927195430 o ao vivo e o congelado contam
só o kpi. O importador pode **pular** um pedido (cliente não resolvido, desconto ilegível, falha
individual na RPC `criar_pedidos_com_itens`), e os três casos só viram **contador** em
`fin_sync_log.results`, sem o id. O pedido pulado fica fora da positivação e ninguém fica sabendo.

## A medição (psql-ro, 2026-09-30)

- **26 linhas do app** com payload e id: 23 em abril, 2 em junho, 1 em agosto, 0 em setembro. Todas
  `enviado`, nenhuma apagada. **Nenhuma** linha com payload e sem id.
- **Gêmeos:** 31.646 linhas com id e payload nulo, todas com o hash canônico. **25/26** têm gêmeo.
- **O órfão `4c19af2a`:** oben, R$ 314,40, nº 10536, 06/04. O Omie respondeu "Pedido cadastrado com
  sucesso!". O cliente tem mapa de conta oben e 3 pedidos importados em fevereiro, e os 3.197 logs de
  `sync_pedidos` (desde 27/05) nunca citam o id. O backfill de abril trouxe os outros 8 pedidos
  empurrados no mesmo dia, o que aponta para pedido excluído ou cancelado direto no Omie. Conta 1×
  hoje só porque tem kpi do backfill.
- ⚠️ **O `created_at` do gêmeo é a data do pedido no Omie, não a chegada.** Ele sai ANTES da linha do
  app, com intervalos negativos de até −13 h. Medir latência por ele é medir nada.
- **Latência real do gêmeo** (pares recentes): ~3 min e ~2h23, um ciclo do cron.
- **Janela do importador:** `[hoje_SP−5, hoje_SP]` com `filtrar_apenas_inclusao:'N'`, 10 páginas
  (500 pedidos). O máximo medido foi 110 pedidos em 6 dias (oben). O `f82f3ffd` (previsão 08/08,
  gêmeo já presente às 21:06 SP de 07/08) contradiz o filtro "só por previsão" que o `sync.md`
  registra do backfill. O incremental pega a INCLUSÃO.
- **PostHog:** 73 pageviews em 30 dias no app inteiro, 1 pessoa (controle rodado na mesma query). Um
  sensor que depende de alguém abrir uma tela não teria denominador. Foi um dos motivos do e-mail.

## As decisões (founder, 2026-09-30)

1. **Mora no Sentinela, com e-mail.** É o check `vendas_empurradas_sem_gemeo`: 31º source do compute,
   23º do `v_sources` e 24º do resumo diário. A migration recria o trio acoplado inteiro a partir dos
   corpos de PROD, conferidos byte a byte (md5 do `prosrc` = repo).
2. **O órfão conhecido se resolve ANTES do apply.** O founder confere o nº 10536 no Omie. Se existe,
   semeia-se a janela de abril para o gêmeo voltar (abril passa a contá-lo 2×, como os outros 22 pares,
   até a deduplicação). Se foi cancelado ou excluído, a linha do app vira `cancelado`. O sensor nasce
   verde.
3. **6 h e dois níveis.** `stale` após 6 h, ou 3 ciclos do cron. `broken` após 6 dias, quando a órfã
   sai da janela incremental e só um reprocesso humano (ou uma alteração do pedido no Omie) a traz.
   A severity fica fixa em `warning`. A subida stale→broken escala a gravidade e fura o ack.
4. **O fecho de ACL vai junto.** Achado de passagem: `data_health_watchdog()` e `fin_sync_heartbeat()`
   tinham `EXECUTE` para `authenticated` em prod (ACL medido em 30/09). Nenhum código do app as chama
   (só `types.ts` e comentários), mas qualquer sessão logada, inclusive de cliente, conseguia
   dispará-las via `/rpc`, e cada chamada do heartbeat grava um e-mail para o founder. Como esta
   migration já recria as duas, ela faz o `REVOKE` (de PUBLIC, anon e authenticated) e a POS confere.

## O desenho

- **Universo:** linha do app = payload + id, status canônico de venda, não apagada. **Gêmeo** = mesma
  `(account, omie_pedido_id)` com payload nulo, em QUALQUER status, apagado ou não. A pergunta é "o
  importador conhece o pedido?", e um gêmeo cancelado já diz que a venda não vale.
- **Âncora da idade = o menor LIMITE SUPERIOR do envio.** O envio não grava carimbo. O `created_at`
  é limite INFERIOR e mentiria no orçamento convertido (o `SalesQuotes` reusa a linha). Os dois limites
  superiores são o `updated_at`, renovado pelo gatilho no UPDATE do próprio envio, e o fim do dia UTC
  da `data_previsao` do payload (a edge grava a data UTC do envio). `LEAST` dos dois nunca acusa antes
  de 6 h do envio real. O preço é que uma órfã EDITADA reancora. A previsão só vale se for data válida
  e coerente com a criação (`>= created_at`). O parse é por CASE aninhado e nunca lança: um erro ali
  derrubaria os 31 checks, porque o watchdog engole o erro do compute.
- **Message estável:** só fatos das órfãs, por conta em ordem fixa (`COLLATE "C"`). O valor usa `,` e
  `.` do `to_char`, que não dependem de `lc_numeric`. A data congelada é a da órfã mais antiga, em SP.
  A idade vai em `age_seconds`, os IDs em `last_error`, e o denominador só aparece na message `ok`
  (sem fingerprint).
- **Migration:** PRE com trava (`ALTER FUNCTION … SET search_path` com o mesmo valor, antes de ler) e
  identidade por md5 EXATO, aceitando o predecessor ou ESTA versão. A POS executa o compute e ordena
  os predicados que dizem O QUE está errado antes do md5.

- **O dia de SP escrito no corpo copiado.** O CI reprovou a 1ª versão no gate `relogio-nu-da-sessao`: o
  compute recriado carregava os 2 `current_date` do ramo `reposicao_sugestoes`, e migration posterior ao corte
  do gate (`20260927195430`) não herda baseline. A 1ª troca foi para o UTC escrito, apoiada no motivo da baseline
  ("o `data_ciclo` é gravado em UTC"). Uma sessão-irmã mediu, e eu conferi, que é o contrário: **645 de 646**
  execuções do motor gravaram o dia de SP, inclusive **19 de 20** depois das 21h BRT (`reposicao_motor_run`).
  Com o dia UTC, das 21h à meia-noite BRT a idade da sugestão saía +1 dia e o `stale` de 3 dias disparava 1 dia
  antes. Ficou `(now() AT TIME ZONE 'America/Sao_Paulo')::date`. As entradas quitadas saíram das baselines dos
  dois gates de fuso. A função `_data_health_compute` é desta entrega na coordenação com a sessão da família
  `data_ciclo` (migration `20261001023000`, que a deixou de fora para as duas não recriarem a mesma função).

## A prova

- **44 asserts, todos pela saída do compute REAL** (e o A44 sob `SET ROLE authenticated`). Os seeds cobrem par completo, órfão recente (não
  alerta), órfão velho (alerta), mais de 6 dias, os 4 status excluídos e os 4 admitidos, apagado, gêmeo
  em outra conta, gêmeo cancelado ou apagado, orçamento convertido, linha tocada depois do envio,
  previsão incoerente, inválida (`31/02`, `abc`), payload que não é objeto e payload sem cabeçalho.
  Há ainda as bordas em pares de 1 s (6 h e 6 dias) e a message lida às 23:00 e às 02:00 BRT. O fuso
  da sessão (UTC × SP) e o `lc_numeric` pt_BR não mudam a message. Do trio: o watchdog avalia 23, o
  push recebe o source, o resumo traz `vendas_empurradas_sem_gemeo: broken`, re-aplicar é inócuo e a
  PRE recusa um corpo estranho sem revertê-lo. O fecho de ACL é provado por efeito: `42501` exato nas duas
  chamadas como `authenticated`.
- **Leitura que erra vira VALOR** (`ERRO:<sqlstate>`), não linha `ERROR`. É assim que "o compute não
  pode errar" se falsifica sem violar a regra do laço de que vermelho por erro não é dente.
- **`--falsificar`:** controle verde + **18/18** sabotagens vermelhas no assert declarado, com o servidor
  em SP **e** em `TZ=UTC`. Sob UTC, a sabotagem de fuso só cai no A28, o que mostra que ele não é
  redundante: num runner UTC, o A5 sozinho deixaria a regressão passar.

## O Codex

- **Desenho:** exit 79 (`SALDO_ALTO`, 86% da cota semanal, janela reabre em 03/10 19:11). Foi pelo
  Caminho B, com a seção `RÉGUA:` escrita e conferida por mim (no prompt preservado do consult).
- **Adversarial de código:** o founder mergeou o #2698 sem ele em 2026-10-01 07:21Z (Caminho B, `sem-codex`
  no corpo do PR). Ele roda RETROATIVO sobre o código mergeado quando a janela reabrir (03/10 19:11), e
  achado vira PR novo.

## O desfecho (2026-10-01)

### O órfão 4c19af2a

O founder ia conferir o nº 10536 no Omie, mas o banco respondeu antes. A resposta veio de cruzar
`venda_items_history` (itens das NF-e) com `fin_contas_receber` (títulos, com `id_origem` e a NF citada):

- O 10536 foi para o cadastro Omie 12008261284, um CNPJ em `omie_clientes_nao_vinculados`. Se o pedido
  ainda existe no Omie, o importador o pula (`skippedNoClient`), e semear abril não traria o gêmeo.
- No mesmo dia entrou o nº **10538** (omie 12070361032), com os mesmos 2 itens, quantidades e preços, para
  outro cadastro (um CPF vinculado a outro cliente do app). Ele foi faturado na NF-e 8291, de R$ 314,40. O
  importador o trouxe (`142e5f72`, faturado, kpi 06/04).
- Um título manual (origem `MANR`) de R$ 314,40, que cita a NF 8291, está RECEBIDO no CNPJ do 10536.

O 10536 não virou venda; a venda é o 10538, e ela contava 2× em abril. É o ramo "cancelado/excluído" da
regra. Com a confirmação do founder, [`db/aplicar-cancelar-orfa-4c19af2a.sql`](../../db/aplicar-cancelar-orfa-4c19af2a.sql)
passou a linha para `cancelado` pelo `db:aplicar`: ensaio e depois o real, recibo #214, sha256 `243a5855…`,
às 08:02:25Z. A PRE ancora no estado medido (linha `enviado`, gêmeo ausente, 10538 faturado com os mesmos
itens). A POS confere pelo predicado do próprio sensor. Validação por fora (psql-ro):

- a linha está `cancelado` e o resto dela ficou intacto;
- o 10538 continua faturado;
- há 0 órfãs no universo do sensor;
- o cliente da linha tem 0 vendas canônicas em abril no ao vivo.

Fica no Omie, como higiene do founder: conferir que o 10536 não ficou aberto, para ninguém faturá-lo de novo.

### O congelado de abril

O `carteira_positivacao_snapshot` de abril, gravado em 25/05, marca o cliente da linha como positivado por
R$ 314,40 só por ela, e a mesma venda conta também no cliente do 10538. **Decisão do founder (2026-10-01):
mês fechado não se reescreve.** Abril congelado fica com R$ 314,40 contados 2× e um positivado a mais.
Reescrevê-lo mexeria também nos dias desde a última compra e no risco de churn dos meses seguintes.

### O apply

O founder aplicou a migration pelo **SQL Editor**, fora do `db:aplicar`, entre 07:23Z (pré-voo ainda com os
predecessores no ar) e 08:00Z. Por isso não há recibo em `db_aplicacoes` nem linha em
`supabase_migrations.schema_migrations`. Validação por fora (psql-ro, 08:04Z):

- md5 dos três corpos = repo (`79362363…`, `633a9b71…`, `6be719aa…`);
- `search_path=public, pg_temp`;
- ACL das três só com `postgres`, `service_role` e `sandbox_exec_<ref>`, sem PUBLIC, anon ou authenticated;
- watchdog com 23 avaliados e 0 falhos às 08:00Z.

**O sensor nasceu vermelho, não verde.** O apply veio antes do reparo, e a 1ª rodada (08:00:00Z) pegou a
órfã: alerta `broken` ("1 venda empurrada ao Omie sem gemeo do importador ha mais de 6 h (1 fora da janela
de 5 dias do importador) - oben: 1 (R$ 314,40, a mais antiga de 06/04/2026)"), com e-mail enfileirado às
08:00:02Z. O reparo entrou às 08:02Z, e a rodada das 08:30Z fechou o episódio sozinha: alerta resolvido às 08:30:00Z,
23 avaliados e 0 falhos, nenhum alerta novo. É o 1º sinal positivo do
sensor em prod: na 1ª rodada, achou a órfã real que já conhecíamos.

## Sinal (fase-sem-sinal)

O sensor não cria tela nova: aparece em `/gestao/saude-dados` e no e-mail. Medir o uso é query. Os
episódios do tipo, com abertura, resolução, reconhecimento e e-mails:

```sql
SELECT criado_em, resolvido_em, acknowledged_at, dismissed_at, email_enfileirado_em, mensagem
FROM fin_alertas WHERE tipo = 'data_health_vendas_empurradas_sem_gemeo' ORDER BY criado_em DESC;
```

Episódio resolvido por `ok` = a órfã foi tratada (gêmeo chegou ou linha cancelada). Reconhecido e
aberto há semanas = o alerta virou ruído.

## Lições

1. **Sem carimbo do evento, a idade vem do menor LIMITE SUPERIOR, nunca de um limite inferior.** O
   `created_at` parece a âncora óbvia e fabricaria alerta no orçamento convertido. O `updated_at` sozinho
   rejuvenesce a cada toque. O menor dos limites superiores é o que não acusa cedo e não rejuvenesce
   à toa.
2. **O `created_at` de uma linha importada pode ser a data da ORIGEM, não a da chegada.** Antes de medir
   latência por ele, confira o sinal do intervalo: aqui ele dava negativo.
3. **`psql -c` não interpola `:'var'`.** Só script via stdin ou `-f` interpola. O seed avulso com
   variável morre com `syntax error at or near ":"`.
4. **Um ack em alerta de órfã cala a PRÓXIMA órfã do mesmo nível.** O `how_to_fix` diz para resolver a
   linha, não reconhecer. O único jeito legítimo de aceitar uma órfã é mudar o estado dela.
5. **Recriar uma função grande depois do corte de um gate textual traz os sítios ANTIGOS para o seu
   arquivo.** A baseline valia para a definição antiga; a nova é "migration nova" e reprova inteira. Antes
   de copiar um corpo para uma migration nova, rode os gates de fuso pela CLI
   (`bun scripts/relogio-nu-da-sessao-gate.ts`) e escreva o fuso nos sítios herdados.
6. **O motivo escrito numa baseline é hipótese até alguém medir o ESCRITOR.** "UTC contra UTC" estava
   documentado nas duas baselines de fuso e era falso em 645 de 646 linhas. Antes de herdar o veredito de uma
   baseline num conserto, meça quem grava o dado.
7. **Antes de pedir a alguém para abrir o Omie, cruze o que o banco já copia dele.** `venda_items_history`
   (itens das NF-e) e `fin_contas_receber` (títulos, com a origem e a NF citada) mostraram o que houve com o
   10536 sem ninguém abrir o Omie. A órfã tem um 3º destino além de "existe" e "cancelada": **substituída**,
   quando a venda é refeita como outro pedido, às vezes em outro cadastro. Aí semear não traz o gêmeo, e o
   remédio é o mesmo da cancelada.
8. **Com dois caminhos de apply, a ordem "resolve antes do apply" tem de estar onde se aplica.** O SQL Editor
   do founder e o `db:aplicar` da sessão aplicam a mesma migration. O pré-voo das 07:23Z envelheceu em 40 min:
   o founder aplicou pelo SQL Editor antes do reparo, e o sensor nasceu vermelho e com e-mail. Combine QUEM
   aplica e re-meça o md5 vivo imediatamente antes de aplicar. Quando a ordem importa, a PRE da migration pode
   exigir a pré-condição (aqui, "0 órfãs") e recusar o apply cedo demais em qualquer caminho.
