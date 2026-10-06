# Chuyển Resize Video thành app desktop (Tauri 2)

Ngày: 2026-10-06

## Mục tiêu

Biến tool resize video từ một web app hai tiến trình (Express + Vite) thành **một file `.exe` nhẹ**, giao diện đơn giản hơn, chạy trên máy cá nhân của người làm creative.

Repo hiện tại **chuyển hẳn** thành app desktop. Bản web không được duy trì nữa; team đã nhận bàn giao vẫn dùng được commit `028feaa` trên `main`.

## Vì sao Tauri

Phần logic đáng giá nhất của codebase là **hàm thuần**: `buildCommand.ts` trả về mảng tham số ffmpeg, `outputDerivation.ts` trả về danh sách output, `naming/*` trả về tên file. Không cái nào chạm đĩa hay mạng. Độ dài video đã được đọc bằng thẻ `<video>` của trình duyệt (`fgDuration.ts`), không qua ffprobe.

Nên phần "native" thật sự chỉ cần làm bốn việc: chọn file, chọn thư mục, chạy ffmpeg, báo tiến độ. Việc nào cũng nhỏ, nên vỏ app được chọn thuần theo cân nặng.

| | Vỏ app | ffmpeg | Tổng |
|---|---|---|---|
| **Tauri 2** | ~6 MB | 62 MB | **~68 MB** |
| Node SEA | ~98 MB | 62 MB | ~160 MB |
| Electron | ~160 MB | 62 MB | ~220 MB |

`ffprobe.exe` (78 MB) **bị bỏ**. Nó chỉ còn dùng để dò codec, mà `ffmpeg -i` in ra đúng thông tin đó.

Mọi máy Windows 10/11 có Edge đều đã có WebView2 runtime, nên Tauri không mang theo trình duyệt.

## Các quyết định đã chốt

| Hạng mục | Quyết định |
|---|---|
| Phạm vi | Chỉ Resize. Bỏ Hook Composer và Local Library |
| Luồng file | Chọn từ ổ đĩa → xuất thẳng ra thư mục. Không upload, không ZIP |
| Độ dài output | Hai chế độ: **Cắt** hoặc **Tua nhanh**, chọn trong Settings |
| Batch | Có. Nhiều video một lúc, version tự tăng |
| Nền | Hai kiểu: tự làm mờ chính video, hoặc một ảnh banner dùng chung |
| Đặt tên | Config Game/Version/Suffix, lưu lại, tự tăng version theo lô |
| Logo / CTA | Giữ code, mặc định **tắt**, nằm sau mục "Nâng cao" |
| Preview | **Một ô duy nhất**, có hai ô chọn: video nào, tỉ lệ nào |
| Bố cục | Một cột, cuộn từ trên xuống |
| Bản gốc | Chép sang thư mục xuất, đổi tên theo config, convert h264 nếu nguồn không phải h264 |
| Chỗ đứng | Repo hiện tại chuyển hẳn thành desktop |

## Kiến trúc

Hai nửa, ranh giới là **ai quyết định** và **ai chạm vào máy**.

### Nửa trên — webview (TypeScript + React)

Toàn bộ phần quyết định: giao diện, suy ra output từ độ dài, đặt tên và tăng version, dựng spec, dựng mảng tham số ffmpeg, hàng đợi. Tất cả là hàm thuần, test bằng `node:test` không cần dựng server.

### Nửa dưới — Rust

Toàn bộ phần chạm vào máy. Không có logic nghiệp vụ.

| Lệnh | Việc |
|---|---|
| `pick_videos() -> Vec<PathBuf>` | Hộp thoại chọn nhiều video |
| `pick_folder() -> PathBuf` | Chọn thư mục xuất |
| `pick_image() -> PathBuf` | Chọn ảnh banner |
| `run_ffmpeg(args, job_id)` | Chạy ffmpeg sidecar, đẩy từng dòng stderr về webview qua event |
| `cancel(job_id)` | Giết một tiến trình |
| `reveal(path)` | Mở thư mục trong Explorer |

ffmpeg đi kèm app dưới dạng **sidecar** (`externalBin` trong `tauri.conf.json`), chạy qua `tauri-plugin-shell`. Hộp thoại dùng `tauri-plugin-dialog`.

Rust giữ một bảng `job_id → Child` và **giết sạch khi cửa sổ đóng**. Đây chính là lỗi ffmpeg mồ côi chiếm cổng đã gặp ba lần ở bản web; lần này nằm trong thiết kế chứ không phải đi dọn sau.

### Preview không copy file

