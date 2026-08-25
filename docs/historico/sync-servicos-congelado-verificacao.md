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

## Observação viva

O run levou **57,5s** contra o `timeout_milliseconds := 60000` do cron 155 — margem de ~2,5s. Se
estourar, o `pg_net` marca `timed_out` e você perde o **sinal HTTP**, não o sync (a edge segue
rodando e é ela quem escreve o `sync_state`). Degradação de observabilidade, não de dado — mas é
o tipo de coisa que vira incidente confuso meses depois.

## Como revalidar

```bash
~/.config/afiacao/psql-ro -c "select last_sync_at, status, coalesce(error_message,'-') from sync_state where entity_type='customers' and account='servicos';" -c "select account, count(*), max(updated_at) from omie_customer_account_map where account='colacor_sc' group by 1;" -c "select account, count(*) from omie_customer_account_map_fresco group by 1 order by 1;"
```

Saudável = `status='complete'` com `last_sync_at` do dia, proof `colacor_sc` fresca, e as **três**
contas na view `_fresco`. Durante o incidente ela devolvia só `colacor` e `oben`.
