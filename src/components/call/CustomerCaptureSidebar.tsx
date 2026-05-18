import { useWebRTCCallContext } from '@/contexts/WebRTCCallContext';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sparkles, Building2, User, Mail, MapPin, Phone, FileText, Tag, Factory, Loader2 } from 'lucide-react';
import { captureFilledCount } from '@/lib/customer-capture/merge';

/**
 * Sidebar exibida durante chamada ativa. Mostra dados cadastrais que a IA
 * está capturando em tempo real do que o cliente fala. Vendedor pode editar
 * cada campo inline.
 *
 * Compact mode: aparece como Card no painel lateral da chamada.
 */
export function CustomerCaptureSidebar() {
  const {
    isEstablished,
    customerCaptureBuffer: c,
    updateCustomerCaptureBuffer: update,
    spinAnalysisStatus,
  } = useWebRTCCallContext();

  if (!isEstablished) return null;

  const filled = captureFilledCount(c);
  const isAnalyzing = spinAnalysisStatus === 'analyzing';

  return (
    <Card className="p-3 space-y-3 max-w-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-status-warning" />
          <h3 className="text-sm font-semibold">Capturando cliente</h3>
        </div>
        <div className="flex items-center gap-2">
          {isAnalyzing && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          <Badge variant="outline" className="text-2xs">{filled} dados</Badge>
        </div>
      </div>

      {filled === 0 && (
        <div className="text-2xs text-muted-foreground italic">
          Aguardando cliente revelar dados cadastrais (nome da empresa, CNPJ, endereço, email, segmento, volume mensal...)
        </div>
      )}

      <div className="space-y-2 text-xs">
        <FieldRow icon={Building2} label="Razão social" value={c.razao_social} onChange={(v) => update({ razao_social: v || null })} />
        <FieldRow icon={User} label="Contato" value={c.nome_contato} onChange={(v) => update({ nome_contato: v || null })} />
        <FieldRow icon={FileText} label="CNPJ" value={c.cnpj} onChange={(v) => update({ cnpj: v || null })} />
        <FieldRow icon={Mail} label="Email" value={c.email} onChange={(v) => update({ email: v || null })} />
        <FieldRow icon={Phone} label="Telefone alt." value={c.telefone_alternativo} onChange={(v) => update({ telefone_alternativo: v || null })} />

        <div className="grid grid-cols-2 gap-2">
          <FieldRow icon={MapPin} label="Cidade" value={c.cidade} onChange={(v) => update({ cidade: v || null })} compact />
          <FieldRow icon={null} label="UF" value={c.estado} onChange={(v) => update({ estado: (v || null) as string | null })} compact />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow icon={Factory} label="Segmento" value={c.segmento} onChange={(v) => update({ segmento: v || null })} compact />
          <div>
            <Label className="text-[10px] flex items-center gap-1 text-muted-foreground">Volume mensal</Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={c.volume_mensal_litros ?? ''}
              onChange={(e) => update({ volume_mensal_litros: e.target.value ? Number(e.target.value) : null })}
              placeholder="L/mês"
            />
          </div>
        </div>

        {c.produtos_interesse.length > 0 && (
          <div>
            <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Tag className="w-2.5 h-2.5" /> Interesse
            </Label>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {c.produtos_interesse.map((p) => (
                <Badge key={p} variant="outline" className="text-2xs">{p}</Badge>
              ))}
            </div>
          </div>
        )}

        {c.tags_detectadas.length > 0 && (
          <div>
            <Label className="text-[10px] text-muted-foreground">Tags</Label>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {c.tags_detectadas.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="text-2xs text-muted-foreground border-t border-border pt-2">
        💡 IA detecta automaticamente conforme cliente fala. Você pode editar qualquer campo.
        Após encerrar a chamada, abrirá wizard pra cadastrar (se cliente for novo).
      </div>
    </Card>
  );
}

function FieldRow({
  icon: Icon,
  label,
  value,
  onChange,
  compact,
}: {
  icon: typeof Building2 | null;
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? '' : 'space-y-0.5'}>
      <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="w-2.5 h-2.5" />}
        {label}
      </Label>
      <Input
        className="h-7 text-xs"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
    </div>
  );
}
