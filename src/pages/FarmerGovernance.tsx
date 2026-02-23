import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFarmerGovernance, type GovernanceProposal } from '@/hooks/useFarmerGovernance';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useAuth } from '@/contexts/AuthContext';
import {
  Shield, CheckCircle, XCircle, Clock, FileText,
  ArrowUpRight, ArrowDownRight, Loader2, Plus, AlertTriangle,
  TrendingUp, TrendingDown, Minus
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const statusConfig: Record<string, { label: string; icon: typeof Clock; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  aguardando_aprovacao: { label: 'Aguardando Aprovação', icon: Clock, variant: 'secondary' },
  aprovado: { label: 'Aprovado', icon: CheckCircle, variant: 'default' },
  rejeitado: { label: 'Rejeitado', icon: XCircle, variant: 'destructive' },
};

const FarmerGovernance = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const {
    proposals, auditLogs, loading, isGovernor,
    createProposal, approveProposal, rejectProposal,
  } = useFarmerGovernance();
  const { config } = useFarmerScoring();

  const [showNewProposal, setShowNewProposal] = useState(false);
  const [rejectDialog, setRejectDialog] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // New proposal form
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [paramChanges, setParamChanges] = useState<Record<string, string>>({});
  const [impacts, setImpacts] = useState({ revenue: '', margin: '', churn: '', marginPerHour: '' });
  const [saving, setSaving] = useState(false);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const editableParams = [
    { key: 'health_w_rf', label: 'Peso RF (Health)', current: config.health_w_rf },
    { key: 'health_w_m', label: 'Peso M (Health)', current: config.health_w_m },
    { key: 'health_w_g', label: 'Peso G (Health)', current: config.health_w_g },
    { key: 'health_w_x', label: 'Peso X (Health)', current: config.health_w_x },
    { key: 'health_w_s', label: 'Peso S (Health)', current: config.health_w_s },
    { key: 'priority_w_churn', label: 'Peso Churn (Priority)', current: config.priority_w_churn },
    { key: 'priority_w_recover', label: 'Peso Recover (Priority)', current: config.priority_w_recover },
    { key: 'priority_w_expansion', label: 'Peso Expansion (Priority)', current: config.priority_w_expansion },
    { key: 'priority_w_eff', label: 'Peso Eff (Priority)', current: config.priority_w_eff },
    { key: 'agenda_pct_risco', label: 'Quota Risco (%)', current: config.agenda_pct_risco },
    { key: 'agenda_pct_expansao', label: 'Quota Expansão (%)', current: config.agenda_pct_expansao },
    { key: 'agenda_pct_followup', label: 'Quota Follow-up (%)', current: config.agenda_pct_followup },
    { key: 'k1', label: 'k1 (ChurnRisk decay)', current: config.k1 },
    { key: 'k2', label: 'k2 (RF decay)', current: config.k2 },
    { key: 'cat_target', label: 'Categorias Alvo', current: config.cat_target },
    { key: 'sla_contact_days', label: 'SLA Contato (dias)', current: config.sla_contact_days },
  ];

  const handleSubmitProposal = async () => {
    if (!title.trim()) return;
    setSaving(true);

    const currentParams: Record<string, number> = {};
    const proposedParams: Record<string, number> = {};

    for (const [key, val] of Object.entries(paramChanges)) {
      if (val.trim() !== '') {
        const param = editableParams.find(p => p.key === key);
        if (param) {
          currentParams[key] = param.current;
          proposedParams[key] = parseFloat(val);
        }
      }
    }

    await createProposal({
      proposal_type: 'weight_change',
      title,
      description,
      current_params: currentParams,
      proposed_params: proposedParams,
      impact_revenue_pct: parseFloat(impacts.revenue) || undefined,
      impact_margin_pct: parseFloat(impacts.margin) || undefined,
      impact_churn_pct: parseFloat(impacts.churn) || undefined,
      impact_margin_per_hour: parseFloat(impacts.marginPerHour) || undefined,
    });

    setShowNewProposal(false);
    setTitle(''); setDescription(''); setParamChanges({}); setImpacts({ revenue: '', margin: '', churn: '', marginPerHour: '' });
    setSaving(false);
  };

  const handleReject = async () => {
    if (!rejectDialog) return;
    await rejectProposal(rejectDialog, rejectReason);
    setRejectDialog(null);
    setRejectReason('');
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Governança" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {isGovernor && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-3 flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium">Você é o Governador – pode aprovar/rejeitar propostas</span>
            </CardContent>
          </Card>
        )}

        <Button className="w-full" onClick={() => setShowNewProposal(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nova Proposta de Ajuste
        </Button>

        <Tabs defaultValue="proposals">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="proposals" className="text-xs">Propostas</TabsTrigger>
            <TabsTrigger value="audit" className="text-xs">Audit Log</TabsTrigger>
          </TabsList>

          <TabsContent value="proposals" className="space-y-3 mt-3">
            {proposals.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-50" />
                Nenhuma proposta registrada
              </div>
            ) : (
              proposals.map(p => <ProposalCard key={p.id} proposal={p} isGovernor={isGovernor} onApprove={approveProposal} onReject={(id) => setRejectDialog(id)} />)
            )}
          </TabsContent>

          <TabsContent value="audit" className="space-y-2 mt-3">
            {auditLogs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Nenhum registro de auditoria
              </div>
            ) : (
              auditLogs.map((log: any) => (
                <Card key={log.id}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <Badge variant="outline" className="text-[10px]">{log.action}</Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(log.created_at), 'dd/MM/yy HH:mm', { locale: ptBR })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{log.entity_type} · v{log.algorithm_version}</p>
                    {log.notes && <p className="text-xs mt-1">{log.notes}</p>}
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* New Proposal Dialog */}
      <Dialog open={showNewProposal} onOpenChange={setShowNewProposal}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" /> Nova Proposta de Ajuste
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Título</label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex: Aumentar peso de Churn Risk" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Descrição / Justificativa</label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Explique o motivo da mudança..." className="mt-1" rows={2} />
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Parâmetros (altere apenas o que deseja mudar)</label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {editableParams.map(p => (
                  <div key={p.key} className="flex items-center gap-2">
                    <span className="text-xs flex-1 min-w-0 truncate">{p.label}</span>
                    <span className="text-xs text-muted-foreground w-12 text-right">{p.current}</span>
                    <span className="text-xs">→</span>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="-"
                      value={paramChanges[p.key] || ''}
                      onChange={e => setParamChanges(prev => ({ ...prev, [p.key]: e.target.value }))}
                      className="w-20 h-7 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Impacto Projetado (simulação)</label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground">Receita (%)</label>
                  <Input type="number" step="0.1" placeholder="Ex: +5.2" value={impacts.revenue} onChange={e => setImpacts(p => ({ ...p, revenue: e.target.value }))} className="h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">Margem (%)</label>
                  <Input type="number" step="0.1" placeholder="Ex: +3.1" value={impacts.margin} onChange={e => setImpacts(p => ({ ...p, margin: e.target.value }))} className="h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">Churn (%)</label>
                  <Input type="number" step="0.1" placeholder="Ex: -2.0" value={impacts.churn} onChange={e => setImpacts(p => ({ ...p, churn: e.target.value }))} className="h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">Margem/Hora (R$)</label>
                  <Input type="number" step="0.01" placeholder="Ex: +15.50" value={impacts.marginPerHour} onChange={e => setImpacts(p => ({ ...p, marginPerHour: e.target.value }))} className="h-7 text-xs" />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewProposal(false)}>Cancelar</Button>
            <Button onClick={handleSubmitProposal} disabled={!title.trim() || saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Shield className="w-4 h-4 mr-1" />}
              Submeter Proposta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={() => setRejectDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rejeitar Proposta</DialogTitle>
          </DialogHeader>
          <Textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Motivo da rejeição..." rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialog(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleReject}>
              <XCircle className="w-4 h-4 mr-1" /> Rejeitar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
};

const ProposalCard = ({ proposal, isGovernor, onApprove, onReject }: {
  proposal: GovernanceProposal;
  isGovernor: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) => {
  const sc = statusConfig[proposal.status] || statusConfig.aguardando_aprovacao;
  const StatusIcon = sc.icon;
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{proposal.title}</p>
            <p className="text-[10px] text-muted-foreground">
              por {proposal.proposer_name} · {format(new Date(proposal.created_at), 'dd/MM/yy HH:mm', { locale: ptBR })}
            </p>
          </div>
          <Badge variant={sc.variant} className="text-[10px] shrink-0 ml-2">
            <StatusIcon className="w-3 h-3 mr-1" />
            {sc.label}
          </Badge>
        </div>

        {proposal.description && (
          <p className="text-xs text-muted-foreground mb-2">{proposal.description}</p>
        )}

        {/* Impact */}
        <div className="grid grid-cols-4 gap-1 mb-2">
          {proposal.impact_revenue_pct != null && (
            <ImpactChip label="Receita" value={proposal.impact_revenue_pct} />
          )}
          {proposal.impact_margin_pct != null && (
            <ImpactChip label="Margem" value={proposal.impact_margin_pct} />
          )}
          {proposal.impact_churn_pct != null && (
            <ImpactChip label="Churn" value={proposal.impact_churn_pct} inverted />
          )}
          {proposal.impact_margin_per_hour != null && (
            <ImpactChip label="R$/h" value={proposal.impact_margin_per_hour} />
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} className="w-full text-xs h-6">
          {expanded ? 'Ocultar detalhes' : 'Ver detalhes'}
        </Button>

        {expanded && (
          <div className="mt-2 space-y-1 bg-muted/30 rounded-lg p-2">
            <p className="text-[10px] font-semibold">Atual → Proposto</p>
            {Object.entries(proposal.proposed_params).map(([key, val]) => (
              <div key={key} className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">{key}</span>
                <span>
                  <span className="text-muted-foreground">{(proposal.current_params as any)[key]}</span>
                  <span className="mx-1">→</span>
                  <span className="font-semibold">{val as number}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {proposal.rejection_reason && (
          <div className="mt-2 bg-destructive/10 rounded-lg p-2">
            <p className="text-[10px] text-destructive font-medium">Motivo: {proposal.rejection_reason}</p>
          </div>
        )}

        {isGovernor && proposal.status === 'aguardando_aprovacao' && (
          <div className="flex gap-2 mt-3">
            <Button size="sm" className="flex-1" onClick={() => onApprove(proposal.id)}>
              <CheckCircle className="w-3 h-3 mr-1" /> Aprovar
            </Button>
            <Button size="sm" variant="destructive" className="flex-1" onClick={() => onReject(proposal.id)}>
              <XCircle className="w-3 h-3 mr-1" /> Rejeitar
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const ImpactChip = ({ label, value, inverted = false }: { label: string; value: number; inverted?: boolean }) => {
  const isPositive = inverted ? value < 0 : value > 0;
  const Icon = value === 0 ? Minus : isPositive ? TrendingUp : TrendingDown;
  const color = value === 0
    ? 'text-muted-foreground bg-muted'
    : isPositive ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50';
  return (
    <div className={`text-center rounded p-1 ${color}`}>
      <Icon className="w-3 h-3 mx-auto" />
      <p className="text-[9px] font-semibold">{value > 0 ? '+' : ''}{value}%</p>
      <p className="text-[8px]">{label}</p>
    </div>
  );
};

export default FarmerGovernance;
