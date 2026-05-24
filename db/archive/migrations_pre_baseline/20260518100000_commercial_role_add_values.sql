-- PR-MULTIVENDOR-4-ROLES: adicionar valores ao enum commercial_role
-- Aditivo — mantém 'operacional', 'gerencial', 'estrategico', 'super_admin' (legado).
-- Novos: farmer, hunter, closer, master.

ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'farmer';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'hunter';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'closer';
ALTER TYPE public.commercial_role ADD VALUE IF NOT EXISTS 'master';

COMMENT ON TYPE public.commercial_role IS
  'Papel comercial — farmer/hunter/closer/master (PR-MULTIVENDOR) ou operacional/gerencial/estrategico/super_admin (legado).';
