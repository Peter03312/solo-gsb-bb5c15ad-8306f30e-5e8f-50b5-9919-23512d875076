'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const approx = (a, b, eps = 0.05) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !=~ ${b}（容差 ${eps}）`);

const dbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'cue-rooms-')),
  'test.db'
);
process.env.DB_PATH = dbPath;
process.env.PORT = '0';

let app;
let server;
let base;

function http(method, urlPath, body) {
  return fetch(base + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, data };
  });
}

before(async () => {
  app = require('../server.js');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// 建一盏灯 + 一条 10 秒线性渐变 Cue，发布为版本 1；再准备空数据的版本 2
async function seedVersions() {
  await http('POST', '/api/lights', { name: '面光1' });
  await http('POST', '/api/cues', { light_id: 1, time: 0, target: 100, duration: 10 });
  const v1 = await http('POST', '/api/versions', { label: '联排版' });
  assert.equal(v1.status, 201);
  assert.equal(v1.data.id, 1);
}

test('创建房间：无效/不存在的版本明确报错', async () => {
  let r = await http('POST', '/api/rooms', { version_id: 'abc' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /版本编号无效/);

  r = await http('POST', '/api/rooms', { version_id: 99 });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /版本不存在/);
});

test('基于已发布版本创建房间，返回房间码、控制密钥与版本快照', async () => {
  await seedVersions();
  const r = await http('POST', '/api/rooms', { version_id: 1, label: 'unused' });
  assert.equal(r.status, 201);
  assert.match(r.data.code, /^[0-9A-Z]{6}$/);
  assert.match(r.data.control_key, /^[0-9a-f]{48}$/);
  assert.equal(r.data.revision, 0);
  assert.equal(r.data.playing, false);
  approx(r.data.time, 0);
  assert.equal(r.data.speed, 1);
  approx(r.data.duration, 10);
  assert.equal(r.data.version.id, 1);
  assert.equal(r.data.lights.length, 1);
  assert.equal(r.data.cues.length, 1);
  // 房间码唯一：再建一个不同码
  const r2 = await http('POST', '/api/rooms', { version_id: 1 });
  assert.equal(r2.status, 201);
  assert.notEqual(r2.data.code, r.data.code);
});

test('观看者凭房间码加入；错误房间码明确报错', async () => {
  const created = await http('POST', '/api/rooms', { version_id: 1 });
  const code = created.data.code;

  // 小写房间码也能加入（统一大写）
  const joined = await http('GET', `/api/rooms/${code.toLowerCase()}`);
  assert.equal(joined.status, 200);
  assert.equal(joined.data.code, code);
  assert.equal(joined.data.time, created.data.time);
  assert.equal('control_key' in joined.data, false); // 观看响应不泄露控制密钥

  for (const bad of ['ZZZZZZ', 'abc', 'ABCDEFG', 'AB-DE1']) {
    const rr = await rawGet(bad);
    assert.notEqual(rr.status, 200, `${bad} 不应成功`);
    assert.match(rr.data.error, bad === 'ZZZZZZ' ? /房间不存在/ : /房间码无效/);
  }
});

// 直接按原始路径发 GET（编码后原样）
async function rawGet(code) {
  const res = await fetch(`${base}/api/rooms/${code}`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('控制：缺密钥/错密钥被拒绝（403），观看者不能控制', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code } = room.data;

  let r = await http('POST', `/api/rooms/${code}/control`, { revision: 0, action: 'play' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /缺少控制密钥/);

  r = await http('POST', `/api/rooms/${code}/control`, {
    revision: 0, action: 'play', control_key: 'deadbeef'.repeat(6),
  });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /控制密钥无效/);

  // 房间不存在
  r = await http('POST', '/api/rooms/ZZZZZZ/control', {
    revision: 0, action: 'play', control_key: room.data.control_key,
  });
  assert.equal(r.status, 404);
});

test('控制：修订号必须携带、合法；过期返回 409 且不改房间', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code, control_key } = room.data;
  const ctrl = (body) =>
    http('POST', `/api/rooms/${code}/control`, { control_key, ...body });

  let r = await ctrl({ action: 'play' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /必须携带当前修订号/);

  r = await ctrl({ revision: -1, action: 'play' });
  assert.equal(r.status, 400);

  r = await ctrl({ revision: 5, action: 'play' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /修订号冲突/);

  // 成功播放后修订号 +1
  r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.data.revision, 1);
  assert.equal(r.data.playing, true);

  // 立即暂停：旧修订号 0 过期
  r = await ctrl({ revision: 0, action: 'pause' });
  assert.equal(r.status, 409);
  r = await ctrl({ revision: 1, action: 'pause' });
  assert.equal(r.status, 200);
  assert.equal(r.data.revision, 2);
  assert.equal(r.data.playing, false);
});

test('播放：服务端按墙钟推算时码；到版本末尾自动停住', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code, control_key } = room.data;
  const ctrl = (body) =>
    http('POST', `/api/rooms/${code}/control`, { control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  await sleep(300);
  r = await http('GET', `/api/rooms/${code}`);
  assert.equal(r.data.playing, true);
  assert.ok(r.data.time > 0.1 && r.data.time < 1, `推进时码异常：${r.data.time}`);

  // 房间时长仅 10 秒：等待越过末尾，服务端自动停住并持久化
  // 直接把时码跳到 9.8 后播放，缩短等待
  await ctrl({ revision: r.data.revision, action: 'seek', time: 9.8 });
  await ctrl({ revision: r.data.revision + 1, action: 'play' });
  await sleep(400);
  r = await http('GET', `/api/rooms/${code}`);
  assert.equal(r.data.playing, false, '到末尾应自动停住');
  approx(r.data.time, 10);
  assert.equal(r.data.ended, true);

  // 停住后再按播放：从头开始（修订号继续自增，房间仍可用）
  const rev = r.data.revision;
  r = await ctrl({ revision: rev, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.data.playing, true);
  approx(r.data.time, 0);
});

test('跳转：负数/非数字时码 400 且不改房间；越界时码夹到末尾', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code, control_key } = room.data;
  const ctrl = (body) =>
    http('POST', `/api/rooms/${code}/control`, { control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'seek', time: -2 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /非法时码/);

  r = await ctrl({ revision: 0, action: 'seek', time: 'oops' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /非法时码/);

  // 被拒后房间仍停在修订号 0
  r = await http('GET', `/api/rooms/${code}`);
  assert.equal(r.data.revision, 0);
  approx(r.data.time, 0);

  r = await ctrl({ revision: 0, action: 'seek', time: 42 });
  assert.equal(r.status, 200);
  assert.equal(r.data.playing, false);
  approx(r.data.time, 10);
});

test('速度：仅接受现有 0.5/1/2；变速不跳时码', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code, control_key } = room.data;
  const ctrl = (body) =>
    http('POST', `/api/rooms/${code}/control`, { control_key, ...body });

  for (const bad of [0.25, 1.5, 3, 0, 'fast']) {
    const r = await ctrl({ revision: 0, action: 'speed', speed: bad });
    assert.equal(r.status, 400, `速度 ${bad} 应被拒绝`);
    assert.match(r.data.error, /无效速度/);
  }

  await ctrl({ revision: 0, action: 'seek', time: 4 });
  let r = await ctrl({ revision: 1, action: 'speed', speed: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.speed, 2);
  approx(r.data.time, 4); // 变速瞬间时码不变

  // 2 倍速播放 0.3 秒墙钟，时码推进约 0.6 秒
  await ctrl({ revision: 2, action: 'play' });
  await sleep(300);
  r = await http('GET', `/api/rooms/${code}`);
  assert.equal(r.data.speed, 2);
  assert.ok(r.data.time > 4.4 && r.data.time < 6, `2 倍速推进异常：${r.data.time}`);
});

test('房间固定创建时版本：之后改草稿、发布新版本均不影响房间', async () => {
  const room = await http('POST', '/api/rooms', { version_id: 1 });
  const { code } = room.data;

  // 改草稿：改 Cue 目标并新增灯具，再发布版本 2
  const cues = (await http('GET', '/api/cues')).data;
  await http('PATCH', `/api/cues/${cues[0].id}`, {
    cue_no: cues[0].cue_no, light_id: 1, time: 0, target: 10, duration: 0,
  });
  await http('POST', '/api/lights', { name: '侧光L' });
  const v2 = await http('POST', '/api/versions', { label: '改版' });
  assert.equal(v2.status, 201);
  assert.equal(v2.data.id, 2);

  const r = await http('GET', `/api/rooms/${code}`);
  assert.equal(r.data.version.id, 1);
  assert.equal(r.data.lights.length, 1); // 仍是版本 1 的一灯
  assert.equal(r.data.cues.length, 1);
  assert.equal(r.data.cues[0].target, 100);
  assert.equal(r.data.cues[0].duration, 10);
});

test('服务重启后房间进度恢复（暂停状态与播放锚点均持久）', async () => {
  // 房间 A：跳到 6.25 秒暂停
  const roomA = await http('POST', '/api/rooms', { version_id: 1 });
  let r = await http('POST', `/api/rooms/${roomA.data.code}/control`, {
    control_key: roomA.data.control_key, revision: 0, action: 'seek', time: 6.25,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.playing, false);

  // 房间 B：从 2 秒开始 0.5 倍速播放
  const roomB = await http('POST', '/api/rooms', { version_id: 1 });
  await http('POST', `/api/rooms/${roomB.data.code}/control`, {
    control_key: roomB.data.control_key, revision: 0, action: 'seek', time: 2,
  });
  await http('POST', `/api/rooms/${roomB.data.code}/control`, {
    control_key: roomB.data.control_key, revision: 1, action: 'speed', speed: 0.5,
  });
  await http('POST', `/api/rooms/${roomB.data.code}/control`, {
    control_key: roomB.data.control_key, revision: 2, action: 'play',
  });

  // 模拟服务重启：清掉模块缓存后用同一个 DB_PATH 重新载入
  server.close();
  delete require.cache[require.resolve('../server.js')];
  delete require.cache[require.resolve('../src/db.js')];
  app = require('../server.js');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  r = await http('GET', `/api/rooms/${roomA.data.code}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.playing, false);
  approx(r.data.time, 6.25, 1e-6);
  assert.equal(r.data.revision, 1);

  r = await http('GET', `/api/rooms/${roomB.data.code}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.playing, true);
  assert.equal(r.data.speed, 0.5);
  assert.ok(r.data.time >= 2, `重启后播放进度异常：${r.data.time}`);
});
