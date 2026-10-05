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
  public: {
    Tables: {
      ai_interviews: {
        Row: {
          application_id: string
          created_at: string
          culture_org_score: number
          culture_role_score: number
          id: string
          jd_match_score: number
          org_id: string | null
          skillset_score: number
          summary: string | null
          transcript: Json
        }
        Insert: {
          application_id: string
          created_at?: string
          culture_org_score?: number
          culture_role_score?: number
          id?: string
          jd_match_score?: number
          org_id?: string | null
          skillset_score?: number
          summary?: string | null
          transcript?: Json
        }
        Update: {
          application_id?: string
          created_at?: string
          culture_org_score?: number
          culture_role_score?: number
          id?: string
          jd_match_score?: number
          org_id?: string | null
          skillset_score?: number
          summary?: string | null
          transcript?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_interviews_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_interviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_provider_credentials: {
        Row: {
          api_key: string
          org_id: string | null
          provider: string
          updated_at: string
        }
        Insert: {
          api_key: string
          org_id?: string | null
          provider: string
          updated_at?: string
        }
        Update: {
          api_key?: string
          org_id?: string | null
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_credentials_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_settings: {
        Row: {
          id: string
          last_test_message: string | null
          last_test_status: string
          last_tested_at: string | null
          model: string
          org_id: string | null
          provider: string
          singleton: boolean
          updated_at: string
        }
        Insert: {
          id?: string
          last_test_message?: string | null
          last_test_status?: string
          last_tested_at?: string | null
          model?: string
          org_id?: string | null
          provider?: string
          singleton?: boolean
          updated_at?: string
        }
        Update: {
          id?: string
          last_test_message?: string | null
          last_test_status?: string
          last_tested_at?: string | null
          model?: string
          org_id?: string | null
          provider?: string
          singleton?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          applied_at: string
          candidate_id: string
          id: string
          last_activity_at: string
          org_id: string | null
          requisition_id: string
          source: string
          stage: Database["public"]["Enums"]["app_stage"]
          stage_note: string | null
          stage_reason: string | null
        }
        Insert: {
          applied_at?: string
          candidate_id: string
          id?: string
          last_activity_at?: string
          org_id?: string | null
          requisition_id: string
          source?: string
          stage?: Database["public"]["Enums"]["app_stage"]
          stage_note?: string | null
          stage_reason?: string | null
        }
        Update: {
          applied_at?: string
          candidate_id?: string
          id?: string
          last_activity_at?: string
          org_id?: string | null
          requisition_id?: string
          source?: string
          stage?: Database["public"]["Enums"]["app_stage"]
          stage_note?: string | null
          stage_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          actor_user_id: string | null
          created_at: string
          detail: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          ip: string | null
          org_id: string | null
        }
        Insert: {
          action: string
          actor?: string | null
          actor_user_id?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip?: string | null
          org_id?: string | null
        }
        Update: {
          action?: string
          actor?: string | null
          actor_user_id?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip?: string | null
          org_id?: string | null
        }
        Relationships: []
      }
      auth_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          purpose: string
          token_hash: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          purpose: string
          token_hash: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          purpose?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "auth_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_assessments: {
        Row: {
          answers: Json
          candidate_id: string
          completed_at: string | null
          created_at: string
          dimensions: Json | null
          id: string
          mindset_score: number | null
          model: string | null
          org_id: string | null
          questions: Json
          red_flags: string[]
          requisition_id: string | null
          status: string
          strengths: string[]
          summary: string | null
          token: string
        }
        Insert: {
          answers?: Json
          candidate_id: string
          completed_at?: string | null
          created_at?: string
          dimensions?: Json | null
          id?: string
          mindset_score?: number | null
          model?: string | null
          org_id?: string | null
          questions?: Json
          red_flags?: string[]
          requisition_id?: string | null
          status?: string
          strengths?: string[]
          summary?: string | null
          token: string
        }
        Update: {
          answers?: Json
          candidate_id?: string
          completed_at?: string | null
          created_at?: string
          dimensions?: Json | null
          id?: string
          mindset_score?: number | null
          model?: string | null
          org_id?: string | null
          questions?: Json
          red_flags?: string[]
          requisition_id?: string | null
          status?: string
          strengths?: string[]
          summary?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_assessments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_assessments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_assessments_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_notes: {
        Row: {
          author_id: string
          author_name: string | null
          body: string
          candidate_id: string
          created_at: string
          id: string
          mentions: string[]
          org_id: string | null
        }
        Insert: {
          author_id: string
          author_name?: string | null
          body: string
          candidate_id: string
          created_at?: string
          id?: string
          mentions?: string[]
          org_id?: string | null
        }
        Update: {
          author_id?: string
          author_name?: string | null
          body?: string
          candidate_id?: string
          created_at?: string
          id?: string
          mentions?: string[]
          org_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_ownership_events: {
        Row: {
          actor: string | null
          candidate_id: string
          created_at: string
          from_owner: string | null
          id: string
          org_id: string | null
          reason: string | null
          to_owner: string | null
        }
        Insert: {
          actor?: string | null
          candidate_id: string
          created_at?: string
          from_owner?: string | null
          id?: string
          org_id?: string | null
          reason?: string | null
          to_owner?: string | null
        }
        Update: {
          actor?: string | null
          candidate_id?: string
          created_at?: string
          from_owner?: string | null
          id?: string
          org_id?: string | null
          reason?: string | null
          to_owner?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_ownership_events_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_ownership_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_referrals: {
        Row: {
          candidate_id: string
          created_at: string
          from_user: string
          id: string
          note: string | null
          org_id: string | null
          requisition_id: string | null
          responded_at: string | null
          response_note: string | null
          status: string
          to_user: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          from_user: string
          id?: string
          note?: string | null
          org_id?: string | null
          requisition_id?: string | null
          responded_at?: string | null
          response_note?: string | null
          status?: string
          to_user: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          from_user?: string
          id?: string
          note?: string | null
          org_id?: string | null
          requisition_id?: string | null
          responded_at?: string | null
          response_note?: string | null
          status?: string
          to_user?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_referrals_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_referrals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_referrals_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_verifications: {
        Row: {
          authenticity_score: number
          candidate_id: string
          claims: Json
          created_at: string
          evidence: Json
          id: string
          model: string | null
          org_id: string | null
          red_flags: string[]
          status: string
          summary: string | null
        }
        Insert: {
          authenticity_score?: number
          candidate_id: string
          claims?: Json
          created_at?: string
          evidence?: Json
          id?: string
          model?: string | null
          org_id?: string | null
          red_flags?: string[]
          status?: string
          summary?: string | null
        }
        Update: {
          authenticity_score?: number
          candidate_id?: string
          claims?: Json
          created_at?: string
          evidence?: Json
          id?: string
          model?: string | null
          org_id?: string | null
          red_flags?: string[]
          status?: string
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_verifications_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_verifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      candidates: {
        Row: {
          added_by: string | null
          career_metrics: Json | null
          consent_given: boolean
          created_at: string
          current_ctc: number | null
          current_department: string | null
          current_employer: string | null
          education: string | null
          email: string
          employee_id: string | null
          employment_history: Json
          expected_ctc: number | null
          experience_years: number
          external_id: string | null
          external_provider: string | null
          full_name: string
          github_url: string | null
          id: string
          is_internal: boolean
          last_synced_at: string | null
          linkedin_url: string | null
          location: string | null
          manager_endorsed: boolean
          notice_period_days: number | null
          org_id: string | null
          owner_id: string | null
          phone: string | null
          preferred_locations: string[]
          referral_source: string | null
          resume_file_path: string | null
          resume_text: string | null
          skills: string[]
          source: string
          suspected_prompt_injection: boolean
          sync_status: string
          website_url: string | null
          willing_to_relocate: boolean | null
          work_authorization: string | null
          x_url: string | null
        }
        Insert: {
          added_by?: string | null
          career_metrics?: Json | null
          consent_given?: boolean
          created_at?: string
          current_ctc?: number | null
          current_department?: string | null
          current_employer?: string | null
          education?: string | null
          email: string
          employee_id?: string | null
          employment_history?: Json
          expected_ctc?: number | null
          experience_years?: number
          external_id?: string | null
          external_provider?: string | null
          full_name: string
          github_url?: string | null
          id?: string
          is_internal?: boolean
          last_synced_at?: string | null
          linkedin_url?: string | null
          location?: string | null
          manager_endorsed?: boolean
          notice_period_days?: number | null
          org_id?: string | null
          owner_id?: string | null
          phone?: string | null
          preferred_locations?: string[]
          referral_source?: string | null
          resume_file_path?: string | null
          resume_text?: string | null
          skills?: string[]
          source?: string
          suspected_prompt_injection?: boolean
          sync_status?: string
          website_url?: string | null
          willing_to_relocate?: boolean | null
          work_authorization?: string | null
          x_url?: string | null
        }
        Update: {
          added_by?: string | null
          career_metrics?: Json | null
          consent_given?: boolean
          created_at?: string
          current_ctc?: number | null
          current_department?: string | null
          current_employer?: string | null
          education?: string | null
          email?: string
          employee_id?: string | null
          employment_history?: Json
          expected_ctc?: number | null
          experience_years?: number
          external_id?: string | null
          external_provider?: string | null
          full_name?: string
          github_url?: string | null
          id?: string
          is_internal?: boolean
          last_synced_at?: string | null
          linkedin_url?: string | null
          location?: string | null
          manager_endorsed?: boolean
          notice_period_days?: number | null
          org_id?: string | null
          owner_id?: string | null
          phone?: string | null
          preferred_locations?: string[]
          referral_source?: string | null
          resume_file_path?: string | null
          resume_text?: string | null
          skills?: string[]
          source?: string
          suspected_prompt_injection?: boolean
          sync_status?: string
          website_url?: string | null
          willing_to_relocate?: boolean | null
          work_authorization?: string | null
          x_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      capture_events: {
        Row: {
          candidate_id: string | null
          created_at: string
          detail: string | null
          id: string
          kind: string
          org_id: string
          requisition_id: string | null
          source_url: string | null
          status: string
          title: string | null
        }
        Insert: {
          candidate_id?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          kind: string
          org_id: string
          requisition_id?: string | null
          source_url?: string | null
          status?: string
          title?: string | null
        }
        Update: {
          candidate_id?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          kind?: string
          org_id?: string
          requisition_id?: string | null
          source_url?: string | null
          status?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capture_events_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capture_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capture_events_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      comp_knowledge: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          experience_max: number | null
          experience_min: number | null
          high: number | null
          id: string
          level_key: string
          location: string | null
          low: number | null
          median: number
          note: string | null
          org_id: string
          requisition_id: string | null
          role_key: string
          source: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          experience_max?: number | null
          experience_min?: number | null
          high?: number | null
          id?: string
          level_key: string
          location?: string | null
          low?: number | null
          median: number
          note?: string | null
          org_id: string
          requisition_id?: string | null
          role_key: string
          source?: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          experience_max?: number | null
          experience_min?: number | null
          high?: number | null
          id?: string
          level_key?: string
          location?: string | null
          low?: number | null
          median?: number
          note?: string | null
          org_id?: string
          requisition_id?: string | null
          role_key?: string
          source?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "comp_knowledge_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comp_knowledge_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_templates: {
        Row: {
          background_content_type: string | null
          background_path: string | null
          config: Json
          created_at: string
          id: string
          instructions: string | null
          is_default: boolean
          kind: string
          logo_content_type: string | null
          logo_path: string | null
          name: string
          org_id: string
          source_content_type: string | null
          source_name: string | null
          source_path: string | null
          updated_at: string
        }
        Insert: {
          background_content_type?: string | null
          background_path?: string | null
          config?: Json
          created_at?: string
          id?: string
          instructions?: string | null
          is_default?: boolean
          kind: string
          logo_content_type?: string | null
          logo_path?: string | null
          name: string
          org_id: string
          source_content_type?: string | null
          source_name?: string | null
          source_path?: string | null
          updated_at?: string
        }
        Update: {
          background_content_type?: string | null
          background_path?: string | null
          config?: Json
          created_at?: string
          id?: string
          instructions?: string | null
          is_default?: boolean
          kind?: string
          logo_content_type?: string | null
          logo_path?: string | null
          name?: string
          org_id?: string
          source_content_type?: string | null
          source_name?: string | null
          source_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          org_id: string | null
          role: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          org_id?: string | null
          role: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          org_id?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "copilot_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          budgeted_cost: number
          budgeted_headcount: number
          created_at: string
          head_name: string | null
          id: string
          name: string
          org_id: string | null
          period: string
        }
        Insert: {
          budgeted_cost?: number
          budgeted_headcount?: number
          created_at?: string
          head_name?: string | null
          id?: string
          name: string
          org_id?: string | null
          period?: string
        }
        Update: {
          budgeted_cost?: number
          budgeted_headcount?: number
          created_at?: string
          head_name?: string | null
          id?: string
          name?: string
          org_id?: string | null
          period?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluations: {
        Row: {
          application_id: string
          comments: string | null
          competencies: Json
          created_at: string
          evaluator: string | null
          focus_area: string | null
          id: string
          interview_id: string | null
          level: number
          org_id: string | null
          rating: number | null
          recommendation: Database["public"]["Enums"]["recommendation"]
          submitted_at: string | null
          submitted_by: string | null
        }
        Insert: {
          application_id: string
          comments?: string | null
          competencies?: Json
          created_at?: string
          evaluator?: string | null
          focus_area?: string | null
          id?: string
          interview_id?: string | null
          level: number
          org_id?: string | null
          rating?: number | null
          recommendation?: Database["public"]["Enums"]["recommendation"]
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Update: {
          application_id?: string
          comments?: string | null
          competencies?: Json
          created_at?: string
          evaluator?: string | null
          focus_area?: string | null
          id?: string
          interview_id?: string | null
          level?: number
          org_id?: string | null
          rating?: number | null
          recommendation?: Database["public"]["Enums"]["recommendation"]
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "evaluations_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluations_interview_id_fkey"
            columns: ["interview_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      hr_incentive_schemes: {
        Row: {
          currency: string
          monthly_cap: number | null
          notes: string | null
          org_id: string
          payout_per_closure: number
          quality_bands: Json
          target_closures_per_month: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          currency?: string
          monthly_cap?: number | null
          notes?: string | null
          org_id: string
          payout_per_closure?: number
          quality_bands?: Json
          target_closures_per_month?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          currency?: string
          monthly_cap?: number | null
          notes?: string | null
          org_id?: string
          payout_per_closure?: number
          quality_bands?: Json
          target_closures_per_month?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hr_incentive_schemes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_messages: {
        Row: {
          attachment_bytes: number | null
          attachment_name: string | null
          body: string | null
          candidate_id: string | null
          created_at: string
          detail: string | null
          from_email: string | null
          from_name: string | null
          id: string
          org_id: string
          provider_message_id: string | null
          received_at: string
          requisition_id: string | null
          status: string
          subject: string | null
          to_address: string | null
        }
        Insert: {
          attachment_bytes?: number | null
          attachment_name?: string | null
          body?: string | null
          candidate_id?: string | null
          created_at?: string
          detail?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          org_id: string
          provider_message_id?: string | null
          received_at?: string
          requisition_id?: string | null
          status?: string
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          attachment_bytes?: number | null
          attachment_name?: string | null
          body?: string | null
          candidate_id?: string | null
          created_at?: string
          detail?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          org_id?: string
          provider_message_id?: string | null
          received_at?: string
          requisition_id?: string | null
          status?: string
          subject?: string | null
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbox_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_credentials: {
        Row: {
          integration_id: string
          org_id: string | null
          secrets: Json
          updated_at: string
        }
        Insert: {
          integration_id: string
          org_id?: string | null
          secrets?: Json
          updated_at?: string
        }
        Update: {
          integration_id?: string
          org_id?: string | null
          secrets?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_credentials_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: true
            referencedRelation: "source_integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_credentials_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      interviews: {
        Row: {
          agenda: string | null
          application_id: string
          completed_at: string | null
          created_at: string
          duration_mins: number
          id: string
          interviewer: string | null
          interviewer_email: string | null
          level: number
          mode: string
          org_id: string | null
          scheduled_at: string | null
          status: string
          teams_link: string | null
        }
        Insert: {
          agenda?: string | null
          application_id: string
          completed_at?: string | null
          created_at?: string
          duration_mins?: number
          id?: string
          interviewer?: string | null
          interviewer_email?: string | null
          level?: number
          mode?: string
          org_id?: string | null
          scheduled_at?: string | null
          status?: string
          teams_link?: string | null
        }
        Update: {
          agenda?: string | null
          application_id?: string
          completed_at?: string | null
          created_at?: string
          duration_mins?: number
          id?: string
          interviewer?: string | null
          interviewer_email?: string | null
          level?: number
          mode?: string
          org_id?: string | null
          scheduled_at?: string | null
          status?: string
          teams_link?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "interviews_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_descriptions: {
        Row: {
          approver_comment: string | null
          created_at: string
          full_text: string | null
          good_to_have: string[]
          id: string
          must_have: string[]
          org_id: string | null
          purpose: string | null
          qualifications: string | null
          reporting_to: string | null
          requisition_id: string
          responsibilities: string | null
          status: Database["public"]["Enums"]["jd_status"]
          success_factors: string | null
          template_id: string | null
          template_name: string | null
          version: number
        }
        Insert: {
          approver_comment?: string | null
          created_at?: string
          full_text?: string | null
          good_to_have?: string[]
          id?: string
          must_have?: string[]
          org_id?: string | null
          purpose?: string | null
          qualifications?: string | null
          reporting_to?: string | null
          requisition_id: string
          responsibilities?: string | null
          status?: Database["public"]["Enums"]["jd_status"]
          success_factors?: string | null
          template_id?: string | null
          template_name?: string | null
          version?: number
        }
        Update: {
          approver_comment?: string | null
          created_at?: string
          full_text?: string | null
          good_to_have?: string[]
          id?: string
          must_have?: string[]
          org_id?: string | null
          purpose?: string | null
          qualifications?: string | null
          reporting_to?: string | null
          requisition_id?: string
          responsibilities?: string | null
          status?: Database["public"]["Enums"]["jd_status"]
          success_factors?: string | null
          template_id?: string | null
          template_name?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_descriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_descriptions_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      linkedin_oauth_states: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          org_id: string
          redirect_uri: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          org_id: string
          redirect_uri: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          org_id?: string
          redirect_uri?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "linkedin_oauth_states_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          created_at: string
          email: string
          id: string
          ip: string | null
          success: boolean
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          ip?: string | null
          success?: boolean
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          ip?: string | null
          success?: boolean
        }
        Relationships: []
      }
      master_items: {
        Row: {
          active: boolean
          category: string | null
          created_at: string
          id: string
          kind: string
          name: string
          org_id: string | null
          sort_order: number
        }
        Insert: {
          active?: boolean
          category?: string | null
          created_at?: string
          id?: string
          kind: string
          name: string
          org_id?: string | null
          sort_order?: number
        }
        Update: {
          active?: boolean
          category?: string | null
          created_at?: string
          id?: string
          kind?: string
          name?: string
          org_id?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "master_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      match_scores: {
        Row: {
          application_id: string
          career_flags: string[]
          career_metrics: Json | null
          career_score: number
          computed_at: string
          education_score: number
          experience_score: number
          id: string
          impact_highlights: string[]
          impact_score: number
          innovation_score: number
          innovation_signals: string[]
          logistics_flags: string[]
          matched_skills: string[]
          missing_skills: string[]
          model: string | null
          org_id: string | null
          overall_score: number
          override_reason: string | null
          rationale: string | null
          recommendation: Database["public"]["Enums"]["recommendation"] | null
          recruiter_override:
            | Database["public"]["Enums"]["recommendation"]
            | null
          risk_flags: string[]
          skills_score: number
          social_score: number
          weights: Json
        }
        Insert: {
          application_id: string
          career_flags?: string[]
          career_metrics?: Json | null
          career_score?: number
          computed_at?: string
          education_score?: number
          experience_score?: number
          id?: string
          impact_highlights?: string[]
          impact_score?: number
          innovation_score?: number
          innovation_signals?: string[]
          logistics_flags?: string[]
          matched_skills?: string[]
          missing_skills?: string[]
          model?: string | null
          org_id?: string | null
          overall_score?: number
          override_reason?: string | null
          rationale?: string | null
          recommendation?: Database["public"]["Enums"]["recommendation"] | null
          recruiter_override?:
            | Database["public"]["Enums"]["recommendation"]
            | null
          risk_flags?: string[]
          skills_score?: number
          social_score?: number
          weights?: Json
        }
        Update: {
          application_id?: string
          career_flags?: string[]
          career_metrics?: Json | null
          career_score?: number
          computed_at?: string
          education_score?: number
          experience_score?: number
          id?: string
          impact_highlights?: string[]
          impact_score?: number
          innovation_score?: number
          innovation_signals?: string[]
          logistics_flags?: string[]
          matched_skills?: string[]
          missing_skills?: string[]
          model?: string | null
          org_id?: string | null
          overall_score?: number
          override_reason?: string | null
          rationale?: string | null
          recommendation?: Database["public"]["Enums"]["recommendation"] | null
          recruiter_override?:
            | Database["public"]["Enums"]["recommendation"]
            | null
          risk_flags?: string[]
          skills_score?: number
          social_score?: number
          weights?: Json
        }
        Relationships: [
          {
            foreignKeyName: "match_scores_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_scores_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          application_id: string
          approval_trail: Json
          created_at: string
          id: string
          joining_date: string | null
          letter: Json | null
          letter_template_id: string | null
          offered_ctc: number
          org_id: string | null
          status: Database["public"]["Enums"]["offer_status"]
        }
        Insert: {
          application_id: string
          approval_trail?: Json
          created_at?: string
          id?: string
          joining_date?: string | null
          letter?: Json | null
          letter_template_id?: string | null
          offered_ctc?: number
          org_id?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
        }
        Update: {
          application_id?: string
          approval_trail?: Json
          created_at?: string
          id?: string
          joining_date?: string | null
          letter?: Json | null
          letter_template_id?: string | null
          offered_ctc?: number
          org_id?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
        }
        Relationships: [
          {
            foreignKeyName: "offers_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_documents: {
        Row: {
          application_id: string
          candidate_id: string
          content_type: string | null
          created_at: string
          doc_type: string
          extracted: Json | null
          extracted_text: string | null
          extraction_note: string | null
          extraction_status: string
          file_bytes: number | null
          file_name: string
          file_path: string | null
          id: string
          inbox_message_id: string | null
          model: string | null
          offer_id: string | null
          org_id: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          uploaded_by: string | null
        }
        Insert: {
          application_id: string
          candidate_id: string
          content_type?: string | null
          created_at?: string
          doc_type: string
          extracted?: Json | null
          extracted_text?: string | null
          extraction_note?: string | null
          extraction_status?: string
          file_bytes?: number | null
          file_name: string
          file_path?: string | null
          id?: string
          inbox_message_id?: string | null
          model?: string | null
          offer_id?: string | null
          org_id: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          uploaded_by?: string | null
        }
        Update: {
          application_id?: string
          candidate_id?: string
          content_type?: string | null
          created_at?: string
          doc_type?: string
          extracted?: Json | null
          extracted_text?: string | null
          extraction_note?: string | null
          extraction_status?: string
          file_bytes?: number | null
          file_name?: string
          file_path?: string | null
          id?: string
          inbox_message_id?: string | null
          model?: string | null
          offer_id?: string | null
          org_id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_documents_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_documents_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ontology_snapshots: {
        Row: {
          added: string[]
          created_at: string
          dormant: string[]
          edge_count: number
          grown: string[]
          id: string
          model: string | null
          node_count: number
          org_id: string
          retired: string[]
          stats: Json
        }
        Insert: {
          added?: string[]
          created_at?: string
          dormant?: string[]
          edge_count?: number
          grown?: string[]
          id?: string
          model?: string | null
          node_count?: number
          org_id: string
          retired?: string[]
          stats?: Json
        }
        Update: {
          added?: string[]
          created_at?: string
          dormant?: string[]
          edge_count?: number
          grown?: string[]
          id?: string
          model?: string | null
          node_count?: number
          org_id?: string
          retired?: string[]
          stats?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ontology_snapshots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_linkedin_connections: {
        Row: {
          access_token: string
          connected_at: string
          connected_by: string | null
          expires_at: string | null
          member_email: string | null
          member_name: string | null
          member_sub: string
          org_id: string
          refresh_token: string | null
          scope: string | null
          updated_at: string
        }
        Insert: {
          access_token: string
          connected_at?: string
          connected_by?: string | null
          expires_at?: string | null
          member_email?: string | null
          member_name?: string | null
          member_sub: string
          org_id: string
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string
          connected_at?: string
          connected_by?: string | null
          expires_at?: string | null
          member_email?: string | null
          member_name?: string | null
          member_sub?: string
          org_id?: string
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_linkedin_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["app_role"] | null
          is_owner: boolean
          joined_at: string | null
          org_id: string
          status: string
          title: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["app_role"] | null
          is_owner?: boolean
          joined_at?: string | null
          org_id: string
          status?: string
          title?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["app_role"] | null
          is_owner?: boolean
          joined_at?: string | null
          org_id?: string
          status?: string
          title?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_pool_shares: {
        Row: {
          created_at: string
          id: string
          owner_org: string
          partner_org: string
          requested_by: string | null
          responded_at: string | null
          responded_by: string | null
          revoked_at: string | null
          scope: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          owner_org: string
          partner_org: string
          requested_by?: string | null
          responded_at?: string | null
          responded_by?: string | null
          revoked_at?: string | null
          scope?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          owner_org?: string
          partner_org?: string
          requested_by?: string | null
          responded_at?: string | null
          responded_by?: string | null
          revoked_at?: string | null
          scope?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_pool_shares_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_pool_shares_partner_org_fkey"
            columns: ["partner_org"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          archived_at: string | null
          archived_reason: string | null
          capture_token: string | null
          capture_token_hash: string | null
          careers_email: string | null
          created_at: string
          created_by: string | null
          currency: string
          email_domain: string | null
          employee_band: string | null
          fiscal_year_start_month: number
          hq_city: string | null
          hq_country: string | null
          id: string
          inbox_slug: string | null
          industry: string | null
          legal_name: string | null
          name: string
          onboarded_at: string | null
          onboarding_step: string
          rejected_at: string | null
          rejection_reason: string | null
          slug: string
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          archived_reason?: string | null
          capture_token?: string | null
          capture_token_hash?: string | null
          careers_email?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          email_domain?: string | null
          employee_band?: string | null
          fiscal_year_start_month?: number
          hq_city?: string | null
          hq_country?: string | null
          id?: string
          inbox_slug?: string | null
          industry?: string | null
          legal_name?: string | null
          name: string
          onboarded_at?: string | null
          onboarding_step?: string
          rejected_at?: string | null
          rejection_reason?: string | null
          slug: string
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          archived_reason?: string | null
          capture_token?: string | null
          capture_token_hash?: string | null
          careers_email?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          email_domain?: string | null
          employee_band?: string | null
          fiscal_year_start_month?: number
          hq_city?: string | null
          hq_country?: string | null
          id?: string
          inbox_slug?: string | null
          industry?: string | null
          legal_name?: string | null
          name?: string
          onboarded_at?: string | null
          onboarding_step?: string
          rejected_at?: string | null
          rejection_reason?: string | null
          slug?: string
          status?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          id: string
          note: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          id?: string
          note?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          id?: string
          note?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      product_catalogue_commercials: {
        Row: {
          currency: string
          list_price: number | null
          module_id: string
          notes: string | null
          tier: string | null
          unit: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          currency?: string
          list_price?: number | null
          module_id: string
          notes?: string | null
          tier?: string | null
          unit?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          currency?: string
          list_price?: number | null
          module_id?: string
          notes?: string | null
          tier?: string | null
          unit?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      requisitions: {
        Row: {
          approval_trail: Json
          billing_type: string
          budget_ctc: number
          career_level: string | null
          client_name: string | null
          code: string
          cost_center: string | null
          created_at: string
          ctc_band_max: number | null
          ctc_band_min: number | null
          department_id: string | null
          education_requirement: string | null
          engagement_type: string
          experience_max: number
          experience_min: number
          good_to_have_skills: string[]
          hiring_manager: string | null
          id: string
          ijp_enabled: boolean
          ijp_notes: string | null
          ijp_posted_at: string | null
          job_card_overrides: Json
          location: string | null
          max_notice_period_days: number | null
          must_have_skills: string[]
          opened_at: string
          openings: number
          org_id: string | null
          req_type: Database["public"]["Enums"]["req_type"]
          responsibilities: string | null
          status: Database["public"]["Enums"]["req_status"]
          title: string
          weight_career: number
          weight_education: number
          weight_experience: number
          weight_impact: number
          weight_skills: number
          weight_social: number
          work_authorization_required: string | null
        }
        Insert: {
          approval_trail?: Json
          billing_type?: string
          budget_ctc?: number
          career_level?: string | null
          client_name?: string | null
          code: string
          cost_center?: string | null
          created_at?: string
          ctc_band_max?: number | null
          ctc_band_min?: number | null
          department_id?: string | null
          education_requirement?: string | null
          engagement_type?: string
          experience_max?: number
          experience_min?: number
          good_to_have_skills?: string[]
          hiring_manager?: string | null
          id?: string
          ijp_enabled?: boolean
          ijp_notes?: string | null
          ijp_posted_at?: string | null
          job_card_overrides?: Json
          location?: string | null
          max_notice_period_days?: number | null
          must_have_skills?: string[]
          opened_at?: string
          openings?: number
          org_id?: string | null
          req_type?: Database["public"]["Enums"]["req_type"]
          responsibilities?: string | null
          status?: Database["public"]["Enums"]["req_status"]
          title: string
          weight_career?: number
          weight_education?: number
          weight_experience?: number
          weight_impact?: number
          weight_skills?: number
          weight_social?: number
          work_authorization_required?: string | null
        }
        Update: {
          approval_trail?: Json
          billing_type?: string
          budget_ctc?: number
          career_level?: string | null
          client_name?: string | null
          code?: string
          cost_center?: string | null
          created_at?: string
          ctc_band_max?: number | null
          ctc_band_min?: number | null
          department_id?: string | null
          education_requirement?: string | null
          engagement_type?: string
          experience_max?: number
          experience_min?: number
          good_to_have_skills?: string[]
          hiring_manager?: string | null
          id?: string
          ijp_enabled?: boolean
          ijp_notes?: string | null
          ijp_posted_at?: string | null
          job_card_overrides?: Json
          location?: string | null
          max_notice_period_days?: number | null
          must_have_skills?: string[]
          opened_at?: string
          openings?: number
          org_id?: string | null
          req_type?: Database["public"]["Enums"]["req_type"]
          responsibilities?: string | null
          status?: Database["public"]["Enums"]["req_status"]
          title?: string
          weight_career?: number
          weight_education?: number
          weight_experience?: number
          weight_impact?: number
          weight_skills?: number
          weight_social?: number
          work_authorization_required?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "requisitions_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requisitions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      salary_benchmarks: {
        Row: {
          confidence: string
          created_at: string
          currency: string
          experience_max: number
          experience_min: number
          grounded: boolean
          id: string
          input_key: string
          location: string | null
          model: string
          org_id: string
          payload: Json
          provider: string
          requisition_id: string | null
          title: string
        }
        Insert: {
          confidence?: string
          created_at?: string
          currency?: string
          experience_max?: number
          experience_min?: number
          grounded?: boolean
          id?: string
          input_key: string
          location?: string | null
          model: string
          org_id: string
          payload: Json
          provider: string
          requisition_id?: string | null
          title: string
        }
        Update: {
          confidence?: string
          created_at?: string
          currency?: string
          experience_max?: number
          experience_min?: number
          grounded?: boolean
          id?: string
          input_key?: string
          location?: string | null
          model?: string
          org_id?: string
          payload?: Json
          provider?: string
          requisition_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "salary_benchmarks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_benchmarks_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      screening_kits: {
        Row: {
          application_id: string | null
          candidate_id: string
          created_at: string
          created_by: string | null
          engine: Json
          focus_summary: string | null
          id: string
          org_id: string | null
          questions: Json
          requisition_id: string | null
          updated_at: string
        }
        Insert: {
          application_id?: string | null
          candidate_id: string
          created_at?: string
          created_by?: string | null
          engine?: Json
          focus_summary?: string | null
          id?: string
          org_id?: string | null
          questions?: Json
          requisition_id?: string | null
          updated_at?: string
        }
        Update: {
          application_id?: string | null
          candidate_id?: string
          created_at?: string
          created_by?: string | null
          engine?: Json
          focus_summary?: string | null
          id?: string
          org_id?: string | null
          questions?: Json
          requisition_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "screening_kits_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_kits_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_kits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_kits_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      screening_runs: {
        Row: {
          answers: Json
          application_id: string | null
          audio_engine: string | null
          audio_path: string | null
          candidate_id: string
          combined_score: number | null
          created_at: string
          created_by: string | null
          engine: Json
          id: string
          input_kind: string
          kit_id: string
          match_score: number | null
          org_id: string | null
          rationale: string | null
          recommendation: string | null
          recommendation_reason: string | null
          red_flags: string[]
          requisition_id: string | null
          screening_score: number
          transcript: string | null
          verdicts: Json
        }
        Insert: {
          answers?: Json
          application_id?: string | null
          audio_engine?: string | null
          audio_path?: string | null
          candidate_id: string
          combined_score?: number | null
          created_at?: string
          created_by?: string | null
          engine?: Json
          id?: string
          input_kind?: string
          kit_id: string
          match_score?: number | null
          org_id?: string | null
          rationale?: string | null
          recommendation?: string | null
          recommendation_reason?: string | null
          red_flags?: string[]
          requisition_id?: string | null
          screening_score?: number
          transcript?: string | null
          verdicts?: Json
        }
        Update: {
          answers?: Json
          application_id?: string | null
          audio_engine?: string | null
          audio_path?: string | null
          candidate_id?: string
          combined_score?: number | null
          created_at?: string
          created_by?: string | null
          engine?: Json
          id?: string
          input_kind?: string
          kit_id?: string
          match_score?: number | null
          org_id?: string | null
          rationale?: string | null
          recommendation?: string | null
          recommendation_reason?: string | null
          red_flags?: string[]
          requisition_id?: string | null
          screening_score?: number
          transcript?: string | null
          verdicts?: Json
        }
        Relationships: [
          {
            foreignKeyName: "screening_runs_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_runs_kit_id_fkey"
            columns: ["kit_id"]
            isOneToOne: false
            referencedRelation: "screening_kits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screening_runs_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          last_used_at: string
          token_hash: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          last_used_at?: string
          token_hash: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          last_used_at?: string
          token_hash?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_edges: {
        Row: {
          evidence_count: number
          from_slug: string
          id: string
          kind: string
          org_id: string
          to_slug: string
          updated_at: string
          weight: number
        }
        Insert: {
          evidence_count?: number
          from_slug: string
          id?: string
          kind?: string
          org_id: string
          to_slug: string
          updated_at?: string
          weight?: number
        }
        Update: {
          evidence_count?: number
          from_slug?: string
          id?: string
          kind?: string
          org_id?: string
          to_slug?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "skill_edges_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_evidence: {
        Row: {
          candidate_id: string | null
          created_at: string
          id: string
          observed_at: string
          org_id: string
          requisition_id: string | null
          slug: string
          source: string
          strength: number
        }
        Insert: {
          candidate_id?: string | null
          created_at?: string
          id?: string
          observed_at?: string
          org_id: string
          requisition_id?: string | null
          slug: string
          source: string
          strength?: number
        }
        Update: {
          candidate_id?: string | null
          created_at?: string
          id?: string
          observed_at?: string
          org_id?: string
          requisition_id?: string | null
          slug?: string
          source?: string
          strength?: number
        }
        Relationships: [
          {
            foreignKeyName: "skill_evidence_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_evidence_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_evidence_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_nodes: {
        Row: {
          aliases: string[]
          category: string
          demand: number
          evidence_count: number
          first_seen_at: string
          id: string
          last_seen_at: string
          name: string
          org_id: string
          parent_slug: string | null
          slug: string
          status: string
          supply: number
          updated_at: string
          validated: number
        }
        Insert: {
          aliases?: string[]
          category?: string
          demand?: number
          evidence_count?: number
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          name: string
          org_id: string
          parent_slug?: string | null
          slug: string
          status?: string
          supply?: number
          updated_at?: string
          validated?: number
        }
        Update: {
          aliases?: string[]
          category?: string
          demand?: number
          evidence_count?: number
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          name?: string
          org_id?: string
          parent_slug?: string | null
          slug?: string
          status?: string
          supply?: number
          updated_at?: string
          validated?: number
        }
        Relationships: [
          {
            foreignKeyName: "skill_nodes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_profiles: {
        Row: {
          candidate_id: string
          fetched_at: string
          handle: string | null
          id: string
          last_synced_at: string | null
          org_id: string | null
          profile_url: string | null
          provider: string
          rationale: string | null
          raw: Json | null
          score: number
          signals: Json
          status: string
        }
        Insert: {
          candidate_id: string
          fetched_at?: string
          handle?: string | null
          id?: string
          last_synced_at?: string | null
          org_id?: string | null
          profile_url?: string | null
          provider: string
          rationale?: string | null
          raw?: Json | null
          score?: number
          signals?: Json
          status?: string
        }
        Update: {
          candidate_id?: string
          fetched_at?: string
          handle?: string | null
          id?: string
          last_synced_at?: string | null
          org_id?: string | null
          profile_url?: string | null
          provider?: string
          rationale?: string | null
          raw?: Json | null
          score?: number
          signals?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_profiles_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      source_integrations: {
        Row: {
          category: string
          config: Json
          created_at: string
          credential_fields: string[]
          enabled: boolean
          has_credentials: boolean
          id: string
          label: string
          last_test_message: string | null
          last_test_status: string
          last_tested_at: string | null
          org_id: string | null
          provider: string
          updated_at: string
        }
        Insert: {
          category?: string
          config?: Json
          created_at?: string
          credential_fields?: string[]
          enabled?: boolean
          has_credentials?: boolean
          id?: string
          label: string
          last_test_message?: string | null
          last_test_status?: string
          last_tested_at?: string | null
          org_id?: string | null
          provider: string
          updated_at?: string
        }
        Update: {
          category?: string
          config?: Json
          created_at?: string
          credential_fields?: string[]
          enabled?: boolean
          has_credentials?: boolean
          id?: string
          label?: string
          last_test_message?: string | null
          last_test_status?: string
          last_tested_at?: string | null
          org_id?: string | null
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_integrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      stage_events: {
        Row: {
          actor: string | null
          application_id: string
          created_at: string
          from_stage: Database["public"]["Enums"]["app_stage"] | null
          id: string
          note: string | null
          org_id: string | null
          reason: string | null
          to_stage: Database["public"]["Enums"]["app_stage"]
        }
        Insert: {
          actor?: string | null
          application_id: string
          created_at?: string
          from_stage?: Database["public"]["Enums"]["app_stage"] | null
          id?: string
          note?: string | null
          org_id?: string | null
          reason?: string | null
          to_stage: Database["public"]["Enums"]["app_stage"]
        }
        Update: {
          actor?: string | null
          application_id?: string
          created_at?: string
          from_stage?: Database["public"]["Enums"]["app_stage"] | null
          id?: string
          note?: string | null
          org_id?: string | null
          reason?: string | null
          to_stage?: Database["public"]["Enums"]["app_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "stage_events_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      talent_request_suggestions: {
        Row: {
          candidate_id: string
          created_at: string
          id: string
          note: string | null
          org_id: string
          request_id: string
          status: string
          suggested_by: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          id?: string
          note?: string | null
          org_id: string
          request_id: string
          status?: string
          suggested_by: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          id?: string
          note?: string | null
          org_id?: string
          request_id?: string
          status?: string
          suggested_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "talent_request_suggestions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "talent_request_suggestions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "talent_request_suggestions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "talent_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      talent_requests: {
        Row: {
          closed_at: string | null
          created_at: string
          id: string
          note: string | null
          org_id: string
          requester_id: string
          requisition_id: string | null
          skills: string[]
          status: string
          title: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          id?: string
          note?: string | null
          org_id: string
          requester_id: string
          requisition_id?: string | null
          skills?: string[]
          status?: string
          title: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          id?: string
          note?: string | null
          org_id?: string
          requester_id?: string
          requisition_id?: string | null
          skills?: string[]
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "talent_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "talent_requests_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          org_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          org_id?: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          org_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          email_confirmed_at: string | null
          full_name: string | null
          id: string
          last_login_at: string | null
          password_hash: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          email_confirmed_at?: string | null
          full_name?: string | null
          id?: string
          last_login_at?: string | null
          password_hash?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          email_confirmed_at?: string | null
          full_name?: string | null
          id?: string
          last_login_at?: string | null
          password_hash?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_org_id: { Args: never; Returns: string }
      has_org_role: {
        Args: {
          _org: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_org_member: { Args: { _org: string }; Returns: boolean }
      is_org_owner: { Args: { _org: string }; Returns: boolean }
      shares_pool_with_me: { Args: { _owner_org: string }; Returns: boolean }
    }
    Enums: {
      app_role:
        | "recruiter"
        | "hiring_manager"
        | "department_head"
        | "hr_head"
        | "president_cbo"
      app_stage:
        | "sourced"
        | "applied"
        | "ai_screened"
        | "shortlisted"
        | "l1"
        | "l2"
        | "l3"
        | "offer"
        | "hired"
        | "rejected"
        | "offer_pending"
        | "offer_released"
        | "offer_accepted"
        | "offer_declined"
        | "joined"
        | "no_show"
        | "joining_deferred"
        | "withdrawn"
        | "on_hold"
        | "reserve"
      jd_status: "draft" | "pending_dh" | "approved" | "changes_requested"
      offer_status:
        | "draft"
        | "pending_hr"
        | "pending_cbo"
        | "approved"
        | "released"
        | "accepted"
        | "declined"
        | "revoked"
      recommendation: "select" | "reject" | "hold"
      req_status:
        | "draft"
        | "pending_dh"
        | "pending_hr"
        | "pending_cbo"
        | "approved"
        | "rejected"
        | "on_hold"
        | "closed"
      req_type: "new" | "replacement"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      app_role: [
        "recruiter",
        "hiring_manager",
        "department_head",
        "hr_head",
        "president_cbo",
      ],
      app_stage: [
        "sourced",
        "applied",
        "ai_screened",
        "shortlisted",
        "l1",
        "l2",
        "l3",
        "offer",
        "hired",
        "rejected",
        "offer_pending",
        "offer_released",
        "offer_accepted",
        "offer_declined",
        "joined",
        "no_show",
        "joining_deferred",
        "withdrawn",
        "on_hold",
        "reserve",
      ],
      jd_status: ["draft", "pending_dh", "approved", "changes_requested"],
      offer_status: [
        "draft",
        "pending_hr",
        "pending_cbo",
        "approved",
        "released",
        "accepted",
        "declined",
        "revoked",
      ],
      recommendation: ["select", "reject", "hold"],
      req_status: [
        "draft",
        "pending_dh",
        "pending_hr",
        "pending_cbo",
        "approved",
        "rejected",
        "on_hold",
        "closed",
      ],
      req_type: ["new", "replacement"],
    },
  },
} as const
