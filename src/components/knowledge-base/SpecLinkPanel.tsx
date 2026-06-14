import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Link2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import {
  useSpecLinks,
  useBuscarSkusCandidatos,
  useConfirmarVinculo,
  useDesvincularBoletim,
} from '@/hooks/useProductSpecLink';
import { type SkuCandidato, keyDeSku } from '@/lib/knowledge-base/spec-link';

interface Props {
  spec: {
    id: string;
    product_code: string | null;
    product_name: string | null;
  };
  disabled?: boolean;
}

/**
 * Painel master-only para visualizar, adicionar e remover vínculos boletim↔SKU Omie.
 * Montado no detalhe do boletim (AdminKnowledgeBaseDetail) após a ficha técnica aprovada.
 */
export function SpecLinkPanel({ spec, disabled }: Props) {
  const [termo, setTermo] = useState(spec.product_code ?? '');
  const [candidatos, setCandidatos] = useState<SkuCandidato[]>([]);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());

  const buscar = useBuscarSkusCandidatos();
  const confirmar = useConfirmarVinculo();
  const desvincular = useDesvincularBoletim();
  const { links, isLoading } = useSpecLinks(spec.id);

  // Set para lookup O(1) dos vínculos já confirmados
  const linksSet = useMemo(
    () => new Set(links.map((l) => keyDeSku(l.account, l.omie_codigo_produto))),
    [links],
  );

  // Quantos selecionados ainda não estão vinculados (para habilitar o botão confirmar)
  const selecionadosNaoVinculados = [...selecionados].filter(
    (k) => !linksSet.has(k),
  ).length;

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
    const skusParaVincular = candidatos
      .filter(
        (c) =>
          selecionados.has(keyDeSku(c.account, c.omie_codigo_produto)) &&
          !linksSet.has(keyDeSku(c.account, c.omie_codigo_produto)),
      )
      .map((c) => ({
        account: c.account,
        omie_codigo_produto: c.omie_codigo_produto,
      }));

    if (skusParaVincular.length === 0) return;

    const count = await confirmar.mutateAsync({
      specId: spec.id,
      skus: skusParaVincular,
    });
    if (count > 0) toast.success(`${count} vínculo(s) confirmado(s).`);
    setSelecionados(new Set());
    setCandidatos([]);
  };

  return (
    <Card className="p-3 space-y-2">
      {/* Cabeçalho */}
      <div className="flex items-center gap-2">
        <Link2 className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Itens de venda vinculados</span>
      </div>

      {/* Lista de vínculos confirmados */}
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : links.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          Nenhum item vinculado ainda.
        </p>
      ) : (
        <ul className="space-y-1">
          {links.map((l) => {
            const key = keyDeSku(l.account, l.omie_codigo_produto);
            return (
              <li key={key} className="flex items-center gap-1.5 text-2xs">
                <Badge variant="outline" className="text-2xs">
                  {l.account}
                </Badge>
                <span className="font-mono">
                  {l.codigo ?? l.omie_codigo_produto}
                </span>
                <span className="text-muted-foreground truncate max-w-[200px]">
                  {l.descricao ?? '—'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-5 px-1 text-2xs gap-1"
                  disabled={disabled || desvincular.isPending}
                  onClick={() =>
                    desvincular.mutate({
                      account: l.account,
                      omie_codigo_produto: l.omie_codigo_produto,
                      expectedSpecId: spec.id,
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

      {/* Busca e vínculo de novos SKUs */}
      <div className="border-t border-border pt-2 space-y-2">
        <p className="text-2xs font-medium text-muted-foreground">
          Vincular itens
        </p>

        <div className="flex gap-1.5">
          <Input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleBuscar();
            }}
            placeholder="Código ou descrição do SKU"
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
            {buscar.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              'Buscar'
            )}
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
                  <Badge variant="outline" className="text-2xs">
                    {c.account}
                  </Badge>
                  <span className="font-mono">
                    {c.codigo ?? c.omie_codigo_produto}
                  </span>
                  <span className="text-muted-foreground truncate max-w-[160px]">
                    {c.descricao ?? '—'}
                  </span>
                  {jaVinculado && (
                    <Badge
                      variant="secondary"
                      className="text-2xs ml-auto shrink-0"
                    >
                      já vinculado
                    </Badge>
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
            disabled={
              disabled || confirmar.isPending || selecionadosNaoVinculados === 0
            }
          >
            {confirmar.isPending && (
              <Loader2 className="w-3 h-3 animate-spin" />
            )}
            Confirmar vínculo ({selecionadosNaoVinculados})
          </Button>
        )}
      </div>
    </Card>
  );
}
