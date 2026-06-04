-- ============================================================================
-- SLA de resposta do WhatsApp — funções base + view
-- Spec: docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md
-- Plano: docs/superpowers/plans/2026-06-04-whatsapp-sla-resposta.md
-- ⚠️ Migration MANUAL (Lovable não aplica custom): colar no SQL Editor.
-- ============================================================================

-- ===== PARTE 1 — funções =====================================================

-- stop-keyword: espelha src/lib/whatsapp/stop-keyword.ts (lista canônica).
-- Só dispara quando a mensagem É a palavra (1 token), não numa frase.
create or replace function public.wa_is_stop_keyword(p_body text)
returns boolean
language sql
immutable
as $$
  select case
    when p_body is null then false
    else trim(upper(regexp_replace(p_body, '[^A-Za-z ]', '', 'g')))
         in ('PARAR','SAIR','STOP','CANCELAR','DESCADASTRAR')
  end;
$$;

-- minutos de expediente entre dois instantes (default seg-sex 07:30-17:30 SP).
-- Semântica meio-aberta [desde, ate) ∩ [h_inicio, h_fim) por dia útil.
create or replace function public.whatsapp_minutos_uteis(
  p_desde     timestamptz,
  p_ate       timestamptz,
  p_h_inicio  time   default '07:30',
  p_h_fim     time   default '17:30',
  p_dias      int[]  default array[1,2,3,4,5]   -- ISO DOW: 1=seg … 7=dom
) returns integer
language plpgsql
stable
as $$
declare
  v_total   interval := interval '0';
  v_dia     date;
  v_dia_fim date;
  v_jan_ini timestamptz;
  v_jan_fim timestamptz;
  v_ov_ini  timestamptz;
  v_ov_fim  timestamptz;
  v_guard   int := 0;
begin
  if p_desde is null or p_ate is null or p_desde >= p_ate then
    return 0;
  end if;
  v_dia     := (p_desde at time zone 'America/Sao_Paulo')::date;
  v_dia_fim := (p_ate   at time zone 'America/Sao_Paulo')::date;
  while v_dia <= v_dia_fim loop
    v_guard := v_guard + 1;
    exit when v_guard > 400;  -- guard anti-loop p/ conversa órfã de anos (já estaria no vermelho)
    if extract(isodow from v_dia)::int = any(p_dias) then
      v_jan_ini := (v_dia + p_h_inicio) at time zone 'America/Sao_Paulo';
      v_jan_fim := (v_dia + p_h_fim)    at time zone 'America/Sao_Paulo';
      v_ov_ini  := greatest(p_desde, v_jan_ini);
      v_ov_fim  := least(p_ate, v_jan_fim);
      if v_ov_fim > v_ov_ini then
        v_total := v_total + (v_ov_fim - v_ov_ini);
      end if;
    end if;
    v_dia := v_dia + 1;
  end loop;
  return floor(extract(epoch from v_total) / 60)::int;
end;
$$;

-- ===== PARTE 2 (view + seed) adicionada na Task 3 ===========================
