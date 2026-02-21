import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { 
  Loader2, Send, MessageCircle, Mail, Users, 
  AlertTriangle, CheckCircle, Wrench, Eye, ExternalLink 
} from 'lucide-react';

interface ToolSummary {
  name: string;
  internal_code: string | null;
  category: string;
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
  whatsapp_message: string;
  whatsapp_url: string | null;
  email_html?: string;
}

const AdminMonthlyReports = () => {
  const navigate = useNavigate();
  const { isStaff } = useAuth();
  const { toast } = useToast();

  const [reports, setReports] = useState<CustomerReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const loadReports = async (sendEmail = false) => {
    if (sendEmail) {
      setSending(true);
    } else {
      setLoading(true);
    }

    try {
      const { data, error } = await supabase.functions.invoke('monthly-report', {
        body: { 
          send_email: sendEmail, 
          preview_only: !sendEmail 
        },
      });

      if (error) throw error;

      setReports(data.reports || []);
      
      if (sendEmail) {
        toast({
          title: 'E-mails enviados!',
          description: `Relatórios enviados para ${data.reports_count} cliente(s)`,
        });
      }
    } catch (error: any) {
      console.error('Error:', error);
      toast({
        title: 'Erro',
        description: error.message || 'Falha ao gerar relatórios',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
      setSending(false);
    }
  };

  if (!isStaff) {
    navigate('/');
    return null;
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Relatório Mensal" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto">
        {/* Actions */}
        <div className="space-y-3 mb-6">
          <Button 
            className="w-full" 
            variant="outline"
            onClick={() => loadReports(false)} 
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Eye className="w-4 h-4 mr-2" />
            )}
            Pré-visualizar Relatórios
          </Button>
          
          <Button 
            className="w-full" 
            onClick={() => loadReports(true)} 
            disabled={sending || loading}
          >
            {sending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-2" />
            )}
            Enviar E-mails para Todos os Clientes
          </Button>
        </div>

        {/* Stats */}
        {reports.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <Card className="text-center">
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold text-foreground">
                  <Users className="w-5 h-5 inline-block mb-1" /> {reports.length}
                </p>
                <p className="text-xs text-muted-foreground">Clientes</p>
              </CardContent>
            </Card>
            <Card className="text-center">
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold text-destructive">
                  {reports.reduce((sum, r) => sum + r.overdue_count, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Ferramentas atrasadas</p>
              </CardContent>
            </Card>
            <Card className="text-center">
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold text-amber-600">
                  {reports.reduce((sum, r) => sum + r.due_soon_count, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Vencem em breve</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Report cards */}
        <div className="space-y-3">
          {reports.map((report) => (
            <Card key={report.user_id} className="overflow-hidden">
              <CardContent className="p-4">
                {/* Customer header */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">{report.name}</h3>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {report.email && (
                        <Badge variant="secondary" className="text-xs">
                          <Mail className="w-3 h-3 mr-1" />
                          {report.email}
                        </Badge>
                      )}
                      {report.phone && (
                        <Badge variant="secondary" className="text-xs">
                          <MessageCircle className="w-3 h-3 mr-1" />
                          {report.phone}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {report.overdue_count > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        {report.overdue_count} atrasada(s)
                      </Badge>
                    )}
                    {report.due_soon_count > 0 && (
                      <Badge className="text-xs bg-amber-100 text-amber-800 hover:bg-amber-100">
                        {report.due_soon_count} em breve
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Tool summary */}
                <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                  <span className="flex items-center gap-1">
                    <Wrench className="w-3.5 h-3.5" />
                    {report.total_tools} ferramentas
                  </span>
                </div>

                {/* Expandable details */}
                {expandedReport === report.user_id && (
                  <div className="mt-3 space-y-2">
                    <Separator />
                    {report.tools.map((tool, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                        <div className="flex items-center gap-2">
                          {tool.is_overdue ? (
                            <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                          ) : tool.is_due_soon ? (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                          ) : (
                            <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                          )}
                          <span className="text-foreground">{tool.name}</span>
                          {tool.internal_code && (
                            <span className="text-xs font-mono text-muted-foreground">#{tool.internal_code}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{tool.sharpening_count} afiações</span>
                          {tool.anomaly_count > 0 && (
                            <span className="text-destructive">{tool.anomaly_count} anomalias</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 mt-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => setExpandedReport(
                      expandedReport === report.user_id ? null : report.user_id
                    )}
                  >
                    {expandedReport === report.user_id ? 'Ocultar' : 'Ver detalhes'}
                  </Button>
                  
                  {report.whatsapp_url && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => window.open(report.whatsapp_url!, '_blank')}
                    >
                      <MessageCircle className="w-3.5 h-3.5 mr-1" />
                      WhatsApp
                    </Button>
                  )}

                  {report.email_html && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => setPreviewHtml(
                        previewHtml === report.email_html ? null : report.email_html!
                      )}
                    >
                      <Mail className="w-3.5 h-3.5 mr-1" />
                      Ver e-mail
                    </Button>
                  )}
                </div>

                {/* Email preview */}
                {previewHtml && previewHtml === report.email_html && (
                  <div className="mt-3 border border-border rounded-lg overflow-hidden">
                    <iframe
                      srcDoc={report.email_html}
                      className="w-full h-[400px] bg-white"
                      title="Email preview"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {reports.length === 0 && !loading && (
          <div className="text-center py-12">
            <Send className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Relatórios Mensais</h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              Gere relatórios com resumo de ferramentas, afiações e alertas para enviar aos clientes por e-mail e WhatsApp.
            </p>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminMonthlyReports;
