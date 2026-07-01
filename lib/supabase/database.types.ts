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
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          acknowledged_by: string | null
          client_id: string | null
          id: string
          kind: Database["public"]["Enums"]["alert_kind"]
          option_id: string | null
          severity: Database["public"]["Enums"]["alert_severity"]
          subtitle: string | null
          title: string
          triggered_at: string
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          client_id?: string | null
          id?: string
          kind: Database["public"]["Enums"]["alert_kind"]
          option_id?: string | null
          severity: Database["public"]["Enums"]["alert_severity"]
          subtitle?: string | null
          title: string
          triggered_at?: string
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          client_id?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["alert_kind"]
          option_id?: string | null
          severity?: Database["public"]["Enums"]["alert_severity"]
          subtitle?: string | null
          title?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "option_holdings"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: string
          client_id: string | null
          detail: string | null
          id: number
          role: string
          ts: string
        }
        Insert: {
          action: string
          actor: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role: string
          ts?: string
        }
        Update: {
          action?: string
          actor?: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role?: string
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log_2026_06: {
        Row: {
          action: string
          actor: string
          client_id: string | null
          detail: string | null
          id: number
          role: string
          ts: string
        }
        Insert: {
          action: string
          actor: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role: string
          ts?: string
        }
        Update: {
          action?: string
          actor?: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role?: string
          ts?: string
        }
        Relationships: []
      }
      audit_log_2026_07: {
        Row: {
          action: string
          actor: string
          client_id: string | null
          detail: string | null
          id: number
          role: string
          ts: string
        }
        Insert: {
          action: string
          actor: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role: string
          ts?: string
        }
        Update: {
          action?: string
          actor?: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role?: string
          ts?: string
        }
        Relationships: []
      }
      audit_log_default: {
        Row: {
          action: string
          actor: string
          client_id: string | null
          detail: string | null
          id: number
          role: string
          ts: string
        }
        Insert: {
          action: string
          actor: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role: string
          ts?: string
        }
        Update: {
          action?: string
          actor?: string
          client_id?: string | null
          detail?: string | null
          id?: never
          role?: string
          ts?: string
        }
        Relationships: []
      }
      bids: {
        Row: {
          alloc: number | null
          amount: number
          client_id: string
          created_at: string
          id: string
          paid: boolean
          placement_id: string
          updated_at: string
        }
        Insert: {
          alloc?: number | null
          amount: number
          client_id: string
          created_at?: string
          id?: string
          paid?: boolean
          placement_id: string
          updated_at?: string
        }
        Update: {
          alloc?: number | null
          amount?: number
          client_id?: string
          created_at?: string
          id?: string
          paid?: boolean
          placement_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bids_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bids_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "placements"
            referencedColumns: ["id"]
          },
        ]
      }
      client_accounts: {
        Row: {
          cash_balance: number
          client_id: string
          currency: string
          updated_at: string
        }
        Insert: {
          cash_balance?: number
          client_id: string
          currency?: string
          updated_at?: string
        }
        Update: {
          cash_balance?: number
          client_id?: string
          currency?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          account_type: string
          created_at: string
          display_name: string
          email: string | null
          id: string
          initials: string | null
          ref: string | null
          s708_expiry: string | null
          updated_at: string
        }
        Insert: {
          account_type: string
          created_at?: string
          display_name: string
          email?: string | null
          id?: string
          initials?: string | null
          ref?: string | null
          s708_expiry?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: string
          created_at?: string
          display_name?: string
          email?: string | null
          id?: string
          initials?: string | null
          ref?: string | null
          s708_expiry?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      investment_ideas: {
        Row: {
          code: string
          conviction: number
          created_at: string
          entry_hi: number | null
          entry_lo: number | null
          hook: string | null
          horizon: string | null
          id: string
          name: string
          placement_id: string | null
          risk: Database["public"]["Enums"]["risk_level"]
          target: number | null
          theme: string
          thesis: string | null
        }
        Insert: {
          code: string
          conviction: number
          created_at?: string
          entry_hi?: number | null
          entry_lo?: number | null
          hook?: string | null
          horizon?: string | null
          id?: string
          name: string
          placement_id?: string | null
          risk: Database["public"]["Enums"]["risk_level"]
          target?: number | null
          theme: string
          thesis?: string | null
        }
        Update: {
          code?: string
          conviction?: number
          created_at?: string
          entry_hi?: number | null
          entry_lo?: number | null
          hook?: string | null
          horizon?: string | null
          id?: string
          name?: string
          placement_id?: string | null
          risk?: Database["public"]["Enums"]["risk_level"]
          target?: number | null
          theme?: string
          thesis?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "investment_ideas_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "placements"
            referencedColumns: ["id"]
          },
        ]
      }
      market_indices: {
        Row: {
          chg: number
          code: string
          decimal_places: number
          last: number
          name: string
          updated_at: string
        }
        Insert: {
          chg: number
          code: string
          decimal_places?: number
          last: number
          name: string
          updated_at?: string
        }
        Update: {
          chg?: number
          code?: string
          decimal_places?: number
          last?: number
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      news: {
        Row: {
          direction: Database["public"]["Enums"]["news_direction"]
          headline: string
          id: string
          impact: string | null
          source: string
          ts: string
          use_note: string | null
        }
        Insert: {
          direction: Database["public"]["Enums"]["news_direction"]
          headline: string
          id?: string
          impact?: string | null
          source: string
          ts?: string
          use_note?: string | null
        }
        Update: {
          direction?: Database["public"]["Enums"]["news_direction"]
          headline?: string
          id?: string
          impact?: string | null
          source?: string
          ts?: string
          use_note?: string | null
        }
        Relationships: []
      }
      option_holdings: {
        Row: {
          client_id: string
          code: string
          created_at: string
          expiry_date: string
          id: string
          listed: boolean
          name: string
          option_type: Database["public"]["Enums"]["option_type"]
          qty: number
          ref: string | null
          source: string | null
          status: Database["public"]["Enums"]["option_status"]
          strike: number
          underlying_code: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          code: string
          created_at?: string
          expiry_date: string
          id?: string
          listed: boolean
          name: string
          option_type: Database["public"]["Enums"]["option_type"]
          qty: number
          ref?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["option_status"]
          strike: number
          underlying_code?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          code?: string
          created_at?: string
          expiry_date?: string
          id?: string
          listed?: boolean
          name?: string
          option_type?: Database["public"]["Enums"]["option_type"]
          qty?: number
          ref?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["option_status"]
          strike?: number
          underlying_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "option_holdings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "option_holdings_underlying_code_fkey"
            columns: ["underlying_code"]
            isOneToOne: false
            referencedRelation: "securities"
            referencedColumns: ["code"]
          },
        ]
      }
      placements: {
        Row: {
          alloc_date: string | null
          allot_date: string | null
          close_date: string | null
          code: string
          created_at: string
          discount_pct: number | null
          id: string
          last: number | null
          min_bid: number
          name: string
          opts: string | null
          price: number
          raise_millions: number
          ref: string | null
          settle_date: string | null
          stage: Database["public"]["Enums"]["placement_stage"]
          type: Database["public"]["Enums"]["placement_type"]
          updated_at: string
        }
        Insert: {
          alloc_date?: string | null
          allot_date?: string | null
          close_date?: string | null
          code: string
          created_at?: string
          discount_pct?: number | null
          id?: string
          last?: number | null
          min_bid: number
          name: string
          opts?: string | null
          price: number
          raise_millions: number
          ref?: string | null
          settle_date?: string | null
          stage?: Database["public"]["Enums"]["placement_stage"]
          type: Database["public"]["Enums"]["placement_type"]
          updated_at?: string
        }
        Update: {
          alloc_date?: string | null
          allot_date?: string | null
          close_date?: string | null
          code?: string
          created_at?: string
          discount_pct?: number | null
          id?: string
          last?: number | null
          min_bid?: number
          name?: string
          opts?: string | null
          price?: number
          raise_millions?: number
          ref?: string | null
          settle_date?: string | null
          stage?: Database["public"]["Enums"]["placement_stage"]
          type?: Database["public"]["Enums"]["placement_type"]
          updated_at?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          avg_cost: number
          client_id: string
          created_at: string
          id: string
          qty: number
          security_code: string
          updated_at: string
        }
        Insert: {
          avg_cost: number
          client_id: string
          created_at?: string
          id?: string
          qty: number
          security_code: string
          updated_at?: string
        }
        Update: {
          avg_cost?: number
          client_id?: string
          created_at?: string
          id?: string
          qty?: number
          security_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_security_code_fkey"
            columns: ["security_code"]
            isOneToOne: false
            referencedRelation: "securities"
            referencedColumns: ["code"]
          },
        ]
      }
      recommendations: {
        Row: {
          move: string | null
          rating: string
          security_code: string
          target_price: number | null
          updated_at: string
        }
        Insert: {
          move?: string | null
          rating: string
          security_code: string
          target_price?: number | null
          updated_at?: string
        }
        Update: {
          move?: string | null
          rating?: string
          security_code?: string
          target_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendations_security_code_fkey"
            columns: ["security_code"]
            isOneToOne: true
            referencedRelation: "securities"
            referencedColumns: ["code"]
          },
        ]
      }
      research_notes: {
        Row: {
          body: string
          created_at: string
          id: string
          published: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          published?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          published?: string
          title?: string
        }
        Relationships: []
      }
      research_reports: {
        Row: {
          id: string
          kind: string
          pages: number | null
          published: string
          title: string
        }
        Insert: {
          id?: string
          kind: string
          pages?: number | null
          published: string
          title: string
        }
        Update: {
          id?: string
          kind?: string
          pages?: number | null
          published?: string
          title?: string
        }
        Relationships: []
      }
      sectors: {
        Row: {
          beneficiaries: string[]
          drivers: string | null
          momentum: number
          name: string
        }
        Insert: {
          beneficiaries?: string[]
          drivers?: string | null
          momentum: number
          name: string
        }
        Update: {
          beneficiaries?: string[]
          drivers?: string | null
          momentum?: number
          name?: string
        }
        Relationships: []
      }
      securities: {
        Row: {
          code: string
          created_at: string
          last_price: number | null
          last_price_at: string | null
          listed: boolean
          name: string
          sector: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          last_price?: number | null
          last_price_at?: string | null
          listed?: boolean
          name: string
          sector?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          last_price?: number | null
          last_price_at?: string | null
          listed?: boolean
          name?: string
          sector?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          action: Database["public"]["Enums"]["signal_action"]
          detail: string | null
          headline: string
          security_code: string
          target: number | null
          updated_at: string
        }
        Insert: {
          action: Database["public"]["Enums"]["signal_action"]
          detail?: string | null
          headline: string
          security_code: string
          target?: number | null
          updated_at?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["signal_action"]
          detail?: string | null
          headline?: string
          security_code?: string
          target?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signals_security_code_fkey"
            columns: ["security_code"]
            isOneToOne: true
            referencedRelation: "securities"
            referencedColumns: ["code"]
          },
        ]
      }
      watchlist_items: {
        Row: {
          alert_direction: Database["public"]["Enums"]["alert_direction"] | null
          alert_threshold: number | null
          client_id: string
          created_at: string
          display_name: string
          id: string
          security_code: string | null
          unlisted: boolean
        }
        Insert: {
          alert_direction?:
            | Database["public"]["Enums"]["alert_direction"]
            | null
          alert_threshold?: number | null
          client_id: string
          created_at?: string
          display_name: string
          id?: string
          security_code?: string | null
          unlisted?: boolean
        }
        Update: {
          alert_direction?:
            | Database["public"]["Enums"]["alert_direction"]
            | null
          alert_threshold?: number | null
          client_id?: string
          created_at?: string
          display_name?: string
          id?: string
          security_code?: string | null
          unlisted?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "watchlist_items_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      alert_direction: "above" | "below"
      alert_kind: "expiry" | "itm" | "window" | "price"
      alert_severity: "red" | "amber" | "green"
      news_direction: "up" | "dn"
      option_status: "open" | "pending" | "expired"
      option_type: "Call" | "Put"
      placement_stage: "upcoming" | "open" | "closed" | "settled"
      placement_type: "Placement" | "SPP" | "Pre-IPO" | "Rights"
      risk_level: "Low" | "Medium" | "High"
      signal_action: "Add" | "Hold" | "Trim" | "Take profit" | "Watch"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      alert_direction: ["above", "below"],
      alert_kind: ["expiry", "itm", "window", "price"],
      alert_severity: ["red", "amber", "green"],
      news_direction: ["up", "dn"],
      option_status: ["open", "pending", "expired"],
      option_type: ["Call", "Put"],
      placement_stage: ["upcoming", "open", "closed", "settled"],
      placement_type: ["Placement", "SPP", "Pre-IPO", "Rights"],
      risk_level: ["Low", "Medium", "High"],
      signal_action: ["Add", "Hold", "Trim", "Take profit", "Watch"],
    },
  },
} as const
