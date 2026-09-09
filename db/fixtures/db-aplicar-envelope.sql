-- Fixture do db/test-db-aplicar.sh — SQL COM envelope de transação, que DEVE ser RECUSADO.
--
-- Esta é a classe de entrada que faltava. As outras fixtures (ok/erro) não têm envelope, e foi
-- exatamente por isso que o #2421 passou verde no CI: o desenvelopador que ele instalou era um
-- NO-OP sobre elas. Teste cujas entradas não cobrem a classe real é cego para o defeito que a
-- classe carrega — o desenvelopamento quebrava TODA migration com envelope, e nenhuma prova viu.
--
-- Por que o envelope é recusado aqui: a transação é DO SCRIPT. `db-aplicar.sh` abre o `BEGIN;`,
-- põe os `SET LOCAL` de timeout, manda o corpo como parâmetro para `aplicar_sql()` — que o roda
-- via `EXECUTE`, onde comando de transação é proibido — e fecha com `COMMIT;`/`ROLLBACK;`.
-- Envelope pertence à migration feita para colar no SQL Editor; SQL feito para o `db:aplicar`
-- não leva. São caminhos diferentes.
--
-- Se a recusa sumir do script, o banco ainda barra — mas com `EXECUTE of transaction commands
-- is not implemented`, um sintoma que esconde a causa. Recusar aqui é dizer o que fazer.
--
-- A tabela abaixo NUNCA deve nascer: a prova exige que a recusa venha antes de tocar o banco.
BEGIN;
CREATE TABLE public.fixture_aplicar_envelope (id int PRIMARY KEY, marca text NOT NULL);
INSERT INTO public.fixture_aplicar_envelope (id, marca) VALUES (1, 'nunca deveria existir');
COMMIT;
