-- Fixture do db/test-db-aplicar.sh — migration LENTA de propósito.
-- Existe para abrir a janela em que o defeito de veredito vive: a tentativa JÁ está gravada no
-- ledger (fora da transação) e o apply está DENTRO do corpo quando a conexão morre. Sem a janela,
-- a prova só consegue derrubar a conexão ANTES do primeiro comando — que para na sonda (exit 6) e
-- não exercita nada. O sentinela no comentário é o que a prova procura em pg_stat_activity para
-- saber, com resposta POSITIVA, que o backend está no corpo: `query LIKE '%APPLY_LENTO%'`.
-- O sleep é longo porque quem manda no tempo é a prova (ela derruba a conexão em ~1s); um sleep
-- curto faria o apply TERMINAR durante um poll lento e a prova mediria outra coisa.
CREATE TABLE IF NOT EXISTS public.fixture_aplicar_lento (id int PRIMARY KEY);
SELECT pg_sleep(45);  -- APPLY_LENTO: a janela que a prova usa para derrubar a conexão
