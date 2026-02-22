import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

// Authentication: requires admin auth OR cron secret
async function authenticateRequest(req: Request): Promise<boolean> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Check cron secret
  const cronSecret = req.headers.get('x-cron-secret');
  const expectedCronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && expectedCronSecret && cronSecret === expectedCronSecret) {
    return true;
  }

  // Check auth header for admin
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error } = await supabaseAuth.auth.getUser();
  if (error || !user) return false;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: roleData } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .single();

  return roleData?.role === 'admin' || roleData?.role === 'employee';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authenticated = await authenticateRequest(req);
    if (!authenticated) {
      return new Response(
        JSON.stringify({ error: 'Não autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const today = new Date().toISOString().split('T')[0];
    
    const { data: schedules, error: schedError } = await supabase
      .from('recurring_schedules')
      .select('*')
      .eq('is_active', true)
      .lte('next_order_date', today);

    if (schedError) throw schedError;

    const results: { schedule_id: string; success: boolean; error?: string }[] = [];

    for (const schedule of schedules || []) {
      try {
        const { data: tools } = await supabase
          .from('user_tools')
          .select('id, tool_category_id, generated_name, custom_name, specifications, tool_categories(name)')
          .in('id', schedule.tool_ids);

        if (!tools || tools.length === 0) {
          results.push({ schedule_id: schedule.id, success: false, error: 'No tools found' });
          continue;
        }

        const { data: servicos } = await supabase
          .from('omie_servicos')
          .select('*')
          .eq('inativo', false);

        const orderItems = tools.map((tool: any) => {
          const categoryName = tool.tool_categories?.name?.toLowerCase() || '';
          const matchingService = (servicos || []).find((s: any) => 
            s.descricao.toLowerCase().includes(categoryName)
          );

          return {
            category: matchingService?.descricao || tool.tool_categories?.name || '',
            quantity: 1,
            omie_codigo_servico: matchingService?.omie_codigo_servico,
            userToolId: tool.id,
            toolName: tool.generated_name || tool.custom_name || tool.tool_categories?.name || '',
            photos: [],
          };
        });

        let addressData = null;
        if (schedule.address_id) {
          const { data: addr } = await supabase
            .from('addresses')
            .select('*')
            .eq('id', schedule.address_id)
            .single();
          if (addr) {
            addressData = {
              street: addr.street,
              number: addr.number,
              complement: addr.complement,
              neighborhood: addr.neighborhood,
              city: addr.city,
              state: addr.state,
              zip_code: addr.zip_code,
            };
          }
        }

        const { error: orderError } = await supabase
          .from('orders')
          .insert({
            user_id: schedule.user_id,
            items: orderItems,
            service_type: 'padrao',
            delivery_option: schedule.delivery_option,
            time_slot: schedule.time_slot,
            address: addressData,
            subtotal: 0,
            delivery_fee: 0,
            total: 0,
            notes: `Pedido automático - Agendamento recorrente`,
            status: 'pedido_recebido',
          });

        if (orderError) throw orderError;

        const nextDate = new Date(schedule.next_order_date);
        nextDate.setDate(nextDate.getDate() + schedule.frequency_days);

        await supabase
          .from('recurring_schedules')
          .update({ 
            next_order_date: nextDate.toISOString().split('T')[0],
            updated_at: new Date().toISOString(),
          })
          .eq('id', schedule.id);

        results.push({ schedule_id: schedule.id, success: true });
      } catch (err) {
        results.push({ schedule_id: schedule.id, success: false, error: String(err) });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Erro ao processar agendamentos' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
