import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import {
  getCategoryMappings, upsertCategoryMapping, deleteCategoryMapping,
  getCategoriasOmie, DRE_LINHAS,
  type FinCategoriaDREMapping,
} from '@/services/financeiroService';
import {
  Loader2, Save, Trash2, Building2, Search, Layers, AlertTriangle, History
} from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { useSuggestedMapping } from '@/hooks/useSuggestedMapping';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const dreLabelMap = Object.fromEntries(DRE_LINHAS.map(l => [l.value, l.label]));

const FinanceiroMapping = () => {
  const [company, setCompany] = useState<Company | '_default'>('_default');
  const [mappings, setMappings] = useState<FinCategoriaDREMapping[]>([]);
  const [categorias, setCategorias] = useState<{ omie_codigo: string; descricao: string; tipo: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);

  // Suggestions
  const now = new Date();
  const [targetAno] = useState(now.getFullYear());
  const [targetMes] = useState(now.getMonth() + 1);
  const { data: suggestions = [] } = useSuggestedMapping(company as Company, targetAno, targetMes);
  const qc = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCategoryMappings(company);
      setMappings(data);
      if (company !== '_default') {
        const cats = await getCategoriasOmie(company);
        setCategorias(cats);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [company]);

  useEffect(() => { load(); }, [load]);

  const mappedCodes = new Set(mappings.map(m => m.omie_codigo));
  const unmappedCategorias = categorias.filter(c => !mappedCodes.has(c.omie_codigo));

  const handleSave = async (omie_codigo: string, dre_linha: string, notas?: string) => {
    setSaving(omie_codigo);
    try {
      await upsertCategoryMapping({
        company,
        omie_codigo,
        dre_linha,
        notas: notas || null,
      });
      await load();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCategoryMapping(id);
      await load();
    } catch (e) {
      console.error(e);
    }
  };

  const aplicarSugestao = async (omie_codigo: string, dre_linha: string) => {
    const { error } = await supabase.from('fin_categoria_dre_mapping').insert({
      company: company === '_default' ? '_default' : company,
      omie_codigo,
      dre_linha,
    });
    if (error) {
      toast.error(`Falha ao aplicar: ${error.message}`);
    } else {
      toast.success(`Mapping aplicado: ${omie_codigo} → ${dre_linha}`);
      qc.invalidateQueries({ queryKey: ['fin_suggest_mapping'] });
      qc.invalidateQueries({ queryKey: ['fin_categoria_dre_mapping'] });
      await load();
    }
  };

  const aplicarTodasAltaConfianca = async () => {
    const alta = suggestions.filter(s => s.sugestao.confianca === 'alta' && s.sugestao.linha_dre);
    if (alta.length === 0) return;
    const { error } = await supabase.from('fin_categoria_dre_mapping').insert(
      alta.map(s => ({
        company: company === '_default' ? '_default' : company,
        omie_codigo: s.omie_codigo,
        dre_linha: s.sugestao.linha_dre!
      }))
    );
    if (error) {
      toast.error(`Falha em bulk: ${error.message}`);
    } else {
      toast.success(`${alta.length} mappings aplicados`);
      qc.invalidateQueries({ queryKey: ['fin_suggest_mapping'] });
      qc.invalidateQueries({ queryKey: ['fin_categoria_dre_mapping'] });
      await load();
    }
  };

  const filteredMappings = mappings.filter(m => {
    if (!search) return true;
    const q = search.toLowerCase();
    return m.omie_codigo.toLowerCase().includes(q) ||
      (m.notas || '').toLowerCase().includes(q) ||
      dreLabelMap[m.dre_linha]?.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mapeamento DRE</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configurar como cada categoria do Omie é classificada na DRE gerencial
          </p>
        </div>
        <Select value={company} onValueChange={v => setCompany(v as Company | '_default')}>
          <SelectTrigger className="w-[200px]">
            <Building2 className="w-4 h-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_default">Padrão (todas)</SelectItem>
            {ALL_COMPANIES.map(co => (
              <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="border-status-info/40 bg-status-info-bg/30">
        <CardContent className="p-4 text-sm text-status-info-foreground">
          <p className="font-medium">Como funciona o mapeamento:</p>
          <p className="mt-1 text-status-info">
            Cada categoria do Omie (ex: "1.01.02 - Venda de produtos") precisa ser vinculada a uma linha da DRE.
            O mapeamento "Padrão" se aplica a todas as empresas. Mapeamentos por empresa têm prioridade sobre o padrão.
            Categorias sem mapeamento explícito usam heurística por nome — o ideal é mapear todas manualmente.
          </p>
        </CardContent>
      </Card>

      {/* Suggestions banner */}
      {suggestions.length > 0 && (
        <Alert variant="default" className="border-status-warning bg-status-warning-bg">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{suggestions.length} categorias sem mapeamento</AlertTitle>
          <AlertDescription>
            Afetam R$ {suggestions.reduce((s, x) => s + Number(x.valor_periodo), 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} no período {String(targetMes).padStart(2,'0')}/{targetAno}.
            <Button
              variant="link" className="ml-2 h-auto p-0"
              onClick={() => document.getElementById('suggestions-table')?.scrollIntoView()}
            >
              Ver sugestões →
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por código ou descrição..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {company !== '_default' && unmappedCategorias.length > 0 && (
          <Button
            variant={showUnmapped ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowUnmapped(!showUnmapped)}
          >
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
            {unmappedCategorias.length} sem mapeamento
          </Button>
        )}
      </div>

      {/* Unmapped categories */}
      {showUnmapped && unmappedCategorias.length > 0 && (
        <Card className="border-status-warning/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-status-warning">
              <AlertTriangle className="w-4 h-4" />
              Categorias sem mapeamento
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Código</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="w-16">Tipo</TableHead>
                    <TableHead className="w-52">Linha DRE</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unmappedCategorias.map(cat => (
                    <UnmappedRow
                      key={cat.omie_codigo}
                      cat={cat}
                      saving={saving === cat.omie_codigo}
                      onSave={(dre_linha) => handleSave(cat.omie_codigo, dre_linha, cat.descricao)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Suggestions table */}
      {suggestions.length > 0 && (
        <Card id="suggestions-table" className="border-status-warning/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Sugestões automáticas</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Valor no período</TableHead>
                    <TableHead>Sugestão</TableHead>
                    <TableHead>Confiança</TableHead>
                    <TableHead>Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestions.map(s => (
                    <TableRow key={s.omie_codigo}>
                      <TableCell className="font-mono text-xs">{s.omie_codigo} — {s.categoria_nome}</TableCell>
                      <TableCell className="font-tabular">R$ {Number(s.valor_periodo).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</TableCell>
                      <TableCell>{s.sugestao.linha_dre ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell>
                        <Badge variant={s.sugestao.confianca === 'alta' ? 'default' : 'outline'}>
                          {s.sugestao.confianca}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {s.sugestao.linha_dre && (
                          <Button
                            size="sm" variant="outline"
                            onClick={() => aplicarSugestao(s.omie_codigo, s.sugestao.linha_dre!)}
                          >
                            Aplicar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t p-3">
              <Button
                className="w-full"
                onClick={() => aplicarTodasAltaConfianca()}
                disabled={!suggestions.some(s => s.sugestao.confianca === 'alta')}
              >
                Aplicar todas de alta confiança ({suggestions.filter(s => s.sugestao.confianca === 'alta').length})
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing mappings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Mapeamentos configurados
            <Badge variant="secondary">{filteredMappings.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <PageSkeleton variant="list" className="p-4" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Código Omie</TableHead>
                    <TableHead>Notas</TableHead>
                    <TableHead className="w-16">Escopo</TableHead>
                    <TableHead className="w-52">Linha DRE</TableHead>
                    <TableHead className="w-20" />
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMappings.map(m => (
                    <TableRow key={m.id}>
                      <TableCell className="font-mono text-sm">{m.omie_codigo}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.notas || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={m.company === '_default' ? 'secondary' : 'default'} className="text-xs">
                          {m.company === '_default' ? 'Padrão' : COMPANIES[m.company as Company]?.shortName || m.company}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={m.dre_linha}
                          onValueChange={(v) => handleSave(m.omie_codigo, v, m.notas || undefined)}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DRE_LINHAS.map(l => (
                              <SelectItem key={l.value} value={l.value}>
                                <span className={l.tipo === 'R' ? 'text-status-success' : 'text-status-error'}>
                                  {l.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(m.id)}
                          className="text-status-error hover:text-status-error/80"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAuditTarget({
                              table: 'fin_categoria_dre_mapping',
                              id: m.id,
                              title: `Mapping ${m.omie_codigo}`,
                            });
                          }}
                          aria-label="Histórico"
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredMappings.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {search ? 'Nenhum mapeamento encontrado' : 'Nenhum mapeamento configurado. Sincronize as categorias e adicione mapeamentos.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {auditTarget && (
        <AuditTrailDrawer
          open
          onOpenChange={(open) => !open && setAuditTarget(null)}
          tableName={auditTarget.table}
          rowId={auditTarget.id}
          title={auditTarget.title}
        />
      )}
    </div>
  );
};

function UnmappedRow({ cat, saving, onSave }: {
  cat: { omie_codigo: string; descricao: string; tipo: string };
  saving: boolean;
  onSave: (dre_linha: string) => void;
}) {
  const [selected, setSelected] = useState('');

  return (
    <TableRow>
      <TableCell className="font-mono text-sm">{cat.omie_codigo}</TableCell>
      <TableCell className="text-sm">{cat.descricao}</TableCell>
      <TableCell>
        <Badge variant="outline" className={`text-xs ${cat.tipo === 'R' ? 'text-status-success' : 'text-status-error'}`}>
          {cat.tipo === 'R' ? 'Rec' : cat.tipo === 'D' ? 'Desp' : 'Trf'}
        </Badge>
      </TableCell>
      <TableCell>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Selecionar linha..." />
          </SelectTrigger>
          <SelectContent>
            {DRE_LINHAS.map(l => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          disabled={!selected || saving}
          onClick={() => onSave(selected)}
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default FinanceiroMapping;
