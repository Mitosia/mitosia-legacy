-- Dev-only bootstrap, runs on first container start (fresh volume).
-- The app must NOT connect as the compose POSTGRES_USER: that user is a
-- Postgres superuser and superusers bypass Row Level Security entirely.
-- The app connects as mitosia_app (non-superuser); migrations run as the
-- owner via MIGRATE_DATABASE_URL.

CREATE ROLE mitosia_app LOGIN PASSWORD 'mitosia_app';
GRANT CONNECT ON DATABASE mitosia TO mitosia_app;
GRANT USAGE ON SCHEMA public TO mitosia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mitosia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mitosia_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mitosia IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mitosia_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mitosia IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mitosia_app;
