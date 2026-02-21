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
          is_employee: boolean | null
          name: string
          phone: string | null
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
          is_employee?: boolean | null
          name: string
          phone?: string | null
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
          is_employee?: boolean | null
          name?: string
          phone?: string | null
          updated_at?: string
          user_id?: string
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
    }
    Enums: {
      app_role: "admin" | "employee" | "customer"
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
    },
  },
} as const
