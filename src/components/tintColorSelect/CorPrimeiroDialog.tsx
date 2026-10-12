// "Pedir por cor" (Fase 2A): a vendedora parte da COR que o cliente pediu — não da base.
// Passo 1: busca a cor (tokenizada, sem acento). Passo 2: escolhe produto/acabamento →
// embalagem, cada uma com o preço do motor. A base é derivada da embalagem escolhida.
import { Fragment, useEffect, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, Palette, Plus, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { track } from '@/lib/analytics';
import { selectAltPrice } from '@/lib/tint/select-price';
import { aplicarDesconto, ehBaseTintometricaOben, podeAdicionarCor } from '@/lib/tint/pode-adicionar';
import { AltPriceSourcePicker } from './AltPriceSourcePicker';
import { FormulaSearchResults } from './FormulaSearchResults';
import { useCorPrimeiro } from './useCorPrimeiro';
import type { TintColorSelectDialogProps } from './types';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const TOQUE_CAMPO = '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-24';

interface CorPrimeiroDialogProps {
  open: boolean;
  onClose: () => void;
  /** Mesmo contrato do seletor por base; aqui o produto (a base derivada) vem SEMPRE. */
  onConfirm: TintColorSelectDialogProps['onConfirm'];
}

export function CorPrimeiroDialog({ open, onClose, onConfirm }: CorPrimeiroDialogProps) {
  const s = useCorPrimeiro(open);
  const [realce, setRealce] = useState(0);
  const cores = s.cores ?? [];
  const listaVisivel = !s.cor && cores.length > 0;
  useEffect(() => { setRealce(0); }, [s.cores]);
  useEffect(() => {
    if (open) track('tint.cor_primeiro_aberto');
  }, [open]);

  const onBuscaKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (listaVisivel && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setRealce((r) => (e.key === 'ArrowDown' ? Math.min(cores.length - 1, r + 1) : Math.max(0, r - 1)));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Só a lista do texto JÁ buscado (Enter antes do debounce pegaria a busca anterior).
    if (listaVisivel && s.buscaEstavel && !s.loadingCores) {
      const c = cores[Math.min(realce, cores.length - 1)];
      if (c) s.setCor(c);
    }
  };

  let grupoAnterior: string | null = null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Palette className="w-4 h-4 text-primary" />
            Pedir por cor
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Busque a cor; depois escolha o produto e a embalagem. A base sai da embalagem.
          </p>
        </DialogHeader>

        {s.falhaLeitura && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <span className="block">Não consegui carregar as cores agora (falha de conexão ou do servidor). Isso não significa que a cor não exista.</span>
              <Button size="touch" variant="outline" onClick={s.tentarDeNovo}>Tentar de novo</Button>
            </div>
          </div>
        )}

        {!s.cor ? (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Código ou nome da cor (ex: 346J, verde afiacao)"
                value={s.search}
                onChange={(e) => s.onSearchChange(e.target.value)}
                onKeyDown={onBuscaKeyDown}
                role="combobox"
                aria-expanded={listaVisivel}
                aria-activedescendant={listaVisivel ? `tint-cor-primeiro-${realce}` : undefined}
                className="pl-9 h-9 [@media(pointer:coarse)]:h-11"
                autoFocus
              />
            </div>
            {s.loadingCores && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}
            {listaVisivel && (
              <FormulaSearchResults
                formulas={cores.map((c) => ({ id: c.corId, cor_id: c.corId, nome_cor: c.nomeCor, preco_final_sayersystem: null }))}
                onSelect={(f) => s.setCor({ corId: f.cor_id, nomeCor: f.nome_cor })}
                realce={realce}
                idPrefixo="tint-cor-primeiro"
              />
            )}
            {s.truncado && listaVisivel && (
              <p className="text-[11px] text-muted-foreground">Há mais cores com esse termo — digite mais (código ou outra palavra) para afunilar.</p>
            )}
            {!s.loadingCores && !s.falhaLeitura && s.cores && cores.length === 0 && s.buscaEstavel && (
              <p className="text-xs text-muted-foreground text-center py-4">Nenhuma cor encontrada.</p>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => s.setCor(null)}>
                <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Trocar cor
              </Button>
              <span className="text-xs font-mono font-medium">{s.cor.corId}</span>
              <span className="text-xs truncate">{s.cor.nomeCor}</span>
            </div>

            {s.loadingEmbalagens && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}
            {s.precoErro && (
              <div className="space-y-2">
                <p className="text-xs text-status-error">Não consegui calcular os preços agora — as embalagens aparecem sem preço.</p>
                <Button size="touch" variant="outline" onClick={s.tentarDeNovo}>Tentar de novo</Button>
              </div>
            )}
            {!s.loadingEmbalagens && !s.falhaLeitura && s.embalagens && s.embalagens.length === 0 && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-status-warning-bg border border-status-warning/30 text-xs text-status-warning">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                A cor está no catálogo, mas nenhuma embalagem dela está vinculada a um produto Omie vendável. Avise o tintométrico.
              </div>
            )}

            <div className="space-y-1.5">
              {(s.embalagens ?? []).map((emb) => {
                const altSel = selectAltPrice(emb.precoFinalCsv, s.precos?.[emb.formulaId] ?? null, s.overrides[emb.formulaId] ?? null);
                const desconto = s.descontos[emb.formulaId] ?? 0;
                const precoFinal = altSel.preco != null ? aplicarDesconto(altSel.preco, desconto) : null;
                // Regra ÚNICA de adicionar (a mesma do card da cor selecionada).
                const pode =
                  ehBaseTintometricaOben(emb.product) &&
                  podeAdicionarCor({ precoCarregando: s.precoCarregando, disponivel: altSel.preco != null, precoFinal });
                const cabecalho = emb.grupo !== grupoAnterior ? emb.grupo : null;
                grupoAnterior = emb.grupo;
                return (
                  <Fragment key={emb.formulaId}>
                    {cabecalho && (
                      <p className="pt-2 text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">{cabecalho}</p>
                    )}
                    <div className="rounded-md border border-border text-xs p-2 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium break-words">{emb.productDescricao}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{emb.productCodigo}</p>
                        </div>
                        <div className="text-right shrink-0">
                          {precoFinal != null && !s.precoCarregando ? (
                            <>
                              <span className="font-bold text-primary">{fmt(precoFinal)}</span>
                              {desconto > 0 && altSel.preco != null && (
                                <span className="block text-[10px] text-muted-foreground line-through">{fmt(altSel.preco)}</span>
                              )}
                              <Badge variant={altSel.fonte === 'tabela' ? 'secondary' : 'outline'} className="text-[8px] px-1 py-0 ml-1">
                                {altSel.fonte === 'tabela' ? 'Tabela' : 'Calc.'}
                              </Badge>
                            </>
                          ) : s.precoCarregando ? (
                            <span className="text-[10px] text-muted-foreground">calculando…</span>
                          ) : (
                            <span className="text-[10px] font-medium text-status-warning">sem preço</span>
                          )}
                        </div>
                      </div>
                      {altSel.preco != null && !s.precoCarregando && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <AltPriceSourcePicker formulaId={emb.formulaId} altSel={altSel} isSl={emb.isSl} setOverride={s.setOverride} />
                          <div className="flex items-center gap-2 ml-auto">
                            <label className="text-[10px] text-muted-foreground whitespace-nowrap" htmlFor={`desc-${emb.formulaId}`}>Desconto %</label>
                            <Input
                              id={`desc-${emb.formulaId}`}
                              type="number"
                              min={0}
                              max={99.99}
                              step={1}
                              value={desconto || ''}
                              onChange={(e) => s.setDesconto(emb.formulaId, Number(e.target.value) || 0)}
                              className={`h-6 w-16 text-[10px] text-right ${TOQUE_CAMPO}`}
                              placeholder="0"
                            />
                          </div>
                        </div>
                      )}
                      <Button
                        size="sm"
                        className="w-full h-7 text-xs"
                        disabled={!pode}
                        onClick={() => {
                          if (!pode || precoFinal == null) return;
                          const resultado = onConfirm(
                            emb.formulaId,
                            emb.corId ?? s.cor!.corId,
                            emb.nomeCor ?? s.cor!.nomeCor,
                            precoFinal,
                            altSel.custoCorantes,
                            // Fase 3: a fonte EFETIVA (override validado) + o desconto declarado
                            // + o preço-base — o gate do submit revalida exatamente isto.
                            { source: altSel.fonte, discountPct: desconto, precoSemDesconto: altSel.preco },
                            emb.product,
                          );
                          // Só conta o que ENTROU: conflito no carrinho não é confirmação (Codex P2).
                          if (resultado === 'conflito') return;
                          track('tint.cor_confirmada', {
                            fonte: altSel.fonte ?? 'nenhuma',
                            alternativa: true,
                            com_desconto: desconto > 0,
                            entrada: 'cor_primeiro',
                          });
                        }}
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar ao pedido
                      </Button>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
