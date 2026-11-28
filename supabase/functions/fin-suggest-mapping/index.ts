import { createClient } from "npm:@supabase/supabase-js@2";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { decidirSugestaoCruzada, normalizarDescricao } from "./sugestao-cruzada.ts";
import { fetchAll } from "../_shared/paginate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// =============================================================
// Edge function: sugere linha DRE para categorias Omie sem mapping
// =============================================================
type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'cmv'
  | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'receitas_financeiras'
  | 'outras_receitas' | 'outras_despesas' | 'impostos'
  // DRE fase 2 — existem no mapa (CHECK), mas só por decisão da própria empresa:
  | 'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi' | 'das' | 'irpj' | 'csll' | 'fora_dre' | 'nao_resultado';

// Sugestão cruzada (o que OUTRA empresa mapeou) só copia linha que vale para a empresa-alvo:
// fora_dre NUNCA (sair do DRE é decisão de natureza por empresa) e imposto específico só se o
// regime da alvo for o mesmo (IRPJ/CSLL no Simples sumiriam do resultado; DAS no presumido não existe).
const REGIME_POR_EMPRESA: Record<string, 'simples' | 'presumido'> = { colacor: 'presumido', oben: 'presumido', colacor_sc: 'simples' };
const SO_PRESUMIDO = new Set<string>(['ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'irpj', 'csll']);
function sugerivelPara(linha: string, company: string): boolean {
  if (linha === 'fora_dre' || linha === 'nao_resultado') return false;
  const regime = REGIME_POR_EMPRESA[company];
  if (SO_PRESUMIDO.has(linha)) return regime === 'presumido';
  if (linha === 'das') return regime === 'simples';
  return true;
}

type Suggestion = {
  omie_codigo: string;
  categoria_nome: string;
  valor_periodo: number;
  sugestao: { linha_dre: DreLinha | null; confianca: 'alta' | 'media' | 'baixa'; razao: string };
};

const KEYWORDS: Array<[RegExp, DreLinha]> = [
  [/honor|advog|contador|consultor/i, 'despesas_administrativas'],
  [/aluguel|condom[íi]nio|iptu/i, 'despesas_administrativas'],
  [/sal[áa]rio|folha|enc(argo|argos)|inss|fgts/i, 'despesas_administrativas'],
  [/marketing|propaganda|publicidade|google ads|facebook|meta ads/i, 'despesas_comerciais'],
  [/frete|transporte|combust[íi]vel|pedágio/i, 'despesas_comerciais'],
  [/juros|tarifa banc[áa]ria|iof/i, 'despesas_financeiras'],
  [/rendimento|aplica[çc][ãa]o/i, 'receitas_financeiras'],
  [/icms|pis|cofins|iss|irpj|csll|simples nacional/i, 'impostos'],
  [/cmv|mercador|insumo|mat[ée]ria.prima/i, 'cmv'],
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Sonda de versão — DEPOIS do gate (que já aceita `x-cron-secret`) e antes de qualquer IO.
  // O front chama por GET com query string; a sonda é um POST com corpo `{ "probe": true }`.
  if (req.method === 'POST') {
    const corpoBruto = await req.json().catch(() => ({}));
    const decisaoSonda = classificarSonda(corpoBruto);
    if (decisaoSonda.tipo !== 'disparo') {
      const corpo = decisaoSonda.tipo === 'sonda' ? respostaSonda(VERSAO) : { error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) };
      return new Response(JSON.stringify(corpo), {
        status: decisaoSonda.tipo === 'sonda' ? 200 : 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  const url = new URL(req.url);
  const company = url.searchParams.get('company');
  const ano = Number(url.searchParams.get('ano'));
  const mes = Number(url.searchParams.get('mes'));

  if (!company || !ano || !mes) {
    return new Response(JSON.stringify({ error: 'company, ano, mes obrigatórios' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const startDate = `${ano}-${String(mes).padStart(2,'0')}-01`;
  const endDate = new Date(ano, mes, 0).toISOString().slice(0, 10);

  const { data: pendentes, error: pendErr } = await supabase.rpc('fin_categorias_sem_mapping', {
    p_company: company, p_start: startDate, p_end: endDate,
  });
  if (pendErr) {
    return new Response(JSON.stringify({ error: pendErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: mappings, error: mapErr } = await supabase
    .from('fin_categoria_dre_mapping')
    .select('company, omie_codigo, dre_linha');
  if (mapErr || mappings == null) {
    return new Response(JSON.stringify({ error: mapErr?.message ?? 'fin_categoria_dre_mapping: data null sem error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // PostgREST capa em 1.000 linhas SILENCIOSO: lista truncada viraria "sem mapeamento" calado.
  // Hoje são ~270 mapeamentos; no teto, falha fechada.
  const TETO_POSTGREST = 1000;
  if (mappings.length >= TETO_POSTGREST) {
    return new Response(JSON.stringify({ error: `fin_categoria_dre_mapping: ${mappings.length} linhas — no teto do PostgREST, leitura possivelmente truncada` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // v1.3 — descrição da categoria em CADA empresa (fonte E alvo) do cadastro `fin_categorias`:
  // sugestão cruzada exige mesmo código E mesma descrição (o código é reusado para naturezas
  // distintas entre as empresas). O nome que a RPC traz dos TÍTULOS não serve: o endpoint de
  // títulos do Omie não manda `descricao_categoria` e o writer grava "" (0 de 62k preenchidos,
  // medido 2026-11-27) — o que também matava a sugestão por keyword. Código "" (título sem
  // categoria) não entra no `.in`.
  const codigosPendentes = [...new Set(((pendentes ?? []) as Array<{ omie_codigo: string }>).map(p => p.omie_codigo).filter(c => c != null && c.trim() !== ''))];
  const descricaoPorEmpresaCodigo = new Map<string, string | null>();
  if (codigosPendentes.length > 0) {
    let cats: Array<{ company: string; omie_codigo: string; descricao: string | null }>;
    try {
      cats = await fetchAll<{ company: string; omie_codigo: string; descricao: string | null }>(
        (from, to) => supabase
          .from('fin_categorias')
          .select('company, omie_codigo, descricao')
          .in('omie_codigo', codigosPendentes)
          .order('company').order('omie_codigo')
          .range(from, to),
        'fin_categorias (descrição por empresa)',
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    for (const c of cats) {
      descricaoPorEmpresaCodigo.set(`${c.company}|${c.omie_codigo}`, c.descricao);
    }
  }
  const descricaoDe = (c: string, codigo: string) => descricaoPorEmpresaCodigo.get(`${c}|${codigo}`);

  const byCodigo = new Map<string, { dre_linha: DreLinha; company: string }[]>();
  for (const m of (mappings ?? []) as Array<{ company: string; omie_codigo: string; dre_linha: DreLinha }>) {
    if (!byCodigo.has(m.omie_codigo)) byCodigo.set(m.omie_codigo, []);
    byCodigo.get(m.omie_codigo)!.push({ dre_linha: m.dre_linha, company: m.company });
  }

  const suggestions: Suggestion[] = ((pendentes ?? []) as Array<{
    omie_codigo: string; categoria_nome: string; valor_periodo: number;
  }>).map(p0 => {
    // Nome do ALVO pelo cadastro da própria empresa; o do título só se o cadastro não tiver.
    const nomeCadastro = descricaoDe(company, p0.omie_codigo);
    const p = { ...p0, categoria_nome: normalizarDescricao(nomeCadastro) != null ? nomeCadastro! : (p0.categoria_nome ?? '') };
    const candidatos = byCodigo.get(p.omie_codigo)?.filter(m => m.company !== company && sugerivelPara(m.dre_linha, company)) ?? [];
    const top = decidirSugestaoCruzada(p.categoria_nome, candidatos, p.omie_codigo, descricaoDe) as { dre_linha: DreLinha; company: string } | null;
    if (top) {
      return {
        ...p,
        sugestao: {
          linha_dre: top.dre_linha,
          confianca: 'alta',
          razao: `Empresa ${top.company} mapeou a mesma categoria (código e descrição) como ${top.dre_linha}`,
        },
      };
    }
    for (const [rx, linha] of KEYWORDS) {
      if (rx.test(p.categoria_nome)) {
        return {
          ...p,
          sugestao: { linha_dre: linha, confianca: 'baixa', razao: `Keyword '${rx.source}' sugere ${linha}` },
        };
      }
    }
    return {
      ...p,
      sugestao: { linha_dre: null, confianca: 'baixa', razao: 'Sem sugestão automática' },
    };
  });

  return new Response(JSON.stringify({ suggestions }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
