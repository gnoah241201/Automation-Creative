# Precomposed Banner FG-Region Anchor Plan

## Mục tiêu

Điều chỉnh rule render cho `backgroundImageMode = 'precomposed'` để output `4:5` và `1:1` không còn dùng anchor `lower-center` chung nữa.

Rule mới sẽ lấy **vùng background nằm dưới foreground trong canonical layout `16:9`** làm anchor hình học, sau đó:

1. scale background image lên `300%`
2. crop `4:5` hoặc `1:1` quanh anchor đó
3. giữ foreground video, logo overlay, button overlay tách biệt như hiện tại

Plan này cũng bao gồm việc sửa **preview frontend** để dùng đúng cùng model với backend, tránh tình trạng preview và final render lệch nhau.

---

## Phạm vi áp dụng

Chỉ áp dụng khi đồng thời thỏa tất cả điều kiện sau:

1. `bgType === 'image'`
2. `backgroundImageMode === 'precomposed'`
3. `inputRatio === '9:16'`
4. `fgPosition === 'left' || fgPosition === 'right'`
5. `outputRatio === '4:5' || outputRatio === '1:1'`

Không áp dụng cho:

1. `backgroundImageMode === 'clean'`
2. `bgType === 'video'`
3. `fgPosition === 'center'`
4. output `9:16`
5. output `16:9`
6. input `16:9`

---

## Giả định sản phẩm

1. Banner precomposed thường đã có logo/button baked sẵn ở phía đối diện foreground.
2. Với case `input 9:16 -> output 16:9`, phần background bị foreground che lên thường là vùng banner sạch hơn để tái sử dụng cho crop `4:5` và `1:1`.
3. `4:5` và `1:1` vẫn chỉ thay đổi background image layer, không thay foreground pipeline.
4. Mức zoom `300%` vẫn là rule cố định cho v1.

---

## Rule sản phẩm mới

### Banner sạch

Giữ nguyên toàn bộ behavior hiện tại.

### Banner đã có logo/button

- `9:16`: giữ nguyên behavior hiện tại
- `16:9`: giữ nguyên behavior hiện tại
- `4:5`: scale background image `300%`, crop quanh **anchor lấy từ hidden FG region của canonical 16:9 layout**
- `1:1`: scale background image `300%`, crop quanh **anchor lấy từ hidden FG region của canonical 16:9 layout**

---

## Canonical geometry model

### 1. Canonical frame

Dùng layout output `16:9` làm hệ quy chiếu chuẩn hóa `0..1`.

Mọi anchor dùng cho preview và backend đều phải xuất phát từ cùng hệ quy chiếu này.

### 2. Foreground rect trong canonical `16:9`

Với `inputRatio = '9:16'` và `outputRatio = '16:9'`, foreground hiện được đặt theo rule cố định trong `server/ffmpeg/buildCommand.ts`:

1. foreground cao full frame
2. foreground rộng theo tỷ lệ `9:16`
3. có horizontal padding
4. vị trí phụ thuộc `fgPosition = left/right`

Ký hiệu:

- `F = foregroundRect16x9`

### 3. Anchor region

Rule mới định nghĩa:

- `anchorRegion = F`

Lý do:

- trong layer stack, background nằm dưới foreground
- phần background nằm dưới `F` chính là vùng banner đang bị foreground che trong layout `16:9`
- với banner precomposed, đây được coi là vùng sạch hơn để zoom vào cho `4:5` / `1:1`

### 4. Anchor point

Lấy tâm của `anchorRegion`:

- `anchorX = F.x + F.w / 2`
- `anchorY = F.y + F.h / 2`

Vì `F` ăn full chiều cao canonical `16:9`, `anchorY` gần như luôn nằm ở trục giữa. Phần thay đổi chính là `anchorX` theo `fgPosition = left/right`.

---

## Rule crop mới

### Backend intent

Với `precomposed + input 9:16 + fg left/right + output 4:5/1:1`:

1. tính `foregroundRect16x9`
2. suy ra `anchorPoint` normalized từ rect đó
3. scale background image lên `300%`
4. dùng **kích thước thực sau scale** để tính crop window
5. crop `4:5` / `1:1` quanh `anchorPoint`
6. clamp để crop không vượt biên

Pseudo math:

