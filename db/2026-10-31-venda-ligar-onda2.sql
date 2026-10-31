-- Liga a Onda 2 (onda_complemento) por DECISÃO DO FOUNDER, antes da condição automática de adoção
-- (venda_avaliar_ondas exige ≥ 80% de contatados por farmer em 2 semanas — medido 0 em 2026-10-31).
--   bun run db:aplicar db/2026-10-31-venda-ligar-onda2.sql [--ensaio]
-- Idempotente: reaplicar não muda nada (UPDATE só se ainda false; log ON CONFLICT DO NOTHING; o
-- gerador é ON CONFLICT/NOT EXISTS). A Onda 3 NÃO é tocada: continua dependendo de repasse vigente.

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_recompra' AND valor = 'true'::jsonb) THEN
    RAISE EXCEPTION 'PRE: Onda 1 (onda_recompra) não está ligada — Onda 2 não pode vir antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_complemento') THEN
    RAISE EXCEPTION 'PRE: chave onda_complemento ausente em venda_config';
  END IF;
END
$pre$;

UPDATE public.venda_config
   SET valor = 'true'::jsonb, atualizado_em = now()
 WHERE chave = 'onda_complemento' AND valor IS DISTINCT FROM 'true'::jsonb;

INSERT INTO public.venda_onda_log (onda, condicao)
VALUES ('onda_complemento', jsonb_build_object(
          'manual', true,
          'decisao', 'founder em 2026-10-31: ligar antes da condição de adoção',
          'condicao_automatica', 'contatados/na_lista >= 0.8 por farmer em 2 semanas',
          'medido_na_decisao', jsonb_build_object('venda_contato', 0, 'venda_lista_acesso', 0)))
ON CONFLICT (onda) DO NOTHING;

-- Complemento da lista ativa de HOJE (o cron das 08:15 UTC já rodou sem ele).
SELECT public.venda_gerar_lista((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'ativa');

DO $post$
DECLARE
  v_compl int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_complemento' AND valor = 'true'::jsonb) THEN
    RAISE EXCEPTION 'POS: onda_complemento não ficou true';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_complemento') THEN
    RAISE EXCEPTION 'POS: sem linha de onda_complemento em venda_onda_log';
  END IF;
  IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_preco' AND valor = 'true'::jsonb)
     AND NOT EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_preco') THEN
    RAISE EXCEPTION 'POS: onda_preco ficou true sem log — este script não deveria tocá-la';
  END IF;
  SELECT count(*) INTO v_compl FROM public.venda_sugestao
   WHERE tipo = 'complemento' AND fase = 'ativa'
     AND dia_referencia = (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  RAISE NOTICE 'POS_OK: onda_complemento ligada; complemento de hoje = % linhas', v_compl;
END
$post$;
