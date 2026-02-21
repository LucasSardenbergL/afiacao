import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface ToolSummary {
  name: string;
  internal_code: string | null;
  category: string;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  sharpening_count: number;
  anomaly_count: number;
  is_overdue: boolean;
  is_due_soon: boolean;
  days_until_due: number | null;
}

interface CustomerReport {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tools: ToolSummary[];
  overdue_count: number;
  due_soon_count: number;
  total_tools: number;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function generateEmailHtml(report: CustomerReport): string {
  const overdueRows = report.tools
    .filter(t => t.is_overdue)
    .map(t => `
      <tr style="background-color: #fef2f2;">
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px;">
          <strong>${t.name}</strong>
          ${t.internal_code ? `<br><span style="font-family: monospace; color: #dc2626; font-size: 12px;">#${t.internal_code}</span>` : ''}
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; color: #dc2626; font-weight: 600;">
          ⚠️ ${Math.abs(t.days_until_due!)} dias atrasado
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.sharpening_count}</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.anomaly_count}</td>
      </tr>
    `).join('');

  const dueSoonRows = report.tools
    .filter(t => t.is_due_soon)
    .map(t => `
      <tr style="background-color: #fffbeb;">
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px;">
          <strong>${t.name}</strong>
          ${t.internal_code ? `<br><span style="font-family: monospace; color: #d97706; font-size: 12px;">#${t.internal_code}</span>` : ''}
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; color: #d97706;">
          Em ${t.days_until_due} dias
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.sharpening_count}</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.anomaly_count}</td>
      </tr>
    `).join('');

  const okRows = report.tools
    .filter(t => !t.is_overdue && !t.is_due_soon)
    .map(t => `
      <tr>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px;">
          <strong>${t.name}</strong>
          ${t.internal_code ? `<br><span style="font-family: monospace; color: #666; font-size: 12px;">#${t.internal_code}</span>` : ''}
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; color: #16a34a;">
          ${t.next_sharpening_due ? `${formatDate(t.next_sharpening_due)}` : 'Não definida'}
        </td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.sharpening_count}</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #e5e5e5; font-size: 14px; text-align: center;">${t.anomaly_count}</td>
      </tr>
    `).join('');

  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const now = new Date();
  const monthYear = `${monthNames[now.getMonth()]}/${now.getFullYear()}`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); border-radius: 12px; padding: 28px; margin-bottom: 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0 0 6px 0; font-size: 22px;">Relatório Mensal de Ferramentas</h1>
      <p style="color: rgba(255,255,255,0.85); margin: 0; font-size: 14px;">${monthYear}</p>
    </div>

    <!-- Greeting -->
    <p style="font-size: 15px; color: #333; margin-bottom: 20px;">
      Olá <strong>${report.name}</strong>, aqui está o resumo das suas ferramentas:
    </p>

    <!-- Stats -->
    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
      <div style="flex: 1; background: #f8f8f8; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #333;">${report.total_tools}</div>
        <div style="font-size: 12px; color: #888;">Ferramentas</div>
      </div>
      <div style="flex: 1; background: #fef2f2; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #dc2626;">${report.overdue_count}</div>
        <div style="font-size: 12px; color: #dc2626;">Atrasadas</div>
      </div>
      <div style="flex: 1; background: #fffbeb; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #d97706;">${report.due_soon_count}</div>
        <div style="font-size: 12px; color: #d97706;">Em breve</div>
      </div>
    </div>

    <!-- Tools table -->
    ${report.tools.length > 0 ? `
    <table style="width: 100%; border-collapse: collapse; border-radius: 10px; overflow: hidden; border: 1px solid #e5e5e5;">
      <thead>
        <tr style="background: #1a1a1a;">
          <th style="padding: 12px 14px; text-align: left; color: #fff; font-size: 13px;">Ferramenta</th>
          <th style="padding: 12px 14px; text-align: left; color: #fff; font-size: 13px;">Próxima Afiação</th>
          <th style="padding: 12px 14px; text-align: center; color: #fff; font-size: 13px;">Afiações</th>
          <th style="padding: 12px 14px; text-align: center; color: #fff; font-size: 13px;">Anomalias</th>
        </tr>
      </thead>
      <tbody>
        ${overdueRows}${dueSoonRows}${okRows}
      </tbody>
    </table>
    ` : '<p style="text-align: center; color: #888;">Nenhuma ferramenta cadastrada.</p>'}

    <!-- CTA -->
    ${report.overdue_count > 0 ? `
    <div style="text-align: center; margin-top: 24px;">
      <p style="font-size: 14px; color: #666; margin-bottom: 12px;">
        Você tem ferramentas que precisam de afiação!
      </p>
      <a href="https://colacor.lovable.app/new-order" 
         style="display: inline-block; background: linear-gradient(135deg, #dc2626, #991b1b); color: #fff; 
                padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
        Agendar Afiação
      </a>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="text-align: center; margin-top: 32px; padding-top: 20px; border-top: 1px solid #e5e5e5;">
      <p style="font-size: 12px; color: #aaa; margin: 0;">
        Colacor • Relatório automático mensal
      </p>
    </div>
  </div>
