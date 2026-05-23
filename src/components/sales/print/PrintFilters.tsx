// Card de filtros (data, período, empresas) da Impressão de Pedidos.
// Extraído de src/pages/SalesPrintDashboard.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Sun, Sunset, Building2 } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { COMPANY_LABELS, COMPANY_COLORS, type CompanyFilter } from './types';

export function PrintFilters({
  selectedDate, setSelectedDate, selectedPeriod, setSelectedPeriod, selectedCompanies, toggleCompany,
}: {
  selectedDate: Date;
  setSelectedDate: (d: Date) => void;
  selectedPeriod: 'all' | 'manha' | 'tarde';
  setSelectedPeriod: (p: 'all' | 'manha' | 'tarde') => void;
  selectedCompanies: CompanyFilter[];
  toggleCompany: (c: CompanyFilter) => void;
}) {
  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        {/* Date picker */}
        <div className="flex items-center gap-3 flex-wrap">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className={cn("w-[200px] justify-start text-left font-normal")}>
                <CalendarIcon className="mr-2 h-4 w-4" />
                {format(selectedDate, "dd 'de' MMMM, yyyy", { locale: ptBR })}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={d => d && setSelectedDate(d)}
                initialFocus
                className="p-3 pointer-events-auto"
                locale={ptBR}
              />
            </PopoverContent>
          </Popover>

          {/* Period filter */}
          <Tabs value={selectedPeriod} onValueChange={v => setSelectedPeriod(v as 'all' | 'manha' | 'tarde')}>
            <TabsList>
              <TabsTrigger value="all">Todos</TabsTrigger>
              <TabsTrigger value="manha" className="gap-1"><Sun className="h-3 w-3" />Manhã</TabsTrigger>
              <TabsTrigger value="tarde" className="gap-1"><Sunset className="h-3 w-3" />Tarde</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Company toggles */}
        <div className="flex items-center gap-2 flex-wrap">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          {(['oben', 'colacor', 'afiacao'] as CompanyFilter[]).map(c => (
            <Badge
              key={c}
              variant="outline"
              className={cn(
                'cursor-pointer transition-all',
                selectedCompanies.includes(c) ? COMPANY_COLORS[c] : 'opacity-40'
              )}
              onClick={() => toggleCompany(c)}
            >
              {COMPANY_LABELS[c]}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
