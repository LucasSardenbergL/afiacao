-- Fixture do db/test-db-aplicar.sh — migration que falha NO MEIO, de propósito.
-- A primeira metade cria uma tabela; a segunda estoura. A prova exige que a tabela NÃO
-- exista depois: meia-migration aplicada é o pior desfecho possível em produção, e é
-- exatamente o que a transação única existe para impedir.
CREATE TABLE public.fixture_aplicar_meia (id int PRIMARY KEY);
SELECT 1 / 0;  -- 22012 division_by_zero: aborta a transação inteira
