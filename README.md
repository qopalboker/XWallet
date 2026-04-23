# Wallet Service

سرویس HD wallet برای **BTC / ETH / TRON / USDT** با پنل ادمین، batch generation، balance checker، مدیریت API keys، و ابزار آموزشی Benchmark.

## امکانات

- ✅ ولت ۱۲/۲۴ کلمه سازگار با Trust Wallet و MetaMask
- ✅ HD derivation استاندارد (BIP-84/44)
- ✅ AES-256-GCM encryption برای mnemonic
- ✅ پنل ادمین کامل
- ✅ Batch generation با BullMQ
- ✅ Balance checker با Multicall3 و Redis cache
- ✅ مدیریت API keys از پنل با rotation خودکار
- ✅ **Benchmark Mode** — ابزار آموزشی یک‌بار مصرف (حداکثر ۱۰۰,۰۰۰ تست)

## Benchmark Mode

یه ابزار آموزشی که نشون می‌ده **brute-force کردن ولت ریاضیاً غیرممکنه**.

**چطور کار می‌کنه:**
1. تو پنل برو به **🎓 Benchmark**
2. تعداد mnemonic (حداکثر ۱۰۰,۰۰۰)، chain‌ها، و word count رو انتخاب کن
3. روی **▶ Start Benchmark** کلیک کن
4. سیستم mnemonic random می‌سازه، آدرس derive می‌کنه، موجودی چک می‌کنه
5. در پایان گزارش می‌ده: سرعت، تعداد، احتمال موفقیت

**محدودیت‌های مهم:**
- حداکثر `MAX_TARGET = 100,000` (hardcoded، قابل تغییر نیست)
- mnemonic‌ها هرگز ذخیره نمی‌شن (فقط تو RAM موقع چک)
- اگه hit شد (احتمال ≈ 10^-34)، فقط آدرس و موجودی ثبت می‌شه، mnemonic نه
- هم‌زمان فقط یه run می‌تونه اجرا بشه
- هیچ قابلیت برداشت یا signing وجود نداره — فقط read-only

این ابزار برای یادگیری کار می‌کنه، نه کاربرد عملی.

## راه‌اندازی

```bash
npm install
cp .env.example .env

# تولید کلیدها
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# → WALLET_MASTER_KEY و JWT_SECRET رو تو .env بذار

docker compose up -d
npm run seed:admin

npm run dev        # API
npm run worker     # Worker (تو ترمینال دوم)
```

http://localhost:3000 → `admin` / `1590320` → تغییر رمز اجباری

## ساختار

```
src/
├── crypto/aes.ts
├── wallet/derivation.ts
├── services/
│   ├── wallet-service.ts
│   ├── credentials-service.ts
│   └── benchmark-service.ts
├── auth/
├── balance/
├── queue/
├── api/routes/
│   ├── auth.ts
│   ├── wallets.ts
│   ├── jobs.ts
│   ├── credentials.ts
│   └── benchmark.ts
└── db/
    └── migrations/
        ├── 002_admins.sql
        ├── 003_api_credentials.sql
        └── 004_benchmark.sql
```

## صفحات پنل

1. **📊 داشبورد** — آمار کلی
2. **💰 ولت‌ها** — ولت‌های واقعی سیستم
3. **⚙️ Jobs** — batch generation
4. **🎓 Benchmark** — ابزار آموزشی
5. **🔐 API Keys** — مدیریت RPC/API keys
6. **🔑 تغییر رمز**

## امنیت

- Mnemonic و API keys با AES-256-GCM
- bcrypt cost 12 برای رمز ادمین
- JWT تو httpOnly cookie
- Lockout بعد از ۵ تلاش ناموفق
- Audit log کامل

## License

MIT
