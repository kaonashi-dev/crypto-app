CREATE TYPE "public"."sweep_status" AS ENUM('planned', 'authorized', 'broadcast', 'confirmed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"asset" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"to_address" text NOT NULL,
	"via" text NOT NULL,
	"authorization_nonce" text,
	"valid_before" timestamp,
	"account_nonce" integer,
	"tx_hash" text,
	"block_number" bigint,
	"fee_raw" numeric(78, 0),
	"status" "sweep_status" DEFAULT 'planned' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sweeps_live_idx" ON "sweeps" USING btree ("network","address","asset") WHERE status in ('planned','authorized','broadcast');--> statement-breakpoint
CREATE UNIQUE INDEX "sweeps_auth_nonce_idx" ON "sweeps" USING btree ("network","authorization_nonce");--> statement-breakpoint
CREATE INDEX "sweeps_due_idx" ON "sweeps" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "sweeps_address_idx" ON "sweeps" USING btree ("network","address");