# CutMuck

Kick kanallarını takip et, VOD / klip / canlı kes, efekt uygula, YouTube’a yükle.

- **apps/web** — Next.js UI  
- **apps/worker** — FastAPI (Streamlink, FFmpeg, YouTube, canlı DVR)

Repo: https://github.com/tab2can/CutMuck

---

## Linux — tek komut kurulum (HTTPS + otomatik güncelleme)

Sunucuda (Ubuntu/Debian önerilir), domain A kaydı sunucu IP’sine gelsin, **80/443** açık olsun:

```bash
curl -fsSL https://raw.githubusercontent.com/tab2can/CutMuck/main/scripts/install.sh | sudo bash
```

Ortam değişkenleriyle (interaktif sormadan):

```bash
sudo CUTMUCK_DOMAIN=cut.example.com CUTMUCK_EMAIL=you@example.com \
  bash -c 'curl -fsSL https://raw.githubusercontent.com/tab2can/CutMuck/main/scripts/install.sh | bash'
```

Kurulum şunları yapar:

1. Docker (+ Compose) kurar  
2. Repoyu `/opt/cutmuck` altına klonlar  
3. **Caddy** ile Let’s Encrypt SSL alır  
4. Web + worker container’ları ayağa kaldırır  
5. **Günlük otomatik güncelleme** timer’ı ekler (`cutmuck-update.timer`)

Manuel güncelleme:

```bash
sudo cutmuck-update
```

YouTube OAuth redirect URI (Ayarlar’da Google Cloud’a ekleyin):

```text
https://YOUR_DOMAIN/api/auth/login/callback
https://YOUR_DOMAIN/api/auth/youtube/callback
```

İlk giriş: `ADMIN_EMAIL` (varsayılan `can@pekgezer.com`) Google hesabı ile. Diğer kullanıcıları Ayarlar → İzinli kullanıcılar’dan ekleyin.

---

## Windows — geliştirme

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1
```

- UI: http://localhost:3000  
- Worker: http://127.0.0.1:8787/health  

## Yerel Docker (SSL yok)

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

---

## Ortam değişkenleri (`.env`)

| Değişken | Açıklama |
|----------|----------|
| `CUTMUCK_DOMAIN` | HTTPS domain (zorunlu, prod) |
| `CUTMUCK_EMAIL` | Let’s Encrypt e-posta |
| `GOOGLE_CLIENT_ID` | Google OAuth Web client ID (giriş) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SESSION_SECRET` | Oturum çerezi imza anahtarı |
| `ADMIN_EMAIL` | Yönetici Google e-postası (varsayılan `can@pekgezer.com`) |
| `CUTMUCK_HOME` | Kurulum dizini (varsayılan `/opt/cutmuck`) |
| `CUTMUCK_BRANCH` | Takip edilen dal (`main`) |

---

## API özeti (worker)

| Method | Path | Açıklama |
|--------|------|----------|
| GET/PUT | `/settings` | Kullanıcıya özel tema + YouTube kimlik |
| GET/POST/DELETE | `/channels` | Kanallar |
| POST | `/jobs/open-live` | Canlı + DVR |
| POST | `/jobs/{id}/youtube` | Export + upload (oturum sahibinin YouTube’u) |
| GET | `/auth/youtube/start` | OAuth |

---

## Notlar

- Prod’da worker dışarı açık değildir; trafik Caddy → Next.js / API → worker.  
- YouTube Client ID/Secret ve OAuth token’ları kullanıcıya özeldir (paylaşılan ayar yok).  
- Kapak yükleme için YouTube kanalının doğrulanmış olması gerekir.  
- Sürüm: `VERSION` dosyası.
