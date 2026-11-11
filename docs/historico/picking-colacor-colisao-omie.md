# Picking da Colacor × concorrência no `ListarPedidos` do Omie (C19, plano v9)

> 2026-11-11. Item C19 do [plano v9](../superpowers/plans/2026-11-11-plano-melhoria-v9/README.md) ("C20" no parecer do Codex). Edge `picking-fila-omie` v0.6 → **v0.7-retry-concorrente**.

## Sintoma

`acoes_execucoes`, `picking_fila.sincronizar_colacor`, 7 d: 21 erros em 660. A fila anterior fica no banco (o erro aborta antes de `picking_sincronizar_fila`), então o dano é a fila **desatualizada** até a próxima rodada boa (6 min dentro do horário; no fim do expediente, o dia seguinte).

## Diagnóstico (só leitura, `psql-ro` com `ON_ERROR_STOP` e marcador final)

1. **O plano estava parcialmente errado:** os 21 erros **não** são todos "página 3: Já existe uma requisição". São **13 de concorrência** (páginas 1, 2 **e** 3) e 8 de outras causas: o episódio de 06/11 11:07–11:43 foi `Signal timed out` e `SOAP-ERROR` (Omie fora, a Oben caiu junto), mais 1 `Broken response` em 07/11.
2. **A concorrência tem horário fixo.** Das 13, 12 são da rodada das **:01 de 11, 15, 17 e 19 h UTC** (08, 12, 14 e 16 h BRT): 4 erros em 7 dias em cada uma dessas horas (57%). As rodadas das :01 de 12, 13, 14, 16, 18, 20 e 21 h UTC: **0 erros em 49**. A 13ª é isolada (10/11 11:49).
3. **Não é a Oben:** a mesma rodada da Oben (mesmo cron, mesmo minuto) não erra nessas horas. É algo só na app_key da Colacor.
4. **Não é nenhum chamador nosso:**
   - `pendencias:deploy`: as 5 edges que usam a trava (`omie-vendas-sync` v1.35, `sync-reprocess` v1.20, `omie-desconto-backfill` v1.6, `omie-financeiro` v1.11 e `picking-fila-omie` v0.6) estão servindo a versão da main, todas com `comVezOmie`.
   - `ListarPedidos` literal só existe nessas edges (`git grep` em `supabase/functions`). Nenhuma edge monta o método por variável vinda de fora.
   - `cron.job`: nenhum job tem horário `0 11,15,17,19`. Os que disparam às :00 dessas horas (`omie-sync` de hora em hora, `omie-analytics-sync` a cada 30 min, watchdogs) disparam igual nas horas sem erro, e nenhum chama `ListarPedidos`.
   - `colacor_sc` no `omie-vendas-sync` vai sem trava, mas é outra app_key e só chama `ListarClientes`.
   - Se fosse uma edge nossa sob a trava, o picking veria `OMIE_COTA … ocupado` (a vez negada com lease de 150 s estoura o teto de espera), não o fault do Omie.
5. **O concorrente é externo ao app** (outra integração na app_key da Colacor, fora deste repositório), periódico às 08/12/14/16 h BRT em ponto, e **intermitente**: na mesma rodada as páginas 1 e 2 passam e a 3 cai (05/11 19:01, 09/11 15:01 e 19:01, 11/11 11:01 e 17:01), ou seja, ele faz chamadas em rajada, com intervalos.

## Conserto escolhido: retry curto da página recusada

Deslocar o minuto não serve: o concorrente não é nosso, e não sabemos quanto dura a rajada dele (mover o picking para :04 é aposta sem dado). O retry vale para este e para qualquer outro chamador de fora.

- `comRetryConcorrente` (`picking-fila-omie/coleta.ts`, função pura): repete **só a página** cuja recusa o `classificarFaultCota` classifica como `concorrente`, após 5, 10 e 20 s.
- Cada tentativa passa de novo pela trava (`paginaDePedidos` → `chamarOmie` → `comVezOmie`) e pelo prazo de início de página (80 s desde o início da invocação). Se a espera não couber no prazo, o erro volta na hora, sem dormir. O prazo de aplicar (115 s) e o lease da reserva (150 s) seguem valendo como antes: a última página começa até os 80 s, e o fetch tem 25 s.
- REDUNDANT, bloqueio por consumo indevido e erro de dado **não** são repetidos (chamar cedo depois de um "aguarde" é o que escala para o bloqueio). Mesmo desenho do `omie-vendas-sync`, que já repete o "Já existe uma requisição" com 5/10/15 s.
- Ao desistir, o erro sai com "(após N retentativas)", e o resumo de sucesso traz `retentativas_concorrente`.
- Teste: `coleta_test.ts` (5 casos, com o texto de produção e o classificador real). Falsificado contra a versão commitada: o controle ficou verde; repetir qualquer erro deu vermelho; ignorar o prazo deu vermelho.

## Deploy e como medir

- **Deploy de edge** `picking-fila-omie` (v0.7-retry-concorrente), feito pelo founder no Lovable depois do merge. Sem migration, sem mudança de cron. Quem atesta a versão servida é a sonda por cron (a edge está na allowlist) e o `pendencias:deploy`.
- **Quando medir:** depois de 1 semana com a v0.7 servida, rodar:

```sql
select status,
       count(*) filter (where detalhes::text like '%Já existe%') as concorrencia,
       count(*) filter (where (detalhes->>'retentativas_concorrente')::int > 0) as salvas_pelo_retry,
       count(*)
from acoes_execucoes
where acao = 'picking_fila.sincronizar_colacor' and iniciado_em > now() - interval '7 days'
group by 1;
```

Pronto quando `concorrencia` ficar perto de 0 e `salvas_pelo_retry` mostrar as rodadas das 11/15/17/19 h UTC. Se as retentativas esgotarem (erro "após 3 retentativas"), a rajada externa é mais longa que 35 s. Aí cabe descobrir a integração na conta Omie da Colacor (painel de aplicativos do Omie, com o founder), ou tirar o picking das :01.
