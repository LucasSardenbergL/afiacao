# Provas com janela de relógio fora do núcleo — 3 consertadas, 1 parada no sensor

**2026-09-27.** Continuação de [deslocar-o-dado-nao-e-avancar-o-relogio.md](deslocar-o-dado-nao-e-avancar-o-relogio.md).
A triagem ESTÁTICA daquele diário (feita por subagente, sem execução) apontou 4 provas fora de
`db/nucleo-ci.txt` com janelas latentes, que virariam bloqueio de CI no dia da promoção. Aqui cada
uma foi **reproduzida por execução** num relógio simulado, dos dois lados da janela, antes de
qualquer conserto. As 4 se confirmaram; 3 eram defeito da PROVA e foram consertadas; a 4ª é mista e
**parou no sensor**, que é outro ritual.

| prova | janela reproduzida | causa | desfecho |
|---|---|---|---|
| `db/test-auto-aprovacao-piloto.sh` | **23:15:00–23:59:59 UTC**, todo dia (B1), servidor SP e UTC | corte `'23:59'` usado como "sempre no futuro"; a janela da função é minutos UTC sem wrap (por desenho) ⇒ 23:59 − 45 min = 23:14 | consertada |
| `db/test-push-vendedora.sh` | **02:59:00–02:59:59 UTC** (23:59 BRT), todo dia (T11) | expediente `'00:00'–'23:59'` usado como "o dia todo"; o gate é semiaberto (`< hora_fim`, por desenho) | consertada |
| `db/test-data-health-estoque-fonte-dado.sh` | **~50–70 ms** em torno de 08:00 e de 18:00 BRT (N9) | DOIS relógios: esperado pelo `date` do bash, real pelo `now()` do banco | consertada |
| `db/test-positivacao-eligible-consumo.sh` | **dia 1, 00:00:00–02:59:59 UTC**, só com servidor UTC | seed da prova (C2/C3/C7/F1) **e** defeito do sensor (C4) | **parada** — ver abaixo |

## Reproduzir: o método do diário anterior, e 5 ressalvas medidas

O injetor (cópia da prova com `public.now()` = `COALESCE(test.agora, pg_catalog.now() + test.desvio)`,
`pg_catalog` depois de `public` e `test.desvio` no banco) reproduziu as janelas. No caminho, 5 coisas
que ele NÃO cobria, cada uma pega porque o resultado não bateu com a previsão:

1. **`public` antes de `pg_catalog` troca TODA assinatura idêntica, não só o `now()`.** O snapshot
   tem `public.set_config(text,text,boolean)`, um wrapper que só aceita `fin.%` e levanta exceção no
   resto. Pego pela guarda que o próprio conserto ganhou (abaixo). Um `set_config('test.agora', …)`
   não qualificado cairia nele.
2. **`DEFAULT now()` é resolvido no `CREATE TABLE`** e continua em `pg_catalog.now()`: o dado nasce
   no relógio real e o trigger lê o simulado. No push-vendedora o throttle de 10 min nunca engatava e
   **tudo** caía no T2, não no T11. Reapontar os defaults resolve, mas o `pg_get_expr` imprime
   `pg_catalog.now()` QUALIFICADO quando `public` vem na frente: o 1º filtro (`= 'now()'`) reapontou
   **0 colunas**, que é ausência de dado, não sucesso.
3. **Função recriada depois da injeção** (sabotagem, restore) volta ao `search_path` da migration e
   sai do relógio. Resolvido com um *event trigger* em `ddl_command_end` que reaplica o `pg_catalog`
   depois de `public` a cada `CREATE FUNCTION`.
4. **O injetor muda o `proconfig`, e com ele o md5 do `pg_get_functiondef`.** A guarda de drift da
   migration do estoque abortou mais adiante na prova (exit 3), por artefato. Por isso o conserto
   dessa prova liga o relógio SÓ durante a seção e confere o `search_path` de volta.
5. **Dois relógios pedem os dois simulados, com o MESMO desvio.** Simular só o banco não reproduz o
   N9. O `date` do bash precisou virar `time.time() + desvio`.

