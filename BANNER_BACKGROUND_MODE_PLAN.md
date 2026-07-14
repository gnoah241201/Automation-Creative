# Banner Background Mode Plan

## Mục tiêu

Giải quyết trường hợp `background image` đã chứa sẵn logo/button baked vào ảnh, khiến output `4:5` và `1:1` bị xấu khi crop theo rule hiện tại.

Giải pháp sản phẩm được chốt cho v1:

1. Thêm 2 mode cho banner image:
   - `Banner sạch`
   - `Banner đã có logo/button`
2. Với mode `Banner đã có logo/button`:
   - `9:16` và `16:9`: giữ nguyên behavior hiện tại
   - `4:5` và `1:1`: chỉ zoom `background image layer` lên `300%`
3. Việc zoom chỉ ảnh hưởng background image:
   - không ảnh hưởng foreground video
   - không ảnh hưởng logo overlay
   - không ảnh hưởng button overlay

## Context hiện tại

- `background image` được chọn ở frontend trong `src/App.tsx`.
- `RenderSpec` hiện chưa có field nào để phân biệt ảnh nền sạch với ảnh nền precomposed.
- `RenderSpec` hiện nằm ở `shared/render-contract.ts`.
- Frontend build spec ở `src/render/renderSpec.ts`.
- Backend validate spec ở `server/services/validation.ts`.
- FFmpeg dựng background image trong `server/ffmpeg/buildCommand.ts`.
- Rule hiện tại cho `bgType === 'image'`:
  - `4:5` / `1:1`: scale tăng rồi crop giữa khung
  - `9:16` / `16:9`: scale trực tiếp theo output
- Vì logo/button đã dính vào ảnh nền, crop sang `4:5` và `1:1` không thể tự re-layout lại composition.

## Assumption sản phẩm

1. Với `Banner đã có logo/button`, phần sạch để đặt foreground video nằm ở khu vực dưới banner.
2. Mục tiêu của zoom `300%` là đẩy vùng logo/button baked sẵn ra ngoài khung nhìn của `4:5` và `1:1` nhiều nhất có thể.
3. Rule zoom `300%` là cố định cho v1, chưa thêm slider hoặc focal-point editor.
4. Crop anchor cho mode precomposed nên ưu tiên phần `lower-center` hoặc `bottom-center`.

## Rule sản phẩm

### 1. Banner sạch

- Giữ nguyên pipeline hiện tại.
- Tất cả output ratios render như cũ:
  - `9:16`
  - `16:9`
  - `4:5`
  - `1:1`

### 2. Banner đã có logo/button

- `9:16`: giữ nguyên current behavior
- `16:9`: giữ nguyên current behavior
- `4:5`: zoom background image `300%`, crop theo lower anchor
- `1:1`: zoom background image `300%`, crop theo lower anchor

### 3. Layer isolation

Zoom chỉ áp dụng cho `background image layer`.

Không được zoom các layer sau:

1. foreground video
2. logo overlay
3. button overlay

## Thiết kế kỹ thuật

### 1. Thêm field mới vào RenderSpec

Thêm field mới vào `RenderSpec`, ví dụ:

```ts
backgroundImageMode?: 'clean' | 'precomposed'
```

Rule:

- Chỉ có ý nghĩa khi `bgType === 'image'`
- Nếu `bgType === 'video'`, backend có thể ignore field này
- Giá trị mặc định nên là `clean`

### 2. Frontend state và UI

Trong `src/App.tsx`:

1. Thêm state mới cho banner image mode
2. Chỉ hiển thị control này khi `bgType === 'image'`
3. UI đề xuất:
   - `Banner sạch`
   - `Banner đã có logo/button`
4. Thêm helper text ngắn:
   - `Banner đã có logo/button sẽ tự zoom nền cho output 4:5 và 1:1`

### 3. Build render spec

Trong `src/render/renderSpec.ts`:

1. Mở rộng `BuilderInput`
2. Truyền `backgroundImageMode` vào `RenderSpec`
3. Đặt default hợp lý nếu frontend chưa truyền

