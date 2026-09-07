import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCron, corsHeaders } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const auth = authorizeCron(req);
    if (!auth.ok) return auth.response;

    // ⚠️ SONDA DE VERSÃO ({"probe":true}) — ANTES do createClient, para seguir sendo o único
    // caminho sem custo. O `authorizeCron` acima aceita exatamente o `x-cron-secret` do SQL Editor
    // ⇒ sem gate próprio. Ver versao.ts / _shared/sonda-versao.ts.
    //
    // ⚠️ Esta edge NÃO lia o corpo: no bundle pré-sensor, `{"probe":true}` executava o tick
    // INTEIRO. A leitura abaixo é ADITIVA (nenhum outro ponto do handler consome `req`) e o
    // `.catch(() => ({}))` preserva o caminho do cron, que chama sem corpo. Daqui pra frente a
    // edge CRIA pedido (`orders`) e AVANÇA o `next_order_date` — o run legítimo do dia seguinte
    // pula a data já consumida, então o dano de um disparo acidental não é só o pedido a mais.
    const corpoBruto: unknown = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const decisaoSonda = classificarSonda(corpoBruto);
    if (decisaoSonda.tipo === 'sonda') {
      return new Response(JSON.stringify(respostaSonda(VERSAO)), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (decisaoSonda.tipo === 'ambiguo') {
      return new Response(
        JSON.stringify({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
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

        const orderItems = tools.map((tool: { id: string; generated_name?: string | null; custom_name?: string | null; tool_categories?: { name?: string } | null }) => {
          const categoryName = tool.tool_categories?.name?.toLowerCase() || '';
          const matchingService = (servicos || []).find((s: { descricao: string; omie_codigo_servico?: string }) => 
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
