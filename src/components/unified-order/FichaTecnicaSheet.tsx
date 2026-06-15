import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { FileText } from 'lucide-react';
import { type CurrentSpec, FICHA_CAMPOS } from '@/lib/knowledge-base/spec-link';
import { rotularCampo, formatarValorCampo } from '@/lib/knowledge-base/campo-labels';

interface Props {
  spec: CurrentSpec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Ficha técnica do produto (boletim), read-only, exibida sob demanda no wizard
 * de venda. Lê só o que a view `v_omie_product_current_spec` entregou (vínculo
 * confirmado + ficha aprovada). Reusa rótulos/formatadores da Fase B1.
 */
export function FichaTecnicaSheet({ spec, open, onOpenChange }: Props) {
  const campos = FICHA_CAMPOS.map((campo) => ({ campo, valor: spec[campo] })).filter(
    ({ valor }) =>
      valor != null && valor !== '' && !(Array.isArray(valor) && valor.length === 0),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <FileText className="w-4 h-4 text-muted-foreground" />
            {spec.product_name ?? spec.product_code ?? 'Ficha técnica'}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Especificações técnicas do produto.
          </SheetDescription>
          <div className="flex items-center gap-2 flex-wrap">
            {spec.supplier && (
              <Badge variant="outline" className="text-2xs">
                {spec.supplier}
              </Badge>
            )}
            {spec.product_code && (
              <Badge variant="outline" className="text-2xs font-mono">
                {spec.product_code}
              </Badge>
            )}
          </div>
        </SheetHeader>

        {campos.length === 0 ? (
          <p className="text-xs text-muted-foreground mt-4">
            Sem dados técnicos preenchidos.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 mt-4">
            {campos.map(({ campo, valor }) => (
              <div key={campo} className="min-w-0">
                <dt className="text-2xs text-muted-foreground">{rotularCampo(campo)}</dt>
                <dd className="text-xs font-medium tabular-nums break-words">
                  {formatarValorCampo(valor)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </SheetContent>
    </Sheet>
  );
}
