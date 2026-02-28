import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Calculator, Lock, Save, ShieldCheck, AlertTriangle } from 'lucide-react';

const HEALTH_WEIGHTS = [
  { key: 'hs_weight_recency', label: 'Recência', default: 25 },
  { key: 'hs_weight_frequency', label: 'Frequência', default: 20 },
  { key: 'hs_weight_margin', label: 'Margem Média', default: 20 },
  { key: 'hs_weight_diversity', label: 'Diversidade de Categorias', default: 15 },
  { key: 'hs_weight_crosssell', label: 'Cross-sell Adoption', default: 10 },
  { key: 'hs_weight_engagement', label: 'Engajamento Técnico', default: 10 },
];

const PRIORITY_WEIGHTS = [
  { key: 'ps_weight_margin_potential', label: 'Potencial de Margem', default: 35 },
  { key: 'ps_weight_churn_risk', label: 'Risco de Churn', default: 30 },
  { key: 'ps_weight_repurchase', label: 'Probabilidade de Recompra', default: 20 },
  { key: 'ps_weight_goal_proximity', label: 'Proximidade da Meta', default: 15 },
];

function WeightEditor({ title, description, weights, values, onChange, locked }: {
  title: string;
  description: string;
  weights: { key: string; label: string; default: number }[];
  values: Record<string, number>;
  onChange: (key: string, val: number) => void;
  locked: boolean;
}) {
  const total = weights.reduce((a, w) => a + (values[w.key] ?? w.default), 0);
  const isValid = total === 100;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Calculator className="w-4 h-4" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {weights.map(w => {
          const val = values[w.key] ?? w.default;
          return (
            <div key={w.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{w.label}</span>
                <Badge variant="outline" className="text-2xs font-mono">{val}%</Badge>
              </div>
              <Slider
                value={[val]}
                onValueChange={([v]) => onChange(w.key, v)}
                min={0}
                max={100}
                step={5}
                disabled={locked}
                className="h-1.5"
              />
            </div>
          );
        })}
        <div className={`flex items-center justify-between pt-2 border-t ${isValid ? 'text-emerald-600' : 'text-destructive'}`}>
          <span className="text-xs font-medium">Total</span>
          <div className="flex items-center gap-2">
            {!isValid && <AlertTriangle className="w-3 h-3" />}
            <Badge variant={isValid ? 'default' : 'destructive'} className="text-xs font-mono">{total}%</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function GovernanceMathParams() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { isSuperAdmin } = useCommercialRole();
  const queryClient = useQueryClient();

  const canEdit = isSuperAdmin; // Only super_admin (master CPF) can edit

  const { data: config, isLoading } = useQuery({
    queryKey: ['gov-algo-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('farmer_algorithm_config')
        .select('*');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const [healthWeights, setHealthWeights] = useState<Record<string, number>>({});
  const [priorityWeights, setPriorityWeights] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!config) return;
    const hw: Record<string, number> = {};
    const pw: Record<string, number> = {};
    config.forEach(c => {
      if (c.key.startsWith('hs_')) hw[c.key] = Number(c.value);
      if (c.key.startsWith('ps_')) pw[c.key] = Number(c.value);
    });
    setHealthWeights(hw);
    setPriorityWeights(pw);
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const allWeights = { ...healthWeights, ...priorityWeights };
      for (const [key, value] of Object.entries(allWeights)) {
        const existing = config?.find(c => c.key === key);
        if (existing) {
          await supabase.from('farmer_algorithm_config').update({ value, updated_at: new Date().toISOString() }).eq('id', existing.id);
        } else {
          await supabase.from('farmer_algorithm_config').insert({ key, value, description: `Peso do algoritmo: ${key}` });
        }
      }
      // Audit log
      await supabase.from('farmer_audit_log').insert({
        performed_by: user?.id || '',
        action: 'update_algorithm_weights',
        entity_type: 'algorithm_config',
        new_params: allWeights,
        notes: 'Atualização de pesos via Governança',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gov-algo-config'] });
      toast.success('Parâmetros salvos com sucesso');
    },
    onError: (e: any) => toast.error('Erro: ' + e.message),
  });

  const hsTotal = HEALTH_WEIGHTS.reduce((a, w) => a + (healthWeights[w.key] ?? w.default), 0);
  const psTotal = PRIORITY_WEIGHTS.reduce((a, w) => a + (priorityWeights[w.key] ?? w.default), 0);
  const canSave = hsTotal === 100 && psTotal === 100;

  if (!isAdmin && !isSuperAdmin) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">Acesso restrito</p></div>;
  }

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64" /><Skeleton className="h-64" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Calculator className="w-5 h-5" />
            Governança — Parâmetros Matemáticos
          </h1>
          <p className="text-sm text-muted-foreground">
            Ajuste os pesos dos algoritmos de Health Score e Priority Score
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />
            Salvar
          </Button>
        )}
      </div>

      {!canEdit && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-amber-700">
              Apenas o Super Admin (CPF mestre) pode editar estes parâmetros. Você está no modo leitura.
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WeightEditor
          title="Health Score (0-100)"
          description="Saúde geral do cliente na carteira"
          weights={HEALTH_WEIGHTS}
          values={healthWeights}
          onChange={(k, v) => setHealthWeights(prev => ({ ...prev, [k]: v }))}
          locked={!canEdit}
        />
        <WeightEditor
          title="Priority Score Diário"
          description="Priorização diária de atendimento"
          weights={PRIORITY_WEIGHTS}
          values={priorityWeights}
          onChange={(k, v) => setPriorityWeights(prev => ({ ...prev, [k]: v }))}
          locked={!canEdit}
        />
      </div>
    </div>
  );
}
