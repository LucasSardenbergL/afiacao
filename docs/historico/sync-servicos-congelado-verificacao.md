# O sync que ficou 37 dias congelado — e a verificação que quase o declarou não-resolvido

**Classe:** duas lições distintas, uma de DADO e uma de MÉTODO.
A de dado: um guard de integridade que trata **duas identidades legítimas** da mesma entidade
comercial como corrupção derruba o run inteiro, todo dia, em silêncio.
A de método — a mais cara e a menos óbvia: **uma previsão falsificável tem pré-condições
temporais**, e testá-la antes que elas ocorram não devolve "refutada", devolve **ausência de
dado** com aparência de refutação.

## O incidente (2026-07-18 → 2026-08-25)

O sync `customers/servicos` (empresa `colacor_sc`, cron `sync-customers-servicos-daily`, jobid
155, `40 5 * * *` UTC) parou em `2026-07-18 05:40:58` e ficou **37 dias** em `status='error'`,
falhando todo dia sem que ninguém notasse. O `sync_state.error_message` guardava a assinatura
inteira:

> `colisão de código na conta colacor_sc: omie_codigo_cliente=3545072150 aponta para de411586… e
> 700657a1… (fonte: proof). Duas identidades para o mesmo código dentro da MESMA conta é
> corrupção — abortando antes de admitir o user errado no ledger.`

