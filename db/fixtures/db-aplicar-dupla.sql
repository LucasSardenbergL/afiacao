-- APLICAR_DUPLA_PORTAO — fixture do db/test-db-aplicar.sh: dois applies dos MESMOS bytes ao mesmo
-- tempo (A15, CONTROLE, S14/S15). Commitada de propósito: o `db:aplicar` exige arquivo versionado.
-- O sentinela fica na 1ª linha porque pg_stat_activity.query trunca em 1024 bytes.
--
-- Conta as DUAS coisas que a aplicação dupla faz, separadas — o dano mora na diferença:
--   • a SEQUÊNCIA conta EXECUÇÕES: `nextval` é não-transacional, sobrevive ao ROLLBACK (o canal
--     de toda IDENTITY/serial de produção);
--   • a TABELA conta o DADO: transacional, a linha de um apply revertido some.
-- Sem o re-check o 2º executa o corpo (sequência 2) e o índice único do recibo o reverte (tabela 1):
-- o dado se salva, a execução não. Contar só a tabela aprovaria o defeito.
--
-- Tabela e sequência são criadas pela PROVA, antes dos dois applies: `CREATE … IF NOT EXISTS`
-- concorrente não se tolera (o 2º espera o 1º e morre em pg_class), e isso derrubaria a sabotagem
-- que tira a fila antes de ela chegar ao ponto que mede.
--
-- O PORTÃO: o 1º apply para aqui, dentro do corpo e segurando a vez, até a prova ver o 2º no ponto de
-- decisão. A prova o abre com pg_cancel_backend, que o bloco engole; o teto de 60 s solta sozinho.
SELECT nextval('public.fixture_aplicar_dupla_seq');
INSERT INTO public.fixture_aplicar_dupla DEFAULT VALUES;
DO $portao$
BEGIN
  PERFORM pg_sleep(60);
EXCEPTION WHEN query_canceled THEN
  NULL;
END
$portao$;
