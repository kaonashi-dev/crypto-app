ALTER TABLE "deposits" ALTER COLUMN "amount_raw" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "amount_crypto_raw" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "confirmed_raw" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "confirmed_raw" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "pending_raw" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "pending_raw" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "overpaid_raw" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "overpaid_raw" SET DEFAULT 0;--> statement-breakpoint
--> Added nullable, backfilled, then tightened: a bare NOT NULL add fails on any
--> table that already holds a deposit. Every existing row can only be its
--> payment's asset — until this migration each network offered exactly one
--> token, so there was nothing else a deposit could have been.
ALTER TABLE "deposits" ADD COLUMN "asset" text;--> statement-breakpoint
UPDATE "deposits" AS d SET "asset" = p."asset" FROM "payments" AS p WHERE p."id" = d."payment_id" AND d."asset" IS NULL;--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "asset" SET NOT NULL;