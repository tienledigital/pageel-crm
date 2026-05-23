<div align="center">
  <a href="https://pageel.com">
    <img src="https://raw.githubusercontent.com/pageel/pageel-cms/main/.github/assets/pageel-icon.svg" width="120" alt="Pageel CRM">
  </a>

  <h1>Pageel CRM</h1>

  <p><strong>Hệ thống CRM tối giản, siêu tốc và đối soát dòng tiền tự động chạy trên Astro, SQLite và Cloudflare D1</strong></p>
  <p>Bộ máy quản lý tài chính và hóa đơn tự vận hành tối ưu cho hộ kinh doanh Việt Nam.</p>

  [![License](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
  [![Version](https://img.shields.io/badge/Version-v0.4.1-blue.svg)](../../CHANGELOG.md)
  ![Status](https://img.shields.io/badge/Status-Beta-orange.svg)
  [![Built with Astro](https://img.shields.io/badge/Built%20with-Astro-BC52EE.svg?logo=astro&logoColor=white)](https://astro.build)

  <br />

  <a href="../../README.md">🇺🇸 <b>English</b></a> | <a href="README.md">🇻🇳 <b>Tiếng Việt</b></a>
</div>

<br/>

## Mục lục
- [Giới thiệu](#giới-thiệu)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Công nghệ sử dụng](#công-nghệ-sử-dụng)
- [Khởi chạy nhanh](#khởi-chạy-nhanh)
- [Triển khai hệ thống](#triển-khai-hệ-thống)
- [Kiến trúc Cơ sở Dữ liệu](#kiến-trúc-cơ-sở-dữ-liệu)
- [Giấy phép](#giấy-phép)

---

## 🎯 Giới thiệu

**Pageel CRM** là một giải pháp tự lưu trữ (self-hosted), CRM siêu nhẹ và bộ máy quản lý hóa đơn tự động dành cho các hộ kinh doanh cá thể (HKD) và doanh nghiệp nhỏ tại Việt Nam. Dự án vận hành trực tiếp trên hạ tầng Edge của Cloudflare Workers, giúp triệt tiêu hoàn toàn chi phí thuê server và đảm bảo hiệu năng truy cập tối đa.

---

## ✨ Tính năng nổi bật

- **Đối soát dòng tiền tự động:** Đồng bộ và khớp giao dịch ngân hàng theo thời gian thực tích hợp qua cổng API Webhook của SePay.
- **Định tuyến database động:** Tự động sử dụng SQLite in-memory khi test, SQLite local file khi dev cục bộ, và Cloudflare D1 khi deploy production.
- **Báo cáo Thuế S1a-HKD:** Tự động kết xuất báo cáo thuế định kỳ theo tháng/quý dạng file Excel (tuân thủ quy chuẩn kế toán HKD).
- **Phát triển TDD-First:** Mã nguồn được thiết kế chặt chẽ theo Repository Pattern, kiểm thử độc lập nhanh chóng với Vitest.

---

## 💻 Công nghệ sử dụng

- **Framework:** [Astro](https://astro.build/) (Xây dựng Serverless endpoints & giao diện tĩnh)
- **Database ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **Database Engine:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (Production) & SQLite / [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) (Local/Testing)
- **Framework kiểm thử:** [Vitest](https://vitest.dev/)

---

## 🚀 Khởi chạy nhanh

### Yêu cầu hệ thống
- Node.js (phiên bản v22 trở lên)
- npm (phiên bản v10 trở lên)

### Cài đặt và Chạy
1. Clone mã nguồn dự án:
   ```bash
   git clone https://github.com/pageel/pageel-crm.git
   cd pageel-crm
   ```
2. Cài đặt các gói thư viện phụ thuộc:
   ```bash
   npm install
   ```
3. Khởi tạo cấu trúc cơ sở dữ liệu (schema) local:
   - Áp dụng các tệp tin migrations lên database D1 local giả lập:
     ```bash
     npx wrangler d1 migrations apply pageel-crm-db --local
     ```
4. Khởi chạy server phát triển:
   - Sử dụng môi trường giả lập Cloudflare (đầy đủ binding D1 & KV):
     ```bash
     npm run dev:cf
     ```
   - Sử dụng Astro dev thuần:
     ```bash
     npm run dev
     ```
5. Chạy kiểm thử unit test:
   ```bash
   npx vitest run
   ```

### 🔐 Đăng nhập môi trường Dev

Khi khởi chạy cục bộ bằng `npm run dev` hoặc `npm run dev:cf`, ứng dụng sử dụng cơ sở dữ liệu mô phỏng local:

*   **Tài khoản đăng nhập mặc định (D1 Local):**
    *   **Username:** `admin`
    *   **Password:** `admin123`
*   **Nạp dữ liệu mẫu (Seed Data) vào D1 Local:**
    Bạn có thể đặt tệp tin SQL chứa dữ liệu nhạy cảm vào `scripts/migration.sql` (tệp tin này đã được đưa vào `.gitignore` để đảm bảo an toàn, không bị commit) và nạp dữ liệu bằng lệnh:
    ```bash
    npx wrangler d1 execute pageel-crm-db --local --file=scripts/migration.sql
    ```
*   **Thêm/Cập nhật tài khoản tùy chỉnh vào D1 Local:**
    Nếu bạn muốn sử dụng tài khoản riêng trong môi trường D1 Local emulator:
    ```bash
    npx wrangler d1 execute pageel-crm-db --local --command="INSERT OR REPLACE INTO users (id, username, password_hash, role) VALUES ('<id_tùy_ý>', '<tên_đăng_nhập>', '<mã_băm_pbkdf2>', 'admin');"
    ```
*   **Reset mật khẩu trên D1 Local:**
    ```bash
    node scripts/reset-password-local-d1.cjs <username> <new-password>
    ```
*   **Reset mật khẩu trên file SQLite (`local.db`):**
    ```bash
    node scripts/reset-password.cjs <username> <new-password>
    ```

---

## 🚀 Triển khai hệ thống (Deployment)

Để xem hướng dẫn chi tiết từng bước triển khai ứng dụng lên Cloudflare Workers (kèm D1 Database, KV Namespace) và thiết lập tài khoản Admin ban đầu bảo mật, vui lòng tham khảo [Hướng dẫn Triển khai Hệ thống](guides/deployment-guide.md).

---

## 📐 Kiến trúc Cơ sở Dữ liệu

Ứng dụng tách biệt tầng logic nghiệp vụ khỏi lớp lưu trữ vật lý bằng bộ điều tuyến DB Router động:

- **Môi trường Test:** Khởi chạy trên in-memory SQLite biệt lập và siêu tốc.
- **Môi trường Production:** Tận dụng SQLite phân tán Cloudflare D1 thông qua kết nối truyền trực tiếp biến `env` từ `cloudflare:workers` vào hàm `getDb(env)`.

---

## 📄 Giấy phép

Phát hành dưới giấy phép MIT License. Xem tệp `LICENSE` để biết thêm chi tiết.
