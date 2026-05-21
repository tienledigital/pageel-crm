# Hướng dẫn Triển khai Hệ thống (Deployment Guide)

> **Dự án:** pageel-crm
> **Tài liệu:** docs/guides/deployment-guide.md
> **Phiên bản:** 0.4.1
> **Ngày cập nhật:** 2026-05-21
> **Hạ tầng triển khai:** Cloudflare Workers (Astro Hybrid SSR) & Cloudflare D1 & Cloudflare KV

---

## 📋 1. Chuẩn bị trước khi triển khai
Để chạy dự án trên môi trường Production, bạn cần chuẩn bị:
1. Một tài khoản [Cloudflare](https://dash.cloudflare.com/) đã kích hoạt.
2. Đã cài đặt [Node.js](https://nodejs.org/) v22+ và đã cấu hình xác thực Wrangler CLI cục bộ bằng lệnh:
   ```bash
   npx wrangler login
   ```

---

## 🗄️ 2. Cấu hình Tài nguyên Cloudflare (Production)

### Bước 1: Khởi tạo database D1 trên Cloudflare
Chạy lệnh sau tại thư mục `repo` để tạo cơ sở dữ liệu D1 mới trên tài khoản Cloudflare của bạn:
```bash
npx wrangler d1 create pageel-crm-db
```
Hệ thống sẽ trả về thông tin cấu hình chứa `database_id` của bạn.

### Bước 2: Khởi tạo KV Namespace cho Sessions
Chạy lệnh sau để tạo KV Namespace lưu trữ phiên đăng nhập:
```bash
npx wrangler kv namespace create SESSION
```
Hệ thống sẽ trả về thông tin cấu hình chứa `id` của KV Namespace.

### Bước 3: Cập nhật cấu hình wrangler.jsonc (Chạy Local/Private)
Mở tệp `repo/wrangler.jsonc` và cập nhật các ID thật của bạn:
```json
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "pageel-crm-db",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "SESSION",
      "id": "YOUR_KV_NAMESPACE_ID"
    }
  ]
```

### Bước 4: Áp dụng DB Migrations lên Production (Remote)
Áp dụng cấu hình bảng từ thư mục `drizzle` lên Cloudflare D1 trên môi trường cloud:
```bash
npx wrangler d1 migrations apply pageel-crm-db --remote
```
*Lưu ý:* Xác nhận `y` khi Wrangler yêu cầu xác nhận.

---

## 🔒 3. Nguyên tắc Bảo mật đối với Dự án OSS & Vận hành thực tế

Do `pageel-crm` vừa là dự án mã nguồn mở (OSS) vừa được dùng để vận hành dịch vụ thực tế có dữ liệu thật, bạn cần tuân thủ quy trình quản lý mã nguồn sau để bảo mật tài nguyên:

### Quy tắc commit tệp cấu hình:
- **Trên Repository OSS công cộng:** Tệp `wrangler.jsonc` luôn để ID ở dạng placeholder (`00000000-0000-0000-0000-000000000000`) để cộng đồng sử dụng an toàn và chạy CI/CD thành công. Tuyệt đối không đẩy ID thật lên repo công cộng.
- **Dữ liệu nhạy cảm & script chuyển đổi:** Đưa các tệp tin chứa dữ liệu thật hoặc kịch bản migration dữ liệu cũ vào `.gitignore`.

### Mô hình Upstream-Origin Git Workflow (Khuyên dùng):
Để vận hành tự động và an toàn, bạn nên tạo một repository **Private** riêng để deploy:
1. Đặt tên remote `upstream` cho Repo OSS Public và `origin` cho Repo Private của bạn.
2. Commit `wrangler.jsonc` chứa ID thật lên Repo Private của bạn để chạy deploy tự động.
3. Đồng bộ tính năng mới từ OSS Public bằng cách chạy:
   ```bash
   git checkout main
   git pull upstream main
   git push origin main
   ```

---

## ⚙️ 4. Thiết lập Biến Môi trường và Mật khẩu bí mật (Secrets)

Các biến bí mật (Secrets) cần được mã hóa an toàn trên hạ tầng của Cloudflare bằng công cụ Wrangler CLI. Nếu bạn chạy deploy và quản lý Worker dưới một tên cụ thể (ví dụ ví dụ: `pageel-crm`), bạn nên thêm flag `--name pageel-crm` vào sau mỗi lệnh.

### Nhóm 1: Xác thực & Quản trị hệ thống

1. **SESSION_SECRET** (Khóa bí mật dùng để ký và giải mã Cookie phiên đăng nhập. Yêu cầu tối thiểu 32 ký tự ngẫu nhiên):
   *Bạn có thể tạo nhanh chuỗi ngẫu nhiên bằng lệnh:*
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   *Sau đó nạp vào Cloudflare:*
   ```bash
   npx wrangler secret put SESSION_SECRET --name pageel-crm
   ```

2. **Tài khoản quản trị viên (Admin) ban đầu:**
   ```bash
   # Tên tài khoản Admin khởi tạo (Mặc định nếu bỏ qua: admin)
   npx wrangler secret put INITIAL_ADMIN_USERNAME --name pageel-crm
   
   # Mật khẩu tài khoản Admin khởi tạo (Mặc định nếu bỏ qua: admin123)
   npx wrangler secret put INITIAL_ADMIN_PASSWORD --name pageel-crm
   ```

### Nhóm 2: Tích hợp Cổng thanh toán (SePay Webhook)

Để đối soát tiền tự động qua SePay, bạn cần cài đặt khóa bí mật nhằm kiểm tra chữ ký chữ ký số webhook được gửi tới hệ thống:
```bash
# Token xác thực webhook được thiết lập trên SePay Dashboard (Header Authorization: Apikey <secret>)
npx wrangler secret put SEPAY_WEBHOOK_SECRET --name pageel-crm
```

### Nhóm 3: Tự động Sao lưu Cơ sở dữ liệu (GitHub Backup Engine)

Để hệ thống định kỳ (hoặc kích hoạt thủ công) xuất toàn bộ dữ liệu database JSON và đẩy thẳng lên repository GitHub riêng tư làm nơi sao lưu an toàn:

1. **GITHUB_BACKUP_TOKEN** (Personal Access Token của GitHub, quyền Contents: Read & Write):
   ```bash
   npx wrangler secret put GITHUB_BACKUP_TOKEN --name pageel-crm
   ```
2. **GITHUB_BACKUP_OWNER** (Tên tài khoản hoặc tên Organization sở hữu repo backup):
   ```bash
   npx wrangler secret put GITHUB_BACKUP_OWNER --name pageel-crm
   ```
3. **GITHUB_BACKUP_REPO** (Tên repository GitHub được dùng để chứa các bản sao lưu):
   ```bash
   npx wrangler secret put GITHUB_BACKUP_REPO --name pageel-crm
   ```
4. **GITHUB_BACKUP_BRANCH** (Tên nhánh đích muốn đẩy dữ liệu lên, ví dụ: `main`):
   ```bash
   npx wrangler secret put GITHUB_BACKUP_BRANCH --name pageel-crm
   ```

---

## ⚠️ 5. Lưu ý quan trọng về cơ chế Tự động Khởi tạo (Auto-Seed)
- **Cơ chế hoạt động:** Hệ thống chỉ thực hiện quét và tự động tạo tài khoản Admin từ biến Secrets **khi bảng người dùng (`users`) trong Database trống hoàn toàn** (ngay sau khi bạn triển khai và truy cập hệ thống lần đầu).
- **Tránh bẫy đăng nhập:** 
  - Nếu bạn truy cập vào trang đăng nhập **trước** khi thiết lập các biến Secrets trên, hệ thống sẽ tự động tạo tài khoản mặc định `admin` / `admin123`.
  - Khi đó, dù sau đó bạn có nạp Secrets mới thế nào đi nữa, hệ thống cũng **không áp dụng** (vì database đã có tài khoản cũ và không còn trống).
- **Cách xử lý sự cố (Nếu lỡ tạo tài khoản mặc định):**
  Bạn cần chạy lệnh sau để xóa trắng bảng users trên Cloudflare D1:
  ```bash
  npx wrangler d1 execute pageel-crm-db --remote --command "DELETE FROM users"
  ```
  Sau đó, refresh lại trang login và đăng nhập lại bằng thông tin tài khoản mới từ Secrets.

---

## 🚀 6. Triển khai ứng dụng (Deployment)

Sau khi đã hoàn tất build và chuẩn bị tài nguyên, chạy các lệnh sau để deploy ứng dụng lên Cloudflare Workers:

### Bước 1: Build ứng dụng cục bộ
```bash
npm run build
```

### Bước 2: Deploy ứng dụng lên Cloudflare Workers
```bash
npx wrangler deploy --name pageel-crm
```
Sau khi hoàn tất, Wrangler sẽ cung cấp URL chạy live của bạn (ví dụ: `https://pageel-crm.your-subdomain.workers.dev`).
Các liên kết tài nguyên D1, KV và Assets tĩnh sẽ tự động được ánh xạ dựa trên cấu hình tệp `wrangler.jsonc`.
