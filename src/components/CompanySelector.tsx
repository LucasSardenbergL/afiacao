import { useCompany, COMPANIES, Company } from '@/contexts/CompanyContext';
import { useAuth } from '@/contexts/AuthContext';
import { Building2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const CompanySelector = () => {
  const { activeCompany, setActiveCompany } = useCompany();
  const { isStaff } = useAuth();

  if (!isStaff) return null;

  return (
    <Select value={activeCompany} onValueChange={(v) => setActiveCompany(v as Company)}>
      <SelectTrigger className="h-8 w-[130px] text-xs gap-1 border-primary/30 bg-primary/5">
        <Building2 className="w-3.5 h-3.5 text-primary shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.values(COMPANIES).map((c) => (
          <SelectItem key={c.id} value={c.id} className="text-xs">
            {c.shortName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