</body>
</html>`;
}

function generateWhatsAppMessage(report: CustomerReport): string {
  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const now = new Date();
  const monthYear = `${monthNames[now.getMonth()]}/${now.getFullYear()}`;

  let msg = `🔧 *Relatório Mensal - ${monthYear}*\n\n`;
  msg += `Olá ${report.name}! Segue o resumo das suas ferramentas:\n\n`;
  msg += `📊 *Resumo:* ${report.total_tools} ferramentas\n`;

  if (report.overdue_count > 0) {
    msg += `⚠️ *${report.overdue_count} atrasada(s)*\n`;
    report.tools.filter(t => t.is_overdue).forEach(t => {
      msg += `   • ${t.name}${t.internal_code ? ` (#${t.internal_code})` : ''} - ${Math.abs(t.days_until_due!)} dias atrasado\n`;
    });
  }

  if (report.due_soon_count > 0) {
    msg += `\n🔶 *${report.due_soon_count} vence(m) em breve:*\n`;
    report.tools.filter(t => t.is_due_soon).forEach(t => {
      msg += `   • ${t.name}${t.internal_code ? ` (#${t.internal_code})` : ''} - em ${t.days_until_due} dias\n`;
    });
  }

  const okTools = report.tools.filter(t => !t.is_overdue && !t.is_due_soon);
  if (okTools.length > 0) {
    msg += `\n✅ *${okTools.length} em dia*\n`;
    okTools.forEach(t => {
      msg += `   • ${t.name} - ${t.sharpening_count} afiações\n`;
    });
  }

  const totalAnomalies = report.tools.reduce((sum, t) => sum + t.anomaly_count, 0);
  if (totalAnomalies > 0) {
    msg += `\n🔴 *Anomalias registradas:* ${totalAnomalies}\n`;
  }

  msg += `\nPrecisa agendar afiação? Entre em contato conosco! 💬`;

  return msg;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const targetUserId = body.user_id; // optional: send to specific user
    const sendEmail = body.send_email !== false;
    const previewOnly = body.preview_only === true;

    // Get all customers with tools
    let profilesQuery = supabase
      .from('profiles')
      .select('user_id, name, email, phone');
    
    if (targetUserId) {
      profilesQuery = profilesQuery.eq('user_id', targetUserId);
    }

    const { data: profiles, error: profilesError } = await profilesQuery;
    if (profilesError) throw profilesError;

    const reports: CustomerReport[] = [];

    for (const profile of (profiles || [])) {
      // Get user tools
      const { data: tools } = await supabase
        .from('user_tools')
        .select('*, tool_categories(name)')
        .eq('user_id', profile.user_id);

      if (!tools || tools.length === 0) continue;

      const now = new Date();
      const toolSummaries: ToolSummary[] = [];

      for (const tool of tools) {
        // Get event counts
        const { count: sharpeningCount } = await supabase
          .from('tool_events')
          .select('*', { count: 'exact', head: true })
          .eq('user_tool_id', tool.id)
          .eq('event_type', 'sharpening');

        const { count: anomalyCount } = await supabase
          .from('tool_events')
          .select('*', { count: 'exact', head: true })
          .eq('user_tool_id', tool.id)
          .eq('event_type', 'anomaly');

        const nextDue = tool.next_sharpening_due ? new Date(tool.next_sharpening_due) : null;
        const daysUntilDue = nextDue 
          ? Math.ceil((nextDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        toolSummaries.push({
          name: tool.generated_name || tool.custom_name || (tool.tool_categories as any)?.name || 'Ferramenta',
          internal_code: tool.internal_code,
          category: (tool.tool_categories as any)?.name || '',
          last_sharpened_at: tool.last_sharpened_at,
          next_sharpening_due: tool.next_sharpening_due,
          sharpening_count: sharpeningCount || 0,
          anomaly_count: anomalyCount || 0,
          is_overdue: daysUntilDue !== null && daysUntilDue < 0,
          is_due_soon: daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 7,
          days_until_due: daysUntilDue,
        });
      }

      // Sort: overdue first, then due soon, then by days until due
      toolSummaries.sort((a, b) => {
        if (a.is_overdue && !b.is_overdue) return -1;
        if (!a.is_overdue && b.is_overdue) return 1;
        if (a.is_due_soon && !b.is_due_soon) return -1;
        if (!a.is_due_soon && b.is_due_soon) return 1;
        return (a.days_until_due ?? 999) - (b.days_until_due ?? 999);
      });

      const report: CustomerReport = {
        user_id: profile.user_id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        tools: toolSummaries,
        overdue_count: toolSummaries.filter(t => t.is_overdue).length,
        due_soon_count: toolSummaries.filter(t => t.is_due_soon).length,
        total_tools: toolSummaries.length,
      };

      reports.push(report);

      // Send email if not preview-only
      if (sendEmail && !previewOnly && resendApiKey && profile.email) {
        const resend = new Resend(resendApiKey);
        const html = generateEmailHtml(report);

        try {
          await resend.emails.send({
            from: 'Colacor <noreply@colacor.com.br>',
            to: [profile.email],
            subject: `🔧 Relatório Mensal de Ferramentas - ${report.overdue_count > 0 ? `${report.overdue_count} ferramenta(s) atrasada(s)` : 'Tudo em dia!'}`,
            html,
          });
          console.log(`Email sent to ${profile.email}`);
        } catch (emailErr) {
          console.error(`Failed to send email to ${profile.email}:`, emailErr);
        }
      }
    }

    // Generate WhatsApp messages
    const reportsWithWhatsApp = reports.map(report => ({
      ...report,
      whatsapp_message: generateWhatsAppMessage(report),
      whatsapp_url: report.phone 
        ? `https://wa.me/${report.phone.replace(/\D/g, '')}?text=${encodeURIComponent(generateWhatsAppMessage(report))}`
        : null,
      email_html: previewOnly ? generateEmailHtml(report) : undefined,
    }));

    return new Response(JSON.stringify({ 
      success: true, 
      reports_count: reportsWithWhatsApp.length,
      reports: reportsWithWhatsApp,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error in monthly-report:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
