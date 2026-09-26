# Deslocar o dado não é avançar o relógio — a prova que reprovava de madrugada

**2026-09-26.** O job `provas-sql` (passo *Núcleo de provas SQL executadas*, `bash db/roda-nucleo-ci.sh`)
reprovou em `db/test-data-health-sync-reprocess.sh` com `PASS=28 FAIL=1`, no assert *"message VARIOU
com a idade — o fingerprint source|status|severity|message re-emailaria a cada rodada"*. O `validate`
exige todo job verde, então isso travou o auto-merge de **todo PR** na janela — caiu no #2576 e no
#2573 por volta de 04:00Z. Reproduzido local e numa cópia limpa de `origin/main` (`d65247058`): não
dependia de PR nenhum. Fora da janela a mesma prova passava.

A pergunta que decidia o conserto: o defeito é da **prova** (ela simula mal o passar do tempo) ou do
**sensor** (a data "erro desde DD/MM" muda de verdade para um mesmo problema, e o push re-emailaria)?
Foi a prova — e a medição corrigiu duas partes da hipótese de partida.

## O mecanismo, medido

O assert simulava *"o mesmo problema ficou 3h mais velho"* assim:

```sql
UPDATE sync_reprocess_log SET created_at = created_at - interval '3 hours'
 WHERE reprocess_type='operational' AND entity_type='orders';   -- desloca o DADO
```

e exigia a message idêntica. A message do check `sync_reprocess_saude` é
`Reprocesso Omie PARADO: operational/orders (oben): erro desde DD/MM`, com

```sql
to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM')
-- ultimo_sucesso_em = max(created_at) WHERE status = 'complete'   (sem janela)
```

**Correção 1 — a data é do último SUCESSO, não do início do erro.** A hipótese inicial datava pelo
`error` semeado em `now()-10min` e estimava a janela em 00:10–03:10 BRT. Só que o `UPDATE` pega as
**duas** linhas da chave, e quem alimenta o DD/MM é o `complete` semeado em `now()-30min`.

**Correção 2 — a janela exata.** Varredura com relógio controlado (146 instantes de semeadura, um a
cada 10 min, mais sondas de fronteira): o procedimento antigo reprova para semeadura em
**[00:30:00, 03:29:59] BRT = [03:30Z, 06:30Z)**. `00:29:59` passa, `00:30:00` reprova, `03:29:59`
reprova, `03:30:00` passa. A fronteira é o `complete` em T−30min cruzando a meia-noite local quando é
deslocado 3h.

## O veredito: a PROVA — com evidência nos quatro eixos

1. **Estático.** `ultimo_sucesso_em` é `max(created_at)` do `complete`, **sem janela**. Nenhum
   escritor grava `created_at`: as 6 menções na edge `sync-reprocess` são leitura, e o UPDATE
   `running→complete` só toca `status`/contagens/`error_message`/`metadata`. Em prod não há trigger
   na tabela, o `DEFAULT now()` só vale no INSERT e **nenhum cron** toca a tabela: a linha mais antiga
   é de 28/02 (n=5115), sem purga. ⇒ para um problema que não muda, o instante da data é **imutável**.
2. **Prod.** O `md5(prosrc)` do compute em prod é o do corpo da `20260922225500` (`a136ea53…`), e o
   bloco do check é byte-idêntico ao da `20260920233000` que a prova aplica. Os 3 e-mails reais do
   source (`fornecedor_alerta`): **18/09 23:30** (5 chaves) · **19/09 03:30** (3 chaves, já depois de
   o operational voltar) · **21/09 19:00** (episódio novo, `desde 21/09`). O 1º episódio ficou aberto
   de 18/09 23:30 a 20/09 00:00 e atravessou a meia-noite de 19/09 **sem e-mail perto dela**.
3. **Execução.** Com o dado parado e o relógio 3h adiante, message idêntica em **146/146** instantes,
   inclusive os **72** em que o relógio cruza a meia-noite. O controle positivo mostra que o relógio
   de fato mordeu: idade `1800 → 12600` em 584/584 leituras.
4. **Sessão e locale.** Message idêntica sob TimeZone {UTC, America/Sao_Paulo} × `lc_time` {C,
   pt_BR.UTF-8} × servidor {C, pt_BR.UTF-8} — 292/292 grupos. O `AT TIME ZONE` é explícito e o
   `to_char` numérico não consulta locale.

## A lição

**Deslocar o DADO só equivale a avançar o RELÓGIO para o que é função de `(now() − t)`.** Quando a
saída carrega um instante ABSOLUTO do dado — data congelada, "desde DD/MM", dia/semana/mês de
referência —, deslocar o dado muda esse instante, e a prova passa a medir outra coisa. Isso quebra
dos **dois** lados:

- **Falso vermelho, dependente da hora do CI:** reprova quando o deslocamento cruza uma fronteira de
  calendário. Foi este incidente.
- **Falso verde, permanente:** a prova fica CEGA para o defeito que devia pegar. Uma data tirada do
  RELÓGIO só muda à meia-noite, e deslocar o dado nunca a mexe. **Medido:** com a sabotagem
  `message_com_data_do_relogio` (o defeito de sensor da hipótese (b)), o arquivo ANTIGO ficou
  **verde** (`PASS=29`).

