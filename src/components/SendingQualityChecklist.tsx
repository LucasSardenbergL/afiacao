import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { ClipboardCheck, Loader2, CheckCircle2, Package } from 'lucide-react';

interface SendingQualityChecklistProps {
  orderId: string;
  userId: string; // customer user_id (owner of the order)
}

interface QualityLog {
  id: string;
  is_clean: boolean;
  is_separated: boolean;
  is_identified: boolean;
  is_properly_packed: boolean;
  score: number;
}

const CRITERIA = [
  { key: 'is_clean', label: 'Ferramenta limpa', description: 'Sem resíduos, poeira ou graxa excessiva' },
  { key: 'is_separated', label: 'Separada por tipo', description: 'Itens organizados e separados corretamente' },
  { key: 'is_identified', label: 'Identificada', description: 'Com etiqueta, nome ou código visível' },
  { key: 'is_properly_packed', label: 'Embalada corretamente', description: 'Proteção adequada para transporte' },
] as const;

export const SendingQualityChecklist = ({ orderId, userId }: SendingQualityChecklistProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [existingLog, setExistingLog] = useState<QualityLog | null>(null);
  const [checks, setChecks] = useState({
    is_clean: false,
    is_separated: false,
    is_identified: false,
    is_properly_packed: false,
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadExisting();
  }, [orderId]);

  const loadExisting = async () => {
    try {
      const { data } = await supabase
        .from('sending_quality_logs')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle();

      if (data) {
        setExistingLog(data as QualityLog);
        setChecks({
          is_clean: data.is_clean,
          is_separated: data.is_separated,
          is_identified: data.is_identified,
          is_properly_packed: data.is_properly_packed,
        });
      }
    } catch (err) {
      console.error('Error loading quality log:', err);
    } finally {
      setLoading(false);
    }
  };

  const calculateScore = (): number => {
    const total = Object.values(checks).filter(Boolean).length;
    return Math.round((total / 4) * 100);
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);

    const score = calculateScore();

    try {
      if (existingLog) {
        const { error } = await supabase
          .from('sending_quality_logs')
          .update({
            ...checks,
            score,
            evaluated_by: user.id,
          })
          .eq('id', existingLog.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('sending_quality_logs')
          .insert({
            order_id: orderId,
            user_id: userId,
            ...checks,
            score,
            evaluated_by: user.id,
          });

        if (error) throw error;
      }

      toast({
        title: 'Avaliação salva!',
        description: `Qualidade do envio: ${score}%`,
      });

      await loadExisting();
    } catch (err) {
      console.error('Error saving quality log:', err);
      toast({
        title: 'Erro',
        description: 'Não foi possível salvar a avaliação',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const score = calculateScore();
  const checkedCount = Object.values(checks).filter(Boolean).length;

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="w-4 h-4" />
            Qualidade do Envio
          </CardTitle>
          {existingLog && (
            <Badge
              variant="secondary"
              className={
                existingLog.score >= 75
                  ? 'bg-emerald-100 text-emerald-700'
                  : existingLog.score >= 50
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-700'
              }
            >
              {existingLog.score}%
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Avalie como o cliente enviou as ferramentas. Isso alimenta o pilar Organização da gamificação.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {CRITERIA.map(({ key, label, description }) => (
          <label
            key={key}
            className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <Checkbox
              checked={checks[key as keyof typeof checks]}
              onCheckedChange={(checked) =>
                setChecks((prev) => ({ ...prev, [key]: !!checked }))
              }
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            {checks[key as keyof typeof checks] && (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
            )}
          </label>
        ))}

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {checkedCount}/4 critérios • Score: <span className="font-semibold text-foreground">{score}%</span>
            </span>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              existingLog ? 'Atualizar' : 'Salvar'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
