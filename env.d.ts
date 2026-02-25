declare namespace NodeJS {
  interface ProcessEnv {
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    PROFILE_ID?: string;
    CRON_SECRET?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_FROM_PHONE?: string;
    OPENAI_API_KEY?: string;
    GOOGLE_MAPS_API_KEY?: string;
  }
}
