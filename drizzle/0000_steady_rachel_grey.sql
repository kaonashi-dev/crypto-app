CREATE TYPE "public"."payment_status" AS ENUM('pending', 'detecting', 'partially_paid', 'paid', 'expired', 'underpaid_expired');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"webhook_url" text,
	"webhook_secret" text NOT NULL,
	"balance_cop" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"network" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"from_address" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hd_counter" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"next_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"payment_id" uuid,
	"amount_cop" bigint NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"amount_cop" bigint NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"amount_crypto_raw" bigint NOT NULL,
	"rate_cop_per_unit_e6" bigint NOT NULL,
	"address" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"confirmed_raw" bigint DEFAULT 0 NOT NULL,
	"pending_raw" bigint DEFAULT 0 NOT NULL,
	"overpaid_raw" bigint DEFAULT 0 NOT NULL,
	"quote_expires_at" timestamp NOT NULL,
	"grace_expires_at" timestamp,
	"paid_at" timestamp,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_api_key_hash_idx" ON "clients" USING btree ("api_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_tx_log_idx" ON "deposits" USING btree ("network","tx_hash","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_public_id_idx" ON "payments" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_address_network_idx" ON "payments" USING btree ("address","network");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_jobs_pending_idx" ON "webhook_jobs" USING btree ("delivered_at","next_attempt_at");