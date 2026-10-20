-- R59: liga `habilitado` da passada de encerrados do Omie para a OBEN (reposicao_encerrados_omie_publicacao)
--
-- POR QUE AGORA: o `habilitado` ficou desligado enquanto a semântica do filtro só-encerrados estava em aberto
-- (docs/historico/ospc-passada-encerrados-earlydrop.md). O R59 v2 (#3176) fechou essa decisão: o filtro devolve
-- o ciclo CONCLUÍDO (520 de 549), e por isso o backtest só tira do caixa o que está nomeado em
-- scripts/orcamento-compra/r59-exclusoes-aprovadas.ts (3 pedidos conferidos no portal pelo founder em 2026-10-19).
-- O resto fica no caixa e aparece em `pendentesR59`. Desligado, o backtest recusa rodar (fail-closed:
-- "passada de encerrados do Omie não publicada"). Ligar é o que destrava o R59 v2. Pedido do founder em 2026-10-20.
--
-- RAIO (medido 2026-10-20 por psql-ro): `purchase_orders_tracking.encerrado_omie_em` tem 1 escritor
-- (reposicao_registrar_encerrados_omie) e 1 leitor (scripts/orcamento-compra/simular.ts, offline). Nenhuma
-- função, view ou tela da prod o lê, e o upsert do espelho o protege (index.ts, colunas preservadas). Este
-- arquivo NÃO grava a coluna: a próxima passada (completo diário, ~00:16 UTC) publica, e aí a RPC marca os
-- ~520 do conjunto e devolve status 'publicado'.
--
-- PRÉ-VOO (psql-ro, 2026-10-20 ~10:30 UTC): 1 linha OBEN, habilitado=false, status 'observado', seq 153,
-- 520 ids; encerrado_omie_em não nulo = 0 linhas.
--
-- REVERTER: update ... set habilitado = false where empresa = 'OBEN'. O backtest volta a recusar na hora
-- (exige habilitado=true), mesmo com a coluna já gravada.
--
-- ENVELOPE: idempotente (re-rodar mantém true); transação do executor (`bun run db:aplicar <arquivo>`, sem
-- BEGIN/COMMIT); pré-condição e pós-condição abaixo.
--
-- RECIBOS: #569 aplicou a 1ª versão (a pré-condição com `<> 1`, que o assert-verde-por-ausencia-gate recusa).
-- Esta versão (`is distinct from 1`) foi reaplicada para o recibo bater com o arquivo. Mesmo efeito: idempotente.
do $pre$
begin
  if (select count(*) from public.reposicao_encerrados_omie_publicacao where empresa = 'OBEN') is distinct from 1 then
    raise exception 'pré-condição: esperava 1 linha OBEN em reposicao_encerrados_omie_publicacao';
  end if;
  if exists (select 1 from public.reposicao_encerrados_omie_publicacao
              where empresa = 'OBEN' and status not in ('observado', 'publicado')) then
    raise exception 'pré-condição: última passada OBEN não terminou em observado/publicado — não ligar sobre tentativa ruim';
  end if;
end
$pre$;

update public.reposicao_encerrados_omie_publicacao
   set habilitado = true
 where empresa = 'OBEN';

do $post$
begin
  if not exists (select 1 from public.reposicao_encerrados_omie_publicacao
                  where empresa = 'OBEN' and habilitado is true) then
    raise exception 'pós-condição: habilitado da OBEN não ficou true';
  end if;
  if exists (select 1 from public.reposicao_encerrados_omie_publicacao
              where empresa <> 'OBEN' and habilitado is true) then
    raise exception 'pós-condição: outra empresa ficou habilitada';
  end if;
  if exists (select 1 from public.purchase_orders_tracking where encerrado_omie_em is not null) then
    raise exception 'pós-condição: encerrado_omie_em gravado fora da passada';
  end if;
end
$post$;
