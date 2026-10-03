// Supabase 스키마에서 생성한 타입 (supabase/migrations 기준).
// 스키마를 바꾸면 다시 생성해 `Database` 부분을 교체한다.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      comments: {
        Row: {
          author_id: string;
          body: string;
          created_at: string;
          id: string;
          room_id: string;
        };
        Insert: {
          author_id?: string;
          body: string;
          created_at?: string;
          id?: string;
          room_id: string;
        };
        Update: {
          author_id?: string;
          body?: string;
          created_at?: string;
          id?: string;
          room_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_room_id_fkey';
            columns: ['room_id'];
            isOneToOne: false;
            referencedRelation: 'rooms';
            referencedColumns: ['id'];
          },
        ];
      };
      furniture_catalog: {
        Row: {
          category: string;
          clearance_m: number;
          depth_m: number;
          height_m: number;
          id: string;
          license: string | null;
          model_key: string | null;
          name_ko: string;
          sort_order: number;
          width_m: number;
        };
        Insert: {
          category: string;
          clearance_m?: number;
          depth_m: number;
          height_m: number;
          id: string;
          license?: string | null;
          model_key?: string | null;
          name_ko: string;
          sort_order?: number;
          width_m: number;
        };
        Update: {
          category?: string;
          clearance_m?: number;
          depth_m?: number;
          height_m?: number;
          id?: string;
          license?: string | null;
          model_key?: string | null;
          name_ko?: string;
          sort_order?: number;
          width_m?: number;
        };
        Relationships: [];
      };
      jobs: {
        Row: {
          created_at: string;
          error: string | null;
          id: string;
          owner_id: string;
          progress: number;
          provider_task_id: string | null;
          result: Json | null;
          room_id: string | null;
          status: string;
          type: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          error?: string | null;
          id?: string;
          owner_id: string;
          progress?: number;
          provider_task_id?: string | null;
          result?: Json | null;
          room_id?: string | null;
          status?: string;
          type: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          error?: string | null;
          id?: string;
          owner_id?: string;
          progress?: number;
          provider_task_id?: string | null;
          result?: Json | null;
          room_id?: string | null;
          status?: string;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'jobs_room_id_fkey';
            columns: ['room_id'];
            isOneToOne: false;
            referencedRelation: 'rooms';
            referencedColumns: ['id'];
          },
        ];
      };
      layouts: {
        Row: {
          ai_summary: string | null;
          created_at: string;
          created_by: string;
          id: string;
          is_public: boolean;
          items: Json;
          name: string;
          owner_id: string;
          room_id: string;
          updated_at: string;
        };
        Insert: {
          ai_summary?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          is_public?: boolean;
          items?: Json;
          name?: string;
          owner_id?: string;
          room_id: string;
          updated_at?: string;
        };
        Update: {
          ai_summary?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          is_public?: boolean;
          items?: Json;
          name?: string;
          owner_id?: string;
          room_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'layouts_room_id_fkey';
            columns: ['room_id'];
            isOneToOne: false;
            referencedRelation: 'rooms';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          id: string;
          is_adult_confirmed: boolean;
          nickname: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          is_adult_confirmed?: boolean;
          nickname: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_adult_confirmed?: boolean;
          nickname?: string;
        };
        Relationships: [];
      };
      room_photos: {
        Row: {
          created_at: string;
          id: string;
          r2_key: string;
          room_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          r2_key: string;
          room_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          r2_key?: string;
          room_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'room_photos_room_id_fkey';
            columns: ['room_id'];
            isOneToOne: false;
            referencedRelation: 'rooms';
            referencedColumns: ['id'];
          },
        ];
      };
      room_reports: {
        Row: {
          created_at: string;
          id: string;
          model: string;
          report: Json;
          room_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          model: string;
          report: Json;
          room_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          model?: string;
          report?: Json;
          room_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'room_reports_room_id_fkey';
            columns: ['room_id'];
            isOneToOne: false;
            referencedRelation: 'rooms';
            referencedColumns: ['id'];
          },
        ];
      };
      rooms: {
        Row: {
          consent_at: string;
          created_at: string;
          description: string;
          floor_polygon: Json | null;
          id: string;
          is_public: boolean;
          openings: Json;
          owner_id: string;
          source: string;
          splat_bytes: number | null;
          splat_format: string | null;
          splat_key: string | null;
          status: string;
          title: string;
          transform: Json | null;
          updated_at: string;
        };
        Insert: {
          consent_at: string;
          created_at?: string;
          description?: string;
          floor_polygon?: Json | null;
          id?: string;
          is_public?: boolean;
          openings?: Json;
          owner_id?: string;
          source?: string;
          splat_bytes?: number | null;
          splat_format?: string | null;
          splat_key?: string | null;
          status?: string;
          title: string;
          transform?: Json | null;
          updated_at?: string;
        };
        Update: {
          consent_at?: string;
          created_at?: string;
          description?: string;
          floor_polygon?: Json | null;
          id?: string;
          is_public?: boolean;
          openings?: Json;
          owner_id?: string;
          source?: string;
          splat_bytes?: number | null;
          splat_format?: string | null;
          splat_key?: string | null;
          status?: string;
          title?: string;
          transform?: Json | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_furniture: {
        Row: {
          category: string;
          created_at: string;
          depth_m: number;
          height_m: number;
          id: string;
          model_key: string | null;
          name: string;
          owner_id: string;
          source: string;
          width_m: number;
        };
        Insert: {
          category?: string;
          created_at?: string;
          depth_m: number;
          height_m: number;
          id?: string;
          model_key?: string | null;
          name: string;
          owner_id?: string;
          source?: string;
          width_m: number;
        };
        Update: {
          category?: string;
          created_at?: string;
          depth_m?: number;
          height_m?: number;
          id?: string;
          model_key?: string | null;
          name?: string;
          owner_id?: string;
          source?: string;
          width_m?: number;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type PublicTables = Database['public']['Tables'];

/** 테이블 한 줄의 타입. 예: Tables<'rooms'> */
export type Tables<T extends keyof PublicTables> = PublicTables[T]['Row'];
export type TablesInsert<T extends keyof PublicTables> = PublicTables[T]['Insert'];
export type TablesUpdate<T extends keyof PublicTables> = PublicTables[T]['Update'];
