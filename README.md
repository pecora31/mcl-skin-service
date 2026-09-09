# MCL Skin Service

Backend nhỏ chạy trên Cloudflare Workers, phục vụ việc đồng bộ skin cho MCLv2.
Thay thế `CustomSkinAPI` (hiện đang trỏ vào ely.by) bằng dịch vụ do MCLv2 tự quản lý.

Đã viết xong và test cục bộ (`npm test` — 7/7 pass, và test tay qua `wrangler dev`
xác nhận đủ 8 kịch bản: claim, đọc công khai, chặn claim trùng, chặn token sai,
chấp nhận token đúng, chặn file không phải PNG, chặn username sai định dạng).
Phần còn lại dưới đây cần tài khoản Cloudflare của bạn, mình không làm thay được.

## 1. Tạo tài khoản và cài công cụ

```bash
npm install -g wrangler
wrangler login
```

Lệnh `wrangler login` sẽ mở trình duyệt để bạn đăng nhập/đăng ký Cloudflare
(miễn phí). Khi đăng ký lần đầu, Cloudflare sẽ hỏi bạn chọn một **workers.dev
subdomain** riêng — đây sẽ là phần đầu của mọi URL sau này, ví dụ nếu bạn chọn
`pecora31` thì service này sẽ chạy ở:

```
https://mcl-skin-service.pecora31.workers.dev
```

## 2. Tạo KV namespace và R2 bucket

```bash
cd mcl-skin-service
wrangler kv namespace create SKIN_REGISTRY
```

Lệnh trên in ra một `id`, ví dụ:
```
{ binding = "SKIN_REGISTRY", id = "abcd1234..." }
```

Mở `wrangler.toml`, thay dòng:
```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```
bằng `id` thật vừa nhận được.

Tiếp theo tạo R2 bucket:
```bash
wrangler r2 bucket create mcl-skins
```

(Tên bucket đã khớp sẵn trong `wrangler.toml`, không cần sửa gì thêm.)

## 3. Đặt secret cho quyền admin (dùng để gỡ skin vi phạm)

```bash
wrangler secret put ADMIN_SECRET
```

Nhập một chuỗi bí mật dài, ngẫu nhiên (ví dụ tạo bằng `openssl rand -hex 32`).
Giữ chuỗi này riêng cho bạn — đây là "chìa khoá vạn năng" để xoá bất kỳ skin
nào khi có báo cáo vi phạm, không chia sẻ, không commit vào git.

## 4. Deploy

```bash
npm run deploy
```

Sau khi chạy xong, wrangler in ra URL thật của service — dùng URL đó (dạng
`https://mcl-skin-service.<subdomain>.workers.dev`) cho bước tiếp theo.

## 5. Kiểm tra nhanh sau khi deploy

```bash
curl -X POST --data-binary @duong-dan-toi-mot-file-skin.png \
  https://mcl-skin-service.<subdomain>.workers.dev/v1/skins/TenThuNghiem
```

Phải nhận về JSON có `token` và `skinUrl`. Mở `skinUrl` trên trình duyệt phải
thấy đúng ảnh vừa gửi lên.

## Bước tiếp theo (chưa làm trong lần này)

Sau khi bạn xác nhận deploy thành công và có URL thật, việc còn lại là nối vào
MCLv2 (Giai đoạn 5 trong kế hoạch tổng thể): sửa `install_local_skin` phía Rust
để tự động gọi API này, lưu token vào máy người dùng, và đổi `root` trong cấu
hình CustomSkinLoader trỏ vào URL mới thay vì ely.by. Báo mình khi có URL để
làm tiếp phần này.

## Giới hạn đã biết

- `npm audit` báo lỗ hổng trong `sharp` (thư viện xử lý ảnh nội bộ của môi
  trường giả lập `wrangler dev`) — chỉ ảnh hưởng công cụ phát triển cục bộ,
  không có trong Worker thật được deploy, không xử lý input từ người dùng.
  Không cần lo, chỉ cần biết nó ở đó.
- Rate limit hiện đặt 5 lần claim mới/IP/ngày — chỉnh trong `RATE_LIMIT_CLAIMS_PER_DAY`
  ở `src/index.ts` nếu cần khác.
- Chưa có cơ chế khôi phục token khi mất máy — xem phần thảo luận trong kế
  hoạch tổng thể, dự kiến làm khi MCLv2 có MS auth.