```ts
cropX = clamp(anchorX * scaledBgWidth - targetW / 2, 0, scaledBgWidth - targetW)
cropY = clamp(anchorY * scaledBgHeight - targetH / 2, 0, scaledBgHeight - targetH)
```

Trong đó:

- `targetW,targetH = 1080x1350` cho `4:5`
- `targetW,targetH = 1080x1080` cho `1:1`

### Khác với implementation hiện tại

Code hiện tại đang dùng offset cố định:

```ts
cropX = w
cropY = scaledH - h
```

Rule này phải bị thay thế hoàn toàn trong nhánh áp dụng của plan mới.

---

## Rule preview frontend mới

### Mục tiêu

Preview FE phải phản ánh cùng anchor model với backend.

Không được tiếp tục dùng một rule CSS chung kiểu:

- `transform: scale(3)`
- `transform-origin: center bottom`

cho mọi case precomposed `4:5` / `1:1`, vì rule đó không còn đúng với logic mới.

### Preview behavior mới

Khi thỏa điều kiện của plan này:

1. preview xác định `foregroundRect16x9` từ cùng geometry model như backend
2. tính `anchorPoint` từ hidden FG region
3. scale background preview lên `3x`
4. đặt crop/position preview sao cho viewport `4:5` hoặc `1:1` nhìn vào đúng anchor đó

### Yêu cầu kỹ thuật cho preview

Frontend không nên chỉ dựa vào `transformOrigin` đơn giản nữa.

Nên có helper hình học dùng chung để trả về:

1. `foregroundRect16x9`
2. `anchorPoint`
3. crop window hoặc object-position tương ứng cho preview

Nếu cần để đạt parity tốt hơn, preview có thể phải dùng:

1. intrinsic image dimensions
2. explicit translate offsets sau scale
3. object-position / transform phối hợp

Mục tiêu là preview và backend cùng dùng **một model anchor**, không phải 2 heuristic khác nhau.

---

## Kiến trúc khuyến nghị

Để tránh mismatch FE/BE, nên tách geometry thành helper thuần tính toán.

### Gợi ý helper mới

Tạo một helper dùng chung hoặc hai helper mirror cùng logic, ví dụ:

- `shared/precomposedAnchor.ts`

Helper này nên chịu trách nhiệm:

1. nhận `inputRatio`, `fgPosition`, target ratio
2. xác định có áp dụng rule mới hay không
3. trả về `foregroundRect16x9`
4. trả về `anchorPoint`
5. trả về dữ liệu cần cho preview/backend crop

Nếu chưa muốn đặt trong `shared`, thì ít nhất FE và BE phải dùng cùng công thức copy chuẩn hóa, có test bảo vệ.

---

## File nên thay đổi

1. `server/ffmpeg/buildCommand.ts`
   - thay nhánh precomposed `4:5` / `1:1`
   - bỏ hardcoded crop offsets
   - dùng anchor derived from canonical 16:9 FG region

2. `src/App.tsx`
   - thay preview logic cho `precomposed + 4:5/1:1`
   - không còn hardcode `transformOrigin: 'center bottom'` cho mọi case

3. `src/render/overlay.ts`
   - không cần đổi layout overlay nếu overlay pipeline hiện vẫn đúng
   - chỉ đọc lại để đảm bảo logic logo/button vẫn khớp với canonical `16:9`

4. `test/build-command.test.ts`
   - thêm case cho `fgPosition = left/right`
   - verify crop rule mới thay đổi theo `fgPosition`

5. `BANNER_BACKGROUND_MODE_PLAN.md`
   - không sửa trong bước này
   - giữ làm baseline plan cũ

6. `PRECOMPOSED_BANNER_FG_REGION_ANCHOR_PLAN.md`
   - file plan mới này là source of truth cho hướng mới

### File có thể thêm mới

1. `shared/precomposedAnchor.ts`
2. test mới cho geometry helper nếu cần

---

## Implementation breakdown

### Bước 1. Chuẩn hóa geometry model

1. mô tả canonical `16:9` frame
2. mô tả foreground rect cho `input 9:16 -> output 16:9`
3. tách công thức cho `fgPosition = left/right`
4. sinh `anchorPoint` normalized từ `foregroundRect16x9`

