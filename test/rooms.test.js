'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Rooms = require('../src/rooms.js');

const approx = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !=~ ${b}`);

// 时长 10 秒的房间锚点
const row = (overrides = {}) => ({
  playing: 0,
  base_time: 0,
  anchor: 1000,
  speed: 1,
  duration: 10,
  ...overrides,
});

test('暂停状态：当前时码恒为基准时码（与墙钟无关）', () => {
  const r = row({ playing: 0, base_time: 3.5, anchor: 1000 });
  for (const now of [0, 1000, 2000]) {
    const d = Rooms.derive(r, now);
    assert.equal(d.playing, false);
    approx(d.time, 3.5);
    assert.equal(d.ended, false);
  }
});

test('播放状态：按经过墙钟 × 速度推算当前时码', () => {
  const r = row({ playing: 1, base_time: 2, anchor: 1000, speed: 1 });
  approx(Rooms.derive(r, 1000).time, 2);
  approx(Rooms.derive(r, 1003).time, 5);
  assert.equal(Rooms.derive(r, 1003).playing, true);

  // 2 倍速：3 秒墙钟推进 6 秒时码
  const r2 = row({ playing: 1, base_time: 0, anchor: 1000, speed: 2 });
  approx(Rooms.derive(r2, 1003).time, 6);

  // 0.5 倍速：4 秒墙钟推进 2 秒时码
  const rHalf = row({ playing: 1, base_time: 0, anchor: 1000, speed: 0.5 });
  approx(Rooms.derive(rHalf, 1004).time, 2);
});

test('到版本末尾自动停住：playing 转 false、时码固定在 duration', () => {
  const r = row({ playing: 1, base_time: 0, anchor: 1000, speed: 1, duration: 10 });
  const atEnd = Rooms.derive(r, 1010);
  approx(atEnd.time, 10);
  assert.equal(atEnd.playing, false);
  assert.equal(atEnd.ended, true);
  // 之后墙钟继续走也停在末尾
  const later = Rooms.derive(r, 9999);
  approx(later.time, 10);
  assert.equal(later.playing, false);
  assert.equal(later.ended, true);
});

test('暂停在末尾也算 ended（如 seek 到末尾）；从头播放后 ended 清除', () => {
  const r = row({ playing: 0, base_time: 10, anchor: 1000 });
  assert.equal(Rooms.derive(r, 1000).ended, true);
  const play = Rooms.applyAction(r, 'play', {}, 2000).values;
  assert.equal(play.playing, 1);
  approx(play.base_time, 0);
  assert.equal(play.anchor, 2000);
});

test('play：中途播放以当前时码重锚；无时长版本保持暂停在 0', () => {
  const paused = row({ playing: 0, base_time: 4, anchor: 1000, speed: 2 });
  const v = Rooms.applyAction(paused, 'play', {}, 1500).values;
  assert.equal(v.playing, 1);
  approx(v.base_time, 4);
  assert.equal(v.anchor, 1500);
  assert.equal(v.speed, 2); // 倍速沿用

  const zero = row({ playing: 0, base_time: 0, duration: 0 });
  const vz = Rooms.applyAction(zero, 'play', {}, 1500).values;
  assert.equal(vz.playing, 0);
  approx(vz.base_time, 0);
});

test('pause：把推算出的当前时码固化为基准时码', () => {
  const playing = row({ playing: 1, base_time: 2, anchor: 1000, speed: 1 });
  const v = Rooms.applyAction(playing, 'pause', {}, 1003).values;
  assert.equal(v.playing, 0);
  approx(v.base_time, 5);
  assert.equal(v.anchor, 1003);
});

test('seek：非负时码夹到版本末尾；播放中跳到末尾即停住', () => {
  const playing = row({ playing: 1, base_time: 0, anchor: 1000, speed: 1 });
  let v = Rooms.applyAction(playing, 'seek', { time: 7 }, 1002).values;
  assert.equal(v.playing, 1); // 继续播放
  approx(v.base_time, 7);
  assert.equal(v.anchor, 1002);

  // 越过末尾：落在末尾并停住（沿用播放器既有夹取行为）
  v = Rooms.applyAction(playing, 'seek', { time: 99 }, 1002).values;
  assert.equal(v.playing, 0);
  approx(v.base_time, 10);

  // 暂停态 seek 不改变播放/暂停
  const paused = row({ playing: 0, base_time: 1 });
  v = Rooms.applyAction(paused, 'seek', { time: 6 }, 1002).values;
  assert.equal(v.playing, 0);
  approx(v.base_time, 6);
});

test('非法时码、速度、动作明确报错且不改房间', () => {
  const r = row();
  assert.ok(Rooms.applyAction(r, 'seek', { time: -1 }, 1).error.includes('非法时码'));
  assert.ok(Rooms.applyAction(r, 'seek', { time: 'x' }, 1).error.includes('非法时码'));
  assert.ok(Rooms.applyAction(r, 'seek', { time: NaN }, 1).error.includes('非法时码'));
  assert.ok(Rooms.applyAction(r, 'speed', { speed: 3 }, 1).error.includes('无效速度'));
  assert.ok(Rooms.applyAction(r, 'speed', { speed: 0 }, 1).error.includes('无效速度'));
  assert.ok(Rooms.applyAction(r, 'rewind', {}, 1).error.includes('未知控制动作'));
});

test('speed：变速不跳时码——先按当前时码重锚再换倍速', () => {
  const playing = row({ playing: 1, base_time: 0, anchor: 1000, speed: 1 });
  const v = Rooms.applyAction(playing, 'speed', { speed: 2 }, 1004).values;
  assert.equal(v.playing, 1);
  approx(v.base_time, 4);
  assert.equal(v.anchor, 1004);
  assert.equal(v.speed, 2);
  // 再走 3 秒墙钟：推进 6 秒时码
  approx(Rooms.derive({ ...row(), ...v }, 1007).time, 10); // 到末尾自动停住
});

test('房间码：小写转大写、须为 6 位字母数字', () => {
  assert.equal(Rooms.normalizeCode('ab3k9z'), 'AB3K9Z');
  assert.equal(Rooms.normalizeCode('AbCdEf'), 'ABCDEF');
  assert.equal(Rooms.normalizeCode('ABCDE'), null);
  assert.equal(Rooms.normalizeCode('ABCDEFG'), null);
  assert.equal(Rooms.normalizeCode('AB-DE1'), null);
  assert.equal(Rooms.normalizeCode(123456), null);
  assert.equal(Rooms.normalizeCode(null), null);
});

test('isValidSpeed：仅 0.5/1/2 合法', () => {
  for (const s of [0.5, 1, 2]) assert.equal(Rooms.isValidSpeed(s), true);
  for (const s of [0, 0.25, 1.5, 3, NaN, Infinity]) assert.equal(Rooms.isValidSpeed(s), false);
});
