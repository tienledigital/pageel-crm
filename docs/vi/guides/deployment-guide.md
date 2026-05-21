# Hướng dẫn Triển khai Hệ thống (Deployment Guide)

> **Dự án:** pageel-crm
> **Tài liệu:** docs/guides/deployment-guide.md
> **Hạ tầng triển khai:** Cloudflare Pages & Cloudflare D1

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

Các biến bí mật (Secrets) cần được mã hóa an toàn trên hạ tầng của Cloudflare và **tuyệt đối không đưa vào mã nguồn**.

### Bước 1: Khởi tạo các biến Secrets trên Cloudflare
Chạy các lệnh sau tại thư mục `repo/` để thiết lập:

1. **JWT_SECRET** (Khóa dùng để ký mã hóa Cookie Session. Yêu cầu tối thiểu 32 ký tự ngẫu nhiên):
   *Bạn có thể tạo nhanh chuỗi ngẫu nhiên bằng lệnh:*
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   *Sau đó nạp vào Cloudflare:*
   ```bash
   npx wrangler secret put JWT_SECRET
   ```

2. **Tài khoản quản trị viên (Admin) ban đầu:**
   ```bash
   # Tên tài khoản Admin khởi tạo (Mặc định nếu bỏ qua: admin)
   npx wrangler secret put INITIAL_ADMIN_USERNAME
   
   # Mật khẩu tài khoản Admin khởi tạo (Mặc định nếu bỏ qua: admin123)
   npx wrangler secret put INITIAL_ADMIN_PASSWORD
   ```

### ⚠️ Lưu ý quan trọng về cơ chế Tự động Khởi tạo (Auto-Seed)
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

> [!IMPORTANT]
> Sau khi đăng nhập thành công lần đầu và tài khoản admin đã được lưu an toàn vào Database D1, bạn nên gỡ bỏ các biến `INITIAL_ADMIN_*` trên Cloudflare Dashboard (hoặc dùng lệnh `npx wrangler secret delete [TÊN_BIẾN]`) để đảm bảo an toàn bảo mật tối đa. Cổng đăng nhập sẽ chỉ sử dụng tài khoản được lưu trong Database.

---

## 🚀 5. Triển khai ứng dụng (Deployment)

Sau khi đã hoàn tất build và chuẩn bị tài nguyên, chạy các lệnh sau để deploy ứng dụng lên Cloudflare Workers:

### Bước 1: Build ứng dụng cục bộ
```bash
npm run build
```

### Bước 2: Deploy ứng dụng lên Cloudflare Workers
```bash
npx wrangler deploy
```
Sau khi hoàn tất, Wrangler sẽ cung cấp URL chạy live của bạn (ví dụ: `https://pageel-crm.your-subdomain.workers.dev`).
Các liên kết tài nguyên D1, KV và Assets tĩnh sẽ tự động được ánh xạ dựa trên cấu hình tệp `wrangler.jsonc`.
