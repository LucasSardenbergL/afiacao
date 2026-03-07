import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export interface GovernanceProposal {
  id: string;
  proposed_by: string;
  proposal_type: string;
  title: string;
  description: string | null;
  current_params: Record<string, number>;
  proposed_params: Record<string, number>;
  impact_revenue_pct: number | null;
  impact_margin_pct: number | null;
  impact_churn_pct: number | null;
  impact_margin_per_hour: number | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  algorithm_version: string;
  created_at: string;
  proposer_name?: string;
}

export const useFarmerGovernance = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isGovernor, setIsGovernor] = useState(false);

  useEffect(() => {
    loadData();
    checkGovernor();
  }, [user?.id]);

  const checkGovernor = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('commercial_roles')
      .select('commercial_role')
      .eq('user_id', user.id)
      .single();
    setIsGovernor(data?.commercial_role === 'super_admin');
  };

  const loadData = async () => {
    try {
      const [proposalsRes, logsRes] = await Promise.all([
        supabase.from('farmer_governance_proposals')
          .select('*').order('created_at', { ascending: false }) as any,
        supabase.from('farmer_audit_log')
          .select('*').order('created_at', { ascending: false }).limit(50) as any,
      ]);

      if (proposalsRes.data) {
        // Load proposer names
        const proposerIds = [...new Set(proposalsRes.data.map((p: any) => p.proposed_by))] as string[];
        const { data: profiles } = await supabase
          .from('profiles').select('user_id, name').in('user_id', proposerIds);
        const nameMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name]));
        setProposals(proposalsRes.data.map((p: any) => ({
          ...p, proposer_name: nameMap.get(p.proposed_by) || 'Desconhecido',
        })));
      }
      if (logsRes.data) setAuditLogs(logsRes.data);
    } catch (error) {
      console.error('Error loading governance data:', error);
    } finally {
      setLoading(false);
    }
  };

  const createProposal = async (proposal: {
    proposal_type: string;
    title: string;
    description: string;
    current_params: Record<string, number>;
    proposed_params: Record<string, number>;
    impact_revenue_pct?: number;
    impact_margin_pct?: number;
    impact_churn_pct?: number;
    impact_margin_per_hour?: number;
  }) => {
    if (!user) return;
    const { error } = await supabase.from('farmer_governance_proposals').insert({
      ...proposal,
      proposed_by: user.id,
      algorithm_version: 'v1.0',
    } as any);

    if (error) {
      toast({ title: 'Erro ao criar proposta', variant: 'destructive' });
      return;
    }

    // Audit log
    await supabase.from('farmer_audit_log').insert({
      action: 'proposal_created',
      entity_type: 'governance_proposal',
      performed_by: user.id,
      algorithm_version: 'v1.0',
      previous_params: proposal.current_params,
      new_params: proposal.proposed_params,
      projection: {
        revenue_pct: proposal.impact_revenue_pct,
        margin_pct: proposal.impact_margin_pct,
        churn_pct: proposal.impact_churn_pct,
      },
    } as any);

    toast({ title: 'Proposta criada com sucesso' });
    loadData();
  };

  const approveProposal = async (proposalId: string) => {
    if (!user || !isGovernor) {
      toast({ title: 'Apenas o governador pode aprovar propostas', variant: 'destructive' });
      return;
    }

    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal) return;

    // Apply the changes to algorithm config
    for (const [key, value] of Object.entries(proposal.proposed_params)) {
      await supabase.from('farmer_algorithm_config')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('key', key);
    }

    // Update proposal status
    await supabase.from('farmer_governance_proposals')
      .update({
        status: 'aprovado',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', proposalId);

    // Audit log
    await supabase.from('farmer_audit_log').insert({
      action: 'proposal_approved',
      entity_type: 'governance_proposal',
      entity_id: proposalId,
      performed_by: user.id,
      algorithm_version: proposal.algorithm_version,
      previous_params: proposal.current_params,
      new_params: proposal.proposed_params,
      projection: {
        revenue_pct: proposal.impact_revenue_pct,
        margin_pct: proposal.impact_margin_pct,
        churn_pct: proposal.impact_churn_pct,
      },
    } as any);

    toast({ title: 'Proposta aprovada e aplicada' });
    loadData();
  };

  const rejectProposal = async (proposalId: string, reason: string) => {
    if (!user || !isGovernor) {
      toast({ title: 'Apenas o governador pode rejeitar propostas', variant: 'destructive' });
      return;
    }

    await supabase.from('farmer_governance_proposals')
      .update({
        status: 'rejeitado',
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      }).eq('id', proposalId);

    await supabase.from('farmer_audit_log').insert({
      action: 'proposal_rejected',
      entity_type: 'governance_proposal',
      entity_id: proposalId,
      performed_by: user.id,
      notes: reason,
    } as any);

    toast({ title: 'Proposta rejeitada' });
    loadData();
  };

  return {
    proposals, auditLogs, loading, isGovernor,
    createProposal, approveProposal, rejectProposal, reload: loadData,
  };
};
