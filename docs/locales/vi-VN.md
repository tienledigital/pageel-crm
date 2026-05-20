<div align="center">
  <img src="https://raw.githubusercontent.com/pageel/pageel-crm/main/public/pageel-logo.svg" alt="Pageel CRM Logo" width="120" />
  
  <h1>Pageel CRM 🧠</h1>
  
  <p><b>Hệ thống CRM tối giản, siêu tốc và đối soát dòng tiền tự động chạy trên Astro, SQLite và Cloudflare D1.</b></p>
  
  <p>
    <a href="../../README.md"><b>🇺🇸 English</b></a> •
    <a href="vi-VN.md"><b>🇻🇳 Tiếng Việt</b></a>
  </p>

  <p>
    <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="Giấy phép: MIT"></a>
    <img src="https://img.shields.io/badge/Status-Beta-orange.svg" alt="Trạng thái: Beta">
    <img src="https://img.shields.io/badge/Built%20with-Astro-BC52EE.svg" alt="Xây dựng với: Astro">
  </p>
</div>

<br/>

## Mục lục
- [Giới thiệu](#giới-thiệu)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Công nghệ sử dụng](#công-nghệ-sử-dụng)
- [Khởi chạy nhanh](#khởi-chạy-nhanh)
- [Kiến trúc Cơ sở Dữ liệu](#kiến-trúc-cơ-sở-dữ-liệu)
- [Giấy phép](#giấy-phép)

---

## 🎯 Giới thiệu

**Pageel CRM** là một giải pháp tự lưu trữ (self-hosted), CRM siêu nhẹ và bộ máy quản lý hóa đơn tự động dành cho các hộ kinh doanh cá thể (HKD) và doanh nghiệp nhỏ tại Việt Nam. Dự án vận hành trực tiếp trên hạ tầng Edge của Cloudflare Pages, giúp triệt tiêu hoàn toàn chi phí thuê server và đảm bảo hiệu năng truy cập tối đa.

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
- Node.js (phiên bản v18 trở lên)
- npm (phiên bản v9 trở lên)

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
3. Chạy server phát triển cục bộ:
   ```bash
   npm run dev
   ```
4. Chạy kiểm thử unit test:
   ```bash
   npx vitest run
   ```

---

## 📐 Kiến trúc Cơ sở Dữ liệu

Ứng dụng tách biệt tầng logic nghiệp vụ khỏi lớp lưu trữ vật lý bằng bộ điều tuyến DB Router động:

- **Môi trường Test:** Khởi chạy trên in-memory SQLite biệt lập và siêu tốc.
- **Môi trường Production:** Tận dụng tối đa SQLite phân tán Cloudflare D1 qua binding `platform.env.DB`.

---

## 📄 Giấy phép

Phát hành dưới giấy phép MIT License. Xem tệp `LICENSE` để biết thêm chi tiết.
