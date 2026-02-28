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
          metadata: Json | null
          ncm: string | null
          omie_codigo_produto: number
          omie_codigo_produto_integracao: string | null
          subfamilia: string | null
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
          metadata?: Json | null
          ncm?: string | null
          omie_codigo_produto: number
          omie_codigo_produto_integracao?: string | null
          subfamilia?: string | null
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
          metadata?: Json | null
          ncm?: string | null
          omie_codigo_produto?: number
          omie_codigo_produto_integracao?: string | null
          subfamilia?: string | null
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
      sales_orders: {
        Row: {
          account: string
          created_at: string
          created_by: string
          customer_user_id: string
          discount: number
          id: string
          items: Json
          notes: string | null
          omie_numero_pedido: string | null
          omie_payload: Json | null
          omie_pedido_id: number | null
          omie_response: Json | null
          status: string
          subtotal: number
          total: number
          updated_at: string
        }
        Insert: {
          account?: string
          created_at?: string
          created_by: string
          customer_user_id: string
          discount?: number
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Update: {
          account?: string
          created_at?: string
          created_by?: string
          customer_user_id?: string
          discount?: number
          id?: string
          items?: Json
          notes?: string | null
          omie_numero_pedido?: string | null
          omie_payload?: Json | null
          omie_pedido_id?: number | null
          omie_response?: Json | null
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
      [_ in never]: never
    }
    Functions: {
      get_commercial_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["commercial_role"]
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
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "employee" | "customer"
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
      app_role: ["admin", "employee", "customer"],
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
    },
  },
} as const