Webview đọc file tại chỗ qua `convertFileSrc`, nên `<video>` trỏ thẳng vào đường dẫn gốc. Cơ chế nền mờ bằng CSS giữ nguyên.

### Không còn HTTP

Không Express, không multer, không thư mục temp, không token tải về, không `queue-state.json`.

## Màn hình chính

Một cột, thứ tự từ trên xuống:

1. **Vùng thả video** — kéo thả hoặc bấm chọn. Hiện số lượng đã chọn.
2. **Hàng hai cột**: trái là preview (hai ô chọn phía trên: video nào, tỉ lệ nào); phải là Game / Version / Suffix và lựa chọn nền. Mặc định preview lấy video đầu tiên trong lô và tỉ lệ đầu tiên đang được tick.
3. **Bảng xuất ra** — ma trận tỉ lệ × độ dài, tick ô.
4. **Thư mục lưu** — ô đường dẫn + nút Đổi.
5. **▸ Nâng cao** — logo và nút CTA, mặc định đóng.
6. **Nút Render** — hiện rõ số việc: "Render 20 video → 120 file".

Trong lúc render, danh sách job thay chỗ nút Render, mỗi dòng một thanh tiến độ.

## Hai chế độ độ dài

Chọn trong Settings. Năm tỉ lệ luôn là `9:16, 16:9, 4:5, 2:3, 1:1`.

### Chế độ Cắt

Mốc: `6, 10, 12, 15, 30, 60, 90, 120` giây. Một mốc chỉ được chào khi `d > T`.

Mỗi tỉ lệ có thêm **một bản full-length**, trừ khi mốc dài nhất cách độ dài nguồn không quá 1 giây (lúc đó bản full và mốc đó là một).

Mỗi tỉ lệ **composite đúng một lần**: render bản dài nhất, các bản ngắn hơn cắt ra bằng `-t N -c copy` (không encode lại).

### Chế độ Tua nhanh

Mốc: `15, 30` giây. Một mốc chỉ được chào khi `d > T + 0.5`. Biên 0.5 giây tồn tại vì `buildOutputFilename` làm tròn — không có nó thì nguồn 30.2s sẽ đặt tên bản full là `_30s` trùng với bản 30s.

Mỗi tỉ lệ luôn có bản full-length, và nó là bản được composite. Hai bản ngắn là **toàn bộ video tua nhanh cho vừa 15s/30s**, không mất đoạn cuối. Chúng phải encode lại nhưng encode từ khung hình đã dựng xong — không phải làm lại blur, overlay, logo.

## Luồng chạy

1. Thả video → nhận **đường dẫn thật**, không copy.
2. Mỗi video: đọc độ dài và kích thước bằng `<video>` ẩn (`fgDuration.ts`).
3. Áp config đặt tên cho cả lô, version tăng dần `v60 → v61 → v62` (`applyNamingConfigToBatch`).
4. Từ độ dài + chế độ → danh sách output **cho từng video riêng** (`deriveSourceOutputs`). Video 20s không được chào bản 30s.
5. Người dùng tick tỉ lệ × độ dài một lần, áp cho cả lô; video nào không đủ dài thì ô đó tự rụng (`selectSourceOutputs`).
6. Bấm Render → ba kiểm tra trước: thư mục ghi được, tên nào đã tồn tại, version có số ở đuôi.
7. Hàng đợi chạy N job song song; job con chờ job cha xong.
8. File ghi thẳng vào thư mục đã chọn, đúng tên.

### Hàng đợi

Nằm ở TypeScript. Rust chỉ biết chạy một tiến trình và báo lại. Nhờ vậy logic xếp hàng và quan hệ cha–con test được bằng `node:test`.

Trạng thái hàng đợi **không lưu ra đĩa**. Đóng app là render dừng — đúng kỳ vọng của một app desktop, và bỏ được `jobStore` cùng lỗi poisoned write chain đã gặp ở bản web.

### Bản gốc

**Mỗi video nguồn** được chép một bản sang thư mục xuất, đổi tên theo config, **thời lượng tự detect** chứ không lấy từ config.

Nếu nguồn không phải h264 thì convert sang h264 thay vì copy (`sourceNormalize.ts` giữ lại). Đây đúng là lỗi 7 file HEVC trên Google Drive không mở được hồi trước.

### Tiến độ và CPU

Tiến độ đọc từ dòng `time=00:00:12.34` ffmpeg in ra stderr, chia cho tổng độ dài. Hàm parse thuần, có test riêng.

CPU giữ nguyên bài học cũ: `-threads` chia theo số core và số job song song, cộng priority BelowNormal và affinity. Rust gọi thẳng API Windows nên bỏ được vòng PowerShell.

