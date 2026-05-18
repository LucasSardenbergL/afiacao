import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { Tables, TablesInsert } from '@/integrations/supabase/types';

type GovernanceProposalRow = Tables<'farmer_governance_proposals'>;
type AuditLogRow = Tables<'farmer_audit_log'>;
type ProfileRow = Pick<Tables<'profiles'>, 'user_id' | 'name'>;

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
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
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
          .select('*').order('created_at', { ascending: false }),
        supabase.from('farmer_audit_log')
          .select('*').order('created_at', { ascending: false }).limit(50),
      ]);

      if (proposalsRes.data) {
        const rows = proposalsRes.data as GovernanceProposalRow[];
        // Load proposer names
        const proposerIds = [...new Set(rows.map((p) => p.proposed_by))];
        const { data: profiles } = await supabase
          .from('profiles').select('user_id, name').in('user_id', proposerIds);
        const nameMap = new Map(
          ((profiles || []) as ProfileRow[]).map((p) => [p.user_id, p.name])
        );
        setProposals(rows.map((p) => ({
          id: p.id,
          proposed_by: p.proposed_by,
          proposal_type: p.proposal_type,
          title: p.title,
          description: p.description,
          current_params: (p.current_params ?? {}) as Record<string, number>,
          proposed_params: (p.proposed_params ?? {}) as Record<string, number>,
          impact_revenue_pct: p.impact_revenue_pct,
          impact_margin_pct: p.impact_margin_pct,
          impact_churn_pct: p.impact_churn_pct,
          impact_margin_per_hour: p.impact_margin_per_hour,
          status: p.status ?? 'pendente',
          approved_by: p.approved_by,
          approved_at: p.approved_at,
          rejection_reason: p.rejection_reason,
          algorithm_version: p.algorithm_version ?? 'v1.0',
          created_at: p.created_at ?? '',
          proposer_name: nameMap.get(p.proposed_by) || 'Desconhecido',
        })));
      }
      if (logsRes.data) setAuditLogs(logsRes.data as AuditLogRow[]);
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
    const proposalInsert: TablesInsert<'farmer_governance_proposals'> = {
      ...proposal,
      proposed_by: user.id,
      algorithm_version: 'v1.0',
    };
    const { error } = await supabase
      .from('farmer_governance_proposals')
      .insert(proposalInsert);

    if (error) {
      toast.error('Erro ao criar proposta');
      return;
    }

    // Audit log
    const auditInsert: TablesInsert<'farmer_audit_log'> = {
      action: 'proposal_created',
      entity_type: 'governance_proposal',
      performed_by: user.id,
      algorithm_version: 'v1.0',
      previous_params: proposal.current_params,
      new_params: proposal.proposed_params,
      projection: {
        revenue_pct: proposal.impact_revenue_pct ?? null,
        margin_pct: proposal.impact_margin_pct ?? null,
        churn_pct: proposal.impact_churn_pct ?? null,
      },
    };
    await supabase.from('farmer_audit_log').insert(auditInsert);

    toast.success('Proposta criada com sucesso');
    loadData();
  };

  const approveProposal = async (proposalId: string) => {
    if (!user || !isGovernor) {
      toast.error('Apenas o governador pode aprovar propostas');
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
    const approveAudit: TablesInsert<'farmer_audit_log'> = {
      action: 'proposal_approved',
      entity_type: 'governance_proposal',
      entity_id: proposalId,
      performed_by: user.id,
      algorithm_version: proposal.algorithm_version,
      previous_params: proposal.current_params,
      new_params: proposal.proposed_params,
      projection: {
        revenue_pct: proposal.impact_revenue_pct ?? null,
        margin_pct: proposal.impact_margin_pct ?? null,
        churn_pct: proposal.impact_churn_pct ?? null,
      },
    };
    await supabase.from('farmer_audit_log').insert(approveAudit);

    toast.success('Proposta aprovada e aplicada');
    loadData();
  };

  const rejectProposal = async (proposalId: string, reason: string) => {
    if (!user || !isGovernor) {
      toast.error('Apenas o governador pode rejeitar propostas');
      return;
    }

    await supabase.from('farmer_governance_proposals')
      .update({
        status: 'rejeitado',
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      }).eq('id', proposalId);

    const rejectAudit: TablesInsert<'farmer_audit_log'> = {
      action: 'proposal_rejected',
      entity_type: 'governance_proposal',
      entity_id: proposalId,
      performed_by: user.id,
      notes: reason,
    };
    await supabase.from('farmer_audit_log').insert(rejectAudit);

    toast.success('Proposta rejeitada');
    loadData();
  };

  return {
    proposals, auditLogs, loading, isGovernor,
    createProposal, approveProposal, rejectProposal, reload: loadData,
  };
};
