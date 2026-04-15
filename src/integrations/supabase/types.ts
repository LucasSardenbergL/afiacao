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
          attempt_number: number | null
          call_result: Database["public"]["Enums"]["farmer_call_result"]
          call_type: Database["public"]["Enums"]["farmer_call_type"]
          created_at: string
          customer_user_id: string
          duration_seconds: number | null
          ended_at: string | null
          farmer_id: string
          follow_up_duration_seconds: number | null
          id: string
          is_whatsapp: boolean | null
          linked_sales_order_id: string | null
          margin_generated: number | null
          notes: string | null
          revenue_generated: number | null
          started_at: string
          whatsapp_replied: boolean | null
        }
        Insert: {
          attempt_number?: number | null
          call_result?: Database["public"]["Enums"]["farmer_call_result"]
          call_type: Database["public"]["Enums"]["farmer_call_type"]
          created_at?: string
          customer_user_id: string
          duration_seconds?: number | null
          ended_at?: string | null
          farmer_id: string
          follow_up_duration_seconds?: number | null
          id?: string
          is_whatsapp?: boolean | null
          linked_sales_order_id?: string | null
          margin_generated?: number | null
          notes?: string | null
          revenue_generated?: number | null
          started_at?: string
          whatsapp_replied?: boolean | null
        }
        Update: {
          attempt_number?: number | null
          call_result?: Database["public"]["Enums"]["farmer_call_result"]
          call_type?: Database["public"]["Enums"]["farmer_call_type"]
          created_at?: string
          customer_user_id?: string
          duration_seconds?: number | null
          ended_at?: string | null
          farmer_id?: string
          follow_up_duration_seconds?: number | null
          id?: string
          is_whatsapp?: boolean | null
          linked_sales_order_id?: string | null
          margin_generated?: number | null
          notes?: string | null
          revenue_generated?: number | null
          started_at?: string
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
          m_score: number | null
          priority_score: number | null
          recover_score: number | null
          revenue_potential: number | null
          rf_score: number | null
          s_score: number | null
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
          m_score?: number | null
          priority_score?: number | null
          recover_score?: number | null
          revenue_potential?: number | null
          rf_score?: number | null
          s_score?: number | null
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
          m_score?: number | null
          priority_score?: number | null
          recover_score?: number | null
          revenue_potential?: number | null
          rf_score?: number | null
          s_score?: number | null
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
          regime: string | null
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
          regime?: string | null
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
          regime?: string | null
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
          snapshot_dre_id?: string | null
          status?: string
          updated_at?: string | null
          versao?: number
        }
        Relationships: [
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
          chave_acesso: string
          cnpj_emitente: string
          conferente_id: string | null
          conferido_at: string | null
          created_at: string
          data_emissao: string | null
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
          chave_acesso: string
          cnpj_emitente: string
          conferente_id?: string | null
          conferido_at?: string | null
          created_at?: string
          data_emissao?: string | null
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
          chave_acesso?: string
          cnpj_emitente?: string
          conferente_id?: string | null
          conferido_at?: string | null
          created_at?: string
          data_emissao?: string | null
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
      omie_clientes: {
        Row: {
          created_at: string
          id: string
          omie_codigo_cliente: number
          omie_codigo_cliente_integracao: string | null
          omie_codigo_vendedor: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          omie_codigo_cliente: number
          omie_codigo_cliente_integracao?: string | null
          omie_codigo_vendedor?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          omie_codigo_cliente?: number
          omie_codigo_cliente_integracao?: string | null
          omie_codigo_vendedor?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      omie_ordens_servico: {
        Row: {
          created_at: string
          id: string
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
        ]
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
          cost_price: number
          cost_source: string | null
          family_category: string | null
          id: string
          product_id: string
          updated_at: string
        }
        Insert: {
          cmc?: number | null
          cost_confidence?: number | null
          cost_final?: number | null
          cost_price?: number
          cost_source?: string | null
          family_category?: string | null
          id?: string
          product_id: string
          updated_at?: string
        }
        Update: {
          cmc?: number | null
          cost_confidence?: number | null
          cost_final?: number | null
          cost_price?: number
          cost_source?: string | null
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
          id: string
          notes: string | null
          omie_ordem_numero: string | null
          omie_ordem_producao_id: number | null
          product_codigo: string | null
          product_descricao: string | null
          product_id: string | null
          quantidade: number
          ready_by_date: string | null
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
          id?: string
          notes?: string | null
          omie_ordem_numero?: string | null
          omie_ordem_producao_id?: number | null
          product_codigo?: string | null
          product_descricao?: string | null
          product_id?: string | null
          quantidade?: number
          ready_by_date?: string | null
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
          id?: string
          notes?: string | null
          omie_ordem_numero?: string | null
          omie_ordem_producao_id?: number | null
          product_codigo?: string | null
          product_descricao?: string | null
          product_id?: string | null
          quantidade?: number
          ready_by_date?: string | null
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
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          business_hours_close: string | null
          business_hours_open: string | null
          cnae: string | null
          created_at: string
          customer_type: string | null
          document: string | null
          email: string | null
          employee_code: string | null
          id: string
          is_approved: boolean
          is_employee: boolean | null
          lunch_end: string | null
          lunch_start: string | null
          name: string
          phone: string | null
          preferred_delivery_time: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          business_hours_close?: string | null
          business_hours_open?: string | null
          cnae?: string | null
          created_at?: string
          customer_type?: string | null
          document?: string | null
          email?: string | null
          employee_code?: string | null
          id?: string
          is_approved?: boolean
          is_employee?: boolean | null
          lunch_end?: string | null
          lunch_start?: string | null
          name: string
          phone?: string | null
          preferred_delivery_time?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          business_hours_close?: string | null
          business_hours_open?: string | null
          cnae?: string | null
          created_at?: string
          customer_type?: string | null
          document?: string | null
          email?: string | null
          employee_code?: string | null
          id?: string
          is_approved?: boolean
          is_employee?: boolean | null
          lunch_end?: string | null
          lunch_start?: string | null
          name?: string
          phone?: string | null
          preferred_delivery_time?: string | null
          updated_at?: string
          user_id?: string
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
          created_at: string
          created_by: string
          customer_address: string | null
          customer_phone: string | null
          customer_user_id: string
          discount: number
          hash_payload: string | null
          id: string
          items: Json
          notes: string | null
          omie_numero_pedido: string | null
          omie_payload: Json | null
          omie_pedido_id: number | null
          omie_response: Json | null
          ready_by_date: string | null
          status: string
          subtotal: number
          total: number
          updated_at: string
        }
        Insert: {
          account?: string
          created_at?: string
          created_by: string
          customer_address?: string | null
          customer_phone?: string | null
          customer_user_id: string
          discount?: number
          hash_payload?: string | null
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
          ready_by_date?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Update: {
          account?: string
          created_at?: string
          created_by?: string
          customer_address?: string | null
          customer_phone?: string | null
          customer_user_id?: string
          discount?: number
          hash_payload?: string | null
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
          ready_by_date?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Relationships: []
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
        ]
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
        ]
      }
      tint_formulas: {
        Row: {
          account: string
          base_id: string
          cor_id: string
          created_at: string | null
          data_geracao: string | null
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
          store_code?: string
          store_name?: string | null
          sync_enabled?: boolean
          sync_token?: string
          updated_at?: string
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
          descricao: string | null
          id: string
          id_corante_sayersystem: string
          matched_id: string | null
          preco_litro: number | null
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
          id_corante_sayersystem: string
          matched_id?: string | null
          preco_litro?: number | null
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
          id_corante_sayersystem?: string
          matched_id?: string | null
          preco_litro?: number | null
          raw_data?: Json | null
          staging_status?: string
          store_code?: string
          sync_run_id?: string
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
          id: string
          id_base: string | null
          id_embalagem: string | null
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
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
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
          id?: string
          id_base?: string | null
          id_embalagem?: string | null
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
    }
    Functions: {
      fin_calcular_confiabilidade: {
        Args: { p_ano: number; p_company: string; p_mes: number }
        Returns: Json
      }
      fin_consolidado_intercompany: {
        Args: { p_ano: number; p_mes: number }
        Returns: {
          dre_linha: string
          eliminacoes: number
          valor_bruto: number
          valor_liquido: number
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
      fin_user_can_access: {
        Args: { check_company?: string }
        Returns: boolean
      }
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
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
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
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      refresh_customer_metrics: { Args: never; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      tint_run_reconciliation: {
        Args: { p_sync_run_id: string }
        Returns: Json
      }
    }
    Enums: {
      app_role: "admin" | "employee" | "customer" | "master" | "manager"
      commercial_role:
        | "operacional"
        | "gerencial"
        | "estrategico"
        | "super_admin"
      farmer_call_result:
        | "contato_sucesso"
        | "sem_resposta"
        | "ocupado"
        | "caixa_postal"
        | "numero_invalido"
        | "reagendado"
      farmer_call_type: "reativacao" | "cross_sell" | "up_sell" | "follow_up"
      tint_integration_mode: "csv_only" | "shadow_mode" | "automatic_primary"
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
      app_role: ["admin", "employee", "customer", "master", "manager"],
      commercial_role: [
        "operacional",
        "gerencial",
        "estrategico",
        "super_admin",
      ],
      farmer_call_result: [
        "contato_sucesso",
        "sem_resposta",
        "ocupado",
        "caixa_postal",
        "numero_invalido",
        "reagendado",
      ],
      farmer_call_type: ["reativacao", "cross_sell", "up_sell", "follow_up"],
      tint_integration_mode: ["csv_only", "shadow_mode", "automatic_primary"],
    },
  },
} as const
