# Drag And Drop Upload Plan

## Mục tiêu

Làm cho các vùng upload trong UI đang hiển thị thông điệp `Click to upload or drag and drop` thực sự hỗ trợ kéo-thả file, đồng thời giữ nguyên toàn bộ behavior hiện tại khi người dùng click để mở file picker.

## Context hiện tại

- Dự án là frontend React/Vite + backend Express/FFmpeg.
- Phần upload UI nằm tập trung trong `src/App.tsx`.
- Hiện tại các vùng upload chỉ dùng `<input type="file" onChange={...}>`.
- Không có xử lý drag-and-drop thật:
  - `onDragOver`
  - `onDragEnter`
  - `onDragLeave`
  - `onDrop`
  - `event.dataTransfer.files`
- Vì vậy text UI đang nói có drag-and-drop nhưng implementation thực tế chưa có.
- Đây là thay đổi frontend-only; backend/render pipeline hiện tại không cần sửa.

## Phạm vi thay đổi

Thêm drag-and-drop thật cho các vùng sau trong `src/App.tsx`:

1. Foreground Video
2. Background Video
3. Background Image
4. Logo Overlay
5. Button Image

## File sẽ thay đổi

1. `src/App.tsx`

Lý do:

- Toàn bộ upload handlers hiện tại đang nằm ở đây.
- Đây là nơi nhỏ nhất và đúng nhất để bổ sung drag-and-drop.
- Giữ thay đổi cục bộ, tránh refactor lan rộng không cần thiết.

## File không được thay đổi

Không thay đổi các file sau, trừ khi phát hiện blocker thực sự buộc phải đổi:

1. `server/index.ts`
2. `server/routes/jobs.ts`
3. `server/services/jobQueue.ts`
4. `server/services/renderRunner.ts`
5. `server/services/fileStore.ts`
6. `server/services/jobStore.ts`
7. `server/services/validation.ts`
8. `server/services/encoderConfig.ts`
9. `server/ffmpeg/buildCommand.ts`
10. `server/types/renderJob.ts`
11. `shared/render-contract.ts`
12. `src/render/api.ts`
13. `src/render/renderSpec.ts`
14. `src/render/overlay.ts`
15. `src/render/outputDerivation.ts`
16. `src/render/resetState.ts`
17. `src/render/overlayDefaults.ts`
18. `src/render/jobDisplay.ts`
19. `src/naming.ts`
20. `vite.config.ts`
21. `README.md`
22. `package.json`
23. `test/**/*.test.ts`

Ghi chú:

- Mặc định không thêm file helper mới.
- Mặc định không thêm test mới cho thay đổi này nếu triển khai theo hướng tối thiểu trong `App.tsx`.

## Thiết kế implementation

### 1. Tách logic nhận `File` khỏi `onChange`

Hiện tại mỗi input upload xử lý trực tiếp trong `onChange`. Cần refactor để gom phần nhận file vào các hàm dùng chung, ví dụ:

1. `applyForegroundFile(file: File)`
2. `applyBackgroundVideoFile(file: File)`
3. `applyBackgroundImageFile(file: File)`
4. `applyLogoFile(file: File)`
5. `applyButtonImageFile(file: File)`

Lợi ích:

- `onChange` và `onDrop` dùng chung cùng một code path.
- Giảm rủi ro click-upload và drag-drop chạy lệch behavior.
- Dễ verify side effects hiện có vẫn giữ nguyên.

### 2. Thêm drag state cho từng upload zone

Trong `src/App.tsx`, thêm state để biết zone nào đang được kéo file vào. Có thể dùng một trong hai cách:

1. Một state duy nhất kiểu `activeDropZone: 'foreground' | 'bgVideo' | 'bgImage' | 'logo' | 'buttonImage' | null`
2. Hoặc nhiều boolean riêng

Ưu tiên cách 1 vì gọn hơn và đủ dùng.

Mục tiêu:

- Hiển thị visual feedback khi người dùng drag file qua đúng zone
- Xóa feedback khi leave/drop

### 3. Thêm bộ handler drag-and-drop dùng chung

Trong `src/App.tsx`, thêm helper cho drag events:

1. `handleDragOver(event)`
2. `handleDragEnter(zone)`
3. `handleDragLeave(zone)`
4. `handleDrop(zone, event)`

Yêu cầu:

- `preventDefault()` trong `dragover` và `drop`
- Chỉ lấy file đầu tiên từ `event.dataTransfer.files`
- Reset state active sau `drop` hoặc `leave`
- Không làm ảnh hưởng click behavior của `label`

### 4. Validate loại file ở client theo từng zone

Không dựa hoàn toàn vào `accept`, vì drag-and-drop có thể bỏ qua ràng buộc đó.

Rule tối thiểu:

1. Foreground: chỉ nhận `video/*`
2. Background video: chỉ nhận `video/*`
3. Background image: chỉ nhận `image/*`
4. Logo: chỉ nhận `image/*`
5. Button image: chỉ nhận `image/*`

Nếu file sai loại:

- Không cập nhật state upload
- Không thay đổi loại background/button hiện tại
- Nếu cần feedback thì ưu tiên feedback nhẹ, cục bộ, không mở rộng scope quá mức

### 5. Giữ nguyên side effects hiện tại

Khi file được thả thành công, behavior phải giống hệt click-upload hiện tại.

#### Foreground

- Tạo preview URL
- set `fgFile`
- đọc metadata để lấy `fgDuration`
- parse filename bằng `parseVideoNamingMeta()`
- auto-fill `gameName`, `version`, `suffix` nếu field đang trống

#### Background video

- Tạo preview URL
- set `bgVideoFile`
- set `bgType = 'video'`

