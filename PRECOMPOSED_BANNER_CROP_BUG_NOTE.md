# Precomposed Banner Crop Bug Note

## Tóm tắt

Implementation hiện tại của `backgroundImageMode = 'precomposed'` chưa crop đúng theo ý tưởng `lower-center` cho banner thực tế có input ratio `16:9` hoặc `9:16`.

Vấn đề nằm ở việc nhánh FFmpeg mới trong `server/ffmpeg/buildCommand.ts` dùng offset crop cố định, trong khi cùng lúc lại dùng `force_original_aspect_ratio=increase`.

## File bị ảnh hưởng

1. `server/ffmpeg/buildCommand.ts`
2. `test/build-command.test.ts`

## Logic hiện tại

Với `precomposed` và output `4:5` / `1:1`, code đang làm:

1. scale ảnh nền lên `w * 3` và `h * 3`
2. crop với offset cố định:
   - `cropX = w`
   - `cropY = scaledH - h`

Ví dụ đoạn hiện tại:

```ts
const scaledW = w * 3;
const scaledH = h * 3;
const cropX = w;
const cropY = scaledH - h;
```

## Vì sao sai

Filter cũng đang dùng:

```ts
force_original_aspect_ratio=increase
```

Điều này có nghĩa là kích thước thực tế sau scale có thể lớn hơn `scaledW` hoặc `scaledH` tùy theo tỷ lệ gốc của banner.

Do đó:

1. `cropX = w` không đại diện cho horizontal center thật
2. `cropY = scaledH - h` không đại diện cho bottom alignment thật trong mọi trường hợp

## Ví dụ lỗi

### Case 1: source 16:9 -> output 4:5

- output: `1080x1350`
- code đặt scale target: `3240x4050`
- nhưng với `force_original_aspect_ratio=increase`, source `16:9` sẽ thành khoảng `7200x4050`
- center crop đúng phải có:
  - `x = (7200 - 1080) / 2 = 3060`
- code hiện tại lại dùng:
  - `x = 1080`

=> crop lệch trái, không phải lower-center thật.

### Case 2: source 9:16 -> output 1:1

- output: `1080x1080`
- code đặt scale target: `3240x3240`
- nhưng source `9:16` với `increase` sẽ thành khoảng `3240x5760`
- bottom-aligned crop đúng phải có:
  - `y = 5760 - 1080 = 4680`
- code hiện tại lại dùng:
  - `y = 2160`

=> crop không nằm ở phần đáy thật.

## Hệ quả

1. Output FFmpeg có thể không đẩy phần logo/button baked sẵn ra khỏi khung như mong muốn
2. Preview frontend và output final có thể cùng sai theo một rule, nhưng vẫn không đúng với intent sản phẩm
3. Banner thực tế `9:16` và `16:9` sẽ cho kết quả composition không ổn định

## Vấn đề ở test hiện tại

`test/build-command.test.ts` đang assert đúng các hằng số sai của implementation hiện tại, ví dụ:

1. `crop=1080:1350:1080:2700`
2. `crop=1080:1080:1080:2160`

Các test này chỉ chứng minh code đang sinh đúng chuỗi hiện tại, không chứng minh crop thực sự là `lower-center` với source banner thật.

## Hướng sửa

1. Tính crop theo kích thước thực tế sau scale, không dùng offset cố định dựa trên `w` và `h * 3`
2. Dùng crop expression theo dimensions sau scale để thể hiện đúng:
   - center-x
   - bottom-y hoặc lower-y
3. Cập nhật test để verify rule/biểu thức crop đúng intent, thay vì khóa vào các số hardcoded hiện tại

## Trạng thái

- Đây là ghi chú checkpoint để quay lại sửa tiếp.
- Chưa sửa bug trong note này.