### 4. Validation backend

Trong `server/services/validation.ts`:

1. Thêm enum hợp lệ cho `backgroundImageMode`
2. Chỉ validate field này khi cần
3. Không làm vỡ API cũ nếu request cũ chưa gửi field mới

### 5. Logic render backend

Trong `server/ffmpeg/buildCommand.ts`:

#### Với `bgType === 'image'` và mode `clean`

- Giữ nguyên behavior hiện tại

#### Với `bgType === 'image'` và mode `precomposed`

- Nếu `outputRatio` là `9:16` hoặc `16:9`:
  - giữ nguyên behavior hiện tại
- Nếu `outputRatio` là `4:5` hoặc `1:1`:
  - background image được scale lớn hơn tương đương `300%`
  - sau đó crop về đúng output size
  - crop anchor ưu tiên `lower-center`

Điểm quan trọng:

- Chỉ thay nhánh chuẩn bị `[bg_ready]`
- Không thay các bước overlay foreground, overlay PNG, audio map, encoder settings

### 6. Logic preview frontend

Trong `src/App.tsx`, preview phải phản ánh đúng rule backend:

#### Với mode `clean`

- giữ nguyên preview hiện tại

#### Với mode `precomposed` + output `4:5` / `1:1`

- chỉ background image preview được scale `3x`
- dùng `transform-origin: center bottom` hoặc gần tương đương
- foreground video vẫn render như cũ
- logo/button overlay vẫn render như cũ

Mục tiêu:

- người dùng nhìn preview gần đúng với output FFmpeg
- tránh mismatch giữa preview và file final

## File sẽ thay đổi

1. `shared/render-contract.ts`
   - thêm type/field `backgroundImageMode`

2. `src/render/renderSpec.ts`
   - truyền field mới vào `RenderSpec`

3. `server/services/validation.ts`
   - validate field mới

4. `server/ffmpeg/buildCommand.ts`
   - thêm nhánh xử lý `precomposed + 4:5/1:1`

5. `src/App.tsx`
   - thêm state/UI chọn mode banner
   - cập nhật preview logic cho background image

6. `test/reset-and-spec.test.ts`
   - verify `buildRenderSpec` truyền field mới đúng

7. `test/build-command.test.ts`
   - thêm test cho FFmpeg filter rules của mode mới

## File không nên thay đổi

1. `server/services/jobQueue.ts`
2. `server/services/renderRunner.ts`
3. `server/services/fileStore.ts`
4. `server/services/jobStore.ts`
5. `server/services/encoderConfig.ts`
6. `server/routes/jobs.ts`
7. `src/render/api.ts`
8. `src/render/outputDerivation.ts`
9. `src/render/resetState.ts`
10. `src/render/jobDisplay.ts`
11. `src/naming.ts`

## Chi tiết implementation

### Bước 1. Mở rộng shared contract

Trong `shared/render-contract.ts`:

1. Thêm type mới cho background image mode
2. Thêm field vào `RenderSpec`
3. Đảm bảo naming rõ ràng, không làm contract khó đọc

### Bước 2. Truyền field từ frontend spec builder

Trong `src/render/renderSpec.ts`:

1. thêm input field mới
2. map sang `RenderSpec`
3. đảm bảo default là `clean`

### Bước 3. Cập nhật UI editor

Trong `src/App.tsx`:

1. thêm state mới cho `backgroundImageMode`
2. render segmented control hoặc button group cho 2 mode
3. chỉ hiển thị khi `bgType === 'image'`
4. truyền field này vào `buildRenderSpec`

### Bước 4. Cập nhật preview logic

Trong `src/App.tsx`:

1. xác định khi nào cần áp dụng `precomposed zoom preview`
2. chỉ áp dụng cho:
   - `bgType === 'image'`
   - `backgroundImageMode === 'precomposed'`
   - `outputRatio === '4:5' || outputRatio === '1:1'`