#### Background image

- Tạo preview URL
- set `bgImageFile`
- set `bgType = 'image'`

#### Logo

- Tạo preview URL
- set `logoFile`

#### Button image

- Tạo preview URL
- set `buttonImageFile`
- set `buttonType = 'image'`

### 6. Gắn handlers vào từng upload zone

Gắn handlers lên đúng các khối `label` upload trong `src/App.tsx`:

1. Foreground upload zone
2. Background video upload zone
3. Background image upload zone
4. Logo upload zone
5. Button image upload zone

Visual state của zone nên thay đổi bằng className hiện có hoặc class bổ sung tối thiểu, ví dụ thay đổi:

- border color
- background tint
- text/icon color

## Các rủi ro kỹ thuật cần kiểm soát

### 1. Flicker drag state

`dragenter` / `dragleave` trên container có thể flicker khi đi qua child elements.

Kiểm soát bằng cách:

- Dùng active zone đơn giản và reset cẩn thận
- Tránh logic phức tạp nếu không cần

### 2. Làm hỏng click-upload

Vì upload zone dùng `label` + `input`, cần đảm bảo thêm drag handlers nhưng không chặn hành vi click mở file picker.

### 3. Sai loại file nhưng vẫn set state

Phải có chặn client-side rõ ràng để image không bị nhận vào zone video và ngược lại.

### 4. Làm mất side effects cũ của foreground upload

Đây là điểm dễ regress nhất vì foreground có nhiều logic hơn các zone khác: preview, metadata duration, auto naming.

## QA/QC

### A. Code QA

Checklist review code:

1. `onChange` và `onDrop` đi qua cùng một logic xử lý file
2. Không có thay đổi backend/API contract
3. Không có thay đổi đến render queue hoặc download flow
4. Drag handlers có `preventDefault()` đúng chỗ
5. Active drop state được reset đúng khi leave/drop
6. Mỗi zone có validate loại file phù hợp
7. Không thêm refactor ngoài phạm vi upload

### B. Functional QA

#### Foreground Video

1. Click chọn video vẫn hoạt động
2. Drag video vào zone hoạt động
3. Preview foreground hiển thị đúng
4. `fgDuration` vẫn được đọc từ metadata
5. Naming auto-detect vẫn chạy đúng từ tên file

#### Background Video

1. Click chọn video vẫn hoạt động
2. Drag video vào zone hoạt động
3. `bgType` tự về `video`
4. Preview background video hiển thị đúng

#### Background Image

1. Click chọn ảnh vẫn hoạt động
2. Drag ảnh vào zone hoạt động
3. `bgType` tự về `image`
4. Preview background image hiển thị đúng

#### Logo Overlay

1. Click chọn ảnh vẫn hoạt động
2. Drag ảnh vào zone hoạt động
3. Trạng thái `Logo loaded` vẫn đúng

#### Button Image

1. Click chọn ảnh vẫn hoạt động
2. Drag ảnh vào zone hoạt động
3. `buttonType` tự chuyển sang `image`
4. Trạng thái `Image loaded` vẫn đúng

### C. Negative QA

1. Thả image vào Foreground: không được nhận
2. Thả video vào Logo: không được nhận
3. Thả video vào Button Image: không được nhận
4. Thả nhiều file cùng lúc: chỉ nhận file đầu tiên hoặc bỏ qua theo implementation đã chọn, nhưng behavior phải nhất quán
5. Thả file ngoài zone: không làm đổi state hiện tại

### D. UX QA

1. Khi drag file vào đúng zone, border/background đổi trạng thái rõ ràng
2. Khi kéo file ra ngoài zone, visual feedback biến mất
3. Không có trạng thái active bị kẹt sau khi drop xong

### E. Regression QA

1. Sau khi upload bằng drag-drop, previews vẫn render đúng cho các output
2. Nút `Download` vẫn queue jobs như cũ
3. Sidebar queue vẫn poll trạng thái bình thường
4. Completed jobs vẫn download được như cũ
5. Retry/cancel flow không bị ảnh hưởng

## Verify

### 1. Static verify

Chạy:

```bash
npm run lint
```

Kỳ vọng:

- Không có TypeScript error

### 2. Manual browser verify

Thực hiện lần lượt:

1. Drag foreground video hợp lệ
2. Drag background video hợp lệ
3. Drag background image hợp lệ
4. Drag logo image hợp lệ
5. Drag button image hợp lệ

Xác nhận sau mỗi bước:

- state cập nhật đúng
- preview cập nhật đúng
- visual feedback drag/drop hoạt động đúng

### 3. Negative verify

1. Drag sai loại file vào từng zone
2. Verify app không nhận nhầm file
3. Verify state cũ không bị ghi đè sai

### 4. End-to-end verify

Sau khi drag/drop đủ input cần thiết:

1. Queue ít nhất 1 render job
2. Verify submit thành công
3. Verify polling vẫn cập nhật trạng thái
4. Verify completed job vẫn tải được

### 5. Non-regression verify

Lặp lại các flow upload bằng click thay vì drag-and-drop:

1. Foreground
2. Background video
3. Background image
4. Logo
5. Button image

Kỳ vọng:

- Tất cả flow click-upload cũ vẫn hoạt động như trước khi sửa

## Definition of Done

1. Tất cả upload zone đang quảng cáo drag-and-drop đều thả file được thật
2. Click-upload cũ vẫn hoạt động
3. Không thay đổi backend hay API contract
4. Chỉ sửa `src/App.tsx` trong scope chính
5. `npm run lint` pass
6. Manual QA cho happy path, invalid type, và basic end-to-end đều pass