### Bước 2. Đổi backend crop logic

1. phát hiện case áp dụng plan này
2. scale background image lên `300%`
3. tính crop từ `anchorPoint`, không dùng offset cố định
4. crop theo actual post-scale dimensions
5. clamp để tránh crop vượt biên

### Bước 3. Đổi preview frontend logic

1. phát hiện case áp dụng plan này
2. bỏ `center bottom` hardcode ở case áp dụng
3. tính same `anchorPoint`
4. scale background preview `3x`
5. dịch preview để viewport đang nhìn vào cùng vùng như backend sẽ crop

### Bước 4. Test và parity guard

1. thêm test backend cho `left/right`
2. nếu có helper geometry, thêm unit test cho helper
3. verify preview và backend cùng bám cùng anchor model

---

## QA / Verification

### A. Functional QA - Precomposed banner

Chuẩn bị banner precomposed có baked logo/button ở phía đối diện foreground.

#### Case 1: `fgPosition = left`

1. chọn `bgType = image`
2. chọn `backgroundImageMode = precomposed`
3. chọn `inputRatio = 9:16`
4. set `fgPosition = left`
5. verify `16:9` giữ nguyên behavior hiện tại
6. verify `4:5` crop quanh vùng hidden dưới FG-left
7. verify `1:1` crop quanh vùng hidden dưới FG-left

#### Case 2: `fgPosition = right`

1. chọn `bgType = image`
2. chọn `backgroundImageMode = precomposed`
3. chọn `inputRatio = 9:16`
4. set `fgPosition = right`
5. verify `16:9` giữ nguyên behavior hiện tại
6. verify `4:5` crop quanh vùng hidden dưới FG-right
7. verify `1:1` crop quanh vùng hidden dưới FG-right

### B. Preview parity QA

1. preview `4:5` gần khớp final render `4:5`
2. preview `1:1` gần khớp final render `1:1`
3. đổi `fgPosition` từ `left` sang `right` làm anchor preview thay đổi tương ứng
4. không có trường hợp preview đúng bên trái nhưng final render vẫn crop theo kiểu chung ở giữa hoặc đáy

### C. Regression QA

1. `clean` mode không đổi
2. `bgType = video` không đổi
3. `output 9:16` không đổi
4. `output 16:9` không đổi
5. overlay logo/button custom không bị scale theo background
6. queue submit/poll/download không bị ảnh hưởng

---

## Automated test expectations

### Backend tests

Thêm tối thiểu các case sau:

1. `precomposed + input 9:16 + fg left + output 4:5`
2. `precomposed + input 9:16 + fg left + output 1:1`
3. `precomposed + input 9:16 + fg right + output 4:5`
4. `precomposed + input 9:16 + fg right + output 1:1`

Kỳ vọng:

1. filter có scale `300%`
2. crop expression không còn hardcode kiểu `crop=...:1080:2700` cho mọi case
3. left/right cho ra anchor khác nhau

### Geometry tests

Nếu tạo helper geometry mới, test phải verify:

1. `fgPosition = left` trả về `anchorX` về phía trái
2. `fgPosition = right` trả về `anchorX` về phía phải
3. output `4:5` và `1:1` dùng cùng anchor source nhưng khác crop window

---

## Definition of Done

1. Rule mới chỉ áp dụng cho banner precomposed với `input 9:16`, `fgPosition left/right`, output `4:5/1:1`
2. Backend không còn dùng hardcoded lower-center crop offsets ở case áp dụng
3. Preview frontend dùng cùng anchor model với backend
4. Đổi `fgPosition left/right` làm crop anchor đổi tương ứng
5. `clean` mode giữ nguyên behavior cũ
6. `9:16` và `16:9` giữ nguyên behavior cũ
7. Automated tests pass
8. Manual QA với asset thật cho kết quả chấp nhận được

---

## Ghi chú mở rộng cho v2

Không làm trong plan này, nhưng có thể cân nhắc sau:

1. hỗ trợ `fgPosition = center`
2. thêm focal-point editor nếu hidden FG region không đủ tốt với mọi banner
3. cho phép tinh chỉnh riêng anchor của `4:5` và `1:1`
4. nếu parity preview cần chính xác hơn nữa, thêm explicit image-measurement flow ở frontend