**Contraprova mais forte que simular a parede: o tripwire.** Quando a prova corrigida FIXA o relógio,
simular a parede testa pouco e ainda arrasta junto funções que a prova deixou, de propósito, no
relógio da transação (o push-vendedora caiu no T1 por isso, com a cobertura nascendo em
`CURRENT_DATE` real). O tripwire é um `public.now()` que **levanta exceção** se for lido sem
`test.agora`. As 3 provas corrigidas passam com ele armado (28/28, 20/20, 45/45). Tirar o pin
numa cópia deixa as 3 vermelhas com `TRIPWIRE`, e isso é a falsificação do próprio tripwire.

## O conserto — o mesmo desenho nas 3

- **Relógio controlado** (padrão do #2583): `public.now()` lê `test.agora`, e SÓ as funções sob
  teste ganham `pg_catalog` depois de `public`. No push-vendedora, os triggers de throttle ficam de
  fora de propósito: continuam no relógio da transação, o mesmo do `DEFAULT now()`.
- **Guarda de sombra com controle positivo.** Nenhuma função sob teste pode chamar um nome que
  `public` sombreia, e a guarda tem de enxergar o próprio `public.now()` (`now|`). Se ela não vê nem
  esse, está cega e aborta.
- **Um bloco que CRUZA a borda de propósito, em pares de 1 s.** Fixar o cenário longe da fronteira
  tiraria o vermelho falso e manteria o verde cego. Os blocos também separam SP de UTC:
  - auto-aprovação: bloco **J**. O mesmo cenário às 23:14:59Z aprova (J1) e às 23:15:00Z fica humano
    (J2). Controle positivo **J0**: `aprovado_em` = o instante simulado. Às 23:15Z (20:15 BRT), uma
    janela contada em SP aprovaria.
  - push: bloco **E**, com a config de prod (07:30–17:30, seg–sex) numa quarta: **07:30:00 dentro ·
    07:29:59 fora · 17:29:59 dentro · 17:30:00 fora**. Esse padrão é o próprio controle positivo:
    preso na parede, as 4 chamadas (a ms de distância) dariam o mesmo resultado. O bloco roda ANTES
    dos T* porque o T12 apaga o secret do Vault, e depois dele nenhum push sai (um bloco ali passaria
    por cegueira).
  - estoque: **N9a–d**, o mesmo dado de 5h às 07:59:59 · 08:00:00 · 17:59:59 · 18:00:00 BRT ⇒
    `ok · stale · stale · ok`, com esperado FIXO. Controle positivo: `age_seconds = 18000` exato (na
    parede, dias ⇒ `broken`).
- **Transação desfeita** (`BEGIN … ROLLBACK`) nos blocos J e E: nenhum alerta, log ou captura sobra
  para os cenários que contam alertas.
- **Cenários que não são sobre a borda rodam num instante FIXO** (B/C, T11/T11b). O T11b passou a
  calcular o "hoje" com `public.now()`, o relógio do tick. Os fixtures da auto-aprovação trocaram
  `CURRENT_DATE` por `now()::date`, para ficar um relógio só.

Asserts: auto-aprovação 25 → **28**; push 16 → **20**; estoque 38 → **45**.

## Falsificação — o vermelho tem de ser do assert CERTO

Auto-aprovação e push ganharam `--falsificar` (controle verde na MESMA invocação, antes de sabotar).
Cada sabotagem declara **qual** assert tem de acusá-la. Ficar vermelha por outro motivo (sabotagem
que não aplicou, erro de sintaxe) conta como FALHA da falsificação, não como dente. O estoque já
tinha falsificação inline (F1–F5) e ganhou F6–F9. A 1ª versão delas aceitava "leitura diferente da
esperada", e isso inclui rodada que quebrou. Sob o tripwire sem pin, as 4 "passaram". Agora F6/F7
exigem a leitura EXATA que a sabotagem produz (é determinística), e F8/F9, 4 leituras bem formadas.
F8 lê a hora da parede, então o critério dela não pode depender da hora real (seria outra janela).

| prova | sabotagens (→ assert que acusa) | resultado |
|---|---|---|
| auto-aprovação | janela em BRT → J2 · margem 44 min → J2 · borda aberta → J1 · hora de parede → J2 · relógio desligado → J0 | 5/5 |
| push | expediente em UTC → E2 · fim fechado → E4 · início aberto → E1 · sem gate de dia → T11b · hora de parede → E1 · relógio desligado → E1 | 6/6 |
| estoque | F6 janela em UTC · F7 fim fechado · F8 hora de parede · F9 relógio desligado (+ F1–F5 de antes) | 9/9 |

As três rodaram em **`LC_ALL` ∈ {C, pt_BR.UTF-8} × servidor ∈ {SP, UTC}** (`TZ=UTC`, como no runner
do CI), com exit 0 nas 12 combinações. Transparência sobre o eixo do locale: os harnesses fazem
`export LC_ALL=C` logo no topo, então o locale externo quase não chega ao que roda. O eixo que morde
esta classe é o **fuso do servidor**.

## A 4ª prova: parada no sensor (`_carteira_positivacao_for_owner`)

No mesmo instante (01/10 01:30Z, servidor UTC), o experimento separou as duas causas:

- **Prova.** Com o pedido semeado no mês de SP (o contrato da função), C2/C3/C7/F1 passam. O seed
  usava `date_trunc('month', now())` no fuso da SESSÃO.
- **Sensor.** C4 segue vermelho. Com os MESMOS dados e no MESMO instante, `contatados_mtd` = **0 com
  sessão UTC e 1 com sessão SP**. A função fixa o mês em SP (`mes_inicio`/`mes_fim` são `date`), mas
  compara `fc.started_at` (timestamptz) com essas datas, e o cast usa o fuso da SESSÃO. O mesmo vale
  para `so.created_at::date` (pedido sem `order_date_kpi`). Em sessão UTC, o que acontece das 21:00
  às 23:59 BRT do último dia do mês conta no mês SEGUINTE.
- **Prod (psql-ro):** `TimeZone = UTC`, vindo do arquivo de configuração, sem override por papel ou
  banco, e é isso que as sessões do PostgREST herdam. O corpo em prod é o do repo: o md5 difere, mas
  só por um comentário. **Impacto hoje: zero.** `farmer_calls` tem 0 linhas, e dos 31.550 pedidos
  válidos só 4 não têm `order_date_kpi`, nenhum na janela. O defeito é real e **latente**: morde no
  dia em que `farmer_calls` receber dado.

Pela regra do pedido ("defeito do sensor: pare e reporte"), nada foi mexido nem na migration nem
nesta prova. Consertar só o seed deixaria a prova reprovando na mesma janela, agora só pelo C4, que é
vermelho verdadeiro. E o formato final dela depende do conserto do sensor: comparar em SP, por
exemplo `(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date` contra as datas, e ganhar um bloco de
borda de contatos igual ao dos pedidos. Esse trabalho vai para o ritual `lovable-db-operator`
(briefing em chip).

## O que ficou de fora, com dono

- **O laço `--falsificar` do #2583 conta sabotagem NÃO APLICÁVEL como dente.** A prova é
  `db/test-data-health-sync-reprocess.sh`, e está NO núcleo. O `sabotar()` sai com 9 quando o padrão
  derivou, e o laço trata todo exit≠0 como "vermelha como devia". Medido numa cópia com o padrão de
  `message_com_data_do_relogio` derivado: "✅ vermelha como devia (1 assert(s) quebraram)", e o
  "assert" era a própria linha `❌ SABOTAGEM NÃO APLICÁVEL` contada pelo `grep -c '❌'`. Resultado:
  `SABOTAGENS: 1 vermelhas / 0 falhas`, exit 0. O runner do núcleo só lê esse recibo. É o que
  `money-path.md` já proíbe ("o vermelho tem de ser do SEU assert"). Vai para chip.
- **bash 3.2 do macOS: erro de SINTAXE no meio de uma prova com `trap cleanup EXIT` sai 0.** O
  status do último comando do trap vence, e nem `trap 'rc=$?; …; exit $rc'` salva, porque o `$?` ali
  já é 0. No CI (bash 5), o `lint:shell` barra o parse antes. O risco é o rodar LOCAL (e cópias
  geradas, como as desta sessão). Não medi no bash 5. Entrada 22 de
  [evidencia-positiva-shell.md](evidencia-positiva-shell.md).
- **Promoção ao núcleo** continua exigindo o que não era escopo aqui: `db/lib/pg-harness.sh` no lugar
  do boilerplate `/opt/homebrew` (as 3 são só-macOS) e, na auto-aprovação e no push, um recibo de
  contagem (`PASS=`) que o runner saiba ler.

## O gate da classe do N9: `scripts/relogio-bash-em-provas-gate.ts`

No mesmo dia, pelo protocolo `matar-classe`, a classe dos dois relógios ganhou gate textual (vitest).

- **Assinatura:** `date`/`gdate` com formato que tem campo de calendário, `\bg?date\b[^|;#\n]*\+["']?%[^s]`.
  Casa `+%H`, `-u "+%d/%m"`, `'+%u'`, `+"%H"`; não casa `+%s`, que mede duração. Foi calibrada com o
  próprio gate sobre a árvore REAL de `db/` (`git archive`): antes do #2588, exit 1 só na linha 167 da
  prova do estoque; depois, exit 0, inclusive com o comentário novo que cita o `date` (o stripper o
  limpa). A forma `git grep -E` não entende `\b` e dava 0 no pré-fix: seria assinatura teatro.
- **Universo:** todo shell de `db/` (313: as 304 provas, `db/lib/` e os falsificadores), não só
  `test-*.sh`. Um `hora_brt()` no harness seria a mesma leitura. O teste confere contra o `git ls-files`.
- **Varredura do repo inteiro** (subagente, read-only): a assinatura casa 11 linhas. Fora o N9, são 10,
  todas fora de `db/` e todas falso-positivo (carimbo de log em hook, exibição em skill, `date -r
  "$epoch"` formatando um instante DADO). As formas irmãs (`gdate`, `date -I`/`-R`, `$(date)` cru,
  `printf '%(…)T'`, python/perl/node, `$EPOCHSECONDS`) têm 0 ocorrência em `db/`. O `clock_timestamp()`
  das provas (67 linhas em 20) é seed relativo, duração ou prova DELIBERADA de ordem entre os relógios:
  nenhum afetado.
- **Dente:** stripper compartilhado, walker e os quatro alarmes herdados do irmão
  `shell-variavel-colada-gate.ts`, pisos de 250 provas e 60.000 linhas de código (medido: 304 e
  76.725). A falsificação roda no arquivo REAL: devolve o N9 ao fim da prova do estoque e exige
  exatamente aquele sítio, com o corpo intocado verde na mesma invocação. O `mutcheck` pega 18/18
  (`scripts/mutcheck.d/relogio-bash-em-provas.mut`). Suíte verde em `LC_ALL=C` e `pt_BR.UTF-8`.

### A 2ª assinatura (seed no fuso da sessão): calibrada, gate adiado

`date_trunc\(\s*'(day|week|month|year)'\s*,\s*now\(\)\s*\)` em `db/test-*.sh` casa só a positivação
(l.145-146, sem `AT TIME ZONE`). Não casa a forma com `AT TIME ZONE`, nem a de 3 argumentos do PG14+,
nem `'hour'` (SP tem offset de hora cheia: truncar a hora dá o mesmo instante nos dois fusos). A
positivação espera o conserto do sensor (chip "Corrigir fuso da sessão no sensor de positivação").
Gatear antes deixaria a main vermelha, e o lado pós-fix da calibração ainda não existe. O gate tem dono
em chip próprio ("Gatear seed no fuso da sessão em provas SQL").

Alargar para `current_date`/`now()::date` nus não serve: são 363 ocorrências em ~52 provas, quase todas
com seed e esperado no MESMO fuso (coerentes), e 12 provas fixam o fuso de propósito. Se um dia faltar
alcance, a forma cirúrgica medida é por ARQUIVO: `date_trunc(…, now())` nu **e** `AT TIME ZONE
'America/…'` no mesmo arquivo, **sem** `SET TIME ZONE`/`ALTER DATABASE … TimeZone`. Hoje ela casa só
a positivação.
