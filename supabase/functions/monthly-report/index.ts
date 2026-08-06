import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import {
  type BancoPostgrest,
  montarRelatorios,
  type MotivoSemEnvio,
  planejarEnvios,
  type RelatorioCliente,
} from "../_shared/relatorio-mensal.ts";
// Resend usado via fetch direto à REST API (https://api.resend.com/emails) para evitar dep npm

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Host do app para os links do e-mail. Mesmo padrão das edges de reposição
// (gerar-pedidos-diario / disparar-pedidos-aprovados) — nunca hardcodar o domínio.
const APP_URL = Deno.env.get('APP_URL') ?? 'https://steu.lovable.app';

// A montagem do relatório (e o custo de banco dela) vive em `_shared/relatorio-mensal.ts`,
// coberta por teste. Aqui ficam só HTTP, auth, template e envio.
type CustomerReport = RelatorioCliente;

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
    <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); border-radius: 12px; padding: 28px; margin-bottom: 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0 0 6px 0; font-size: 22px;">Relatório Mensal de Ferramentas</h1>
      <p style="color: rgba(255,255,255,0.85); margin: 0; font-size: 14px;">${monthYear}</p>
    </div>
    <p style="font-size: 15px; color: #333; margin-bottom: 20px;">
      Olá <strong>${report.name}</strong>, aqui está o resumo das suas ferramentas:
    </p>
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
    ` : '<p style="text-align: center; color: #888;">Nenhuma ferramenta cadastrada.</p>' }
    ${report.overdue_count > 0 ? `
    <div style="text-align: center; margin-top: 24px;">
      <p style="font-size: 14px; color: #666; margin-bottom: 12px;">
        Você tem ferramentas que precisam de afiação!
      </p>
      <a href="${APP_URL}/new-order"
         style="display: inline-block; background: linear-gradient(135deg, #dc2626, #991b1b); color: #fff; 
                padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
        Agendar Afiação
      </a>
    </div>
    ` : ''}
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

// Authentication: requires admin auth OR cron secret
async function authenticateRequest(req: Request): Promise<{ authenticated: boolean; isAdmin: boolean }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Check cron secret first
  const cronSecret = req.headers.get('x-cron-secret');
  const expectedCronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && expectedCronSecret && cronSecret === expectedCronSecret) {
    return { authenticated: true, isAdmin: true };
  }

  // Check auth header
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { authenticated: false, isAdmin: false };
  }

  const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error } = await supabaseAuth.auth.getUser();
  if (error || !user) {
    return { authenticated: false, isAdmin: false };
  }

  // Check admin/employee role
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: roleData } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .single();

  const isStaff = roleData?.role === 'master' || roleData?.role === 'employee';
  return { authenticated: isStaff, isAdmin: roleData?.role === 'master' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const targetUserId = body.user_id;
    const sendEmail = body.send_email !== false;
    const previewOnly = body.preview_only === true;

    // 3 consultas, independentemente do tamanho da base de clientes (medido: 5.276 perfis →
    // 3 idas ao banco; a versão anterior fazia ~5.285 e não terminava). O invariante de custo
    // é testado em `_shared/relatorio-mensal_test.ts`, não aqui.
    const reports: CustomerReport[] = await montarRelatorios(
      supabase as unknown as BancoPostgrest,
      { userIdAlvo: targetUserId, agora: new Date() },
    );

    // Contadores de entrega: é o que distingue "rodou e não havia para quem enviar" de
    // "rodou e entregou". Sem eles, uma execução que entrega ZERO é indistinguível de uma
    // bem-sucedida — foi assim que o cron entregou zero e-mails por meses sem ninguém notar.
    // Os logs identificam por `user_id`, NUNCA por e-mail/telefone: log de edge não é lugar
    // de dado pessoal de cliente.
    const semContato: Record<MotivoSemEnvio, number> = { sem_email: 0, sem_canal_nenhum: 0 };
    let enviados = 0;
    let falhasEnvio = 0;
    let naoEnviadosSemChave = 0;

    const envioArmado = sendEmail && !previewOnly;
    if (envioArmado && !resendApiKey) {
      console.error(
        'monthly-report: envio pedido mas RESEND_API_KEY ausente — NENHUM e-mail sai desta execução',
      );
    }

    // Quem recebe × quem não recebe sai de UMA função pura, testada — inclusive pela
    // invariante de conservação (nenhum relatório evapora). O gate de envio mora lá e só
    // lá: replicá-lo aqui como um `continue` extra é exatamente como o caso da chave
    // ausente escapou dos contadores em #1438.
    const plano = planejarEnvios(reports, { envioArmado, temChaveResend: !!resendApiKey });

    // Contadores derivados da partição, não recontados por outro caminho.
    for (const { report, motivo } of plano.pulados) {
      if (motivo === 'sem_chave_resend') {
        naoEnviadosSemChave++;
        continue;
      }
      // `envio_desarmado` (preview / `send_email:false`) é o modo pedido, não anomalia:
      // não polui os contadores nem o log.
      if (motivo === 'envio_desarmado') continue;

      semContato[motivo]++;
      console.warn(
        `monthly-report: user_id ${report.user_id} PULADO (${motivo}) — ` +
        `${report.total_tools} ferramenta(s), ${report.overdue_count} atrasada(s)`,
      );
    }

    for (const report of plano.destinatarios) {
      const html = generateEmailHtml(report);

      try {
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: 'Colacor <noreply@colacor.com.br>',
            to: [report.email],
            subject: `🔧 Relatório Mensal de Ferramentas - ${report.overdue_count > 0 ? `${report.overdue_count} ferramenta(s) atrasada(s)` : 'Tudo em dia!'}`,
            html,
          }),
        });
        if (!resp.ok) {
          falhasEnvio++;
          console.error(`monthly-report: envio FALHOU p/ user_id ${report.user_id}: HTTP ${resp.status}`);
        } else {
          enviados++;
          console.log(`monthly-report: enviado p/ user_id ${report.user_id}`);
        }
      } catch (emailErr) {
        falhasEnvio++;
        console.error(`monthly-report: envio FALHOU p/ user_id ${report.user_id}:`, emailErr);
      }
    }

    const puladosTotal = semContato.sem_email + semContato.sem_canal_nenhum;
    if (puladosTotal > 0) {
      console.warn(
        `monthly-report: ${puladosTotal} de ${reports.length} cliente(s) com ferramenta ficaram ` +
        `SEM relatório por falta de contato (${semContato.sem_email} sem e-mail mas com telefone, ` +
        `${semContato.sem_canal_nenhum} sem canal nenhum).`,
      );
    }

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
      // `success: true` + `reports_count: 0` sempre foi ambíguo entre "ninguém tem ferramenta"
      // e "todo mundo ficou sem contato". Estes campos desambiguam sem precisar ir ao banco.
      emails_enviados: enviados,
      falhas_envio: falhasEnvio,
      pulados_sem_contato: puladosTotal,
      pulados_detalhe: semContato,
      // Fecha a conta: sem este campo, os clientes alcançáveis que não chegaram a ser tentados
      // (envio pedido, ambiente sem chave) sumiriam de todos os totais.
      nao_enviados_sem_chave: naoEnviadosSemChave,
      reports: reportsWithWhatsApp,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in monthly-report:', error);
    return new Response(JSON.stringify({ error: 'Erro ao gerar relatório' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
