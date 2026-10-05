CREATE TABLE "notification_logs" (
  "id"         TEXT        NOT NULL,
  "event_type" TEXT        NOT NULL,
  "channel"    TEXT        NOT NULL,
  "success"    BOOLEAN     NOT NULL,
  "error"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);