**Causa-raiz (PR #1971, merge `883080edb` em 2026-08-25 01:31:34 UTC):** o `fetchCodigoUserMap`
de `supabase/functions/omie-analytics-sync/index.ts` unia duas fontes — `customer_canonical_alias`
e a proof `omie_customer_account_map` — que **por desenho** guardam duas identidades da mesma
entidade: o alias fiscal (clone `@placeholder.local`, sem `profiles`) e o user canônico. O guard
`setOuFalha` lia a divergência como corrupção e abortava. Medido: **1633 desacordos, e em
1633/1633 o user da proof era exatamente o `canonical_user_id` do alias** — falso-positivo de 100%.

O fix removeu a fonte `alias`. É no-op de comportamento: os 1633 códigos já estavam todos na
proof (0 exclusivos), aliases ativos só existem em `alias_conta='servicos'`, e nessa conta o mapa
não tem consumidor (tags são `vendas`-only via `tagRows = account === "vendas" ? … : []`).
Ver também `epico-drop-espelho-omie.md` e o §5 de `docs/agent/database.md` (os clones são
**aliases fiscais legítimos**, não lixo de import).

## O fecho — o que efetivamente provou

| Eixo | Medição | |
| --- | --- | --- |
| `sync_state` | `last_sync_at=2026-08-25 05:41:00.096`, `status=complete`, sem erro | ✅ |
| efeito no dado | proof `colacor_sc`: 5296 linhas, `max(updated_at)=05:40:59.194` | ✅ |
| frescor | view `omie_customer_account_map_fresco` (TTL 7d) voltou a listar `colacor_sc` | ✅ |
| versão no ar | sonda `{"probe":true}` → `versao: v1.1-mapa-codigo-sem-alias` | ✅ |

A proof manteve as **mesmas 5296 linhas**, só que atualizadas — refresh, não crescimento.
É exatamente o previsto por os 1633 códigos de alias já estarem lá.

## Lição 1 — a previsão falsificável tem relógio

A verificação começou **76 segundos depois do merge**. O `sync_state` mostrava o mesmo
congelamento, a proof não tinha mudado, a view seguia sem `colacor_sc`. Todos os sinais diziam
"não resolvido" — e o roteiro de investigação previa, para esse caso, que a causa-raiz estaria
errada e que o passo seguinte era pedir o log da edge.

**Seria um veredito fabricado.** A previsão só se torna testável depois de **duas** pré-condições
que nada tinham a ver com a hipótese:

1. a edge ser deployada (merge ≠ produção — 3 deploys manuais, `docs/agent/deploy.md`);
2. o **cron diário** rodar de novo — o último run devido fora `2026-08-24 05:40`, ~20h ANTES do
   merge, e o próximo só às `2026-08-25 05:40`.

Medir antes disso não mede a correção: mede **o run anterior**. E o log que o roteiro mandaria
pedir seria o log do código ANTIGO — caro, e já disponível de graça em `sync_state.error_message`.

> **Regra:** antes de declarar uma previsão falsificável refutada, liste as pré-condições dela e
> prove que **todas** já ocorreram. Numa entrega que depende de cron, a pré-condição é um
> **horário**, não um estado — calcule a próxima execução devida com o `now()` do BANCO. Enquanto
> faltar uma pré-condição, o estado correto é `AGUARDANDO`, nunca `REFUTADO`.

É a irmã temporal de "ausência de sinal não é aprovação" (§Armadilhas do CLAUDE.md): ausência de
sinal também **não é reprovação**.

## Lição 2 — a assinatura temporal prova a causa-raiz de graça

O que confirmou o fix não foi só o `complete`. Foi a **duração**:

- durante o incidente o run morria em **~3 segundos** (`05:40:02` → erro em `05:40:05.391`),
  porque o `setOuFalha` abortava dentro do `fetchCodigoUserMap`, no começo do fluxo;
- no run corrigido ele atravessou essa janela e rodou **57,5s** até `complete`.

O guard não deixou de reclamar por acaso: ele deixou de ser **alcançado** no ponto em que
abortava. Duração é um sinal que já está gravado (`updated_at` − início) e não custa query nova —
quando a falha é um abort precoce, o tempo até o desfecho **localiza a camada** que quebrou.

## Lição 3 — o `request_id` do próprio disparo mata a ambiguidade de emissor

Tentei fechar o eixo HTTP lendo `net._http_response` na janela do run. **Não deu, e o correto foi
declarar INCONCLUSIVO:** ≥6 crons dispararam no mesmo `05:40:00` (`pedidos-programados-watchdog`,
`call-log-missed-backstop`, `sayerlack-portal-watchdog`, `atp-reconciliar`, `afiacao-os-sync`…) e
a resposta HTTP não carrega `action`/empresa. Havia um `200` temporalmente plausível — plausível
não é provado (é a armadilha do #1953, onde um `request_id` copiado à mão pegou o watchdog e
fabricou um "verificado").

O que resolveu, na sonda de versão: **disparar e usar o `id` que o próprio `net.http_post`
devolve**, depois ler `net._http_response` por esse id exato. Some-se o campo `edge` no eco da
sonda (`{"ok":true,"probe":true,"versao":…,"edge":"omie-analytics-sync"}`), e a resposta passa a
se identificar sozinha.

⚠️ A sonda **não** é pré-auth nesta edge: ela fica logo APÓS `authorizeCronOrStaff` — "sem custo"
ali significa sem custo computacional (não cria client, não chama Omie), não sem autenticação.
Sondar por `curl` sem header devolve `401`. O caminho é o SQL Editor com o `x-cron-secret` vindo
do Vault dentro da própria query.

## Lição 4 — a "observação viva" se auto-refutou: o timeout mede a RESPOSTA, não o TRABALHO

Fechado o incidente, sobrou uma observação: o run levou **57,5s** contra o `timeout_milliseconds := 60000`
do cron 155 — margem de ~2,5s; se estourasse, o `pg_net` marcaria `timed_out` e se perderia o sinal HTTP
(não o sync). Parecia ajuste óbvio de folga. **Era erro de categoria, e medir matou a premissa em vez de
calibrar o número.**

O `case "sync_customers"` responde **`202 {"accepted":true,"background":true}` na hora** e joga o trabalho
em `EdgeRuntime.waitUntil` (`supabase/functions/omie-analytics-sync/index.ts:2480`). O que o
`timeout_milliseconds` cronometra é a **resposta HTTP**, que chega em milissegundos. Os 57,5s são a duração
do background — que o pg_net não observa e não corta. A margem não é de 2,5s: é o teto inteiro.

E está em PROD, não só no repo: a sonda de `2026-08-25 12:35` devolveu
`versao: v1.2-produtos-teto-500-e-partial-honesto`, idêntica ao `VERSAO` de `origin/main`, e esse main
carrega o `accepted: true, background: true`. O `waitUntil` entrou em **2026-05-28 (#438, `ad6675d4c`)** —
no MESMO commit que criou o cron dedicado. O `60000` nunca foi dimensionado para o trabalho; foi escolhido
para um 202.

O irmão confirma de graça. Os **três** `sync_customers` medidos no mesmo dia, todos `timeout:=60000`, todos
`complete` (disparo em `cron.job_run_details` → fim em `sync_state.last_sync_at`):

| jobid | conta | disparo | fim | trabalho |
| --- | --- | --- | --- | --- |
| 104 | vendas | `05:00:00.709` | `05:02:53.300` | **172,6s** (2,9× o teto) |
| 154 | colacor_vendas | `05:20:00.244` | `05:20:56.934` | 56,7s |
| 155 | servicos | `05:40:00.274` | `05:41:00.096` | 59,8s |

3× de variação numa métrica que ninguém está cronometrando — e o `vendas` "estourando" há meses sem
consequência alguma.

**Decisão: não mexer.** Nem no 155, nem no 104/154. Re-agendar com `120000` seria escrita em prod para
consertar problema inexistente, e deixaria no banco a evidência de que alguém acreditou que aquele número
media o sync.

> **Regra** (movida para `docs/agent/sync.md` §Padrão de cron): antes de folgar um `timeout_milliseconds`,
> leia o `case` da action. Se ela retorna `202`/`accepted`, o teto não cobre o trabalho — aumentá-lo não
> compra nada.

### Varredura do parque (o irmão do default-5s)

`51` crons ativos usam `net.http_post` e **`0` estão sem `timeout_milliseconds`** — a armadilha do default
de 5s está fechada em prod. Dos `10` com teto ≤60s: `103`/`104`/`154`/`155` respondem `202` (imunes);
`44`/`60`/`102`/`109` rodaram na janela de retenção de `net._http_response` sem estouro (ver a ⚠️ abaixo:
o filtro certo é `error_msg IS NOT NULL`, **não** `timed_out`); `75` dispara só `sync_categorias` (max 4,1s) e `sync_contas_correntes` (max 28,3s) por
`fin_sync_log`/30d; `59` se dimensiona para ~10s no próprio arquivo (`index.ts:139`). Nenhum aperto real.

O mais estreito do parque é outro, e é **síncrono**: `omie-financeiro`/`sync_movimentacoes` (jobids 78/79,
teto 150000) tem **max 124,1s** e p95 98,3s em 30 dias — 83% do teto. Sem estouro (`fin_sync_log`: 4549
`complete`, 0 sem `completed_at`), mas é ali que uma folga compraria alguma coisa, não no 155.

### ⚠️ A varredura acima quase aprovou por CEGUEIRA (achado do fecho, 2026-08-25)

A primeira passada contou `count(*) FILTER (WHERE timed_out)` e leu **`0` em 206 respostas** como "nenhum
estouro". **`timed_out` não é o campo que se preenche.** A resposta `59887` estava cortada aos 150s —
`error_msg = "Timeout of 150000 ms reached. Total time: 150004.306000 ms"` — com `timed_out` **NULL** e
`status_code` **NULL**. O filtro certo é `error_msg IS NOT NULL OR status_code IS NULL`.

Ou seja: **existe ≥1 estouro real de `150000` na janela de 6h** e a conclusão "nenhum aperto real" vale só
para os crons cujo teto foi provado por OUTRA via (o `202` do 103/104/154/155, o `fin_sync_log` do 75, o
dimensionamento do 59). Qual cron emitiu o `59887` ficou **em aberto**: 20 crons dispararam naquele
`08:30:00` e o `net._http_response` não carrega a URL — é a ambiguidade de emissor de sempre. Fechá-la
exige observar dentro da janela de retenção; virou chip próprio.

Isto é a lição 1 da própria `/fecho` aplicada a si mesma: **ausência de sinal não é aprovação** — e um
campo que nunca se preenche produz ausência de sinal indistinguível de saúde.

## Como revalidar

```bash
~/.config/afiacao/psql-ro -c "select last_sync_at, status, coalesce(error_message,'-') from sync_state where entity_type='customers' and account='servicos';" -c "select account, count(*), max(updated_at) from omie_customer_account_map where account='colacor_sc' group by 1;" -c "select account, count(*) from omie_customer_account_map_fresco group by 1 order by 1;"
```

Saudável = `status='complete'` com `last_sync_at` do dia, proof `colacor_sc` fresca, e as **três**
contas na view `_fresco`. Durante o incidente ela devolvia só `colacor` e `oben`.
