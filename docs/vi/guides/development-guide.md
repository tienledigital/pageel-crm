# Hướng dẫn Thiết lập & Phát triển (Development Guide)

<!-- ⚠️ SOURCE-VERIFIED — Đã đối chiếu với package.json, wrangler.jsonc, src/lib/db.ts ngày 2026-05-28 -->

> **Dự án:** pageel-crm
> **Tài liệu:** docs/vi/guides/development-guide.md
> **Phiên bản:** v0.8.1
> **Ngày cập nhật:** 2026-05-28

---

## 🚀 1. Thiết lập Môi trường & Cài đặt

Để bắt đầu chạy dự án phát triển cục bộ, đảm bảo bạn đã cài đặt **Node.js (phiên bản v22 trở lên)**.

### Bước 1: Cài đặt Dependencies
1. Di chuyển vào thư mục chứa mã nguồn:
   ```bash
   cd repo
   ```
2. Cài đặt các gói phụ thuộc:
   ```bash
   npm install
   ```

### Bước 2: Thiết lập Database D1 cục bộ & Chạy Migrations
Hệ thống sử dụng **Cloudflare D1** giả lập ở môi trường local. Bạn cần đồng bộ cấu hình bảng trước khi khởi chạy dev server:
1. Áp dụng migrations Drizzle vào cơ sở dữ liệu D1 giả lập (Miniflare):
   ```bash
   npx wrangler d1 migrations apply pageel-crm-db --local
   ```
   *Lưu ý:* Gõ `y` và nhấn Enter khi Wrangler yêu cầu xác nhận thực thi.

### Bước 3: Chạy Dev Server
*   Khởi chạy server phát triển cục bộ với mock D1 binding:
     ```bash
     npm run dev
     ```
*   Truy cập ứng dụng tại: [http://localhost:4321](http://localhost:4321)

### Bước 4: Đăng nhập lần đầu (Auto-Seed)
Khi truy cập trang đăng nhập lần đầu tiên trên local, cơ chế **Auto-Seed** sẽ tự động tạo tài khoản quản trị mặc định nếu bảng `users` trống:
*   **Tên đăng nhập (Username):** `admin`
*   **Mật khẩu (Password):** `admin123`
*   **Quyền hạn (Role):** `admin`

### Bước 5: Thiết lập SePay API Token (Local Sync)
Để chạy thử nghiệm tính năng chủ động quét cập nhật từ SePay trên môi trường phát triển cục bộ (Local), hãy tạo tệp tin `.dev.vars` trong thư mục `repo/` và khai báo Token của bạn:
```env
SEPAY_API_TOKEN=your_sepay_api_token_here
```
*(Lưu ý: Tệp `.dev.vars` chứa các biến môi trường bí mật cho local dev, đã được ghi nhận trong `.gitignore` để tránh bị lộ).*

---

## 🧪 2. Chạy Kiểm thử (Unit Tests)

Chúng ta sử dụng **Vitest** làm framework kiểm thử chính và **Better-SQLite3** để khởi chạy cơ sở dữ liệu SQLite in-memory siêu tốc khi chạy test cục bộ.

- Chạy toàn bộ test suite một lần duy nhất (One-shot mode):
  ```bash
  npx vitest run
  ```
- Chạy test ở chế độ theo dõi thay đổi (Watch mode):
  ```bash
  npx vitest
  ```

### 2.2. Kiểm thử Sao lưu Thủ công (Manual Backup Test)

Để kiểm tra tính hợp lệ của kết nối GitHub API và cơ chế sao lưu từ môi trường phát triển cục bộ (local) mà không cần khởi chạy toàn bộ server Astro, bạn có thể chạy script kiểm thử thủ công:

1. Đảm bảo cấu hình repo và token GitHub Backup của bạn đã được khai báo chính xác trong tệp `.dev.vars`.
2. Chạy script kiểm thử bằng Node:
   ```bash
   npx tsx scripts/test-backup-manual.ts
   ```

Script này sẽ tự động nạp các biến môi trường từ `.dev.vars` (thông qua hàm trợ giúp `loadDevVars`), khởi tạo một payload JSON mẫu và thử đẩy tệp tin này lên repository GitHub được cấu hình.

---

## 📐 3. Cơ chế Hoạt động Cơ sở Dữ liệu

Kiến trúc Database được xây dựng bằng **Drizzle ORM** và định tuyến thông qua bộ **DB Client Router**:

1.  **Môi trường Kiểm thử (`process.env.NODE_ENV === 'test'`):**
    - Router tự động chuyển hướng kết nối tới **in-memory SQLite** (sử dụng `better-sqlite3`).
    - Dữ liệu hoàn toàn độc lập, tự động xóa sạch khi kết thúc phiên test, không sinh file rác.
2.  **Môi trường Sản phẩm (Cloudflare Workers):**
    - Astro v6 loại bỏ `Astro.locals.runtime.env`. Router kết nối trực tiếp với cơ sở dữ liệu **Cloudflare D1** bằng cách import `env` từ `cloudflare:workers` và truyền vào hàm khởi tạo: `getDb(env)`.
3.  **Local Development Fallback:**
    - Nếu không có binding D1 và không ở chế độ test, hệ thống tự tạo tệp tin SQLite cục bộ có tên `local.db` để lập trình viên phát triển trực tiếp.

---

## 📝 4. Quy tắc Đóng góp và Phát triển

- **English-First cho Mã nguồn:** Toàn bộ tên biến, tên hàm, class, comment trong code và **Git commit messages** bắt buộc phải viết bằng Tiếng Anh (English) để chuẩn bị cho việc phát hành mã nguồn mở quốc tế.
- **Tài liệu nội bộ:** Các tài liệu hướng dẫn và đặc tả kỹ thuật nội bộ trong thư mục `docs/` được viết bằng Tiếng Việt để tối ưu trải nghiệm đọc hiểu của lập trình viên trong nước.
- **TDD (Test-Driven Development):** Luôn viết test case fail trước khi triển khai bất kỳ tính năng hay sửa lỗi nào trong code.
- **Quality Gates:** Trước khi commit hoặc tạo PR, hãy chạy các lệnh sau để đảm bảo chất lượng:
  - TypeScript build thành công: `npm run build`
  - Unit test đạt 100% màu xanh: `npx vitest run`
