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
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      academic_sessions: {
        Row: {
          created_at: string
          end_date: string
          id: string
          institution_id: string
          is_current: boolean
          name: string
          start_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_date: string
          id?: string
          institution_id: string
          is_current?: boolean
          name: string
          start_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_date?: string
          id?: string
          institution_id?: string
          is_current?: boolean
          name?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academic_sessions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_ip: unknown
          actor_user_agent: string | null
          actor_user_id: string | null
          created_at: string
          id: string
          institution_id: string | null
          new_value: Json | null
          old_value: Json | null
          request_id: string | null
          resource_id: string | null
          resource_type: string
          session_id: string | null
        }
        Insert: {
          action: string
          actor_ip?: unknown
          actor_user_agent?: string | null
          actor_user_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          new_value?: Json | null
          old_value?: Json | null
          request_id?: string | null
          resource_id?: string | null
          resource_type: string
          session_id?: string | null
        }
        Update: {
          action?: string
          actor_ip?: unknown
          actor_user_agent?: string | null
          actor_user_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          new_value?: Json | null
          old_value?: Json | null
          request_id?: string | null
          resource_id?: string | null
          resource_type?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_message_events: {
        Row: {
          created_at: string
          event_json: Json
          event_type: string
          id: string
          message_id: string | null
          run_id: string
          seq: number
          thread_id: string
        }
        Insert: {
          created_at?: string
          event_json: Json
          event_type: string
          id?: string
          message_id?: string | null
          run_id: string
          seq: number
          thread_id: string
        }
        Update: {
          created_at?: string
          event_json?: Json
          event_type?: string
          id?: string
          message_id?: string | null
          run_id?: string
          seq?: number
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_message_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "thread_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_events_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_message_feedback: {
        Row: {
          created_at: string
          helpful: boolean
          id: string
          institution_id: string | null
          sdk_message_id: string
          thread_id: string
          user_id: string
          user_role: string | null
        }
        Insert: {
          created_at?: string
          helpful: boolean
          id?: string
          institution_id?: string | null
          sdk_message_id: string
          thread_id: string
          user_id: string
          user_role?: string | null
        }
        Update: {
          created_at?: string
          helpful?: boolean
          id?: string
          institution_id?: string | null
          sdk_message_id?: string
          thread_id?: string
          user_id?: string
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_message_feedback_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_feedback_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_thread_shares: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          is_revoked: boolean
          thread_id: string
          token: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_revoked?: boolean
          thread_id: string
          token?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_revoked?: boolean
          thread_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_thread_shares_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          is_archived: boolean
          metadata: Json
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_archived?: boolean
          metadata?: Json
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_archived?: boolean
          metadata?: Json
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_threads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_sla_rules: {
        Row: {
          claim_type: Database["public"]["Enums"]["claim_type"]
          created_at: string
          hod_sla_hours: number
          id: string
          institution_id: string
          updated_at: string
        }
        Insert: {
          claim_type: Database["public"]["Enums"]["claim_type"]
          created_at?: string
          hod_sla_hours?: number
          id?: string
          institution_id: string
          updated_at?: string
        }
        Update: {
          claim_type?: Database["public"]["Enums"]["claim_type"]
          created_at?: string
          hod_sla_hours?: number
          id?: string
          institution_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_sla_rules_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          course_code: string
          course_type: string
          created_at: string
          credit_units: number
          deleted_at: string | null
          department_id: string
          dept_prefix: string
          id: string
          institution_id: string
          is_active: boolean
          is_gst: boolean
          is_lab: boolean
          is_project: boolean
          is_siwes: boolean
          level: number
          search_vector: unknown
          semester: string
          synopsis: string | null
          title: string
          updated_at: string
        }
        Insert: {
          course_code: string
          course_type?: string
          created_at?: string
          credit_units: number
          deleted_at?: string | null
          department_id: string
          dept_prefix: string
          id?: string
          institution_id: string
          is_active?: boolean
          is_gst?: boolean
          is_lab?: boolean
          is_project?: boolean
          is_siwes?: boolean
          level: number
          search_vector?: unknown
          semester: string
          synopsis?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          course_code?: string
          course_type?: string
          created_at?: string
          credit_units?: number
          deleted_at?: string | null
          department_id?: string
          dept_prefix?: string
          id?: string
          institution_id?: string
          is_active?: boolean
          is_gst?: boolean
          is_lab?: boolean
          is_project?: boolean
          is_siwes?: boolean
          level?: number
          search_vector?: unknown
          semester?: string
          synopsis?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          code: string
          created_at: string
          faculty_id: string
          hod_user_id: string | null
          id: string
          institution_id: string
          is_active: boolean
          name: string
          prefix_code: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          faculty_id: string
          hod_user_id?: string | null
          id?: string
          institution_id: string
          is_active?: boolean
          name: string
          prefix_code?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          faculty_id?: string
          hod_user_id?: string | null
          id?: string
          institution_id?: string
          is_active?: boolean
          name?: string
          prefix_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_faculty_id_fkey"
            columns: ["faculty_id"]
            isOneToOne: false
            referencedRelation: "faculties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_departments_hod"
            columns: ["hod_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      faculties: {
        Row: {
          code: string
          created_at: string
          dean_email: string | null
          id: string
          institution_id: string
          is_active: boolean
          name: string
          site_url: string | null
          unit_type: Database["public"]["Enums"]["academic_unit_type"]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          dean_email?: string | null
          id?: string
          institution_id: string
          is_active?: boolean
          name: string
          site_url?: string | null
          unit_type: Database["public"]["Enums"]["academic_unit_type"]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          dean_email?: string | null
          id?: string
          institution_id?: string
          is_active?: boolean
          name?: string
          site_url?: string | null
          unit_type?: Database["public"]["Enums"]["academic_unit_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "faculties_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions: {
        Row: {
          code: string
          created_at: string
          domain: string | null
          id: string
          is_active: boolean
          logo_url: string | null
          name: string
          settings: Json
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          domain?: string | null
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          domain?: string | null
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: []
      }
      invite_tokens: {
        Row: {
          created_at: string
          department_id: string | null
          email: string
          expires_at: string
          id: string
          institution_id: string
          invited_by: string
          redeemed_at: string | null
          role: Database["public"]["Enums"]["user_role"]
          token_hash: string
        }
        Insert: {
          created_at?: string
          department_id?: string | null
          email: string
          expires_at?: string
          id?: string
          institution_id: string
          invited_by: string
          redeemed_at?: string | null
          role: Database["public"]["Enums"]["user_role"]
          token_hash: string
        }
        Update: {
          created_at?: string
          department_id?: string | null
          email?: string
          expires_at?: string
          id?: string
          institution_id?: string
          invited_by?: string
          redeemed_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "invite_tokens_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_tokens_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_tokens_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_document_sources: {
        Row: {
          content_hash: string | null
          created_at: string
          doc_id: string
          fetch_error_count: number
          id: string
          institution_id: string | null
          last_changed_at: string | null
          last_fetched_at: string | null
          source_url: string
          updated_at: string
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          doc_id: string
          fetch_error_count?: number
          id?: string
          institution_id?: string | null
          last_changed_at?: string | null
          last_fetched_at?: string | null
          source_url: string
          updated_at?: string
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          doc_id?: string
          fetch_error_count?: number
          id?: string
          institution_id?: string | null
          last_changed_at?: string | null
          last_fetched_at?: string | null
          source_url?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_document_sources_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          read_at: string | null
          resource_id: string | null
          resource_type: string
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          resource_id?: string | null
          resource_type?: string
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          resource_id?: string | null
          resource_type?: string
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_sessions: {
        Row: {
          abandoned_at: string | null
          completed_at: string | null
          current_step: number
          id: string
          journey_type: Database["public"]["Enums"]["journey_type"]
          source_url: string | null
          started_at: string
          status: Database["public"]["Enums"]["onboarding_status"]
          step_data: Json
          step_key: string | null
          total_steps: number
          user_id: string
        }
        Insert: {
          abandoned_at?: string | null
          completed_at?: string | null
          current_step?: number
          id?: string
          journey_type: Database["public"]["Enums"]["journey_type"]
          source_url?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["onboarding_status"]
          step_data?: Json
          step_key?: string | null
          total_steps: number
          user_id: string
        }
        Update: {
          abandoned_at?: string | null
          completed_at?: string | null
          current_step?: number
          id?: string
          journey_type?: Database["public"]["Enums"]["journey_type"]
          source_url?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["onboarding_status"]
          step_data?: Json
          step_key?: string | null
          total_steps?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      parent_student_links: {
        Row: {
          can_receive_notifications: boolean
          can_view_academic: boolean
          can_view_attendance: boolean
          can_view_fees: boolean
          claimed_matric: string | null
          correction_count: number
          created_at: string
          expires_at: string | null
          id: string
          is_primary_contact: boolean
          last_corrected_at: string | null
          parent_user_id: string
          relationship_type: Database["public"]["Enums"]["parent_relationship"]
          student_user_id: string | null
          updated_at: string
          verification_code: string | null
          verification_status: Database["public"]["Enums"]["link_status"]
          verified_at: string | null
        }
        Insert: {
          can_receive_notifications?: boolean
          can_view_academic?: boolean
          can_view_attendance?: boolean
          can_view_fees?: boolean
          claimed_matric?: string | null
          correction_count?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          is_primary_contact?: boolean
          last_corrected_at?: string | null
          parent_user_id: string
          relationship_type?: Database["public"]["Enums"]["parent_relationship"]
          student_user_id?: string | null
          updated_at?: string
          verification_code?: string | null
          verification_status?: Database["public"]["Enums"]["link_status"]
          verified_at?: string | null
        }
        Update: {
          can_receive_notifications?: boolean
          can_view_academic?: boolean
          can_view_attendance?: boolean
          can_view_fees?: boolean
          claimed_matric?: string | null
          correction_count?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          is_primary_contact?: boolean
          last_corrected_at?: string | null
          parent_user_id?: string
          relationship_type?: Database["public"]["Enums"]["parent_relationship"]
          student_user_id?: string | null
          updated_at?: string
          verification_code?: string | null
          verification_status?: Database["public"]["Enums"]["link_status"]
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parent_student_links_parent_user_id_fkey"
            columns: ["parent_user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parent_student_links_student_user_id_fkey"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      prefix_routing: {
        Row: {
          created_at: string
          department_id: string
          faculty_id: string
          id: string
          institution_id: string
          prefix_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department_id: string
          faculty_id: string
          id?: string
          institution_id: string
          prefix_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department_id?: string
          faculty_id?: string
          id?: string
          institution_id?: string
          prefix_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prefix_routing_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prefix_routing_faculty_id_fkey"
            columns: ["faculty_id"]
            isOneToOne: false
            referencedRelation: "faculties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prefix_routing_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      programs: {
        Row: {
          code: string
          created_at: string
          degree_type: string
          department_id: string
          duration_years: number | null
          entry_level: number | null
          id: string
          institution_id: string
          is_active: boolean
          jamb_subject_combo: string[] | null
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          degree_type: string
          department_id: string
          duration_years?: number | null
          entry_level?: number | null
          id?: string
          institution_id: string
          is_active?: boolean
          jamb_subject_combo?: string[] | null
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          degree_type?: string
          department_id?: string
          duration_years?: number | null
          entry_level?: number | null
          id?: string
          institution_id?: string
          is_active?: boolean
          jamb_subject_combo?: string[] | null
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "programs_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      semesters: {
        Row: {
          academic_session_id: string
          created_at: string
          end_date: string
          id: string
          is_current: boolean
          name: string
          semester_number: number
          start_date: string
          updated_at: string
        }
        Insert: {
          academic_session_id: string
          created_at?: string
          end_date: string
          id?: string
          is_current?: boolean
          name: string
          semester_number: number
          start_date: string
          updated_at?: string
        }
        Update: {
          academic_session_id?: string
          created_at?: string
          end_date?: string
          id?: string
          is_current?: boolean
          name?: string
          semester_number?: number
          start_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "semesters_academic_session_id_fkey"
            columns: ["academic_session_id"]
            isOneToOne: false
            referencedRelation: "academic_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      thread_messages: {
        Row: {
          content: string
          content_json: Json
          created_at: string
          format: string | null
          id: string
          metadata: Json
          parent_id: string | null
          role: string
          sdk_message_id: string | null
          thread_id: string
        }
        Insert: {
          content?: string
          content_json?: Json
          created_at?: string
          format?: string | null
          id?: string
          metadata?: Json
          parent_id?: string | null
          role: string
          sdk_message_id?: string | null
          thread_id: string
        }
        Update: {
          content?: string
          content_json?: Json
          created_at?: string
          format?: string | null
          id?: string
          metadata?: Json
          parent_id?: string | null
          role?: string
          sdk_message_id?: string | null
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ai_context: {
        Row: {
          created_at: string
          id: string
          institution: string | null
          level: string | null
          matric_number: string | null
          preferences: Json
          programme: string | null
          role: string | null
          topics_seen: string[]
          trust_level: number | null
          updated_at: string
          user_id: string
          verified: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          institution?: string | null
          level?: string | null
          matric_number?: string | null
          preferences?: Json
          programme?: string | null
          role?: string | null
          topics_seen?: string[]
          trust_level?: number | null
          updated_at?: string
          user_id: string
          verified?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          institution?: string | null
          level?: string | null
          matric_number?: string | null
          preferences?: Json
          programme?: string | null
          role?: string | null
          topics_seen?: string[]
          trust_level?: number | null
          updated_at?: string
          user_id?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "user_ai_context_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          custom_fields: Json
          id: string
          profile_data: Json
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          custom_fields?: Json
          id?: string
          profile_data?: Json
          role: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          custom_fields?: Json
          id?: string
          profile_data?: Json
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_student_links: {
        Row: {
          attempt_count: number
          claimed_programme_id: string | null
          created_at: string
          department_id: string | null
          id: string
          idp_provider: string | null
          idp_sub: string | null
          institution_id: string
          last_attempt_at: string | null
          matric_number: string
          portal_response: Json | null
          rejection_reason: string | null
          trust_level: number
          updated_at: string
          user_id: string
          verification_method: string
          verification_status: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          attempt_count?: number
          claimed_programme_id?: string | null
          created_at?: string
          department_id?: string | null
          id?: string
          idp_provider?: string | null
          idp_sub?: string | null
          institution_id: string
          last_attempt_at?: string | null
          matric_number: string
          portal_response?: Json | null
          rejection_reason?: string | null
          trust_level?: number
          updated_at?: string
          user_id: string
          verification_method?: string
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          attempt_count?: number
          claimed_programme_id?: string | null
          created_at?: string
          department_id?: string | null
          id?: string
          idp_provider?: string | null
          idp_sub?: string | null
          institution_id?: string
          last_attempt_at?: string | null
          matric_number?: string
          portal_response?: Json | null
          rejection_reason?: string | null
          trust_level?: number
          updated_at?: string
          user_id?: string
          verification_method?: string
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_student_links_claimed_programme_id_fkey"
            columns: ["claimed_programme_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_student_links_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_student_links_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_student_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_student_links_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_id: string
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          deleted_reason: string | null
          display_name: string | null
          email: string
          email_verified_at: string | null
          first_name: string | null
          id: string
          institution_id: string | null
          is_superadmin: boolean
          last_login_at: string | null
          last_name: string | null
          phone: string | null
          primary_role: Database["public"]["Enums"]["user_role"]
          roles: Database["public"]["Enums"]["user_role"][]
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
        }
        Insert: {
          auth_id: string
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          display_name?: string | null
          email: string
          email_verified_at?: string | null
          first_name?: string | null
          id?: string
          institution_id?: string | null
          is_superadmin?: boolean
          last_login_at?: string | null
          last_name?: string | null
          phone?: string | null
          primary_role?: Database["public"]["Enums"]["user_role"]
          roles?: Database["public"]["Enums"]["user_role"][]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Update: {
          auth_id?: string
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          display_name?: string | null
          email?: string
          email_verified_at?: string | null
          first_name?: string | null
          id?: string
          institution_id?: string | null
          is_superadmin?: boolean
          last_login_at?: string | null
          last_name?: string | null
          phone?: string | null
          primary_role?: Database["public"]["Enums"]["user_role"]
          roles?: Database["public"]["Enums"]["user_role"][]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_claims: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assigned_to: string | null
          auto_routed: boolean
          claim_type: Database["public"]["Enums"]["claim_type"]
          created_at: string
          deadline: string | null
          department_id: string | null
          details: Json
          escalated_at: string | null
          escalated_to: string | null
          id: string
          institution_id: string
          is_urgent: boolean
          rejection_reason: string | null
          requirements: Json
          review_notes: string | null
          reviewed_at: string | null
          reviewer_id: string | null
          status: Database["public"]["Enums"]["claim_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          auto_routed?: boolean
          claim_type: Database["public"]["Enums"]["claim_type"]
          created_at?: string
          deadline?: string | null
          department_id?: string | null
          details?: Json
          escalated_at?: string | null
          escalated_to?: string | null
          id?: string
          institution_id: string
          is_urgent?: boolean
          rejection_reason?: string | null
          requirements?: Json
          review_notes?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          status?: Database["public"]["Enums"]["claim_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          auto_routed?: boolean
          claim_type?: Database["public"]["Enums"]["claim_type"]
          created_at?: string
          deadline?: string | null
          department_id?: string | null
          details?: Json
          escalated_at?: string | null
          escalated_to?: string | null
          id?: string
          institution_id?: string
          is_urgent?: boolean
          rejection_reason?: string | null
          requirements?: Json
          review_notes?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          status?: Database["public"]["Enums"]["claim_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_claims_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_escalated_to_fkey"
            columns: ["escalated_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_claims_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_admin_institution_id: { Args: never; Returns: string }
      current_user_public_id: { Args: never; Returns: string }
      fn_admin_assign_claim: {
        Args: {
          p_claim_id: string
          p_department_id: string
          p_hod_user_id: string
        }
        Returns: undefined
      }
      fn_admin_reopen_claim: {
        Args: { p_claim_id: string; p_notes?: string }
        Returns: undefined
      }
      fn_admin_set_user_role: {
        Args: { p_role: string; p_target_user_id: string }
        Returns: undefined
      }
      fn_admin_set_user_status: {
        Args: { p_status: string; p_target_user_id: string }
        Returns: undefined
      }
      fn_admin_verify_student: {
        Args: { p_action: string; p_link_id: string; p_reason?: string }
        Returns: undefined
      }
      fn_assert_active_admin: {
        Args: never
        Returns: {
          institution_id: string
          is_superadmin: boolean
          user_id: string
        }[]
      }
      fn_assert_active_hod: {
        Args: never
        Returns: {
          department_id: string
          department_name: string
          faculty_id: string
          institution_id: string
          user_id: string
        }[]
      }
      fn_create_chat_thread: { Args: { p_title?: string }; Returns: string }
      fn_delete_chat_thread: {
        Args: { p_thread_id: string }
        Returns: undefined
      }
      fn_delete_my_account: { Args: { p_reason?: string }; Returns: undefined }
      fn_escalate_stale_claims: { Args: never; Returns: number }
      fn_expire_parent_claims: { Args: never; Returns: undefined }
      fn_get_auth_institution_id: { Args: never; Returns: string }
      fn_get_chat_messages: {
        Args: { p_thread_id: string }
        Returns: {
          content: string
          content_json: Json
          created_at: string
          id: string
          metadata: Json
          role: string
        }[]
      }
      fn_get_message_feedback: {
        Args: { p_sdk_message_id: string }
        Returns: {
          helpful: boolean
        }[]
      }
      fn_get_public_messages_by_share_token: {
        Args: { p_token: string }
        Returns: {
          content: string
          content_json: Json
          created_at: string
          format: string | null
          id: string
          metadata: Json
          parent_id: string | null
          role: string
          sdk_message_id: string | null
          thread_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "thread_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_get_public_thread_by_share_token: {
        Args: { p_token: string }
        Returns: {
          created_at: string
          is_archived: boolean
          metadata: Json
          thread_id: string
          title: string
          updated_at: string
        }[]
      }
      fn_hod_review_claim: {
        Args: {
          p_action: string
          p_claim_id: string
          p_notes?: string
          p_rejection_reason?: string
        }
        Returns: undefined
      }
      fn_is_admin: { Args: never; Returns: boolean }
      fn_is_hod: { Args: never; Returns: boolean }
      fn_is_staff_or_above: { Args: never; Returns: boolean }
      fn_is_superadmin: { Args: never; Returns: boolean }
      fn_list_chat_threads: {
        Args: never
        Returns: {
          created_at: string
          id: string
          is_archived: boolean
          last_message_at: string
          last_message_content: string
          title: string
          updated_at: string
        }[]
      }
      fn_list_my_chat_threads: {
        Args: never
        Returns: {
          id: string
          is_archived: boolean
          title: string
          updated_at: string
        }[]
      }
      fn_log_auth_event: { Args: { p_action: string }; Returns: undefined }
      fn_mark_notification_read: {
        Args: { p_notification_id: string }
        Returns: undefined
      }
      fn_onboard_self: {
        Args: {
          p_first_name: string
          p_institution_id: string
          p_last_name?: string
          p_phone?: string
          p_role: string
        }
        Returns: undefined
      }
      fn_provision_admin: {
        Args: { p_email: string; p_institution_id: string }
        Returns: undefined
      }
      fn_provision_superadmin: { Args: { p_email: string }; Returns: undefined }
      fn_readonly_list_active_faculties: {
        Args: { p_institution_id: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      fn_redeem_invite_token: { Args: { p_token: string }; Returns: Json }
      fn_resolve_pending_parent_claims: {
        Args: { p_matric: string; p_user_id: string }
        Returns: undefined
      }
      fn_respond_to_parent_claim: {
        Args: { p_accept: boolean; p_link_id: string }
        Returns: undefined
      }
      fn_search_institutions: {
        Args: { p_query: string }
        Returns: {
          code: string
          domain: string
          id: string
          name: string
        }[]
      }
      fn_self_report_student: {
        Args: { p_institution_id: string; p_matric_number: string }
        Returns: undefined
      }
      fn_set_my_avatar: { Args: { p_url: string }; Returns: undefined }
      fn_submit_message_feedback: {
        Args: {
          p_helpful: boolean
          p_sdk_message_id: string
          p_thread_id: string
        }
        Returns: undefined
      }
      fn_submit_verification_claim: {
        Args: {
          p_claim_type: Database["public"]["Enums"]["claim_type"]
          p_deadline?: string
          p_details?: Json
          p_is_urgent?: boolean
          p_requirements?: Json
        }
        Returns: Json
      }
      fn_superadmin_override_claim: {
        Args: {
          p_action: string
          p_claim_id: string
          p_notes?: string
          p_rejection_reason?: string
        }
        Returns: undefined
      }
      fn_update_chat_thread: {
        Args: { p_archived?: boolean; p_thread_id: string; p_title?: string }
        Returns: undefined
      }
      fn_update_my_ai_context: { Args: { p_patch: Json }; Returns: undefined }
      fn_update_my_profile: { Args: { p_patch: Json }; Returns: undefined }
      fn_upsert_chat_messages: {
        Args: { p_messages: Json; p_thread_id: string }
        Returns: undefined
      }
      fn_validate_institution_scope: {
        Args: { p_institution_id: string }
        Returns: boolean
      }
      fn_validate_patch_text: {
        Args: { p_key: string; p_max: number; p_patch: Json }
        Returns: string
      }
      fn_write_audit_log: {
        Args: {
          p_action: string
          p_institution_id?: string
          p_new_value?: Json
          p_old_value?: Json
          p_resource_id?: string
          p_resource_type: string
        }
        Returns: undefined
      }
      fn_write_audit_log_for_kb: {
        Args: {
          p_action: string
          p_new_value?: Json
          p_old_value?: Json
          p_resource_id?: string
          p_resource_type: string
        }
        Returns: undefined
      }
    }
    Enums: {
      academic_unit_type:
        | "faculty"
        | "school"
        | "college"
        | "institute"
        | "centre"
        | "affiliate"
      account_status:
        | "pending_verification"
        | "active"
        | "suspended"
        | "deactivated"
        | "archived"
      claim_status:
        | "pending"
        | "in_review"
        | "approved"
        | "rejected"
        | "cancelled"
      claim_type:
        | "transcript"
        | "degree"
        | "enrollment"
        | "good_standing"
        | "attestation"
      journey_type: "prospective" | "student" | "parent" | "staff"
      link_status:
        | "pending"
        | "verified"
        | "rejected"
        | "awaiting_student_approval"
        | "abandoned"
      onboarding_status: "in_progress" | "completed" | "abandoned"
      parent_relationship: "parent" | "guardian" | "sponsor"
      user_role:
        | "prospective"
        | "student"
        | "parent"
        | "guardian"
        | "staff"
        | "hod"
        | "admin"
        | "superadmin"
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
      academic_unit_type: [
        "faculty",
        "school",
        "college",
        "institute",
        "centre",
        "affiliate",
      ],
      account_status: [
        "pending_verification",
        "active",
        "suspended",
        "deactivated",
        "archived",
      ],
      claim_status: [
        "pending",
        "in_review",
        "approved",
        "rejected",
        "cancelled",
      ],
      claim_type: [
        "transcript",
        "degree",
        "enrollment",
        "good_standing",
        "attestation",
      ],
      journey_type: ["prospective", "student", "parent", "staff"],
      link_status: [
        "pending",
        "verified",
        "rejected",
        "awaiting_student_approval",
        "abandoned",
      ],
      onboarding_status: ["in_progress", "completed", "abandoned"],
      parent_relationship: ["parent", "guardian", "sponsor"],
      user_role: [
        "prospective",
        "student",
        "parent",
        "guardian",
        "staff",
        "hod",
        "admin",
        "superadmin",
      ],
    },
  },
} as const