3. zoom nền lên `scale(3)`
4. đặt `transform-origin` về vùng đáy để crop thiên xuống dưới

### Bước 5. Cập nhật validation backend

Trong `server/services/validation.ts`:

1. validate enum mới nếu field xuất hiện
2. có thể cho phép optional để tương thích request cũ
3. nếu `bgType !== 'image'`, không cần bắt buộc field này

### Bước 6. Cập nhật FFmpeg command builder

Trong `server/ffmpeg/buildCommand.ts`:

1. nhận `backgroundImageMode` từ `RenderSpec`
2. với `clean mode`, giữ nguyên nhánh cũ
3. với `precomposed mode + 4:5/1:1`:
   - scale background image lớn hơn tương ứng `300%`
   - crop theo lower-center
4. đảm bảo không chạm vào foreground pipeline
5. đảm bảo không chạm vào overlay PNG pipeline

## QA/QC

### A. Contract QA

1. `RenderSpec` mới được FE và BE hiểu thống nhất
2. request submit job không bị vỡ type
3. request cũ vẫn hợp lệ nếu field mới chưa có

### B. Functional QA - Banner sạch

1. upload banner sạch ở mode `clean`
2. verify output `9:16` không đổi
3. verify output `16:9` không đổi
4. verify output `4:5` không đổi
5. verify output `1:1` không đổi

### C. Functional QA - Banner đã có logo/button

1. upload banner precomposed ở mode `precomposed`
2. verify output `9:16` vẫn như hiện tại
3. verify output `16:9` vẫn như hiện tại
4. verify output `4:5` dùng nền đã zoom `300%`
5. verify output `1:1` dùng nền đã zoom `300%`
6. verify vùng baked logo/button bị đẩy ra khỏi frame nhiều hơn đáng kể

### D. Layer Isolation QA

1. foreground video không bị scale theo background
2. logo overlay không bị scale theo background
3. button overlay không bị scale theo background

### E. Preview Parity QA

1. preview FE cho `clean mode` khớp behavior cũ
2. preview FE cho `precomposed mode` gần khớp output backend
3. không có trường hợp preview đẹp nhưng final render sai lệch lớn

### F. Regression QA

1. queue submit/poll/download không bị ảnh hưởng
2. background video mode không bị ảnh hưởng
3. logo/button custom image flow không bị ảnh hưởng
4. output naming không bị ảnh hưởng

## Verify

### 1. Static verify

Chạy:

```bash
npm run lint
```

Kỳ vọng:

- không có TypeScript error

### 2. Automated tests

Chạy:

```bash
npm test
```

Kỳ vọng:

- test cũ pass
- test mới cho `RenderSpec` và `buildCommand` pass

### 3. Manual verify với asset thật

Chuẩn bị 2 asset:

1. một banner sạch
2. một banner precomposed có logo/button sẵn

Render đủ 4 ratio cho từng mode:

1. `9:16`
2. `16:9`
3. `4:5`
4. `1:1`

Kiểm tra:

- mode `clean` giữ nguyên behavior cũ
- mode `precomposed` chỉ thay đổi `4:5` và `1:1`
- foreground và overlay không bị scale theo background

## Definition of Done

1. User có thể chọn giữa `Banner sạch` và `Banner đã có logo/button`
2. `Banner sạch` giữ nguyên toàn bộ behavior hiện tại
3. `Banner đã có logo/button` chỉ thay đổi xử lý cho `4:5` và `1:1`
4. zoom `300%` chỉ tác động background image layer
5. preview frontend phản ánh đúng rule render backend
6. `npm run lint` pass
7. `npm test` pass
8. manual verify với asset thật cho kết quả chấp nhận được

## Gợi ý mở rộng cho v2

Không làm trong v1, nhưng có thể cân nhắc sau:

1. slider chỉnh mức zoom thay vì cố định `300%`
2. focal-point editor để điều chỉnh anchor theo từng banner
3. per-ratio tuning riêng cho `4:5` và `1:1`
4. upload override asset riêng cho từng ratio nếu cần chất lượng cao nhất
