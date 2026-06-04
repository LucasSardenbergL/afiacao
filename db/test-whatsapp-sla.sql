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

-- ===== View v_whatsapp_sla: cenários de "esperando" =====
-- semeia com instantes RELATIVOS a now() (asserts validam presença/ausência + dono, não o
-- número exato — o número exato já é coberto pelos 10 asserts determinísticos da função).
DO $$
DECLARE
  v_vend uuid := gen_random_uuid();   -- vendedora dona
  v_cli  uuid := gen_random_uuid();   -- cliente
  v_owner uuid;
  c_espera uuid; c_bola uuid; c_fechada uuid; c_stop uuid; c_semdono uuid;
  v_min int; v_nivel text; v_n int;
BEGIN
  -- FK: carteira_assignments referencia auth.users(id)
  insert into auth.users(id) values (v_vend), (v_cli) on conflict do nothing;
  insert into public.carteira_assignments(customer_user_id, owner_user_id, source)
    values (v_cli, v_vend, 'omie');

  -- C1: cliente mandou msg há ~40 min e ninguém respondeu → esperando
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k1','5599000000001', v_cli, 'aberta') returning id into c_espera;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_espera,'in','text','qual o preço do verniz?', now() - interval '40 minutes');

  -- C2: cliente mandou, vendedora HUMANA respondeu depois → bola com o cliente (fora)
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k2','5599000000002', v_cli, 'aguardando_cliente') returning id into c_bola;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_bola,'in','text','oi', now() - interval '60 minutes');
  insert into public.whatsapp_messages(conversation_id, direction, type, body, sender_user_id, wa_timestamp)
    values (c_bola,'out','text','respondido', v_vend, now() - interval '30 minutes');

  -- C3: igual C1 mas FECHADA → fora
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k3','5599000000003', v_cli, 'fechada') returning id into c_fechada;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_fechada,'in','text','pergunta', now() - interval '40 minutes');

  -- C4: único inbound é stop-keyword → fora
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k4','5599000000004', v_cli, 'aberta') returning id into c_stop;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_stop,'in','text','PARAR', now() - interval '40 minutes');

  -- C5: cliente sem cadastro (customer_user_id null) → esperando, mas SEM DONO
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k5','5599000000005', null, 'aberta') returning id into c_semdono;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_semdono,'in','text','tem em estoque?', now() - interval '40 minutes');

  -- C6 (anti-template): blast de template SEM sender depois do inbound → ainda esperando
  insert into public.whatsapp_messages(conversation_id, direction, type, body, sender_user_id, wa_timestamp)
    values (c_espera,'out','template','[promo]', null, now() - interval '20 minutes');

  -- ASSERTS
  SELECT count(*) INTO v_n FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_n = 1, 'C1 deve estar esperando (template sem sender NÃO respondeu)';
  SELECT owner_user_id INTO v_owner FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_owner = v_vend, 'C1 tem dono derivado da carteira (= vendedora)';
  ASSERT NOT EXISTS (SELECT 1 FROM public.v_whatsapp_sla WHERE conversation_id IN (c_bola,c_fechada,c_stop)),
    'C2 (bola), C3 (fechada), C4 (stop) NÃO esperam';
  SELECT owner_user_id INTO v_owner FROM public.v_whatsapp_sla WHERE conversation_id = c_semdono;
  ASSERT v_owner IS NULL, 'C5 é sem dono';
  SELECT minutos_uteis_aguardando, nivel INTO v_min, v_nivel FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_min >= 0, 'C1 tem minutos >= 0';
  RAISE NOTICE 'OK: v_whatsapp_sla (esperando/bola/fechada/stop/sem-dono/template) min=% nivel=%', v_min, v_nivel;
END $$;

-- ===== F2: digest idempotente (rodar 2x não duplica) =====
DO $$
DECLARE v_vend2 uuid := gen_random_uuid(); v_cli2 uuid := gen_random_uuid(); c_red uuid; v_antes int; v_depois int;
BEGIN
  -- conversa SEMPRE vermelha (inbound de 7 dias atrás) → garante vermelho independente do horário do teste
  insert into auth.users(id) values (v_vend2),(v_cli2) on conflict do nothing;
  insert into public.carteira_assignments(customer_user_id, owner_user_id, source) values (v_cli2, v_vend2, 'omie');
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('kred','5599000009999', v_cli2, 'aberta') returning id into c_red;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_red,'in','text','urgente, cadê?', now() - interval '7 days');

  PERFORM public.whatsapp_sla_digest_tick();
  SELECT count(*) INTO v_antes FROM public.fornecedor_alerta WHERE tipo='whatsapp_sla';
  PERFORM public.whatsapp_sla_digest_tick();  -- 2ª vez no mesmo dia local
  SELECT count(*) INTO v_depois FROM public.fornecedor_alerta WHERE tipo='whatsapp_sla';
  ASSERT v_antes = 1, 'digest inseriu 1 alerta quando há vermelho';
  ASSERT v_depois = 1, 'digest NÃO duplica no mesmo dia (idempotente)';
  ASSERT (SELECT count(*) FROM public.whatsapp_sla_digest_log) = 1, 'log tem 1 linha do dia';
  RAISE NOTICE 'OK: digest idempotente (antes=% depois=%)', v_antes, v_depois;
END $$;
