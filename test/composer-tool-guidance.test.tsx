import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerToolGuidance } from '../src/composer/HookComposerPage.tsx';

const render = (tool: 'insert' | 'trim' | 'crop') => renderToStaticMarkup(
  <ComposerToolGuidance tool={tool} originalDuration={8.041} maxHookDuration={2.035} />,
);

test('insert guidance names the insertion range of the active original', () => {
  const html = render('insert');
  assert.match(html, /Chèn hook/);
  assert.match(html, /0–8\.041s/, 'the insertion point is bounded by the original duration');
  assert.match(html, /phần gốc trước điểm chèn, rồi hook, rồi phần gốc còn lại/);
  assert.match(html, /vùng trim tự nới/);
});

test('trim guidance states the combined length and both trim limits', () => {
  const html = render('trim');
  assert.match(html, /Cắt đoạn xuất ra/);
  // The timeline runs over the combined original + hook length, not the original alone.
  assert.match(html, /10\.076s/);
  assert.match(html, /Trim start không vượt quá điểm chèn/);
  assert.match(html, /Trim end\s+không lùi trước lúc hook kết thúc/);
});

test('crop guidance sends the user back to the Sources step', () => {
  const html = render('crop');
  assert.match(html, /Khung 9:16/);
  assert.match(html, /không làm thay đổi file gốc/);
  assert.match(html, /quay lại bước Sources/);
});

test('only the tools that edit a configuration warn about losing the reviewed mark', () => {
  const reviewedNote = /bỏ dấu đã kiểm tra/;
  assert.match(render('insert'), reviewedNote);
  assert.match(render('trim'), reviewedNote);
  // Crop is read-only here, so it changes no configuration and clears no review.
  assert.doesNotMatch(render('crop'), reviewedNote);
});

test('each tool renders only its own guidance', () => {
  assert.doesNotMatch(render('insert'), /Cắt đoạn xuất ra|Khung 9:16/);
  assert.doesNotMatch(render('trim'), /Chèn hook|Khung 9:16/);
  assert.doesNotMatch(render('crop'), /Chèn hook|Cắt đoạn xuất ra/);
});

test('guidance durations follow the active variation rather than being hardcoded', () => {
  const html = renderToStaticMarkup(
    <ComposerToolGuidance tool="trim" originalDuration={5.038} maxHookDuration={4.037} />,
  );
  assert.match(html, /9\.075s/);
  assert.doesNotMatch(html, /10\.076s/);
});
