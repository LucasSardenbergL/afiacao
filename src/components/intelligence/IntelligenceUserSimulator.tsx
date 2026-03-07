import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserCheck, Eye } from 'lucide-react';

interface UserSimulatorProps {
  onSelect: (id: string | null) => void;
  currentSimulation: string | null;
}

export function IntelligenceUserSimulator({ onSelect, currentSimulation }: UserSimulatorProps) {
  const { data: employees } = useQuery({
    queryKey: ['intel-sim-employees'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, name').eq('is_employee', true);
      if (error) throw error;
      return data || [];
    },
  });

  return (
    <div className="flex items-center gap-2">
      <UserCheck className="w-4 h-4 text-muted-foreground" />
      <Select value={currentSimulation || '__none__'} onValueChange={v => onSelect(v === '__none__' ? null : v)}>
        <SelectTrigger className="h-7 w-[200px] text-xs">
          <SelectValue placeholder="Simular como..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Visão própria</SelectItem>
          {employees?.map(e => (
            <SelectItem key={e.user_id} value={e.user_id}>{e.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {currentSimulation && (
        <Badge variant="outline" className="text-2xs bg-amber-500/10 text-amber-700 border-amber-500/30">
          <Eye className="w-3 h-3 mr-1" /> Simulando
        </Badge>
      )}
    </div>
  );
}