**Regra:** para provar que *"a saída não muda com o passar do tempo"*, o dado fica PARADO e quem anda
é o relógio. O cenário deve **cruzar a fronteira de calendário de propósito**, num instante fixo e
independente da hora em que o CI roda. Evitar a fronteira ("fixe longe da meia-noite") some com o
vermelho falso, mas mantém o verde cego.

## O conserto (`db/test-data-health-sync-reprocess.sh`)

- **Relógio controlado sem tocar no corpo:** `public.now()` lê a GUC `test.agora`, e o compute ganha
  `search_path = public, pg_catalog, pg_temp`. `pg_catalog` explícito DEPOIS de `public` é a única
  forma de um nome de usuário vencer um embutido. Sem ele, o `pg_catalog` é buscado PRIMEIRO, e por
  isso nada mais no banco enxerga a função. No fim da seção, o relógio é desligado e o `search_path`
  do compute é **conferido** contra o da migration.
- **Cenário adversarial fixo:** semeado às 23:00 BRT de 15/09, relido às 02:00 BRT de 16/09.
- **Controle positivo** (`idade 1800 → 12600`). Sem ele, um relógio desligado dá M1=M2 por construção.
  **Medido:** com o `ALTER` removido, o assert de estabilidade ficou verde e só o controle acusou.
- **`pg_sleep(1.1)` real mantido:** o relógio controlado só intercepta `now()`, e
  `clock_timestamp()`/`CURRENT_TIMESTAMP` escapam dele. **Medido:** sem o sleep, a sabotagem
  `message_com_hora_de_parede` foi pega 2 de 7 vezes (sorte de fronteira de segundo); com ele, 6/6.
- **2 sabotagens novas**, cada uma pega por UMA camada: `message_com_data_do_relogio` (relógio
  controlado) e `message_com_hora_de_parede` (sleep real). Falsificação: controle verde (31 asserts)
  e **13/13 vermelhas**, sob `LC_ALL=C` e `pt_BR.UTF-8`. O manifesto passou a `31 falsificar=13`.

## Reproduzir uma janela de relógio sem esperar a madrugada

Sem `libfaketime` (ausente no laptop, e no macOS o `pg_ctl` passa por `/bin/sh`, que o SIP limpa de
`DYLD_*`): numa **cópia** da prova, injete logo após o apply:

- `public.now()` = `COALESCE(test.agora, pg_catalog.now() + test.desvio)`;
- `ALTER DATABASE prove SET search_path = public, pg_catalog` para as sessões;
- `ALTER FUNCTION … SET search_path` com `pg_catalog` depois de `public` em toda função que fixa
  `search_path`;
- `ALTER DATABASE prove SET test.desvio = '<instante simulado − agora>'`.

O relógio segue andando a partir do instante simulado. **Resultado:** o arquivo ANTIGO a 04:00Z
simulada deu `PASS=28 FAIL=1` (`desde 26/09 → desde 25/09`) nos dois locales, e a 15:00Z, `29/0`. O
corrigido deu `31/0` nos quatro. O mesmo vale com o servidor em **UTC** (`TZ=UTC`, como no runner
Ubuntu do CI): original `28/1`, corrigido `31/0` e falsificação 13/13. **Limites:** só `now()` é
interceptado (`CURRENT_TIMESTAMP`, `clock_timestamp()` e afins escapam), e função cujo `search_path`
não tem `public` não vê o relógio simulado.

## A classe no resto do repo (triagem estática, 2026-09-26)

Varredura das 304 `db/test-*.sh` por um subagente. É leitura, **não** execução: das janelas abaixo só a
do piloto foi relida por mim, e nenhuma foi falsificada.

- **O padrão exato** — deslocar o timestamp do dado antes de comparar uma saída — tem **1 ocorrência**
  no repo: esta.
- **Armadilha de ambiente:** nenhum harness fixa `timezone`, e o `initdb` herda o fuso do sistema:
  **UTC no CI**, America/Sao_Paulo no Mac. Uma prova que semeia no fuso da SESSÃO contra uma função
  que calcula em SP explícito passa no laptop e só reprova no CI.
- **No núcleo** (o que o CI roda): nenhuma outra janela de horas. Resta a borda exata
  `CURRENT_DATE - 90` do `test-cfo-caixa-90d-otica.sh`, que só vira se 00:00 UTC cair entre o seed e o
  assert (segundos).
- **Fora do núcleo**, 4 janelas latentes, que viram bloqueio de CI no dia em que forem promovidas:
  - `test-auto-aprovacao-piloto.sh` (B1): corte `23:59` UTC − 45 min, falha de **23:15 a 23:59 UTC
    todo dia**;
  - `test-positivacao-eligible-consumo.sh`: seed no mês da sessão contra `mes_inicio` em SP, falha
    **dia 1, 00:00–02:59 UTC**, só com o servidor em UTC;
  - `test-push-vendedora.sh` (T11): expediente `< 23:59` BRT, falha **02:59 UTC, 1 min/dia**;
  - `test-data-health-estoque-fonte-dado.sh` (N9): esperado calculado com `date` do bash contra
    `now()` do banco — dois relógios, segundos em torno de 11:00 e 21:00 UTC.
