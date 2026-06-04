-- Asserts do SLA de WhatsApp para rodar num PostgreSQL 17 local.
-- Parte 1 (funções): roda contra um DB com a migration 20260604130000 aplicada (sem deps de tabela).
-- Parte 2/3 (view/digest) precisam do schema-snapshot + migrations base — ver o plano.

-- ===== Função de minutos-úteis: expediente seg-sex 07:30-17:30 America/Sao_Paulo =====
DO $$
BEGIN
  -- mesmo instante / invertido → 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T12:00:00-03','2026-06-04T12:00:00-03') = 0, 'mesmo instante';
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T13:00:00-03','2026-06-04T12:00:00-03') = 0, 'invertido';
  -- 09:00 → 09:30 numa quinta = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T09:00:00-03','2026-06-04T09:30:00-03') = 30, '30 min dentro do expediente';
  -- 17:00 → 18:00 (sexta): só conta até 17:30 = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-05T17:00:00-03','2026-06-05T18:00:00-03') = 30, 'clamp no fim do expediente';
  -- 06:00 → 08:00 (quinta): só conta de 07:30 = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T06:00:00-03','2026-06-04T08:00:00-03') = 30, 'clamp no início do expediente';
  -- atravessa a noite: qui 17:00 → sex 08:00 = 30 (qui 17:00-17:30) + 30 (sex 07:30-08:00) = 60
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T17:00:00-03','2026-06-05T08:00:00-03') = 60, 'atravessa a noite';
  -- só fim de semana: sáb 09:00 → dom 18:00 = 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-06T09:00:00-03','2026-06-07T18:00:00-03') = 0, 'fim de semana = 0';
  -- inteiro fora do expediente: qui 19:00 → qui 22:00 = 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T19:00:00-03','2026-06-04T22:00:00-03') = 0, 'fora do expediente';
  -- sex 17:00 → seg 08:00: sex 30 (17:00-17:30) + fim de semana 0 + seg 30 (07:30-08:00) = 60
  ASSERT public.whatsapp_minutos_uteis('2026-06-05T17:00:00-03','2026-06-08T08:00:00-03') = 60, 'pula o fim de semana';
  -- dia útil cheio: qui 07:30 → qui 17:30 = 600
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T07:30:00-03','2026-06-04T17:30:00-03') = 600, 'dia cheio = 600';
  RAISE NOTICE 'OK: whatsapp_minutos_uteis (10 asserts)';
END $$;

-- ===== stop-keyword =====
DO $$
BEGIN
  ASSERT public.wa_is_stop_keyword('PARAR') = true, 'PARAR';
  ASSERT public.wa_is_stop_keyword('  sair ') = true, 'sair com espaço';
  ASSERT public.wa_is_stop_keyword('CANCELAR!') = true, 'CANCELAR com pontuação';
  ASSERT public.wa_is_stop_keyword('quero parar de receber promoção') = false, 'parar numa frase';
  ASSERT public.wa_is_stop_keyword('qual o preço?') = false, 'pergunta real';
  ASSERT public.wa_is_stop_keyword(NULL) = false, 'null';
  RAISE NOTICE 'OK: wa_is_stop_keyword (6 asserts)';
END $$;
