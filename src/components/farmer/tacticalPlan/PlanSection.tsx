// Primitivos presentacionais do PlanCard (Section, MetricRow, CopyButton).
// Extraídos verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import { Copy, Check, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const Section = ({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-1.5">
      <Icon className="w-3 h-3 text-primary" />
      <span className="text-[10px] font-semibold">{title}</span>
    </div>
    <div className="space-y-1.5 pl-4">{children}</div>
  </div>
);

export const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between text-[10px]">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

export const CopyButton = ({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: (t: string) => void }) => (
  <Button size="sm" variant="ghost" className="h-5 w-5 p-0 shrink-0" onClick={() => onCopy(text)}>
    {copied ? <Check className="w-2.5 h-2.5 text-status-success" /> : <Copy className="w-2.5 h-2.5" />}
  </Button>
);
