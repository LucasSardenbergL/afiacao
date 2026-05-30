// Hook de dados/estado do Mapeamento SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split):
// 2 queries (mapeamentos + descrições), memos de filtro, upsert e validação.
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { EMPTY_FORM } from './config';
import type { Mapeamento, DescricaoLookup, ValidacaoResult } from './types';
import { validarGabarito, sugerirMapeamentos, PARSER_VERSION, type SugestaoSegura } from '@/lib/reposicao/sayerlack-sku';

export function useSkuMapeamento() {
  const qc = useQueryClient();
  const [filtroEmpresa, setFiltroEmpresa] = useState<string>('__all__');
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>('__all__');
  const [filtroAtivo, setFiltroAtivo] = useState<string>('__all__');
  const [busca, setBusca] = useState('');
  const [openAdd, setOpenAdd] = useState(false);
  const [openValidar, setOpenValidar] = useState(false);
  const [editing, setEditing] = useState<Mapeamento | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [validacao, setValidacao] = useState<ValidacaoResult | null>(null);
  const [validando, setValidando] = useState(false);

  const { data: mapeamentos, isLoading } = useQuery({
    queryKey: ['sku-mapeamento'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sku_fornecedor_externo')
        .select('*')
        .order('empresa')
        .order('fornecedor_nome')
        .order('sku_omie');
      if (error) throw error;
      return data as Mapeamento[];
    },
  });

  // Lookup de descrições do Omie a partir de pedido_compra_item (último valor visto)
  const skusOmie = useMemo(() => (mapeamentos ?? []).map((m) => m.sku_omie), [mapeamentos]);

  const { data: descricoes } = useQuery({
    queryKey: ['sku-descricoes', skusOmie],
    enabled: skusOmie.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao')
        .in('sku_codigo_omie', skusOmie);
      if (error) throw error;
      const map = new Map<string, string>();
      (data as DescricaoLookup[]).forEach((d) => {
        if (!map.has(d.sku_codigo_omie) && d.sku_descricao) {
          map.set(d.sku_codigo_omie, d.sku_descricao);
        }
      });
      return map;
    },
  });

  const empresas = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.empresa))).sort(),
    [mapeamentos],
  );
  const fornecedores = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.fornecedor_nome))).sort(),
    [mapeamentos],
  );

  const filtrados = useMemo(() => {
    return (mapeamentos ?? []).filter((m) => {
      if (filtroEmpresa !== '__all__' && m.empresa !== filtroEmpresa) return false;
      if (filtroFornecedor !== '__all__' && m.fornecedor_nome !== filtroFornecedor) return false;
      if (filtroAtivo === 'ativos' && !m.ativo) return false;
      if (filtroAtivo === 'inativos' && m.ativo) return false;
      if (busca.trim()) {
        const t = busca.trim().toLowerCase();
        const desc = descricoes?.get(m.sku_omie) ?? '';
        return (
          m.sku_omie.toLowerCase().includes(t) ||
          (m.sku_portal ?? '').toLowerCase().includes(t) ||
          desc.toLowerCase().includes(t)
        );
      }
      return true;
    });
  }, [mapeamentos, filtroEmpresa, filtroFornecedor, filtroAtivo, busca, descricoes]);

  const upsertMut = useMutation({
    mutationFn: async (payload: typeof EMPTY_FORM & { id?: number }) => {
      const { id, ...rest } = payload;
      if (id) {
        const { error } = await supabase
          .from('sku_fornecedor_externo')
          .update({ ...rest, atualizado_em: new Date().toISOString() })
          .eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('sku_fornecedor_externo').insert(rest);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sku-mapeamento'] });
      toast.success(editing ? 'Mapeamento atualizado' : 'Mapeamento criado');
      setOpenAdd(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
    onError: (e: Error) => toast.error(e.message ?? 'Erro ao salvar'),
  });

  // Grava em lote os mapeamentos "seguros" (1 código extraído da descrição).
  // fator_conversao=1 (default do EMPTY_FORM = regra do negócio; founder revisa antes);
  // unidade_portal = sufixo do código; observacoes marca como auto pro contador `automaticos`.
  const gravarSegurosMut = useMutation({
    mutationFn: async (seguros: SugestaoSegura[]) => {
      if (seguros.length === 0) return 0;
      const rows = seguros.map((s) => ({
        empresa: 'OBEN',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        sku_omie: s.sku_omie,
        sku_portal: s.sku_portal,
        unidade_portal: s.sufixo || 'UN',
        fator_conversao: 1,
        ativo: true,
        observacoes: `extraído automaticamente (parser v${PARSER_VERSION})`,
      }));
      const { error } = await supabase.from('sku_fornecedor_externo').insert(rows);
      if (error) throw error;
      return rows.length;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ['sku-mapeamento'] });
      toast.success(`${n} mapeamento(s) criado(s) automaticamente`);
      setOpenValidar(false);
    },
    onError: (e: Error) => toast.error(e.message ?? 'Erro ao gravar mapeamentos'),
  });

  const handleEdit = (m: Mapeamento) => {
    setEditing(m);
    setForm({
      empresa: m.empresa,
      fornecedor_nome: m.fornecedor_nome,
      sku_omie: m.sku_omie,
      sku_portal: m.sku_portal ?? '',
      unidade_portal: m.unidade_portal,
      fator_conversao: Number(m.fator_conversao),
      ativo: m.ativo,
      observacoes: m.observacoes ?? '',
    });
    setOpenAdd(true);
  };

  const handleNovo = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpenAdd(true);
  };

  const handleValidar = async () => {
    setValidando(true);
    setOpenValidar(true);
    try {
      // SKUs em pedidos Sayerlack OBEN sem mapeamento ativo
      const { data: itens, error: e1 } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao, pedido_id, pedido_compra_sugerido!inner(empresa, fornecedor_nome)')
        .ilike('pedido_compra_sugerido.fornecedor_nome', '%SAYERLACK%')
        .eq('pedido_compra_sugerido.empresa', 'OBEN');
      if (e1) throw e1;

      const skusUnicos = new Map<string, string>();
      (itens as Array<{ sku_codigo_omie: string; sku_descricao: string }> | null)?.forEach((i) => {
        if (!skusUnicos.has(i.sku_codigo_omie)) skusUnicos.set(i.sku_codigo_omie, i.sku_descricao);
      });

      const mapAtivos = new Set(
        (mapeamentos ?? [])
          .filter((m) => m.ativo && m.empresa === 'OBEN' && /SAYERLACK/i.test(m.fornecedor_nome))
          .map((m) => m.sku_omie),
      );

      const faltantes: ValidacaoResult['faltantes'] = [];
      skusUnicos.forEach((desc, sku) => {
        if (!mapAtivos.has(sku)) {
          faltantes.push({
            empresa: 'OBEN',
            fornecedor_nome: 'RENNER SAYERLACK S/A',
            sku_codigo_omie: sku,
            sku_descricao: desc,
          });
        }
      });

      const suspeitos = (mapeamentos ?? []).filter(
        (m) =>
          (m.sku_portal ?? '').trim() === '' ||
          (m.sku_portal ?? '').length < 4 ||
          !/[A-Z]/i.test(m.sku_portal ?? ''),
      );

      const automaticos = (mapeamentos ?? []).filter((m) =>
        (m.observacoes ?? '').toLowerCase().includes('extraído automaticamente'),
      ).length;
      const manuais = (mapeamentos ?? []).length - automaticos;

      // GATE: o parser reproduz os mapeamentos manuais (Sayerlack OBEN ativos)?
      const gabaritoRows = (mapeamentos ?? [])
        .filter((m) => m.ativo && m.empresa === 'OBEN' && /SAYERLACK/i.test(m.fornecedor_nome))
        .map((m) => ({ sku_omie: m.sku_omie, sku_portal: m.sku_portal, descricao: descricoes?.get(m.sku_omie) ?? null }));
      const gabarito = validarGabarito(gabaritoRows);

      // SUGESTÕES: extrai o código da descrição dos faltantes
      const sugestoes = sugerirMapeamentos(
        faltantes.map((f) => ({ sku_codigo_omie: f.sku_codigo_omie, sku_descricao: f.sku_descricao })),
      );

      setValidacao({
        faltantes,
        suspeitos,
        total: mapeamentos?.length ?? 0,
        automaticos,
        manuais,
        gabarito,
        sugestoes,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erro ao validar');
    } finally {
      setValidando(false);
    }
  };

  const handleOpenAddChange = (v: boolean) => {
    setOpenAdd(v);
    if (!v) { setEditing(null); setForm(EMPTY_FORM); }
  };

  return {
    // filtros
    filtroEmpresa, setFiltroEmpresa,
    filtroFornecedor, setFiltroFornecedor,
    filtroAtivo, setFiltroAtivo,
    busca, setBusca,
    empresas, fornecedores,
    // dados
    mapeamentos,
    isLoading,
    descricoes,
    filtrados,
    // add/edit
    openAdd,
    handleOpenAddChange,
    closeAdd: () => setOpenAdd(false),
    isEditing: !!editing,
    form, setForm,
    save: () => upsertMut.mutate({ ...form, id: editing?.id }),
    isSaving: upsertMut.isPending,
    handleEdit,
    handleNovo,
    // validar
    openValidar, setOpenValidar,
    validando, validacao,
    handleValidar,
    gravarSeguros: (seguros: SugestaoSegura[]) => gravarSegurosMut.mutate(seguros),
    gravandoSeguros: gravarSegurosMut.isPending,
  };
}
