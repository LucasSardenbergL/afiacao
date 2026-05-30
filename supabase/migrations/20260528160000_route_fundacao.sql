-- PR2a: fundação de rota (agenda, override de feriado, config de disparo, log de contato).
-- ⚠️ Aplicação MANUAL via SQL Editor do Lovable (Lovable não aplica migration custom sozinho).

CREATE TABLE IF NOT EXISTS public.route_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  city text NOT NULL,            -- canônico: UPPER, sem acento (ex.: 'FORMIGA')
  uf text NOT NULL DEFAULT 'MG',
  is_daily boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_route_schedule_weekday ON public.route_schedule(weekday) WHERE ativo;

CREATE TABLE IF NOT EXISTS public.route_calendar_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL UNIQUE,
  cancela_rota boolean NOT NULL DEFAULT false,
  motivo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.route_disparo_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  disparo_inicio time NOT NULL DEFAULT '07:30',
  disparo_corte  time NOT NULL DEFAULT '15:30',
  meta_tier_cap  int  NOT NULL DEFAULT 1000,
  win_back_reserva_pct numeric NOT NULL DEFAULT 0.20,
  cold_start_piso_dia  int NOT NULL DEFAULT 3,
  capacidade_ligacoes_dia int NOT NULL DEFAULT 40,
  cadencia_min_dias int NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.route_disparo_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.route_contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_rota date NOT NULL,
  customer_user_id uuid,
  farmer_id uuid,
  canal text NOT NULL CHECK (canal IN ('whatsapp','ligacao')),
  valor_da_ligacao numeric,
  bucket text,
  status text,         -- enviado/respondido/convertido/sem_resposta/opt_out
  pedido_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_route_contact_log_customer ON public.route_contact_log(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_contact_log_data ON public.route_contact_log(data_rota);

ALTER TABLE public.route_schedule          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_calendar_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_disparo_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_contact_log       ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master). escrita: master (config/agenda) — log escrito por service_role (edge, PR2b).
CREATE POLICY "route_sched_staff_read" ON public.route_schedule FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_sched_master_write" ON public.route_schedule FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_override_staff_read" ON public.route_calendar_override FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_override_master_write" ON public.route_calendar_override FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_config_staff_read" ON public.route_disparo_config FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_config_master_write" ON public.route_disparo_config FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_log_staff_read" ON public.route_contact_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- seed da agenda fixa (spec §2.1). Cidades canônicas (UPPER, sem acento). VALIDAR grafia no banco antes (spec §13).
INSERT INTO public.route_schedule (weekday, city, uf, is_daily) VALUES
  (2,'FORMIGA','MG',false),(2,'PIMENTA','MG',false),(2,'PIUMHI','MG',false),(2,'CAPITOLIO','MG',false),
  (3,'CLAUDIO','MG',false),(3,'ITAGUARA','MG',false),(3,'ITAUNA','MG',false),(3,'MATEUS LEME','MG',false),(3,'PARA DE MINAS','MG',false),
  (4,'BOM DESPACHO','MG',false),(4,'ABAETE','MG',false),(4,'MARTINHO CAMPOS','MG',false),(4,'PITANGUI','MG',false),(4,'LUZ','MG',false),(4,'NOVA SERRANA','MG',false),(4,'POMPEU','MG',false),
  (5,'SAO JOAO DEL REI','MG',false),(5,'SANTA CRUZ DE MINAS','MG',false),(5,'PRADOS','MG',false),(5,'OLIVEIRA','MG',false),(5,'TIRADENTES','MG',false),(5,'CARMO DA MATA','MG',false),
  (0,'DIVINOPOLIS','MG',true),(0,'CARMO DO CAJURU','MG',true)
ON CONFLICT DO NOTHING;
