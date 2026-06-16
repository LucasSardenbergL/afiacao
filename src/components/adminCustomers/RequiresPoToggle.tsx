// Toggle "Exige ordem de compra" do Customer360View.
// Extraído verbatim de src/pages/AdminCustomers.tsx (god-component split).
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Customer } from './types';

export function RequiresPoToggle({ customer }: { customer: Customer }) {
  const [checked, setChecked] = useState<boolean>(!!customer.requires_po);
  const [saving, setSaving] = useState(false);

  const handleChange = async (next: boolean) => {
    setSaving(true);
    const prev = checked;
    setChecked(next);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ requires_po: next })
        .eq('user_id', customer.user_id);
      if (error) throw error;
      customer.requires_po = next;
      toast.success(next ? 'Cliente exige ordem de compra' : 'Ordem de compra desativada');
    } catch (e) {
      setChecked(prev);
      toast.error('Erro ao salvar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="flex items-center gap-2 text-sm pt-2 border-t border-border cursor-pointer">
      <Checkbox checked={checked} disabled={saving} onCheckedChange={(v) => handleChange(!!v)} />
      <span>Exige ordem de compra</span>
    </label>
  );
}