## Settings

Sau bánh răng góc trên:

- Chế độ độ dài: Cắt / Tua nhanh
- Thư mục xuất mặc định
- Số job chạy song song (mặc định tính theo số core)
- Mở sẵn mục Nâng cao hay không

Lưu bằng `localStorage`, như `namingConfig` hiện tại. Trong Tauri nó tồn tại qua các lần mở app.

**`namingHistory.ts` bị xóa.** Trước đây nó phải tự ghi nhớ đã render tên nào vì server không thấy máy người dùng. Giờ thư mục xuất chính là sổ ghi — kiểm tra file có tồn tại hay không, chính xác hơn và không phải lưu gì.

## Xử lý lỗi

| Tình huống | Xử lý |
|---|---|
| Một output ffmpeg lỗi | Dòng đó đỏ kèm 10 dòng stderr cuối; các job khác chạy tiếp |
| Thư mục xuất không ghi được | Chặn lúc bấm Render, không chạy job nào |
| Tên file đã có trong thư mục | Liệt kê ra, cho chọn Ghi đè / Bỏ qua / Tăng version |
| File nguồn bị xóa giữa chừng | Loại video đó khỏi lô, báo rõ tên |
| Không đọc được độ dài | Video đó chỉ còn bản full-length, có cờ cảnh báo trên dòng của nó |
| Version không có số ở đuôi, lô nhiều video | Chặn cứng (luật cũ) |
| Đóng app giữa chừng | Rust giết sạch tiến trình con |

## Cấu trúc repo sau khi đổi

```
src/
  core/                  hàm thuần, có test
    outputDerivation.ts  hai chế độ Cắt / Tua nhanh
    buildCommand.ts
    sourceNormalize.ts
    validation.ts
    batchOutputs.ts
    batchNaming.ts
    batchSources.ts      từ batchUpload.ts, bỏ phần upload
    submitBatch.ts       từ submitResizeBatch.ts
    fgDuration.ts
    precomposedAnchor.ts
    overlay.ts
    naming/
    progressParse.ts     MỚI: đọc time= từ stderr
    renderPlan.ts        MỚI: hàng đợi + quan hệ cha/con
    outputCollision.ts   MỚI: dò trùng tên trong thư mục
  ui/                    React, bố cục một cột
  bridge/tauri.ts        gói invoke() lại để test mock được
src-tauri/
  src/main.rs
  src/commands.rs
  src/process.rs         sổ tiến trình, priority, affinity
  binaries/ffmpeg-x86_64-pc-windows-msvc.exe
  tauri.conf.json
test/
```

### Bị xóa

`server/` cả thư mục · `src/composer/` · `src/library/` · Docker, nginx, prometheus, grafana, các script deploy · `renderDownloadBundles` · `renderBundlePlan` · `libraryDownloadBundles` · `authSession` · `metrics` · `jobStore` · `fileStore` · `namingHistory` · hai file `.tar.gz` deploy cũ · toàn bộ `*.sync-conflict-*`

Khoảng 60% số file trong repo biến mất, phần còn lại là phần được test kỹ nhất.

## Test

- Mọi module thuần giữ `node:test`. Phần lớn trong 597 test hiện có thuộc nhóm ở lại.
- Ba nhóm test mới: parse tiến độ, lập kế hoạch cha–con, dò trùng tên trong thư mục.
- Rust: 5 lệnh mỏng, test tích hợp bằng ffmpeg thật trên một video fixture nhỏ (như `speed-up-real-media-smoke.test.ts`).
- Một smoke test cuối: render thật một video ra hai tỉ lệ, mở lại bằng ffmpeg để chắc file hợp lệ.

## Rủi ro

**Máy build cần Rust + MSVC Build Tools** (~2 GB). Máy chỉ dùng app thì không cần gì.

**`.exe` chưa ký số** sẽ bị Windows SmartScreen cảnh báo "Unknown publisher" lần đầu mở, và một số antivirus doanh nghiệp có thể chặn. Ký số cần chứng chỉ trả phí. Không chặn việc dùng, nhưng khi gửi cho team nên báo trước.

**Repo đang có thay đổi chưa commit** chuyển `outputDerivation.ts` từ mô hình Cắt sang Tua nhanh. Thiết kế này giữ cả hai, nên phần sửa dở đó trở thành một nửa của chế độ kép — không bỏ đi.

## Ngoài phạm vi

Không làm trong lần này: auto-update, bản macOS/Linux, ký số, đa ngôn ngữ, lưu hàng đợi ra đĩa, sửa video trong app (cắt tay, chỉnh timeline), đẩy thẳng lên Google Drive.
