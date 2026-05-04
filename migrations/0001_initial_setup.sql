CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE queue_status AS ENUM ('pending', 'active', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'queue_channel',
  status queue_status NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  queue_id_type text;
BEGIN
  SELECT data_type
  INTO queue_id_type
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'queue'
    AND column_name = 'id';

  IF queue_id_type IS NOT NULL AND queue_id_type <> 'uuid' THEN
    ALTER TABLE queue ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE queue ALTER COLUMN id TYPE uuid USING gen_random_uuid();
    ALTER TABLE queue ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'queue'
      AND column_name = 'channel'
  ) THEN
    ALTER TABLE queue ADD COLUMN channel text NOT NULL DEFAULT 'queue_channel';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'queue'
      AND column_name = 'run_at'
  ) THEN
    ALTER TABLE queue ADD COLUMN run_at timestamptz NOT NULL DEFAULT now();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'queue'
      AND column_name = 'attempts'
  ) THEN
    ALTER TABLE queue ADD COLUMN attempts integer NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'queue'
      AND column_name = 'max_attempts'
  ) THEN
    ALTER TABLE queue ADD COLUMN max_attempts integer NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'queue'
      AND column_name = 'retry_after'
  ) THEN
    ALTER TABLE queue ADD COLUMN retry_after timestamptz;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS active_listeners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regprocedure('uuidv7()') IS NOT NULL THEN
    ALTER TABLE active_listeners
      ALTER COLUMN id SET DEFAULT uuidv7();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'queue_attempts_non_negative'
      AND conrelid = 'queue'::regclass
  ) THEN
    ALTER TABLE queue
      ADD CONSTRAINT queue_attempts_non_negative CHECK (attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'queue_max_attempts_positive'
      AND conrelid = 'queue'::regclass
  ) THEN
    ALTER TABLE queue
      ADD CONSTRAINT queue_max_attempts_positive CHECK (max_attempts >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_queue_channel_pending
  ON queue (channel, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_queue_channel_pending_run_at
  ON queue (channel, run_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_queue_channel_pending_ready_at
  ON queue (channel, run_at, retry_after, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_broadcasts_channel
  ON broadcasts (channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_active_listeners_channel_last_seen
  ON active_listeners (channel, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_active_listeners_last_seen
  ON active_listeners (last_seen_at);

DO $$
BEGIN
  IF to_regclass('idx_queue_pending') IS NOT NULL THEN
    DROP INDEX idx_queue_pending;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION notify_queue_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(NEW.channel, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notify_broadcast_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(NEW.channel || '_broadcast', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'queue_notify'
      AND tgrelid = 'queue'::regclass
      AND NOT tgisinternal
  ) THEN
    DROP TRIGGER queue_notify ON queue;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'broadcast_notify'
      AND tgrelid = 'broadcasts'::regclass
      AND NOT tgisinternal
  ) THEN
    DROP TRIGGER broadcast_notify ON broadcasts;
  END IF;
END $$;

CREATE TRIGGER queue_notify
AFTER INSERT ON queue
FOR EACH ROW
EXECUTE FUNCTION notify_queue_insert();

CREATE TRIGGER broadcast_notify
AFTER INSERT ON broadcasts
FOR EACH ROW
EXECUTE FUNCTION notify_broadcast_insert();
