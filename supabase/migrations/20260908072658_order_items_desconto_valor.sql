-- ============================================================
-- order_items.desconto_valor — o desconto do item em VALOR (R$), com semântica declarada
--
-- POR QUE UMA COLUNA NOVA, e não redefinir `discount`:
--   `order_items.discount` tem SETE consumidores em produção com DUAS fórmulas incompatíveis
--   (cinco fazem `qtd·preço·(1 − d/100)`, dois fazem `qtd·preço − d`). Com qtd=2, preço=100 e
--   desconto=10 isso é 180 contra 190. A divergência nunca apareceu porque a coluna é 0 em 100%
--   das linhas — e onde o desconto é zero as duas fórmulas coincidem.
--
--   Só que esse zero é CEGUEIRA, não medição: a ingestão lia `prod.desconto`, e a API do Omie
--   não tem esse campo. Doc oficial (GET https://app.omie.com.br/api/v1/produtos/pedido/, lida
--   2026-09-07): `det.produto` expõe `tipo_desconto` ("V"/"P"), `percentual_desconto` e
--   `valor_desconto` — `desconto` pelado não existe. O código lia `undefined`, o `|| 0` gravava
--   zero, e ninguém soube. Detalhe em docs/historico/desconto-a-sonda-lia-campo-que-nao-existe.md
--
--   Redefinir `discount` como "R$" deixaria os cinco consumidores percentuais calculando errado
--   no instante da primeira ingestão corrigida — falha SILENCIOSA, porque hoje eles acertam por
--   acidente (zero é neutro nas duas fórmulas). Coluna nova torna a migração de cada consumidor
--   explícita: quem não migrou lê NULL, não um número errado.
--
-- SEM DEFAULT, e NULLABLE, de propósito:
--   `DEFAULT 0` faria toda linha do acervo nascer afirmando "desconto zero" — certificando como
--   fato justamente o que foi provado desconhecido. NULL aqui significa NÃO APURADO, e é o valor
--   honesto para as 70.860 linhas ingeridas pelo leitor cego. Zero passa a significar "o Omie
--   informou que não há desconto", que é outra coisa. (Mesma régua de `unit_price`, que deixou de
--   ser NOT NULL DEFAULT 0 em 2026-09-05 pelo mesmo motivo: ausente ≠ zero.)
--
-- ESTA MIGRATION NÃO MUDA NENHUM NÚMERO. Ela só abre a coluna. Escritores e consumidores migram
-- em passos próprios, e a ordem importa: consumidores ANTES da ingestão — enquanto o acervo é
-- zero, trocar a fórmula dos consumidores é inerte; corrigir a ingestão primeiro ATIVA a
-- divergência.
-- ============================================================

BEGIN;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS desconto_valor numeric;

COMMENT ON COLUMN public.order_items.desconto_valor IS
  'Desconto do item em VALOR ABSOLUTO (R$), da LINHA inteira — não por unidade e não percentual. '
  'Receita líquida da linha = unit_price * quantity - desconto_valor; preço unitário líquido = '
  'unit_price - desconto_valor / quantity. NULL = NÃO APURADO (ingerido pelo leitor que lia a '
  'chave inexistente `prod.desconto`), e é diferente de 0 = o Omie informou que não há desconto. '
  'Origem: det.produto do Omie, normalizado por _shared/desconto-omie.ts, que lê tipo_desconto '
  '("V"/"P") + valor_desconto + percentual_desconto. NUNCA faça COALESCE(desconto_valor, 0) na '
  'ingestão: isso reintroduz a fabricação que a coluna existe para evitar.';

COMMENT ON COLUMN public.order_items.discount IS
  'LEGADO — semântica AMBÍGUA, não use em código novo. Preenchida por um leitor que lia '
  '`prod.desconto`, campo que a API do Omie não tem, então é 0 em 100% das linhas por cegueira, '
  'não por medição. Sete consumidores a interpretaram de duas formas incompatíveis (percentual e '
  'valor). Substituída por desconto_valor. Mantida porque consumidores ainda a leem; remover '
  'exige migrar todos primeiro.';

-- Postcondição: prova SUFICIÊNCIA, não só existência. Um DEFAULT aqui é o defeito, não um detalhe
-- — ele carimbaria "desconto zero" em todo o acervo não apurado, que é exatamente o erro que a
-- coluna existe para não cometer. NOT NULL teria o mesmo efeito por outro caminho.
DO $post$
DECLARE
  v_default text;
  v_nullable text;
  v_tipo text;
BEGIN
  SELECT column_default, is_nullable, data_type
    INTO v_default, v_nullable, v_tipo
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'desconto_valor';

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'FALHOU: order_items.desconto_valor não existe — a migration não pegou.';
  END IF;
  IF v_tipo <> 'numeric' THEN
    RAISE EXCEPTION 'FALHOU: desconto_valor é % , esperado numeric — dinheiro em tipo aproximado.', v_tipo;
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: desconto_valor nasceu com DEFAULT (%) — isso afirma "desconto zero" no acervo inteiro, que é o erro que a coluna existe para evitar.', v_default;
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION 'FALHOU: desconto_valor é NOT NULL — não há como representar "não apurado".';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_description d
      JOIN pg_class c ON c.oid = d.objoid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
     WHERE c.relname = 'order_items' AND a.attname = 'desconto_valor'
  ) THEN
    RAISE EXCEPTION 'FALHOU: desconto_valor sem COMMENT — a semântica é o ponto da coluna; sem ela a ambiguidade volta.';
  END IF;

  RAISE NOTICE 'OK: order_items.desconto_valor numeric NULL, sem default, com semântica declarada.';
END
$post$;

COMMIT;
