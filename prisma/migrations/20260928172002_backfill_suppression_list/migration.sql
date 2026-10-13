-- Backfill: contactos já em opt-out passam a constar da suppression list local.
INSERT INTO "SuppressionEntry" ("id", "phoneE164", "source", "createdAt")
SELECT 'bf_' || md5("phoneE164"), "phoneE164", 'backfill', COALESCE("optedOutAt", CURRENT_TIMESTAMP)
FROM "Contact"
WHERE "consentStatus" = 'OPTED_OUT' OR "optedOutAt" IS NOT NULL
ON CONFLICT ("phoneE164") DO NOTHING;
