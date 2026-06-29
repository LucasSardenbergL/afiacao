import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, FlaskConical, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { useBuscarSkusCandidatos } from '@/hooks/useProductSpecLink';
import {
  useCatalisadorLinks,
  useConfirmarCatalisador,
  useDesvincularCatalisador,
} from '@/hooks/useCatalisadorLink';
import { keyDeSku, type SkuCandidato } from '@/lib/knowledge-base/spec-link';

interface Props {
  /** catalisador_codigo cru do boletim (ex.: 'FC.6975' / 'FC 6975'). */
  catalisadorCodigo: string;
  disabled?: boolean;
}

/**
 * Painel master-only para casar o catalisador do boletim ↔ SKU(s) Omie.
 * Grava no mapa GLOBAL (kb_catalisador_links, normalizado) → serve todos os boletins com o mesmo
 * código. Montado no detalhe do boletim, irmão do SpecLinkPanel da base.
 */
export function CatalisadorLinkPanel({ catalisadorCodigo, disabled }: Props) {
  const [termo, setTermo] = useState(catalisadorCodigo ?? '');
  const [candidatos, setCandidatos] = useState<SkuCandidato[]>([]);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());

  const buscar = useBuscarSkusCandidatos();
  const confirmar = useConfirmarCatalisador();
  const desvincular = useDesvincularCatalisador();
  const { links, norm, isLoading } = useCatalisadorLinks(catalisadorCodigo);

  const linksSet = useMemo(
    () => new Set(links.map((l) => keyDeSku(l.account, l.omie_codigo_produto))),
    [links],
  );
  const selecionadosNaoVinculados = [...selecionados].filter((k) => !linksSet.has(k)).length;

  const toggle = (key: string) => {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleBuscar = async () => {
    const t = termo.trim();
    if (!t) return;
    const result = await buscar.mutateAsync([t]);
    setCandidatos(result);
    setSelecionados(new Set());
  };

  const handleConfirmar = async () => {
    const skus = candidatos
      .filter(
        (c) =>
          selecionados.has(keyDeSku(c.account, c.omie_codigo_produto)) &&
          !linksSet.has(keyDeSku(c.account, c.omie_codigo_produto)),
      )
      .map((c) => ({ account: c.account, omie_codigo_produto: c.omie_codigo_produto }));
    if (skus.length === 0) return;
    const count = await confirmar.mutateAsync({ codigo: catalisadorCodigo, skus });
    if (count > 0) toast.success(`${count} SKU(s) de catalisador casado(s).`);
    setSelecionados(new Set());
    setCandidatos([]);
  };

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2">
        <FlaskConical className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Catalisador</span>
        <Badge variant="outline" className="text-2xs font-mono">{catalisadorCodigo}</Badge>
        {norm && norm !== catalisadorCodigo && (
          <span className="text-2xs text-muted-foreground">norm: {norm}</span>
        )}
      </div>

      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : links.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          Catalisador ainda não casado — a venda mostra "sob consulta" até vincular o SKU.
        </p>
      ) : (
        <ul className="space-y-1">
          {links.map((l) => {
            const key = keyDeSku(l.account, l.omie_codigo_produto);
            return (
              <li key={key} className="flex items-center gap-1.5 text-2xs">
                <Badge variant="outline" className="text-2xs">{l.account}</Badge>
                <span className="font-mono">{l.codigo ?? l.omie_codigo_produto}</span>
                <span className="text-muted-foreground truncate max-w-[200px]">{l.descricao ?? '—'}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-5 px-1 text-2xs gap-1"
                  disabled={disabled || desvincular.isPending}
                  onClick={() =>
                    desvincular.mutate({
                      account: l.account,
                      omie_codigo_produto: l.omie_codigo_produto,
                      expectedNorm: norm,
                    })
                  }
                >
                  <Unlink className="w-3 h-3" />
                  Desvincular
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-border pt-2 space-y-2">
        <p className="text-2xs font-medium text-muted-foreground">Casar SKU do catalisador</p>
        <div className="flex gap-1.5">
          <Input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleBuscar();
            }}
            placeholder="Código ou descrição do catalisador"
            className="text-xs h-7"
            disabled={disabled || buscar.isPending}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void handleBuscar()}
            disabled={disabled || buscar.isPending || !termo.trim()}
          >
            {buscar.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Buscar'}
          </Button>
        </div>

        {candidatos.length > 0 && (
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {candidatos.map((c) => {
              const key = keyDeSku(c.account, c.omie_codigo_produto);
              const jaVinculado = linksSet.has(key);
              return (
                <li key={key} className="flex items-center gap-1.5 text-2xs">
                  <Checkbox
                    checked={jaVinculado || selecionados.has(key)}
                    disabled={disabled || jaVinculado}
                    onCheckedChange={() => toggle(key)}
                  />
                  <Badge variant="outline" className="text-2xs">{c.account}</Badge>
                  <span className="font-mono">{c.codigo ?? c.omie_codigo_produto}</span>
                  <span className="text-muted-foreground truncate max-w-[160px]">{c.descricao ?? '—'}</span>
                  {jaVinculado && (
                    <Badge variant="secondary" className="text-2xs ml-auto shrink-0">já vinculado</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {candidatos.length > 0 && (
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => void handleConfirmar()}
            disabled={disabled || confirmar.isPending || selecionadosNaoVinculados === 0}
          >
            {confirmar.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            Casar catalisador ({selecionadosNaoVinculados})
          </Button>
        )}
      </div>
    </Card>
  );
}
