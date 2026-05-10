# Wallet Service

سرویس HD wallet برای **BTC / ETH / TRON / USDT** با پنل ادمین، batch generation، balance checker و مدیریت API keys.

## امکانات

- ✅ ولت ۱۲/۲۴ کلمه سازگار با Trust Wallet و MetaMask
- ✅ HD derivation استاندارد (BIP-84/44)
- ✅ AES-256-GCM encryption برای mnemonic
- ✅ پنل ادمین کامل
- ✅ Batch generation با BullMQ
- ✅ Balance checker با Multicall3 و Redis cache
- ✅ مدیریت API keys از پنل با rotation خودکار
- ✅ Auto-cleanup ولت‌های بدون موجودی (۱۰ ثانیه پس از تولید)

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
│   └── credentials-service.ts
├── auth/
├── balance/
├── queue/
├── api/routes/
│   ├── auth.ts
│   ├── wallets.ts
│   ├── jobs.ts
│   └── credentials.ts
└── db/
    └── migrations/
        ├── 002_admins.sql
        └── 003_api_credentials.sql
```

## صفحات پنل

1. **📊 داشبورد** — آمار کلی
2. **💰 ولت‌ها** — ولت‌های واقعی سیستم
3. **⚙️ Jobs** — batch generation
4. **🔐 API Keys** — مدیریت RPC/API keys
5. **🔑 تغییر رمز**

## امنیت

- Mnemonic و API keys با AES-256-GCM
- bcrypt cost 12 برای رمز ادمین
- JWT تو httpOnly cookie
- Lockout بعد از ۵ تلاش ناموفق
- Audit log کامل

## License

MIT
