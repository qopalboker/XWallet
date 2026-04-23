-- ═══════════════════════════════════════════════════════════════════════
-- Educational Benchmark Mode
--
-- هدف: نشون دادن اینکه brute-force ولت ریاضیاً غیرممکنه.
-- هر run یه تعداد mnemonic random می‌سازه، موجودی چک می‌کنه، آمار می‌ده.
--
-- مهم: برای try های بی‌اثر (اکثریت مطلق) چیزی ذخیره نمی‌شه. فقط اگه یه
-- آدرس موجودی/history داشت، آدرس+موجودی+mnemonic متناظر در hits_info ثبت
-- می‌شه تا اپراتور بتونه ولت پیداشده رو recover کنه.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE benchmark_runs (
    id                  BIGSERIAL    PRIMARY KEY,

    -- Config
    word_count          SMALLINT     NOT NULL,
    addresses_per_mnemonic SMALLINT  NOT NULL,
    target_count        INTEGER      NOT NULL,       -- هدف (حداکثر 100000)
    chains              VARCHAR[]    NOT NULL,       -- ['BTC', 'ETH', 'TRON']

    -- Progress
    checked_count       INTEGER      NOT NULL DEFAULT 0,
    hit_count           INTEGER      NOT NULL DEFAULT 0,  -- اگه چیزی پیدا شد (نمی‌شه)

    -- اگه hit شد: آدرس و موجودی و mnemonic متناظر
    hits_info           JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- نمونه: [{"chain":"ETH", "address":"0x...", "native":"1000", "usdt":"0",
    --         "mnemonic":"abandon abandon ..."}]

    -- Timing
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'stopped', 'failed')),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    duration_ms         BIGINT,

    -- سرعت (updates هر چند batch)
    avg_rate_per_sec    NUMERIC(10, 2),

    started_by          BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
    error               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_benchmark_runs_status ON benchmark_runs(status, started_at DESC);
CREATE INDEX idx_benchmark_runs_created ON benchmark_runs(created_at DESC);
