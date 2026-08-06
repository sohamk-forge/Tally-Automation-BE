-- supertokens_core user-data wipe, used 2026-08-06.
-- Scoped to USER DATA ONLY: accounts, sessions, tokens, role assignments.
-- Deliberately excludes apps/tenants/tenant_configs/key_value/
-- jwt_signing_keys/session_access_token_signing_keys/roles — those are
-- SuperTokens' own bootstrap/config tables; wiping them can break the
-- container's default tenant setup since it isn't guaranteed to
-- re-create them at runtime.
--
-- Backup used before this wipe:
--   backups/supertokens_core_backup_20260806_210511.dump
--
-- To restore:
--   PGPASSWORD='<pwd>' pg_restore -h 103.215.115.12 -p 5432 -U postgres -d tally_nonprod \
--     --schema=supertokens_core --clean --if-exists --no-owner --no-privileges \
--     backups/supertokens_core_backup_20260806_210511.dump

TRUNCATE TABLE
  supertokens_core.app_id_to_user_id,
  supertokens_core.all_auth_recipe_users,
  supertokens_core.user_last_active,
  supertokens_core.session_info,
  supertokens_core.emailpassword_users,
  supertokens_core.emailpassword_user_to_tenant,
  supertokens_core.emailverification_verified_emails,
  supertokens_core.passwordless_users,
  supertokens_core.passwordless_user_to_tenant,
  supertokens_core.user_roles,
  supertokens_core.activity_log
RESTART IDENTITY CASCADE;
