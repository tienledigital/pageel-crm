# Hướng dẫn Cấu hình Sao lưu Cơ sở dữ liệu lên GitHub

Tài liệu này hướng dẫn chi tiết cách tạo và cấu hình GitHub Fine-grained Personal Access Token (PAT) cùng các biến môi trường để kích hoạt tính năng sao lưu cơ sở dữ liệu tự động của Pageel CRM lên kho chứa GitHub bảo mật.

---

## Bước 1: Tạo Kho chứa (Repository) Sao lưu riêng tư

Để đảm bảo an toàn cho dữ liệu khách hàng, bạn **phải** lưu trữ các bản sao lưu trong một kho chứa riêng tư (Private Repository).

1. Truy cập [GitHub](https://github.com) và đăng nhập vào tài khoản của bạn.
2. Nhấp vào nút **New** (hoặc truy cập [github.com/new](https://github.com/new)).
3. Điền các thông tin:
   - **Repository name**: Ví dụ: `crm-backups`
   - **Publicity**: Chọn **Private** 🔒 (Bắt buộc để bảo vệ dữ liệu).
4. Nhấp vào **Create repository**.

---

## Bước 2: Tạo GitHub Fine-grained Personal Access Token (PAT)

Fine-grained PAT là loại token thế hệ mới của GitHub, cho phép bạn giới hạn quyền truy cập ở mức tối thiểu (chỉ cho phép truy cập đúng 1 repository sao lưu với quyền tối thiểu).

1. Nhấp vào ảnh đại diện của bạn ở góc trên bên phải GitHub, chọn **Settings**.
2. Cuộn xuống menu bên trái, nhấp vào **Developer settings** (ở dưới cùng).
3. Chọn **Personal access tokens** -> **Fine-grained tokens**.
4. Nhấp vào nút **Generate new token**.
5. Điền thông tin cấu hình token:
   - **Token name**: Ví dụ: `pageel-crm-backup-token`
   - **Expiration**: Chọn thời hạn hoạt động phù hợp (ví dụ: 90 days hoặc Custom).
   - **Repository access**: Chọn **Only select repositories** và chọn kho chứa sao lưu bạn vừa tạo ở Bước 1 (ví dụ: `crm-backups`).
   - **Permissions**: Nhấp vào mục **Repository permissions**, tìm dòng **Contents** và chuyển quyền thành **Read and write** (Quyền ghi tệp tin bản sao lưu).
6. Nhấp vào **Generate token** ở dưới cùng.
7. **Sao chép mã Token hiển thị** (bắt đầu bằng `github_pat_...`) và lưu lại an toàn. *Lưu ý: Mã này chỉ hiển thị một lần duy nhất.*

---

## Bước 3: Cấu hình biến môi trường trong dự án

### 1. Chạy thử nghiệm ở môi trường cục bộ (Local Development)

Wrangler sử dụng tệp tin `.dev.vars` để mô phỏng các biến bí mật (secrets) trên Cloudflare Workers.

1. Tại thư mục gốc của repo (`repo/`), tạo một tệp tin mới tên là `.dev.vars` (đã được cấu hình tự động bỏ qua trong `.gitignore` để không bị lộ lên Git).
2. Sao chép nội dung từ `.dev.vars.example` vào `.dev.vars` và thay thế giá trị thực tế của bạn:

```ini
GITHUB_BACKUP_TOKEN=github_pat_xxxx_your_token_here
GITHUB_BACKUP_OWNER=your_github_username
GITHUB_BACKUP_REPO=crm-backups
GITHUB_BACKUP_BRANCH=main
```

### 2. Triển khai trên Production (Cloudflare Workers)

Khi deploy ứng dụng dưới dạng Cloudflare Workers, bạn cần cài đặt các biến bí mật này bằng Wrangler CLI (nếu Worker của bạn chạy dưới một tên cụ thể, ví dụ: `pageel-crm`, hãy sử dụng flag `--name pageel-crm`):

```bash
# Nạp Token của bạn (Wrangler sẽ yêu cầu nhập giá trị bí mật)
npx wrangler secret put GITHUB_BACKUP_TOKEN --name pageel-crm

# Nạp tên tài khoản / Organization sở hữu repo backup
npx wrangler secret put GITHUB_BACKUP_OWNER --name pageel-crm

# Nạp tên kho chứa sao lưu
npx wrangler secret put GITHUB_BACKUP_REPO --name pageel-crm

# Nạp tên nhánh muốn commit dữ liệu (mặc định: main)
npx wrangler secret put GITHUB_BACKUP_BRANCH --name pageel-crm
```

Ngoài ra, bạn cũng có thể quản lý trực tiếp các biến này trên Cloudflare Dashboard -> **Workers & Pages** -> Chọn dự án Worker của bạn -> tab **Settings** -> mục **Variables**.

---

## Bước 4: Chạy thử nghiệm kết nối sao lưu thủ công

Để đảm bảo token và cấu hình kho chứa hoạt động chính xác mà không cần đi qua giao diện UI:

1. Đảm bảo bạn đã hoàn thành cấu hình tệp `repo/.dev.vars` ở Bước 3.
2. Tại thư mục `repo/`, chạy lệnh terminal sau:

```bash
npx tsx scripts/test-backup-manual.ts
```

3. Kiểm tra đầu ra trong console:
   - Nếu hiển thị `Backup Success! New Commit SHA: ...`, kết nối đã thành công! Bạn có thể lên kho chứa sao lưu trên GitHub kiểm tra tệp tin thử nghiệm trong thư mục `backups/test/`.
   - Nếu thất bại, lỗi chi tiết từ GitHub API sẽ được hiển thị rõ ràng để bạn kiểm tra lại quyền của Token hoặc thông tin kho chứa.
