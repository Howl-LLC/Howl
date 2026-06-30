-- Self-roles: per-entry custom icon URL (Pro-tier feature). Sits alongside
-- the existing emoji column; renderers prefer iconUrl when both are set.
ALTER TABLE "RolePickerEntry" ADD COLUMN "iconUrl" VARCHAR(2048);
