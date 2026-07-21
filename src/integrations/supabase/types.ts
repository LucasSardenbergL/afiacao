export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      _quarantine_omie_clientes_20260722: {
        Row: {
          created_at: string
          empresa_omie: string
          id: string
          omie_codigo_cliente: number
          omie_codigo_cliente_integracao: string | null
          omie_codigo_vendedor: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          empresa_omie?: string
          id?: string
          omie_codigo_cliente: number
          omie_codigo_cliente_integracao?: string | null
          omie_codigo_vendedor?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          empresa_omie?: string
          id?: string
          omie_codigo_cliente?: number
          omie_codigo_cliente_integracao?: string | null
          omie_codigo_vendedor?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      abc_xyz_classification: {
        Row: {
          classe_abc: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_anterior: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_efetiva: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_anterior: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_efetiva: Database["public"]["Enums"]["classe_xyz"] | null
          coeficiente_variacao: number | null
          created_at: string
          demanda_desvio_padrao: number | null
          demanda_media_mensal: number | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          id: string
          mes_referencia: string
          meses_na_classe_abc: number
          meses_na_classe_xyz: number
          percentual_valor_acumulado: number | null
          rank_pareto: number | null
          sku_codigo: string | null
          sku_codigo_omie: number
          sku_descricao: string | null
          valor_consumido_12m: number | null
        }
        Insert: {
          classe_abc?: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_anterior?: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_efetiva?: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz?: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_anterior?: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_efetiva?: Database["public"]["Enums"]["classe_xyz"] | null
          coeficiente_variacao?: number | null
          created_at?: string
          demanda_desvio_padrao?: number | null
          demanda_media_mensal?: number | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          id?: string
          mes_referencia: string
          meses_na_classe_abc?: number
          meses_na_classe_xyz?: number
          percentual_valor_acumulado?: number | null
          rank_pareto?: number | null
          sku_codigo?: string | null
          sku_codigo_omie: number
          sku_descricao?: string | null
          valor_consumido_12m?: number | null
        }
        Update: {
          classe_abc?: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_anterior?: Database["public"]["Enums"]["classe_abc"] | null
          classe_abc_efetiva?: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz?: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_anterior?: Database["public"]["Enums"]["classe_xyz"] | null
          classe_xyz_efetiva?: Database["public"]["Enums"]["classe_xyz"] | null
          coeficiente_variacao?: number | null
          created_at?: string
          demanda_desvio_padrao?: number | null
          demanda_media_mensal?: number | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          id?: string
          mes_referencia?: string
          meses_na_classe_abc?: number
          meses_na_classe_xyz?: number
          percentual_valor_acumulado?: number | null
          rank_pareto?: number | null
          sku_codigo?: string | null
          sku_codigo_omie?: number
          sku_descricao?: string | null
          valor_consumido_12m?: number | null
        }
        Relationships: []
      }
      acoes_execucoes: {
        Row: {
          acao: string
          detalhes: Json | null
          executado_por: string | null
          executado_por_nome: string | null
          finalizado_em: string | null
          id: string
          iniciado_em: string
          origem: string
          status: string
        }
        Insert: {
          acao: string
          detalhes?: Json | null
          executado_por?: string | null
          executado_por_nome?: string | null
          finalizado_em?: string | null
          id?: string
          iniciado_em?: string
          origem?: string
          status?: string
        }
        Update: {
          acao?: string
          detalhes?: Json | null
          executado_por?: string | null
          executado_por_nome?: string | null
          finalizado_em?: string | null
          id?: string
          iniciado_em?: string
          origem?: string
          status?: string
        }
        Relationships: []
      }
      addresses: {
        Row: {
          city: string
          complement: string | null
          created_at: string
          id: string
          is_default: boolean
          is_from_omie: boolean
          label: string
          neighborhood: string
          number: string
          state: string
          street: string
          user_id: string
          zip_code: string
        }
        Insert: {
          city: string
          complement?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          is_from_omie?: boolean
          label: string
          neighborhood: string
          number: string
          state: string
          street: string
          user_id: string
          zip_code: string
        }
        Update: {
          city?: string
          complement?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          is_from_omie?: boolean
          label?: string
          neighborhood?: string
          number?: string
          state?: string
          street?: string
          user_id?: string
          zip_code?: string
        }
        Relationships: []
      }
      afiacao_os_sync_fila: {
        Row: {
          atualizado_em: string
          criado_em: string
          etapa_alvo: string
          next_retry_em: string
          order_id: string
          status_app: string
          tentativas: number
        }
        Insert: {
          atualizado_em?: string
          criado_em?: string
          etapa_alvo: string
          next_retry_em?: string
          order_id: string
          status_app: string
          tentativas?: number
        }
        Update: {
          atualizado_em?: string
          criado_em?: string
          etapa_alvo?: string
          next_retry_em?: string
          order_id?: string
          status_app?: string
          tentativas?: number
        }
        Relationships: []
      }
      ai_decision_audit_log: {
        Row: {
          action: string
          created_at: string
          data_snapshot: Json | null
          decision_id: string | null
          id: string
          notes: string | null
          performed_by: string | null
        }
        Insert: {
          action: string
          created_at?: string
          data_snapshot?: Json | null
          decision_id?: string | null
          id?: string
          notes?: string | null
          performed_by?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          data_snapshot?: Json | null
          decision_id?: string | null
          id?: string
          notes?: string | null
          performed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_decision_audit_log_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "ai_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_decisions: {
        Row: {
          confidence: string
          confidence_value: number | null
          created_at: string
          customer_metrics: Json | null
          customer_user_id: string
          decision_type: string
          evidences: Json | null
          executed_at: string | null
          explanation: string | null
          farmer_id: string | null
          id: string
          primary_reason: string | null
          score_final: number
          status: string
          suggested_action: string | null
          updated_at: string
        }
        Insert: {
          confidence?: string
          confidence_value?: number | null
          created_at?: string
          customer_metrics?: Json | null
          customer_user_id: string
          decision_type?: string
          evidences?: Json | null
          executed_at?: string | null
          explanation?: string | null
          farmer_id?: string | null
          id?: string
          primary_reason?: string | null
          score_final?: number
          status?: string
          suggested_action?: string | null
          updated_at?: string
        }
        Update: {
          confidence?: string
          confidence_value?: number | null
          created_at?: string
          customer_metrics?: Json | null
          customer_user_id?: string
          decision_type?: string
          evidences?: Json | null
          executed_at?: string | null
          explanation?: string | null
          farmer_id?: string | null
          id?: string
          primary_reason?: string | null
          score_final?: number
          status?: string
          suggested_action?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      cache_lotes: {
        Row: {
          cache_key: string
          created_at: string
          data: Json
          expires_at: string
          id: string
        }
        Insert: {
          cache_key: string
          created_at?: string
          data: Json
          expires_at: string
          id?: string
        }
        Update: {
          cache_key?: string
          created_at?: string
          data?: Json
          expires_at?: string
          id?: string
        }
        Relationships: []
      }
      calendario_feriados: {
        Row: {
          data: string
          nome: string
          observacoes: string | null
          tipo: string
        }
        Insert: {
          data: string
          nome: string
          observacoes?: string | null
          tipo?: string
        }
        Update: {
          data?: string
          nome?: string
          observacoes?: string | null
          tipo?: string
        }
        Relationships: []
      }
      call_log: {
        Row: {
          acknowledged_at: string | null
          answered_at: string | null
          caller_id_used: string | null
          created_at: string
          customer_user_id: string | null
          direction: Database["public"]["Enums"]["call_direction"]
          display_name: string | null
          duration_seconds: number
          ended_at: string | null
          farmer_call_id: string | null
          farmer_id: string
          id: string
          last_synced_at: string | null
          match_confidence: string | null
          matched_contact_id: string | null
          phone_normalized: string | null
          phone_raw: string | null
          provider: string
          provider_call_id: string | null
          recorded: boolean
          sip_call_id: string | null
          source: string
          source_payload: Json | null
          started_at: string
          status: Database["public"]["Enums"]["call_status"]
        }
        Insert: {
          acknowledged_at?: string | null
          answered_at?: string | null
          caller_id_used?: string | null
          created_at?: string
          customer_user_id?: string | null
          direction: Database["public"]["Enums"]["call_direction"]
          display_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          farmer_call_id?: string | null
          farmer_id: string
          id?: string
          last_synced_at?: string | null
          match_confidence?: string | null
          matched_contact_id?: string | null
          phone_normalized?: string | null
          phone_raw?: string | null
          provider: string
          provider_call_id?: string | null
          recorded?: boolean
          sip_call_id?: string | null
          source?: string
          source_payload?: Json | null
          started_at?: string
          status?: Database["public"]["Enums"]["call_status"]
        }
        Update: {
          acknowledged_at?: string | null
          answered_at?: string | null
          caller_id_used?: string | null
          created_at?: string
          customer_user_id?: string | null
          direction?: Database["public"]["Enums"]["call_direction"]
          display_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          farmer_call_id?: string | null
          farmer_id?: string
          id?: string
          last_synced_at?: string | null
          match_confidence?: string | null
          matched_contact_id?: string | null
          phone_normalized?: string | null
          phone_raw?: string | null
          provider?: string
          provider_call_id?: string | null
          recorded?: boolean
          sip_call_id?: string | null
          source?: string
          source_payload?: Json | null
          started_at?: string
          status?: Database["public"]["Enums"]["call_status"]
        }
        Relationships: [
          {
            foreignKeyName: "call_log_farmer_call_id_fkey"
            columns: ["farmer_call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      carteira_assignments: {
        Row: {
          customer_user_id: string
          eligible: boolean
          id: string
          last_synced_at: string | null
          omie_account: string | null
          omie_codigo_vendedor: number | null
          owner_user_id: string
          source: string
          updated_at: string
          valid_from: string
        }
        Insert: {
          customer_user_id: string
          eligible?: boolean
          id?: string
          last_synced_at?: string | null
          omie_account?: string | null
          omie_codigo_vendedor?: number | null
          owner_user_id: string
          source: string
          updated_at?: string
          valid_from?: string
        }
        Update: {
          customer_user_id?: string
          eligible?: boolean
          id?: string
          last_synced_at?: string | null
          omie_account?: string | null
          omie_codigo_vendedor?: number | null
          owner_user_id?: string
          source?: string
          updated_at?: string
          valid_from?: string
        }
        Relationships: []
      }
      carteira_coverage: {
        Row: {
          active: boolean
          covered_user_id: string
          covering_user_id: string
          created_at: string
          created_by: string
          id: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          covered_user_id: string
          covering_user_id: string
          created_at?: string
          created_by: string
          id?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          covered_user_id?: string
          covering_user_id?: string
          created_at?: string
          created_by?: string
          id?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: []
      }
      carteira_membership_ledger: {
        Row: {
          first_seen_at: string
          identity_state: string
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          first_seen_at: string
          identity_state?: string
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          first_seen_at?: string
          identity_state?: string
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      carteira_positivacao_snapshot: {
        Row: {
          churn_risk_at_month_start: number | null
          contacted_in_month: boolean
          created_at: string
          customer_user_id: string
          days_since_last_purchase_at_month_start: number | null
          eligible: boolean
          first_order_date_in_month: string | null
          had_order_in_month: boolean
          id: string
          mes: string
          owner_user_id: string
          revenue_month: number | null
          visited_in_month: boolean
        }
        Insert: {
          churn_risk_at_month_start?: number | null
          contacted_in_month?: boolean
          created_at?: string
          customer_user_id: string
          days_since_last_purchase_at_month_start?: number | null
          eligible: boolean
          first_order_date_in_month?: string | null
          had_order_in_month: boolean
          id?: string
          mes: string
          owner_user_id: string
          revenue_month?: number | null
          visited_in_month?: boolean
        }
        Update: {
          churn_risk_at_month_start?: number | null
          contacted_in_month?: boolean
          created_at?: string
          customer_user_id?: string
          days_since_last_purchase_at_month_start?: number | null
          eligible?: boolean
          first_order_date_in_month?: string | null
          had_order_in_month?: boolean
          id?: string
          mes?: string
          owner_user_id?: string
          revenue_month?: number | null
          visited_in_month?: boolean
        }
        Relationships: []
      }
      categoria_aumento_familia_mapeamento: {
        Row: {
          aumento_item_id: number
          criado_em: string | null
          familia_omie: string
          id: number
          sku_codigo_omie_especifico: number | null
        }
        Insert: {
          aumento_item_id: number
          criado_em?: string | null
          familia_omie: string
          id?: number
          sku_codigo_omie_especifico?: number | null
        }
        Update: {
          aumento_item_id?: number
          criado_em?: string | null
          familia_omie?: string
          id?: number
          sku_codigo_omie_especifico?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "categoria_aumento_familia_mapeamento_aumento_item_id_fkey"
            columns: ["aumento_item_id"]
            isOneToOne: false
            referencedRelation: "fornecedor_aumento_item"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categoria_aumento_familia_mapeamento_aumento_item_id_fkey"
            columns: ["aumento_item_id"]
            isOneToOne: false
            referencedRelation: "v_sku_aumento_vigente"
            referencedColumns: ["aumento_item_id"]
          },
        ]
      }
      category_mappings: {
        Row: {
          id: string
          order_category: string
          tool_category_id: string | null
        }
        Insert: {
          id?: string
          order_category: string
          tool_category_id?: string | null
        }
        Update: {
          id?: string
          order_category?: string
          tool_category_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "category_mappings_tool_category_id_fkey"
            columns: ["tool_category_id"]
            isOneToOne: false
            referencedRelation: "tool_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      cep_geo: {
        Row: {
          cep: string
          confidence: number | null
          lat: number
          lng: number
          municipio_codigo: string | null
          precision: string
          raw: Json | null
          source: string
          uf: string | null
          updated_at: string
        }
        Insert: {
          cep: string
          confidence?: number | null
          lat: number
          lng: number
          municipio_codigo?: string | null
          precision: string
          raw?: Json | null
          source: string
          uf?: string | null
          updated_at?: string
        }
        Update: {
          cep?: string
          confidence?: number | null
          lat?: number
          lng?: number
          municipio_codigo?: string | null
          precision?: string
          raw?: Json | null
          source?: string
          uf?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      cliente_classificacao: {
        Row: {
          excluir_da_carteira: boolean
          is_fornecedor: boolean
          tags_omie: string[]
          tags_synced_at: string | null
          tem_venda_real: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          excluir_da_carteira?: boolean
          is_fornecedor?: boolean
          tags_omie?: string[]
          tags_synced_at?: string | null
          tem_venda_real?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          excluir_da_carteira?: boolean
          is_fornecedor?: boolean
          tags_omie?: string[]
          tags_synced_at?: string | null
          tem_venda_real?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      cliente_grupo_membros: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          documento: string
          grupo_id: string
          id: string
          note: string | null
          relation_type: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          documento: string
          grupo_id: string
          id?: string
          note?: string | null
          relation_type?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          documento?: string
          grupo_id?: string
          id?: string
          note?: string | null
          relation_type?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "cliente_grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "v_grupo_contas_receber"
            referencedColumns: ["grupo_id"]
          },
        ]
      }
      cliente_grupos: {
        Row: {
          ativo: boolean
          created_at: string
          created_by: string | null
          id: string
          nome: string
          notas: string | null
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          nome: string
          notas?: string | null
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string
          notas?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      cliente_item_mapa: {
        Row: {
          cliente_ref: string
          codigo_item_cliente: string
          created_at: string
          id: string
          omie_product_id: string
          ultimo_preco: number | null
          updated_at: string
        }
        Insert: {
          cliente_ref?: string
          codigo_item_cliente: string
          created_at?: string
          id?: string
          omie_product_id: string
          ultimo_preco?: number | null
          updated_at?: string
        }
        Update: {
          cliente_ref?: string
          codigo_item_cliente?: string
          created_at?: string
          id?: string
          omie_product_id?: string
          ultimo_preco?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cliente_item_mapa_omie_product_id_fkey"
            columns: ["omie_product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      cliente_tier_preco: {
        Row: {
          company: string
          customer_user_id: string
          definido_por: string
          motivo: string | null
          tier: string
          updated_at: string
        }
        Insert: {
          company: string
          customer_user_id: string
          definido_por: string
          motivo?: string | null
          tier: string
          updated_at?: string
        }
        Update: {
          company?: string
          customer_user_id?: string
          definido_por?: string
          motivo?: string | null
          tier?: string
          updated_at?: string
        }
        Relationships: []
      }
      cliente_tier_preco_log: {
        Row: {
          company: string
          customer_user_id: string
          id: string
          motivo: string | null
          mudado_em: string
          mudado_por: string | null
          tier_de: string | null
          tier_para: string | null
        }
        Insert: {
          company: string
          customer_user_id: string
          id?: string
          motivo?: string | null
          mudado_em?: string
          mudado_por?: string | null
          tier_de?: string | null
          tier_para?: string | null
        }
        Update: {
          company?: string
          customer_user_id?: string
          id?: string
          motivo?: string | null
          mudado_em?: string
          mudado_por?: string | null
          tier_de?: string | null
          tier_para?: string | null
        }
        Relationships: []
      }
      cmc_ledger: {
        Row: {
          account: string
          cmc_anterior: number | null
          cmc_novo: number
          id: string
          observed_at: string
          omie_codigo_produto: number
          saldo: number | null
          synced_at: string | null
        }
        Insert: {
          account: string
          cmc_anterior?: number | null
          cmc_novo: number
          id?: string
          observed_at?: string
          omie_codigo_produto: number
          saldo?: number | null
          synced_at?: string | null
        }
        Update: {
          account?: string
          cmc_anterior?: number | null
          cmc_novo?: number
          id?: string
          observed_at?: string
          omie_codigo_produto?: number
          saldo?: number | null
          synced_at?: string | null
        }
        Relationships: []
      }
      cmc_snapshot: {
        Row: {
          account: string
          cmc: number
          data_posicao: string
          id: string
          omie_codigo_produto: number
          synced_at: string
        }
        Insert: {
          account: string
          cmc: number
          data_posicao: string
          id?: string
          omie_codigo_produto: number
          synced_at?: string
        }
        Update: {
          account?: string
          cmc?: number
          data_posicao?: string
          id?: string
          omie_codigo_produto?: number
          synced_at?: string
        }
        Relationships: []
      }
      cockpit_audit_log: {
        Row: {
          action: string
          created_at: string
          id: string
          metadata: Json | null
          result: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          metadata?: Json | null
          result: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          result?: string
          user_id?: string | null
        }
        Relationships: []
      }
      commercial_roles: {
        Row: {
          assigned_by: string | null
          commercial_role: Database["public"]["Enums"]["commercial_role"]
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          commercial_role?: Database["public"]["Enums"]["commercial_role"]
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          commercial_role?: Database["public"]["Enums"]["commercial_role"]
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      company_cnpjs: {
        Row: {
          cnpj: string
          cnpj_normalized: string | null
          company: string
          nome_fantasia: string | null
          updated_at: string | null
        }
        Insert: {
          cnpj: string
          cnpj_normalized?: string | null
          company: string
          nome_fantasia?: string | null
          updated_at?: string | null
        }
        Update: {
          cnpj?: string
          cnpj_normalized?: string | null
          company?: string
          nome_fantasia?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      company_config: {
        Row: {
          created_at: string
          id: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      company_profiles: {
        Row: {
          account: string
          address: string | null
          cnpj: string
          created_at: string
          data_fundacao: string | null
          id: string
          legal_name: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          account: string
          address?: string | null
          cnpj: string
          created_at?: string
          data_fundacao?: string | null
          id?: string
          legal_name: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          address?: string | null
          cnpj?: string
          created_at?: string
          data_fundacao?: string | null
          id?: string
          legal_name?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      conversao_unidades: {
        Row: {
          cnpj_fornecedor: string
          codigo_produto_fornecedor: string
          created_at: string
          descricao_produto: string | null
          fator_conversao: number
          id: string
          is_active: boolean
          unidade_destino: string
          unidade_origem: string
          updated_at: string
        }
        Insert: {
          cnpj_fornecedor: string
          codigo_produto_fornecedor: string
          created_at?: string
          descricao_produto?: string | null
          fator_conversao: number
          id?: string
          is_active?: boolean
          unidade_destino: string
          unidade_origem: string
          updated_at?: string
        }
        Update: {
          cnpj_fornecedor?: string
          codigo_produto_fornecedor?: string
          created_at?: string
          descricao_produto?: string | null
          fator_conversao?: number
          id?: string
          is_active?: boolean
          unidade_destino?: string
          unidade_origem?: string
          updated_at?: string
        }
        Relationships: []
      }
      cte_associados: {
        Row: {
          chave_acesso_cte: string
          cnpj_transportadora: string | null
          created_at: string
          id: string
          nfe_recebimento_id: string
          numero_cte: string | null
          omie_cte_id: number | null
          razao_social_transportadora: string | null
          status: string
          valor_frete: number | null
          xml_cte: string | null
        }
        Insert: {
          chave_acesso_cte: string
          cnpj_transportadora?: string | null
          created_at?: string
          id?: string
          nfe_recebimento_id: string
          numero_cte?: string | null
          omie_cte_id?: number | null
          razao_social_transportadora?: string | null
          status?: string
          valor_frete?: number | null
          xml_cte?: string | null
        }
        Update: {
          chave_acesso_cte?: string
          cnpj_transportadora?: string | null
          created_at?: string
          id?: string
          nfe_recebimento_id?: string
          numero_cte?: string | null
          omie_cte_id?: number | null
          razao_social_transportadora?: string | null
          status?: string
          valor_frete?: number | null
          xml_cte?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cte_associados_nfe_recebimento_id_fkey"
            columns: ["nfe_recebimento_id"]
            isOneToOne: false
            referencedRelation: "nfe_recebimentos"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_canonical_alias: {
        Row: {
          alias_conta: string | null
          alias_omie_codigo: number | null
          alias_user_id: string
          batch_id: string | null
          canonical_conta: string | null
          canonical_omie_codigo: number | null
          canonical_user_id: string
          created_at: string
          documento: string | null
          reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          alias_conta?: string | null
          alias_omie_codigo?: number | null
          alias_user_id: string
          batch_id?: string | null
          canonical_conta?: string | null
          canonical_omie_codigo?: number | null
          canonical_user_id: string
          created_at?: string
          documento?: string | null
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          alias_conta?: string | null
          alias_omie_codigo?: number | null
          alias_user_id?: string
          batch_id?: string | null
          canonical_conta?: string | null
          canonical_omie_codigo?: number | null
          canonical_user_id?: string
          created_at?: string
          documento?: string | null
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      customer_contacts: {
        Row: {
          birthday: string | null
          cargo: string | null
          created_at: string
          created_by: string | null
          customer_user_id: string
          email: string | null
          id: string
          is_decision_maker: boolean
          is_primary: boolean
          nome: string | null
          notas: string | null
          phone: string
          source: string | null
          updated_at: string
          whatsapp_only: boolean
        }
        Insert: {
          birthday?: string | null
          cargo?: string | null
          created_at?: string
          created_by?: string | null
          customer_user_id: string
          email?: string | null
          id?: string
          is_decision_maker?: boolean
          is_primary?: boolean
          nome?: string | null
          notas?: string | null
          phone: string
          source?: string | null
          updated_at?: string
          whatsapp_only?: boolean
        }
        Update: {
          birthday?: string | null
          cargo?: string | null
          created_at?: string
          created_by?: string | null
          customer_user_id?: string
          email?: string | null
          id?: string
          is_decision_maker?: boolean
          is_primary?: boolean
          nome?: string | null
          notas?: string | null
          phone?: string
          source?: string | null
          updated_at?: string
          whatsapp_only?: boolean
        }
        Relationships: []
      }
      customer_preferred_items: {
        Row: {
          account: string
          added_manually: boolean | null
          created_at: string
          familia: string | null
          id: string
          last_ordered_at: string | null
          omie_codigo_cliente: number
          omie_codigo_produto: number
          order_count: number | null
          product_codigo: string | null
          product_descricao: string | null
          updated_at: string
        }
        Insert: {
          account?: string
          added_manually?: boolean | null
          created_at?: string
          familia?: string | null
          id?: string
          last_ordered_at?: string | null
          omie_codigo_cliente: number
          omie_codigo_produto: number
          order_count?: number | null
          product_codigo?: string | null
          product_descricao?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          added_manually?: boolean | null
          created_at?: string
          familia?: string | null
          id?: string
          last_ordered_at?: string | null
          omie_codigo_cliente?: number
          omie_codigo_produto?: number
          order_count?: number | null
          product_codigo?: string | null
          product_descricao?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      customer_processes: {
        Row: {
          created_at: string
          created_by: string
          customer_user_id: string
          descricao_livre: string
          etapas: Json | null
          ia_confidence: number | null
          ia_gaps: string[] | null
          ia_structured_at: string | null
          id: string
          is_current: boolean
          parent_id: string | null
          porte: string | null
          segmento: string | null
          tags: string[] | null
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by: string
          customer_user_id: string
          descricao_livre: string
          etapas?: Json | null
          ia_confidence?: number | null
          ia_gaps?: string[] | null
          ia_structured_at?: string | null
          id?: string
          is_current?: boolean
          parent_id?: string | null
          porte?: string | null
          segmento?: string | null
          tags?: string[] | null
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          customer_user_id?: string
          descricao_livre?: string
          etapas?: Json | null
          ia_confidence?: number | null
          ia_gaps?: string[] | null
          ia_structured_at?: string | null
          id?: string
          is_current?: boolean
          parent_id?: string | null
          porte?: string | null
          segmento?: string | null
          tags?: string[] | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "customer_processes_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "customer_processes"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_segments: {
        Row: {
          account: string
          atividade: string | null
          created_at: string
          id: string
          omie_codigo_cliente: number
          segment: string | null
          tags: string[] | null
          updated_at: string
        }
        Insert: {
          account?: string
          atividade?: string | null
          created_at?: string
          id?: string
          omie_codigo_cliente: number
          segment?: string | null
          tags?: string[] | null
          updated_at?: string
        }
        Update: {
          account?: string
          atividade?: string | null
          created_at?: string
          id?: string
          omie_codigo_cliente?: number
          segment?: string | null
          tags?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      customer_visit_scores: {
        Row: {
          calculated_at: string
          city: string | null
          city_norm: string | null
          customer_user_id: string
          days_since_last_visit: number | null
          expansao_score: number | null
          farmer_id: string
          id: string
          last_visit_at: string | null
          neighborhood: string | null
          primary_mission: Database["public"]["Enums"]["visit_mission"] | null
          prospeccao_score: number | null
          recuperacao_score: number | null
          relacionamento_score: number | null
          score_breakdown: Json | null
          state: string | null
          updated_at: string
          visit_score: number | null
        }
        Insert: {
          calculated_at?: string
          city?: string | null
          city_norm?: string | null
          customer_user_id: string
          days_since_last_visit?: number | null
          expansao_score?: number | null
          farmer_id: string
          id?: string
          last_visit_at?: string | null
          neighborhood?: string | null
          primary_mission?: Database["public"]["Enums"]["visit_mission"] | null
          prospeccao_score?: number | null
          recuperacao_score?: number | null
          relacionamento_score?: number | null
          score_breakdown?: Json | null
          state?: string | null
          updated_at?: string
          visit_score?: number | null
        }
        Update: {
          calculated_at?: string
          city?: string | null
          city_norm?: string | null
          customer_user_id?: string
          days_since_last_visit?: number | null
          expansao_score?: number | null
          farmer_id?: string
          id?: string
          last_visit_at?: string | null
          neighborhood?: string | null
          primary_mission?: Database["public"]["Enums"]["visit_mission"] | null
          prospeccao_score?: number | null
          recuperacao_score?: number | null
          relacionamento_score?: number | null
          score_breakdown?: Json | null
          state?: string | null
          updated_at?: string
          visit_score?: number | null
        }
        Relationships: []
      }
      dashboard_visits: {
        Row: {
          company_selection: string | null
          id: number
          persona: string | null
          session_minutes: number | null
          user_id: string
          visited_at: string
        }
        Insert: {
          company_selection?: string | null
          id?: number
          persona?: string | null
          session_minutes?: number | null
          user_id: string
          visited_at?: string
        }
        Update: {
          company_selection?: string | null
          id?: number
          persona?: string | null
          session_minutes?: number | null
          user_id?: string
          visited_at?: string
        }
        Relationships: []
      }
      default_prices: {
        Row: {
          created_at: string
          description: string | null
          id: string
          price: number
          spec_filter: Json
          tool_category_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          price: number
          spec_filter?: Json
          tool_category_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          price?: number
          spec_filter?: Json
          tool_category_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "default_prices_tool_category_id_fkey"
            columns: ["tool_category_id"]
            isOneToOne: false
            referencedRelation: "tool_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      des_checkin_qualitativo: {
        Row: {
          ano: number
          atualizado_em: string | null
          avaliado_com: string | null
          avaliado_por: string | null
          criado_em: string | null
          data_avaliacao: string
          empresa: string
          id: number
          observacoes_gerais: string | null
          tipo: string
          trimestre: number
        }
        Insert: {
          ano: number
          atualizado_em?: string | null
          avaliado_com?: string | null
          avaliado_por?: string | null
          criado_em?: string | null
          data_avaliacao: string
          empresa: string
          id?: number
          observacoes_gerais?: string | null
          tipo?: string
          trimestre: number
        }
        Update: {
          ano?: number
          atualizado_em?: string | null
          avaliado_com?: string | null
          avaliado_por?: string | null
          criado_em?: string | null
          data_avaliacao?: string
          empresa?: string
          id?: number
          observacoes_gerais?: string | null
          tipo?: string
          trimestre?: number
        }
        Relationships: []
      }
      des_checkin_qualitativo_resposta: {
        Row: {
          atingido: boolean
          checkin_id: number
          criado_em: string | null
          criterio_id: number
          id: number
          observacao: string | null
        }
        Insert: {
          atingido?: boolean
          checkin_id: number
          criado_em?: string | null
          criterio_id: number
          id?: number
          observacao?: string | null
        }
        Update: {
          atingido?: boolean
          checkin_id?: number
          criado_em?: string | null
          criterio_id?: number
          id?: number
          observacao?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "des_checkin_qualitativo_resposta_checkin_id_fkey"
            columns: ["checkin_id"]
            isOneToOne: false
            referencedRelation: "des_checkin_qualitativo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "des_checkin_qualitativo_resposta_checkin_id_fkey"
            columns: ["checkin_id"]
            isOneToOne: false
            referencedRelation: "v_des_checkin_atual"
            referencedColumns: ["checkin_id"]
          },
          {
            foreignKeyName: "des_checkin_qualitativo_resposta_checkin_id_fkey"
            columns: ["checkin_id"]
            isOneToOne: false
            referencedRelation: "v_des_desconto_por_checkin"
            referencedColumns: ["checkin_id"]
          },
          {
            foreignKeyName: "des_checkin_qualitativo_resposta_criterio_id_fkey"
            columns: ["criterio_id"]
            isOneToOne: false
            referencedRelation: "des_criterio_qualitativo"
            referencedColumns: ["id"]
          },
        ]
      }
      des_contrato_versao: {
        Row: {
          criado_em: string | null
          data_fim_vigencia: string | null
          data_inicio_vigencia: string
          id: number
          observacoes: string | null
          versao: string
        }
        Insert: {
          criado_em?: string | null
          data_fim_vigencia?: string | null
          data_inicio_vigencia: string
          id?: number
          observacoes?: string | null
          versao: string
        }
        Update: {
          criado_em?: string | null
          data_fim_vigencia?: string | null
          data_inicio_vigencia?: string
          id?: number
          observacoes?: string | null
          versao?: string
        }
        Relationships: []
      }
      des_criterio_percentual: {
        Row: {
          criado_em: string | null
          criterio_id: number
          faixa_id: number
          id: number
          percentual: number
        }
        Insert: {
          criado_em?: string | null
          criterio_id: number
          faixa_id: number
          id?: number
          percentual: number
        }
        Update: {
          criado_em?: string | null
          criterio_id?: number
          faixa_id?: number
          id?: number
          percentual?: number
        }
        Relationships: [
          {
            foreignKeyName: "des_criterio_percentual_criterio_id_fkey"
            columns: ["criterio_id"]
            isOneToOne: false
            referencedRelation: "des_criterio_qualitativo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "des_criterio_percentual_faixa_id_fkey"
            columns: ["faixa_id"]
            isOneToOne: false
            referencedRelation: "des_faixa_quantitativa"
            referencedColumns: ["id"]
          },
        ]
      }
      des_criterio_qualitativo: {
        Row: {
          codigo: string
          contrato_versao_id: number
          criado_em: string | null
          descricao: string | null
          id: number
          nome: string
          ordem: number
          tipo: string
        }
        Insert: {
          codigo: string
          contrato_versao_id: number
          criado_em?: string | null
          descricao?: string | null
          id?: number
          nome: string
          ordem: number
          tipo: string
        }
        Update: {
          codigo?: string
          contrato_versao_id?: number
          criado_em?: string | null
          descricao?: string | null
          id?: number
          nome?: string
          ordem?: number
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "des_criterio_qualitativo_contrato_versao_id_fkey"
            columns: ["contrato_versao_id"]
            isOneToOne: false
            referencedRelation: "des_contrato_versao"
            referencedColumns: ["id"]
          },
        ]
      }
      des_faixa_quantitativa: {
        Row: {
          contrato_versao_id: number
          criado_em: string | null
          desconto_padrao_perc: number
          estrelas: number
          faixa_numero: number
          id: number
          observacoes: string | null
          volume_max: number | null
          volume_min: number
        }
        Insert: {
          contrato_versao_id: number
          criado_em?: string | null
          desconto_padrao_perc: number
          estrelas: number
          faixa_numero: number
          id?: number
          observacoes?: string | null
          volume_max?: number | null
          volume_min: number
        }
        Update: {
          contrato_versao_id?: number
          criado_em?: string | null
          desconto_padrao_perc?: number
          estrelas?: number
          faixa_numero?: number
          id?: number
          observacoes?: string | null
          volume_max?: number | null
          volume_min?: number
        }
        Relationships: [
          {
            foreignKeyName: "des_faixa_quantitativa_contrato_versao_id_fkey"
            columns: ["contrato_versao_id"]
            isOneToOne: false
            referencedRelation: "des_contrato_versao"
            referencedColumns: ["id"]
          },
        ]
      }
      des_meta_empresa: {
        Row: {
          ano: number
          atualizado_em: string | null
          criado_em: string | null
          empresa: string
          faixa_des_objetivo: number | null
          id: number
          meta_faturamento: number
          observacoes: string | null
          trimestre: number
        }
        Insert: {
          ano: number
          atualizado_em?: string | null
          criado_em?: string | null
          empresa: string
          faixa_des_objetivo?: number | null
          id?: number
          meta_faturamento: number
          observacoes?: string | null
          trimestre: number
        }
        Update: {
          ano?: number
          atualizado_em?: string | null
          criado_em?: string | null
          empresa?: string
          faixa_des_objetivo?: number | null
          id?: number
          meta_faturamento?: number
          observacoes?: string | null
          trimestre?: number
        }
        Relationships: []
      }
      des_trimestre_snapshot: {
        Row: {
          ano: number
          criado_em: string | null
          data_envio_email: string | null
          data_referencia: string
          empresa: string
          extracao_confianca: number | null
          fat_bruto_qtde: number | null
          fat_bruto_valor: number
          id: number
          laminas_m2: number | null
          nd_fat_tot_perc: number | null
          nd_fat_tot_valor: number | null
          objetivo_qtde: number | null
          objetivo_valor: number
          origem_arquivo_url: string | null
          pedidos_abertos_qtde: number | null
          pedidos_abertos_valor: number | null
          perc_atingimento_qtde: number | null
          perc_atingimento_valor: number | null
          preco_medio_trimestre: number | null
          tingimix_qtde: number | null
          trimestre: number
        }
        Insert: {
          ano: number
          criado_em?: string | null
          data_envio_email?: string | null
          data_referencia: string
          empresa: string
          extracao_confianca?: number | null
          fat_bruto_qtde?: number | null
          fat_bruto_valor: number
          id?: number
          laminas_m2?: number | null
          nd_fat_tot_perc?: number | null
          nd_fat_tot_valor?: number | null
          objetivo_qtde?: number | null
          objetivo_valor: number
          origem_arquivo_url?: string | null
          pedidos_abertos_qtde?: number | null
          pedidos_abertos_valor?: number | null
          perc_atingimento_qtde?: number | null
          perc_atingimento_valor?: number | null
          preco_medio_trimestre?: number | null
          tingimix_qtde?: number | null
          trimestre: number
        }
        Update: {
          ano?: number
          criado_em?: string | null
          data_envio_email?: string | null
          data_referencia?: string
          empresa?: string
          extracao_confianca?: number | null
          fat_bruto_qtde?: number | null
          fat_bruto_valor?: number
          id?: number
          laminas_m2?: number | null
          nd_fat_tot_perc?: number | null
          nd_fat_tot_valor?: number | null
          objetivo_qtde?: number | null
          objetivo_valor?: number
          origem_arquivo_url?: string | null
          pedidos_abertos_qtde?: number | null
          pedidos_abertos_valor?: number | null
          perc_atingimento_qtde?: number | null
          perc_atingimento_valor?: number | null
          preco_medio_trimestre?: number | null
          tingimix_qtde?: number | null
          trimestre?: number
        }
        Relationships: []
      }
      empresa_configuracao_custos: {
        Row: {
          armazenagem_fisica: number
          atualizado_em: string | null
          atualizado_por: string | null
          custo_pedido_api: number
          custo_pedido_manual: number
          email_notificacoes: string | null
          empresa: string
          haircut_fallback_preco: number
          modo_disparo_pedidos: string | null
          modo_pedido: string
          observacoes: string | null
          selic_anual: number
          spread_oportunidade: number
          z_classe_a: number
          z_classe_b: number
          z_classe_c: number
        }
        Insert: {
          armazenagem_fisica: number
          atualizado_em?: string | null
          atualizado_por?: string | null
          custo_pedido_api: number
          custo_pedido_manual: number
          email_notificacoes?: string | null
          empresa: string
          haircut_fallback_preco?: number
          modo_disparo_pedidos?: string | null
          modo_pedido?: string
          observacoes?: string | null
          selic_anual: number
          spread_oportunidade: number
          z_classe_a?: number
          z_classe_b?: number
          z_classe_c?: number
        }
        Update: {
          armazenagem_fisica?: number
          atualizado_em?: string | null
          atualizado_por?: string | null
          custo_pedido_api?: number
          custo_pedido_manual?: number
          email_notificacoes?: string | null
          empresa?: string
          haircut_fallback_preco?: number
          modo_disparo_pedidos?: string | null
          modo_pedido?: string
          observacoes?: string | null
          selic_anual?: number
          spread_oportunidade?: number
          z_classe_a?: number
          z_classe_b?: number
          z_classe_c?: number
        }
        Relationships: []
      }
      eventos_outlier: {
        Row: {
          data_evento: string
          decidido_em: string | null
          decidido_por: string | null
          desvios_padrao: number | null
          detalhes: Json | null
          detectado_em: string | null
          empresa: string
          id: number
          justificativa_decisao: string | null
          severidade: string
          sku_codigo_omie: string
          sku_descricao: string | null
          status: string
          tipo: string
          valor_esperado: number | null
          valor_observado: number | null
        }
        Insert: {
          data_evento: string
          decidido_em?: string | null
          decidido_por?: string | null
          desvios_padrao?: number | null
          detalhes?: Json | null
          detectado_em?: string | null
          empresa: string
          id?: number
          justificativa_decisao?: string | null
          severidade: string
          sku_codigo_omie: string
          sku_descricao?: string | null
          status?: string
          tipo: string
          valor_esperado?: number | null
          valor_observado?: number | null
        }
        Update: {
          data_evento?: string
          decidido_em?: string | null
          decidido_por?: string | null
          desvios_padrao?: number | null
          detalhes?: Json | null
          detectado_em?: string | null
          empresa?: string
          id?: number
          justificativa_decisao?: string | null
          severidade?: string
          sku_codigo_omie?: string
          sku_descricao?: string | null
          status?: string
          tipo?: string
          valor_esperado?: number | null
          valor_observado?: number | null
        }
        Relationships: []
      }
      familia_nao_comprada: {
        Row: {
          criado_em: string | null
          empresa: string
          familia: string
          id: number
          motivo: string
          observacoes: string | null
        }
        Insert: {
          criado_em?: string | null
          empresa: string
          familia: string
          id?: number
          motivo: string
          observacoes?: string | null
        }
        Update: {
          criado_em?: string | null
          empresa?: string
          familia?: string
          id?: number
          motivo?: string
          observacoes?: string | null
        }
        Relationships: []
      }
      farmer_agenda: {
        Row: {
          agenda_date: string
          agenda_type: string
          call_id: string | null
          completed_at: string | null
          created_at: string | null
          customer_user_id: string
          farmer_id: string
          id: string
          priority_score: number | null
          status: string | null
        }
        Insert: {
          agenda_date?: string
          agenda_type?: string
          call_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          customer_user_id: string
          farmer_id: string
          id?: string
          priority_score?: number | null
          status?: string | null
        }
        Update: {
          agenda_date?: string
          agenda_type?: string
          call_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          customer_user_id?: string
          farmer_id?: string
          id?: string
          priority_score?: number | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_agenda_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_algorithm_config: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string | null
          value: number
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          value: number
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          value?: number
        }
        Relationships: []
      }
      farmer_association_rules: {
        Row: {
          antecedent_product_ids: string[]
          cluster_segment: string | null
          confidence: number
          consequent_product_ids: string[]
          created_at: string | null
          id: string
          lift: number
          rule_type: string
          sample_size: number | null
          support: number
          updated_at: string | null
        }
        Insert: {
          antecedent_product_ids: string[]
          cluster_segment?: string | null
          confidence?: number
          consequent_product_ids: string[]
          created_at?: string | null
          id?: string
          lift?: number
          rule_type?: string
          sample_size?: number | null
          support?: number
          updated_at?: string | null
        }
        Update: {
          antecedent_product_ids?: string[]
          cluster_segment?: string | null
          confidence?: number
          consequent_product_ids?: string[]
          created_at?: string | null
          id?: string
          lift?: number
          rule_type?: string
          sample_size?: number | null
          support?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      farmer_audit_log: {
        Row: {
          action: string
          algorithm_version: string | null
          created_at: string | null
          entity_id: string | null
          entity_type: string
          id: string
          new_params: Json | null
          notes: string | null
          performed_by: string
          previous_params: Json | null
          projection: Json | null
        }
        Insert: {
          action: string
          algorithm_version?: string | null
          created_at?: string | null
          entity_id?: string | null
          entity_type: string
          id?: string
          new_params?: Json | null
          notes?: string | null
          performed_by: string
          previous_params?: Json | null
          projection?: Json | null
        }
        Update: {
          action?: string
          algorithm_version?: string | null
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string
          id?: string
          new_params?: Json | null
          notes?: string | null
          performed_by?: string
          previous_params?: Json | null
          projection?: Json | null
        }
        Relationships: []
      }
      farmer_bundle_recommendations: {
        Row: {
          accepted_at: string | null
          accepted_products: Json | null
          actual_margin: number | null
          approach_type: string | null
          argument_effectiveness: number | null
          argument_phone: string | null
          argument_technical: string | null
          argument_whatsapp: string | null
          bundle_products: Json
          bundle_type: string
          complexity_factor: number | null
          confidence: number | null
          created_at: string | null
          customer_profile: string | null
          customer_user_id: string
          farmer_id: string
          id: string
          lie_bundle: number | null
          lift: number | null
          m_bundle: number | null
          offered_at: string | null
          p_bundle: number | null
          rejected_at: string | null
          status: string | null
          support: number | null
          time_spent_seconds: number | null
          updated_at: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_products?: Json | null
          actual_margin?: number | null
          approach_type?: string | null
          argument_effectiveness?: number | null
          argument_phone?: string | null
          argument_technical?: string | null
          argument_whatsapp?: string | null
          bundle_products?: Json
          bundle_type?: string
          complexity_factor?: number | null
          confidence?: number | null
          created_at?: string | null
          customer_profile?: string | null
          customer_user_id: string
          farmer_id: string
          id?: string
          lie_bundle?: number | null
          lift?: number | null
          m_bundle?: number | null
          offered_at?: string | null
          p_bundle?: number | null
          rejected_at?: string | null
          status?: string | null
          support?: number | null
          time_spent_seconds?: number | null
          updated_at?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_products?: Json | null
          actual_margin?: number | null
          approach_type?: string | null
          argument_effectiveness?: number | null
          argument_phone?: string | null
          argument_technical?: string | null
          argument_whatsapp?: string | null
          bundle_products?: Json
          bundle_type?: string
          complexity_factor?: number | null
          confidence?: number | null
          created_at?: string | null
          customer_profile?: string | null
          customer_user_id?: string
          farmer_id?: string
          id?: string
          lie_bundle?: number | null
          lift?: number | null
          m_bundle?: number | null
          offered_at?: string | null
          p_bundle?: number | null
          rejected_at?: string | null
          status?: string | null
          support?: number | null
          time_spent_seconds?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      farmer_calls: {
        Row: {
          analyses: Json | null
          atendimento_id: string | null
          attempt_number: number | null
          call_backend: string | null
          call_result: Database["public"]["Enums"]["farmer_call_result"]
          call_type: Database["public"]["Enums"]["farmer_call_type"]
          created_at: string
          customer_user_id: string | null
          duration_seconds: number | null
          ended_at: string | null
          entities_extracted: Json | null
          farmer_id: string
          follow_up_duration_seconds: number | null
          id: string
          is_whatsapp: boolean | null
          linked_sales_order_id: string | null
          margin_generated: number | null
          notes: string | null
          phone_dialed: string | null
          revenue_generated: number | null
          sinais_ligacao: Json | null
          started_at: string
          transcript: Json | null
          whatsapp_replied: boolean | null
        }
        Insert: {
          analyses?: Json | null
          atendimento_id?: string | null
          attempt_number?: number | null
          call_backend?: string | null
          call_result?: Database["public"]["Enums"]["farmer_call_result"]
          call_type: Database["public"]["Enums"]["farmer_call_type"]
          created_at?: string
          customer_user_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          entities_extracted?: Json | null
          farmer_id: string
          follow_up_duration_seconds?: number | null
          id?: string
          is_whatsapp?: boolean | null
          linked_sales_order_id?: string | null
          margin_generated?: number | null
          notes?: string | null
          phone_dialed?: string | null
          revenue_generated?: number | null
          sinais_ligacao?: Json | null
          started_at?: string
          transcript?: Json | null
          whatsapp_replied?: boolean | null
        }
        Update: {
          analyses?: Json | null
          atendimento_id?: string | null
          attempt_number?: number | null
          call_backend?: string | null
          call_result?: Database["public"]["Enums"]["farmer_call_result"]
          call_type?: Database["public"]["Enums"]["farmer_call_type"]
          created_at?: string
          customer_user_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          entities_extracted?: Json | null
          farmer_id?: string
          follow_up_duration_seconds?: number | null
          id?: string
          is_whatsapp?: boolean | null
          linked_sales_order_id?: string | null
          margin_generated?: number | null
          notes?: string | null
          phone_dialed?: string | null
          revenue_generated?: number | null
          sinais_ligacao?: Json | null
          started_at?: string
          transcript?: Json | null
          whatsapp_replied?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_calls_linked_sales_order_id_fkey"
            columns: ["linked_sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "farmer_calls_linked_sales_order_id_fkey"
            columns: ["linked_sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_category_conversion: {
        Row: {
          avg_margin_generated: number | null
          avg_time_spent_seconds: number | null
          category_id: string
          complexity_factor: number | null
          conversion_rate: number | null
          id: string
          profit_per_hour: number | null
          total_accepts: number | null
          total_offers: number | null
          updated_at: string | null
        }
        Insert: {
          avg_margin_generated?: number | null
          avg_time_spent_seconds?: number | null
          category_id: string
          complexity_factor?: number | null
          conversion_rate?: number | null
          id?: string
          profit_per_hour?: number | null
          total_accepts?: number | null
          total_offers?: number | null
          updated_at?: string | null
        }
        Update: {
          avg_margin_generated?: number | null
          avg_time_spent_seconds?: number | null
          category_id?: string
          complexity_factor?: number | null
          conversion_rate?: number | null
          id?: string
          profit_per_hour?: number | null
          total_accepts?: number | null
          total_offers?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      farmer_client_scores: {
        Row: {
          answer_rate_60d: number | null
          avg_monthly_spend_180d: number | null
          avg_repurchase_interval: number | null
          calculated_at: string | null
          category_count: number | null
          churn_risk: number | null
          created_at: string | null
          customer_user_id: string
          days_since_last_purchase: number | null
          eff_score: number | null
          expansion_score: number | null
          farmer_id: string
          g_score: number | null
          gross_margin_pct: number | null
          health_class: string | null
          health_score: number | null
          id: string
          last_signal_recalc_at: string | null
          m_score: number | null
          priority_score: number | null
          recover_score: number | null
          revenue_potential: number | null
          rf_score: number | null
          s_score: number | null
          sales_history_status: string | null
          signal_modifiers: Json | null
          updated_at: string | null
          whatsapp_reply_rate_60d: number | null
          x_score: number | null
        }
        Insert: {
          answer_rate_60d?: number | null
          avg_monthly_spend_180d?: number | null
          avg_repurchase_interval?: number | null
          calculated_at?: string | null
          category_count?: number | null
          churn_risk?: number | null
          created_at?: string | null
          customer_user_id: string
          days_since_last_purchase?: number | null
          eff_score?: number | null
          expansion_score?: number | null
          farmer_id: string
          g_score?: number | null
          gross_margin_pct?: number | null
          health_class?: string | null
          health_score?: number | null
          id?: string
          last_signal_recalc_at?: string | null
          m_score?: number | null
          priority_score?: number | null
          recover_score?: number | null
          revenue_potential?: number | null
          rf_score?: number | null
          s_score?: number | null
          sales_history_status?: string | null
          signal_modifiers?: Json | null
          updated_at?: string | null
          whatsapp_reply_rate_60d?: number | null
          x_score?: number | null
        }
        Update: {
          answer_rate_60d?: number | null
          avg_monthly_spend_180d?: number | null
          avg_repurchase_interval?: number | null
          calculated_at?: string | null
          category_count?: number | null
          churn_risk?: number | null
          created_at?: string | null
          customer_user_id?: string
          days_since_last_purchase?: number | null
          eff_score?: number | null
          expansion_score?: number | null
          farmer_id?: string
          g_score?: number | null
          gross_margin_pct?: number | null
          health_class?: string | null
          health_score?: number | null
          id?: string
          last_signal_recalc_at?: string | null
          m_score?: number | null
          priority_score?: number | null
          recover_score?: number | null
          revenue_potential?: number | null
          rf_score?: number | null
          s_score?: number | null
          sales_history_status?: string | null
          signal_modifiers?: Json | null
          updated_at?: string | null
          whatsapp_reply_rate_60d?: number | null
          x_score?: number | null
        }
        Relationships: []
      }
      farmer_config: {
        Row: {
          created_at: string
          farmer_id: string
          hours_friday: number
          hours_weekday: number
          id: string
          updated_at: string
          working_days_per_month: number
        }
        Insert: {
          created_at?: string
          farmer_id: string
          hours_friday?: number
          hours_weekday?: number
          id?: string
          updated_at?: string
          working_days_per_month?: number
        }
        Update: {
          created_at?: string
          farmer_id?: string
          hours_friday?: number
          hours_weekday?: number
          id?: string
          updated_at?: string
          working_days_per_month?: number
        }
        Relationships: []
      }
      farmer_copilot_events: {
        Row: {
          created_at: string | null
          event_data: Json | null
          event_type: string
          id: string
          session_id: string
          suggestion_text: string | null
          suggestion_used: boolean | null
          transcript_snippet: string | null
        }
        Insert: {
          created_at?: string | null
          event_data?: Json | null
          event_type: string
          id?: string
          session_id: string
          suggestion_text?: string | null
          suggestion_used?: boolean | null
          transcript_snippet?: string | null
        }
        Update: {
          created_at?: string | null
          event_data?: Json | null
          event_type?: string
          id?: string
          session_id?: string
          suggestion_text?: string | null
          suggestion_used?: boolean | null
          transcript_snippet?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_copilot_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "farmer_copilot_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_copilot_sessions: {
        Row: {
          bundle_recommendation_id: string | null
          call_id: string | null
          created_at: string | null
          customer_user_id: string | null
          duration_seconds: number | null
          ended_at: string | null
          farmer_id: string
          final_direction: string | null
          final_intent: string | null
          final_phase: string | null
          id: string
          margin_generated: number | null
          result: string | null
          revenue_generated: number | null
          started_at: string
          suggestions_shown: number | null
          suggestions_used: number | null
          transcript_summary: string | null
          updated_at: string | null
        }
        Insert: {
          bundle_recommendation_id?: string | null
          call_id?: string | null
          created_at?: string | null
          customer_user_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          farmer_id: string
          final_direction?: string | null
          final_intent?: string | null
          final_phase?: string | null
          id?: string
          margin_generated?: number | null
          result?: string | null
          revenue_generated?: number | null
          started_at?: string
          suggestions_shown?: number | null
          suggestions_used?: number | null
          transcript_summary?: string | null
          updated_at?: string | null
        }
        Update: {
          bundle_recommendation_id?: string | null
          call_id?: string | null
          created_at?: string | null
          customer_user_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          farmer_id?: string
          final_direction?: string | null
          final_intent?: string | null
          final_phase?: string | null
          id?: string
          margin_generated?: number | null
          result?: string | null
          revenue_generated?: number | null
          started_at?: string
          suggestions_shown?: number | null
          suggestions_used?: number | null
          transcript_summary?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_copilot_sessions_bundle_recommendation_id_fkey"
            columns: ["bundle_recommendation_id"]
            isOneToOne: false
            referencedRelation: "farmer_bundle_recommendations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "farmer_copilot_sessions_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_diagnostic_questions: {
        Row: {
          alt_question_text: string | null
          bundle_recommendation_id: string | null
          bundle_result: string | null
          created_at: string | null
          customer_profile: string | null
          customer_user_id: string
          effectiveness_score: number | null
          farmer_id: string
          id: string
          margin_generated: number | null
          question_text: string
          question_type: string
          response_notes: string | null
          response_type: string | null
          time_spent_seconds: number | null
          updated_at: string | null
          was_bundle_offered: boolean | null
        }
        Insert: {
          alt_question_text?: string | null
          bundle_recommendation_id?: string | null
          bundle_result?: string | null
          created_at?: string | null
          customer_profile?: string | null
          customer_user_id: string
          effectiveness_score?: number | null
          farmer_id: string
          id?: string
          margin_generated?: number | null
          question_text: string
          question_type: string
          response_notes?: string | null
          response_type?: string | null
          time_spent_seconds?: number | null
          updated_at?: string | null
          was_bundle_offered?: boolean | null
        }
        Update: {
          alt_question_text?: string | null
          bundle_recommendation_id?: string | null
          bundle_result?: string | null
          created_at?: string | null
          customer_profile?: string | null
          customer_user_id?: string
          effectiveness_score?: number | null
          farmer_id?: string
          id?: string
          margin_generated?: number | null
          question_text?: string
          question_type?: string
          response_notes?: string | null
          response_type?: string | null
          time_spent_seconds?: number | null
          updated_at?: string | null
          was_bundle_offered?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_diagnostic_questions_bundle_recommendation_id_fkey"
            columns: ["bundle_recommendation_id"]
            isOneToOne: false
            referencedRelation: "farmer_bundle_recommendations"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_experiment_clients: {
        Row: {
          calls_count: number | null
          created_at: string | null
          customer_user_id: string
          experiment_id: string
          group_type: string
          id: string
          margin_generated: number | null
          metric_value: number | null
          revenue_generated: number | null
          total_time_seconds: number | null
          updated_at: string | null
        }
        Insert: {
          calls_count?: number | null
          created_at?: string | null
          customer_user_id: string
          experiment_id: string
          group_type: string
          id?: string
          margin_generated?: number | null
          metric_value?: number | null
          revenue_generated?: number | null
          total_time_seconds?: number | null
          updated_at?: string | null
        }
        Update: {
          calls_count?: number | null
          created_at?: string | null
          customer_user_id?: string
          experiment_id?: string
          group_type?: string
          id?: string
          margin_generated?: number | null
          metric_value?: number | null
          revenue_generated?: number | null
          total_time_seconds?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_experiment_clients_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "farmer_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_experiments: {
        Row: {
          control_description: string | null
          control_metric_value: number | null
          created_at: string | null
          ended_at: string | null
          farmer_id: string
          hypothesis: string
          id: string
          lift_pct: number | null
          min_duration_days: number
          min_sample_size: number
          min_significance: number
          p_value: number | null
          primary_metric: string
          started_at: string | null
          status: string
          test_description: string | null
          test_metric_value: number | null
          title: string
          updated_at: string | null
          winner: string | null
        }
        Insert: {
          control_description?: string | null
          control_metric_value?: number | null
          created_at?: string | null
          ended_at?: string | null
          farmer_id: string
          hypothesis: string
          id?: string
          lift_pct?: number | null
          min_duration_days?: number
          min_sample_size?: number
          min_significance?: number
          p_value?: number | null
          primary_metric: string
          started_at?: string | null
          status?: string
          test_description?: string | null
          test_metric_value?: number | null
          title: string
          updated_at?: string | null
          winner?: string | null
        }
        Update: {
          control_description?: string | null
          control_metric_value?: number | null
          created_at?: string | null
          ended_at?: string | null
          farmer_id?: string
          hypothesis?: string
          id?: string
          lift_pct?: number | null
          min_duration_days?: number
          min_sample_size?: number
          min_significance?: number
          p_value?: number | null
          primary_metric?: string
          started_at?: string | null
          status?: string
          test_description?: string | null
          test_metric_value?: number | null
          title?: string
          updated_at?: string | null
          winner?: string | null
        }
        Relationships: []
      }
      farmer_governance_proposals: {
        Row: {
          algorithm_version: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string | null
          current_params: Json
          description: string | null
          id: string
          impact_churn_pct: number | null
          impact_margin_pct: number | null
          impact_margin_per_hour: number | null
          impact_revenue_pct: number | null
          proposal_type: string
          proposed_by: string
          proposed_params: Json
          rejection_reason: string | null
          status: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          algorithm_version?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string | null
          current_params?: Json
          description?: string | null
          id?: string
          impact_churn_pct?: number | null
          impact_margin_pct?: number | null
          impact_margin_per_hour?: number | null
          impact_revenue_pct?: number | null
          proposal_type: string
          proposed_by: string
          proposed_params?: Json
          rejection_reason?: string | null
          status?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          algorithm_version?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string | null
          current_params?: Json
          description?: string | null
          id?: string
          impact_churn_pct?: number | null
          impact_margin_pct?: number | null
          impact_margin_per_hour?: number | null
          impact_revenue_pct?: number | null
          proposal_type?: string
          proposed_by?: string
          proposed_params?: Json
          rejection_reason?: string | null
          status?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      farmer_learning_weights: {
        Row: {
          agenda_pct_expansion: number | null
          agenda_pct_recovery: number | null
          agenda_pct_risk: number | null
          created_at: string
          farmer_id: string
          id: string
          last_adjusted_at: string | null
          suggested_calls_per_day: number | null
          suggested_portfolio_size: number | null
          updated_at: string
          weight_frequency: number | null
          weight_margin: number | null
          weight_monetary: number | null
          weight_recency: number | null
        }
        Insert: {
          agenda_pct_expansion?: number | null
          agenda_pct_recovery?: number | null
          agenda_pct_risk?: number | null
          created_at?: string
          farmer_id: string
          id?: string
          last_adjusted_at?: string | null
          suggested_calls_per_day?: number | null
          suggested_portfolio_size?: number | null
          updated_at?: string
          weight_frequency?: number | null
          weight_margin?: number | null
          weight_monetary?: number | null
          weight_recency?: number | null
        }
        Update: {
          agenda_pct_expansion?: number | null
          agenda_pct_recovery?: number | null
          agenda_pct_risk?: number | null
          created_at?: string
          farmer_id?: string
          id?: string
          last_adjusted_at?: string | null
          suggested_calls_per_day?: number | null
          suggested_portfolio_size?: number | null
          updated_at?: string
          weight_frequency?: number | null
          weight_margin?: number | null
          weight_monetary?: number | null
          weight_recency?: number | null
        }
        Relationships: []
      }
      farmer_mixgap_feedback: {
        Row: {
          created_at: string
          customer_user_id: string
          familia: string
          id: string
          seller_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_user_id: string
          familia: string
          id?: string
          seller_user_id: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_user_id?: string
          familia?: string
          id?: string
          seller_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      farmer_performance_scores: {
        Row: {
          calculated_at: string
          created_at: string | null
          farmer_id: string
          id: string
          iee_bundle_offered: number | null
          iee_objective_adherence: number | null
          iee_post_call_registration: number | null
          iee_ptpl_usage: number | null
          iee_questions_usage: number | null
          iee_total: number | null
          ipf_churn_reduction: number | null
          ipf_incremental_margin: number | null
          ipf_ltv_evolution: number | null
          ipf_margin_per_hour: number | null
          ipf_mix_expansion: number | null
          ipf_total: number | null
          period_end: string
          period_start: string
          total_calls: number | null
          total_margin: number | null
          total_plans: number | null
          total_time_seconds: number | null
        }
        Insert: {
          calculated_at?: string
          created_at?: string | null
          farmer_id: string
          id?: string
          iee_bundle_offered?: number | null
          iee_objective_adherence?: number | null
          iee_post_call_registration?: number | null
          iee_ptpl_usage?: number | null
          iee_questions_usage?: number | null
          iee_total?: number | null
          ipf_churn_reduction?: number | null
          ipf_incremental_margin?: number | null
          ipf_ltv_evolution?: number | null
          ipf_margin_per_hour?: number | null
          ipf_mix_expansion?: number | null
          ipf_total?: number | null
          period_end: string
          period_start: string
          total_calls?: number | null
          total_margin?: number | null
          total_plans?: number | null
          total_time_seconds?: number | null
        }
        Update: {
          calculated_at?: string
          created_at?: string | null
          farmer_id?: string
          id?: string
          iee_bundle_offered?: number | null
          iee_objective_adherence?: number | null
          iee_post_call_registration?: number | null
          iee_ptpl_usage?: number | null
          iee_questions_usage?: number | null
          iee_total?: number | null
          ipf_churn_reduction?: number | null
          ipf_incremental_margin?: number | null
          ipf_ltv_evolution?: number | null
          ipf_margin_per_hour?: number | null
          ipf_mix_expansion?: number | null
          ipf_total?: number | null
          period_end?: string
          period_start?: string
          total_calls?: number | null
          total_margin?: number | null
          total_plans?: number | null
          total_time_seconds?: number | null
        }
        Relationships: []
      }
      farmer_recommendations: {
        Row: {
          accepted_at: string | null
          actual_margin: number | null
          cluster_volume_estimate: number | null
          complexity_factor: number | null
          created_at: string | null
          current_product_id: string | null
          customer_user_id: string
          farmer_id: string
          id: string
          lie: number | null
          m_ij: number | null
          offered_at: string | null
          p_ij: number | null
          product_id: string | null
          recommendation_type: string
          rejected_at: string | null
          status: string | null
          time_spent_seconds: number | null
          updated_at: string | null
        }
        Insert: {
          accepted_at?: string | null
          actual_margin?: number | null
          cluster_volume_estimate?: number | null
          complexity_factor?: number | null
          created_at?: string | null
          current_product_id?: string | null
          customer_user_id: string
          farmer_id: string
          id?: string
          lie?: number | null
          m_ij?: number | null
          offered_at?: string | null
          p_ij?: number | null
          product_id?: string | null
          recommendation_type: string
          rejected_at?: string | null
          status?: string | null
          time_spent_seconds?: number | null
          updated_at?: string | null
        }
        Update: {
          accepted_at?: string | null
          actual_margin?: number | null
          cluster_volume_estimate?: number | null
          complexity_factor?: number | null
          created_at?: string | null
          current_product_id?: string | null
          customer_user_id?: string
          farmer_id?: string
          id?: string
          lie?: number | null
          m_ij?: number | null
          offered_at?: string | null
          p_ij?: number | null
          product_id?: string | null
          recommendation_type?: string
          rejected_at?: string | null
          status?: string | null
          time_spent_seconds?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_recommendations_current_product_id_fkey"
            columns: ["current_product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "farmer_recommendations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      farmer_tactical_plans: {
        Row: {
          actual_margin: number | null
          approach_strategy: string | null
          approach_strategy_b: string | null
          best_individual_lie: number | null
          bundle_incremental_margin: number | null
          bundle_lie: number | null
          bundle_probability: number | null
          bundle_recommendation_id: string | null
          call_duration_seconds: number | null
          call_result: string | null
          churn_risk: number | null
          cluster_avg_margin_pct: number | null
          completed_at: string | null
          created_at: string | null
          current_margin_pct: number | null
          customer_profile: string | null
          customer_user_id: string
          diagnostic_questions: Json | null
          effectiveness_score: number | null
          expansion_potential: number | null
          expected_result: Json | null
          farmer_id: string
          generated_at: string | null
          health_score: number | null
          id: string
          implication_question: string | null
          ltv_projection: Json | null
          mix_gap: number | null
          notes: string | null
          objection_type: string | null
          offer_transition: string | null
          operational_risks: Json | null
          plan_followed: boolean | null
          plan_type: string | null
          probable_objections: Json | null
          second_bundle: Json | null
          status: string | null
          strategic_objective: string
          top_bundle: Json | null
          updated_at: string | null
          used_at: string | null
        }
        Insert: {
          actual_margin?: number | null
          approach_strategy?: string | null
          approach_strategy_b?: string | null
          best_individual_lie?: number | null
          bundle_incremental_margin?: number | null
          bundle_lie?: number | null
          bundle_probability?: number | null
          bundle_recommendation_id?: string | null
          call_duration_seconds?: number | null
          call_result?: string | null
          churn_risk?: number | null
          cluster_avg_margin_pct?: number | null
          completed_at?: string | null
          created_at?: string | null
          current_margin_pct?: number | null
          customer_profile?: string | null
          customer_user_id: string
          diagnostic_questions?: Json | null
          effectiveness_score?: number | null
          expansion_potential?: number | null
          expected_result?: Json | null
          farmer_id: string
          generated_at?: string | null
          health_score?: number | null
          id?: string
          implication_question?: string | null
          ltv_projection?: Json | null
          mix_gap?: number | null
          notes?: string | null
          objection_type?: string | null
          offer_transition?: string | null
          operational_risks?: Json | null
          plan_followed?: boolean | null
          plan_type?: string | null
          probable_objections?: Json | null
          second_bundle?: Json | null
          status?: string | null
          strategic_objective?: string
          top_bundle?: Json | null
          updated_at?: string | null
          used_at?: string | null
        }
        Update: {
          actual_margin?: number | null
          approach_strategy?: string | null
          approach_strategy_b?: string | null
          best_individual_lie?: number | null
          bundle_incremental_margin?: number | null
          bundle_lie?: number | null
          bundle_probability?: number | null
          bundle_recommendation_id?: string | null
          call_duration_seconds?: number | null
          call_result?: string | null
          churn_risk?: number | null
          cluster_avg_margin_pct?: number | null
          completed_at?: string | null
          created_at?: string | null
          current_margin_pct?: number | null
          customer_profile?: string | null
          customer_user_id?: string
          diagnostic_questions?: Json | null
          effectiveness_score?: number | null
          expansion_potential?: number | null
          expected_result?: Json | null
          farmer_id?: string
          generated_at?: string | null
          health_score?: number | null
          id?: string
          implication_question?: string | null
          ltv_projection?: Json | null
          mix_gap?: number | null
          notes?: string | null
          objection_type?: string | null
          offer_transition?: string | null
          operational_risks?: Json | null
          plan_followed?: boolean | null
          plan_type?: string | null
          probable_objections?: Json | null
          second_bundle?: Json | null
          status?: string | null
          strategic_objective?: string
          top_bundle?: Json | null
          updated_at?: string | null
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farmer_tactical_plans_bundle_recommendation_id_fkey"
            columns: ["bundle_recommendation_id"]
            isOneToOne: false
            referencedRelation: "farmer_bundle_recommendations"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_alertas: {
        Row: {
          company: string
          contexto: Json | null
          criado_em: string
          dismissed_at: string | null
          dismissed_by: string | null
          dismissed_until: string | null
          email_enfileirado_em: string | null
          id: string
          mensagem: string
          severidade: string
          threshold: number | null
          tipo: string
          valor: number | null
        }
        Insert: {
          company: string
          contexto?: Json | null
          criado_em?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          dismissed_until?: string | null
          email_enfileirado_em?: string | null
          id?: string
          mensagem: string
          severidade: string
          threshold?: number | null
          tipo: string
          valor?: number | null
        }
        Update: {
          company?: string
          contexto?: Json | null
          criado_em?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          dismissed_until?: string | null
          email_enfileirado_em?: string | null
          id?: string
          mensagem?: string
          severidade?: string
          threshold?: number | null
          tipo?: string
          valor?: number | null
        }
        Relationships: []
      }
      fin_antecipacoes: {
        Row: {
          banco: string | null
          company: string
          created_at: string
          created_by: string | null
          custos_avulsos: number
          data_operacao: string
          data_vencimento: string
          deleted_at: string | null
          id: string
          observacao: string | null
          operacao_origem_id: string | null
          referencia: string | null
          tipo: string
          updated_at: string
          updated_by: string | null
          valor_bruto: number
          valor_liquido: number
        }
        Insert: {
          banco?: string | null
          company: string
          created_at?: string
          created_by?: string | null
          custos_avulsos?: number
          data_operacao: string
          data_vencimento: string
          deleted_at?: string | null
          id?: string
          observacao?: string | null
          operacao_origem_id?: string | null
          referencia?: string | null
          tipo: string
          updated_at?: string
          updated_by?: string | null
          valor_bruto: number
          valor_liquido: number
        }
        Update: {
          banco?: string | null
          company?: string
          created_at?: string
          created_by?: string | null
          custos_avulsos?: number
          data_operacao?: string
          data_vencimento?: string
          deleted_at?: string | null
          id?: string
          observacao?: string | null
          operacao_origem_id?: string | null
          referencia?: string | null
          tipo?: string
          updated_at?: string
          updated_by?: string | null
          valor_bruto?: number
          valor_liquido?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_antecipacoes_operacao_origem_id_fkey"
            columns: ["operacao_origem_id"]
            isOneToOne: false
            referencedRelation: "fin_antecipacoes"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_audit_log: {
        Row: {
          changed_at: string
          changed_by: string | null
          changed_fields: Json
          company: string | null
          id: number
          op: string
          origem: string
          override_justificativa: string | null
          period_ref: string | null
          row_id: string
          table_name: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          changed_fields: Json
          company?: string | null
          id?: number
          op: string
          origem?: string
          override_justificativa?: string | null
          period_ref?: string | null
          row_id: string
          table_name: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          changed_fields?: Json
          company?: string | null
          id?: number
          op?: string
          origem?: string
          override_justificativa?: string | null
          period_ref?: string | null
          row_id?: string
          table_name?: string
        }
        Relationships: []
      }
      fin_balanco_inputs: {
        Row: {
          ativo_nao_circulante: number
          company: string
          data_ref: string
          observacao: string | null
          passivo_nao_circulante: number
          patrimonio_liquido: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ativo_nao_circulante: number
          company: string
          data_ref: string
          observacao?: string | null
          passivo_nao_circulante: number
          patrimonio_liquido: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ativo_nao_circulante?: number
          company?: string
          data_ref?: string
          observacao?: string | null
          passivo_nao_circulante?: number
          patrimonio_liquido?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_categoria_dre_mapping: {
        Row: {
          company: string
          created_at: string | null
          dre_linha: string
          id: string
          notas: string | null
          omie_codigo: string
          updated_at: string | null
        }
        Insert: {
          company: string
          created_at?: string | null
          dre_linha: string
          id?: string
          notas?: string | null
          omie_codigo: string
          updated_at?: string | null
        }
        Update: {
          company?: string
          created_at?: string | null
          dre_linha?: string
          id?: string
          notas?: string | null
          omie_codigo?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_categorias: {
        Row: {
          ativo: boolean | null
          company: string
          conta_pai: string | null
          created_at: string | null
          descricao: string
          id: string
          nivel: number | null
          omie_codigo: string
          tipo: string | null
          totalizadora: boolean | null
          updated_at: string | null
        }
        Insert: {
          ativo?: boolean | null
          company: string
          conta_pai?: string | null
          created_at?: string | null
          descricao: string
          id?: string
          nivel?: number | null
          omie_codigo: string
          tipo?: string | null
          totalizadora?: boolean | null
          updated_at?: string | null
        }
        Update: {
          ativo?: boolean | null
          company?: string
          conta_pai?: string | null
          created_at?: string | null
          descricao?: string
          id?: string
          nivel?: number | null
          omie_codigo?: string
          tipo?: string | null
          totalizadora?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_conciliacao: {
        Row: {
          company: string
          created_at: string | null
          diferenca: number | null
          id: string
          mov_data: string | null
          mov_descricao: string | null
          mov_id: string | null
          mov_valor: number | null
          observacao: string | null
          omie_ncodcc: number
          resolvido_em: string | null
          resolvido_por: string | null
          status: string
          tipo_match: string | null
          tipo_titulo: string | null
          titulo_id: string | null
          titulo_valor: number | null
          updated_at: string | null
        }
        Insert: {
          company: string
          created_at?: string | null
          diferenca?: number | null
          id?: string
          mov_data?: string | null
          mov_descricao?: string | null
          mov_id?: string | null
          mov_valor?: number | null
          observacao?: string | null
          omie_ncodcc: number
          resolvido_em?: string | null
          resolvido_por?: string | null
          status?: string
          tipo_match?: string | null
          tipo_titulo?: string | null
          titulo_id?: string | null
          titulo_valor?: number | null
          updated_at?: string | null
        }
        Update: {
          company?: string
          created_at?: string | null
          diferenca?: number | null
          id?: string
          mov_data?: string | null
          mov_descricao?: string | null
          mov_id?: string | null
          mov_valor?: number | null
          observacao?: string | null
          omie_ncodcc?: number
          resolvido_em?: string | null
          resolvido_por?: string | null
          status?: string
          tipo_match?: string | null
          tipo_titulo?: string | null
          titulo_id?: string | null
          titulo_valor?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_conciliacao_mov_id_fkey"
            columns: ["mov_id"]
            isOneToOne: false
            referencedRelation: "fin_movimentacoes"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_confiabilidade: {
        Row: {
          ano: number
          calculated_at: string | null
          company: string
          cp_sem_categoria: number | null
          cr_sem_categoria: number | null
          dre_categorias_heuristica: number | null
          dre_categorias_mapeadas: number | null
          dre_categorias_total: number | null
          dre_regime: string | null
          fechamento_status: string | null
          fechamento_versao: number | null
          id: string
          mes: number
          mov_sem_titulo: number | null
          pct_mov_conciliado: number | null
          pct_valor_mapeado: number | null
          sync_status: string | null
          titulo_sem_mov: number | null
          total_cp: number | null
          total_cr: number | null
          total_mov: number | null
          ultimo_sync: string | null
        }
        Insert: {
          ano: number
          calculated_at?: string | null
          company: string
          cp_sem_categoria?: number | null
          cr_sem_categoria?: number | null
          dre_categorias_heuristica?: number | null
          dre_categorias_mapeadas?: number | null
          dre_categorias_total?: number | null
          dre_regime?: string | null
          fechamento_status?: string | null
          fechamento_versao?: number | null
          id?: string
          mes: number
          mov_sem_titulo?: number | null
          pct_mov_conciliado?: number | null
          pct_valor_mapeado?: number | null
          sync_status?: string | null
          titulo_sem_mov?: number | null
          total_cp?: number | null
          total_cr?: number | null
          total_mov?: number | null
          ultimo_sync?: string | null
        }
        Update: {
          ano?: number
          calculated_at?: string | null
          company?: string
          cp_sem_categoria?: number | null
          cr_sem_categoria?: number | null
          dre_categorias_heuristica?: number | null
          dre_categorias_mapeadas?: number | null
          dre_categorias_total?: number | null
          dre_regime?: string | null
          fechamento_status?: string | null
          fechamento_versao?: number | null
          id?: string
          mes?: number
          mov_sem_titulo?: number | null
          pct_mov_conciliado?: number | null
          pct_valor_mapeado?: number | null
          sync_status?: string | null
          titulo_sem_mov?: number | null
          total_cp?: number | null
          total_cr?: number | null
          total_mov?: number | null
          ultimo_sync?: string | null
        }
        Relationships: []
      }
      fin_config_cashflow: {
        Row: {
          adiantamento_categorias_codigos: string[]
          company: string
          dre_tributario: Json
          folha_categorias_codigos: string[]
          overrides_cenario: Json
          thresholds: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          adiantamento_categorias_codigos?: string[]
          company: string
          dre_tributario?: Json
          folha_categorias_codigos?: string[]
          overrides_cenario?: Json
          thresholds?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          adiantamento_categorias_codigos?: string[]
          company?: string
          dre_tributario?: Json
          folha_categorias_codigos?: string[]
          overrides_cenario?: Json
          thresholds?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_contas_correntes: {
        Row: {
          agencia: string | null
          ativo: boolean | null
          banco: string | null
          company: string
          created_at: string | null
          descricao: string | null
          id: string
          numero_conta: string | null
          omie_ncodcc: number
          saldo_atual: number | null
          saldo_data: string | null
          tipo: string | null
          updated_at: string | null
        }
        Insert: {
          agencia?: string | null
          ativo?: boolean | null
          banco?: string | null
          company: string
          created_at?: string | null
          descricao?: string | null
          id?: string
          numero_conta?: string | null
          omie_ncodcc: number
          saldo_atual?: number | null
          saldo_data?: string | null
          tipo?: string | null
          updated_at?: string | null
        }
        Update: {
          agencia?: string | null
          ativo?: boolean | null
          banco?: string | null
          company?: string
          created_at?: string | null
          descricao?: string | null
          id?: string
          numero_conta?: string | null
          omie_ncodcc?: number
          saldo_atual?: number | null
          saldo_data?: string | null
          tipo?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_contas_pagar: {
        Row: {
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          codigo_barras: string | null
          company: string
          created_at: string | null
          data_emissao: string | null
          data_pagamento: string | null
          data_previsao: string | null
          data_vencimento: string | null
          departamento: string | null
          id: string
          id_origem: string | null
          metadata: Json | null
          nome_fornecedor: string | null
          numero_documento: string | null
          numero_documento_fiscal: string | null
          observacao: string | null
          omie_codigo_cliente_fornecedor: number | null
          omie_codigo_lancamento: number
          omie_ncodcc: number | null
          saldo: number | null
          status_titulo: string | null
          tipo_documento: string | null
          updated_at: string | null
          valor_desconto: number | null
          valor_documento: number
          valor_juros: number | null
          valor_multa: number | null
          valor_pago: number | null
        }
        Insert: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          centro_custo?: string | null
          cnpj_cpf?: string | null
          codigo_barras?: string | null
          company: string
          created_at?: string | null
          data_emissao?: string | null
          data_pagamento?: string | null
          data_previsao?: string | null
          data_vencimento?: string | null
          departamento?: string | null
          id?: string
          id_origem?: string | null
          metadata?: Json | null
          nome_fornecedor?: string | null
          numero_documento?: string | null
          numero_documento_fiscal?: string | null
          observacao?: string | null
          omie_codigo_cliente_fornecedor?: number | null
          omie_codigo_lancamento: number
          omie_ncodcc?: number | null
          saldo?: number | null
          status_titulo?: string | null
          tipo_documento?: string | null
          updated_at?: string | null
          valor_desconto?: number | null
          valor_documento?: number
          valor_juros?: number | null
          valor_multa?: number | null
          valor_pago?: number | null
        }
        Update: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          centro_custo?: string | null
          cnpj_cpf?: string | null
          codigo_barras?: string | null
          company?: string
          created_at?: string | null
          data_emissao?: string | null
          data_pagamento?: string | null
          data_previsao?: string | null
          data_vencimento?: string | null
          departamento?: string | null
          id?: string
          id_origem?: string | null
          metadata?: Json | null
          nome_fornecedor?: string | null
          numero_documento?: string | null
          numero_documento_fiscal?: string | null
          observacao?: string | null
          omie_codigo_cliente_fornecedor?: number | null
          omie_codigo_lancamento?: number
          omie_ncodcc?: number | null
          saldo?: number | null
          status_titulo?: string | null
          tipo_documento?: string | null
          updated_at?: string | null
          valor_desconto?: number | null
          valor_documento?: number
          valor_juros?: number | null
          valor_multa?: number | null
          valor_pago?: number | null
        }
        Relationships: []
      }
      fin_contas_receber: {
        Row: {
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          company: string
          created_at: string | null
          data_emissao: string | null
          data_previsao: string | null
          data_recebimento: string | null
          data_vencimento: string | null
          departamento: string | null
          id: string
          id_origem: string | null
          metadata: Json | null
          nome_cliente: string | null
          numero_documento: string | null
          numero_documento_fiscal: string | null
          numero_pedido: string | null
          observacao: string | null
          omie_codigo_cliente: number | null
          omie_codigo_lancamento: number
          omie_ncodcc: number | null
          saldo: number | null
          status_titulo: string | null
          tipo_documento: string | null
          updated_at: string | null
          valor_desconto: number | null
          valor_documento: number
          valor_juros: number | null
          valor_multa: number | null
          valor_recebido: number | null
          vendedor_id: number | null
        }
        Insert: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          centro_custo?: string | null
          cnpj_cpf?: string | null
          company: string
          created_at?: string | null
          data_emissao?: string | null
          data_previsao?: string | null
          data_recebimento?: string | null
          data_vencimento?: string | null
          departamento?: string | null
          id?: string
          id_origem?: string | null
          metadata?: Json | null
          nome_cliente?: string | null
          numero_documento?: string | null
          numero_documento_fiscal?: string | null
          numero_pedido?: string | null
          observacao?: string | null
          omie_codigo_cliente?: number | null
          omie_codigo_lancamento: number
          omie_ncodcc?: number | null
          saldo?: number | null
          status_titulo?: string | null
          tipo_documento?: string | null
          updated_at?: string | null
          valor_desconto?: number | null
          valor_documento?: number
          valor_juros?: number | null
          valor_multa?: number | null
          valor_recebido?: number | null
          vendedor_id?: number | null
        }
        Update: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          centro_custo?: string | null
          cnpj_cpf?: string | null
          company?: string
          created_at?: string | null
          data_emissao?: string | null
          data_previsao?: string | null
          data_recebimento?: string | null
          data_vencimento?: string | null
          departamento?: string | null
          id?: string
          id_origem?: string | null
          metadata?: Json | null
          nome_cliente?: string | null
          numero_documento?: string | null
          numero_documento_fiscal?: string | null
          numero_pedido?: string | null
          observacao?: string | null
          omie_codigo_cliente?: number | null
          omie_codigo_lancamento?: number
          omie_ncodcc?: number | null
          saldo?: number | null
          status_titulo?: string | null
          tipo_documento?: string | null
          updated_at?: string | null
          valor_desconto?: number | null
          valor_documento?: number
          valor_juros?: number | null
          valor_multa?: number | null
          valor_recebido?: number | null
          vendedor_id?: number | null
        }
        Relationships: []
      }
      fin_custo_rateio: {
        Row: {
          ativo: boolean
          company: string
          observacao: string
          origem_company: string
          rotulo: string
          updated_at: string
          updated_by: string | null
          valor_mensal_brl: number
        }
        Insert: {
          ativo?: boolean
          company: string
          observacao: string
          origem_company: string
          rotulo: string
          updated_at?: string
          updated_by?: string | null
          valor_mensal_brl: number
        }
        Update: {
          ativo?: boolean
          company?: string
          observacao?: string
          origem_company?: string
          rotulo?: string
          updated_at?: string
          updated_by?: string | null
          valor_mensal_brl?: number
        }
        Relationships: []
      }
      fin_divida_completude: {
        Row: {
          company: string
          completo: boolean
          validado_em: string | null
          validado_por: string | null
        }
        Insert: {
          company: string
          completo?: boolean
          validado_em?: string | null
          validado_por?: string | null
        }
        Update: {
          company?: string
          completo?: boolean
          validado_em?: string | null
          validado_por?: string | null
        }
        Relationships: []
      }
      fin_divida_parcelas: {
        Row: {
          data_vencimento: string
          divida_id: string
          estimado: boolean
          id: string
          numero_parcela: number
          pago: boolean
          valor_amortizacao: number
          valor_juros: number
          valor_total: number
        }
        Insert: {
          data_vencimento: string
          divida_id: string
          estimado?: boolean
          id?: string
          numero_parcela: number
          pago?: boolean
          valor_amortizacao: number
          valor_juros?: number
          valor_total: number
        }
        Update: {
          data_vencimento?: string
          divida_id?: string
          estimado?: boolean
          id?: string
          numero_parcela?: number
          pago?: boolean
          valor_amortizacao?: number
          valor_juros?: number
          valor_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_divida_parcelas_divida_id_fkey"
            columns: ["divida_id"]
            isOneToOne: false
            referencedRelation: "fin_dividas"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_dividas: {
        Row: {
          ativo: boolean
          cet_aa: number | null
          company: string
          coobrigada_por: string | null
          cp_inclusion_ate: string | null
          cp_inclusion_status: string
          credor: string
          data_contratacao: string
          garantias: string | null
          id: string
          indexador: string | null
          observacao: string | null
          principal_contratado: number
          saldo_devedor_data_base: string | null
          saldo_devedor_informado: number | null
          tipo: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ativo?: boolean
          cet_aa?: number | null
          company: string
          coobrigada_por?: string | null
          cp_inclusion_ate?: string | null
          cp_inclusion_status?: string
          credor: string
          data_contratacao: string
          garantias?: string | null
          id?: string
          indexador?: string | null
          observacao?: string | null
          principal_contratado: number
          saldo_devedor_data_base?: string | null
          saldo_devedor_informado?: number | null
          tipo: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ativo?: boolean
          cet_aa?: number | null
          company?: string
          coobrigada_por?: string | null
          cp_inclusion_ate?: string | null
          cp_inclusion_status?: string
          credor?: string
          data_contratacao?: string
          garantias?: string | null
          id?: string
          indexador?: string | null
          observacao?: string | null
          principal_contratado?: number
          saldo_devedor_data_base?: string | null
          saldo_devedor_informado?: number | null
          tipo?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_dre_custo_tipo: {
        Row: {
          categoria_codigo: string
          company: string
          observacao: string | null
          tipo: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          categoria_codigo: string
          company?: string
          observacao?: string | null
          tipo: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          categoria_codigo?: string
          company?: string
          observacao?: string | null
          tipo?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_dre_snapshots: {
        Row: {
          ano: number
          calculated_at: string | null
          cmv: number | null
          company: string
          deducoes: number | null
          despesas_administrativas: number | null
          despesas_comerciais: number | null
          despesas_financeiras: number | null
          despesas_operacionais: number | null
          detalhamento: Json | null
          id: string
          impostos: number | null
          lucro_bruto: number | null
          mes: number
          outras_despesas: number | null
          outras_receitas: number | null
          qtd_categorias_sem_mapeamento: number | null
          receita_bruta: number | null
          receita_liquida: number | null
          receitas_financeiras: number | null
          regime: string
          resultado_antes_impostos: number | null
          resultado_liquido: number | null
          resultado_operacional: number | null
        }
        Insert: {
          ano: number
          calculated_at?: string | null
          cmv?: number | null
          company: string
          deducoes?: number | null
          despesas_administrativas?: number | null
          despesas_comerciais?: number | null
          despesas_financeiras?: number | null
          despesas_operacionais?: number | null
          detalhamento?: Json | null
          id?: string
          impostos?: number | null
          lucro_bruto?: number | null
          mes: number
          outras_despesas?: number | null
          outras_receitas?: number | null
          qtd_categorias_sem_mapeamento?: number | null
          receita_bruta?: number | null
          receita_liquida?: number | null
          receitas_financeiras?: number | null
          regime?: string
          resultado_antes_impostos?: number | null
          resultado_liquido?: number | null
          resultado_operacional?: number | null
        }
        Update: {
          ano?: number
          calculated_at?: string | null
          cmv?: number | null
          company?: string
          deducoes?: number | null
          despesas_administrativas?: number | null
          despesas_comerciais?: number | null
          despesas_financeiras?: number | null
          despesas_operacionais?: number | null
          detalhamento?: Json | null
          id?: string
          impostos?: number | null
          lucro_bruto?: number | null
          mes?: number
          outras_despesas?: number | null
          outras_receitas?: number | null
          qtd_categorias_sem_mapeamento?: number | null
          receita_bruta?: number | null
          receita_liquida?: number | null
          receitas_financeiras?: number | null
          regime?: string
          resultado_antes_impostos?: number | null
          resultado_liquido?: number | null
          resultado_operacional?: number | null
        }
        Relationships: []
      }
      fin_eliminacoes_intercompany: {
        Row: {
          ativo: boolean | null
          categoria_destino: string | null
          categoria_origem: string | null
          cnpj_destino: string | null
          cnpj_origem: string | null
          created_at: string | null
          descricao: string
          empresa_destino: string
          empresa_origem: string
          id: string
          match_por: string
          tipo: string
          updated_at: string | null
        }
        Insert: {
          ativo?: boolean | null
          categoria_destino?: string | null
          categoria_origem?: string | null
          cnpj_destino?: string | null
          cnpj_origem?: string | null
          created_at?: string | null
          descricao: string
          empresa_destino: string
          empresa_origem: string
          id?: string
          match_por?: string
          tipo: string
          updated_at?: string | null
        }
        Update: {
          ativo?: boolean | null
          categoria_destino?: string | null
          categoria_origem?: string | null
          cnpj_destino?: string | null
          cnpj_origem?: string | null
          created_at?: string | null
          descricao?: string
          empresa_destino?: string
          empresa_origem?: string
          id?: string
          match_por?: string
          tipo?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_eliminacoes_log: {
        Row: {
          ano: number
          created_at: string | null
          detalhes: Json | null
          id: string
          mes: number
          qtd_titulos: number | null
          regra_id: string | null
          valor_eliminado: number
        }
        Insert: {
          ano: number
          created_at?: string | null
          detalhes?: Json | null
          id?: string
          mes: number
          qtd_titulos?: number | null
          regra_id?: string | null
          valor_eliminado: number
        }
        Update: {
          ano?: number
          created_at?: string | null
          detalhes?: Json | null
          id?: string
          mes?: number
          qtd_titulos?: number | null
          regra_id?: string | null
          valor_eliminado?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_eliminacoes_log_regra_id_fkey"
            columns: ["regra_id"]
            isOneToOne: false
            referencedRelation: "fin_eliminacoes_intercompany"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_estoque_valor: {
        Row: {
          cobertura_pct: number | null
          company: string
          created_at: string
          criado_por: string | null
          data_ref: string
          fonte: string
          id: string
          observacao: string | null
          valor: number
        }
        Insert: {
          cobertura_pct?: number | null
          company: string
          created_at?: string
          criado_por?: string | null
          data_ref: string
          fonte?: string
          id?: string
          observacao?: string | null
          valor: number
        }
        Update: {
          cobertura_pct?: number | null
          company?: string
          created_at?: string
          criado_por?: string | null
          data_ref?: string
          fonte?: string
          id?: string
          observacao?: string | null
          valor?: number
        }
        Relationships: []
      }
      fin_eventos_eventuais: {
        Row: {
          categoria_dre: string | null
          company: string
          created_at: string
          criado_por: string | null
          data_prevista: string
          data_realizada: string | null
          descricao: string
          id: string
          observacao: string | null
          status: string
          tipo: string
          updated_at: string
          valor: number
        }
        Insert: {
          categoria_dre?: string | null
          company: string
          created_at?: string
          criado_por?: string | null
          data_prevista: string
          data_realizada?: string | null
          descricao: string
          id?: string
          observacao?: string | null
          status?: string
          tipo: string
          updated_at?: string
          valor: number
        }
        Update: {
          categoria_dre?: string | null
          company?: string
          created_at?: string
          criado_por?: string | null
          data_prevista?: string
          data_realizada?: string | null
          descricao?: string
          id?: string
          observacao?: string | null
          status?: string
          tipo?: string
          updated_at?: string
          valor?: number
        }
        Relationships: []
      }
      fin_eventos_recorrentes: {
        Row: {
          ativo: boolean
          categoria_dre: string | null
          company: string
          created_at: string
          criado_por: string | null
          descricao: string
          dia_do_mes: number
          fim: string | null
          id: string
          inicio: string
          is_folha: boolean
          observacao: string | null
          tipo: string
          updated_at: string
          valor: number
        }
        Insert: {
          ativo?: boolean
          categoria_dre?: string | null
          company: string
          created_at?: string
          criado_por?: string | null
          descricao: string
          dia_do_mes: number
          fim?: string | null
          id?: string
          inicio: string
          is_folha?: boolean
          observacao?: string | null
          tipo: string
          updated_at?: string
          valor: number
        }
        Update: {
          ativo?: boolean
          categoria_dre?: string | null
          company?: string
          created_at?: string
          criado_por?: string | null
          descricao?: string
          dia_do_mes?: number
          fim?: string | null
          id?: string
          inicio?: string
          is_folha?: boolean
          observacao?: string | null
          tipo?: string
          updated_at?: string
          valor?: number
        }
        Relationships: []
      }
      fin_fechamento_log: {
        Row: {
          acao: string
          created_at: string | null
          detalhes: Json | null
          fechamento_id: string
          id: string
          usuario_id: string | null
          usuario_nome: string | null
        }
        Insert: {
          acao: string
          created_at?: string | null
          detalhes?: Json | null
          fechamento_id: string
          id?: string
          usuario_id?: string | null
          usuario_nome?: string | null
        }
        Update: {
          acao?: string
          created_at?: string | null
          detalhes?: Json | null
          fechamento_id?: string
          id?: string
          usuario_id?: string | null
          usuario_nome?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_fechamento_log_fechamento_id_fkey"
            columns: ["fechamento_id"]
            isOneToOne: false
            referencedRelation: "fin_fechamentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_fechamentos: {
        Row: {
          ano: number
          aprovado_em: string | null
          aprovado_por: string | null
          company: string
          created_at: string | null
          fechado_em: string | null
          fechado_por: string | null
          id: string
          mes: number
          motivo_reabertura: string | null
          notas: string | null
          reaberto_em: string | null
          reaberto_por: string | null
          snapshot_data: Json | null
          snapshot_dre_caixa_id: string | null
          snapshot_dre_competencia_id: string | null
          snapshot_dre_id: string | null
          status: string
          updated_at: string | null
          versao: number
        }
        Insert: {
          ano: number
          aprovado_em?: string | null
          aprovado_por?: string | null
          company: string
          created_at?: string | null
          fechado_em?: string | null
          fechado_por?: string | null
          id?: string
          mes: number
          motivo_reabertura?: string | null
          notas?: string | null
          reaberto_em?: string | null
          reaberto_por?: string | null
          snapshot_data?: Json | null
          snapshot_dre_caixa_id?: string | null
          snapshot_dre_competencia_id?: string | null
          snapshot_dre_id?: string | null
          status?: string
          updated_at?: string | null
          versao?: number
        }
        Update: {
          ano?: number
          aprovado_em?: string | null
          aprovado_por?: string | null
          company?: string
          created_at?: string | null
          fechado_em?: string | null
          fechado_por?: string | null
          id?: string
          mes?: number
          motivo_reabertura?: string | null
          notas?: string | null
          reaberto_em?: string | null
          reaberto_por?: string | null
          snapshot_data?: Json | null
          snapshot_dre_caixa_id?: string | null
          snapshot_dre_competencia_id?: string | null
          snapshot_dre_id?: string | null
          status?: string
          updated_at?: string | null
          versao?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_fechamentos_snapshot_dre_caixa_id_fkey"
            columns: ["snapshot_dre_caixa_id"]
            isOneToOne: false
            referencedRelation: "fin_dre_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_fechamentos_snapshot_dre_competencia_id_fkey"
            columns: ["snapshot_dre_competencia_id"]
            isOneToOne: false
            referencedRelation: "fin_dre_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_fechamentos_snapshot_dre_id_fkey"
            columns: ["snapshot_dre_id"]
            isOneToOne: false
            referencedRelation: "fin_dre_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_forecast: {
        Row: {
          ano: number
          base_meses: number | null
          company: string
          confianca: number | null
          dre_linha: string | null
          id: string
          mes: number
          metodo: string | null
          tipo: string
          updated_at: string | null
          valor_forecast: number
        }
        Insert: {
          ano: number
          base_meses?: number | null
          company: string
          confianca?: number | null
          dre_linha?: string | null
          id?: string
          mes: number
          metodo?: string | null
          tipo: string
          updated_at?: string | null
          valor_forecast?: number
        }
        Update: {
          ano?: number
          base_meses?: number | null
          company?: string
          confianca?: number | null
          dre_linha?: string | null
          id?: string
          mes?: number
          metodo?: string | null
          tipo?: string
          updated_at?: string | null
          valor_forecast?: number
        }
        Relationships: []
      }
      fin_funding_inputs: {
        Row: {
          company: string
          funding_inputs: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company: string
          funding_inputs?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company?: string
          funding_inputs?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_ic_matches: {
        Row: {
          cp_id: string | null
          cr_id: string | null
          diff_dias: number | null
          diff_valor: number | null
          empresa_destino: string
          empresa_origem: string
          id: string
          matched_at: string
          observacao: string | null
          resolvido_em: string | null
          resolvido_por: string | null
          status: string
          valor_destino: number | null
          valor_origem: number | null
        }
        Insert: {
          cp_id?: string | null
          cr_id?: string | null
          diff_dias?: number | null
          diff_valor?: number | null
          empresa_destino: string
          empresa_origem: string
          id?: string
          matched_at?: string
          observacao?: string | null
          resolvido_em?: string | null
          resolvido_por?: string | null
          status: string
          valor_destino?: number | null
          valor_origem?: number | null
        }
        Update: {
          cp_id?: string | null
          cr_id?: string | null
          diff_dias?: number | null
          diff_valor?: number | null
          empresa_destino?: string
          empresa_origem?: string
          id?: string
          matched_at?: string
          observacao?: string | null
          resolvido_em?: string | null
          resolvido_por?: string | null
          status?: string
          valor_destino?: number | null
          valor_origem?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_ic_matches_cp_id_fkey"
            columns: ["cp_id"]
            isOneToOne: false
            referencedRelation: "fin_contas_pagar"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_ic_matches_cr_id_fkey"
            columns: ["cr_id"]
            isOneToOne: false
            referencedRelation: "fin_contas_receber"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_kpi_tributario: {
        Row: {
          aliquota_efetiva: number | null
          ano: number
          base_presuncao_comercio: number | null
          base_presuncao_servico: number | null
          calculated_at: string | null
          carga_tributaria_total: number | null
          cofins: number | null
          company: string
          csll: number | null
          detalhamento: Json | null
          faixa_sn: string | null
          fator_r: number | null
          icms: number | null
          id: string
          irpj: number | null
          iss: number | null
          mes: number
          pis: number | null
          receita_bruta_acumulada: number | null
          regime: string
        }
        Insert: {
          aliquota_efetiva?: number | null
          ano: number
          base_presuncao_comercio?: number | null
          base_presuncao_servico?: number | null
          calculated_at?: string | null
          carga_tributaria_total?: number | null
          cofins?: number | null
          company: string
          csll?: number | null
          detalhamento?: Json | null
          faixa_sn?: string | null
          fator_r?: number | null
          icms?: number | null
          id?: string
          irpj?: number | null
          iss?: number | null
          mes: number
          pis?: number | null
          receita_bruta_acumulada?: number | null
          regime: string
        }
        Update: {
          aliquota_efetiva?: number | null
          ano?: number
          base_presuncao_comercio?: number | null
          base_presuncao_servico?: number | null
          calculated_at?: string | null
          carga_tributaria_total?: number | null
          cofins?: number | null
          company?: string
          csll?: number | null
          detalhamento?: Json | null
          faixa_sn?: string | null
          fator_r?: number | null
          icms?: number | null
          id?: string
          irpj?: number | null
          iss?: number | null
          mes?: number
          pis?: number | null
          receita_bruta_acumulada?: number | null
          regime?: string
        }
        Relationships: []
      }
      fin_movimentacoes: {
        Row: {
          categoria_codigo: string | null
          categoria_descricao: string | null
          company: string
          conciliado: boolean | null
          created_at: string | null
          data_movimento: string
          descricao: string | null
          id: string
          metadata: Json | null
          natureza: string | null
          omie_codigo_lancamento: number | null
          omie_ncodcc: number | null
          omie_ncodmov: number
          tipo: string | null
          updated_at: string | null
          valor: number
        }
        Insert: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          company: string
          conciliado?: boolean | null
          created_at?: string | null
          data_movimento: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          natureza?: string | null
          omie_codigo_lancamento?: number | null
          omie_ncodcc?: number | null
          omie_ncodmov: number
          tipo?: string | null
          updated_at?: string | null
          valor: number
        }
        Update: {
          categoria_codigo?: string | null
          categoria_descricao?: string | null
          company?: string
          conciliado?: boolean | null
          created_at?: string | null
          data_movimento?: string
          descricao?: string | null
          id?: string
          metadata?: Json | null
          natureza?: string | null
          omie_codigo_lancamento?: number | null
          omie_ncodcc?: number | null
          omie_ncodmov?: number
          tipo?: string | null
          updated_at?: string | null
          valor?: number
        }
        Relationships: []
      }
      fin_orcamento: {
        Row: {
          ano: number
          company: string
          criado_por: string | null
          dre_linha: string
          id: string
          mes: number
          notas: string | null
          updated_at: string | null
          valor_orcado: number
        }
        Insert: {
          ano: number
          company: string
          criado_por?: string | null
          dre_linha: string
          id?: string
          mes: number
          notas?: string | null
          updated_at?: string | null
          valor_orcado?: number
        }
        Update: {
          ano?: number
          company?: string
          criado_por?: string | null
          dre_linha?: string
          id?: string
          mes?: number
          notas?: string | null
          updated_at?: string | null
          valor_orcado?: number
        }
        Relationships: []
      }
      fin_period_overrides: {
        Row: {
          acao_planejada: string
          ano: number
          closed_at: string | null
          closed_by: string | null
          company: string
          expires_at: string
          id: string
          justificativa: string
          mes: number
          opened_at: string
          opened_by: string
        }
        Insert: {
          acao_planejada: string
          ano: number
          closed_at?: string | null
          closed_by?: string | null
          company: string
          expires_at: string
          id?: string
          justificativa: string
          mes: number
          opened_at?: string
          opened_by: string
        }
        Update: {
          acao_planejada?: string
          ano?: number
          closed_at?: string | null
          closed_by?: string | null
          company?: string
          expires_at?: string
          id?: string
          justificativa?: string
          mes?: number
          opened_at?: string
          opened_by?: string
        }
        Relationships: []
      }
      fin_permissoes: {
        Row: {
          concedido_por: string | null
          created_at: string | null
          empresas: string[]
          id: string
          perfil: string
          pode_aprovar_fechamento: boolean | null
          pode_conciliar: boolean | null
          pode_editar_mapping: boolean | null
          pode_editar_orcamento: boolean | null
          pode_eliminar_intercompany: boolean | null
          pode_exportar: boolean | null
          pode_fechar_mes: boolean | null
          pode_reabrir_fechamento: boolean | null
          pode_sync: boolean | null
          pode_ver_dre: boolean | null
          pode_ver_todas_empresas: boolean | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          concedido_por?: string | null
          created_at?: string | null
          empresas?: string[]
          id?: string
          perfil: string
          pode_aprovar_fechamento?: boolean | null
          pode_conciliar?: boolean | null
          pode_editar_mapping?: boolean | null
          pode_editar_orcamento?: boolean | null
          pode_eliminar_intercompany?: boolean | null
          pode_exportar?: boolean | null
          pode_fechar_mes?: boolean | null
          pode_reabrir_fechamento?: boolean | null
          pode_sync?: boolean | null
          pode_ver_dre?: boolean | null
          pode_ver_todas_empresas?: boolean | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          concedido_por?: string | null
          created_at?: string | null
          empresas?: string[]
          id?: string
          perfil?: string
          pode_aprovar_fechamento?: boolean | null
          pode_conciliar?: boolean | null
          pode_editar_mapping?: boolean | null
          pode_editar_orcamento?: boolean | null
          pode_eliminar_intercompany?: boolean | null
          pode_exportar?: boolean | null
          pode_fechar_mes?: boolean | null
          pode_reabrir_fechamento?: boolean | null
          pode_sync?: boolean | null
          pode_ver_dre?: boolean | null
          pode_ver_todas_empresas?: boolean | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      fin_projecao_snapshots: {
        Row: {
          cenario: string
          company: string
          dados: Json
          dias_cobertura: number | null
          horizon_weeks: number
          id: string
          liquidez_operacional_liquida: number | null
          ncg: number | null
          premissas: Json
          saldo_tesouraria: number | null
          snapshot_at: string
        }
        Insert: {
          cenario: string
          company: string
          dados: Json
          dias_cobertura?: number | null
          horizon_weeks?: number
          id?: string
          liquidez_operacional_liquida?: number | null
          ncg?: number | null
          premissas: Json
          saldo_tesouraria?: number | null
          snapshot_at?: string
        }
        Update: {
          cenario?: string
          company?: string
          dados?: Json
          dias_cobertura?: number | null
          horizon_weeks?: number
          id?: string
          liquidez_operacional_liquida?: number | null
          ncg?: number | null
          premissas?: Json
          saldo_tesouraria?: number | null
          snapshot_at?: string
        }
        Relationships: []
      }
      fin_regime_inputs: {
        Row: {
          company: string
          regime_inputs: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company: string
          regime_inputs?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company?: string
          regime_inputs?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fin_sync_checkpoint: {
        Row: {
          company: string
          completed_at: string | null
          entidade: string
          filtro_data_ate: string | null
          filtro_data_de: string | null
          id: string
          last_error: string | null
          lock_expires_at: string | null
          lock_id: string | null
          started_at: string | null
          status: string | null
          total_paginas: number | null
          total_synced: number | null
          ultima_pagina: number | null
          updated_at: string | null
        }
        Insert: {
          company: string
          completed_at?: string | null
          entidade: string
          filtro_data_ate?: string | null
          filtro_data_de?: string | null
          id?: string
          last_error?: string | null
          lock_expires_at?: string | null
          lock_id?: string | null
          started_at?: string | null
          status?: string | null
          total_paginas?: number | null
          total_synced?: number | null
          ultima_pagina?: number | null
          updated_at?: string | null
        }
        Update: {
          company?: string
          completed_at?: string | null
          entidade?: string
          filtro_data_ate?: string | null
          filtro_data_de?: string | null
          id?: string
          last_error?: string | null
          lock_expires_at?: string | null
          lock_id?: string | null
          started_at?: string | null
          status?: string | null
          total_paginas?: number | null
          total_synced?: number | null
          ultima_pagina?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_sync_cursor: {
        Row: {
          backfill_desde: string | null
          company: string
          next_page: number | null
          resource: string
          updated_at: string
        }
        Insert: {
          backfill_desde?: string | null
          company: string
          next_page?: number | null
          resource: string
          updated_at?: string
        }
        Update: {
          backfill_desde?: string | null
          company?: string
          next_page?: number | null
          resource?: string
          updated_at?: string
        }
        Relationships: []
      }
      fin_sync_kick_retry: {
        Row: {
          attempted_at: string
          company: string
          janela: string
          request_id: number | null
          resource: string
        }
        Insert: {
          attempted_at?: string
          company: string
          janela: string
          request_id?: number | null
          resource: string
        }
        Update: {
          attempted_at?: string
          company?: string
          janela?: string
          request_id?: number | null
          resource?: string
        }
        Relationships: []
      }
      fin_sync_lease: {
        Row: {
          acquired_at: string
          company: string
          expires_at: string
          holder: string | null
          token: string
          updated_at: string
        }
        Insert: {
          acquired_at?: string
          company: string
          expires_at: string
          holder?: string | null
          token: string
          updated_at?: string
        }
        Update: {
          acquired_at?: string
          company?: string
          expires_at?: string
          holder?: string | null
          token?: string
          updated_at?: string
        }
        Relationships: []
      }
      fin_sync_log: {
        Row: {
          action: string
          api_calls: number | null
          companies: string[] | null
          completed_at: string | null
          duracao_ms: number | null
          entidades_por_empresa: Json | null
          error_message: string | null
          id: string
          rate_limits_hit: number | null
          results: Json | null
          started_at: string | null
          status: string | null
          triggered_by: string | null
        }
        Insert: {
          action: string
          api_calls?: number | null
          companies?: string[] | null
          completed_at?: string | null
          duracao_ms?: number | null
          entidades_por_empresa?: Json | null
          error_message?: string | null
          id?: string
          rate_limits_hit?: number | null
          results?: Json | null
          started_at?: string | null
          status?: string | null
          triggered_by?: string | null
        }
        Update: {
          action?: string
          api_calls?: number | null
          companies?: string[] | null
          completed_at?: string | null
          duracao_ms?: number | null
          entidades_por_empresa?: Json | null
          error_message?: string | null
          id?: string
          rate_limits_hit?: number | null
          results?: Json | null
          started_at?: string | null
          status?: string | null
          triggered_by?: string | null
        }
        Relationships: []
      }
      fin_valor_inputs: {
        Row: {
          company: string
          updated_at: string
          updated_by: string | null
          valor_inputs: Json
        }
        Insert: {
          company: string
          updated_at?: string
          updated_by?: string | null
          valor_inputs?: Json
        }
        Update: {
          company?: string
          updated_at?: string
          updated_by?: string | null
          valor_inputs?: Json
        }
        Relationships: []
      }
      fornecedor_alerta: {
        Row: {
          aumento_id: number | null
          calendar_evento_id: string | null
          campanha_id: number | null
          criado_em: string | null
          data_evento: string | null
          duracao_minutos: number | null
          email_enviado: boolean | null
          email_enviado_em: string | null
          email_origem_id: string | null
          empresa: string
          erro_notificacao: string | null
          fornecedor_id: string | null
          fornecedor_nome: string | null
          gmail_message_id: string | null
          id: number
          mensagem: string | null
          metadata: Json | null
          notificado_em: string | null
          resolvido: boolean | null
          resolvido_em: string | null
          resolvido_por: string | null
          severidade: string
          status: string | null
          tentativas: number | null
          tipo: string
          tipo_alerta: string | null
          titulo: string
          visualizado: boolean | null
          visualizado_em: string | null
        }
        Insert: {
          aumento_id?: number | null
          calendar_evento_id?: string | null
          campanha_id?: number | null
          criado_em?: string | null
          data_evento?: string | null
          duracao_minutos?: number | null
          email_enviado?: boolean | null
          email_enviado_em?: string | null
          email_origem_id?: string | null
          empresa: string
          erro_notificacao?: string | null
          fornecedor_id?: string | null
          fornecedor_nome?: string | null
          gmail_message_id?: string | null
          id?: number
          mensagem?: string | null
          metadata?: Json | null
          notificado_em?: string | null
          resolvido?: boolean | null
          resolvido_em?: string | null
          resolvido_por?: string | null
          severidade?: string
          status?: string | null
          tentativas?: number | null
          tipo: string
          tipo_alerta?: string | null
          titulo: string
          visualizado?: boolean | null
          visualizado_em?: string | null
        }
        Update: {
          aumento_id?: number | null
          calendar_evento_id?: string | null
          campanha_id?: number | null
          criado_em?: string | null
          data_evento?: string | null
          duracao_minutos?: number | null
          email_enviado?: boolean | null
          email_enviado_em?: string | null
          email_origem_id?: string | null
          empresa?: string
          erro_notificacao?: string | null
          fornecedor_id?: string | null
          fornecedor_nome?: string | null
          gmail_message_id?: string | null
          id?: number
          mensagem?: string | null
          metadata?: Json | null
          notificado_em?: string | null
          resolvido?: boolean | null
          resolvido_em?: string | null
          resolvido_por?: string | null
          severidade?: string
          status?: string | null
          tentativas?: number | null
          tipo?: string
          tipo_alerta?: string | null
          titulo?: string
          visualizado?: boolean | null
          visualizado_em?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fornecedor_alerta_aumento_id_fkey"
            columns: ["aumento_id"]
            isOneToOne: false
            referencedRelation: "fornecedor_aumento_anunciado"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_aumento_id_fkey"
            columns: ["aumento_id"]
            isOneToOne: false
            referencedRelation: "v_sku_aumento_vigente"
            referencedColumns: ["aumento_id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "fornecedor_alerta_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
        ]
      }
      fornecedor_aumento_anunciado: {
        Row: {
          atualizado_em: string | null
          atualizado_por: string | null
          criado_em: string | null
          criado_por: string | null
          data_anuncio: string | null
          data_vigencia: string
          empresa: string
          estado: string
          extracao_confianca: number | null
          extracao_observacoes: string | null
          extraido_em: string | null
          fornecedor_nome: string
          id: number
          nome: string
          observacoes: string | null
          origem_arquivo_tipo: string | null
          origem_arquivo_url: string | null
          origem_email_assunto: string | null
          origem_email_data: string | null
          origem_email_remetente: string | null
        }
        Insert: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_anuncio?: string | null
          data_vigencia: string
          empresa: string
          estado?: string
          extracao_confianca?: number | null
          extracao_observacoes?: string | null
          extraido_em?: string | null
          fornecedor_nome: string
          id?: number
          nome: string
          observacoes?: string | null
          origem_arquivo_tipo?: string | null
          origem_arquivo_url?: string | null
          origem_email_assunto?: string | null
          origem_email_data?: string | null
          origem_email_remetente?: string | null
        }
        Update: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_anuncio?: string | null
          data_vigencia?: string
          empresa?: string
          estado?: string
          extracao_confianca?: number | null
          extracao_observacoes?: string | null
          extraido_em?: string | null
          fornecedor_nome?: string
          id?: number
          nome?: string
          observacoes?: string | null
          origem_arquivo_tipo?: string | null
          origem_arquivo_url?: string | null
          origem_email_assunto?: string | null
          origem_email_data?: string | null
          origem_email_remetente?: string | null
        }
        Relationships: []
      }
      fornecedor_aumento_item: {
        Row: {
          ativo: boolean
          atualizado_em: string | null
          aumento_id: number
          aumento_perc: number
          categoria_fornecedor: string
          confirmado: boolean
          criado_em: string | null
          data_vigencia_especifica: string | null
          id: number
          observacoes: string | null
        }
        Insert: {
          ativo?: boolean
          atualizado_em?: string | null
          aumento_id: number
          aumento_perc: number
          categoria_fornecedor: string
          confirmado?: boolean
          criado_em?: string | null
          data_vigencia_especifica?: string | null
          id?: number
          observacoes?: string | null
        }
        Update: {
          ativo?: boolean
          atualizado_em?: string | null
          aumento_id?: number
          aumento_perc?: number
          categoria_fornecedor?: string
          confirmado?: boolean
          criado_em?: string | null
          data_vigencia_especifica?: string | null
          id?: number
          observacoes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fornecedor_aumento_item_aumento_id_fkey"
            columns: ["aumento_id"]
            isOneToOne: false
            referencedRelation: "fornecedor_aumento_anunciado"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fornecedor_aumento_item_aumento_id_fkey"
            columns: ["aumento_id"]
            isOneToOne: false
            referencedRelation: "v_sku_aumento_vigente"
            referencedColumns: ["aumento_id"]
          },
        ]
      }
      fornecedor_cadeia_logistica: {
        Row: {
          ativo: boolean | null
          atualizado_em: string | null
          atualizado_por: string | null
          criado_em: string | null
          descricao: string
          empresa: string
          etapa_codigo: string
          fornecedor_nome: string
          id: number
          lt_dias: number
          lt_unidade: string
          observacoes: string | null
          ordem: number
          parceiro_contato: string | null
          parceiro_nome: string | null
          parceiro_tipo: string | null
          valido_ate: string | null
          valido_desde: string | null
        }
        Insert: {
          ativo?: boolean | null
          atualizado_em?: string | null
          atualizado_por?: string | null
          criado_em?: string | null
          descricao: string
          empresa: string
          etapa_codigo: string
          fornecedor_nome: string
          id?: number
          lt_dias: number
          lt_unidade?: string
          observacoes?: string | null
          ordem: number
          parceiro_contato?: string | null
          parceiro_nome?: string | null
          parceiro_tipo?: string | null
          valido_ate?: string | null
          valido_desde?: string | null
        }
        Update: {
          ativo?: boolean | null
          atualizado_em?: string | null
          atualizado_por?: string | null
          criado_em?: string | null
          descricao?: string
          empresa?: string
          etapa_codigo?: string
          fornecedor_nome?: string
          id?: number
          lt_dias?: number
          lt_unidade?: string
          observacoes?: string | null
          ordem?: number
          parceiro_contato?: string | null
          parceiro_nome?: string | null
          parceiro_tipo?: string | null
          valido_ate?: string | null
          valido_desde?: string | null
        }
        Relationships: []
      }
      fornecedor_cadeia_logistica_historico: {
        Row: {
          acao: string
          alterado_por: string | null
          criado_em: string
          descricao_mudanca: string
          empresa: string
          etapa_codigo: string | null
          etapa_id: number | null
          fornecedor_nome: string
          id: number
          valores_anteriores: Json | null
          valores_novos: Json | null
        }
        Insert: {
          acao: string
          alterado_por?: string | null
          criado_em?: string
          descricao_mudanca: string
          empresa: string
          etapa_codigo?: string | null
          etapa_id?: number | null
          fornecedor_nome: string
          id?: number
          valores_anteriores?: Json | null
          valores_novos?: Json | null
        }
        Update: {
          acao?: string
          alterado_por?: string | null
          criado_em?: string
          descricao_mudanca?: string
          empresa?: string
          etapa_codigo?: string | null
          etapa_id?: number | null
          fornecedor_nome?: string
          id?: number
          valores_anteriores?: Json | null
          valores_novos?: Json | null
        }
        Relationships: []
      }
      fornecedor_calendario_operacao: {
        Row: {
          criado_em: string | null
          dia_semana: number
          empresa: string
          fonte_informacao: string | null
          fornecedor_nome: string
          hora_abertura: string | null
          hora_fechamento: string | null
          id: number
          observacoes: string | null
          validado_com_fornecedor: boolean | null
          validado_em: string | null
          validado_por: string | null
        }
        Insert: {
          criado_em?: string | null
          dia_semana: number
          empresa: string
          fonte_informacao?: string | null
          fornecedor_nome: string
          hora_abertura?: string | null
          hora_fechamento?: string | null
          id?: number
          observacoes?: string | null
          validado_com_fornecedor?: boolean | null
          validado_em?: string | null
          validado_por?: string | null
        }
        Update: {
          criado_em?: string | null
          dia_semana?: number
          empresa?: string
          fonte_informacao?: string | null
          fornecedor_nome?: string
          hora_abertura?: string | null
          hora_fechamento?: string | null
          id?: number
          observacoes?: string | null
          validado_com_fornecedor?: boolean | null
          validado_em?: string | null
          validado_por?: string | null
        }
        Relationships: []
      }
      fornecedor_condicao_pagamento_padrao: {
        Row: {
          empresa: string
          fonte_omie_pedido_id: string | null
          fornecedor_nome: string
          ultima_atualizacao: string | null
          ultima_condicao_codigo: string | null
          ultima_condicao_descricao: string | null
          ultimo_num_parcelas: number | null
          ultimos_dias_parcelas: string | null
        }
        Insert: {
          empresa: string
          fonte_omie_pedido_id?: string | null
          fornecedor_nome: string
          ultima_atualizacao?: string | null
          ultima_condicao_codigo?: string | null
          ultima_condicao_descricao?: string | null
          ultimo_num_parcelas?: number | null
          ultimos_dias_parcelas?: string | null
        }
        Update: {
          empresa?: string
          fonte_omie_pedido_id?: string | null
          fornecedor_nome?: string
          ultima_atualizacao?: string | null
          ultima_condicao_codigo?: string | null
          ultima_condicao_descricao?: string | null
          ultimo_num_parcelas?: number | null
          ultimos_dias_parcelas?: string | null
        }
        Relationships: []
      }
      fornecedor_custo_adicional_config: {
        Row: {
          ativo: boolean | null
          criado_em: string | null
          empresa: string
          fornecedor_nome: string
          id: number
          observacoes: string | null
          tipo: string
          valor: number
        }
        Insert: {
          ativo?: boolean | null
          criado_em?: string | null
          empresa: string
          fornecedor_nome: string
          id?: number
          observacoes?: string | null
          tipo: string
          valor: number
        }
        Update: {
          ativo?: boolean | null
          criado_em?: string | null
          empresa?: string
          fornecedor_nome?: string
          id?: number
          observacoes?: string | null
          tipo?: string
          valor?: number
        }
        Relationships: []
      }
      fornecedor_email_polling: {
        Row: {
          aceitar_imagem: boolean | null
          aceitar_pdf: boolean | null
          assunto_contem: string[] | null
          assunto_suspensao: string[] | null
          ativo: boolean | null
          atualizado_em: string | null
          criado_em: string | null
          empresa: string
          fornecedor_nome: string
          id: number
          notificar_calendar_id: string | null
          notificar_email: string | null
          observacoes: string | null
          remetente_email: string
          tipo_documento: string
          ultimo_email_processado_id: string | null
          ultimo_poll_em: string | null
        }
        Insert: {
          aceitar_imagem?: boolean | null
          aceitar_pdf?: boolean | null
          assunto_contem?: string[] | null
          assunto_suspensao?: string[] | null
          ativo?: boolean | null
          atualizado_em?: string | null
          criado_em?: string | null
          empresa: string
          fornecedor_nome: string
          id?: number
          notificar_calendar_id?: string | null
          notificar_email?: string | null
          observacoes?: string | null
          remetente_email: string
          tipo_documento?: string
          ultimo_email_processado_id?: string | null
          ultimo_poll_em?: string | null
        }
        Update: {
          aceitar_imagem?: boolean | null
          aceitar_pdf?: boolean | null
          assunto_contem?: string[] | null
          assunto_suspensao?: string[] | null
          ativo?: boolean | null
          atualizado_em?: string | null
          criado_em?: string | null
          empresa?: string
          fornecedor_nome?: string
          id?: number
          notificar_calendar_id?: string | null
          notificar_email?: string | null
          observacoes?: string | null
          remetente_email?: string
          tipo_documento?: string
          ultimo_email_processado_id?: string | null
          ultimo_poll_em?: string | null
        }
        Relationships: []
      }
      fornecedor_email_polling_log: {
        Row: {
          alertas_suspensao: number | null
          anexos_extraidos: number | null
          aumentos_criados: number | null
          campanhas_criadas: number | null
          detalhes: Json | null
          emails_encontrados: number | null
          emails_processados: number | null
          erro: string | null
          executado_em: string
          id: number
          polling_config_id: number | null
        }
        Insert: {
          alertas_suspensao?: number | null
          anexos_extraidos?: number | null
          aumentos_criados?: number | null
          campanhas_criadas?: number | null
          detalhes?: Json | null
          emails_encontrados?: number | null
          emails_processados?: number | null
          erro?: string | null
          executado_em?: string
          id?: number
          polling_config_id?: number | null
        }
        Update: {
          alertas_suspensao?: number | null
          anexos_extraidos?: number | null
          aumentos_criados?: number | null
          campanhas_criadas?: number | null
          detalhes?: Json | null
          emails_encontrados?: number | null
          emails_processados?: number | null
          erro?: string | null
          executado_em?: string
          id?: number
          polling_config_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fornecedor_email_polling_log_polling_config_id_fkey"
            columns: ["polling_config_id"]
            isOneToOne: false
            referencedRelation: "fornecedor_email_polling"
            referencedColumns: ["id"]
          },
        ]
      }
      fornecedor_excecao: {
        Row: {
          criado_em: string
          criado_por: string | null
          motivo: string | null
          user_id: string
        }
        Insert: {
          criado_em?: string
          criado_por?: string | null
          motivo?: string | null
          user_id: string
        }
        Update: {
          criado_em?: string
          criado_por?: string | null
          motivo?: string | null
          user_id?: string
        }
        Relationships: []
      }
      fornecedor_grupo_producao: {
        Row: {
          atualizado_em: string | null
          criado_em: string | null
          descricao: string | null
          empresa: string
          fornecedor_nome: string
          grupo_codigo: string
          horario_corte: string | null
          id: number
          lt_producao_dias: number
          lt_producao_unidade: string
          observacoes: string | null
        }
        Insert: {
          atualizado_em?: string | null
          criado_em?: string | null
          descricao?: string | null
          empresa: string
          fornecedor_nome: string
          grupo_codigo: string
          horario_corte?: string | null
          id?: number
          lt_producao_dias: number
          lt_producao_unidade?: string
          observacoes?: string | null
        }
        Update: {
          atualizado_em?: string | null
          criado_em?: string | null
          descricao?: string | null
          empresa?: string
          fornecedor_nome?: string
          grupo_codigo?: string
          horario_corte?: string | null
          id?: number
          lt_producao_dias?: number
          lt_producao_unidade?: string
          observacoes?: string | null
        }
        Relationships: []
      }
      fornecedor_habilitado_reposicao: {
        Row: {
          canal_pedido: string | null
          criado_em: string | null
          data_habilitacao: string | null
          delta_max_perc: number | null
          email_pedido: string | null
          empresa: string
          fornecedor_nome: string
          habilitado: boolean
          habilitado_por: string | null
          horario_corte_pedido: string | null
          id: number
          janela_override_minutos: number | null
          lt_logistica_dias: number | null
          lt_logistica_observacoes: string | null
          lt_logistica_unidade: string | null
          nome_contato: string | null
          observacoes: string | null
          observacoes_pedido: string | null
          valor_maximo_mensal: number | null
          whatsapp_pedido: string | null
        }
        Insert: {
          canal_pedido?: string | null
          criado_em?: string | null
          data_habilitacao?: string | null
          delta_max_perc?: number | null
          email_pedido?: string | null
          empresa: string
          fornecedor_nome: string
          habilitado?: boolean
          habilitado_por?: string | null
          horario_corte_pedido?: string | null
          id?: number
          janela_override_minutos?: number | null
          lt_logistica_dias?: number | null
          lt_logistica_observacoes?: string | null
          lt_logistica_unidade?: string | null
          nome_contato?: string | null
          observacoes?: string | null
          observacoes_pedido?: string | null
          valor_maximo_mensal?: number | null
          whatsapp_pedido?: string | null
        }
        Update: {
          canal_pedido?: string | null
          criado_em?: string | null
          data_habilitacao?: string | null
          delta_max_perc?: number | null
          email_pedido?: string | null
          empresa?: string
          fornecedor_nome?: string
          habilitado?: boolean
          habilitado_por?: string | null
          horario_corte_pedido?: string | null
          id?: number
          janela_override_minutos?: number | null
          lt_logistica_dias?: number | null
          lt_logistica_observacoes?: string | null
          lt_logistica_unidade?: string | null
          nome_contato?: string | null
          observacoes?: string | null
          observacoes_pedido?: string | null
          valor_maximo_mensal?: number | null
          whatsapp_pedido?: string | null
        }
        Relationships: []
      }
      fornecedor_mapeamento_extracao: {
        Row: {
          alias_extraido: string
          ativo: boolean
          criado_em: string
          id: number
          nome_canonico: string
        }
        Insert: {
          alias_extraido: string
          ativo?: boolean
          criado_em?: string
          id?: number
          nome_canonico: string
        }
        Update: {
          alias_extraido?: string
          ativo?: boolean
          criado_em?: string
          id?: number
          nome_canonico?: string
        }
        Relationships: []
      }
      fornecedor_omie_cache: {
        Row: {
          cached_at: string
          cnpj: string | null
          empresa: string
          fornecedor_nome: string
          omie_codigo_cliente_fornecedor: number
          razao_social_omie: string | null
        }
        Insert: {
          cached_at?: string
          cnpj?: string | null
          empresa: string
          fornecedor_nome: string
          omie_codigo_cliente_fornecedor: number
          razao_social_omie?: string | null
        }
        Update: {
          cached_at?: string
          cnpj?: string | null
          empresa?: string
          fornecedor_nome?: string
          omie_codigo_cliente_fornecedor?: number
          razao_social_omie?: string | null
        }
        Relationships: []
      }
      fornecedor_prazo_pagamento_config: {
        Row: {
          ativo: boolean | null
          codigo: string
          criado_em: string | null
          desconto_ou_encargo_perc: number
          empresa: string
          fornecedor_nome: string
          id: number
          nome: string
          observacoes: string | null
          padrao: boolean | null
        }
        Insert: {
          ativo?: boolean | null
          codigo: string
          criado_em?: string | null
          desconto_ou_encargo_perc: number
          empresa: string
          fornecedor_nome: string
          id?: number
          nome: string
          observacoes?: string | null
          padrao?: boolean | null
        }
        Update: {
          ativo?: boolean | null
          codigo?: string
          criado_em?: string | null
          desconto_ou_encargo_perc?: number
          empresa?: string
          fornecedor_nome?: string
          id?: number
          nome?: string
          observacoes?: string | null
          padrao?: boolean | null
        }
        Relationships: []
      }
      fornecedor_promocao: {
        Row: {
          condicao_descricao: string | null
          criado_em: string | null
          criado_por: string | null
          desconto_perc: number | null
          empresa: string
          escopo: string
          fonte: string | null
          fornecedor_nome: string
          grupo_codigo: string | null
          id: number
          observacoes: string | null
          recorrencia: string | null
          sku_codigo_omie: string | null
          tipo_desconto: string
          valido_ate: string
          valido_desde: string
          volume_minimo: number | null
        }
        Insert: {
          condicao_descricao?: string | null
          criado_em?: string | null
          criado_por?: string | null
          desconto_perc?: number | null
          empresa: string
          escopo: string
          fonte?: string | null
          fornecedor_nome: string
          grupo_codigo?: string | null
          id?: number
          observacoes?: string | null
          recorrencia?: string | null
          sku_codigo_omie?: string | null
          tipo_desconto: string
          valido_ate: string
          valido_desde: string
          volume_minimo?: number | null
        }
        Update: {
          condicao_descricao?: string | null
          criado_em?: string | null
          criado_por?: string | null
          desconto_perc?: number | null
          empresa?: string
          escopo?: string
          fonte?: string | null
          fornecedor_nome?: string
          grupo_codigo?: string | null
          id?: number
          observacoes?: string | null
          recorrencia?: string | null
          sku_codigo_omie?: string | null
          tipo_desconto?: string
          valido_ate?: string
          valido_desde?: string
          volume_minimo?: number | null
        }
        Relationships: []
      }
      gamification_scores: {
        Row: {
          consistency_score: number
          education_score: number
          efficiency_score: number
          id: string
          level: number
          level_name: string
          organization_score: number
          referral_score: number
          tool_health_index: number
          total_score: number
          updated_at: string
          user_id: string
        }
        Insert: {
          consistency_score?: number
          education_score?: number
          efficiency_score?: number
          id?: string
          level?: number
          level_name?: string
          organization_score?: number
          referral_score?: number
          tool_health_index?: number
          total_score?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          consistency_score?: number
          education_score?: number
          efficiency_score?: number
          id?: string
          level?: number
          level_name?: string
          organization_score?: number
          referral_score?: number
          tool_health_index?: number
          total_score?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      gmail_webhook_log: {
        Row: {
          alertas_criados: number[] | null
          aumentos_criados: number[] | null
          campanhas_criadas: number[] | null
          detalhes: Json | null
          erro: string | null
          id: number
          message_id: string
          processado_em: string | null
          recebido_em: string
          received_at: string | null
          remetente: string
          status: string
          subject: string | null
          tipo_documento: string | null
        }
        Insert: {
          alertas_criados?: number[] | null
          aumentos_criados?: number[] | null
          campanhas_criadas?: number[] | null
          detalhes?: Json | null
          erro?: string | null
          id?: number
          message_id: string
          processado_em?: string | null
          recebido_em?: string
          received_at?: string | null
          remetente: string
          status?: string
          subject?: string | null
          tipo_documento?: string | null
        }
        Update: {
          alertas_criados?: number[] | null
          aumentos_criados?: number[] | null
          campanhas_criadas?: number[] | null
          detalhes?: Json | null
          erro?: string | null
          id?: number
          message_id?: string
          processado_em?: string | null
          recebido_em?: string
          received_at?: string | null
          remetente?: string
          status?: string
          subject?: string | null
          tipo_documento?: string | null
        }
        Relationships: []
      }
      gov_iniciativas: {
        Row: {
          alavanca: string
          created_at: string
          created_by: string | null
          descricao: string | null
          dono_id: string | null
          empresa: string
          evidencia: string | null
          ganho_esperado_mensal: number | null
          ganho_recorrente_mensal: number | null
          id: string
          inicio_em: string | null
          recorrente_desde: string | null
          status: string
          titulo: string
          updated_at: string
        }
        Insert: {
          alavanca?: string
          created_at?: string
          created_by?: string | null
          descricao?: string | null
          dono_id?: string | null
          empresa: string
          evidencia?: string | null
          ganho_esperado_mensal?: number | null
          ganho_recorrente_mensal?: number | null
          id?: string
          inicio_em?: string | null
          recorrente_desde?: string | null
          status?: string
          titulo: string
          updated_at?: string
        }
        Update: {
          alavanca?: string
          created_at?: string
          created_by?: string | null
          descricao?: string | null
          dono_id?: string | null
          empresa?: string
          evidencia?: string | null
          ganho_esperado_mensal?: number | null
          ganho_recorrente_mensal?: number | null
          id?: string
          inicio_em?: string | null
          recorrente_desde?: string | null
          status?: string
          titulo?: string
          updated_at?: string
        }
        Relationships: []
      }
      health_score_history: {
        Row: {
          calculated_at: string
          churn_risk: number | null
          created_at: string
          customer_user_id: string
          farmer_id: string
          g_score: number | null
          health_class: string
          health_score: number
          id: string
          m_score: number | null
          rf_score: number | null
          s_score: number | null
          x_score: number | null
        }
        Insert: {
          calculated_at?: string
          churn_risk?: number | null
          created_at?: string
          customer_user_id: string
          farmer_id: string
          g_score?: number | null
          health_class?: string
          health_score?: number
          id?: string
          m_score?: number | null
          rf_score?: number | null
          s_score?: number | null
          x_score?: number | null
        }
        Update: {
          calculated_at?: string
          churn_risk?: number | null
          created_at?: string
          customer_user_id?: string
          farmer_id?: string
          g_score?: number | null
          health_class?: string
          health_score?: number
          id?: string
          m_score?: number | null
          rf_score?: number | null
          s_score?: number | null
          x_score?: number | null
        }
        Relationships: []
      }
      impersonation_audit: {
        Row: {
          actor_user_id: string
          ended_at: string | null
          id: string
          reason: string | null
          source: string
          started_at: string
          target_user_id: string
        }
        Insert: {
          actor_user_id: string
          ended_at?: string | null
          id?: string
          reason?: string | null
          source?: string
          started_at?: string
          target_user_id: string
        }
        Update: {
          actor_user_id?: string
          ended_at?: string | null
          id?: string
          reason?: string | null
          source?: string
          started_at?: string
          target_user_id?: string
        }
        Relationships: []
      }
      inventory_position: {
        Row: {
          account: string
          cmc: number | null
          created_at: string | null
          id: string
          omie_codigo_produto: number
          preco_medio: number | null
          product_id: string | null
          saldo: number | null
          synced_at: string | null
          updated_at: string | null
        }
        Insert: {
          account?: string
          cmc?: number | null
          created_at?: string | null
          id?: string
          omie_codigo_produto: number
          preco_medio?: number | null
          product_id?: string | null
          saldo?: number | null
          synced_at?: string | null
          updated_at?: string | null
        }
        Update: {
          account?: string
          cmc?: number | null
          created_at?: string | null
          id?: string
          omie_codigo_produto?: number
          preco_medio?: number | null
          product_id?: string | null
          saldo?: number | null
          synced_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_position_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_catalisador_links: {
        Row: {
          account: string
          catalisador_codigo_norm: string
          confirmed_at: string
          confirmed_by: string | null
          created_at: string
          id: string
          omie_codigo_produto: number
          status: string
          updated_at: string
        }
        Insert: {
          account: string
          catalisador_codigo_norm: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          id?: string
          omie_codigo_produto: number
          status?: string
          updated_at?: string
        }
        Update: {
          account?: string
          catalisador_codigo_norm?: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          id?: string
          omie_codigo_produto?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      kb_chunks: {
        Row: {
          char_end: number | null
          char_start: number | null
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          token_count: number | null
        }
        Insert: {
          char_end?: number | null
          char_start?: number | null
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          token_count?: number | null
        }
        Update: {
          char_end?: number | null
          char_start?: number | null
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_competitor_products: {
        Row: {
          argumentos_comparativos: Json | null
          category: string | null
          competitor_id: string
          created_at: string
          created_by: string | null
          fonte_preco: string | null
          id: string
          nosso_equivalente_product_code: string | null
          pontos_fortes: string[] | null
          pontos_fracos: string[] | null
          pot_life_horas: number | null
          preco_atualizado_em: string | null
          preco_referencia_l: number | null
          product_name: string
          rendimento_m2_por_litro: number | null
          solidos_pct: number | null
          updated_at: string
          validade_dias: number | null
        }
        Insert: {
          argumentos_comparativos?: Json | null
          category?: string | null
          competitor_id: string
          created_at?: string
          created_by?: string | null
          fonte_preco?: string | null
          id?: string
          nosso_equivalente_product_code?: string | null
          pontos_fortes?: string[] | null
          pontos_fracos?: string[] | null
          pot_life_horas?: number | null
          preco_atualizado_em?: string | null
          preco_referencia_l?: number | null
          product_name: string
          rendimento_m2_por_litro?: number | null
          solidos_pct?: number | null
          updated_at?: string
          validade_dias?: number | null
        }
        Update: {
          argumentos_comparativos?: Json | null
          category?: string | null
          competitor_id?: string
          created_at?: string
          created_by?: string | null
          fonte_preco?: string | null
          id?: string
          nosso_equivalente_product_code?: string | null
          pontos_fortes?: string[] | null
          pontos_fracos?: string[] | null
          pot_life_horas?: number | null
          preco_atualizado_em?: string | null
          preco_referencia_l?: number | null
          product_name?: string
          rendimento_m2_por_litro?: number | null
          solidos_pct?: number | null
          updated_at?: string
          validade_dias?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_competitor_products_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: false
            referencedRelation: "kb_competitors"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_competitors: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          notas_estrategicas: string | null
          regiao_principal: string | null
          segmento_atuacao: string[] | null
          tipo: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          notas_estrategicas?: string | null
          regiao_principal?: string | null
          segmento_atuacao?: string[] | null
          tipo?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          notas_estrategicas?: string | null
          regiao_principal?: string | null
          segmento_atuacao?: string[] | null
          tipo?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      kb_documents: {
        Row: {
          content_extracted: string | null
          created_at: string
          created_by: string
          file_size_bytes: number | null
          file_url: string
          id: string
          parent_id: string | null
          product_code: string | null
          status: string
          status_error: string | null
          supplier: string | null
          tags: string[] | null
          title: string
          type: string
          updated_at: string
          version: number
        }
        Insert: {
          content_extracted?: string | null
          created_at?: string
          created_by: string
          file_size_bytes?: number | null
          file_url: string
          id?: string
          parent_id?: string | null
          product_code?: string | null
          status?: string
          status_error?: string | null
          supplier?: string | null
          tags?: string[] | null
          title: string
          type: string
          updated_at?: string
          version?: number
        }
        Update: {
          content_extracted?: string | null
          created_at?: string
          created_by?: string
          file_size_bytes?: number | null
          file_url?: string
          id?: string
          parent_id?: string | null
          product_code?: string | null
          status?: string
          status_error?: string | null
          supplier?: string | null
          tags?: string[] | null
          title?: string
          type?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "kb_documents_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_extraction_drafts: {
        Row: {
          claim_token: string | null
          created_at: string
          document_id: string
          extracted_at: string | null
          last_error: string | null
          model: string | null
          spec: Json | null
          started_at: string | null
          status: string
          updated_at: string
          usage: Json | null
        }
        Insert: {
          claim_token?: string | null
          created_at?: string
          document_id: string
          extracted_at?: string | null
          last_error?: string | null
          model?: string | null
          spec?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          usage?: Json | null
        }
        Update: {
          claim_token?: string | null
          created_at?: string
          document_id?: string
          extracted_at?: string | null
          last_error?: string | null
          model?: string | null
          spec?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          usage?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_extraction_drafts_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: true
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_product_spec_versions: {
        Row: {
          approved_at: string
          approved_by: string | null
          brilho_ub: number | null
          catalisador_codigo: string | null
          catalisador_proporcao_pct: number | null
          certificacoes_aplicaveis: string[] | null
          change_note: string | null
          change_type: string
          created_at: string
          demaos_recomendadas: number | null
          densidade_g_cm3: number | null
          diferenciais_chave: string[] | null
          diluente_codigo: string | null
          dureza: string | null
          equipamentos_aplicacao: string[] | null
          extraction_confidence: number | null
          extraction_gaps: string[] | null
          gramatura_g_m2_max: number | null
          gramatura_g_m2_min: number | null
          id: string
          isento_metais_pesados: string[] | null
          isento_substancias: string[] | null
          kb_product_spec_id: string | null
          lixa_recomendada: string | null
          pot_life_horas: number | null
          product_category: string | null
          product_code: string
          product_code_normalized: string
          product_line: string | null
          product_name: string | null
          publico_alvo: string | null
          rendimento_m2_por_litro: number | null
          secagem_empilhamento_h: number | null
          secagem_manuseio_h: number | null
          secagem_total_h: number | null
          solidos_pct: number | null
          source_document_id: string | null
          substrato: string[] | null
          superseded_at: string | null
          supplier: string
          temp_aplicacao_c_max: number | null
          temp_aplicacao_c_min: number | null
          temp_armazenamento_c_max: number | null
          temp_armazenamento_c_min: number | null
          umidade_aplicacao_pct_max: number | null
          umidade_aplicacao_pct_min: number | null
          uso_recomendado: string | null
          validade_dias: number | null
          version_number: number
          viscosidade_aplicacao_s: number | null
          viscosidade_copo: string | null
        }
        Insert: {
          approved_at?: string
          approved_by?: string | null
          brilho_ub?: number | null
          catalisador_codigo?: string | null
          catalisador_proporcao_pct?: number | null
          certificacoes_aplicaveis?: string[] | null
          change_note?: string | null
          change_type: string
          created_at?: string
          demaos_recomendadas?: number | null
          densidade_g_cm3?: number | null
          diferenciais_chave?: string[] | null
          diluente_codigo?: string | null
          dureza?: string | null
          equipamentos_aplicacao?: string[] | null
          extraction_confidence?: number | null
          extraction_gaps?: string[] | null
          gramatura_g_m2_max?: number | null
          gramatura_g_m2_min?: number | null
          id?: string
          isento_metais_pesados?: string[] | null
          isento_substancias?: string[] | null
          kb_product_spec_id?: string | null
          lixa_recomendada?: string | null
          pot_life_horas?: number | null
          product_category?: string | null
          product_code: string
          product_code_normalized: string
          product_line?: string | null
          product_name?: string | null
          publico_alvo?: string | null
          rendimento_m2_por_litro?: number | null
          secagem_empilhamento_h?: number | null
          secagem_manuseio_h?: number | null
          secagem_total_h?: number | null
          solidos_pct?: number | null
          source_document_id?: string | null
          substrato?: string[] | null
          superseded_at?: string | null
          supplier: string
          temp_aplicacao_c_max?: number | null
          temp_aplicacao_c_min?: number | null
          temp_armazenamento_c_max?: number | null
          temp_armazenamento_c_min?: number | null
          umidade_aplicacao_pct_max?: number | null
          umidade_aplicacao_pct_min?: number | null
          uso_recomendado?: string | null
          validade_dias?: number | null
          version_number: number
          viscosidade_aplicacao_s?: number | null
          viscosidade_copo?: string | null
        }
        Update: {
          approved_at?: string
          approved_by?: string | null
          brilho_ub?: number | null
          catalisador_codigo?: string | null
          catalisador_proporcao_pct?: number | null
          certificacoes_aplicaveis?: string[] | null
          change_note?: string | null
          change_type?: string
          created_at?: string
          demaos_recomendadas?: number | null
          densidade_g_cm3?: number | null
          diferenciais_chave?: string[] | null
          diluente_codigo?: string | null
          dureza?: string | null
          equipamentos_aplicacao?: string[] | null
          extraction_confidence?: number | null
          extraction_gaps?: string[] | null
          gramatura_g_m2_max?: number | null
          gramatura_g_m2_min?: number | null
          id?: string
          isento_metais_pesados?: string[] | null
          isento_substancias?: string[] | null
          kb_product_spec_id?: string | null
          lixa_recomendada?: string | null
          pot_life_horas?: number | null
          product_category?: string | null
          product_code?: string
          product_code_normalized?: string
          product_line?: string | null
          product_name?: string | null
          publico_alvo?: string | null
          rendimento_m2_por_litro?: number | null
          secagem_empilhamento_h?: number | null
          secagem_manuseio_h?: number | null
          secagem_total_h?: number | null
          solidos_pct?: number | null
          source_document_id?: string | null
          substrato?: string[] | null
          superseded_at?: string | null
          supplier?: string
          temp_aplicacao_c_max?: number | null
          temp_aplicacao_c_min?: number | null
          temp_armazenamento_c_max?: number | null
          temp_armazenamento_c_min?: number | null
          umidade_aplicacao_pct_max?: number | null
          umidade_aplicacao_pct_min?: number | null
          uso_recomendado?: string | null
          validade_dias?: number | null
          version_number?: number
          viscosidade_aplicacao_s?: number | null
          viscosidade_copo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_product_spec_versions_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_product_specs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          brilho_ub: number | null
          catalisador_codigo: string | null
          catalisador_proporcao_pct: number | null
          certificacoes_aplicaveis: string[] | null
          created_at: string
          demaos_recomendadas: number | null
          densidade_g_cm3: number | null
          diferenciais_chave: string[] | null
          diluente_codigo: string | null
          document_id: string | null
          dureza: string | null
          equipamentos_aplicacao: string[] | null
          extracted_by: string | null
          extraction_confidence: number | null
          extraction_gaps: string[] | null
          gramatura_g_m2_max: number | null
          gramatura_g_m2_min: number | null
          id: string
          isento_metais_pesados: string[] | null
          isento_substancias: string[] | null
          lixa_recomendada: string | null
          pot_life_horas: number | null
          product_category: string | null
          product_code: string
          product_code_normalized: string | null
          product_line: string | null
          product_name: string
          publico_alvo: string | null
          rendimento_m2_por_litro: number | null
          secagem_empilhamento_h: number | null
          secagem_manuseio_h: number | null
          secagem_total_h: number | null
          solidos_pct: number | null
          substrato: string[] | null
          supplier: string
          temp_aplicacao_c_max: number | null
          temp_aplicacao_c_min: number | null
          temp_armazenamento_c_max: number | null
          temp_armazenamento_c_min: number | null
          umidade_aplicacao_pct_max: number | null
          umidade_aplicacao_pct_min: number | null
          updated_at: string
          uso_recomendado: string | null
          validade_dias: number | null
          viscosidade_aplicacao_s: number | null
          viscosidade_copo: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          brilho_ub?: number | null
          catalisador_codigo?: string | null
          catalisador_proporcao_pct?: number | null
          certificacoes_aplicaveis?: string[] | null
          created_at?: string
          demaos_recomendadas?: number | null
          densidade_g_cm3?: number | null
          diferenciais_chave?: string[] | null
          diluente_codigo?: string | null
          document_id?: string | null
          dureza?: string | null
          equipamentos_aplicacao?: string[] | null
          extracted_by?: string | null
          extraction_confidence?: number | null
          extraction_gaps?: string[] | null
          gramatura_g_m2_max?: number | null
          gramatura_g_m2_min?: number | null
          id?: string
          isento_metais_pesados?: string[] | null
          isento_substancias?: string[] | null
          lixa_recomendada?: string | null
          pot_life_horas?: number | null
          product_category?: string | null
          product_code: string
          product_code_normalized?: string | null
          product_line?: string | null
          product_name: string
          publico_alvo?: string | null
          rendimento_m2_por_litro?: number | null
          secagem_empilhamento_h?: number | null
          secagem_manuseio_h?: number | null
          secagem_total_h?: number | null
          solidos_pct?: number | null
          substrato?: string[] | null
          supplier?: string
          temp_aplicacao_c_max?: number | null
          temp_aplicacao_c_min?: number | null
          temp_armazenamento_c_max?: number | null
          temp_armazenamento_c_min?: number | null
          umidade_aplicacao_pct_max?: number | null
          umidade_aplicacao_pct_min?: number | null
          updated_at?: string
          uso_recomendado?: string | null
          validade_dias?: number | null
          viscosidade_aplicacao_s?: number | null
          viscosidade_copo?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          brilho_ub?: number | null
          catalisador_codigo?: string | null
          catalisador_proporcao_pct?: number | null
          certificacoes_aplicaveis?: string[] | null
          created_at?: string
          demaos_recomendadas?: number | null
          densidade_g_cm3?: number | null
          diferenciais_chave?: string[] | null
          diluente_codigo?: string | null
          document_id?: string | null
          dureza?: string | null
          equipamentos_aplicacao?: string[] | null
          extracted_by?: string | null
          extraction_confidence?: number | null
          extraction_gaps?: string[] | null
          gramatura_g_m2_max?: number | null
          gramatura_g_m2_min?: number | null
          id?: string
          isento_metais_pesados?: string[] | null
          isento_substancias?: string[] | null
          lixa_recomendada?: string | null
          pot_life_horas?: number | null
          product_category?: string | null
          product_code?: string
          product_code_normalized?: string | null
          product_line?: string | null
          product_name?: string
          publico_alvo?: string | null
          rendimento_m2_por_litro?: number | null
          secagem_empilhamento_h?: number | null
          secagem_manuseio_h?: number | null
          secagem_total_h?: number | null
          solidos_pct?: number | null
          substrato?: string[] | null
          supplier?: string
          temp_aplicacao_c_max?: number | null
          temp_aplicacao_c_min?: number | null
          temp_armazenamento_c_max?: number | null
          temp_armazenamento_c_min?: number | null
          umidade_aplicacao_pct_max?: number | null
          umidade_aplicacao_pct_min?: number | null
          updated_at?: string
          uso_recomendado?: string | null
          validade_dias?: number | null
          viscosidade_aplicacao_s?: number | null
          viscosidade_copo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_product_specs_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_points: {
        Row: {
          created_at: string
          description: string | null
          id: string
          order_id: string | null
          points: number
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          order_id?: string | null
          points?: number
          type?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          order_id?: string | null
          points?: number
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_points_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_redemptions: {
        Row: {
          created_at: string
          id: string
          points_spent: number
          reward_name: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          points_spent: number
          reward_name: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          points_spent?: number
          reward_name?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      margin_audit_log: {
        Row: {
          calculated_at: string
          created_at: string | null
          customer_user_id: string
          farmer_id: string
          gap_pct: number | null
          id: string
          margin_gap: number | null
          margin_potential: number | null
          margin_real: number | null
          period_end: string
          period_start: string
          top_gap_products: Json | null
        }
        Insert: {
          calculated_at?: string
          created_at?: string | null
          customer_user_id: string
          farmer_id: string
          gap_pct?: number | null
          id?: string
          margin_gap?: number | null
          margin_potential?: number | null
          margin_real?: number | null
          period_end: string
          period_start: string
          top_gap_products?: Json | null
        }
        Update: {
          calculated_at?: string
          created_at?: string | null
          customer_user_id?: string
          farmer_id?: string
          gap_pct?: number | null
          id?: string
          margin_gap?: number | null
          margin_potential?: number | null
          margin_real?: number | null
          period_end?: string
          period_start?: string
          top_gap_products?: Json | null
        }
        Relationships: []
      }
      markup_policy: {
        Row: {
          account: string
          escopo: string
          familia: string | null
          id: string
          meta_markup: number
          piso_markup: number
          sku_codigo: number | null
          tier: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account: string
          escopo: string
          familia?: string | null
          id?: string
          meta_markup: number
          piso_markup: number
          sku_codigo?: number | null
          tier?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account?: string
          escopo?: string
          familia?: string | null
          id?: string
          meta_markup?: number
          piso_markup?: number
          sku_codigo?: number | null
          tier?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      melhoria_itens: {
        Row: {
          autor_user_id: string
          avaliacao_founder: string | null
          created_at: string
          empresa: string
          id: string
          modulo: string | null
          resolvido_em: string | null
          resposta_founder: string | null
          rota_origem: string | null
          status: string
          tipo: string | null
          titulo: string | null
          triagem_status: string
          updated_at: string
          urgencia: string | null
        }
        Insert: {
          autor_user_id: string
          avaliacao_founder?: string | null
          created_at?: string
          empresa: string
          id?: string
          modulo?: string | null
          resolvido_em?: string | null
          resposta_founder?: string | null
          rota_origem?: string | null
          status?: string
          tipo?: string | null
          titulo?: string | null
          triagem_status?: string
          updated_at?: string
          urgencia?: string | null
        }
        Update: {
          autor_user_id?: string
          avaliacao_founder?: string | null
          created_at?: string
          empresa?: string
          id?: string
          modulo?: string | null
          resolvido_em?: string | null
          resposta_founder?: string | null
          rota_origem?: string | null
          status?: string
          tipo?: string | null
          titulo?: string | null
          triagem_status?: string
          updated_at?: string
          urgencia?: string | null
        }
        Relationships: []
      }
      melhoria_mensagens: {
        Row: {
          autor_user_id: string | null
          conteudo: string
          created_at: string
          dados: Json | null
          id: string
          item_id: string
          papel: string
        }
        Insert: {
          autor_user_id?: string | null
          conteudo: string
          created_at?: string
          dados?: Json | null
          id?: string
          item_id: string
          papel: string
        }
        Update: {
          autor_user_id?: string | null
          conteudo?: string
          created_at?: string
          dados?: Json | null
          id?: string
          item_id?: string
          papel?: string
        }
        Relationships: [
          {
            foreignKeyName: "melhoria_mensagens_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "melhoria_itens"
            referencedColumns: ["id"]
          },
        ]
      }
      municipio_geo: {
        Row: {
          lat: number
          lng: number
          municipio_codigo: string
          nome: string | null
          source: string
          uf: string | null
        }
        Insert: {
          lat: number
          lng: number
          municipio_codigo: string
          nome?: string | null
          source?: string
          uf?: string | null
        }
        Update: {
          lat?: number
          lng?: number
          municipio_codigo?: string
          nome?: string | null
          source?: string
          uf?: string | null
        }
        Relationships: []
      }
      nfe_efetivacao_tentativas: {
        Row: {
          created_at: string
          erro: string | null
          id: string
          item_id: string | null
          nfe_recebimento_id: string
          omie_status: string | null
          operacao: string
          sucesso: boolean
          tentativa: number
        }
        Insert: {
          created_at?: string
          erro?: string | null
          id?: string
          item_id?: string | null
          nfe_recebimento_id: string
          omie_status?: string | null
          operacao: string
          sucesso: boolean
          tentativa?: number
        }
        Update: {
          created_at?: string
          erro?: string | null
          id?: string
          item_id?: string | null
          nfe_recebimento_id?: string
          omie_status?: string | null
          operacao?: string
          sucesso?: boolean
          tentativa?: number
        }
        Relationships: [
          {
            foreignKeyName: "nfe_efetivacao_tentativas_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "nfe_recebimento_itens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nfe_efetivacao_tentativas_nfe_recebimento_id_fkey"
            columns: ["nfe_recebimento_id"]
            isOneToOne: false
            referencedRelation: "nfe_recebimentos"
            referencedColumns: ["id"]
          },
        ]
      }
      nfe_lotes_escaneados: {
        Row: {
          data_fabricacao: string | null
          data_validade: string | null
          escaneado_at: string
          escaneado_por: string | null
          id: string
          metodo_leitura: string
          nfe_recebimento_item_id: string
          numero_lote: string
        }
        Insert: {
          data_fabricacao?: string | null
          data_validade?: string | null
          escaneado_at?: string
          escaneado_por?: string | null
          id?: string
          metodo_leitura?: string
          nfe_recebimento_item_id: string
          numero_lote: string
        }
        Update: {
          data_fabricacao?: string | null
          data_validade?: string | null
          escaneado_at?: string
          escaneado_por?: string | null
          id?: string
          metodo_leitura?: string
          nfe_recebimento_item_id?: string
          numero_lote?: string
        }
        Relationships: [
          {
            foreignKeyName: "nfe_lotes_escaneados_nfe_recebimento_item_id_fkey"
            columns: ["nfe_recebimento_item_id"]
            isOneToOne: false
            referencedRelation: "nfe_recebimento_itens"
            referencedColumns: ["id"]
          },
        ]
      }
      nfe_recebimento_itens: {
        Row: {
          ajuste_estoque_at: string | null
          ajuste_estoque_ok: boolean
          ajuste_estoque_omie_id: string | null
          codigo_produto: string | null
          created_at: string
          descricao: string
          ean: string | null
          id: string
          ncm: string | null
          nfe_recebimento_id: string
          observacao_divergencia: string | null
          produto_omie_id: number | null
          quantidade_conferida: number
          quantidade_convertida: number | null
          quantidade_esperada: number
          quantidade_nfe: number
          sequencia: number
          status_item: string
          unidade_estoque: string | null
          unidade_nfe: string
          valor_total: number | null
          valor_unitario: number | null
        }
        Insert: {
          ajuste_estoque_at?: string | null
          ajuste_estoque_ok?: boolean
          ajuste_estoque_omie_id?: string | null
          codigo_produto?: string | null
          created_at?: string
          descricao: string
          ean?: string | null
          id?: string
          ncm?: string | null
          nfe_recebimento_id: string
          observacao_divergencia?: string | null
          produto_omie_id?: number | null
          quantidade_conferida?: number
          quantidade_convertida?: number | null
          quantidade_esperada: number
          quantidade_nfe: number
          sequencia: number
          status_item?: string
          unidade_estoque?: string | null
          unidade_nfe: string
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Update: {
          ajuste_estoque_at?: string | null
          ajuste_estoque_ok?: boolean
          ajuste_estoque_omie_id?: string | null
          codigo_produto?: string | null
          created_at?: string
          descricao?: string
          ean?: string | null
          id?: string
          ncm?: string | null
          nfe_recebimento_id?: string
          observacao_divergencia?: string | null
          produto_omie_id?: number | null
          quantidade_conferida?: number
          quantidade_convertida?: number | null
          quantidade_esperada?: number
          quantidade_nfe?: number
          sequencia?: number
          status_item?: string
          unidade_estoque?: string | null
          unidade_nfe?: string
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "nfe_recebimento_itens_nfe_recebimento_id_fkey"
            columns: ["nfe_recebimento_id"]
            isOneToOne: false
            referencedRelation: "nfe_recebimentos"
            referencedColumns: ["id"]
          },
        ]
      }
      nfe_recebimentos: {
        Row: {
          alterar_etapa_ok: boolean
          alterar_recebimento_ok: boolean
          chave_acesso: string
          cnpj_emitente: string
          concluir_recebimento_ok: boolean
          conferente_id: string | null
          conferido_at: string | null
          created_at: string
          cte_ok: boolean
          data_emissao: string | null
          efetivacao_erro: string | null
          efetivacao_lock_at: string | null
          efetivacao_tentativas: number
          efetivado_at: string | null
          id: string
          numero_nfe: string
          observacoes: string | null
          omie_id_receb: number | null
          omie_nfe_id: number | null
          razao_social_emitente: string | null
          serie_nfe: string | null
          status: string
          updated_at: string
          valor_total: number | null
          warehouse_id: string
          xml_completo: string | null
        }
        Insert: {
          alterar_etapa_ok?: boolean
          alterar_recebimento_ok?: boolean
          chave_acesso: string
          cnpj_emitente: string
          concluir_recebimento_ok?: boolean
          conferente_id?: string | null
          conferido_at?: string | null
          created_at?: string
          cte_ok?: boolean
          data_emissao?: string | null
          efetivacao_erro?: string | null
          efetivacao_lock_at?: string | null
          efetivacao_tentativas?: number
          efetivado_at?: string | null
          id?: string
          numero_nfe: string
          observacoes?: string | null
          omie_id_receb?: number | null
          omie_nfe_id?: number | null
          razao_social_emitente?: string | null
          serie_nfe?: string | null
          status?: string
          updated_at?: string
          valor_total?: number | null
          warehouse_id: string
          xml_completo?: string | null
        }
        Update: {
          alterar_etapa_ok?: boolean
          alterar_recebimento_ok?: boolean
          chave_acesso?: string
          cnpj_emitente?: string
          concluir_recebimento_ok?: boolean
          conferente_id?: string | null
          conferido_at?: string | null
          created_at?: string
          cte_ok?: boolean
          data_emissao?: string | null
          efetivacao_erro?: string | null
          efetivacao_lock_at?: string | null
          efetivacao_tentativas?: number
          efetivado_at?: string | null
          id?: string
          numero_nfe?: string
          observacoes?: string | null
          omie_id_receb?: number | null
          omie_nfe_id?: number | null
          razao_social_emitente?: string | null
          serie_nfe?: string | null
          status?: string
          updated_at?: string
          valor_total?: number | null
          warehouse_id?: string
          xml_completo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nfe_recebimentos_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      observacoes_excluidas: {
        Row: {
          data_observacao: string
          empresa: string
          evento_outlier_id: number | null
          excluido_em: string | null
          excluido_por: string | null
          id: number
          justificativa: string | null
          referencia_original: string | null
          sku_codigo_omie: string
          tipo_observacao: string
          valor_excluido: number | null
        }
        Insert: {
          data_observacao: string
          empresa: string
          evento_outlier_id?: number | null
          excluido_em?: string | null
          excluido_por?: string | null
          id?: number
          justificativa?: string | null
          referencia_original?: string | null
          sku_codigo_omie: string
          tipo_observacao: string
          valor_excluido?: number | null
        }
        Update: {
          data_observacao?: string
          empresa?: string
          evento_outlier_id?: number | null
          excluido_em?: string | null
          excluido_por?: string | null
          id?: number
          justificativa?: string | null
          referencia_original?: string | null
          sku_codigo_omie?: string
          tipo_observacao?: string
          valor_excluido?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "observacoes_excluidas_evento_outlier_id_fkey"
            columns: ["evento_outlier_id"]
            isOneToOne: false
            referencedRelation: "eventos_outlier"
            referencedColumns: ["id"]
          },
        ]
      }
      omie_clientes_nao_vinculados: {
        Row: {
          cidade: string | null
          cnpj_cpf: string | null
          codigo_vendedor: number | null
          created_at: string
          empresa: string
          id: string
          nome_fantasia: string | null
          omie_codigo_cliente: number
          razao_social: string | null
          synced_at: string
          uf: string | null
        }
        Insert: {
          cidade?: string | null
          cnpj_cpf?: string | null
          codigo_vendedor?: number | null
          created_at?: string
          empresa: string
          id?: string
          nome_fantasia?: string | null
          omie_codigo_cliente: number
          razao_social?: string | null
          synced_at: string
          uf?: string | null
        }
        Update: {
          cidade?: string | null
          cnpj_cpf?: string | null
          codigo_vendedor?: number | null
          created_at?: string
          empresa?: string
          id?: string
          nome_fantasia?: string | null
          omie_codigo_cliente?: number
          razao_social?: string | null
          synced_at?: string
          uf?: string | null
        }
        Relationships: []
      }
      omie_condicao_pagamento_catalogo: {
        Row: {
          ativo: boolean | null
          codigo: string
          descricao: string | null
          dias_parcelas: string | null
          empresa: string
          num_parcelas: number | null
          ultima_sincronizacao: string | null
        }
        Insert: {
          ativo?: boolean | null
          codigo: string
          descricao?: string | null
          dias_parcelas?: string | null
          empresa: string
          num_parcelas?: number | null
          ultima_sincronizacao?: string | null
        }
        Update: {
          ativo?: boolean | null
          codigo?: string
          descricao?: string | null
          dias_parcelas?: string | null
          empresa?: string
          num_parcelas?: number | null
          ultima_sincronizacao?: string | null
        }
        Relationships: []
      }
      omie_customer_account_map: {
        Row: {
          account: string
          created_at: string
          id: string
          omie_codigo_cliente: number
          omie_codigo_vendedor: number | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account: string
          created_at?: string
          id?: string
          omie_codigo_cliente: number
          omie_codigo_vendedor?: number | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account?: string
          created_at?: string
          id?: string
          omie_codigo_cliente?: number
          omie_codigo_vendedor?: number | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      omie_nao_vinculados_state: {
        Row: {
          current_run_ts: string | null
          empresa: string
          error_message: string | null
          last_complete_synced_at: string | null
          started_at: string | null
          status: string
          total: number | null
          updated_at: string
        }
        Insert: {
          current_run_ts?: string | null
          empresa: string
          error_message?: string | null
          last_complete_synced_at?: string | null
          started_at?: string | null
          status?: string
          total?: number | null
          updated_at?: string
        }
        Update: {
          current_run_ts?: string | null
          empresa?: string
          error_message?: string | null
          last_complete_synced_at?: string | null
          started_at?: string | null
          status?: string
          total?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      omie_ordens_servico: {
        Row: {
          created_at: string
          id: string
          last_etapa_sincronizada: string | null
          last_status_sincronizado: string | null
          last_sync_at: string | null
          last_sync_error: string | null
          omie_codigo_os: number | null
          omie_numero_os: string
          order_id: string
          payload_enviado: Json | null
          resposta_omie: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_etapa_sincronizada?: string | null
          last_status_sincronizado?: string | null
          last_sync_at?: string | null
          last_sync_error?: string | null
          omie_codigo_os?: number | null
          omie_numero_os: string
          order_id: string
          payload_enviado?: Json | null
          resposta_omie?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_etapa_sincronizada?: string | null
          last_status_sincronizado?: string | null
          last_sync_at?: string | null
          last_sync_error?: string | null
          omie_codigo_os?: number | null
          omie_numero_os?: string
          order_id?: string
          payload_enviado?: Json | null
          resposta_omie?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      omie_product_spec_links: {
        Row: {
          account: string
          confirmed_at: string
          confirmed_by: string | null
          created_at: string
          id: string
          kb_product_spec_id: string
          omie_codigo_produto: number
          status: string
          updated_at: string
        }
        Insert: {
          account: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          id?: string
          kb_product_spec_id: string
          omie_codigo_produto: number
          status?: string
          updated_at?: string
        }
        Update: {
          account?: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          id?: string
          kb_product_spec_id?: string
          omie_codigo_produto?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "omie_product_spec_links_kb_product_spec_id_fkey"
            columns: ["kb_product_spec_id"]
            isOneToOne: false
            referencedRelation: "kb_product_specs"
            referencedColumns: ["id"]
          },
        ]
      }
      omie_products: {
        Row: {
          account: string
          ativo: boolean
          codigo: string
          created_at: string
          descricao: string
          estoque: number | null
          familia: string | null
          id: string
          imagem_url: string | null
          is_tintometric: boolean | null
          metadata: Json | null
          ncm: string | null
          omie_codigo_produto: number
          omie_codigo_produto_integracao: string | null
          subfamilia: string | null
          tint_type: string | null
          tipo_produto: string | null
          unidade: string
          updated_at: string
          valor_unitario: number
        }
        Insert: {
          account?: string
          ativo?: boolean
          codigo: string
          created_at?: string
          descricao: string
          estoque?: number | null
          familia?: string | null
          id?: string
          imagem_url?: string | null
          is_tintometric?: boolean | null
          metadata?: Json | null
          ncm?: string | null
          omie_codigo_produto: number
          omie_codigo_produto_integracao?: string | null
          subfamilia?: string | null
          tint_type?: string | null
          tipo_produto?: string | null
          unidade?: string
          updated_at?: string
          valor_unitario?: number
        }
        Update: {
          account?: string
          ativo?: boolean
          codigo?: string
          created_at?: string
          descricao?: string
          estoque?: number | null
          familia?: string | null
          id?: string
          imagem_url?: string | null
          is_tintometric?: boolean | null
          metadata?: Json | null
          ncm?: string | null
          omie_codigo_produto?: number
          omie_codigo_produto_integracao?: string | null
          subfamilia?: string | null
          tint_type?: string | null
          tipo_produto?: string | null
          unidade?: string
          updated_at?: string
          valor_unitario?: number
        }
        Relationships: []
      }
      omie_servicos: {
        Row: {
          app_service_type: string
          created_at: string
          descricao: string
          id: string
          inativo: boolean
          omie_codigo_integracao: string | null
          omie_codigo_servico: number
          updated_at: string
        }
        Insert: {
          app_service_type: string
          created_at?: string
          descricao: string
          id?: string
          inativo?: boolean
          omie_codigo_integracao?: string | null
          omie_codigo_servico: number
          updated_at?: string
        }
        Update: {
          app_service_type?: string
          created_at?: string
          descricao?: string
          id?: string
          inativo?: boolean
          omie_codigo_integracao?: string | null
          omie_codigo_servico?: number
          updated_at?: string
        }
        Relationships: []
      }
      omie_vendedor_map: {
        Row: {
          created_at: string
          id: string
          nome: string | null
          omie_account: string
          omie_codigo_vendedor: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          nome?: string | null
          omie_account: string
          omie_codigo_vendedor: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          nome?: string | null
          omie_account?: string
          omie_codigo_vendedor?: number
          user_id?: string
        }
        Relationships: []
      }
      omie_webhook_events: {
        Row: {
          author_id: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          event_id: string
          id: string
          message_id: string | null
          payload: Json
          processed_at: string | null
          processing_error: string | null
          received_at: string
          retry_count: number
          topic: string
        }
        Insert: {
          author_id?: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          event_id: string
          id?: string
          message_id?: string | null
          payload: Json
          processed_at?: string | null
          processing_error?: string | null
          received_at?: string
          retry_count?: number
          topic: string
        }
        Update: {
          author_id?: string | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          event_id?: string
          id?: string
          message_id?: string | null
          payload?: Json
          processed_at?: string | null
          processing_error?: string | null
          received_at?: string
          retry_count?: number
          topic?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          created_at: string | null
          customer_user_id: string
          discount: number | null
          hash_payload: string | null
          id: string
          omie_codigo_produto: number | null
          product_id: string | null
          quantity: number
          sales_order_id: string
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          customer_user_id: string
          discount?: number | null
          hash_payload?: string | null
          id?: string
          omie_codigo_produto?: number | null
          product_id?: string | null
          quantity?: number
          sales_order_id: string
          unit_price?: number
        }
        Update: {
          created_at?: string | null
          customer_user_id?: string
          discount?: number | null
          hash_payload?: string | null
          id?: string
          omie_codigo_produto?: number | null
          product_id?: string | null
          quantity?: number
          sales_order_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      order_messages: {
        Row: {
          created_at: string
          id: string
          is_staff: boolean
          message: string
          order_id: string
          read_at: string | null
          sender_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_staff?: boolean
          message: string
          order_id: string
          read_at?: string | null
          sender_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_staff?: boolean
          message?: string
          order_id?: string
          read_at?: string | null
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_messages_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_price_history: {
        Row: {
          created_at: string
          id: string
          service_type: string
          unit_price: number
          user_id: string
          user_tool_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          service_type: string
          unit_price: number
          user_id: string
          user_tool_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          service_type?: string
          unit_price?: number
          user_id?: string
          user_tool_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_price_history_user_tool_id_fkey"
            columns: ["user_tool_id"]
            isOneToOne: false
            referencedRelation: "user_tools"
            referencedColumns: ["id"]
          },
        ]
      }
      order_reviews: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          order_id: string
          rating: number
          user_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          order_id: string
          rating: number
          user_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          order_id?: string
          rating?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_reviews_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          address: Json | null
          created_at: string
          delivery_fee: number
          delivery_option: string
          id: string
          items: Json
          notes: string | null
          service_type: string
          status: string
          subtotal: number
          time_slot: string | null
          total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: Json | null
          created_at?: string
          delivery_fee?: number
          delivery_option: string
          id?: string
          items?: Json
          notes?: string | null
          service_type: string
          status?: string
          subtotal?: number
          time_slot?: string | null
          total?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: Json | null
          created_at?: string
          delivery_fee?: number
          delivery_option?: string
          id?: string
          items?: Json
          notes?: string | null
          service_type?: string
          status?: string
          subtotal?: number
          time_slot?: string | null
          total?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pcp_bom_excecoes: {
        Row: {
          componente_codigo: number
          componente_descricao: string | null
          disposicao: string | null
          disposicao_nota: string | null
          esperado: number | null
          materializado_em: string
          observado: number | null
          pai_codigo: number
          pai_descricao: string | null
          papel: string
          status: string
          unidade: string | null
        }
        Insert: {
          componente_codigo: number
          componente_descricao?: string | null
          disposicao?: string | null
          disposicao_nota?: string | null
          esperado?: number | null
          materializado_em?: string
          observado?: number | null
          pai_codigo: number
          pai_descricao?: string | null
          papel: string
          status: string
          unidade?: string | null
        }
        Update: {
          componente_codigo?: number
          componente_descricao?: string | null
          disposicao?: string | null
          disposicao_nota?: string | null
          esperado?: number | null
          materializado_em?: string
          observado?: number | null
          pai_codigo?: number
          pai_descricao?: string | null
          papel?: string
          status?: string
          unidade?: string | null
        }
        Relationships: []
      }
      pcp_bom_regras: {
        Row: {
          amostras: number
          coef: number | null
          derivado_em: string
          dispersao: number | null
          largura_mm: number
          linha_modelo: string
          metodo: string
          papel: string
        }
        Insert: {
          amostras: number
          coef?: number | null
          derivado_em?: string
          dispersao?: number | null
          largura_mm?: number
          linha_modelo: string
          metodo: string
          papel: string
        }
        Update: {
          amostras?: number
          coef?: number | null
          derivado_em?: string
          dispersao?: number | null
          largura_mm?: number
          linha_modelo?: string
          metodo?: string
          papel?: string
        }
        Relationships: []
      }
      pcp_bom_rota_saidas: {
        Row: {
          fracao_rateio: number
          id: number
          largura_saida_mm: number
          papel: string
          quantidade: number
          rota_id: number
        }
        Insert: {
          fracao_rateio: number
          id?: never
          largura_saida_mm: number
          papel: string
          quantidade: number
          rota_id: number
        }
        Update: {
          fracao_rateio?: number
          id?: never
          largura_saida_mm?: number
          papel?: string
          quantidade?: number
          rota_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "pcp_bom_rota_saidas_rota_id_fkey"
            columns: ["rota_id"]
            isOneToOne: false
            referencedRelation: "pcp_bom_rotas"
            referencedColumns: ["id"]
          },
        ]
      }
      pcp_bom_rotas: {
        Row: {
          ativa: boolean
          esquema: string
          id: number
          largura_alvo_mm: number
          largura_base_mm: number
          linha_modelo: string
          nota: string | null
        }
        Insert: {
          ativa?: boolean
          esquema?: string
          id?: never
          largura_alvo_mm: number
          largura_base_mm: number
          linha_modelo: string
          nota?: string | null
        }
        Update: {
          ativa?: boolean
          esquema?: string
          id?: never
          largura_alvo_mm?: number
          largura_base_mm?: number
          linha_modelo?: string
          nota?: string | null
        }
        Relationships: []
      }
      pcp_config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      pcp_custo_excecoes: {
        Row: {
          classe_causa: string
          custo_padrao_total: number | null
          custo_status: string
          data_posicao: string
          derivado_em: string
          divergencia_abs: number | null
          divergencia_pct: number | null
          impacto_r: number
          ncmc_acabado: number | null
          omie_codigo_produto: number
          tipo_item: string | null
          versao_regra: string
        }
        Insert: {
          classe_causa: string
          custo_padrao_total?: number | null
          custo_status: string
          data_posicao: string
          derivado_em?: string
          divergencia_abs?: number | null
          divergencia_pct?: number | null
          impacto_r: number
          ncmc_acabado?: number | null
          omie_codigo_produto: number
          tipo_item?: string | null
          versao_regra: string
        }
        Update: {
          classe_causa?: string
          custo_padrao_total?: number | null
          custo_status?: string
          data_posicao?: string
          derivado_em?: string
          divergencia_abs?: number | null
          divergencia_pct?: number | null
          impacto_r?: number
          ncmc_acabado?: number | null
          omie_codigo_produto?: number
          tipo_item?: string | null
          versao_regra?: string
        }
        Relationships: []
      }
      pcp_custo_padrao_resultados: {
        Row: {
          custo_abrasivo: number | null
          custo_catalisador: number | null
          custo_cola: number | null
          custo_fita: number | null
          custo_outros: number | null
          custo_status: string
          custo_total: number | null
          data_posicao: string
          derivado_em: string
          detalhe: Json | null
          n_componentes: number
          n_incompletos: number
          omie_codigo_produto: number
          tipo_item: string | null
          versao_regra: string
        }
        Insert: {
          custo_abrasivo?: number | null
          custo_catalisador?: number | null
          custo_cola?: number | null
          custo_fita?: number | null
          custo_outros?: number | null
          custo_status: string
          custo_total?: number | null
          data_posicao: string
          derivado_em?: string
          detalhe?: Json | null
          n_componentes: number
          n_incompletos: number
          omie_codigo_produto: number
          tipo_item?: string | null
          versao_regra: string
        }
        Update: {
          custo_abrasivo?: number | null
          custo_catalisador?: number | null
          custo_cola?: number | null
          custo_fita?: number | null
          custo_outros?: number | null
          custo_status?: string
          custo_total?: number | null
          data_posicao?: string
          derivado_em?: string
          detalhe?: Json | null
          n_componentes?: number
          n_incompletos?: number
          omie_codigo_produto?: number
          tipo_item?: string | null
          versao_regra?: string
        }
        Relationships: []
      }
      pcp_etapas_catalogo: {
        Row: {
          bloqueante: boolean
          centro: string
          etapa: string
          familia: string
          ordem: number
          tempo_padrao_seg: number | null
        }
        Insert: {
          bloqueante?: boolean
          centro: string
          etapa: string
          familia: string
          ordem: number
          tempo_padrao_seg?: number | null
        }
        Update: {
          bloqueante?: boolean
          centro?: string
          etapa?: string
          familia?: string
          ordem?: number
          tempo_padrao_seg?: number | null
        }
        Relationships: []
      }
      pcp_eventos_producao: {
        Row: {
          account: string
          client_ts: string
          componente_codigo: number | null
          criado_por: string | null
          device_id: string
          device_seq: number
          etapa: string | null
          id: string
          motivo: string | null
          nota: string | null
          op_id: string
          quantidade: number | null
          server_ts: string
          tipo: string
          unidade: string | null
        }
        Insert: {
          account?: string
          client_ts: string
          componente_codigo?: number | null
          criado_por?: string | null
          device_id: string
          device_seq: number
          etapa?: string | null
          id: string
          motivo?: string | null
          nota?: string | null
          op_id: string
          quantidade?: number | null
          server_ts?: string
          tipo: string
          unidade?: string | null
        }
        Update: {
          account?: string
          client_ts?: string
          componente_codigo?: number | null
          criado_por?: string | null
          device_id?: string
          device_seq?: number
          etapa?: string | null
          id?: string
          motivo?: string | null
          nota?: string | null
          op_id?: string
          quantidade?: number | null
          server_ts?: string
          tipo?: string
          unidade?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pcp_eventos_producao_op_id_fkey"
            columns: ["op_id"]
            isOneToOne: false
            referencedRelation: "production_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pcp_itens: {
        Row: {
          codigo: string | null
          comprimento_mm: number | null
          descricao: string
          diametro_mm: number | null
          empresa: string
          familia: string | null
          formato_parse: string
          grao: number | null
          largura_mm: number | null
          leadtime_padrao_dias: number | null
          linha_modelo: string | null
          lote_minimo: number | null
          lote_multiplo: number | null
          omie_codigo_produto: number
          politica: string | null
          refreshed_at: string
          tipo_item: string
          tipo_produto: string | null
        }
        Insert: {
          codigo?: string | null
          comprimento_mm?: number | null
          descricao: string
          diametro_mm?: number | null
          empresa?: string
          familia?: string | null
          formato_parse: string
          grao?: number | null
          largura_mm?: number | null
          leadtime_padrao_dias?: number | null
          linha_modelo?: string | null
          lote_minimo?: number | null
          lote_multiplo?: number | null
          omie_codigo_produto: number
          politica?: string | null
          refreshed_at?: string
          tipo_item: string
          tipo_produto?: string | null
        }
        Update: {
          codigo?: string | null
          comprimento_mm?: number | null
          descricao?: string
          diametro_mm?: number | null
          empresa?: string
          familia?: string | null
          formato_parse?: string
          grao?: number | null
          largura_mm?: number | null
          leadtime_padrao_dias?: number | null
          linha_modelo?: string | null
          lote_minimo?: number | null
          lote_multiplo?: number | null
          omie_codigo_produto?: number
          politica?: string | null
          refreshed_at?: string
          tipo_item?: string
          tipo_produto?: string | null
        }
        Relationships: []
      }
      pcp_malha_staging: {
        Row: {
          empresa: string
          omie_codigo_produto: number
          payload: Json
          sync_run_id: number
          synced_at: string
        }
        Insert: {
          empresa?: string
          omie_codigo_produto: number
          payload: Json
          sync_run_id: number
          synced_at?: string
        }
        Update: {
          empresa?: string
          omie_codigo_produto?: number
          payload?: Json
          sync_run_id?: number
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pcp_malha_staging_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "pcp_run_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      pcp_run_logs: {
        Row: {
          detalhe: Json
          empresa: string
          finished_at: string | null
          funcao: string
          id: number
          paginas: number | null
          registros: number | null
          started_at: string
          status: string
        }
        Insert: {
          detalhe?: Json
          empresa?: string
          finished_at?: string | null
          funcao: string
          id?: never
          paginas?: number | null
          registros?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          detalhe?: Json
          empresa?: string
          finished_at?: string | null
          funcao?: string
          id?: never
          paginas?: number | null
          registros?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      pedido_compra_item: {
        Row: {
          ajustado_humano: boolean | null
          criado_em: string | null
          desconto_perc_aplicado: number | null
          economia_estimada_valor: number | null
          estoque_a_caminho: number | null
          estoque_atual: number | null
          estoque_fisico: number | null
          estoque_maximo: number | null
          id: number
          modo_promocao: string | null
          pedido_id: number
          ponto_pedido: number | null
          preco_sem_desconto: number | null
          preco_unitario: number | null
          primeira_compra: boolean | null
          promocao_item_id: number | null
          qtde_final: number | null
          qtde_sem_promocao: number | null
          qtde_sugerida: number
          sku_codigo_omie: string
          sku_descricao: string | null
          valor_linha: number | null
        }
        Insert: {
          ajustado_humano?: boolean | null
          criado_em?: string | null
          desconto_perc_aplicado?: number | null
          economia_estimada_valor?: number | null
          estoque_a_caminho?: number | null
          estoque_atual?: number | null
          estoque_fisico?: number | null
          estoque_maximo?: number | null
          id?: number
          modo_promocao?: string | null
          pedido_id: number
          ponto_pedido?: number | null
          preco_sem_desconto?: number | null
          preco_unitario?: number | null
          primeira_compra?: boolean | null
          promocao_item_id?: number | null
          qtde_final?: number | null
          qtde_sem_promocao?: number | null
          qtde_sugerida: number
          sku_codigo_omie: string
          sku_descricao?: string | null
          valor_linha?: number | null
        }
        Update: {
          ajustado_humano?: boolean | null
          criado_em?: string | null
          desconto_perc_aplicado?: number | null
          economia_estimada_valor?: number | null
          estoque_a_caminho?: number | null
          estoque_atual?: number | null
          estoque_fisico?: number | null
          estoque_maximo?: number | null
          id?: number
          modo_promocao?: string | null
          pedido_id?: number
          ponto_pedido?: number | null
          preco_sem_desconto?: number | null
          preco_unitario?: number | null
          primeira_compra?: boolean | null
          promocao_item_id?: number | null
          qtde_final?: number | null
          qtde_sem_promocao?: number | null
          qtde_sugerida?: number
          sku_codigo_omie?: string
          sku_descricao?: string | null
          valor_linha?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_compra_item_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedido_compra_sugerido"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_compra_item_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "v_des_pedidos_em_transito"
            referencedColumns: ["pedido_id"]
          },
          {
            foreignKeyName: "pedido_compra_item_promocao_item_id_fkey"
            columns: ["promocao_item_id"]
            isOneToOne: false
            referencedRelation: "promocao_item"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_compra_item_promocao_item_id_fkey"
            columns: ["promocao_item_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["promo_item_id"]
          },
          {
            foreignKeyName: "pedido_compra_item_promocao_item_id_fkey"
            columns: ["promocao_item_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["promo_item_id"]
          },
          {
            foreignKeyName: "pedido_compra_item_promocao_item_id_fkey"
            columns: ["promocao_item_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "pedido_compra_item_promocao_item_id_fkey"
            columns: ["promocao_item_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_item_efetivo"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_compra_sugerido: {
        Row: {
          aprovado_em: string | null
          aprovado_por: string | null
          atualizado_em: string | null
          canal_usado: string | null
          cancelado_em: string | null
          cancelado_por: string | null
          condicao_origem: string | null
          condicao_pagamento_codigo: string | null
          condicao_pagamento_descricao: string | null
          criado_em: string | null
          data_ciclo: string
          delta_vs_anterior_perc: number | null
          dias_parcelas: string | null
          empresa: string
          enviado_portal_em: string | null
          fornecedor_nome: string | null
          grupo_codigo: string | null
          horario_corte_planejado: string | null
          horario_disparo_real: string | null
          horario_geracao: string | null
          id: number
          justificativa_cancelamento: string | null
          mensagem_bloqueio: string | null
          num_parcelas: number | null
          num_skus: number
          omie_pedido_compra_id: string | null
          omie_pedido_compra_numero: string | null
          omie_registrado_em: string | null
          origem_evento_id: number | null
          origem_evento_tipo: string | null
          pedido_anterior_valor: number | null
          portal_data_entrega: string | null
          portal_erro: string | null
          portal_protocolo: string | null
          portal_proximo_retry_em: string | null
          portal_resposta: Json | null
          portal_screenshot_url: string | null
          portal_tentativas: number | null
          resposta_canal: Json | null
          split_lote: number | null
          split_parent_id: number | null
          split_total: number | null
          status: string
          status_envio_portal: string | null
          tipo_ciclo: string
          valor_mes_ate_agora: number | null
          valor_total: number
        }
        Insert: {
          aprovado_em?: string | null
          aprovado_por?: string | null
          atualizado_em?: string | null
          canal_usado?: string | null
          cancelado_em?: string | null
          cancelado_por?: string | null
          condicao_origem?: string | null
          condicao_pagamento_codigo?: string | null
          condicao_pagamento_descricao?: string | null
          criado_em?: string | null
          data_ciclo?: string
          delta_vs_anterior_perc?: number | null
          dias_parcelas?: string | null
          empresa: string
          enviado_portal_em?: string | null
          fornecedor_nome?: string | null
          grupo_codigo?: string | null
          horario_corte_planejado?: string | null
          horario_disparo_real?: string | null
          horario_geracao?: string | null
          id?: number
          justificativa_cancelamento?: string | null
          mensagem_bloqueio?: string | null
          num_parcelas?: number | null
          num_skus?: number
          omie_pedido_compra_id?: string | null
          omie_pedido_compra_numero?: string | null
          omie_registrado_em?: string | null
          origem_evento_id?: number | null
          origem_evento_tipo?: string | null
          pedido_anterior_valor?: number | null
          portal_data_entrega?: string | null
          portal_erro?: string | null
          portal_protocolo?: string | null
          portal_proximo_retry_em?: string | null
          portal_resposta?: Json | null
          portal_screenshot_url?: string | null
          portal_tentativas?: number | null
          resposta_canal?: Json | null
          split_lote?: number | null
          split_parent_id?: number | null
          split_total?: number | null
          status?: string
          status_envio_portal?: string | null
          tipo_ciclo?: string
          valor_mes_ate_agora?: number | null
          valor_total?: number
        }
        Update: {
          aprovado_em?: string | null
          aprovado_por?: string | null
          atualizado_em?: string | null
          canal_usado?: string | null
          cancelado_em?: string | null
          cancelado_por?: string | null
          condicao_origem?: string | null
          condicao_pagamento_codigo?: string | null
          condicao_pagamento_descricao?: string | null
          criado_em?: string | null
          data_ciclo?: string
          delta_vs_anterior_perc?: number | null
          dias_parcelas?: string | null
          empresa?: string
          enviado_portal_em?: string | null
          fornecedor_nome?: string | null
          grupo_codigo?: string | null
          horario_corte_planejado?: string | null
          horario_disparo_real?: string | null
          horario_geracao?: string | null
          id?: number
          justificativa_cancelamento?: string | null
          mensagem_bloqueio?: string | null
          num_parcelas?: number | null
          num_skus?: number
          omie_pedido_compra_id?: string | null
          omie_pedido_compra_numero?: string | null
          omie_registrado_em?: string | null
          origem_evento_id?: number | null
          origem_evento_tipo?: string | null
          pedido_anterior_valor?: number | null
          portal_data_entrega?: string | null
          portal_erro?: string | null
          portal_protocolo?: string | null
          portal_proximo_retry_em?: string | null
          portal_resposta?: Json | null
          portal_screenshot_url?: string | null
          portal_tentativas?: number | null
          resposta_canal?: Json | null
          split_lote?: number | null
          split_parent_id?: number | null
          split_total?: number | null
          status?: string
          status_envio_portal?: string | null
          tipo_ciclo?: string
          valor_mes_ate_agora?: number | null
          valor_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "pedido_compra_sugerido_split_parent_id_fkey"
            columns: ["split_parent_id"]
            isOneToOne: false
            referencedRelation: "pedido_compra_sugerido"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_compra_sugerido_split_parent_id_fkey"
            columns: ["split_parent_id"]
            isOneToOne: false
            referencedRelation: "v_des_pedidos_em_transito"
            referencedColumns: ["pedido_id"]
          },
        ]
      }
      pedidos_portal_tentativas: {
        Row: {
          browserless_response_ms: number | null
          concluido_em: string | null
          elapsed_ms: number | null
          erro: string | null
          evidence: Json
          id: string
          iniciado_em: string
          pedido_id: number
          status_resultado: string
        }
        Insert: {
          browserless_response_ms?: number | null
          concluido_em?: string | null
          elapsed_ms?: number | null
          erro?: string | null
          evidence?: Json
          id?: string
          iniciado_em?: string
          pedido_id: number
          status_resultado: string
        }
        Update: {
          browserless_response_ms?: number | null
          concluido_em?: string | null
          elapsed_ms?: number | null
          erro?: string | null
          evidence?: Json
          id?: string
          iniciado_em?: string
          pedido_id?: number
          status_resultado?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_portal_tentativas_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedido_compra_sugerido"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_portal_tentativas_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "v_des_pedidos_em_transito"
            referencedColumns: ["pedido_id"]
          },
        ]
      }
      pedidos_programados: {
        Row: {
          arquivo_path: string
          cliente_ref: string
          created_at: string
          created_by: string
          data_emissao_cliente: string | null
          erro_motivo: string | null
          extracao_bruta: Json | null
          id: string
          numero_pedido_compra: string | null
          status: string
          updated_at: string
          versao: string | null
        }
        Insert: {
          arquivo_path: string
          cliente_ref?: string
          created_at?: string
          created_by: string
          data_emissao_cliente?: string | null
          erro_motivo?: string | null
          extracao_bruta?: Json | null
          id?: string
          numero_pedido_compra?: string | null
          status?: string
          updated_at?: string
          versao?: string | null
        }
        Update: {
          arquivo_path?: string
          cliente_ref?: string
          created_at?: string
          created_by?: string
          data_emissao_cliente?: string | null
          erro_motivo?: string | null
          extracao_bruta?: Json | null
          id?: string
          numero_pedido_compra?: string | null
          status?: string
          updated_at?: string
          versao?: string | null
        }
        Relationships: []
      }
      pedidos_programados_config: {
        Row: {
          account: string
          codigo_cliente_omie: number | null
          codigo_parcela: string | null
          customer_user_id: string | null
          dados_adicionais_nf: string | null
          obs_venda: string | null
          updated_at: string
        }
        Insert: {
          account: string
          codigo_cliente_omie?: number | null
          codigo_parcela?: string | null
          customer_user_id?: string | null
          dados_adicionais_nf?: string | null
          obs_venda?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          codigo_cliente_omie?: number | null
          codigo_parcela?: string | null
          customer_user_id?: string | null
          dados_adicionais_nf?: string | null
          obs_venda?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      pedidos_programados_envios: {
        Row: {
          created_at: string
          data_envio: string
          erro_motivo: string | null
          id: string
          pedido_programado_id: string
          sales_orders_map: Json
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data_envio: string
          erro_motivo?: string | null
          id?: string
          pedido_programado_id: string
          sales_orders_map?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data_envio?: string
          erro_motivo?: string | null
          id?: string
          pedido_programado_id?: string
          sales_orders_map?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_programados_envios_pedido_programado_id_fkey"
            columns: ["pedido_programado_id"]
            isOneToOne: false
            referencedRelation: "pedidos_programados"
            referencedColumns: ["id"]
          },
        ]
      }
      pedidos_programados_itens: {
        Row: {
          cod_forn: string | null
          codigo_item_cliente: string
          created_at: string
          data_entrega_cliente: string | null
          descricao_cliente: string
          envio_id: string | null
          id: string
          mapa_id: string | null
          num_ordem_cliente: string | null
          pedido_programado_id: string
          preco_final: number | null
          preco_pdf: number | null
          quantidade: number
          unidade: string | null
          updated_at: string
        }
        Insert: {
          cod_forn?: string | null
          codigo_item_cliente: string
          created_at?: string
          data_entrega_cliente?: string | null
          descricao_cliente: string
          envio_id?: string | null
          id?: string
          mapa_id?: string | null
          num_ordem_cliente?: string | null
          pedido_programado_id: string
          preco_final?: number | null
          preco_pdf?: number | null
          quantidade: number
          unidade?: string | null
          updated_at?: string
        }
        Update: {
          cod_forn?: string | null
          codigo_item_cliente?: string
          created_at?: string
          data_entrega_cliente?: string | null
          descricao_cliente?: string
          envio_id?: string | null
          id?: string
          mapa_id?: string | null
          num_ordem_cliente?: string | null
          pedido_programado_id?: string
          preco_final?: number | null
          preco_pdf?: number | null
          quantidade?: number
          unidade?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_programados_itens_envio_id_fkey"
            columns: ["envio_id"]
            isOneToOne: false
            referencedRelation: "pedidos_programados_envios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_programados_itens_mapa_id_fkey"
            columns: ["mapa_id"]
            isOneToOne: false
            referencedRelation: "cliente_item_mapa"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_programados_itens_pedido_programado_id_fkey"
            columns: ["pedido_programado_id"]
            isOneToOne: false
            referencedRelation: "pedidos_programados"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_change_log: {
        Row: {
          change_type: string
          changed_by: string
          created_at: string
          id: string
          new_value: string | null
          previous_value: string | null
          target_user_id: string
        }
        Insert: {
          change_type: string
          changed_by: string
          created_at?: string
          id?: string
          new_value?: string | null
          previous_value?: string | null
          target_user_id: string
        }
        Update: {
          change_type?: string
          changed_by?: string
          created_at?: string
          id?: string
          new_value?: string | null
          previous_value?: string | null
          target_user_id?: string
        }
        Relationships: []
      }
      permission_overrides: {
        Row: {
          created_at: string
          granted: boolean
          granted_by: string | null
          id: string
          permission_key: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted?: boolean
          granted_by?: string | null
          id?: string
          permission_key: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted?: boolean
          granted_by?: string | null
          id?: string
          permission_key?: string
          user_id?: string
        }
        Relationships: []
      }
      picking_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          justificativa: string | null
          lote_esperado: string | null
          lote_informado: string | null
          metadata: Json | null
          picking_task_id: string
          picking_task_item_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          justificativa?: string | null
          lote_esperado?: string | null
          lote_informado?: string | null
          metadata?: Json | null
          picking_task_id: string
          picking_task_item_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          justificativa?: string | null
          lote_esperado?: string | null
          lote_informado?: string | null
          metadata?: Json | null
          picking_task_id?: string
          picking_task_item_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "picking_events_picking_task_id_fkey"
            columns: ["picking_task_id"]
            isOneToOne: false
            referencedRelation: "picking_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "picking_events_picking_task_item_id_fkey"
            columns: ["picking_task_item_id"]
            isOneToOne: false
            referencedRelation: "picking_task_items"
            referencedColumns: ["id"]
          },
        ]
      }
      picking_task_items: {
        Row: {
          created_at: string
          id: string
          justificativa_substituicao: string | null
          localizacao: string | null
          lote_fefo: string | null
          lote_separado: string | null
          omie_codigo_produto: number | null
          picking_task_id: string
          product_codigo: string | null
          product_descricao: string | null
          quantidade: number
          quantidade_separada: number
          separado_at: string | null
          status: string
          updated_at: string
          validade_fefo: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          justificativa_substituicao?: string | null
          localizacao?: string | null
          lote_fefo?: string | null
          lote_separado?: string | null
          omie_codigo_produto?: number | null
          picking_task_id: string
          product_codigo?: string | null
          product_descricao?: string | null
          quantidade?: number
          quantidade_separada?: number
          separado_at?: string | null
          status?: string
          updated_at?: string
          validade_fefo?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          justificativa_substituicao?: string | null
          localizacao?: string | null
          lote_fefo?: string | null
          lote_separado?: string | null
          omie_codigo_produto?: number | null
          picking_task_id?: string
          product_codigo?: string | null
          product_descricao?: string | null
          quantidade?: number
          quantidade_separada?: number
          separado_at?: string | null
          status?: string
          updated_at?: string
          validade_fefo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "picking_task_items_picking_task_id_fkey"
            columns: ["picking_task_id"]
            isOneToOne: false
            referencedRelation: "picking_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      picking_tasks: {
        Row: {
          account: string
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          id: string
          notes: string | null
          sales_order_id: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account?: string
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          sales_order_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account?: string
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          sales_order_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "picking_tasks_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "picking_tasks_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      posthog_error_webhook_log: {
        Row: {
          action: string | null
          alerta_id: number | null
          criado_em: string
          dedupe_key: string
          id: number
          issue_id: string | null
          payload_raw: string | null
        }
        Insert: {
          action?: string | null
          alerta_id?: number | null
          criado_em?: string
          dedupe_key: string
          id?: never
          issue_id?: string | null
          payload_raw?: string | null
        }
        Update: {
          action?: string | null
          alerta_id?: number | null
          criado_em?: string
          dedupe_key?: string
          id?: never
          issue_id?: string | null
          payload_raw?: string | null
        }
        Relationships: []
      }
      prime_assinaturas: {
        Row: {
          created_at: string
          created_by: string
          customer_user_id: string
          data_fim: string | null
          data_inicio: string
          franquia_dentes_contratada: number
          id: string
          observacao: string | null
          plano_id: string
          preco_contratado: number
          status: string
          suspensa_em: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          customer_user_id: string
          data_fim?: string | null
          data_inicio?: string
          franquia_dentes_contratada: number
          id?: string
          observacao?: string | null
          plano_id: string
          preco_contratado: number
          status?: string
          suspensa_em?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          customer_user_id?: string
          data_fim?: string | null
          data_inicio?: string
          franquia_dentes_contratada?: number
          id?: string
          observacao?: string | null
          plano_id?: string
          preco_contratado?: number
          status?: string
          suspensa_em?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prime_assinaturas_plano_id_fkey"
            columns: ["plano_id"]
            isOneToOne: false
            referencedRelation: "prime_planos"
            referencedColumns: ["id"]
          },
        ]
      }
      prime_beneficio_uso: {
        Row: {
          assinatura_id: string
          competencia: string
          created_at: string
          created_by: string
          descricao: string | null
          estornado_em: string | null
          estornado_por: string | null
          id: string
          preco_unitario_snapshot: number | null
          quantidade: number
          referencia: string | null
          tipo: string
          valor_tabela: number | null
        }
        Insert: {
          assinatura_id: string
          competencia: string
          created_at?: string
          created_by: string
          descricao?: string | null
          estornado_em?: string | null
          estornado_por?: string | null
          id?: string
          preco_unitario_snapshot?: number | null
          quantidade: number
          referencia?: string | null
          tipo: string
          valor_tabela?: number | null
        }
        Update: {
          assinatura_id?: string
          competencia?: string
          created_at?: string
          created_by?: string
          descricao?: string | null
          estornado_em?: string | null
          estornado_por?: string | null
          id?: string
          preco_unitario_snapshot?: number | null
          quantidade?: number
          referencia?: string | null
          tipo?: string
          valor_tabela?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prime_beneficio_uso_assinatura_id_fkey"
            columns: ["assinatura_id"]
            isOneToOne: false
            referencedRelation: "prime_assinaturas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prime_beneficio_uso_assinatura_id_fkey"
            columns: ["assinatura_id"]
            isOneToOne: false
            referencedRelation: "v_prime_extrato_mensal"
            referencedColumns: ["assinatura_id"]
          },
        ]
      }
      prime_planos: {
        Row: {
          ativo: boolean
          beneficios: Json
          created_at: string
          franquia_dentes: number
          id: string
          nome: string
          preco_mensal: number
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          beneficios?: Json
          created_at?: string
          franquia_dentes: number
          id?: string
          nome: string
          preco_mensal: number
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          beneficios?: Json
          created_at?: string
          franquia_dentes?: number
          id?: string
          nome?: string
          preco_mensal?: number
          updated_at?: string
        }
        Relationships: []
      }
      priority_score_log: {
        Row: {
          calculated_at: string
          churn_risk_component: number | null
          created_at: string
          customer_user_id: string
          farmer_id: string
          goal_proximity_component: number | null
          id: string
          margin_potential_component: number | null
          priority_score: number
          repurchase_component: number | null
          score_date: string
        }
        Insert: {
          calculated_at?: string
          churn_risk_component?: number | null
          created_at?: string
          customer_user_id: string
          farmer_id: string
          goal_proximity_component?: number | null
          id?: string
          margin_potential_component?: number | null
          priority_score?: number
          repurchase_component?: number | null
          score_date?: string
        }
        Update: {
          calculated_at?: string
          churn_risk_component?: number | null
          created_at?: string
          customer_user_id?: string
          farmer_id?: string
          goal_proximity_component?: number | null
          id?: string
          margin_potential_component?: number | null
          priority_score?: number
          repurchase_component?: number | null
          score_date?: string
        }
        Relationships: []
      }
      product_costs: {
        Row: {
          cmc: number | null
          cost_confidence: number | null
          cost_final: number | null
          cost_price: number | null
          cost_source: string | null
          custo_producao: number | null
          custo_producao_computed_at: string | null
          custo_producao_source: string | null
          custo_producao_status: string | null
          family_category: string | null
          id: string
          product_id: string
          updated_at: string
        }
        Insert: {
          cmc?: number | null
          cost_confidence?: number | null
          cost_final?: number | null
          cost_price?: number | null
          cost_source?: string | null
          custo_producao?: number | null
          custo_producao_computed_at?: string | null
          custo_producao_source?: string | null
          custo_producao_status?: string | null
          family_category?: string | null
          id?: string
          product_id: string
          updated_at?: string
        }
        Update: {
          cmc?: number | null
          cost_confidence?: number | null
          cost_final?: number | null
          cost_price?: number | null
          cost_source?: string | null
          custo_producao?: number | null
          custo_producao_computed_at?: string | null
          custo_producao_source?: string | null
          custo_producao_status?: string | null
          family_category?: string | null
          id?: string
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_costs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      production_orders: {
        Row: {
          account: string
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          customer_name: string | null
          estado_projetado: string | null
          id: string
          iniciada_em: string | null
          notes: string | null
          omie_ordem_numero: string | null
          omie_ordem_producao_id: number | null
          origem: string | null
          prioridade: number
          product_codigo: string | null
          product_descricao: string | null
          product_id: string | null
          quantidade: number
          ready_by_date: string | null
          roteiro_familia: string | null
          sales_order_id: string | null
          sales_order_number: string | null
          status: string
          unidade: string | null
          updated_at: string
        }
        Insert: {
          account?: string
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_name?: string | null
          estado_projetado?: string | null
          id?: string
          iniciada_em?: string | null
          notes?: string | null
          omie_ordem_numero?: string | null
          omie_ordem_producao_id?: number | null
          origem?: string | null
          prioridade?: number
          product_codigo?: string | null
          product_descricao?: string | null
          product_id?: string | null
          quantidade?: number
          ready_by_date?: string | null
          roteiro_familia?: string | null
          sales_order_id?: string | null
          sales_order_number?: string | null
          status?: string
          unidade?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_name?: string | null
          estado_projetado?: string | null
          id?: string
          iniciada_em?: string | null
          notes?: string | null
          omie_ordem_numero?: string | null
          omie_ordem_producao_id?: number | null
          origem?: string | null
          prioridade?: number
          product_codigo?: string | null
          product_descricao?: string | null
          product_id?: string | null
          quantidade?: number
          ready_by_date?: string | null
          roteiro_familia?: string | null
          sales_order_id?: string | null
          sales_order_number?: string | null
          status?: string
          unidade?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_orders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_orders_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_orders_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          business_hours_close: string | null
          business_hours_open: string | null
          cnae: string | null
          cnpj: string | null
          created_at: string
          customer_type: string | null
          document: string | null
          email: string | null
          employee_code: string | null
          id: string
          is_approved: boolean
          is_employee: boolean | null
          is_prospect: boolean
          lunch_end: string | null
          lunch_start: string | null
          name: string
          phone: string | null
          preferred_delivery_time: string | null
          prospect_origin_call_id: string | null
          prospect_source: string | null
          razao_social: string | null
          requires_po: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          business_hours_close?: string | null
          business_hours_open?: string | null
          cnae?: string | null
          cnpj?: string | null
          created_at?: string
          customer_type?: string | null
          document?: string | null
          email?: string | null
          employee_code?: string | null
          id?: string
          is_approved?: boolean
          is_employee?: boolean | null
          is_prospect?: boolean
          lunch_end?: string | null
          lunch_start?: string | null
          name: string
          phone?: string | null
          preferred_delivery_time?: string | null
          prospect_origin_call_id?: string | null
          prospect_source?: string | null
          razao_social?: string | null
          requires_po?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          business_hours_close?: string | null
          business_hours_open?: string | null
          cnae?: string | null
          cnpj?: string | null
          created_at?: string
          customer_type?: string | null
          document?: string | null
          email?: string | null
          employee_code?: string | null
          id?: string
          is_approved?: boolean
          is_employee?: boolean | null
          is_prospect?: boolean
          lunch_end?: string | null
          lunch_start?: string | null
          name?: string
          phone?: string | null
          preferred_delivery_time?: string | null
          prospect_origin_call_id?: string | null
          prospect_source?: string | null
          razao_social?: string | null
          requires_po?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_prospect_origin_call_id_fkey"
            columns: ["prospect_origin_call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      promocao_campanha: {
        Row: {
          atualizado_em: string | null
          atualizado_por: string | null
          canal_oferta: string | null
          criado_em: string | null
          criado_por: string | null
          data_corte_faturamento: string | null
          data_corte_pedido: string | null
          data_fim: string
          data_inicio: string
          data_oferta: string | null
          empresa: string
          estado: string
          extracao_confianca: number | null
          extracao_observacoes: string | null
          extraido_em: string | null
          fornecedor_nome: string
          id: number
          nome: string
          observacoes: string | null
          observacoes_negociacao: string | null
          origem_arquivo_tipo: string | null
          origem_arquivo_url: string | null
          origem_email_assunto: string | null
          origem_email_data: string | null
          origem_email_remetente: string | null
          permite_pedido_oportunidade: boolean | null
          responsavel_oferta_email: string | null
          responsavel_oferta_nome: string | null
          status_aceite: string | null
          tipo_origem: string
          volume_minimo_condicional: number | null
          volume_minimo_unidade: string | null
        }
        Insert: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          canal_oferta?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_corte_faturamento?: string | null
          data_corte_pedido?: string | null
          data_fim: string
          data_inicio: string
          data_oferta?: string | null
          empresa: string
          estado?: string
          extracao_confianca?: number | null
          extracao_observacoes?: string | null
          extraido_em?: string | null
          fornecedor_nome: string
          id?: number
          nome: string
          observacoes?: string | null
          observacoes_negociacao?: string | null
          origem_arquivo_tipo?: string | null
          origem_arquivo_url?: string | null
          origem_email_assunto?: string | null
          origem_email_data?: string | null
          origem_email_remetente?: string | null
          permite_pedido_oportunidade?: boolean | null
          responsavel_oferta_email?: string | null
          responsavel_oferta_nome?: string | null
          status_aceite?: string | null
          tipo_origem: string
          volume_minimo_condicional?: number | null
          volume_minimo_unidade?: string | null
        }
        Update: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          canal_oferta?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_corte_faturamento?: string | null
          data_corte_pedido?: string | null
          data_fim?: string
          data_inicio?: string
          data_oferta?: string | null
          empresa?: string
          estado?: string
          extracao_confianca?: number | null
          extracao_observacoes?: string | null
          extraido_em?: string | null
          fornecedor_nome?: string
          id?: number
          nome?: string
          observacoes?: string | null
          observacoes_negociacao?: string | null
          origem_arquivo_tipo?: string | null
          origem_arquivo_url?: string | null
          origem_email_assunto?: string | null
          origem_email_data?: string | null
          origem_email_remetente?: string | null
          permite_pedido_oportunidade?: boolean | null
          responsavel_oferta_email?: string | null
          responsavel_oferta_nome?: string | null
          status_aceite?: string | null
          tipo_origem?: string
          volume_minimo_condicional?: number | null
          volume_minimo_unidade?: string | null
        }
        Relationships: []
      }
      promocao_item: {
        Row: {
          ativo: boolean
          atualizado_em: string | null
          campanha_id: number
          confirmado: boolean
          criado_em: string | null
          desconto_extra_email_referencia: string | null
          desconto_extra_negociado_em: string | null
          desconto_extra_negociado_por: string | null
          desconto_extra_observacoes: string | null
          desconto_extra_perc: number | null
          desconto_perc: number
          descricao_produto_fornecedor: string | null
          id: number
          mapeamento_candidatos: Json | null
          mapeamento_qualidade: string | null
          observacoes: string | null
          sku_codigo_fornecedor: string
          sku_codigo_omie: number | null
          volume_minimo: number | null
        }
        Insert: {
          ativo?: boolean
          atualizado_em?: string | null
          campanha_id: number
          confirmado?: boolean
          criado_em?: string | null
          desconto_extra_email_referencia?: string | null
          desconto_extra_negociado_em?: string | null
          desconto_extra_negociado_por?: string | null
          desconto_extra_observacoes?: string | null
          desconto_extra_perc?: number | null
          desconto_perc: number
          descricao_produto_fornecedor?: string | null
          id?: number
          mapeamento_candidatos?: Json | null
          mapeamento_qualidade?: string | null
          observacoes?: string | null
          sku_codigo_fornecedor: string
          sku_codigo_omie?: number | null
          volume_minimo?: number | null
        }
        Update: {
          ativo?: boolean
          atualizado_em?: string | null
          campanha_id?: number
          confirmado?: boolean
          criado_em?: string | null
          desconto_extra_email_referencia?: string | null
          desconto_extra_negociado_em?: string | null
          desconto_extra_negociado_por?: string | null
          desconto_extra_observacoes?: string | null
          desconto_extra_perc?: number | null
          desconto_perc?: number
          descricao_produto_fornecedor?: string | null
          id?: number
          mapeamento_candidatos?: Json | null
          mapeamento_qualidade?: string | null
          observacoes?: string | null
          sku_codigo_fornecedor?: string
          sku_codigo_omie?: number | null
          volume_minimo?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
        ]
      }
      promocao_negociacao_evento: {
        Row: {
          campanha_id: number
          conteudo: string | null
          data_evento: string
          desconto_perc_proposto: number | null
          email_referencia: string | null
          id: number
          item_id: number | null
          registrado_em: string | null
          registrado_por: string | null
          tipo_evento: string
          volume_minimo_proposto: number | null
        }
        Insert: {
          campanha_id: number
          conteudo?: string | null
          data_evento?: string
          desconto_perc_proposto?: number | null
          email_referencia?: string | null
          id?: number
          item_id?: number | null
          registrado_em?: string | null
          registrado_por?: string | null
          tipo_evento: string
          volume_minimo_proposto?: number | null
        }
        Update: {
          campanha_id?: number
          conteudo?: string | null
          data_evento?: string
          desconto_perc_proposto?: number | null
          email_referencia?: string | null
          id?: number
          item_id?: number | null
          registrado_em?: string | null
          registrado_por?: string | null
          tipo_evento?: string
          volume_minimo_proposto?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "promocao_negociacao_evento_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "promocao_item"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["promo_item_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["promo_item_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "promocao_negociacao_evento_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_item_efetivo"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders_tracking: {
        Row: {
          created_at: string
          cte_chave_acesso: string | null
          cte_numero: string | null
          cte_transportadora_cnpj: string | null
          cte_transportadora_nome_real: string | null
          cte_valor_frete: number | null
          data_previsao_original: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_cnpj: string | null
          fornecedor_codigo_omie: number
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          id: string
          infcpl_raw: string | null
          lt_bruto_dias_uteis: number | null
          lt_faturamento_dias_uteis: number | null
          lt_logistica_dias_uteis: number | null
          match_cte_metodo: string | null
          match_cte_score: number | null
          nfe_chave_acesso: string | null
          nfe_numero: string | null
          nfe_serie: string | null
          nid_receb: number | null
          numero_contrato_fornecedor: string | null
          numero_pedido: string | null
          numero_pedido_fornecedor: string | null
          observacoes: string | null
          omie_codigo_integracao: string | null
          omie_codigo_pedido: number
          raw_data: Json | null
          representante_codigo: string | null
          representante_nome: string | null
          status: Database["public"]["Enums"]["status_pedido_compra"]
          t1_data_pedido: string
          t2_data_faturamento: string | null
          t3_data_cte: string | null
          t4_data_recebimento: string | null
          transportadora_cnpj: string | null
          transportadora_nome: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          cte_chave_acesso?: string | null
          cte_numero?: string | null
          cte_transportadora_cnpj?: string | null
          cte_transportadora_nome_real?: string | null
          cte_valor_frete?: number | null
          data_previsao_original?: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_cnpj?: string | null
          fornecedor_codigo_omie: number
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          infcpl_raw?: string | null
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          match_cte_metodo?: string | null
          match_cte_score?: number | null
          nfe_chave_acesso?: string | null
          nfe_numero?: string | null
          nfe_serie?: string | null
          nid_receb?: number | null
          numero_contrato_fornecedor?: string | null
          numero_pedido?: string | null
          numero_pedido_fornecedor?: string | null
          observacoes?: string | null
          omie_codigo_integracao?: string | null
          omie_codigo_pedido: number
          raw_data?: Json | null
          representante_codigo?: string | null
          representante_nome?: string | null
          status?: Database["public"]["Enums"]["status_pedido_compra"]
          t1_data_pedido: string
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          transportadora_cnpj?: string | null
          transportadora_nome?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          cte_chave_acesso?: string | null
          cte_numero?: string | null
          cte_transportadora_cnpj?: string | null
          cte_transportadora_nome_real?: string | null
          cte_valor_frete?: number | null
          data_previsao_original?: string | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_cnpj?: string | null
          fornecedor_codigo_omie?: number
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          infcpl_raw?: string | null
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          match_cte_metodo?: string | null
          match_cte_score?: number | null
          nfe_chave_acesso?: string | null
          nfe_numero?: string | null
          nfe_serie?: string | null
          nid_receb?: number | null
          numero_contrato_fornecedor?: string | null
          numero_pedido?: string | null
          numero_pedido_fornecedor?: string | null
          observacoes?: string | null
          omie_codigo_integracao?: string | null
          omie_codigo_pedido?: number
          raw_data?: Json | null
          representante_codigo?: string | null
          representante_nome?: string | null
          status?: Database["public"]["Enums"]["status_pedido_compra"]
          t1_data_pedido?: string
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          transportadora_cnpj?: string | null
          transportadora_nome?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          subscription: Json
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          subscription: Json
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          subscription?: Json
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      radar_contatos: {
        Row: {
          acao: string
          cnpj: string
          created_at: string
          criado_por: string
          id: string
          nota: string | null
          status_anterior: string | null
        }
        Insert: {
          acao: string
          cnpj: string
          created_at?: string
          criado_por: string
          id?: string
          nota?: string | null
          status_anterior?: string | null
        }
        Update: {
          acao?: string
          cnpj?: string
          created_at?: string
          criado_por?: string
          id?: string
          nota?: string | null
          status_anterior?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "radar_contatos_cnpj_fkey"
            columns: ["cnpj"]
            isOneToOne: false
            referencedRelation: "radar_empresas"
            referencedColumns: ["cnpj"]
          },
        ]
      }
      radar_empresas: {
        Row: {
          bairro: string | null
          capital_social: number | null
          cep: string | null
          cnae_descricao: string | null
          cnae_principal: string
          cnaes_secundarios: string[]
          cnpj: string
          complemento: string | null
          created_at: string
          data_abertura: string | null
          descarte_motivo: string | null
          email: string | null
          geocode_status: string | null
          geocoded_em: string | null
          ja_cliente: boolean
          lat: number | null
          lng: number | null
          logradouro: string | null
          municipio_codigo: string | null
          municipio_nome: string | null
          nome_fantasia: string | null
          numero: string | null
          omie_cadastrado_em: string | null
          omie_codigo_cliente: string | null
          porte: string | null
          primeira_vista_em: string
          prospeccao_atualizado_em: string | null
          prospeccao_status: string
          razao_social: string | null
          socios_nomes: string | null
          telefone1: string | null
          telefone2: string | null
          uf: string | null
          ultimo_lote: string
          updated_at: string
        }
        Insert: {
          bairro?: string | null
          capital_social?: number | null
          cep?: string | null
          cnae_descricao?: string | null
          cnae_principal: string
          cnaes_secundarios?: string[]
          cnpj: string
          complemento?: string | null
          created_at?: string
          data_abertura?: string | null
          descarte_motivo?: string | null
          email?: string | null
          geocode_status?: string | null
          geocoded_em?: string | null
          ja_cliente?: boolean
          lat?: number | null
          lng?: number | null
          logradouro?: string | null
          municipio_codigo?: string | null
          municipio_nome?: string | null
          nome_fantasia?: string | null
          numero?: string | null
          omie_cadastrado_em?: string | null
          omie_codigo_cliente?: string | null
          porte?: string | null
          primeira_vista_em?: string
          prospeccao_atualizado_em?: string | null
          prospeccao_status?: string
          razao_social?: string | null
          socios_nomes?: string | null
          telefone1?: string | null
          telefone2?: string | null
          uf?: string | null
          ultimo_lote: string
          updated_at?: string
        }
        Update: {
          bairro?: string | null
          capital_social?: number | null
          cep?: string | null
          cnae_descricao?: string | null
          cnae_principal?: string
          cnaes_secundarios?: string[]
          cnpj?: string
          complemento?: string | null
          created_at?: string
          data_abertura?: string | null
          descarte_motivo?: string | null
          email?: string | null
          geocode_status?: string | null
          geocoded_em?: string | null
          ja_cliente?: boolean
          lat?: number | null
          lng?: number | null
          logradouro?: string | null
          municipio_codigo?: string | null
          municipio_nome?: string | null
          nome_fantasia?: string | null
          numero?: string | null
          omie_cadastrado_em?: string | null
          omie_codigo_cliente?: string | null
          porte?: string | null
          primeira_vista_em?: string
          prospeccao_atualizado_em?: string | null
          prospeccao_status?: string
          razao_social?: string | null
          socios_nomes?: string | null
          telefone1?: string | null
          telefone2?: string | null
          uf?: string | null
          ultimo_lote?: string
          updated_at?: string
        }
        Relationships: []
      }
      radar_ingest_state: {
        Row: {
          erro: string | null
          finalizado_em: string | null
          iniciado_em: string
          mes_referencia: string
          novos: number | null
          status: string
          total_recebido: number
        }
        Insert: {
          erro?: string | null
          finalizado_em?: string | null
          iniciado_em?: string
          mes_referencia: string
          novos?: number | null
          status?: string
          total_recebido?: number
        }
        Update: {
          erro?: string | null
          finalizado_em?: string | null
          iniciado_em?: string
          mes_referencia?: string
          novos?: number | null
          status?: string
          total_recebido?: number
        }
        Relationships: []
      }
      radar_municipios: {
        Row: {
          codigo: string
          lat: number | null
          lng: number | null
          nome: string
          uf: string
        }
        Insert: {
          codigo: string
          lat?: number | null
          lng?: number | null
          nome: string
          uf: string
        }
        Update: {
          codigo?: string
          lat?: number | null
          lng?: number | null
          nome?: string
          uf?: string
        }
        Relationships: []
      }
      rag_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          embedding: string | null
          id: string
          metadata: Json | null
          source_id: string
          source_table: string
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          source_id: string
          source_table: string
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          source_id?: string
          source_table?: string
        }
        Relationships: []
      }
      recommendation_config: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string | null
          updated_by: string | null
          value: number
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value?: number
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: number
        }
        Relationships: []
      }
      recommendation_log: {
        Row: {
          cost_source: string | null
          created_at: string | null
          customer_user_id: string
          eip: number | null
          event_type: string | null
          explanation_key: string | null
          explanation_text: string | null
          farmer_id: string
          id: string
          margin: number | null
          margin_realized: number | null
          mode: string | null
          probability: number | null
          product_id: string | null
          quantity_accepted: number | null
          quantity_suggested: number | null
          recommendation_type: string
          sales_order_id: string | null
          score_assoc: number | null
          score_ctx: number | null
          score_eip: number | null
          score_final: number | null
          score_sim: number | null
          unit_cost: number | null
          weights: Json | null
        }
        Insert: {
          cost_source?: string | null
          created_at?: string | null
          customer_user_id: string
          eip?: number | null
          event_type?: string | null
          explanation_key?: string | null
          explanation_text?: string | null
          farmer_id: string
          id?: string
          margin?: number | null
          margin_realized?: number | null
          mode?: string | null
          probability?: number | null
          product_id?: string | null
          quantity_accepted?: number | null
          quantity_suggested?: number | null
          recommendation_type?: string
          sales_order_id?: string | null
          score_assoc?: number | null
          score_ctx?: number | null
          score_eip?: number | null
          score_final?: number | null
          score_sim?: number | null
          unit_cost?: number | null
          weights?: Json | null
        }
        Update: {
          cost_source?: string | null
          created_at?: string | null
          customer_user_id?: string
          eip?: number | null
          event_type?: string | null
          explanation_key?: string | null
          explanation_text?: string | null
          farmer_id?: string
          id?: string
          margin?: number | null
          margin_realized?: number | null
          mode?: string | null
          probability?: number | null
          product_id?: string | null
          quantity_accepted?: number | null
          quantity_suggested?: number | null
          recommendation_type?: string
          sales_order_id?: string | null
          score_assoc?: number | null
          score_ctx?: number | null
          score_eip?: number | null
          score_final?: number | null
          score_sim?: number | null
          unit_cost?: number | null
          weights?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_log_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_log_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_log_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_schedules: {
        Row: {
          address_id: string | null
          created_at: string
          delivery_option: string
          frequency_days: number
          id: string
          is_active: boolean
          next_order_date: string
          time_slot: string | null
          tool_ids: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          address_id?: string | null
          created_at?: string
          delivery_option?: string
          frequency_days?: number
          id?: string
          is_active?: boolean
          next_order_date: string
          time_slot?: string | null
          tool_ids?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          address_id?: string | null
          created_at?: string
          delivery_option?: string
          frequency_days?: number
          id?: string
          is_active?: boolean
          next_order_date?: string
          time_slot?: string | null
          tool_ids?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_schedules_address_id_fkey"
            columns: ["address_id"]
            isOneToOne: false
            referencedRelation: "addresses"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          converted_at: string | null
          created_at: string
          id: string
          points_awarded: boolean
          referred_email: string
          referred_user_id: string | null
          referrer_id: string
          status: string
        }
        Insert: {
          converted_at?: string | null
          created_at?: string
          id?: string
          points_awarded?: boolean
          referred_email: string
          referred_user_id?: string | null
          referrer_id: string
          status?: string
        }
        Update: {
          converted_at?: string | null
          created_at?: string
          id?: string
          points_awarded?: boolean
          referred_email?: string
          referred_user_id?: string | null
          referrer_id?: string
          status?: string
        }
        Relationships: []
      }
      regua_preco_log: {
        Row: {
          account: string
          aliquota_usada: number | null
          aplicou: boolean | null
          cap_limitou: boolean | null
          cmc_confianca: string | null
          cmc_usado: number | null
          confianca: string
          created_at: string
          customer_user_id: string
          evidence_version: string
          id: string
          observed_gap_pct: number | null
          outcome_at: string | null
          outcome_status: string | null
          piso_mc: number | null
          preco_atual: number
          preco_final: number | null
          preco_referencia: number | null
          product_id: string
          quantity: number | null
          reason_codes: string[] | null
          sales_order_id: string | null
          salesperson_id: string | null
          sinal_exibido: string
          suggested_gap_pct: number | null
        }
        Insert: {
          account: string
          aliquota_usada?: number | null
          aplicou?: boolean | null
          cap_limitou?: boolean | null
          cmc_confianca?: string | null
          cmc_usado?: number | null
          confianca: string
          created_at?: string
          customer_user_id: string
          evidence_version?: string
          id?: string
          observed_gap_pct?: number | null
          outcome_at?: string | null
          outcome_status?: string | null
          piso_mc?: number | null
          preco_atual: number
          preco_final?: number | null
          preco_referencia?: number | null
          product_id: string
          quantity?: number | null
          reason_codes?: string[] | null
          sales_order_id?: string | null
          salesperson_id?: string | null
          sinal_exibido: string
          suggested_gap_pct?: number | null
        }
        Update: {
          account?: string
          aliquota_usada?: number | null
          aplicou?: boolean | null
          cap_limitou?: boolean | null
          cmc_confianca?: string | null
          cmc_usado?: number | null
          confianca?: string
          created_at?: string
          customer_user_id?: string
          evidence_version?: string
          id?: string
          observed_gap_pct?: number | null
          outcome_at?: string | null
          outcome_status?: string | null
          piso_mc?: number | null
          preco_atual?: number
          preco_final?: number | null
          preco_referencia?: number | null
          product_id?: string
          quantity?: number | null
          reason_codes?: string[] | null
          sales_order_id?: string | null
          salesperson_id?: string | null
          sinal_exibido?: string
          suggested_gap_pct?: number | null
        }
        Relationships: []
      }
      reposicao_alerta_pedido_minimo: {
        Row: {
          alertado_em: string
          empresa: string
          fornecedor_nome: string
          grupo_codigo: string
          id: number
          pedido_id: number | null
          resolvido_em: string | null
          valor_alertado: number
          valor_ultimo: number
        }
        Insert: {
          alertado_em?: string
          empresa: string
          fornecedor_nome: string
          grupo_codigo?: string
          id?: never
          pedido_id?: number | null
          resolvido_em?: string | null
          valor_alertado: number
          valor_ultimo: number
        }
        Update: {
          alertado_em?: string
          empresa?: string
          fornecedor_nome?: string
          grupo_codigo?: string
          id?: never
          pedido_id?: number | null
          resolvido_em?: string | null
          valor_alertado?: number
          valor_ultimo?: number
        }
        Relationships: []
      }
      reposicao_auto_aprovacao_log: {
        Row: {
          criado_em: string
          delta_pct: number | null
          empresa: string
          fornecedor_nome: string
          grupo_codigo: string
          id: number
          pedido_id: number
          regua: number
          valor_anterior: number | null
          valor_total: number
        }
        Insert: {
          criado_em?: string
          delta_pct?: number | null
          empresa: string
          fornecedor_nome: string
          grupo_codigo?: string
          id?: never
          pedido_id: number
          regua: number
          valor_anterior?: number | null
          valor_total: number
        }
        Update: {
          criado_em?: string
          delta_pct?: number | null
          empresa?: string
          fornecedor_nome?: string
          grupo_codigo?: string
          id?: never
          pedido_id?: number
          regua?: number
          valor_anterior?: number | null
          valor_total?: number
        }
        Relationships: []
      }
      reposicao_cold_start_log: {
        Row: {
          acao: string
          criado_em: string
          detalhe: string | null
          empresa: string
          habilitado: boolean | null
          id: string
          run_id: string | null
          sku_codigo_omie: string
          sku_descricao: string | null
        }
        Insert: {
          acao: string
          criado_em?: string
          detalhe?: string | null
          empresa?: string
          habilitado?: boolean | null
          id?: string
          run_id?: string | null
          sku_codigo_omie: string
          sku_descricao?: string | null
        }
        Update: {
          acao?: string
          criado_em?: string
          detalhe?: string | null
          empresa?: string
          habilitado?: boolean | null
          id?: string
          run_id?: string | null
          sku_codigo_omie?: string
          sku_descricao?: string | null
        }
        Relationships: []
      }
      reposicao_depara_auto_log: {
        Row: {
          criado_em: string
          detalhe: string | null
          empresa: string
          id: string
          parser_version: number | null
          resultado: string
          run_id: string | null
          sku_descricao: string | null
          sku_omie: string
          sku_portal_extraido: string | null
        }
        Insert: {
          criado_em?: string
          detalhe?: string | null
          empresa?: string
          id?: string
          parser_version?: number | null
          resultado: string
          run_id?: string | null
          sku_descricao?: string | null
          sku_omie: string
          sku_portal_extraido?: string | null
        }
        Update: {
          criado_em?: string
          detalhe?: string | null
          empresa?: string
          id?: string
          parser_version?: number | null
          resultado?: string
          run_id?: string | null
          sku_descricao?: string | null
          sku_omie?: string
          sku_portal_extraido?: string | null
        }
        Relationships: []
      }
      reposicao_embalagem_sync_log: {
        Row: {
          cores_elegiveis: number
          detalhes: Json | null
          disparado_por: string
          empresa: string
          executado_em: string
          id: number
          linhas_inseridas: number
        }
        Insert: {
          cores_elegiveis: number
          detalhes?: Json | null
          disparado_por: string
          empresa: string
          executado_em?: string
          id?: never
          linhas_inseridas: number
        }
        Update: {
          cores_elegiveis?: number
          detalhes?: Json | null
          disparado_por?: string
          empresa?: string
          executado_em?: string
          id?: never
          linhas_inseridas?: number
        }
        Relationships: []
      }
      reposicao_estoque_nao_confirmado_log: {
        Row: {
          criado_em: string
          empresa: string
          estoque_efetivo: number | null
          fonte_sync: string | null
          grupo_codigo: string | null
          id: string
          motivo: string
          ponto_pedido: number | null
          run_id: string | null
          sku_codigo_omie: string
          sku_descricao: string | null
        }
        Insert: {
          criado_em?: string
          empresa: string
          estoque_efetivo?: number | null
          fonte_sync?: string | null
          grupo_codigo?: string | null
          id?: string
          motivo: string
          ponto_pedido?: number | null
          run_id?: string | null
          sku_codigo_omie: string
          sku_descricao?: string | null
        }
        Update: {
          criado_em?: string
          empresa?: string
          estoque_efetivo?: number | null
          fonte_sync?: string | null
          grupo_codigo?: string | null
          id?: string
          motivo?: string
          ponto_pedido?: number | null
          run_id?: string | null
          sku_codigo_omie?: string
          sku_descricao?: string | null
        }
        Relationships: []
      }
      reposicao_motor_run: {
        Row: {
          criado_em: string
          data_ciclo: string
          empresa: string
          id: string
          pedidos_gerados: number
          run_id: string
          skus_incluidos: number
          suprimidos_n: number
        }
        Insert: {
          criado_em?: string
          data_ciclo: string
          empresa: string
          id?: string
          pedidos_gerados?: number
          run_id: string
          skus_incluidos?: number
          suprimidos_n?: number
        }
        Update: {
          criado_em?: string
          data_ciclo?: string
          empresa?: string
          id?: string
          pedidos_gerados?: number
          run_id?: string
          skus_incluidos?: number
          suprimidos_n?: number
        }
        Relationships: []
      }
      reposicao_param_auto_log: {
        Row: {
          classe_consolidada: string | null
          cobertura_antes: number | null
          cobertura_depois: number | null
          criado_em: string
          custo_fonte: string | null
          custo_unitario: number | null
          demanda_media_diaria: number | null
          empresa: string
          estoque_maximo_antes: number | null
          estoque_maximo_depois: number | null
          estoque_maximo_sugerido: number | null
          estoque_minimo_antes: number | null
          estoque_minimo_depois: number | null
          estoque_seguranca_antes: number | null
          estoque_seguranca_depois: number | null
          id: string
          impacto_rs: number | null
          lt_medio_dias_uteis: number | null
          ponto_pedido_antes: number | null
          ponto_pedido_depois: number | null
          ponto_pedido_sugerido: number | null
          qtde_compra_antes: number | null
          qtde_compra_depois: number | null
          revertido_em: string | null
          revertido_por: string | null
          run_id: string
          sku_codigo_omie: string
          sku_descricao: string | null
          status: string
          z_score: number | null
        }
        Insert: {
          classe_consolidada?: string | null
          cobertura_antes?: number | null
          cobertura_depois?: number | null
          criado_em?: string
          custo_fonte?: string | null
          custo_unitario?: number | null
          demanda_media_diaria?: number | null
          empresa: string
          estoque_maximo_antes?: number | null
          estoque_maximo_depois?: number | null
          estoque_maximo_sugerido?: number | null
          estoque_minimo_antes?: number | null
          estoque_minimo_depois?: number | null
          estoque_seguranca_antes?: number | null
          estoque_seguranca_depois?: number | null
          id?: string
          impacto_rs?: number | null
          lt_medio_dias_uteis?: number | null
          ponto_pedido_antes?: number | null
          ponto_pedido_depois?: number | null
          ponto_pedido_sugerido?: number | null
          qtde_compra_antes?: number | null
          qtde_compra_depois?: number | null
          revertido_em?: string | null
          revertido_por?: string | null
          run_id: string
          sku_codigo_omie: string
          sku_descricao?: string | null
          status: string
          z_score?: number | null
        }
        Update: {
          classe_consolidada?: string | null
          cobertura_antes?: number | null
          cobertura_depois?: number | null
          criado_em?: string
          custo_fonte?: string | null
          custo_unitario?: number | null
          demanda_media_diaria?: number | null
          empresa?: string
          estoque_maximo_antes?: number | null
          estoque_maximo_depois?: number | null
          estoque_maximo_sugerido?: number | null
          estoque_minimo_antes?: number | null
          estoque_minimo_depois?: number | null
          estoque_seguranca_antes?: number | null
          estoque_seguranca_depois?: number | null
          id?: string
          impacto_rs?: number | null
          lt_medio_dias_uteis?: number | null
          ponto_pedido_antes?: number | null
          ponto_pedido_depois?: number | null
          ponto_pedido_sugerido?: number | null
          qtde_compra_antes?: number | null
          qtde_compra_depois?: number | null
          revertido_em?: string | null
          revertido_por?: string | null
          run_id?: string
          sku_codigo_omie?: string
          sku_descricao?: string | null
          status?: string
          z_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "reposicao_param_auto_log_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "reposicao_param_auto_run"
            referencedColumns: ["id"]
          },
        ]
      }
      reposicao_param_auto_run: {
        Row: {
          concluido_em: string | null
          criado_em: string
          data_negocio_brt: string
          empresa: string
          id: string
          impacto_desconhecido_n: number | null
          impacto_total_rs: number | null
          resumo_enviado_em: string | null
          status: string
          total_aplicados: number | null
          total_avaliados: number | null
          total_pinados: number | null
          total_segurados: number | null
        }
        Insert: {
          concluido_em?: string | null
          criado_em?: string
          data_negocio_brt: string
          empresa: string
          id?: string
          impacto_desconhecido_n?: number | null
          impacto_total_rs?: number | null
          resumo_enviado_em?: string | null
          status?: string
          total_aplicados?: number | null
          total_avaliados?: number | null
          total_pinados?: number | null
          total_segurados?: number | null
        }
        Update: {
          concluido_em?: string | null
          criado_em?: string
          data_negocio_brt?: string
          empresa?: string
          id?: string
          impacto_desconhecido_n?: number | null
          impacto_total_rs?: number | null
          resumo_enviado_em?: string | null
          status?: string
          total_aplicados?: number | null
          total_avaliados?: number | null
          total_pinados?: number | null
          total_segurados?: number | null
        }
        Relationships: []
      }
      reposicao_param_limbo_log: {
        Row: {
          criado_em: string
          empresa: string
          id: number
          limbo_count: number
          medido_em: string
        }
        Insert: {
          criado_em?: string
          empresa: string
          id?: never
          limbo_count: number
          medido_em?: string
        }
        Update: {
          criado_em?: string
          empresa?: string
          id?: never
          limbo_count?: number
          medido_em?: string
        }
        Relationships: []
      }
      reposicao_param_pin: {
        Row: {
          empresa: string
          estoque_maximo_rejeitado: number
          pinado_em: string
          pinado_por: string | null
          ponto_pedido_rejeitado: number
          sku_codigo_omie: string
        }
        Insert: {
          empresa: string
          estoque_maximo_rejeitado: number
          pinado_em?: string
          pinado_por?: string | null
          ponto_pedido_rejeitado: number
          sku_codigo_omie: string
        }
        Update: {
          empresa?: string
          estoque_maximo_rejeitado?: number
          pinado_em?: string
          pinado_por?: string | null
          ponto_pedido_rejeitado?: number
          sku_codigo_omie?: string
        }
        Relationships: []
      }
      reposicao_pedidos_compra_run: {
        Row: {
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          finalizado_em: string
          ids_distintos: number
          janela_ate: string
          janela_de: string
          run_id: string
          seq: number
          status: string
          volume_baseline: number | null
          volume_ok: boolean | null
        }
        Insert: {
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          finalizado_em?: string
          ids_distintos: number
          janela_ate: string
          janela_de: string
          run_id: string
          seq?: number
          status?: string
          volume_baseline?: number | null
          volume_ok?: boolean | null
        }
        Update: {
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          finalizado_em?: string
          ids_distintos?: number
          janela_ate?: string
          janela_de?: string
          run_id?: string
          seq?: number
          status?: string
          volume_baseline?: number | null
          volume_ok?: boolean | null
        }
        Relationships: []
      }
      reposicao_po_last_seen: {
        Row: {
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          omie_codigo_pedido: number
          run_id: string
          visto_em: string
          visto_seq: number
        }
        Insert: {
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          omie_codigo_pedido: number
          run_id: string
          visto_em: string
          visto_seq: number
        }
        Update: {
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          omie_codigo_pedido?: number
          run_id?: string
          visto_em?: string
          visto_seq?: number
        }
        Relationships: []
      }
      reposition_parameters: {
        Row: {
          aplicado_em: string | null
          aprovado_em: string | null
          aprovado_por: string | null
          calculado_em: string | null
          classe_abc: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz: Database["public"]["Enums"]["classe_xyz"] | null
          created_at: string
          delta_estoque_min_pct: number | null
          delta_lt_pct: number | null
          demanda_desvio_padrao: number | null
          demanda_media_diaria: number | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          estoque_max_atual_omie: number | null
          estoque_min_atual_omie: number | null
          estoque_min_sugerido: number | null
          estoque_seguranca: number | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          id: string
          lt_atual_omie: number | null
          lt_desvio_padrao: number | null
          lt_medio_realizado: number | null
          lt_percentil_95: number | null
          lt_sugerido: number | null
          motivo_rejeicao: string | null
          n_amostras_demanda: number | null
          n_amostras_leadtime: number | null
          override_justificativa: string | null
          override_por: string | null
          ponto_pedido_sugerido: number | null
          sku_codigo: string | null
          sku_codigo_omie: number
          sku_descricao: string | null
          status_revisao: Database["public"]["Enums"]["status_revisao"]
          updated_at: string
          z_aplicado: number | null
          z_override: number | null
        }
        Insert: {
          aplicado_em?: string | null
          aprovado_em?: string | null
          aprovado_por?: string | null
          calculado_em?: string | null
          classe_abc?: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz?: Database["public"]["Enums"]["classe_xyz"] | null
          created_at?: string
          delta_estoque_min_pct?: number | null
          delta_lt_pct?: number | null
          demanda_desvio_padrao?: number | null
          demanda_media_diaria?: number | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          estoque_max_atual_omie?: number | null
          estoque_min_atual_omie?: number | null
          estoque_min_sugerido?: number | null
          estoque_seguranca?: number | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          lt_atual_omie?: number | null
          lt_desvio_padrao?: number | null
          lt_medio_realizado?: number | null
          lt_percentil_95?: number | null
          lt_sugerido?: number | null
          motivo_rejeicao?: string | null
          n_amostras_demanda?: number | null
          n_amostras_leadtime?: number | null
          override_justificativa?: string | null
          override_por?: string | null
          ponto_pedido_sugerido?: number | null
          sku_codigo?: string | null
          sku_codigo_omie: number
          sku_descricao?: string | null
          status_revisao?: Database["public"]["Enums"]["status_revisao"]
          updated_at?: string
          z_aplicado?: number | null
          z_override?: number | null
        }
        Update: {
          aplicado_em?: string | null
          aprovado_em?: string | null
          aprovado_por?: string | null
          calculado_em?: string | null
          classe_abc?: Database["public"]["Enums"]["classe_abc"] | null
          classe_xyz?: Database["public"]["Enums"]["classe_xyz"] | null
          created_at?: string
          delta_estoque_min_pct?: number | null
          delta_lt_pct?: number | null
          demanda_desvio_padrao?: number | null
          demanda_media_diaria?: number | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          estoque_max_atual_omie?: number | null
          estoque_min_atual_omie?: number | null
          estoque_min_sugerido?: number | null
          estoque_seguranca?: number | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          lt_atual_omie?: number | null
          lt_desvio_padrao?: number | null
          lt_medio_realizado?: number | null
          lt_percentil_95?: number | null
          lt_sugerido?: number | null
          motivo_rejeicao?: string | null
          n_amostras_demanda?: number | null
          n_amostras_leadtime?: number | null
          override_justificativa?: string | null
          override_por?: string | null
          ponto_pedido_sugerido?: number | null
          sku_codigo?: string | null
          sku_codigo_omie?: number
          sku_descricao?: string | null
          status_revisao?: Database["public"]["Enums"]["status_revisao"]
          updated_at?: string
          z_aplicado?: number | null
          z_override?: number | null
        }
        Relationships: []
      }
      roadmap_state: {
        Row: {
          id: string
          state: Json
          updated_at: string
        }
        Insert: {
          id?: string
          state: Json
          updated_at?: string
        }
        Update: {
          id?: string
          state?: Json
          updated_at?: string
        }
        Relationships: []
      }
      route_calendar_override: {
        Row: {
          cancela_rota: boolean
          created_at: string
          data: string
          id: string
          motivo: string | null
        }
        Insert: {
          cancela_rota?: boolean
          created_at?: string
          data: string
          id?: string
          motivo?: string | null
        }
        Update: {
          cancela_rota?: boolean
          created_at?: string
          data?: string
          id?: string
          motivo?: string | null
        }
        Relationships: []
      }
      route_contact_log: {
        Row: {
          bucket: string | null
          canal: string
          created_at: string
          customer_user_id: string | null
          data_rota: string
          farmer_id: string | null
          id: string
          pedido_id: string | null
          status: string | null
          valor_da_ligacao: number | null
        }
        Insert: {
          bucket?: string | null
          canal: string
          created_at?: string
          customer_user_id?: string | null
          data_rota: string
          farmer_id?: string | null
          id?: string
          pedido_id?: string | null
          status?: string | null
          valor_da_ligacao?: number | null
        }
        Update: {
          bucket?: string | null
          canal?: string
          created_at?: string
          customer_user_id?: string | null
          data_rota?: string
          farmer_id?: string | null
          id?: string
          pedido_id?: string | null
          status?: string | null
          valor_da_ligacao?: number | null
        }
        Relationships: []
      }
      route_disparo_config: {
        Row: {
          cadencia_min_dias: number
          capacidade_ligacoes_dia: number
          cold_start_piso_dia: number
          disparo_corte: string
          disparo_inicio: string
          id: boolean
          meta_tier_cap: number
          updated_at: string
          win_back_reserva_pct: number
        }
        Insert: {
          cadencia_min_dias?: number
          capacidade_ligacoes_dia?: number
          cold_start_piso_dia?: number
          disparo_corte?: string
          disparo_inicio?: string
          id?: boolean
          meta_tier_cap?: number
          updated_at?: string
          win_back_reserva_pct?: number
        }
        Update: {
          cadencia_min_dias?: number
          capacidade_ligacoes_dia?: number
          cold_start_piso_dia?: number
          disparo_corte?: string
          disparo_inicio?: string
          id?: boolean
          meta_tier_cap?: number
          updated_at?: string
          win_back_reserva_pct?: number
        }
        Relationships: []
      }
      route_queue_snapshot: {
        Row: {
          bucket: string | null
          cidade: string | null
          cliente_nome: string | null
          customer_user_id: string
          data_rota: string
          farmer_id: string
          id: string
          rank: number | null
          snapshot_at: string
          valor_da_ligacao: number | null
        }
        Insert: {
          bucket?: string | null
          cidade?: string | null
          cliente_nome?: string | null
          customer_user_id: string
          data_rota: string
          farmer_id: string
          id?: string
          rank?: number | null
          snapshot_at?: string
          valor_da_ligacao?: number | null
        }
        Update: {
          bucket?: string | null
          cidade?: string | null
          cliente_nome?: string | null
          customer_user_id?: string
          data_rota?: string
          farmer_id?: string
          id?: string
          rank?: number | null
          snapshot_at?: string
          valor_da_ligacao?: number | null
        }
        Relationships: []
      }
      route_schedule: {
        Row: {
          ativo: boolean
          city: string
          created_at: string
          id: string
          is_daily: boolean
          uf: string
          weekday: number
        }
        Insert: {
          ativo?: boolean
          city: string
          created_at?: string
          id?: string
          is_daily?: boolean
          uf?: string
          weekday: number
        }
        Update: {
          ativo?: boolean
          city?: string
          created_at?: string
          id?: string
          is_daily?: boolean
          uf?: string
          weekday?: number
        }
        Relationships: []
      }
      route_visits: {
        Row: {
          check_in_at: string | null
          check_out_at: string | null
          created_at: string
          customer_user_id: string
          id: string
          lat: number | null
          lng: number | null
          notes: string | null
          order_created: boolean | null
          result: string | null
          revenue_generated: number | null
          visit_date: string
          visit_type: string
          visited_by: string
        }
        Insert: {
          check_in_at?: string | null
          check_out_at?: string | null
          created_at?: string
          customer_user_id: string
          id?: string
          lat?: number | null
          lng?: number | null
          notes?: string | null
          order_created?: boolean | null
          result?: string | null
          revenue_generated?: number | null
          visit_date?: string
          visit_type?: string
          visited_by: string
        }
        Update: {
          check_in_at?: string | null
          check_out_at?: string | null
          created_at?: string
          customer_user_id?: string
          id?: string
          lat?: number | null
          lng?: number | null
          notes?: string | null
          order_created?: boolean | null
          result?: string | null
          revenue_generated?: number | null
          visit_date?: string
          visit_type?: string
          visited_by?: string
        }
        Relationships: []
      }
      sales_orders: {
        Row: {
          account: string
          atendimento_id: string | null
          checkout_id: string | null
          created_at: string
          created_by: string
          customer_address: string | null
          customer_document: string | null
          customer_phone: string | null
          customer_user_id: string
          deleted_at: string | null
          discount: number
          hash_payload: string | null
          id: string
          items: Json
          notes: string | null
          omie_numero_pedido: string | null
          omie_payload: Json | null
          omie_pedido_id: number | null
          omie_response: Json | null
          order_date_kpi: string | null
          origem: string | null
          pedido_programado_envio_id: string | null
          ready_by_date: string | null
          status: string
          subtotal: number
          total: number
          updated_at: string
          whatsapp_conversation_id: string | null
        }
        Insert: {
          account?: string
          atendimento_id?: string | null
          checkout_id?: string | null
          created_at?: string
          created_by: string
          customer_address?: string | null
          customer_document?: string | null
          customer_phone?: string | null
          customer_user_id: string
          deleted_at?: string | null
          discount?: number
          hash_payload?: string | null
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
          order_date_kpi?: string | null
          origem?: string | null
          pedido_programado_envio_id?: string | null
          ready_by_date?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
          whatsapp_conversation_id?: string | null
        }
        Update: {
          account?: string
          atendimento_id?: string | null
          checkout_id?: string | null
          created_at?: string
          created_by?: string
          customer_address?: string | null
          customer_document?: string | null
          customer_phone?: string | null
          customer_user_id?: string
          deleted_at?: string | null
          discount?: number
          hash_payload?: string | null
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
          order_date_kpi?: string | null
          origem?: string | null
          pedido_programado_envio_id?: string | null
          ready_by_date?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
          whatsapp_conversation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_orders_pedido_programado_envio_id_fkey"
            columns: ["pedido_programado_envio_id"]
            isOneToOne: false
            referencedRelation: "pedidos_programados_envios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_orders_whatsapp_conversation_id_fkey"
            columns: ["whatsapp_conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_price_history: {
        Row: {
          created_at: string
          customer_user_id: string
          id: string
          product_id: string
          sales_order_id: string | null
          unit_price: number
        }
        Insert: {
          created_at?: string
          customer_user_id: string
          id?: string
          product_id: string
          sales_order_id?: string | null
          unit_price: number
        }
        Update: {
          created_at?: string
          customer_user_id?: string
          id?: string
          product_id?: string
          sales_order_id?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_price_history_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_price_history_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_price_history_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      sayerlack_retry_motor_log: {
        Row: {
          aprovado_em: string | null
          criado_em: string
          id: number
          pedido_id: number
          request_id: number | null
          status_envio_portal_no_disparo: string | null
          tentativa_no_disparo: number | null
        }
        Insert: {
          aprovado_em?: string | null
          criado_em?: string
          id?: never
          pedido_id: number
          request_id?: number | null
          status_envio_portal_no_disparo?: string | null
          tentativa_no_disparo?: number | null
        }
        Update: {
          aprovado_em?: string | null
          criado_em?: string
          id?: never
          pedido_id?: number
          request_id?: number | null
          status_envio_portal_no_disparo?: string | null
          tentativa_no_disparo?: number | null
        }
        Relationships: []
      }
      score_recalc_queue: {
        Row: {
          customer_user_id: string
          enqueued_at: string
          error: string | null
          farmer_id: string
          id: string
          processed_at: string | null
          reason: string
          source_call_id: string | null
        }
        Insert: {
          customer_user_id: string
          enqueued_at?: string
          error?: string | null
          farmer_id: string
          id?: string
          processed_at?: string | null
          reason: string
          source_call_id?: string | null
        }
        Update: {
          customer_user_id?: string
          enqueued_at?: string
          error?: string | null
          farmer_id?: string
          id?: string
          processed_at?: string | null
          reason?: string
          source_call_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "score_recalc_queue_source_call_id_fkey"
            columns: ["source_call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      selfservice_cliente_allowlist: {
        Row: {
          account: string
          customer_user_id: string
          enabled: boolean
          enabled_at: string | null
          enabled_by: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          account: string
          customer_user_id: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          customer_user_id?: string
          enabled?: boolean
          enabled_at?: string | null
          enabled_by?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      sending_quality_logs: {
        Row: {
          created_at: string
          evaluated_by: string | null
          id: string
          is_clean: boolean
          is_identified: boolean
          is_properly_packed: boolean
          is_separated: boolean
          order_id: string
          score: number
          user_id: string
        }
        Insert: {
          created_at?: string
          evaluated_by?: string | null
          id?: string
          is_clean?: boolean
          is_identified?: boolean
          is_properly_packed?: boolean
          is_separated?: boolean
          order_id: string
          score?: number
          user_id: string
        }
        Update: {
          created_at?: string
          evaluated_by?: string | null
          id?: string
          is_clean?: boolean
          is_identified?: boolean
          is_properly_packed?: boolean
          is_separated?: boolean
          order_id?: string
          score?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sending_quality_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      simulacao_estoque_resultados: {
        Row: {
          candidato: string
          classe_abc: string | null
          classe_consolidada: string | null
          dias_em_ruptura: number | null
          dias_simulados: number | null
          empresa: string
          estoque_max_aplicado: number | null
          estoque_max_observado: number | null
          estoque_medio: number | null
          estoque_min_aplicado: number | null
          estoque_min_observado: number | null
          giros_ano: number | null
          id: number
          lead_time_aplicado: number | null
          metadata: Json | null
          num_pedidos_disparados: number | null
          ponto_pedido_aplicado: number | null
          qtde_compra_aplicada: number | null
          qtde_demandada_total: number | null
          qtde_ruptura_total: number | null
          simulado_em: string | null
          sku_codigo_omie: string
          sku_descricao: string | null
          srl_perc: number | null
          valor_emi: number | null
          valor_ruptura_estimado: number | null
        }
        Insert: {
          candidato: string
          classe_abc?: string | null
          classe_consolidada?: string | null
          dias_em_ruptura?: number | null
          dias_simulados?: number | null
          empresa: string
          estoque_max_aplicado?: number | null
          estoque_max_observado?: number | null
          estoque_medio?: number | null
          estoque_min_aplicado?: number | null
          estoque_min_observado?: number | null
          giros_ano?: number | null
          id?: number
          lead_time_aplicado?: number | null
          metadata?: Json | null
          num_pedidos_disparados?: number | null
          ponto_pedido_aplicado?: number | null
          qtde_compra_aplicada?: number | null
          qtde_demandada_total?: number | null
          qtde_ruptura_total?: number | null
          simulado_em?: string | null
          sku_codigo_omie: string
          sku_descricao?: string | null
          srl_perc?: number | null
          valor_emi?: number | null
          valor_ruptura_estimado?: number | null
        }
        Update: {
          candidato?: string
          classe_abc?: string | null
          classe_consolidada?: string | null
          dias_em_ruptura?: number | null
          dias_simulados?: number | null
          empresa?: string
          estoque_max_aplicado?: number | null
          estoque_max_observado?: number | null
          estoque_medio?: number | null
          estoque_min_aplicado?: number | null
          estoque_min_observado?: number | null
          giros_ano?: number | null
          id?: number
          lead_time_aplicado?: number | null
          metadata?: Json | null
          num_pedidos_disparados?: number | null
          ponto_pedido_aplicado?: number | null
          qtde_compra_aplicada?: number | null
          qtde_demandada_total?: number | null
          qtde_ruptura_total?: number | null
          simulado_em?: string | null
          sku_codigo_omie?: string
          sku_descricao?: string | null
          srl_perc?: number | null
          valor_emi?: number | null
          valor_ruptura_estimado?: number | null
        }
        Relationships: []
      }
      sinal_classe_config: {
        Row: {
          ativado: boolean
          ativado_em: string | null
          classe: string
          updated_at: string
        }
        Insert: {
          ativado?: boolean
          ativado_em?: string | null
          classe: string
          updated_at?: string
        }
        Update: {
          ativado?: boolean
          ativado_em?: string | null
          classe?: string
          updated_at?: string
        }
        Relationships: []
      }
      sku_embalagem_equivalencia: {
        Row: {
          ativo: boolean
          criado_em: string
          criado_por: string | null
          empresa: string
          fator_para_base: number
          fornecedor_nome: string | null
          grupo_id: string
          id: number
          sku_codigo_omie: string
          unidade_base: string
          vigente_ate: string | null
          vigente_desde: string
        }
        Insert: {
          ativo?: boolean
          criado_em?: string
          criado_por?: string | null
          empresa: string
          fator_para_base: number
          fornecedor_nome?: string | null
          grupo_id?: string
          id?: never
          sku_codigo_omie: string
          unidade_base: string
          vigente_ate?: string | null
          vigente_desde?: string
        }
        Update: {
          ativo?: boolean
          criado_em?: string
          criado_por?: string | null
          empresa?: string
          fator_para_base?: number
          fornecedor_nome?: string | null
          grupo_id?: string
          id?: never
          sku_codigo_omie?: string
          unidade_base?: string
          vigente_ate?: string | null
          vigente_desde?: string
        }
        Relationships: []
      }
      sku_estoque_atual: {
        Row: {
          empresa: string
          estoque_disponivel: number | null
          estoque_fisico: number
          estoque_pendente_entrada: number | null
          fonte_sync: string | null
          sku_codigo_omie: string
          ultima_sincronizacao: string | null
        }
        Insert: {
          empresa: string
          estoque_disponivel?: number | null
          estoque_fisico?: number
          estoque_pendente_entrada?: number | null
          fonte_sync?: string | null
          sku_codigo_omie: string
          ultima_sincronizacao?: string | null
        }
        Update: {
          empresa?: string
          estoque_disponivel?: number | null
          estoque_fisico?: number
          estoque_pendente_entrada?: number | null
          fonte_sync?: string | null
          sku_codigo_omie?: string
          ultima_sincronizacao?: string | null
        }
        Relationships: []
      }
      sku_fornecedor_externo: {
        Row: {
          ativo: boolean
          atualizado_em: string
          criado_em: string
          empresa: string
          fator_conversao: number
          fornecedor_nome: string
          id: number
          observacoes: string | null
          sku_omie: string
          sku_portal: string | null
          unidade_portal: string
        }
        Insert: {
          ativo?: boolean
          atualizado_em?: string
          criado_em?: string
          empresa: string
          fator_conversao?: number
          fornecedor_nome: string
          id?: number
          observacoes?: string | null
          sku_omie: string
          sku_portal?: string | null
          unidade_portal?: string
        }
        Update: {
          ativo?: boolean
          atualizado_em?: string
          criado_em?: string
          empresa?: string
          fator_conversao?: number
          fornecedor_nome?: string
          id?: number
          observacoes?: string | null
          sku_omie?: string
          sku_portal?: string | null
          unidade_portal?: string
        }
        Relationships: []
      }
      sku_grupo_producao: {
        Row: {
          atualizado_em: string | null
          atualizado_por: string | null
          empresa: string
          grupo_codigo: string
          sku_codigo_omie: string
        }
        Insert: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          empresa: string
          grupo_codigo: string
          sku_codigo_omie: string
        }
        Update: {
          atualizado_em?: string | null
          atualizado_por?: string | null
          empresa?: string
          grupo_codigo?: string
          sku_codigo_omie?: string
        }
        Relationships: []
      }
      sku_items_sync_controle: {
        Row: {
          criado_em: string
          motivo: string | null
          tentativas: number
          tracking_id: string
          ultima_tentativa: string
        }
        Insert: {
          criado_em?: string
          motivo?: string | null
          tentativas?: number
          tracking_id: string
          ultima_tentativa?: string
        }
        Update: {
          criado_em?: string
          motivo?: string | null
          tentativas?: number
          tracking_id?: string
          ultima_tentativa?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_items_sync_controle_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: true
            referencedRelation: "purchase_orders_tracking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_items_sync_controle_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: true
            referencedRelation: "v_pedidos_em_aberto"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_leadtime_history: {
        Row: {
          created_at: string
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          id: string
          lt_bruto_dias_uteis: number | null
          lt_faturamento_dias_uteis: number | null
          lt_logistica_dias_uteis: number | null
          origem_compra: string
          quantidade_pedida: number | null
          quantidade_recebida: number | null
          sku_codigo: string | null
          sku_codigo_omie: number
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          t1_data_pedido: string
          t2_data_faturamento: string | null
          t3_data_cte: string | null
          t4_data_recebimento: string | null
          tracking_id: string
          updated_at: string
          valor_total: number | null
          valor_unitario: number | null
        }
        Insert: {
          created_at?: string
          empresa: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          origem_compra?: string
          quantidade_pedida?: number | null
          quantidade_recebida?: number | null
          sku_codigo?: string | null
          sku_codigo_omie: number
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          t1_data_pedido: string
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          tracking_id: string
          updated_at?: string
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Update: {
          created_at?: string
          empresa?: Database["public"]["Enums"]["empresa_reposicao"]
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          origem_compra?: string
          quantidade_pedida?: number | null
          quantidade_recebida?: number | null
          sku_codigo?: string | null
          sku_codigo_omie?: number
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          t1_data_pedido?: string
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          tracking_id?: string
          updated_at?: string
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_leadtime_history_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders_tracking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_leadtime_history_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: false
            referencedRelation: "v_pedidos_em_aberto"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_parametros: {
        Row: {
          aplicar_no_omie: boolean | null
          aprovado_em: string | null
          aprovado_por: string | null
          ativo: boolean | null
          classe_abc: string | null
          classe_consolidada: string | null
          classe_forcada: string | null
          classe_proposta_pendente: string | null
          classe_xyz: string | null
          cobertura_alvo_dias: number | null
          data_ultima_mudanca_classe: string | null
          demanda_coef_variacao: number | null
          demanda_desvio_padrao: number | null
          demanda_dias_com_movimento: number | null
          demanda_media_diaria: number | null
          demanda_multiplicador_override: number | null
          demanda_total_90d: number | null
          empresa: string
          estoque_maximo: number | null
          estoque_maximo_omie: number | null
          estoque_minimo: number | null
          estoque_minimo_omie: number | null
          estoque_seguranca: number | null
          fonte_leadtime: string | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          habilitado_reposicao_automatica: boolean | null
          id: string
          justificativa_aprovacao: string | null
          lote_minimo_fornecedor: number | null
          lt_desvio_padrao_dias: number | null
          lt_medio_dias_uteis: number | null
          lt_n_observacoes: number | null
          lt_p95_dias: number | null
          meses_consecutivos_nova_classe: number | null
          minimo_forcado_manual: number | null
          motivo_classe_forcada: string | null
          motivo_override: string | null
          omie_ultima_sincronizacao: string | null
          override_criado_em: string | null
          override_criado_por: string | null
          override_validade_ate: string | null
          parametro_cold_start: boolean
          ponto_pedido: number | null
          ponto_pedido_omie: number | null
          sku_codigo_omie: number
          sku_descricao: string | null
          tipo_reposicao: string | null
          ultima_aplicacao_omie: string | null
          ultima_atualizacao_calculo: string | null
          valor_vendido_90d: number | null
          z_score: number | null
        }
        Insert: {
          aplicar_no_omie?: boolean | null
          aprovado_em?: string | null
          aprovado_por?: string | null
          ativo?: boolean | null
          classe_abc?: string | null
          classe_consolidada?: string | null
          classe_forcada?: string | null
          classe_proposta_pendente?: string | null
          classe_xyz?: string | null
          cobertura_alvo_dias?: number | null
          data_ultima_mudanca_classe?: string | null
          demanda_coef_variacao?: number | null
          demanda_desvio_padrao?: number | null
          demanda_dias_com_movimento?: number | null
          demanda_media_diaria?: number | null
          demanda_multiplicador_override?: number | null
          demanda_total_90d?: number | null
          empresa: string
          estoque_maximo?: number | null
          estoque_maximo_omie?: number | null
          estoque_minimo?: number | null
          estoque_minimo_omie?: number | null
          estoque_seguranca?: number | null
          fonte_leadtime?: string | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          habilitado_reposicao_automatica?: boolean | null
          id?: string
          justificativa_aprovacao?: string | null
          lote_minimo_fornecedor?: number | null
          lt_desvio_padrao_dias?: number | null
          lt_medio_dias_uteis?: number | null
          lt_n_observacoes?: number | null
          lt_p95_dias?: number | null
          meses_consecutivos_nova_classe?: number | null
          minimo_forcado_manual?: number | null
          motivo_classe_forcada?: string | null
          motivo_override?: string | null
          omie_ultima_sincronizacao?: string | null
          override_criado_em?: string | null
          override_criado_por?: string | null
          override_validade_ate?: string | null
          parametro_cold_start?: boolean
          ponto_pedido?: number | null
          ponto_pedido_omie?: number | null
          sku_codigo_omie: number
          sku_descricao?: string | null
          tipo_reposicao?: string | null
          ultima_aplicacao_omie?: string | null
          ultima_atualizacao_calculo?: string | null
          valor_vendido_90d?: number | null
          z_score?: number | null
        }
        Update: {
          aplicar_no_omie?: boolean | null
          aprovado_em?: string | null
          aprovado_por?: string | null
          ativo?: boolean | null
          classe_abc?: string | null
          classe_consolidada?: string | null
          classe_forcada?: string | null
          classe_proposta_pendente?: string | null
          classe_xyz?: string | null
          cobertura_alvo_dias?: number | null
          data_ultima_mudanca_classe?: string | null
          demanda_coef_variacao?: number | null
          demanda_desvio_padrao?: number | null
          demanda_dias_com_movimento?: number | null
          demanda_media_diaria?: number | null
          demanda_multiplicador_override?: number | null
          demanda_total_90d?: number | null
          empresa?: string
          estoque_maximo?: number | null
          estoque_maximo_omie?: number | null
          estoque_minimo?: number | null
          estoque_minimo_omie?: number | null
          estoque_seguranca?: number | null
          fonte_leadtime?: string | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          habilitado_reposicao_automatica?: boolean | null
          id?: string
          justificativa_aprovacao?: string | null
          lote_minimo_fornecedor?: number | null
          lt_desvio_padrao_dias?: number | null
          lt_medio_dias_uteis?: number | null
          lt_n_observacoes?: number | null
          lt_p95_dias?: number | null
          meses_consecutivos_nova_classe?: number | null
          minimo_forcado_manual?: number | null
          motivo_classe_forcada?: string | null
          motivo_override?: string | null
          omie_ultima_sincronizacao?: string | null
          override_criado_em?: string | null
          override_criado_por?: string | null
          override_validade_ate?: string | null
          parametro_cold_start?: boolean
          ponto_pedido?: number | null
          ponto_pedido_omie?: number | null
          sku_codigo_omie?: number
          sku_descricao?: string | null
          tipo_reposicao?: string | null
          ultima_aplicacao_omie?: string | null
          ultima_atualizacao_calculo?: string | null
          valor_vendido_90d?: number | null
          z_score?: number | null
        }
        Relationships: []
      }
      sku_parametros_historico: {
        Row: {
          classe_consolidada: string | null
          demanda_media_diaria: number | null
          estoque_seguranca: number | null
          id: string
          lt_medio_dias_uteis: number | null
          ponto_pedido: number | null
          sku_parametro_id: string | null
          snapshot_em: string | null
          trigger: string | null
          z_score: number | null
        }
        Insert: {
          classe_consolidada?: string | null
          demanda_media_diaria?: number | null
          estoque_seguranca?: number | null
          id?: string
          lt_medio_dias_uteis?: number | null
          ponto_pedido?: number | null
          sku_parametro_id?: string | null
          snapshot_em?: string | null
          trigger?: string | null
          z_score?: number | null
        }
        Update: {
          classe_consolidada?: string | null
          demanda_media_diaria?: number | null
          estoque_seguranca?: number | null
          id?: string
          lt_medio_dias_uteis?: number | null
          ponto_pedido?: number | null
          sku_parametro_id?: string | null
          snapshot_em?: string | null
          trigger?: string | null
          z_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_parametros_historico_sku_parametro_id_fkey"
            columns: ["sku_parametro_id"]
            isOneToOne: false
            referencedRelation: "sku_parametros"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_preco_captura_run: {
        Row: {
          criado_por: string | null
          disparo: string
          empresa: string
          erro: string | null
          evidencia_url: string | null
          id: string
          iniciado_em: string
          linhas_finais_portal: number | null
          modo: string
          status: string
          terminado_em: string | null
          total_alvo: number | null
          total_falha: number | null
          total_nao_encontrado: number | null
          total_ok: number | null
        }
        Insert: {
          criado_por?: string | null
          disparo: string
          empresa: string
          erro?: string | null
          evidencia_url?: string | null
          id?: string
          iniciado_em?: string
          linhas_finais_portal?: number | null
          modo: string
          status?: string
          terminado_em?: string | null
          total_alvo?: number | null
          total_falha?: number | null
          total_nao_encontrado?: number | null
          total_ok?: number | null
        }
        Update: {
          criado_por?: string | null
          disparo?: string
          empresa?: string
          erro?: string | null
          evidencia_url?: string | null
          id?: string
          iniciado_em?: string
          linhas_finais_portal?: number | null
          modo?: string
          status?: string
          terminado_em?: string | null
          total_alvo?: number | null
          total_falha?: number | null
          total_nao_encontrado?: number | null
          total_ok?: number | null
        }
        Relationships: []
      }
      sku_preco_captura_run_item: {
        Row: {
          criado_em: string
          detalhe: string | null
          empresa: string
          fonte: string | null
          id: number
          preco: number | null
          resultado: string
          run_id: string
          sku_codigo_omie: string
          sku_portal: string
        }
        Insert: {
          criado_em?: string
          detalhe?: string | null
          empresa: string
          fonte?: string | null
          id?: never
          preco?: number | null
          resultado: string
          run_id: string
          sku_codigo_omie: string
          sku_portal: string
        }
        Update: {
          criado_em?: string
          detalhe?: string | null
          empresa?: string
          fonte?: string | null
          id?: never
          preco?: number | null
          resultado?: string
          run_id?: string
          sku_codigo_omie?: string
          sku_portal?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_preco_captura_run_item_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "sku_preco_captura_run"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_preco_fornecedor_capturado: {
        Row: {
          capturado_em: string
          criado_em: string
          criado_por: string | null
          empresa: string
          fonte: string
          fornecedor_nome: string | null
          id: number
          moeda: string
          observacao: string | null
          preco: number
          preco_tipo: string
          run_id: string | null
          sku_codigo_omie: string
          status: string
          validade_operacional_ate: string | null
        }
        Insert: {
          capturado_em?: string
          criado_em?: string
          criado_por?: string | null
          empresa: string
          fonte: string
          fornecedor_nome?: string | null
          id?: never
          moeda?: string
          observacao?: string | null
          preco: number
          preco_tipo?: string
          run_id?: string | null
          sku_codigo_omie: string
          status?: string
          validade_operacional_ate?: string | null
        }
        Update: {
          capturado_em?: string
          criado_em?: string
          criado_por?: string | null
          empresa?: string
          fonte?: string
          fornecedor_nome?: string | null
          id?: never
          moeda?: string
          observacao?: string | null
          preco?: number
          preco_tipo?: string
          run_id?: string | null
          sku_codigo_omie?: string
          status?: string
          validade_operacional_ate?: string | null
        }
        Relationships: []
      }
      sku_status_omie: {
        Row: {
          ativo_no_omie: boolean | null
          data_inativacao: string | null
          empresa: string
          estoque_maximo_omie: number | null
          estoque_minimo_omie: number | null
          fonte_sincronizacao: string | null
          ponto_pedido_omie: number | null
          sku_codigo_omie: string
          sku_descricao: string | null
          ultima_sincronizacao: string | null
        }
        Insert: {
          ativo_no_omie?: boolean | null
          data_inativacao?: string | null
          empresa: string
          estoque_maximo_omie?: number | null
          estoque_minimo_omie?: number | null
          fonte_sincronizacao?: string | null
          ponto_pedido_omie?: number | null
          sku_codigo_omie: string
          sku_descricao?: string | null
          ultima_sincronizacao?: string | null
        }
        Update: {
          ativo_no_omie?: boolean | null
          data_inativacao?: string | null
          empresa?: string
          estoque_maximo_omie?: number | null
          estoque_minimo_omie?: number | null
          fonte_sincronizacao?: string | null
          ponto_pedido_omie?: number | null
          sku_codigo_omie?: string
          sku_descricao?: string | null
          ultima_sincronizacao?: string | null
        }
        Relationships: []
      }
      sku_substituicao: {
        Row: {
          acao_parametros: string
          aplicado_em: string | null
          criado_em: string | null
          criado_por: string | null
          data_substituicao: string
          empresa: string
          id: number
          motivo: string | null
          observacoes: string | null
          sku_codigo_antigo: string
          sku_codigo_novo: string
          status: string
        }
        Insert: {
          acao_parametros: string
          aplicado_em?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_substituicao: string
          empresa: string
          id?: number
          motivo?: string | null
          observacoes?: string | null
          sku_codigo_antigo: string
          sku_codigo_novo: string
          status?: string
        }
        Update: {
          acao_parametros?: string
          aplicado_em?: string | null
          criado_em?: string | null
          criado_por?: string | null
          data_substituicao?: string
          empresa?: string
          id?: number
          motivo?: string | null
          observacoes?: string | null
          sku_codigo_antigo?: string
          sku_codigo_novo?: string
          status?: string
        }
        Relationships: []
      }
      standard_processes: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          etapas: Json
          expected_outcomes: string[] | null
          id: string
          name: string
          parent_id: string | null
          porte_alvo: string[] | null
          prerequisites: string[] | null
          reviewed_at: string | null
          reviewed_by: string | null
          segmento: string
          slug: string | null
          status: string
          status_notes: string | null
          tags: string[] | null
          target_audience: string | null
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          etapas: Json
          expected_outcomes?: string[] | null
          id?: string
          name: string
          parent_id?: string | null
          porte_alvo?: string[] | null
          prerequisites?: string[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          segmento: string
          slug?: string | null
          status?: string
          status_notes?: string | null
          tags?: string[] | null
          target_audience?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          etapas?: Json
          expected_outcomes?: string[] | null
          id?: string
          name?: string
          parent_id?: string | null
          porte_alvo?: string[] | null
          prerequisites?: string[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          segmento?: string
          slug?: string | null
          status?: string
          status_notes?: string | null
          tags?: string[] | null
          target_audience?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "standard_processes_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "standard_processes"
            referencedColumns: ["id"]
          },
        ]
      }
      sugestao_negociacao_paralela: {
        Row: {
          atualizado_em: string | null
          campanha_id_gerada: number | null
          criado_em: string | null
          data_acao: string | null
          data_geracao: string
          empresa: string
          id: number
          motivo: string
          motivo_detalhes: Json | null
          observacoes: string | null
          perc_meses_com_promo: number | null
          preco_medio_unitario: number | null
          promocoes_12m: number | null
          score_final: number | null
          sku_codigo_omie: string
          sku_descricao: string | null
          status: string
          valido_ate: string
          volume_financeiro_12m: number | null
        }
        Insert: {
          atualizado_em?: string | null
          campanha_id_gerada?: number | null
          criado_em?: string | null
          data_acao?: string | null
          data_geracao?: string
          empresa: string
          id?: number
          motivo: string
          motivo_detalhes?: Json | null
          observacoes?: string | null
          perc_meses_com_promo?: number | null
          preco_medio_unitario?: number | null
          promocoes_12m?: number | null
          score_final?: number | null
          sku_codigo_omie: string
          sku_descricao?: string | null
          status?: string
          valido_ate?: string
          volume_financeiro_12m?: number | null
        }
        Update: {
          atualizado_em?: string | null
          campanha_id_gerada?: number | null
          criado_em?: string | null
          data_acao?: string | null
          data_geracao?: string
          empresa?: string
          id?: number
          motivo?: string
          motivo_detalhes?: Json | null
          observacoes?: string | null
          perc_meses_com_promo?: number | null
          preco_medio_unitario?: number | null
          promocoes_12m?: number | null
          score_final?: number | null
          sku_codigo_omie?: string
          sku_descricao?: string | null
          status?: string
          valido_ate?: string
          volume_financeiro_12m?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
        ]
      }
      sync_reprocess_config: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string | null
          value: number
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          value: number
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          value?: number
        }
        Relationships: []
      }
      sync_reprocess_log: {
        Row: {
          account: string
          corrections_applied: number | null
          created_at: string
          deletes_count: number | null
          divergences_found: number | null
          duration_ms: number | null
          entity_type: string
          error_message: string | null
          id: string
          metadata: Json | null
          reprocess_type: string
          status: string
          upserts_count: number | null
          window_end: string
          window_start: string
        }
        Insert: {
          account?: string
          corrections_applied?: number | null
          created_at?: string
          deletes_count?: number | null
          divergences_found?: number | null
          duration_ms?: number | null
          entity_type: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          reprocess_type?: string
          status?: string
          upserts_count?: number | null
          window_end: string
          window_start: string
        }
        Update: {
          account?: string
          corrections_applied?: number | null
          created_at?: string
          deletes_count?: number | null
          divergences_found?: number | null
          duration_ms?: number | null
          entity_type?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          reprocess_type?: string
          status?: string
          upserts_count?: number | null
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      sync_state: {
        Row: {
          account: string
          created_at: string | null
          entity_type: string
          error_message: string | null
          id: string
          last_cursor: string | null
          last_page: number | null
          last_sync_at: string | null
          metadata: Json | null
          status: string | null
          total_synced: number | null
          updated_at: string | null
        }
        Insert: {
          account?: string
          created_at?: string | null
          entity_type: string
          error_message?: string | null
          id?: string
          last_cursor?: string | null
          last_page?: number | null
          last_sync_at?: string | null
          metadata?: Json | null
          status?: string | null
          total_synced?: number | null
          updated_at?: string | null
        }
        Update: {
          account?: string
          created_at?: string | null
          entity_type?: string
          error_message?: string | null
          id?: string
          last_cursor?: string | null
          last_page?: number | null
          last_sync_at?: string | null
          metadata?: Json | null
          status?: string | null
          total_synced?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      tarefa_eventos: {
        Row: {
          ator: string | null
          created_at: string
          id: string
          payload: Json | null
          tarefa_id: string | null
          tipo_evento: string
        }
        Insert: {
          ator?: string | null
          created_at?: string
          id?: string
          payload?: Json | null
          tarefa_id?: string | null
          tipo_evento: string
        }
        Update: {
          ator?: string | null
          created_at?: string
          id?: string
          payload?: Json | null
          tarefa_id?: string | null
          tipo_evento?: string
        }
        Relationships: [
          {
            foreignKeyName: "tarefa_eventos_tarefa_id_fkey"
            columns: ["tarefa_id"]
            isOneToOne: false
            referencedRelation: "tarefas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tarefa_eventos_tarefa_id_fkey"
            columns: ["tarefa_id"]
            isOneToOne: false
            referencedRelation: "v_tarefas_estado"
            referencedColumns: ["id"]
          },
        ]
      }
      tarefa_satisfacao_candidatos: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          matched_payload: Json | null
          mode: string
          motivo: string | null
          resolved_at: string | null
          resolved_by: string | null
          source_id: string | null
          source_type: string
          status: string
          tarefa_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          matched_payload?: Json | null
          mode: string
          motivo?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source_id?: string | null
          source_type: string
          status?: string
          tarefa_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          matched_payload?: Json | null
          mode?: string
          motivo?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source_id?: string | null
          source_type?: string
          status?: string
          tarefa_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tarefa_satisfacao_candidatos_tarefa_id_fkey"
            columns: ["tarefa_id"]
            isOneToOne: false
            referencedRelation: "tarefas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tarefa_satisfacao_candidatos_tarefa_id_fkey"
            columns: ["tarefa_id"]
            isOneToOne: false
            referencedRelation: "v_tarefas_estado"
            referencedColumns: ["id"]
          },
        ]
      }
      tarefa_templates: {
        Row: {
          alto_risco: boolean
          amostra_auditoria_pct: number
          area: string
          assigned_to: string
          ativo: boolean
          cadencia: string
          categoria: string
          created_at: string
          created_by: string
          customer_user_id: string | null
          descricao: string
          dias_semana: number[] | null
          empresa: string
          id: string
          janela_fim: string | null
          janela_inicio: string | null
          leitura_max: number | null
          leitura_min: number | null
          leitura_unidade: string | null
          reincidente_limite: number
          requer_comprovacao: boolean
          supervisor_user_id: string | null
          tipo_comprovacao: string
          tolerancia_dias: number
          updated_at: string
        }
        Insert: {
          alto_risco?: boolean
          amostra_auditoria_pct?: number
          area: string
          assigned_to: string
          ativo?: boolean
          cadencia: string
          categoria: string
          created_at?: string
          created_by: string
          customer_user_id?: string | null
          descricao: string
          dias_semana?: number[] | null
          empresa: string
          id?: string
          janela_fim?: string | null
          janela_inicio?: string | null
          leitura_max?: number | null
          leitura_min?: number | null
          leitura_unidade?: string | null
          reincidente_limite?: number
          requer_comprovacao?: boolean
          supervisor_user_id?: string | null
          tipo_comprovacao?: string
          tolerancia_dias?: number
          updated_at?: string
        }
        Update: {
          alto_risco?: boolean
          amostra_auditoria_pct?: number
          area?: string
          assigned_to?: string
          ativo?: boolean
          cadencia?: string
          categoria?: string
          created_at?: string
          created_by?: string
          customer_user_id?: string | null
          descricao?: string
          dias_semana?: number[] | null
          empresa?: string
          id?: string
          janela_fim?: string | null
          janela_inicio?: string | null
          leitura_max?: number | null
          leitura_min?: number | null
          leitura_unidade?: string | null
          reincidente_limite?: number
          requer_comprovacao?: boolean
          supervisor_user_id?: string | null
          tipo_comprovacao?: string
          tolerancia_dias?: number
          updated_at?: string
        }
        Relationships: []
      }
      tarefas: {
        Row: {
          adiada_para: string | null
          assigned_to: string
          auditada_em: string | null
          auditada_por: string | null
          auditoria_motivo: string | null
          auditoria_status: string
          auto_satisfy_mode: string
          backstop_days: number
          categoria: string
          comprovacao_em: string | null
          comprovacao_leitura: number | null
          comprovacao_url: string | null
          concluida_em: string | null
          concluida_por: string | null
          conclusao_origem: string | null
          created_at: string
          created_by: string
          customer_user_id: string | null
          descricao: string
          due_date: string | null
          empresa: string
          escalado_em: string | null
          id: string
          interacao_tipo: string | null
          janela_fim: string | null
          leitura_max: number | null
          leitura_min: number | null
          leitura_unidade: string | null
          modo: string
          motivo_adiamento: string | null
          nota_conclusao: string | null
          requer_comprovacao: boolean
          status: string
          supervisor_user_id: string | null
          target_preco_centavos: number | null
          target_produto_id: string | null
          target_tags: Json | null
          target_texto: string | null
          template_id: string | null
          tipo_comprovacao: string | null
          tolerancia_dias: number
          updated_at: string
        }
        Insert: {
          adiada_para?: string | null
          assigned_to: string
          auditada_em?: string | null
          auditada_por?: string | null
          auditoria_motivo?: string | null
          auditoria_status?: string
          auto_satisfy_mode?: string
          backstop_days?: number
          categoria: string
          comprovacao_em?: string | null
          comprovacao_leitura?: number | null
          comprovacao_url?: string | null
          concluida_em?: string | null
          concluida_por?: string | null
          conclusao_origem?: string | null
          created_at?: string
          created_by: string
          customer_user_id?: string | null
          descricao: string
          due_date?: string | null
          empresa: string
          escalado_em?: string | null
          id?: string
          interacao_tipo?: string | null
          janela_fim?: string | null
          leitura_max?: number | null
          leitura_min?: number | null
          leitura_unidade?: string | null
          modo: string
          motivo_adiamento?: string | null
          nota_conclusao?: string | null
          requer_comprovacao?: boolean
          status?: string
          supervisor_user_id?: string | null
          target_preco_centavos?: number | null
          target_produto_id?: string | null
          target_tags?: Json | null
          target_texto?: string | null
          template_id?: string | null
          tipo_comprovacao?: string | null
          tolerancia_dias?: number
          updated_at?: string
        }
        Update: {
          adiada_para?: string | null
          assigned_to?: string
          auditada_em?: string | null
          auditada_por?: string | null
          auditoria_motivo?: string | null
          auditoria_status?: string
          auto_satisfy_mode?: string
          backstop_days?: number
          categoria?: string
          comprovacao_em?: string | null
          comprovacao_leitura?: number | null
          comprovacao_url?: string | null
          concluida_em?: string | null
          concluida_por?: string | null
          conclusao_origem?: string | null
          created_at?: string
          created_by?: string
          customer_user_id?: string | null
          descricao?: string
          due_date?: string | null
          empresa?: string
          escalado_em?: string | null
          id?: string
          interacao_tipo?: string | null
          janela_fim?: string | null
          leitura_max?: number | null
          leitura_min?: number | null
          leitura_unidade?: string | null
          modo?: string
          motivo_adiamento?: string | null
          nota_conclusao?: string | null
          requer_comprovacao?: boolean
          status?: string
          supervisor_user_id?: string | null
          target_preco_centavos?: number | null
          target_produto_id?: string | null
          target_tags?: Json | null
          target_texto?: string | null
          template_id?: string | null
          tipo_comprovacao?: string | null
          tolerancia_dias?: number
          updated_at?: string
        }
        Relationships: []
      }
      tier_preco_config: {
        Row: {
          company: string
          mult_partida: number
          tier: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company: string
          mult_partida: number
          tier: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company?: string
          mult_partida?: number
          tier?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      tint_bases: {
        Row: {
          account: string
          created_at: string | null
          descricao: string
          id: string
          id_base_sayersystem: string
        }
        Insert: {
          account?: string
          created_at?: string | null
          descricao: string
          id?: string
          id_base_sayersystem: string
        }
        Update: {
          account?: string
          created_at?: string | null
          descricao?: string
          id?: string
          id_base_sayersystem?: string
        }
        Relationships: []
      }
      tint_colecoes: {
        Row: {
          account: string
          created_at: string | null
          descricao: string
          id: string
          id_colecao_sayersystem: string | null
        }
        Insert: {
          account?: string
          created_at?: string | null
          descricao: string
          id?: string
          id_colecao_sayersystem?: string | null
        }
        Update: {
          account?: string
          created_at?: string | null
          descricao?: string
          id?: string
          id_colecao_sayersystem?: string | null
        }
        Relationships: []
      }
      tint_corantes: {
        Row: {
          account: string
          ativo: boolean | null
          codigo_barras: string | null
          created_at: string | null
          descricao: string
          id: string
          id_corante_sayersystem: string
          omie_product_id: string | null
          peso_especifico: number | null
          preco_litro: number | null
          volume_total_ml: number
        }
        Insert: {
          account?: string
          ativo?: boolean | null
          codigo_barras?: string | null
          created_at?: string | null
          descricao: string
          id?: string
          id_corante_sayersystem: string
          omie_product_id?: string | null
          peso_especifico?: number | null
          preco_litro?: number | null
          volume_total_ml: number
        }
        Update: {
          account?: string
          ativo?: boolean | null
          codigo_barras?: string | null
          created_at?: string | null
          descricao?: string
          id?: string
          id_corante_sayersystem?: string
          omie_product_id?: string | null
          peso_especifico?: number | null
          preco_litro?: number | null
          volume_total_ml?: number
        }
        Relationships: [
          {
            foreignKeyName: "tint_corantes_omie_product_id_fkey"
            columns: ["omie_product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_embalagens: {
        Row: {
          account: string
          created_at: string | null
          descricao: string | null
          id: string
          id_embalagem_sayersystem: string
          volume_ml: number
        }
        Insert: {
          account?: string
          created_at?: string | null
          descricao?: string | null
          id?: string
          id_embalagem_sayersystem: string
          volume_ml: number
        }
        Update: {
          account?: string
          created_at?: string | null
          descricao?: string | null
          id?: string
          id_embalagem_sayersystem?: string
          volume_ml?: number
        }
        Relationships: []
      }
      tint_formula_itens: {
        Row: {
          corante_id: string
          created_at: string | null
          formula_id: string
          id: string
          ordem: number
          qtd_ml: number
        }
        Insert: {
          corante_id: string
          created_at?: string | null
          formula_id: string
          id?: string
          ordem: number
          qtd_ml: number
        }
        Update: {
          corante_id?: string
          created_at?: string | null
          formula_id?: string
          id?: string
          ordem?: number
          qtd_ml?: number
        }
        Relationships: [
          {
            foreignKeyName: "tint_formula_itens_corante_id_fkey"
            columns: ["corante_id"]
            isOneToOne: false
            referencedRelation: "tint_corantes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formula_itens_formula_id_fkey"
            columns: ["formula_id"]
            isOneToOne: false
            referencedRelation: "tint_formulas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formula_itens_formula_id_fkey"
            columns: ["formula_id"]
            isOneToOne: false
            referencedRelation: "v_tint_formula_canonica"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_formulas: {
        Row: {
          account: string
          base_id: string
          cor_id: string
          created_at: string | null
          data_geracao: string | null
          desativada_em: string | null
          embalagem_id: string
          id: string
          id_seq: number | null
          importacao_id: string | null
          nome_cor: string
          personalizada: boolean | null
          preco_final_sayersystem: number | null
          produto_id: string
          sku_id: string | null
          subcolecao_id: string | null
          updated_at: string | null
          volume_final_ml: number | null
        }
        Insert: {
          account?: string
          base_id: string
          cor_id: string
          created_at?: string | null
          data_geracao?: string | null
          desativada_em?: string | null
          embalagem_id: string
          id?: string
          id_seq?: number | null
          importacao_id?: string | null
          nome_cor: string
          personalizada?: boolean | null
          preco_final_sayersystem?: number | null
          produto_id: string
          sku_id?: string | null
          subcolecao_id?: string | null
          updated_at?: string | null
          volume_final_ml?: number | null
        }
        Update: {
          account?: string
          base_id?: string
          cor_id?: string
          created_at?: string | null
          data_geracao?: string | null
          desativada_em?: string | null
          embalagem_id?: string
          id?: string
          id_seq?: number | null
          importacao_id?: string | null
          nome_cor?: string
          personalizada?: boolean | null
          preco_final_sayersystem?: number | null
          produto_id?: string
          sku_id?: string | null
          subcolecao_id?: string | null
          updated_at?: string | null
          volume_final_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_formulas_base_id_fkey"
            columns: ["base_id"]
            isOneToOne: false
            referencedRelation: "tint_bases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_embalagem_id_fkey"
            columns: ["embalagem_id"]
            isOneToOne: false
            referencedRelation: "tint_embalagens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_importacao_id_fkey"
            columns: ["importacao_id"]
            isOneToOne: false
            referencedRelation: "tint_importacoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_produto_id_fkey"
            columns: ["produto_id"]
            isOneToOne: false
            referencedRelation: "tint_produtos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "tint_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_subcolecao_id_fkey"
            columns: ["subcolecao_id"]
            isOneToOne: false
            referencedRelation: "tint_subcolecoes"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_importacoes: {
        Row: {
          account: string
          arquivo_hash: string
          arquivo_nome: string
          created_at: string | null
          erros_detalhe: Json | null
          id: string
          importado_por: string | null
          registros_atualizados: number | null
          registros_erro: number | null
          registros_importados: number | null
          status: string | null
          tipo: string
          total_registros: number | null
        }
        Insert: {
          account?: string
          arquivo_hash: string
          arquivo_nome: string
          created_at?: string | null
          erros_detalhe?: Json | null
          id?: string
          importado_por?: string | null
          registros_atualizados?: number | null
          registros_erro?: number | null
          registros_importados?: number | null
          status?: string | null
          tipo: string
          total_registros?: number | null
        }
        Update: {
          account?: string
          arquivo_hash?: string
          arquivo_nome?: string
          created_at?: string | null
          erros_detalhe?: Json | null
          id?: string
          importado_por?: string | null
          registros_atualizados?: number | null
          registros_erro?: number | null
          registros_importados?: number | null
          status?: string | null
          tipo?: string
          total_registros?: number | null
        }
        Relationships: []
      }
      tint_integration_settings: {
        Row: {
          account: string
          agent_hostname: string | null
          agent_version: string | null
          created_at: string
          id: string
          integration_mode: Database["public"]["Enums"]["tint_integration_mode"]
          last_heartbeat_at: string | null
          last_keys_snapshot_at: string | null
          schema_fingerprint: string | null
          schema_mismatch: Json | null
          store_code: string
          store_name: string | null
          sync_enabled: boolean
          sync_token: string
          updated_at: string
        }
        Insert: {
          account: string
          agent_hostname?: string | null
          agent_version?: string | null
          created_at?: string
          id?: string
          integration_mode?: Database["public"]["Enums"]["tint_integration_mode"]
          last_heartbeat_at?: string | null
          last_keys_snapshot_at?: string | null
          schema_fingerprint?: string | null
          schema_mismatch?: Json | null
          store_code: string
          store_name?: string | null
          sync_enabled?: boolean
          sync_token?: string
          updated_at?: string
        }
        Update: {
          account?: string
          agent_hostname?: string | null
          agent_version?: string | null
          created_at?: string
          id?: string
          integration_mode?: Database["public"]["Enums"]["tint_integration_mode"]
          last_heartbeat_at?: string | null
          last_keys_snapshot_at?: string | null
          schema_fingerprint?: string | null
          schema_mismatch?: Json | null
          store_code?: string
          store_name?: string | null
          sync_enabled?: boolean
          sync_token?: string
          updated_at?: string
        }
        Relationships: []
      }
      tint_keys_snapshots: {
        Row: {
          account: string
          chunk_index: number
          created_at: string | null
          entity: string
          generated_at: string
          id: string
          keys: Json
          setting_id: string
          snapshot_id: string
          store_code: string
          total_chunks: number
        }
        Insert: {
          account: string
          chunk_index: number
          created_at?: string | null
          entity: string
          generated_at: string
          id?: string
          keys: Json
          setting_id: string
          snapshot_id: string
          store_code: string
          total_chunks: number
        }
        Update: {
          account?: string
          chunk_index?: number
          created_at?: string | null
          entity?: string
          generated_at?: string
          id?: string
          keys?: Json
          setting_id?: string
          snapshot_id?: string
          store_code?: string
          total_chunks?: number
        }
        Relationships: []
      }
      tint_produtos: {
        Row: {
          account: string
          cod_produto: string
          created_at: string | null
          descricao: string
          id: string
        }
        Insert: {
          account?: string
          cod_produto: string
          created_at?: string | null
          descricao: string
          id?: string
        }
        Update: {
          account?: string
          cod_produto?: string
          created_at?: string | null
          descricao?: string
          id?: string
        }
        Relationships: []
      }
      tint_reconciliation_items: {
        Row: {
          created_at: string
          csv_value: Json | null
          diff_details: Json | null
          diff_fields: string[] | null
          diff_type: string
          entity_key: string
          entity_type: string
          id: string
          reconciliation_run_id: string
          resolved: boolean | null
          resolved_at: string | null
          resolved_by: string | null
          sync_value: Json | null
        }
        Insert: {
          created_at?: string
          csv_value?: Json | null
          diff_details?: Json | null
          diff_fields?: string[] | null
          diff_type: string
          entity_key: string
          entity_type: string
          id?: string
          reconciliation_run_id: string
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          sync_value?: Json | null
        }
        Update: {
          created_at?: string
          csv_value?: Json | null
          diff_details?: Json | null
          diff_fields?: string[] | null
          diff_type?: string
          entity_key?: string
          entity_type?: string
          id?: string
          reconciliation_run_id?: string
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          sync_value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_reconciliation_items_reconciliation_run_id_fkey"
            columns: ["reconciliation_run_id"]
            isOneToOne: false
            referencedRelation: "tint_reconciliation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_reconciliation_runs: {
        Row: {
          account: string
          completed_at: string | null
          created_at: string
          divergences: number | null
          id: string
          matches: number | null
          only_csv: number | null
          only_sync: number | null
          started_at: string
          status: string
          store_code: string
          sync_run_id: string | null
          total_compared: number | null
        }
        Insert: {
          account: string
          completed_at?: string | null
          created_at?: string
          divergences?: number | null
          id?: string
          matches?: number | null
          only_csv?: number | null
          only_sync?: number | null
          started_at?: string
          status?: string
          store_code: string
          sync_run_id?: string | null
          total_compared?: number | null
        }
        Update: {
          account?: string
          completed_at?: string | null
          created_at?: string
          divergences?: number | null
          id?: string
          matches?: number | null
          only_csv?: number | null
          only_sync?: number | null
          started_at?: string
          status?: string
          store_code?: string
          sync_run_id?: string | null
          total_compared?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_reconciliation_runs_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_skus: {
        Row: {
          account: string
          ativo: boolean | null
          base_id: string
          codigo_etiqueta: string | null
          created_at: string | null
          embalagem_id: string
          id: string
          imposto_pct: number | null
          margem_pct: number | null
          omie_product_id: string | null
          produto_id: string
          updated_at: string | null
        }
        Insert: {
          account?: string
          ativo?: boolean | null
          base_id: string
          codigo_etiqueta?: string | null
          created_at?: string | null
          embalagem_id: string
          id?: string
          imposto_pct?: number | null
          margem_pct?: number | null
          omie_product_id?: string | null
          produto_id: string
          updated_at?: string | null
        }
        Update: {
          account?: string
          ativo?: boolean | null
          base_id?: string
          codigo_etiqueta?: string | null
          created_at?: string | null
          embalagem_id?: string
          id?: string
          imposto_pct?: number | null
          margem_pct?: number | null
          omie_product_id?: string | null
          produto_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_skus_base_id_fkey"
            columns: ["base_id"]
            isOneToOne: false
            referencedRelation: "tint_bases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_skus_embalagem_id_fkey"
            columns: ["embalagem_id"]
            isOneToOne: false
            referencedRelation: "tint_embalagens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_skus_omie_product_id_fkey"
            columns: ["omie_product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_skus_produto_id_fkey"
            columns: ["produto_id"]
            isOneToOne: false
            referencedRelation: "tint_produtos"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_bases: {
        Row: {
          account: string
          created_at: string
          descricao: string | null
          id: string
          id_base_sayersystem: string
          matched_id: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
        }
        Insert: {
          account: string
          created_at?: string
          descricao?: string | null
          id?: string
          id_base_sayersystem: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
        }
        Update: {
          account?: string
          created_at?: string
          descricao?: string | null
          id?: string
          id_base_sayersystem?: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_bases_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_corantes: {
        Row: {
          account: string
          created_at: string
          custo: number | null
          descricao: string | null
          id: string
          id_corante_sayersystem: string
          matched_id: string | null
          preco_litro: number | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
          volume_ml: number | null
        }
        Insert: {
          account: string
          created_at?: string
          custo?: number | null
          descricao?: string | null
          id?: string
          id_corante_sayersystem: string
          matched_id?: string | null
          preco_litro?: number | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
          volume_ml?: number | null
        }
        Update: {
          account?: string
          created_at?: string
          custo?: number | null
          descricao?: string | null
          id?: string
          id_corante_sayersystem?: string
          matched_id?: string | null
          preco_litro?: number | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
          volume_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_corantes_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_cores_catalogo: {
        Row: {
          account: string
          colecao: string | null
          cor_id: string
          created_at: string
          id: string
          nome_cor: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          subcolecao: string | null
          sync_run_id: string
        }
        Insert: {
          account: string
          colecao?: string | null
          cor_id: string
          created_at?: string
          id?: string
          nome_cor?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          subcolecao?: string | null
          sync_run_id: string
        }
        Update: {
          account?: string
          colecao?: string | null
          cor_id?: string
          created_at?: string
          id?: string
          nome_cor?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          subcolecao?: string | null
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_cores_catalogo_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_cores_personalizadas: {
        Row: {
          account: string
          cliente: string | null
          cor_id: string
          created_at: string
          id: string
          nome_cor: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
        }
        Insert: {
          account: string
          cliente?: string | null
          cor_id: string
          created_at?: string
          id?: string
          nome_cor?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
        }
        Update: {
          account?: string
          cliente?: string | null
          cor_id?: string
          created_at?: string
          id?: string
          nome_cor?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_cores_personalizadas_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_embalagens: {
        Row: {
          account: string
          created_at: string
          descricao: string | null
          id: string
          id_embalagem_sayersystem: string
          matched_id: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
          volume_ml: number | null
        }
        Insert: {
          account: string
          created_at?: string
          descricao?: string | null
          id?: string
          id_embalagem_sayersystem: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
          volume_ml?: number | null
        }
        Update: {
          account?: string
          created_at?: string
          descricao?: string | null
          id?: string
          id_embalagem_sayersystem?: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
          volume_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_embalagens_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_formula_itens: {
        Row: {
          created_at: string
          id: string
          id_corante: string
          ordem: number | null
          qtd_ml: number | null
          staging_formula_id: string | null
          sync_run_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          id_corante: string
          ordem?: number | null
          qtd_ml?: number | null
          staging_formula_id?: string | null
          sync_run_id: string
        }
        Update: {
          created_at?: string
          id?: string
          id_corante?: string
          ordem?: number | null
          qtd_ml?: number | null
          staging_formula_id?: string | null
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_formula_itens_staging_formula_id_fkey"
            columns: ["staging_formula_id"]
            isOneToOne: false
            referencedRelation: "tint_staging_formulas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_staging_formula_itens_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_formulas: {
        Row: {
          account: string
          cod_produto: string | null
          cor_id: string
          created_at: string
          expected_item_count: number | null
          id: string
          id_base: string | null
          id_embalagem: string | null
          is_base_pura: boolean | null
          matched_id: string | null
          nome_cor: string | null
          personalizada: boolean | null
          preco_final: number | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          subcolecao: string | null
          sync_run_id: string
          volume_final_ml: number | null
        }
        Insert: {
          account: string
          cod_produto?: string | null
          cor_id: string
          created_at?: string
          expected_item_count?: number | null
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
          is_base_pura?: boolean | null
          matched_id?: string | null
          nome_cor?: string | null
          personalizada?: boolean | null
          preco_final?: number | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          subcolecao?: string | null
          sync_run_id: string
          volume_final_ml?: number | null
        }
        Update: {
          account?: string
          cod_produto?: string | null
          cor_id?: string
          created_at?: string
          expected_item_count?: number | null
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
          is_base_pura?: boolean | null
          matched_id?: string | null
          nome_cor?: string | null
          personalizada?: boolean | null
          preco_final?: number | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          subcolecao?: string | null
          sync_run_id?: string
          volume_final_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_formulas_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_precos_base: {
        Row: {
          account: string
          cod_produto: string
          created_at: string | null
          custo: number | null
          id: string
          id_base: string
          id_embalagem: string
          imposto_pct: number | null
          margem_pct: number | null
          raw_data: Json | null
          staging_status: string | null
          store_code: string
          sync_run_id: string | null
        }
        Insert: {
          account: string
          cod_produto: string
          created_at?: string | null
          custo?: number | null
          id?: string
          id_base: string
          id_embalagem: string
          imposto_pct?: number | null
          margem_pct?: number | null
          raw_data?: Json | null
          staging_status?: string | null
          store_code: string
          sync_run_id?: string | null
        }
        Update: {
          account?: string
          cod_produto?: string
          created_at?: string | null
          custo?: number | null
          id?: string
          id_base?: string
          id_embalagem?: string
          imposto_pct?: number | null
          margem_pct?: number | null
          raw_data?: Json | null
          staging_status?: string | null
          store_code?: string
          sync_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_precos_base_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_preparacao_itens: {
        Row: {
          created_at: string
          id: string
          id_corante: string
          ordem: number | null
          qtd_ml: number | null
          staging_preparacao_id: string | null
          sync_run_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          id_corante: string
          ordem?: number | null
          qtd_ml?: number | null
          staging_preparacao_id?: string | null
          sync_run_id: string
        }
        Update: {
          created_at?: string
          id?: string
          id_corante?: string
          ordem?: number | null
          qtd_ml?: number | null
          staging_preparacao_id?: string | null
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_preparacao_itens_staging_preparacao_id_fkey"
            columns: ["staging_preparacao_id"]
            isOneToOne: false
            referencedRelation: "tint_staging_preparacoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_staging_preparacao_itens_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_preparacoes: {
        Row: {
          account: string
          cliente: string | null
          cod_produto: string | null
          cor_id: string | null
          created_at: string
          data_preparacao: string | null
          id: string
          id_base: string | null
          id_embalagem: string | null
          nome_cor: string | null
          personalizada: boolean | null
          preco: number | null
          preparacao_id: string
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
          volume_ml: number | null
        }
        Insert: {
          account: string
          cliente?: string | null
          cod_produto?: string | null
          cor_id?: string | null
          created_at?: string
          data_preparacao?: string | null
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
          nome_cor?: string | null
          personalizada?: boolean | null
          preco?: number | null
          preparacao_id: string
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
          volume_ml?: number | null
        }
        Update: {
          account?: string
          cliente?: string | null
          cod_produto?: string | null
          cor_id?: string | null
          created_at?: string
          data_preparacao?: string | null
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
          nome_cor?: string | null
          personalizada?: boolean | null
          preco?: number | null
          preparacao_id?: string
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
          volume_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_preparacoes_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_produtos: {
        Row: {
          account: string
          cod_produto: string
          created_at: string
          descricao: string | null
          id: string
          matched_id: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
        }
        Insert: {
          account: string
          cod_produto: string
          created_at?: string
          descricao?: string | null
          id?: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
        }
        Update: {
          account?: string
          cod_produto?: string
          created_at?: string
          descricao?: string | null
          id?: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_produtos_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_staging_skus: {
        Row: {
          account: string
          cod_produto: string
          created_at: string
          id: string
          id_base: string
          id_embalagem: string
          matched_id: string | null
          raw_data: Json | null
          staging_status: string
          store_code: string
          sync_run_id: string
        }
        Insert: {
          account: string
          cod_produto: string
          created_at?: string
          id?: string
          id_base: string
          id_embalagem: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code: string
          sync_run_id: string
        }
        Update: {
          account?: string
          cod_produto?: string
          created_at?: string
          id?: string
          id_base?: string
          id_embalagem?: string
          matched_id?: string | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_staging_skus_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_subcolecoes: {
        Row: {
          account: string
          colecao_id: string | null
          created_at: string | null
          descricao: string
          id: string
          id_subcolecao_sayersystem: string | null
        }
        Insert: {
          account?: string
          colecao_id?: string | null
          created_at?: string | null
          descricao: string
          id?: string
          id_subcolecao_sayersystem?: string | null
        }
        Update: {
          account?: string
          colecao_id?: string | null
          created_at?: string | null
          descricao?: string
          id?: string
          id_subcolecao_sayersystem?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_subcolecoes_colecao_id_fkey"
            columns: ["colecao_id"]
            isOneToOne: false
            referencedRelation: "tint_colecoes"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_sync_errors: {
        Row: {
          created_at: string
          entity_id: string | null
          entity_type: string
          error_details: Json | null
          error_message: string
          id: string
          raw_data: Json | null
          sync_run_id: string
        }
        Insert: {
          created_at?: string
          entity_id?: string | null
          entity_type: string
          error_details?: Json | null
          error_message: string
          id?: string
          raw_data?: Json | null
          sync_run_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          error_details?: Json | null
          error_message?: string
          id?: string
          raw_data?: Json | null
          sync_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tint_sync_errors_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "tint_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_sync_runs: {
        Row: {
          account: string
          completed_at: string | null
          created_at: string
          deletes: number | null
          duration_ms: number | null
          errors: number | null
          id: string
          idempotency_key: string | null
          idempotency_response: Json | null
          inserts: number | null
          metadata: Json | null
          setting_id: string
          source: string
          started_at: string
          status: string
          store_code: string
          sync_type: string
          total_records: number | null
          updates: number | null
        }
        Insert: {
          account: string
          completed_at?: string | null
          created_at?: string
          deletes?: number | null
          duration_ms?: number | null
          errors?: number | null
          id?: string
          idempotency_key?: string | null
          idempotency_response?: Json | null
          inserts?: number | null
          metadata?: Json | null
          setting_id: string
          source?: string
          started_at?: string
          status?: string
          store_code: string
          sync_type?: string
          total_records?: number | null
          updates?: number | null
        }
        Update: {
          account?: string
          completed_at?: string | null
          created_at?: string
          deletes?: number | null
          duration_ms?: number | null
          errors?: number | null
          id?: string
          idempotency_key?: string | null
          idempotency_response?: Json | null
          inserts?: number | null
          metadata?: Json | null
          setting_id?: string
          source?: string
          started_at?: string
          status?: string
          store_code?: string
          sync_type?: string
          total_records?: number | null
          updates?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_sync_runs_setting_id_fkey"
            columns: ["setting_id"]
            isOneToOne: false
            referencedRelation: "tint_integration_settings"
            referencedColumns: ["id"]
          },
        ]
      }
      tint_vendas: {
        Row: {
          account: string
          created_at: string | null
          data_venda: string
          id: string
          id_venda_sayersystem: string | null
          operador: string | null
          origem: string | null
        }
        Insert: {
          account?: string
          created_at?: string | null
          data_venda: string
          id?: string
          id_venda_sayersystem?: string | null
          operador?: string | null
          origem?: string | null
        }
        Update: {
          account?: string
          created_at?: string | null
          data_venda?: string
          id?: string
          id_venda_sayersystem?: string | null
          operador?: string | null
          origem?: string | null
        }
        Relationships: []
      }
      tint_vendas_itens: {
        Row: {
          cor_id: string | null
          created_at: string | null
          formula_id: string | null
          id: string
          nome_cor: string | null
          personalizada: boolean | null
          preco_praticado: number | null
          sku_id: string | null
          venda_id: string
          volume_dosado_ml: number | null
        }
        Insert: {
          cor_id?: string | null
          created_at?: string | null
          formula_id?: string | null
          id?: string
          nome_cor?: string | null
          personalizada?: boolean | null
          preco_praticado?: number | null
          sku_id?: string | null
          venda_id: string
          volume_dosado_ml?: number | null
        }
        Update: {
          cor_id?: string | null
          created_at?: string | null
          formula_id?: string | null
          id?: string
          nome_cor?: string | null
          personalizada?: boolean | null
          preco_praticado?: number | null
          sku_id?: string | null
          venda_id?: string
          volume_dosado_ml?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_vendas_itens_formula_id_fkey"
            columns: ["formula_id"]
            isOneToOne: false
            referencedRelation: "tint_formulas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_vendas_itens_formula_id_fkey"
            columns: ["formula_id"]
            isOneToOne: false
            referencedRelation: "v_tint_formula_canonica"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_vendas_itens_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "tint_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_vendas_itens_venda_id_fkey"
            columns: ["venda_id"]
            isOneToOne: false
            referencedRelation: "tint_vendas"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_categories: {
        Row: {
          created_at: string
          description: string | null
          icon: string | null
          id: string
          name: string
          suggested_interval_days: number | null
          usage_type: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          name: string
          suggested_interval_days?: number | null
          usage_type?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          name?: string
          suggested_interval_days?: number | null
          usage_type?: string
        }
        Relationships: []
      }
      tool_events: {
        Row: {
          created_at: string
          description: string | null
          event_type: string
          id: string
          metadata: Json | null
          order_id: string | null
          performed_by: string | null
          user_tool_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          order_id?: string | null
          performed_by?: string | null
          user_tool_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          order_id?: string | null
          performed_by?: string | null
          user_tool_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_events_user_tool_id_fkey"
            columns: ["user_tool_id"]
            isOneToOne: false
            referencedRelation: "user_tools"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_specifications: {
        Row: {
          allow_custom_option: boolean
          created_at: string
          display_order: number | null
          id: string
          is_required: boolean | null
          options: Json | null
          spec_key: string
          spec_label: string
          spec_type: string
          tool_category_id: string | null
        }
        Insert: {
          allow_custom_option?: boolean
          created_at?: string
          display_order?: number | null
          id?: string
          is_required?: boolean | null
          options?: Json | null
          spec_key: string
          spec_label: string
          spec_type?: string
          tool_category_id?: string | null
        }
        Update: {
          allow_custom_option?: boolean
          created_at?: string
          display_order?: number | null
          id?: string
          is_required?: boolean | null
          options?: Json | null
          spec_key?: string
          spec_label?: string
          spec_type?: string
          tool_category_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tool_specifications_tool_category_id_fkey"
            columns: ["tool_category_id"]
            isOneToOne: false
            referencedRelation: "tool_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      training_completions: {
        Row: {
          completed_at: string
          id: string
          module_id: string
          passed: boolean
          quiz_score: number
          user_id: string
        }
        Insert: {
          completed_at?: string
          id?: string
          module_id: string
          passed?: boolean
          quiz_score?: number
          user_id: string
        }
        Update: {
          completed_at?: string
          id?: string
          module_id?: string
          passed?: boolean
          quiz_score?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_completions_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "training_modules"
            referencedColumns: ["id"]
          },
        ]
      }
      training_modules: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          min_score: number
          points_reward: number
          quiz_questions: Json
          title: string
          video_url: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          min_score?: number
          points_reward?: number
          quiz_questions?: Json
          title: string
          video_url?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          min_score?: number
          points_reward?: number
          quiz_questions?: Json
          title?: string
          video_url?: string | null
        }
        Relationships: []
      }
      user_departments: {
        Row: {
          created_at: string
          created_by: string | null
          department: Database["public"]["Enums"]["department"]
          id: string
          primary_dept: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          department: Database["public"]["Enums"]["department"]
          id?: string
          primary_dept?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          department?: Database["public"]["Enums"]["department"]
          id?: string
          primary_dept?: boolean
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_tools: {
        Row: {
          created_at: string
          custom_name: string | null
          generated_name: string | null
          id: string
          internal_code: string | null
          last_sharpened_at: string | null
          next_sharpening_due: string | null
          quantity: number | null
          sharpening_interval_days: number | null
          specifications: Json | null
          tool_category_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          custom_name?: string | null
          generated_name?: string | null
          id?: string
          internal_code?: string | null
          last_sharpened_at?: string | null
          next_sharpening_due?: string | null
          quantity?: number | null
          sharpening_interval_days?: number | null
          specifications?: Json | null
          tool_category_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          custom_name?: string | null
          generated_name?: string | null
          id?: string
          internal_code?: string | null
          last_sharpened_at?: string | null
          next_sharpening_due?: string | null
          quantity?: number | null
          sharpening_interval_days?: number | null
          specifications?: Json | null
          tool_category_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_tools_tool_category_id_fkey"
            columns: ["tool_category_id"]
            isOneToOne: false
            referencedRelation: "tool_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      venda_bloqueio_credito_log: {
        Row: {
          acao: string
          company: string
          created_at: string
          detalhe: string | null
          excecao_id: string | null
          id: string
          omie_codigo_cliente: number | null
          sales_order_id: string | null
          titulos: number | null
          user_id: string | null
          vencido: number | null
        }
        Insert: {
          acao: string
          company: string
          created_at?: string
          detalhe?: string | null
          excecao_id?: string | null
          id?: string
          omie_codigo_cliente?: number | null
          sales_order_id?: string | null
          titulos?: number | null
          user_id?: string | null
          vencido?: number | null
        }
        Update: {
          acao?: string
          company?: string
          created_at?: string
          detalhe?: string | null
          excecao_id?: string | null
          id?: string
          omie_codigo_cliente?: number | null
          sales_order_id?: string | null
          titulos?: number | null
          user_id?: string | null
          vencido?: number | null
        }
        Relationships: []
      }
      venda_excecao_credito: {
        Row: {
          aprovado_por: string
          company: string
          created_at: string
          id: string
          motivo: string
          nome_cliente: string | null
          omie_codigo_cliente: number
          sales_order_id: string
          valido_ate: string
          vencido_no_momento: number | null
        }
        Insert: {
          aprovado_por: string
          company: string
          created_at?: string
          id?: string
          motivo: string
          nome_cliente?: string | null
          omie_codigo_cliente: number
          sales_order_id: string
          valido_ate: string
          vencido_no_momento?: number | null
        }
        Update: {
          aprovado_por?: string
          company?: string
          created_at?: string
          id?: string
          motivo?: string
          nome_cliente?: string | null
          omie_codigo_cliente?: number
          sales_order_id?: string
          valido_ate?: string
          vencido_no_momento?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "venda_excecao_credito_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venda_excecao_credito_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "selfservice_meus_pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      venda_items_history: {
        Row: {
          cfop: string | null
          cliente_cidade: string | null
          cliente_cnpj_cpf: string | null
          cliente_codigo_omie: number | null
          cliente_razao_social: string | null
          cliente_uf: string | null
          created_at: string
          data_emissao: string
          empresa: string
          id: string
          nfe_chave_acesso: string | null
          nfe_numero: string | null
          nfe_serie: string | null
          quantidade: number
          raw_data: Json | null
          sku_codigo: string | null
          sku_codigo_omie: number
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          valor_total: number | null
          valor_unitario: number | null
        }
        Insert: {
          cfop?: string | null
          cliente_cidade?: string | null
          cliente_cnpj_cpf?: string | null
          cliente_codigo_omie?: number | null
          cliente_razao_social?: string | null
          cliente_uf?: string | null
          created_at?: string
          data_emissao: string
          empresa: string
          id?: string
          nfe_chave_acesso?: string | null
          nfe_numero?: string | null
          nfe_serie?: string | null
          quantidade: number
          raw_data?: Json | null
          sku_codigo?: string | null
          sku_codigo_omie: number
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Update: {
          cfop?: string | null
          cliente_cidade?: string | null
          cliente_cnpj_cpf?: string | null
          cliente_codigo_omie?: number | null
          cliente_razao_social?: string | null
          cliente_uf?: string | null
          created_at?: string
          data_emissao?: string
          empresa?: string
          id?: string
          nfe_chave_acesso?: string | null
          nfe_numero?: string | null
          nfe_serie?: string | null
          quantidade?: number
          raw_data?: Json | null
          sku_codigo?: string | null
          sku_codigo_omie?: number
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Relationships: []
      }
      vendas_sync_cursor: {
        Row: {
          account: string
          completed_at: string | null
          date_from: string
          date_to: string
          heartbeat_at: string | null
          last_error_kind: string | null
          next_page: number | null
          running_since: string | null
          updated_at: string
        }
        Insert: {
          account: string
          completed_at?: string | null
          date_from: string
          date_to: string
          heartbeat_at?: string | null
          last_error_kind?: string | null
          next_page?: number | null
          running_since?: string | null
          updated_at?: string
        }
        Update: {
          account?: string
          completed_at?: string | null
          date_from?: string
          date_to?: string
          heartbeat_at?: string | null
          last_error_kind?: string | null
          next_page?: number | null
          running_since?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      vendor_sip_credentials: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          sip_caller_id: string | null
          sip_pass: string
          sip_user: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          sip_caller_id?: string | null
          sip_pass: string
          sip_user: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          sip_caller_id?: string | null
          sip_pass?: string
          sip_user?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      visit_score_recalc_queue: {
        Row: {
          customer_user_id: string
          enqueued_at: string
          error: string | null
          farmer_id: string
          id: string
          processed_at: string | null
          reason: string
          source_event_id: string | null
        }
        Insert: {
          customer_user_id: string
          enqueued_at?: string
          error?: string | null
          farmer_id: string
          id?: string
          processed_at?: string | null
          reason: string
          source_event_id?: string | null
        }
        Update: {
          customer_user_id?: string
          enqueued_at?: string
          error?: string | null
          farmer_id?: string
          id?: string
          processed_at?: string | null
          reason?: string
          source_event_id?: string | null
        }
        Relationships: []
      }
      visitas_agendadas: {
        Row: {
          created_at: string
          customer_user_id: string
          id: string
          notes: string | null
          route_visit_id: string | null
          scheduled_by: string
          scheduled_date: string
          status: string
          updated_at: string
          visit_type: string
        }
        Insert: {
          created_at?: string
          customer_user_id: string
          id?: string
          notes?: string | null
          route_visit_id?: string | null
          scheduled_by: string
          scheduled_date: string
          status?: string
          updated_at?: string
          visit_type?: string
        }
        Update: {
          created_at?: string
          customer_user_id?: string
          id?: string
          notes?: string | null
          route_visit_id?: string | null
          scheduled_by?: string
          scheduled_date?: string
          status?: string
          updated_at?: string
          visit_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitas_agendadas_route_visit_id_fkey"
            columns: ["route_visit_id"]
            isOneToOne: false
            referencedRelation: "route_visits"
            referencedColumns: ["id"]
          },
        ]
      }
      warehouses: {
        Row: {
          cnpj: string | null
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          cnpj?: string | null
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          cnpj?: string | null
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          credential_id: string
          expires_at: string
          id: string
        }
        Insert: {
          challenge: string
          created_at?: string
          credential_id: string
          expires_at?: string
          id?: string
        }
        Update: {
          challenge?: string
          created_at?: string
          credential_id?: string
          expires_at?: string
          id?: string
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          device_name: string | null
          id: string
          last_used_at: string | null
          public_key: string
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_conversations: {
        Row: {
          assigned_operator_id: string | null
          contact_name: string | null
          created_at: string
          customer_user_id: string | null
          id: string
          last_inbound_at: string | null
          last_message_at: string | null
          last_outbound_at: string | null
          opt_in_status: string
          phone_e164: string | null
          phone_key: string
          status: string
        }
        Insert: {
          assigned_operator_id?: string | null
          contact_name?: string | null
          created_at?: string
          customer_user_id?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_outbound_at?: string | null
          opt_in_status?: string
          phone_e164?: string | null
          phone_key: string
          status?: string
        }
        Update: {
          assigned_operator_id?: string | null
          contact_name?: string | null
          created_at?: string
          customer_user_id?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_outbound_at?: string | null
          opt_in_status?: string
          phone_e164?: string | null
          phone_key?: string
          status?: string
        }
        Relationships: []
      }
      whatsapp_messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          direction: string
          id: string
          media_id: string | null
          media_url: string | null
          sender_user_id: string | null
          status: string | null
          transcript: string | null
          type: string
          wa_message_id: string | null
          wa_timestamp: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          media_id?: string | null
          media_url?: string | null
          sender_user_id?: string | null
          status?: string | null
          transcript?: string | null
          type?: string
          wa_message_id?: string | null
          wa_timestamp?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          media_id?: string | null
          media_url?: string | null
          sender_user_id?: string | null
          status?: string | null
          transcript?: string | null
          type?: string
          wa_message_id?: string | null
          wa_timestamp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_sla_digest_log: {
        Row: {
          created_at: string
          data_local: string
        }
        Insert: {
          created_at?: string
          data_local: string
        }
        Update: {
          created_at?: string
          data_local?: string
        }
        Relationships: []
      }
      whatsapp_template_sends: {
        Row: {
          body_params: Json
          conversation_id: string | null
          created_at: string
          dedupe_key: string
          disparado_por: string | null
          erro: string | null
          id: string
          origem: string
          phone_e164: string
          status: string
          template_nome: string
          wa_message_id: string | null
        }
        Insert: {
          body_params?: Json
          conversation_id?: string | null
          created_at?: string
          dedupe_key: string
          disparado_por?: string | null
          erro?: string | null
          id?: string
          origem?: string
          phone_e164: string
          status?: string
          template_nome: string
          wa_message_id?: string | null
        }
        Update: {
          body_params?: Json
          conversation_id?: string | null
          created_at?: string
          dedupe_key?: string
          disparado_por?: string | null
          erro?: string | null
          id?: string
          origem?: string
          phone_e164?: string
          status?: string
          template_nome?: string
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_template_sends_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_template_sends_template_nome_fkey"
            columns: ["template_nome"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["nome"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          ativo: boolean
          categoria: string
          corpo_referencia: string
          created_at: string
          id: string
          idioma: string
          nome: string
          num_body_params: number
        }
        Insert: {
          ativo?: boolean
          categoria: string
          corpo_referencia: string
          created_at?: string
          id?: string
          idioma?: string
          nome: string
          num_body_params?: number
        }
        Update: {
          ativo?: boolean
          categoria?: string
          corpo_referencia?: string
          created_at?: string
          id?: string
          idioma?: string
          nome?: string
          num_body_params?: number
        }
        Relationships: []
      }
      whatsapp_webhook_events: {
        Row: {
          id: string
          payload: Json
          processed_at: string | null
          received_at: string
        }
        Insert: {
          id?: string
          payload: Json
          processed_at?: string | null
          received_at?: string
        }
        Update: {
          id?: string
          payload?: Json
          processed_at?: string | null
          received_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      customer_metrics_mv: {
        Row: {
          atraso_relativo: number | null
          calculated_at: string | null
          customer_user_id: string | null
          dias_desde_ultima_compra: number | null
          document: string | null
          faturamento_90d: number | null
          faturamento_prev_90d: number | null
          intervalo_medio_dias: number | null
          is_cold_start: boolean | null
          pedidos_90d: number | null
          razao_social: string | null
          ticket_medio_90d: number | null
          ultima_compra_data: string | null
        }
        Relationships: []
      }
      fin_aging_pagar: {
        Row: {
          a_vencer_qtd: number | null
          a_vencer_valor: number | null
          company: string | null
          vencido_1_30_qtd: number | null
          vencido_1_30_valor: number | null
          vencido_31_60_qtd: number | null
          vencido_31_60_valor: number | null
          vencido_61_90_qtd: number | null
          vencido_61_90_valor: number | null
          vencido_90_plus_qtd: number | null
          vencido_90_plus_valor: number | null
        }
        Relationships: []
      }
      fin_aging_receber: {
        Row: {
          a_vencer_qtd: number | null
          a_vencer_valor: number | null
          company: string | null
          vencido_1_30_qtd: number | null
          vencido_1_30_valor: number | null
          vencido_31_60_qtd: number | null
          vencido_31_60_valor: number | null
          vencido_61_90_qtd: number | null
          vencido_61_90_valor: number | null
          vencido_90_plus_qtd: number | null
          vencido_90_plus_valor: number | null
        }
        Relationships: []
      }
      fin_analise_cp_dimensoes: {
        Row: {
          ano: number | null
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          company: string | null
          departamento: string | null
          mes: number | null
          nome_fornecedor: string | null
          qtd_titulos: number | null
          status_titulo: string | null
          tipo_documento: string | null
          total_documento: number | null
          total_pago: number | null
          total_saldo: number | null
        }
        Relationships: []
      }
      fin_analise_cr_dimensoes: {
        Row: {
          ano: number | null
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          company: string | null
          departamento: string | null
          mes: number | null
          nome_cliente: string | null
          qtd_titulos: number | null
          status_titulo: string | null
          total_documento: number | null
          total_recebido: number | null
          total_saldo: number | null
          vendedor_id: number | null
        }
        Relationships: []
      }
      fin_dre_competencia_base: {
        Row: {
          ano: number | null
          categoria_codigo: string | null
          categoria_descricao: string | null
          company: string | null
          mes: number | null
          origem: string | null
          qtd: number | null
          valor_total: number | null
        }
        Relationships: []
      }
      fin_fluxo_caixa_diario: {
        Row: {
          company: string | null
          data: string | null
          entradas_previstas: number | null
          entradas_realizadas: number | null
          saidas_previstas: number | null
          saidas_realizadas: number | null
        }
        Relationships: []
      }
      inventory_position_operacional: {
        Row: {
          account: string | null
          id: string | null
          omie_codigo_produto: number | null
          product_id: string | null
          saldo: number | null
          synced_at: string | null
        }
        Insert: {
          account?: string | null
          id?: string | null
          omie_codigo_produto?: number | null
          product_id?: string | null
          saldo?: number | null
          synced_at?: string | null
        }
        Update: {
          account?: string | null
          id?: string | null
          omie_codigo_produto?: number | null
          product_id?: string | null
          saldo?: number | null
          synced_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_position_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "omie_products"
            referencedColumns: ["id"]
          },
        ]
      }
      omie_customer_account_map_fresco: {
        Row: {
          account: string | null
          created_at: string | null
          id: string | null
          omie_codigo_cliente: number | null
          omie_codigo_vendedor: number | null
          source: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          account?: string | null
          created_at?: string | null
          id?: string | null
          omie_codigo_cliente?: number | null
          omie_codigo_vendedor?: number | null
          source?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          account?: string | null
          created_at?: string | null
          id?: string | null
          omie_codigo_cliente?: number | null
          omie_codigo_vendedor?: number | null
          source?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      order_feed: {
        Row: {
          account: string | null
          created_at: string | null
          customer_name: string | null
          customer_user_id: string | null
          id: string | null
          item_names: string[] | null
          item_quantity: number | null
          omie_pedido_id: number | null
          order_number: string | null
          origin: string | null
          status: string | null
          subtotal: number | null
          total: number | null
        }
        Relationships: []
      }
      referrals_for_referrer: {
        Row: {
          converted_at: string | null
          created_at: string | null
          id: string | null
          points_awarded: boolean | null
          referred_user_id: string | null
          referrer_id: string | null
          status: string | null
        }
        Insert: {
          converted_at?: string | null
          created_at?: string | null
          id?: string | null
          points_awarded?: boolean | null
          referred_user_id?: string | null
          referrer_id?: string | null
          status?: string | null
        }
        Update: {
          converted_at?: string | null
          created_at?: string | null
          id?: string | null
          points_awarded?: boolean | null
          referred_user_id?: string | null
          referrer_id?: string | null
          status?: string | null
        }
        Relationships: []
      }
      score_recalc_pending: {
        Row: {
          customer_user_id: string | null
          enqueued_at: string | null
          error: string | null
          farmer_id: string | null
          id: string | null
          processed_at: string | null
          reason: string | null
          source_call_id: string | null
        }
        Insert: {
          customer_user_id?: string | null
          enqueued_at?: string | null
          error?: string | null
          farmer_id?: string | null
          id?: string | null
          processed_at?: string | null
          reason?: string | null
          source_call_id?: string | null
        }
        Update: {
          customer_user_id?: string | null
          enqueued_at?: string | null
          error?: string | null
          farmer_id?: string | null
          id?: string | null
          processed_at?: string | null
          reason?: string | null
          source_call_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "score_recalc_queue_source_call_id_fkey"
            columns: ["source_call_id"]
            isOneToOne: false
            referencedRelation: "farmer_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      selfservice_catalogo: {
        Row: {
          account: string | null
          codigo: string | null
          descricao: string | null
          familia: string | null
          imagem_url: string | null
          omie_codigo_produto: number | null
          subfamilia: string | null
          unidade: string | null
        }
        Relationships: []
      }
      selfservice_disponibilidade: {
        Row: {
          account: string | null
          disponivel: boolean | null
          omie_codigo_produto: number | null
        }
        Relationships: []
      }
      selfservice_meus_pedidos: {
        Row: {
          account: string | null
          created_at: string | null
          id: string | null
          omie_numero_pedido: string | null
          order_date_kpi: string | null
          status: string | null
          total: number | null
        }
        Relationships: []
      }
      v_caca_candidatos: {
        Row: {
          cidade_uf: string | null
          cliente_user_id: string | null
          compra_em_outra_empresa: boolean | null
          documento: string | null
          empresa_alvo: string | null
          familias: string[] | null
          nome: string | null
          ramo: string | null
          telefone: string | null
          ticket_faixa: number | null
          ultima_compra_grupo_dias: number | null
        }
        Relationships: []
      }
      v_caca_compradores: {
        Row: {
          cidade_uf: string | null
          documento: string | null
          empresa: string | null
          familias: string[] | null
          lucro_cobertura: number | null
          lucro_proxy: number | null
          n_pedidos: number | null
          ramo: string | null
          recencia_dias: number | null
          ticket_faixa: number | null
          volume: number | null
        }
        Relationships: []
      }
      v_capital_giro_prazos: {
        Row: {
          company: string | null
          pmp: number | null
          pmp_cobertura: number | null
          pmr: number | null
          pmr_cobertura: number | null
        }
        Relationships: []
      }
      v_carteira_sla: {
        Row: {
          churn_risk: number | null
          customer_user_id: string | null
          dias_sem_contato: number | null
          farmer_id: string | null
          health_class: string | null
          last_contact_at: string | null
          priority_score: number | null
          sla_dias: number | null
          vencido: boolean | null
        }
        Relationships: []
      }
      v_cliente_interacoes: {
        Row: {
          at: string | null
          autor_id: string | null
          canal: string | null
          customer_user_id: string | null
          ref_id: string | null
          ref_tabela: string | null
          resumo: string | null
          revenue: number | null
          titulo: string | null
        }
        Relationships: []
      }
      v_clientes_nao_vinculados_atual: {
        Row: {
          cidade: string | null
          cnpj_cpf: string | null
          codigo_vendedor: number | null
          empresa: string | null
          id: string | null
          nome_fantasia: string | null
          omie_codigo_cliente: number | null
          razao_social: string | null
          synced_at: string | null
          uf: string | null
        }
        Relationships: []
      }
      v_cron_jobs_falhas: {
        Row: {
          duracao_segundos: number | null
          end_time: string | null
          jobid: number | null
          jobname: string | null
          return_message: string | null
          runid: number | null
          start_time: string | null
          status: string | null
        }
        Relationships: []
      }
      v_cron_jobs_status: {
        Row: {
          active: boolean | null
          command: string | null
          duracao_media_segundos: number | null
          execucoes_7d: number | null
          falhas_7d: number | null
          jobid: number | null
          jobname: string | null
          schedule: string | null
          sucessos_7d: number | null
          ultima_duracao_seg: number | null
          ultima_execucao: string | null
          ultima_mensagem: string | null
          ultimo_status: string | null
        }
        Relationships: []
      }
      v_des_checkin_atual: {
        Row: {
          ano: number | null
          atingido: boolean | null
          avaliado_com: string | null
          avaliado_por: string | null
          checkin_id: number | null
          codigo: string | null
          criterio_tipo: string | null
          data_avaliacao: string | null
          empresa: string | null
          nome: string | null
          observacao_criterio: string | null
          tipo: string | null
          trimestre: number | null
        }
        Relationships: []
      }
      v_des_desconto_por_checkin: {
        Row: {
          ano: number | null
          bonus_atingido_perc: number | null
          checkin_id: number | null
          data_avaliacao: string | null
          desconto_padrao: number | null
          desconto_total_maximo: number | null
          desconto_total_projetado: number | null
          empresa: string | null
          estrelas: number | null
          faixa_numero: number | null
          qualitativos_atingidos_perc: number | null
          tipo: string | null
          trimestre: number | null
        }
        Relationships: []
      }
      v_des_pedidos_em_transito: {
        Row: {
          ano_atual: number | null
          data_ciclo: string | null
          data_emissao: string | null
          data_faturamento_prevista: string | null
          empresa: string | null
          fatura_no_trimestre: boolean | null
          fim_trimestre: string | null
          fornecedor_nome: string | null
          grupo_codigo: string | null
          horario_disparo_real: string | null
          inicio_trimestre: string | null
          pedido_id: number | null
          status: string | null
          tipo_ciclo: string | null
          trimestre_atual: number | null
          valor_total: number | null
          zona_confianca: string | null
        }
        Relationships: []
      }
      v_des_posicao_trimestre_ao_vivo: {
        Row: {
          ano: number | null
          calculado_em: string | null
          dias_restantes: number | null
          empresa: string | null
          faixa_conservadora: Json | null
          faixa_des_alvo: number | null
          faixa_otimista: Json | null
          fat_bruto_confirmado: number | null
          fim_trimestre: string | null
          gap_para_meta_pessoal: number | null
          gooddata_data_referencia: string | null
          gooddata_objetivo: number | null
          gooddata_pedidos_abertos: number | null
          inicio_trimestre: string | null
          meta_pessoal: number | null
          posicao_ao_vivo_conservadora: number | null
          posicao_ao_vivo_otimista: number | null
          qtd_pedidos_fora_trimestre: number | null
          qtd_pedidos_no_trimestre: number | null
          trimestre: number | null
          valor_em_transito_risco: number | null
          valor_em_transito_seguro: number | null
          valor_fora_trimestre: number | null
        }
        Relationships: []
      }
      v_des_snapshot_mais_recente: {
        Row: {
          ano: number | null
          criado_em: string | null
          data_referencia: string | null
          empresa: string | null
          fat_bruto_qtde: number | null
          fat_bruto_valor: number | null
          id: number | null
          objetivo_qtde: number | null
          objetivo_valor: number | null
          pedidos_abertos_qtde: number | null
          pedidos_abertos_valor: number | null
          trimestre: number | null
        }
        Relationships: []
      }
      v_desconto_flat_condicional_ativo: {
        Row: {
          campanha_id: number | null
          canal_oferta: string | null
          data_corte_pedido: string | null
          data_fim: string | null
          data_inicio: string | null
          data_oferta: string | null
          dias_restantes: number | null
          empresa: string | null
          estado: string | null
          fornecedor_nome: string | null
          nome: string | null
          observacoes_negociacao: string | null
          qtd_itens: number | null
          responsavel_oferta_email: string | null
          responsavel_oferta_nome: string | null
          status_aceite: string | null
          tipo_origem: string | null
          urgencia: string | null
          volume_minimo_condicional: number | null
          volume_minimo_unidade: string | null
        }
        Insert: {
          campanha_id?: number | null
          canal_oferta?: string | null
          data_corte_pedido?: string | null
          data_fim?: string | null
          data_inicio?: string | null
          data_oferta?: string | null
          dias_restantes?: never
          empresa?: string | null
          estado?: string | null
          fornecedor_nome?: string | null
          nome?: string | null
          observacoes_negociacao?: string | null
          qtd_itens?: never
          responsavel_oferta_email?: string | null
          responsavel_oferta_nome?: string | null
          status_aceite?: string | null
          tipo_origem?: string | null
          urgencia?: never
          volume_minimo_condicional?: number | null
          volume_minimo_unidade?: string | null
        }
        Update: {
          campanha_id?: number | null
          canal_oferta?: string | null
          data_corte_pedido?: string | null
          data_fim?: string | null
          data_inicio?: string | null
          data_oferta?: string | null
          dias_restantes?: never
          empresa?: string | null
          estado?: string | null
          fornecedor_nome?: string | null
          nome?: string | null
          observacoes_negociacao?: string | null
          qtd_itens?: never
          responsavel_oferta_email?: string | null
          responsavel_oferta_nome?: string | null
          status_aceite?: string | null
          tipo_origem?: string | null
          urgencia?: never
          volume_minimo_condicional?: number | null
          volume_minimo_unidade?: string | null
        }
        Relationships: []
      }
      v_envios_portal_status: {
        Row: {
          dia: string | null
          esgotados: number | null
          fornecedor_nome: string | null
          media_tentativas: number | null
          status_envio_portal: string | null
          total: number | null
        }
        Relationships: []
      }
      v_fornecedor_lt_logistica_total: {
        Row: {
          cadeia_descricao: string | null
          empresa: string | null
          fornecedor_nome: string | null
          lt_logistica_total_dias_uteis: number | null
          num_etapas: number | null
        }
        Relationships: []
      }
      v_fornecedor_sla_compliance: {
        Row: {
          desvio_medio_perc: number | null
          empresa: string | null
          fornecedor_nome: string | null
          lt_medio_observado_agregado: number | null
          lt_teorico_agregado: number | null
          perc_sla_compliance: number | null
          skus_criticos: number | null
          skus_cumprindo: number | null
          skus_limite: number | null
          skus_total: number | null
          skus_violando: number | null
        }
        Relationships: []
      }
      v_grupo_comercial: {
        Row: {
          dias_desde_ultima: number | null
          documentos_com_compra: number | null
          fat_90d: number | null
          fat_90d_anterior: number | null
          faturamento_total: number | null
          grupo_id: string | null
          media_mensal_6m: number | null
          qtd_pedidos: number | null
          ultima_compra: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "cliente_grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "v_grupo_contas_receber"
            referencedColumns: ["grupo_id"]
          },
        ]
      }
      v_grupo_contas_receber: {
        Row: {
          a_vencer: number | null
          documentos_com_titulo: number | null
          grupo_id: string | null
          nome: string | null
          total_aberto: number | null
          venc_1_30: number | null
          venc_31_60: number | null
          venc_61_90: number | null
          venc_90_mais: number | null
        }
        Relationships: []
      }
      v_grupo_contas_receber_por_doc: {
        Row: {
          company: string | null
          documento: string | null
          grupo_id: string | null
          nome_cliente: string | null
          total_aberto: number | null
          vencido: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "cliente_grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "v_grupo_contas_receber"
            referencedColumns: ["grupo_id"]
          },
        ]
      }
      v_grupo_contatos: {
        Row: {
          cidade: string | null
          documento: string | null
          email: string | null
          empresa_omie: string | null
          endereco: string | null
          grupo_id: string | null
          nome: string | null
          omie_codigo_vendedor: number | null
          phone: string | null
          uf: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "cliente_grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cliente_grupo_membros_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "v_grupo_contas_receber"
            referencedColumns: ["grupo_id"]
          },
        ]
      }
      v_leadtime_por_grupo: {
        Row: {
          empresa: Database["public"]["Enums"]["empresa_reposicao"] | null
          grupo_leadtime: string | null
          lt_bruto_max: number | null
          lt_bruto_medio: number | null
          lt_bruto_p95: number | null
          lt_bruto_stddev: number | null
          lt_faturamento_medio: number | null
          lt_logistica_medio: number | null
          n_pedidos: number | null
        }
        Relationships: []
      }
      v_notificacoes_status: {
        Row: {
          com_calendar_event: number | null
          dia: string | null
          esgotados: number | null
          status: string | null
          total: number | null
        }
        Relationships: []
      }
      v_omie_product_current_spec: {
        Row: {
          account: string | null
          catalisador_codigo: string | null
          catalisador_proporcao_pct: number | null
          demaos_recomendadas: number | null
          diferenciais_chave: string[] | null
          diluente_codigo: string | null
          equipamentos_aplicacao: string[] | null
          kb_product_spec_id: string | null
          omie_codigo_produto: number | null
          pot_life_horas: number | null
          product_category: string | null
          product_code: string | null
          product_name: string | null
          rendimento_m2_por_litro: number | null
          substrato: string[] | null
          supplier: string | null
          uso_recomendado: string | null
          validade_dias: number | null
        }
        Relationships: [
          {
            foreignKeyName: "omie_product_spec_links_kb_product_spec_id_fkey"
            columns: ["kb_product_spec_id"]
            isOneToOne: false
            referencedRelation: "kb_product_specs"
            referencedColumns: ["id"]
          },
        ]
      }
      v_oportunidade_economica_hoje: {
        Row: {
          aumento_evitado_perc: number | null
          aumentos_json: Json | null
          campanha_id: number | null
          campanha_nome: string | null
          cenario: string | null
          custo_capital_efetivo_perc: number | null
          data_limite_acao: string | null
          demanda_diaria: number | null
          desconto_promo_perc: number | null
          desconto_total_perc: number | null
          dias_ate_limite: number | null
          economia_bruta_estimada: number | null
          empresa: string | null
          fornecedor_nome: string | null
          modo_promo: string | null
          preco_item_eoq: number | null
          promo_data_corte_faturamento: string | null
          promo_data_corte_pedido: string | null
          promo_item_id: number | null
          proxima_vigencia_aumento: string | null
          qtde_base: number | null
          qtde_oportunidade: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          tem_negociacao_extra: boolean | null
        }
        Relationships: []
      }
      v_oportunidade_economica_hoje_badge_cached: {
        Row: {
          empresa: string | null
          oportunidade_count: number | null
          refreshed_at: string | null
        }
        Relationships: []
      }
      v_otimizador_compras_insumos: {
        Row: {
          aumento_evitado_perc: number | null
          aumentos_json: Json | null
          campanha_id: number | null
          campanha_nome: string | null
          cenario: string | null
          custo_capital_efetivo_perc: number | null
          data_limite_acao: string | null
          demanda_diaria: number | null
          desconto_promo_perc: number | null
          desconto_total_perc: number | null
          dias_ate_limite: number | null
          economia_bruta_estimada: number | null
          empresa: string | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          frete_fixo: number | null
          frete_perc_valor: number | null
          frete_taxa_pedido: number | null
          lote_minimo_fornecedor: number | null
          minimo_forcado_manual: number | null
          modo_promo: string | null
          prazo_padrao_perc: number | null
          preco_item_eoq: number | null
          promo_data_corte_faturamento: string | null
          promo_data_corte_pedido: string | null
          promo_item_id: number | null
          proxima_vigencia_aumento: string | null
          qtde_base: number | null
          qtde_oportunidade: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          tem_negociacao_extra: boolean | null
        }
        Relationships: []
      }
      v_pcp_malha_oben: {
        Row: {
          comp_oben: number | null
          pai_oben: number | null
          quantidade: number | null
          unidade: string | null
        }
        Relationships: []
      }
      v_pcp_malha_oben_cand: {
        Row: {
          comp_ativo: boolean | null
          comp_codigo_prd: string | null
          comp_oben: number | null
          componente_codigo: number | null
          n_comp_oben: number | null
          n_pai_oben: number | null
          pai_codigo: number | null
          pai_codigo_prd: string | null
          pai_oben: number | null
          perc_perda: number | null
          quantidade: number | null
          un_estoque: string | null
          un_ficha: string | null
        }
        Relationships: []
      }
      v_pcp_malha_oben_quarentena: {
        Row: {
          comp_oben: number | null
          componente_codigo: number | null
          motivo: string | null
          pai_codigo: number | null
          pai_oben: number | null
          perc_perda: number | null
          quantidade: number | null
          un_estoque: string | null
          un_ficha: string | null
        }
        Relationships: []
      }
      v_pedidos_em_aberto: {
        Row: {
          dias_desde_pedido: number | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"] | null
          estagio: string | null
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          id: string | null
          omie_codigo_pedido: number | null
          status: Database["public"]["Enums"]["status_pedido_compra"] | null
          t1_data_pedido: string | null
          t2_data_faturamento: string | null
          t3_data_cte: string | null
          t4_data_recebimento: string | null
        }
        Insert: {
          dias_desde_pedido?: never
          empresa?: Database["public"]["Enums"]["empresa_reposicao"] | null
          estagio?: never
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string | null
          omie_codigo_pedido?: number | null
          status?: Database["public"]["Enums"]["status_pedido_compra"] | null
          t1_data_pedido?: string | null
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
        }
        Update: {
          dias_desde_pedido?: never
          empresa?: Database["public"]["Enums"]["empresa_reposicao"] | null
          estagio?: never
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string | null
          omie_codigo_pedido?: number | null
          status?: Database["public"]["Enums"]["status_pedido_compra"] | null
          t1_data_pedido?: string | null
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
        }
        Relationships: []
      }
      v_prime_extrato_mensal: {
        Row: {
          assinatura_id: string | null
          competencia: string | null
          customer_user_id: string | null
          dentes_bonus: number | null
          dentes_excedentes: number | null
          dentes_restantes: number | null
          dentes_usados: number | null
          franquia_total: number | null
          mensalidade_contratada: number | null
          monetizado_total: number | null
          n_registros: number | null
          status: string | null
          usos_operacionais: number | null
        }
        Relationships: []
      }
      v_promocao_avaliacao_hoje: {
        Row: {
          campanha_id: number | null
          campanha_nome: string | null
          custo_capital_periodo_perc: number | null
          data_fim: string | null
          data_inicio: string | null
          desconto_base: number | null
          desconto_extra: number | null
          desconto_perc: number | null
          dias_extra_estoque: number | null
          economia_bruta_valor: number | null
          economia_liquida_perc: number | null
          economia_liquida_valor: number | null
          empresa: string | null
          fornecedor_nome: string | null
          item_id: number | null
          modo_aplicacao: string | null
          qtde_base: number | null
          qtde_com_desconto: number | null
          qtde_extra: number | null
          sku_codigo_fornecedor: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          tem_negociacao_extra: boolean | null
          tipo_origem: string | null
          volume_minimo: number | null
        }
        Relationships: []
      }
      v_promocao_item_efetivo: {
        Row: {
          ativo: boolean | null
          campanha_id: number | null
          confirmado: boolean | null
          desconto_base: number | null
          desconto_efetivo: number | null
          desconto_extra: number | null
          desconto_extra_email_referencia: string | null
          desconto_extra_negociado_em: string | null
          desconto_extra_negociado_por: string | null
          desconto_extra_observacoes: string | null
          id: number | null
          sku_codigo_fornecedor: string | null
          sku_codigo_omie: number | null
          tem_negociacao_extra: boolean | null
          volume_minimo: number | null
        }
        Insert: {
          ativo?: boolean | null
          campanha_id?: number | null
          confirmado?: boolean | null
          desconto_base?: number | null
          desconto_efetivo?: never
          desconto_extra?: number | null
          desconto_extra_email_referencia?: string | null
          desconto_extra_negociado_em?: string | null
          desconto_extra_negociado_por?: string | null
          desconto_extra_observacoes?: string | null
          id?: number | null
          sku_codigo_fornecedor?: string | null
          sku_codigo_omie?: number | null
          tem_negociacao_extra?: never
          volume_minimo?: number | null
        }
        Update: {
          ativo?: boolean | null
          campanha_id?: number | null
          confirmado?: boolean | null
          desconto_base?: number | null
          desconto_efetivo?: never
          desconto_extra?: number | null
          desconto_extra_email_referencia?: string | null
          desconto_extra_negociado_em?: string | null
          desconto_extra_negociado_por?: string | null
          desconto_extra_observacoes?: string | null
          id?: number | null
          sku_codigo_fornecedor?: string | null
          sku_codigo_omie?: number | null
          tem_negociacao_extra?: never
          volume_minimo?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "promocao_item_campanha_id_fkey"
            columns: ["campanha_id"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
        ]
      }
      v_reposicao_cold_start_elegivel: {
        Row: {
          empresa: string | null
          estoque_catalogo: number | null
          fornecedor_nome: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
        }
        Relationships: []
      }
      v_reposicao_depara_sayerlack_elegivel: {
        Row: {
          empresa: string | null
          familia: string | null
          sku_descricao: string | null
          sku_omie: string | null
        }
        Relationships: []
      }
      v_reposicao_sku_sem_fornecedor: {
        Row: {
          empresa: string | null
          estoque_efetivo: number | null
          estoque_fisico: number | null
          estoque_maximo: number | null
          estoque_pendente: number | null
          omie_descricao: string | null
          ponto_pedido: number | null
          sku_codigo_omie: string | null
          sku_descricao: string | null
        }
        Relationships: []
      }
      v_simulacao_comparativa: {
        Row: {
          candidato: string | null
          classe_abc: string | null
          classe_consolidada: string | null
          dias_em_ruptura: number | null
          empresa: string | null
          estoque_max_aplicado: number | null
          estoque_max_observado: number | null
          estoque_medio: number | null
          estoque_min_aplicado: number | null
          giros_ano: number | null
          lead_time_aplicado: number | null
          num_pedidos_disparados: number | null
          ponto_pedido_aplicado: number | null
          qtde_compra_aplicada: number | null
          qtde_demandada_total: number | null
          qtde_ruptura_total: number | null
          rank_emi: number | null
          rank_giros: number | null
          rank_srl: number | null
          rank_srl_emi: number | null
          sku_codigo_omie: string | null
          sku_descricao: string | null
          srl_perc: number | null
          valor_emi: number | null
          valor_ruptura_estimado: number | null
          vencedor: string | null
        }
        Relationships: []
      }
      v_simulacao_ranking_global: {
        Row: {
          candidato: string | null
          dias_rupt_total: number | null
          emi_medio_rs: number | null
          emi_total_rs: number | null
          empresa: string | null
          giros_medios: number | null
          pedidos_disparados_total: number | null
          perda_ruptura_total_rs: number | null
          skus_simulados: number | null
          skus_srl_95_plus: number | null
          skus_srl_98_plus: number | null
          skus_srl_criticos: number | null
          srl_mediano: number | null
          srl_medio: number | null
          srl_pior: number | null
        }
        Relationships: []
      }
      v_sku_aumento_vigente: {
        Row: {
          aumento_estado: string | null
          aumento_id: number | null
          aumento_item_id: number | null
          aumento_nome: string | null
          aumento_perc: number | null
          categoria_fornecedor: string | null
          data_vigencia_efetiva: string | null
          empresa_lower: string | null
          familia: string | null
          fornecedor_nome: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
        }
        Relationships: []
      }
      v_sku_candidatos_primeira_compra: {
        Row: {
          calculado_em: string | null
          classe_abc_proposta: string | null
          classe_consolidada: string | null
          classe_xyz_proposta: string | null
          coef_variacao_ordem: number | null
          demanda_media_diaria: number | null
          demanda_sigma_diario: number | null
          dias_com_movimento: number | null
          dias_desde_ultima_venda: number | null
          empresa: string | null
          fonte_leadtime: string | null
          fonte_preco: string | null
          fornecedor_habilitado: boolean | null
          fornecedor_nome: string | null
          ja_habilitado: boolean | null
          lead_time_desvio: number | null
          lead_time_medio: number | null
          lt_p95_dias: number | null
          lt_total_teorico_dias_uteis: number | null
          preco_compra_real: number | null
          preco_item_eoq: number | null
          preco_venda_medio: number | null
          primeira_compra_cap_dias: number | null
          primeira_compra_estoque_maximo: number | null
          primeira_compra_ponto_pedido: number | null
          primeira_compra_qtde: number | null
          recorrencia_clientes_180d: number | null
          recorrencia_meses_180d: number | null
          recorrencia_nfs_180d: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          status_sugestao: string | null
          valor_total_180d: number | null
          valor_total_90d: number | null
          z_aplicado: number | null
        }
        Relationships: []
      }
      v_sku_classificacao_abc_xyz: {
        Row: {
          classe_abc_proposta: string | null
          classe_consolidada_proposta: string | null
          classe_xyz_proposta: string | null
          coef_variacao_ordem: number | null
          demanda_media_diaria: number | null
          empresa: string | null
          num_ordens: number | null
          qtde_desvio_por_ordem: number | null
          qtde_media_por_ordem: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          valor_total_90d: number | null
        }
        Relationships: []
      }
      v_sku_demanda_efetiva: {
        Row: {
          cfop: string | null
          cliente_cidade: string | null
          cliente_cnpj_cpf: string | null
          cliente_codigo_omie: number | null
          cliente_razao_social: string | null
          cliente_uf: string | null
          created_at: string | null
          data_emissao: string | null
          empresa: string | null
          id: string | null
          nfe_chave_acesso: string | null
          nfe_numero: string | null
          nfe_serie: string | null
          quantidade: number | null
          raw_data: Json | null
          sku_codigo: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          valor_total: number | null
          valor_unitario: number | null
        }
        Relationships: []
      }
      v_sku_demanda_estatisticas: {
        Row: {
          coef_variacao_ordem: number | null
          demanda_media_diaria: number | null
          demanda_total_90d: number | null
          empresa: string | null
          num_ordens: number | null
          qtde_desvio_por_ordem: number | null
          qtde_media_por_ordem: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_unidade: string | null
          ultima_venda_data: string | null
          valor_total_90d: number | null
        }
        Relationships: []
      }
      v_sku_demanda_rajada: {
        Row: {
          demanda_desvio_diario: number | null
          demanda_media_diaria: number | null
          dias_com_movimento: number | null
          empresa: string | null
          p90_diario: number | null
          p90_quando_vende: number | null
          p95_diario: number | null
          p95_quando_vende: number | null
          p99_diario: number | null
          pico_maximo_dia: number | null
          qtde_total_180d: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_unidade: string | null
          valor_total_180d: number | null
        }
        Relationships: []
      }
      v_sku_leadtime_efetivo: {
        Row: {
          dedup_key: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"] | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          lt_bruto_dias_uteis: number | null
          lt_faturamento_dias_uteis: number | null
          lt_logistica_dias_uteis: number | null
          n_copias_origem: number | null
          nfe_chave_acesso: string | null
          origem_compra: string | null
          quantidade_pedida: number | null
          quantidade_recebida: number | null
          sku_codigo: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          t1_data_pedido: string | null
          t2_data_faturamento: string | null
          t3_data_cte: string | null
          t4_data_recebimento: string | null
          valor_total: number | null
          valor_unitario: number | null
          veio_de_duplicata: boolean | null
        }
        Relationships: []
      }
      v_sku_leadtime_estatisticas: {
        Row: {
          empresa: string | null
          fonte_leadtime: string | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          lt_desvio_padrao_dias: number | null
          lt_fornecedor_desvio: number | null
          lt_fornecedor_n_observacoes: number | null
          lt_medio_dias_uteis: number | null
          lt_n_observacoes: number | null
          lt_p95_dias: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
        }
        Relationships: []
      }
      v_sku_leadtime_history_normal: {
        Row: {
          created_at: string | null
          empresa: Database["public"]["Enums"]["empresa_reposicao"] | null
          fornecedor_codigo_omie: number | null
          fornecedor_nome: string | null
          grupo_leadtime: string | null
          id: string | null
          lt_bruto_dias_uteis: number | null
          lt_faturamento_dias_uteis: number | null
          lt_logistica_dias_uteis: number | null
          origem_compra: string | null
          quantidade_pedida: number | null
          quantidade_recebida: number | null
          sku_codigo: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          t1_data_pedido: string | null
          t2_data_faturamento: string | null
          t3_data_cte: string | null
          t4_data_recebimento: string | null
          tracking_id: string | null
          updated_at: string | null
          valor_total: number | null
          valor_unitario: number | null
        }
        Insert: {
          created_at?: string | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"] | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string | null
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          origem_compra?: string | null
          quantidade_pedida?: number | null
          quantidade_recebida?: number | null
          sku_codigo?: string | null
          sku_codigo_omie?: number | null
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          t1_data_pedido?: string | null
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          tracking_id?: string | null
          updated_at?: string | null
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Update: {
          created_at?: string | null
          empresa?: Database["public"]["Enums"]["empresa_reposicao"] | null
          fornecedor_codigo_omie?: number | null
          fornecedor_nome?: string | null
          grupo_leadtime?: string | null
          id?: string | null
          lt_bruto_dias_uteis?: number | null
          lt_faturamento_dias_uteis?: number | null
          lt_logistica_dias_uteis?: number | null
          origem_compra?: string | null
          quantidade_pedida?: number | null
          quantidade_recebida?: number | null
          sku_codigo?: string | null
          sku_codigo_omie?: number | null
          sku_descricao?: string | null
          sku_ncm?: string | null
          sku_unidade?: string | null
          t1_data_pedido?: string | null
          t2_data_faturamento?: string | null
          t3_data_cte?: string | null
          t4_data_recebimento?: string | null
          tracking_id?: string | null
          updated_at?: string | null
          valor_total?: number | null
          valor_unitario?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_leadtime_history_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders_tracking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_leadtime_history_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: false
            referencedRelation: "v_pedidos_em_aberto"
            referencedColumns: ["id"]
          },
        ]
      }
      v_sku_lt_teorico: {
        Row: {
          cadeia_descricao: string | null
          empresa: string | null
          grupo_codigo: string | null
          horario_corte: string | null
          lt_logistica_dias: number | null
          lt_logistica_unidade: string | null
          lt_producao_dias: number | null
          lt_producao_unidade: string | null
          lt_total_teorico_dias_uteis: number | null
          num_etapas_logistica: number | null
          sku_codigo_omie: string | null
        }
        Relationships: []
      }
      v_sku_parametros_sugeridos: {
        Row: {
          calculado_em: string | null
          classe_abc_proposta: string | null
          classe_consolidada: string | null
          classe_xyz_proposta: string | null
          cobertura_alvo_dias: number | null
          coef_variacao_ordem: number | null
          custo_capital_efetivo_perc: number | null
          custo_pedido_aplicado: number | null
          demanda_media_diaria: number | null
          demanda_sigma_diario: number | null
          dias_com_movimento: number | null
          empresa: string | null
          estoque_maximo_sugerido: number | null
          estoque_minimo_sugerido: number | null
          estoque_seguranca_sugerido: number | null
          fonte_fornecedor: string | null
          fonte_leadtime: string | null
          fonte_lt: string | null
          fonte_preco: string | null
          fornecedor_habilitado: boolean | null
          fornecedor_nome: string | null
          grupo_codigo: string | null
          lead_time_desvio: number | null
          lead_time_medio: number | null
          lt_historico_medio: number | null
          lt_p95_dias: number | null
          lt_total_teorico_dias_uteis: number | null
          minimo_operacional: number | null
          modo_pedido: string | null
          n_compras: number | null
          num_ordens: number | null
          p90_diario: number | null
          p90_quando_vende: number | null
          p95_diario: number | null
          p95_quando_vende: number | null
          p99_diario: number | null
          pico_maximo_dia: number | null
          ponto_pedido_sugerido: number | null
          preco_compra_real: number | null
          preco_item_eoq: number | null
          preco_venda_medio: number | null
          qtde_compra_ciclo_sugerida: number | null
          qtde_desvio_por_ordem: number | null
          qtde_media_por_ordem: number | null
          sigma_lt_d: number | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          status_sugestao: string | null
          valor_total_180d: number | null
          valor_total_90d: number | null
          z_aplicado: number | null
        }
        Relationships: []
      }
      v_sku_sigma_demanda: {
        Row: {
          empresa: string | null
          media_demanda_diaria: number | null
          sigma_demanda_diaria: number | null
          sku_codigo_omie: string | null
        }
        Relationships: []
      }
      v_sku_sla_compliance: {
        Row: {
          desvio_absoluto: number | null
          desvio_perc: number | null
          empresa: string | null
          fornecedor_nome: string | null
          grupo_codigo: string | null
          lt_faturamento_medio: number | null
          lt_logistica_medio: number | null
          lt_max: number | null
          lt_min: number | null
          lt_observado_desvio: number | null
          lt_observado_mediana: number | null
          lt_observado_medio: number | null
          lt_observado_p95: number | null
          lt_recente_medio: number | null
          lt_teorico: number | null
          n_observacoes: number | null
          n_recentes: number | null
          sku_codigo_omie: string | null
          sku_descricao: string | null
          status_sla: string | null
          tendencia: string | null
          ultimo_recebimento: string | null
        }
        Relationships: []
      }
      v_sugestao_negociacao_ativa: {
        Row: {
          campanha_id_gerada: number | null
          categoria: string | null
          data_geracao: string | null
          dias_ate_expirar: number | null
          empresa: string | null
          estoque_efetivo: number | null
          estoque_maximo: number | null
          fornecedor_nome: string | null
          id: number | null
          motivo: string | null
          motivo_detalhes: Json | null
          perc_meses_com_promo: number | null
          ponto_pedido: number | null
          preco_medio_unitario: number | null
          promocoes_12m: number | null
          score_final: number | null
          sku_codigo_omie: string | null
          sku_descricao: string | null
          status: string | null
          valido_ate: string | null
          volume_financeiro_12m: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "promocao_campanha"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_desconto_flat_condicional_ativo"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_oportunidade_economica_hoje"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_otimizador_compras_insumos"
            referencedColumns: ["campanha_id"]
          },
          {
            foreignKeyName: "sugestao_negociacao_paralela_campanha_id_gerada_fkey"
            columns: ["campanha_id_gerada"]
            isOneToOne: false
            referencedRelation: "v_promocao_avaliacao_hoje"
            referencedColumns: ["campanha_id"]
          },
        ]
      }
      v_tarefas_estado: {
        Row: {
          adiada_para: string | null
          assigned_to: string | null
          atrasada: boolean | null
          auditada_em: string | null
          auditada_por: string | null
          auditoria_motivo: string | null
          auditoria_status: string | null
          auto_satisfy_mode: string | null
          backstop_days: number | null
          categoria: string | null
          comprovacao_em: string | null
          comprovacao_leitura: number | null
          comprovacao_url: string | null
          concluida_em: string | null
          concluida_por: string | null
          conclusao_origem: string | null
          created_at: string | null
          created_by: string | null
          customer_user_id: string | null
          descricao: string | null
          due_date: string | null
          effective_due: string | null
          empresa: string | null
          escalado_em: string | null
          escalavel: boolean | null
          id: string | null
          interacao_tipo: string | null
          janela_fim: string | null
          leitura_max: number | null
          leitura_min: number | null
          leitura_unidade: string | null
          modo: string | null
          motivo_adiamento: string | null
          nota_conclusao: string | null
          requer_auditoria: boolean | null
          requer_comprovacao: boolean | null
          responsavel_efetivo: string | null
          status: string | null
          supervisor_user_id: string | null
          target_preco_centavos: number | null
          target_produto_id: string | null
          target_tags: Json | null
          target_texto: string | null
          tem_sugestao_pendente: boolean | null
          template_id: string | null
          tipo_comprovacao: string | null
          tolerancia_dias: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      v_tint_formula_canonica: {
        Row: {
          account: string | null
          cor_id: string | null
          id: string | null
          is_sl: boolean | null
          nome_cor: string | null
          personalizada: boolean | null
          preco_csv_legado: number | null
          preco_final_sayersystem: number | null
          receita_valida: boolean | null
          sku_id: string | null
          subcolecao_id: string | null
          tem_receita: boolean | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tint_formulas_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "tint_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tint_formulas_subcolecao_id_fkey"
            columns: ["subcolecao_id"]
            isOneToOne: false
            referencedRelation: "tint_subcolecoes"
            referencedColumns: ["id"]
          },
        ]
      }
      v_titulo_baixas: {
        Row: {
          company: string | null
          data_baixa_final: string | null
          n_movimentos: number | null
          omie_codigo_lancamento: number | null
          prazo_ponderado_dias: number | null
          tipo: string | null
          valor_baixado: number | null
        }
        Relationships: []
      }
      v_venda_items_history_efetivo: {
        Row: {
          cfop: string | null
          cliente_cidade: string | null
          cliente_cnpj_cpf: string | null
          cliente_codigo_omie: number | null
          cliente_razao_social: string | null
          cliente_uf: string | null
          created_at: string | null
          data_emissao: string | null
          empresa: string | null
          id: string | null
          nfe_chave_acesso: string | null
          nfe_numero: string | null
          nfe_serie: string | null
          quantidade: number | null
          raw_data: Json | null
          sku_codigo: string | null
          sku_codigo_omie: number | null
          sku_descricao: string | null
          sku_ncm: string | null
          sku_unidade: string | null
          valor_total: number | null
          valor_unitario: number | null
        }
        Relationships: []
      }
      v_whatsapp_sla: {
        Row: {
          aguardando_desde: string | null
          contact_name: string | null
          conversation_id: string | null
          customer_user_id: string | null
          minutos_uteis_aguardando: number | null
          nivel: string | null
          owner_user_id: string | null
          phone_e164: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      visit_score_recalc_pending: {
        Row: {
          customer_user_id: string | null
          enqueued_at: string | null
          error: string | null
          farmer_id: string | null
          id: string | null
          processed_at: string | null
          reason: string | null
          source_event_id: string | null
        }
        Insert: {
          customer_user_id?: string | null
          enqueued_at?: string | null
          error?: string | null
          farmer_id?: string | null
          id?: string | null
          processed_at?: string | null
          reason?: string | null
          source_event_id?: string | null
        }
        Update: {
          customer_user_id?: string | null
          enqueued_at?: string | null
          error?: string | null
          farmer_id?: string | null
          id?: string | null
          processed_at?: string | null
          reason?: string | null
          source_event_id?: string | null
        }
        Relationships: []
      }
      vw_pcp_bom_validacao: {
        Row: {
          componente_codigo: number | null
          componente_descricao: string | null
          comprimento_mm: number | null
          esperado: number | null
          largura_mm: number | null
          linha_modelo: string | null
          observado: number | null
          pai_codigo: number | null
          pai_descricao: string | null
          pai_tipo: string | null
          papel: string | null
          regra_origem: string | null
          status: string | null
          tolerancia: number | null
          unidade: string | null
        }
        Relationships: []
      }
      vw_pcp_cmc_cobertura: {
        Row: {
          com_cmc: number | null
          fabricados: number | null
          tipo_item: string | null
        }
        Relationships: []
      }
      vw_pcp_custo_calibracao: {
        Row: {
          custo_total: number | null
          data_posicao: string | null
          div_pct: number | null
          ncmc: number | null
          omie_codigo_produto: number | null
          tipo_item: string | null
          versao_regra: string | null
        }
        Insert: {
          custo_total?: number | null
          data_posicao?: string | null
          div_pct?: never
          ncmc?: never
          omie_codigo_produto?: number | null
          tipo_item?: string | null
          versao_regra?: string | null
        }
        Update: {
          custo_total?: number | null
          data_posicao?: string | null
          div_pct?: never
          ncmc?: never
          omie_codigo_produto?: number | null
          tipo_item?: string | null
          versao_regra?: string | null
        }
        Relationships: []
      }
      vw_pcp_malha_componentes: {
        Row: {
          componente_codigo: number | null
          componente_descricao: string | null
          componente_familia: string | null
          pai_codigo: number | null
          perc_perda: number | null
          quantidade: number | null
          unidade: string | null
        }
        Relationships: []
      }
      vw_pcp_malha_itens: {
        Row: {
          componente_codigo_txt: string | null
          componente_descricao_omie: string | null
          componente_id: number | null
          pai_codigo: number | null
          perc_perda: number | null
          quantidade: number | null
          unidade: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _carteira_mixgap_for_owner: { Args: { p_owner: string }; Returns: Json }
      _carteira_positivacao_for_owner: {
        Args: { p_owner: string }
        Returns: Json
      }
      _data_health_compute: {
        Args: never
        Returns: {
          age_seconds: number
          domain: string
          expected_max_age_seconds: number
          freshness_basis: string
          how_to_fix: string
          last_error: string
          message: string
          probable_cause: string
          severity: string
          source: string
          status: string
        }[]
      }
      _push_enviar: {
        Args: {
          p_corpo: string
          p_tag: string
          p_titulo: string
          p_url: string
          p_user_ids: string[]
        }
        Returns: undefined
      }
      _registrar_ciclo_oportunidade: {
        Args: { p_detalhes: Json; p_inicio: string }
        Returns: undefined
      }
      _tint_cobertura_bases_lista_email: {
        Args: { p_limit?: number }
        Returns: string
      }
      _tint_preflight: { Args: never; Returns: Json }
      _vendas_familia_ausente_lista_email: {
        Args: { p_limit?: number }
        Returns: string
      }
      adicionar_opcao_tool_spec: {
        Args: { p_spec_id: string; p_valor: string }
        Returns: Json
      }
      afiacao_os_sync_kick: { Args: never; Returns: Json }
      aplicar_exclusao_fornecedores: { Args: never; Returns: Json }
      aplicar_parametros_automatico_diario: {
        Args: { p_empresa: string }
        Returns: string
      }
      aplicar_promocoes_no_ciclo: {
        Args: { p_data_ciclo?: string; p_empresa?: string }
        Returns: {
          economia_total_estimada: number
          itens_flat_aplicados: number
          itens_forward_buying_aplicados: number
          pedidos_afetados: number
          pedidos_bloqueados_por_delta: number
        }[]
      }
      aplicar_snapshot_pendente: {
        Args: {
          p_codints_aprovados: string[]
          p_codints_em_aprovacao: string[]
          p_empresa: string
          p_meta?: Json
          p_observed_at: string
          p_pendente: Json
          p_run_id: number
        }
        Returns: Json
      }
      apply_score_updates: { Args: { p_updates: Json }; Returns: number }
      aprovar_pedido_sugerido: {
        Args: { p_pedido_id: number; p_usuario: string }
        Returns: Json
      }
      aprovar_versao_boletim: {
        Args: {
          p_change_note?: string
          p_change_type: string
          p_document_id: string
          p_payload: Json
        }
        Returns: string
      }
      atualizar_campanha_datas_corte: {
        Args: {
          p_campanha_id: number
          p_data_corte_faturamento?: string
          p_data_corte_pedido?: string
        }
        Returns: boolean
      }
      atualizar_classificacao_skus: {
        Args: { p_empresa: string }
        Returns: {
          acao: string
          classe_anterior: string
          classe_aplicada: string
          classe_proposta: string
          sku_codigo_omie: number
        }[]
      }
      atualizar_descricao_sku_parametros: {
        Args: { p_empresa: string }
        Returns: number
      }
      atualizar_estados_eventos_comerciais: {
        Args: never
        Returns: {
          aumentos_expirados: number
          aumentos_vigentes: number
          campanhas_encerradas: number
        }[]
      }
      atualizar_parametros_numericos_skus: {
        Args: { p_empresa: string; p_run_id?: string }
        Returns: number
      }
      auditar_tarefa: {
        Args: { p_aprovar: boolean; p_motivo?: string; p_tarefa_id: string }
        Returns: undefined
      }
      authz_contract_version: { Args: never; Returns: number }
      buscar_skus_candidatos: {
        Args: { p_termos: string[] }
        Returns: {
          account: string
          codigo: string
          descricao: string
          omie_codigo_produto: number
        }[]
      }
      calcular_gatilhos_reposicao: {
        Args: { p_empresa?: string; p_only_sku?: number }
        Returns: Record<string, unknown>
      }
      cancelar_pedido_sugerido: {
        Args: {
          p_justificativa: string
          p_pedido_id: number
          p_usuario: string
        }
        Returns: Json
      }
      carteira_por_municipio: {
        Args: { p_municipio_codigo: string }
        Returns: {
          business_hours_close: string
          business_hours_open: string
          city: string
          complement: string
          dias_desde_visita: number
          lat: number
          lng: number
          name: string
          neighborhood: string
          number: string
          phone: string
          precision: string
          state: string
          street: string
          ultima_visita: string
          user_id: string
          zip_code: string
        }[]
      }
      cep_geo_upsert: {
        Args: {
          p_cep: string
          p_confidence?: number
          p_lat: number
          p_lng: number
          p_municipio_codigo?: string
          p_precision: string
          p_raw?: Json
          p_source: string
          p_uf?: string
        }
        Returns: undefined
      }
      ciclo_oportunidade_do_dia: {
        Args: { p_data_ciclo?: string; p_empresa?: string }
        Returns: {
          economia_estimada: number
          executou: boolean
          motivo: string
          pedidos_gerados: number
          skus_incluidos: number
        }[]
      }
      claim_carteira_rebuild: { Args: { p_run_id: string }; Returns: boolean }
      claim_estoque_full_sync: {
        Args: { p_account: string; p_at: string; p_run_id: number }
        Returns: boolean
      }
      claim_nfe_efetivacao_lock: {
        Args: { p_cutoff: string; p_lock_ts: string; p_nfe_id: string }
        Returns: {
          id: string
        }[]
      }
      classificar_clientes_fornecedores: { Args: never; Returns: Json }
      classificar_sayerlack_grupo_default: { Args: never; Returns: number }
      concluir_com_comprovacao: {
        Args: { p_leitura?: number; p_tarefa_id: string; p_url?: string }
        Returns: undefined
      }
      confirmar_catalisador_vinculo: {
        Args: { p_catalisador_codigo: string; p_skus: Json }
        Returns: number
      }
      confirmar_item_picking: {
        Args: {
          p_confirmed_at: string
          p_event_id: string
          p_item_id: string
          p_justificativa: string
          p_lote_informado: string
          p_quantidade_separada: number
          p_task_id: string
        }
        Returns: Json
      }
      confirmar_vinculo_boletim: {
        Args: { p_kb_product_spec_id: string; p_skus: Json }
        Returns: number
      }
      consolidar_demanda_sku: {
        Args: { p_empresa: string; p_sku_antigo: string; p_sku_novo: string }
        Returns: undefined
      }
      converter_sugestao_em_campanha_flat: {
        Args: {
          p_canal?: string
          p_data_fim: string
          p_desconto_perc: number
          p_observacoes?: string
          p_responsavel_nome?: string
          p_sugestao_id: number
          p_volume_minimo: number
          p_volume_unidade: string
        }
        Returns: number
      }
      criar_pedidos_com_itens: { Args: { p_pedidos: Json }; Returns: Json }
      criar_plano_tatico: {
        Args: {
          _customer_user_id: string
          _expected_owner: string
          _payload: Json
        }
        Returns: string
      }
      data_health_watchdog: { Args: never; Returns: undefined }
      delete_push_subscription: {
        Args: { p_endpoint: string }
        Returns: undefined
      }
      des_data_faturamento_prevista: {
        Args: {
          p_data_emissao: string
          p_empresa?: string
          p_grupo_codigo: string
        }
        Returns: string
      }
      des_determinar_faixa: {
        Args: { p_valor: number; p_versao?: string }
        Returns: {
          desconto_padrao_perc: number
          estrelas: number
          faixa_id: number
          faixa_numero: number
          volume_max: number
          volume_min: number
        }[]
      }
      desfazer_contato_radar: { Args: { p_id: string }; Returns: Json }
      desfazer_contato_rota: { Args: { p_id: string }; Returns: Json }
      despinar_parametro: {
        Args: { p_empresa: string; p_sku: string }
        Returns: boolean
      }
      desvincular_boletim: {
        Args: {
          p_account: string
          p_expected_kb_product_spec_id: string
          p_omie_codigo_produto: number
        }
        Returns: number
      }
      desvincular_catalisador: {
        Args: {
          p_account: string
          p_expected_norm: string
          p_omie_codigo_produto: number
        }
        Returns: number
      }
      detectar_outliers_empresa: {
        Args: { p_empresa?: string }
        Returns: {
          eventos_criticos: number
          novos_eventos: number
          tipo: string
        }[]
      }
      detectar_skus_sem_grupo: { Args: { p_empresa?: string }; Returns: number }
      dias_uteis_entre: {
        Args: { fim: string; inicio: string }
        Returns: number
      }
      end_impersonation: { Args: { p_audit_id: string }; Returns: undefined }
      enfileirar_erro_app: {
        Args: {
          p_action: string
          p_cap?: number
          p_dedupe_key: string
          p_issue_id: string
          p_lista_url: string
          p_mensagem: string
          p_metadata: Json
          p_payload_raw: string
          p_rollup_key: string
          p_titulo: string
        }
        Returns: Json
      }
      ensure_picking_task_for_sales_order: {
        Args: { p_sales_order_id: string }
        Returns: Json
      }
      envio_portal_claim_ids: {
        Args: { p_ids: number[] }
        Returns: {
          id: number
        }[]
      }
      envio_portal_lock_candidatos: {
        Args: { p_max?: number }
        Returns: {
          empresa: string
          fornecedor_nome: string
          id: number
          portal_protocolo: string
          portal_tentativas: number
          status_envio_portal: string
        }[]
      }
      expandir_promocao_item:
        | { Args: { p_item_id: number }; Returns: Json }
        | {
            Args: { p_item_id: number; p_threshold_similaridade?: number }
            Returns: Json
          }
      fin_analise_cp_dimensoes_rpc: {
        Args: { p_ano?: number; p_company?: string; p_mes?: number }
        Returns: {
          ano: number | null
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          company: string | null
          departamento: string | null
          mes: number | null
          nome_fornecedor: string | null
          qtd_titulos: number | null
          status_titulo: string | null
          tipo_documento: string | null
          total_documento: number | null
          total_pago: number | null
          total_saldo: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "fin_analise_cp_dimensoes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fin_analise_cr_dimensoes_rpc: {
        Args: { p_ano?: number; p_company?: string; p_mes?: number }
        Returns: {
          ano: number | null
          categoria_codigo: string | null
          categoria_descricao: string | null
          centro_custo: string | null
          cnpj_cpf: string | null
          company: string | null
          departamento: string | null
          mes: number | null
          nome_cliente: string | null
          qtd_titulos: number | null
          status_titulo: string | null
          total_documento: number | null
          total_recebido: number | null
          total_saldo: number | null
          vendedor_id: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "fin_analise_cr_dimensoes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fin_calcular_confiabilidade: {
        Args: { p_ano: number; p_company: string; p_mes: number }
        Returns: Json
      }
      fin_categorias_sem_mapping: {
        Args: { p_company: string; p_end: string; p_start: string }
        Returns: {
          categoria_nome: string
          omie_codigo: string
          valor_periodo: number
        }[]
      }
      fin_consolidado_intercompany: {
        Args: { p_ano: number; p_mes: number }
        Returns: {
          conta: string
          eliminacoes: number
          total_bruto: number
          total_consolidado: number
        }[]
      }
      fin_divida_replace_parcelas: {
        Args: { p_divida_id: string; p_parcelas: Json }
        Returns: undefined
      }
      fin_estimar_estoque_omie: {
        Args: { p_company: string }
        Returns: {
          cobertura_pct: number
          skus_com_custo: number
          skus_total: number
          valor_estimado: number
        }[]
      }
      fin_projecao_13_semanas: {
        Args: { p_company?: string; p_saldo_inicial?: number }
        Returns: {
          entradas_previstas: number
          fluxo_liquido: number
          saidas_previstas: number
          saldo_projetado: number
          semana_fim: string
          semana_inicio: string
          semana_label: string
        }[]
      }
      fin_refresh_analise_dimensoes: { Args: never; Returns: undefined }
      fin_regua_condicao_prazo: {
        Args: { p_codigo: string; p_empresa: string }
        Returns: {
          descricao: string
          num_parcelas: number
        }[]
      }
      fin_regua_custo_capital: { Args: { p_empresa: string }; Returns: number }
      fin_sync_heartbeat: { Args: never; Returns: undefined }
      fin_sync_kicks_perdidos: {
        Args: { p_now?: string }
        Returns: {
          company: string
          janela: string
          prio: number
          resource: string
        }[]
      }
      fin_sync_lease_acquire: {
        Args: { p_company: string; p_holder: string; p_ttl_seconds?: number }
        Returns: string
      }
      fin_sync_lease_release: {
        Args: { p_company: string; p_token: string }
        Returns: boolean
      }
      fin_sync_retry_tick: { Args: never; Returns: undefined }
      fin_sync_watchdog_check: { Args: never; Returns: undefined }
      fin_user_can_access: {
        Args: { check_company?: string }
        Returns: boolean
      }
      finalizar_carteira_rebuild: {
        Args: { p_run_id: string; p_status: string }
        Returns: boolean
      }
      finalizar_estoque_full_sync: {
        Args: {
          p_account: string
          p_at: string
          p_error_message: string
          p_meta: Json
          p_run_id: number
          p_status: string
          p_total_synced: number
        }
        Returns: boolean
      }
      finalize_nao_vinculados_snapshot: {
        Args: { p_empresa: string; p_run_ts: string; p_total: number }
        Returns: undefined
      }
      fn_pcp_cadastrar_rota: {
        Args: {
          p_esquema?: string
          p_largura_alvo: number
          p_largura_base: number
          p_linha: string
          p_nota?: string
          p_saidas: Json
        }
        Returns: number
      }
      fn_pcp_cmc_vigente: {
        Args: {
          p_cod: number
          p_data_posicao: string
          p_permitir_anterior?: boolean
        }
        Returns: number
      }
      fn_pcp_componente_tem_drift: {
        Args: { p_cod: number; p_data: string; p_drift: number }
        Returns: boolean
      }
      fn_pcp_derivar_rotas_simples: { Args: never; Returns: number }
      fn_pcp_destilar_bom: { Args: never; Returns: number }
      fn_pcp_dispor_excecao: {
        Args: {
          p_componente: number
          p_disposicao: string
          p_nota?: string
          p_pai: number
          p_papel: string
        }
        Returns: boolean
      }
      fn_pcp_finalizar_apontamento: {
        Args: {
          p_client_ts: string
          p_device_id: string
          p_device_seq: number
          p_event_id: string
          p_op_id: string
        }
        Returns: string
      }
      fn_pcp_iniciar_apontamento: {
        Args: {
          p_client_ts: string
          p_device_id: string
          p_device_seq: number
          p_event_id: string
          p_op_id: string
        }
        Returns: string
      }
      fn_pcp_materializar_excecoes: { Args: never; Returns: number }
      fn_pcp_num: { Args: { p_raw: string }; Returns: number }
      fn_pcp_papel_componente: {
        Args: { p_descricao: string; p_familia: string }
        Returns: string
      }
      fn_pcp_parse_dimensoes: {
        Args: { p_descricao: string }
        Returns: {
          comprimento_mm: number
          diametro_mm: number
          formato: string
          grao: number
          largura_mm: number
        }[]
      }
      fn_pcp_projetar_op: { Args: { p_op_id: string }; Returns: string }
      fn_pcp_ratear_corte: {
        Args: { p_custo_base: number; p_rota_id: number }
        Returns: {
          custo_total: number
          custo_unitario: number
          largura_saida_mm: number
          papel: string
          quantidade: number
        }[]
      }
      fn_pcp_recompute_custo_padrao: {
        Args: { p_data_posicao: string }
        Returns: number
      }
      fn_pcp_recompute_excecoes: {
        Args: { p_data_posicao: string }
        Returns: number
      }
      fn_pcp_refresh_itens: {
        Args: never
        Returns: {
          dimensionais: number
          discos: number
          sem_match: number
          total: number
        }[]
      }
      fn_pcp_registrar_evento: {
        Args: {
          p_client_ts: string
          p_componente?: number
          p_device_id: string
          p_device_seq: number
          p_etapa?: string
          p_event_id: string
          p_motivo?: string
          p_nota?: string
          p_op_id: string
          p_quantidade?: number
          p_tipo: string
          p_unidade?: string
        }
        Returns: string
      }
      fn_pcp_rota_fracao_default: {
        Args: { p_rota_id: number }
        Returns: {
          fracao: number
          saida_id: number
        }[]
      }
      fn_pcp_ultima_data_posicao: { Args: never; Returns: string }
      fornecedor_operacional: {
        Args: { p_empresa: string; p_fornecedor: string; p_timestamp?: string }
        Returns: {
          calendario_validado: boolean
          motivo: string
          opera: boolean
        }[]
      }
      fornecedor_polling_pendente: {
        Args: { p_intervalo_min?: number }
        Returns: {
          aceitar_imagem: boolean
          aceitar_pdf: boolean
          assunto_contem: string[]
          assunto_suspensao: string[]
          config_id: number
          empresa: string
          fornecedor_nome: string
          notificar_calendar_id: string
          notificar_email: string
          remetente_email: string
          tipo_documento: string
          ultimo_email_processado_id: string
        }[]
      }
      gerar_pedidos_oportunidade_ciclo: {
        Args: {
          p_cenarios?: string[]
          p_data_ciclo?: string
          p_empresa?: string
        }
        Returns: {
          cenarios_cobertos: string[]
          economia_bruta: number
          pedidos_gerados: number
          skus_incluidos: number
          valor_total: number
        }[]
      }
      gerar_pedidos_sugeridos_ciclo: {
        Args: { p_data_ciclo?: string; p_empresa?: string }
        Returns: {
          bloqueados: number
          pedidos_gerados: number
          skus_incluidos: number
          valor_total_ciclo: number
        }[]
      }
      get_carteira_saude: { Args: never; Returns: Json }
      get_commercial_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["commercial_role"]
      }
      get_customer_metrics: {
        Args: never
        Returns: {
          atraso_relativo: number
          calculated_at: string
          customer_user_id: string
          dias_desde_ultima_compra: number
          document: string
          faturamento_90d: number
          faturamento_prev_90d: number
          intervalo_medio_dias: number
          is_cold_start: boolean
          pedidos_90d: number
          razao_social: string
          ticket_medio_90d: number
          ultima_compra_data: string
        }[]
      }
      get_customer_sales_summary: {
        Args: never
        Returns: {
          category_count: number
          customer_user_id: string
          days_since_last_purchase: number
          item_count: number
          revenue_180d: number
          total_revenue: number
        }[]
      }
      get_data_health: {
        Args: never
        Returns: {
          age_seconds: number
          domain: string
          expected_max_age_seconds: number
          freshness_basis: string
          how_to_fix: string
          last_error: string
          message: string
          probable_cause: string
          severity: string
          source: string
          status: string
        }[]
      }
      get_defasagem_cliente: {
        Args: { p_customer_user_id: string; p_itens: Json }
        Returns: Json
      }
      get_default_production_assignee: { Args: never; Returns: string }
      get_meu_mixgap: { Args: never; Returns: Json }
      get_meu_mixgap_for: { Args: { p_target: string }; Returns: Json }
      get_minha_positivacao: { Args: never; Returns: Json }
      get_minha_positivacao_for: { Args: { p_target: string }; Returns: Json }
      get_preco_cockpit: { Args: { p_itens: Json }; Returns: Json }
      get_public_tool_history: { Args: { p_tool_id: string }; Returns: Json }
      get_regua_preco: {
        Args: {
          p_customer: string
          p_prazo_dias?: number[]
          p_preco_atual: number
          p_product: string
          p_qty: number
        }
        Returns: Json
      }
      get_regua_preco_customer360: {
        Args: { p_customer: string; p_omie_codigos: number[] }
        Returns: Json
      }
      get_sku_ranking_negociacao_paralela: {
        Args: { p_empresa?: string }
        Returns: unknown[]
        SetofOptions: {
          from: "*"
          to: "mv_sku_ranking_negociacao_paralela"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_tint_price: { Args: { p_formula_id: string }; Returns: Json }
      get_tint_prices: { Args: { p_formula_ids: string[] }; Returns: Json }
      get_ultimos_precos_cliente: {
        Args: { p_customer: string }
        Returns: {
          product_id: string
          ultimo_praticado_em: string
          unit_price: number
        }[]
      }
      get_user_access_profile_for: { Args: { p_target: string }; Returns: Json }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      get_whatsapp_funil: {
        Args: { p_dias?: number }
        Returns: {
          entregues: number
          enviados: number
          falhas: number
          lidos: number
          pedidos_omie: number
          propostas: number
          receita_omie: number
          respondidos: number
        }[]
      }
      get_whatsapp_pendentes: {
        Args: never
        Returns: {
          contact_name: string
          conversation_id: string
          customer_user_id: string
          last_inbound_at: string
          phone_e164: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      import_tint_formulas: {
        Args: { p_account: string; p_personalizada: boolean; p_rows: Json }
        Returns: Json
      }
      iniciar_envio_portal_pre_claim: {
        Args: { p_pedido_id: number }
        Returns: boolean
      }
      kb_extraction_draft_claim: {
        Args: { p_claim_token: string; p_document_id: string }
        Returns: boolean
      }
      kb_normalizar_catalisador: { Args: { p: string }; Returns: string }
      leadtime_t1_e_data_de_pedido: {
        Args: {
          p_hist_t1: string
          p_hist_t2: string
          p_omie_codigo_pedido: number
          p_tracking_t1: string
        }
        Returns: boolean
      }
      limpar_sugestoes_antigas: {
        Args: never
        Returns: {
          deletadas: number
          expiradas: number
        }[]
      }
      list_impersonation_targets: {
        Args: never
        Returns: {
          commercial_role: string
          nome: string
          user_id: string
        }[]
      }
      listar_pedidos_a_separar: {
        Args: { p_account: string }
        Returns: {
          customer_user_id: string
          data: string
          id: string
          items: Json
          status: string
          total: number
        }[]
      }
      listar_skus_por_codigo_fornecedor: {
        Args: { p_codigo_fornecedor: string; p_empresa: string }
        Returns: {
          codigo_interno: string
          descricao: string
          familia: string
          omie_codigo_produto: number
        }[]
      }
      log_impersonation_start: {
        Args: { p_reason?: string; p_target: string }
        Returns: string
      }
      mapear_status_etapa: { Args: { p_status: string }; Returns: string }
      marcar_alerta_notificado: {
        Args: {
          p_alerta_id: number
          p_calendar_evento_id?: string
          p_email_enviado?: boolean
        }
        Returns: boolean
      }
      mark_mixgap_feedback: {
        Args: { p_customer: string; p_familia: string; p_status: string }
        Returns: undefined
      }
      medir_abaixo_piso_tier: {
        Args: { p_dias?: number }
        Returns: {
          company: string
          folga_negativa_reais: number
          itens_abaixo: number
          tier: string
          total_itens: number
        }[]
      }
      melhoria_clientes_por_produto: {
        Args: { p_termo: string }
        Returns: Json
      }
      melhoria_produtos_relacionados: {
        Args: { p_termo: string }
        Returns: Json
      }
      minha_carteira: {
        Args: never
        Returns: {
          coberto_de: string
          customer_user_id: string
          owner_user_id: string
        }[]
      }
      norm_cidade: { Args: { t: string }; Returns: string }
      normalizar_cep: { Args: { p: string }; Returns: string }
      omie_sync_identity_snapshot: {
        Args: { p_account: string }
        Returns: Json
      }
      pedido_compra_split: {
        Args: { p_chunk_size?: number; p_pedido_id: number }
        Returns: {
          filho_id: number
          lote: number
          total: number
        }[]
      }
      pedidos_programados_watchdog_claims: { Args: never; Returns: number }
      pode_ver_carteira_completa: { Args: { _uid: string }; Returns: boolean }
      preencher_parametros_faltantes_skus: {
        Args: { p_empresa: string }
        Returns: number
      }
      processar_alertas_pendentes_notificacao: {
        Args: { p_empresa?: string }
        Returns: {
          alerta_id: number
          aumento_id: number
          calendar_evento_data: string
          calendar_evento_duracao_minutos: number
          calendar_evento_titulo: string
          calendar_id: string
          campanha_id: number
          deve_criar_calendar_evento: boolean
          deve_enviar_email: boolean
          email_destino: string
          empresa: string
          mensagem: string
          payload_json: Json
          severidade: string
          tipo: string
          titulo: string
        }[]
      }
      promover_candidato_primeira_compra: {
        Args: { p_empresa: string; p_sku: number }
        Returns: number
      }
      proxima_janela_operacional: {
        Args: { p_a_partir?: string; p_empresa: string; p_fornecedor: string }
        Returns: string
      }
      push_sla_tick: { Args: never; Returns: undefined }
      radar_atribuir_tarefa: {
        Args: { p_cnpj: string; p_dias_retomada?: number }
        Returns: Json
      }
      radar_contagem_por_municipio: {
        Args: {
          p_cnae_exato?: string
          p_cnae_prefix?: string
          p_data_abertura_max?: string
          p_data_abertura_min?: string
          p_incluir_ja_clientes?: boolean
          p_limit?: number
          p_status?: string
          p_uf?: string
        }
        Returns: {
          a_contatar: number
          com_telefone: number
          lat: number
          lng: number
          municipio_codigo: string
          municipio_nome: string
          total: number
          uf: string
        }[]
      }
      radar_kpis: { Args: never; Returns: Json }
      radar_prospects_para_rota: {
        Args: { p_limit?: number; p_municipio_codigo: string }
        Returns: {
          bairro: string
          cep: string
          cnpj: string
          complemento: string
          geocode_status: string
          lat: number
          lng: number
          logradouro: string
          municipio_nome: string
          nome_fantasia: string
          numero: string
          precision: string
          prospeccao_status: string
          razao_social: string
          telefone1: string
          telefone2: string
          uf: string
        }[]
      }
      radar_recruzar_ja_cliente: { Args: never; Returns: number }
      radar_registrar_cadastro_omie: {
        Args: {
          p_cnpj: string
          p_codigo_cliente: string
          p_ja_existia?: boolean
        }
        Returns: Json
      }
      radar_salvar_geocode: {
        Args: {
          p_cnpj: string
          p_lat?: number
          p_lng?: number
          p_status?: string
        }
        Returns: Json
      }
      rank_precisao: { Args: { p: string }; Returns: number }
      recalcular_picking_task: { Args: { p_task_id: string }; Returns: Json }
      recomputar_leadtime_derivado: {
        Args: { p_empresa: string }
        Returns: {
          etapa: string
          valor: number
        }[]
      }
      refresh_customer_metrics: { Args: never; Returns: undefined }
      refresh_oportunidade_badge: { Args: never; Returns: undefined }
      refresh_sku_ranking_negociacao: {
        Args: never
        Returns: {
          atualizado_em: string
          skus_ranqueados: number
        }[]
      }
      register_carteira_member: {
        Args: {
          p_account: string
          p_omie_codigo_cliente: number
          p_omie_codigo_vendedor?: number
          p_user_id: string
        }
        Returns: undefined
      }
      registrar_aplicacao_regua: {
        Args: { p_log_id: string; p_preco_final: number }
        Returns: boolean
      }
      registrar_aumento_via_vision: {
        Args: {
          p_categorias: Json
          p_criado_por?: string
          p_data_anuncio: string
          p_data_vigencia: string
          p_empresa: string
          p_extracao_confianca?: number
          p_extracao_observacoes?: string
          p_fornecedor_nome: string
          p_nome: string
          p_origem_arquivo_tipo?: string
          p_origem_arquivo_url?: string
          p_origem_email_assunto?: string
          p_origem_email_data?: string
          p_origem_email_remetente?: string
        }
        Returns: number
      }
      registrar_contato_radar: {
        Args: { p_acao: string; p_cnpj: string; p_nota?: string }
        Returns: Json
      }
      registrar_contato_rota: {
        Args: {
          p_bucket?: string
          p_customer_user_id: string
          p_data_rota: string
          p_status: string
          p_valor?: number
        }
        Returns: Json
      }
      registrar_exibicao_regua: {
        Args: {
          p_account: string
          p_cap_limitou?: boolean
          p_confianca: string
          p_customer_user_id: string
          p_observed_gap_pct?: number
          p_prazo_dias?: number[]
          p_preco_atual: number
          p_preco_referencia?: number
          p_product_id: string
          p_quantity: number
          p_reason_codes?: string[]
          p_sinal_exibido: string
          p_suggested_gap_pct?: number
        }
        Returns: string
      }
      registrar_polling_resultado: {
        Args: {
          p_alertas_suspensao: number
          p_anexos_extraidos: number
          p_aumentos_criados: number
          p_campanhas_criadas: number
          p_config_id: number
          p_detalhes?: Json
          p_emails_encontrados: number
          p_emails_processados: number
          p_erro?: string
          p_ultimo_email_id?: string
        }
        Returns: number
      }
      registrar_resultado_plano: {
        Args: {
          _actual_margin: number
          _call_duration_seconds: number
          _call_result: string
          _notes?: string
          _objection_type?: string
          _plan_followed: boolean
          _plan_id: string
        }
        Returns: undefined
      }
      registrar_substituicao_sku: {
        Args: {
          p_acao_parametros: string
          p_codigo_antigo: string
          p_codigo_novo: string
          p_empresa: string
          p_motivo: string
          p_usuario: string
        }
        Returns: Json
      }
      rejeitar_sugestao: {
        Args: {
          p_account: string
          p_kb_product_spec_id: string
          p_omie_codigo_produto: number
        }
        Returns: undefined
      }
      reposicao__po_id: { Args: { p: string }; Returns: number }
      reposicao__trim: { Args: { p: string }; Returns: string }
      reposicao_alerta_pedido_minimo_tick: { Args: never; Returns: undefined }
      reposicao_alocar_run_seq: { Args: never; Returns: number }
      reposicao_aplicar_depara_sayerlack_auto: {
        Args: {
          p_candidatos: Json
          p_parser_version?: number
          p_run_id?: string
        }
        Returns: {
          colisao_destino: number
          inseridos: number
          ja_existe: number
          nao_elegivel: number
        }[]
      }
      reposicao_cold_start_parametros: {
        Args: { p_empresa?: string; p_limite?: number; p_run_id?: string }
        Returns: {
          criados: number
          graduados: number
        }[]
      }
      reposicao_param_auto_resumo_tick: { Args: never; Returns: undefined }
      reposicao_param_limbo_watchdog: { Args: never; Returns: undefined }
      reposicao_pedido_auto_aprovavel: {
        Args: {
          p_cooldown_horas: number
          p_delta_max: number
          p_pedido_id: number
          p_threshold: number
        }
        Returns: Json
      }
      reposicao_persistir_qtde_inteira: {
        Args: { p_pedido_id: number }
        Returns: number
      }
      reposicao_pos_candidatos: {
        Args: { p_empresa: string }
        Returns: {
          algum_sinal_de_canal: boolean
          canal_usado: string
          data_ciclo: string
          fornecedor_nome: string
          idade_dias: number
          itens_sem_valor: number
          marcador_run_id: string
          marcador_seq: number
          na_janela_7d: boolean
          omie_codigo_pedido: string
          pedido_id: number
          po_no_espelho: boolean
          portal_protocolo: string
          resposta_canal: Json
          status_envio_portal: string
          tem_canal: boolean
          tem_protocolo: boolean
          tem_resposta_canal: boolean
          tem_status_portal: boolean
          valor_total: number
          visto_status: string
        }[]
      }
      reposicao_publicar_run_completo: {
        Args: {
          p_empresa: string
          p_ids: number[]
          p_janela_ate: string
          p_janela_de: string
          p_run_id: string
          p_seq: number
        }
        Returns: boolean
      }
      reposicao_sincronizar_embalagem_wp: {
        Args: { p_empresa?: string }
        Returns: Json
      }
      request_customer_metrics_refresh: { Args: never; Returns: undefined }
      resgatar_recompensa: { Args: { p_reward_key: string }; Returns: string }
      resolve_markup_policy: {
        Args: {
          p_codigo: number
          p_empresa: string
          p_familia: string
          p_tier?: string
        }
        Returns: {
          meta_markup: number
          piso_markup: number
        }[]
      }
      resolver_outlier: {
        Args: {
          p_decisao: string
          p_evento_id: number
          p_justificativa?: string
          p_usuario_email?: string
        }
        Returns: Json
      }
      resolver_sku_por_codigo_fornecedor: {
        Args: { p_codigo_fornecedor: string; p_empresa: string }
        Returns: Json
      }
      reverter_exclusao_fornecedor: {
        Args: { p_motivo?: string; p_user_id: string }
        Returns: Json
      }
      reverter_parametro_auto: { Args: { p_log_id: string }; Returns: string }
      reverter_run_auto: {
        Args: { p_run_id: string }
        Returns: {
          conflitos: number
          revertidos: number
        }[]
      }
      rodar_bateria_simulacao: {
        Args: { p_empresa: string; p_top_n?: number }
        Returns: {
          candidatos_testados: number
          simulacoes_total: number
          skus_simulados: number
          tempo_execucao_seg: number
          valor_coberto_rs: number
        }[]
      }
      route_city_norm: { Args: { raw: string }; Returns: string }
      sayerlack_retry_orfaos: { Args: never; Returns: Json }
      seed_targets_faltantes: {
        Args: never
        Returns: {
          user_id: string
        }[]
      }
      selfservice_conta_atual: {
        Args: never
        Returns: {
          accounts: string[]
          customer_user_id: string
          habilitado: boolean
        }[]
      }
      set_config: {
        Args: { is_local?: boolean; parameter: string; value: string }
        Returns: string
      }
      simular_formula_estoque: {
        Args: {
          p_candidato: string
          p_dias_simulacao?: number
          p_empresa: string
          p_sku: string
        }
        Returns: Json
      }
      simular_puxar_volume_trimestre: {
        Args: {
          p_ano?: number
          p_dias_estoque_extra?: number
          p_empresa?: string
          p_prazo_pagamento_codigo?: string
          p_trimestre?: number
          p_valor_extra?: number
        }
        Returns: Json
      }
      staff_get_sales_order_payload: {
        Args: { p_order_ids: string[] }
        Returns: {
          id: string
          omie_payload: Json
          omie_response: Json
        }[]
      }
      sugerir_negociacao_paralela_hoje: {
        Args: { p_empresa?: string; p_limite?: number }
        Returns: {
          out_categoria: string
          out_motivo: string
          out_motivo_legivel: string
          out_preco_medio_unitario: number
          out_score_final: number
          out_sku_codigo_omie: string
          out_sku_descricao: string
          out_sugestao_id: number
          out_volume_financeiro_12m: number
        }[]
      }
      tarefas_escalonamento_tick: { Args: never; Returns: undefined }
      tarefas_matcher_tick: { Args: never; Returns: undefined }
      tarefas_materializar_recorrentes: { Args: never; Returns: undefined }
      tint_apply_keys_snapshot: {
        Args: { p_snapshot_id: string }
        Returns: Json
      }
      tint_calc_preco_final: {
        Args: {
          p_account: string
          p_cod_produto: string
          p_fator: number
          p_id_base: string
          p_id_embalagem: string
          p_staging_formula_id: string
          p_store_code: string
        }
        Returns: number
      }
      tint_ensure_corante_stub: {
        Args: { p_account: string; p_id_corante: string }
        Returns: string
      }
      tint_gate_revalida: {
        Args: {
          p_account: string
          p_contexto: string
          p_customer_user_id: string
          p_items: Json
          p_sales_order_id: string
        }
        Returns: Json
      }
      tint_marcar_bases_mixmachine: { Args: never; Returns: number }
      tint_promote_sync_run: { Args: { p_sync_run_id: string }; Returns: Json }
      tint_recalc_preco_oficial: {
        Args: {
          p_account: string
          p_cod_produto: string
          p_formula_id: string
          p_id_base: string
          p_id_embalagem: string
          p_store_code: string
        }
        Returns: number
      }
      tint_run_reconciliation: {
        Args: { p_sync_run_id: string }
        Returns: Json
      }
      tint_ultimo_preco_cliente: {
        Args: {
          p_cor_id: string
          p_customer_user_id: string
          p_exclude_sales_order_id?: string
          p_product_id: string
        }
        Returns: Json
      }
      upsert_push_subscription: {
        Args: {
          p_endpoint: string
          p_subscription: Json
          p_user_agent?: string
        }
        Returns: undefined
      }
      validar_sku_para_aplicacao: {
        Args: { p_empresa: string; p_sku: string }
        Returns: Json
      }
      venda_gate_credito: {
        Args: { p_codigo: number; p_company: string; p_sales_order_id: string }
        Returns: Json
      }
      vendas_sync_finish: {
        Args: {
          p_account: string
          p_complete: boolean
          p_date_from: string
          p_date_to: string
          p_last_error_kind: string
          p_next_page: number
        }
        Returns: undefined
      }
      vendas_sync_heartbeat: {
        Args: {
          p_account: string
          p_date_from: string
          p_date_to: string
          p_page: number
        }
        Returns: undefined
      }
      vendas_sync_lease_acquire: {
        Args: { p_account: string; p_date_from: string; p_date_to: string }
        Returns: number
      }
      vendas_sync_release: {
        Args: {
          p_account: string
          p_date_from: string
          p_date_to: string
          p_last_error_kind: string
        }
        Returns: undefined
      }
      vendas_sync_semear_janela: {
        Args: { p_account: string; p_date_from: string; p_date_to: string }
        Returns: Json
      }
      wa_is_stop_keyword: { Args: { p_body: string }; Returns: boolean }
      wa_owner_efetivo: { Args: { p_customer: string }; Returns: string }
      whatsapp_minutos_uteis: {
        Args: {
          p_ate: string
          p_desde: string
          p_dias?: number[]
          p_h_fim?: string
          p_h_inicio?: string
        }
        Returns: number
      }
      whatsapp_sla_digest_tick: { Args: never; Returns: undefined }
    }
    Enums: {
      app_role: "master" | "employee" | "customer"
      call_direction: "inbound" | "outbound"
      call_status:
        | "ringing"
        | "answered"
        | "missed"
        | "rejected"
        | "busy"
        | "failed"
        | "canceled"
        | "ended"
      classe_abc: "A" | "B" | "C"
      classe_xyz: "X" | "Y" | "Z"
      commercial_role:
        | "operacional"
        | "gerencial"
        | "estrategico"
        | "super_admin"
        | "farmer"
        | "hunter"
        | "closer"
        | "master"
      department:
        | "separador"
        | "conferente"
        | "comprador"
        | "tintometrico"
        | "financeiro"
        | "vendas"
        | "gestao"
        | "outro"
      empresa_reposicao: "OBEN" | "COLACOR"
      farmer_call_result:
        | "contato_sucesso"
        | "sem_resposta"
        | "ocupado"
        | "caixa_postal"
        | "numero_invalido"
        | "reagendado"
      farmer_call_type: "reativacao" | "cross_sell" | "up_sell" | "follow_up"
      status_pedido_compra:
        | "CRIADO"
        | "FATURADO"
        | "EM_TRANSPORTE"
        | "RECEBIDO"
        | "CANCELADO"
        | "DIVERGENCIA"
      status_revisao:
        | "NAO_REVISADO"
        | "PENDENTE_APROVACAO"
        | "APROVADO"
        | "APLICADO"
        | "REJEITADO"
        | "APLICADO_AUTOMATICO"
      tint_integration_mode: "csv_only" | "shadow_mode" | "automatic_primary"
      visit_mission:
        | "recuperacao"
        | "expansao"
        | "relacionamento"
        | "prospeccao"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["master", "employee", "customer"],
      call_direction: ["inbound", "outbound"],
      call_status: [
        "ringing",
        "answered",
        "missed",
        "rejected",
        "busy",
        "failed",
        "canceled",
        "ended",
      ],
      classe_abc: ["A", "B", "C"],
      classe_xyz: ["X", "Y", "Z"],
      commercial_role: [
        "operacional",
        "gerencial",
        "estrategico",
        "super_admin",
        "farmer",
        "hunter",
        "closer",
        "master",
      ],
      department: [
        "separador",
        "conferente",
        "comprador",
        "tintometrico",
        "financeiro",
        "vendas",
        "gestao",
        "outro",
      ],
      empresa_reposicao: ["OBEN", "COLACOR"],
      farmer_call_result: [
        "contato_sucesso",
        "sem_resposta",
        "ocupado",
        "caixa_postal",
        "numero_invalido",
        "reagendado",
      ],
      farmer_call_type: ["reativacao", "cross_sell", "up_sell", "follow_up"],
      status_pedido_compra: [
        "CRIADO",
        "FATURADO",
        "EM_TRANSPORTE",
        "RECEBIDO",
        "CANCELADO",
        "DIVERGENCIA",
      ],
      status_revisao: [
        "NAO_REVISADO",
        "PENDENTE_APROVACAO",
        "APROVADO",
        "APLICADO",
        "REJEITADO",
        "APLICADO_AUTOMATICO",
      ],
      tint_integration_mode: ["csv_only", "shadow_mode", "automatic_primary"],
      visit_mission: [
        "recuperacao",
        "expansao",
        "relacionamento",
        "prospeccao",
      ],
    },
  },
} as const
