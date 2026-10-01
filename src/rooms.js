'use strict';

/*
 * 共享排演房间：服务端时钟推算逻辑（纯函数，无数据库/网络依赖，浏览器与 Node 均可用）。
 *
 * 房间只保存“锚点状态”而不保存每一帧的时码：
 *  - playing=false（暂停）：当前时码恒为 base_time；
 *  - playing=true（播放）：当前时码 = base_time + (now - anchor) * speed，
 *    到达版本末尾 duration 即视为自动停住（playing 转 false、时码固定在 duration）。
 * 因此页面刷新、服务重启、观看者重连后，只需读回锚点状态即可恢复进度。
 */

// 现有播放器支持的倍速
const SPEEDS = [0.5, 1, 2];

function isValidSpeed(n) {
  return typeof n === 'number' && Number.isFinite(n) && SPEEDS.some((s) => s === n);
}

function round6(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

// 房间码为 6 位大写字母数字（创建时生成，不含易混的 0/O/1/I）；
// 调用方可传小写，统一转大写；格式不符返回 null。
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase();
  return /^[0-9A-Z]{6}$/.test(code) ? code : null;
}

/**
 * 由房间锚点状态推算 now（秒，UNIX 时间）时刻的播放状态。
 * row：{ playing(0/1 或布尔), base_time, anchor, speed, duration }
 * 返回 { time, playing, ended }：
 *  - time：当前演出时码（秒，已夹到 [0, duration]）；
 *  - playing：此刻是否仍在播放（到末尾自动停住后为 false）；
 *  - ended：是否已停在版本末尾（控制器再按播放即从头开始）。
 */
function derive(row, now) {
  const duration = Number(row.duration) || 0;
  if (!row.playing) {
    const time = Math.min(Math.max(Number(row.base_time) || 0, 0), duration);
    return { time: round6(time), playing: false, ended: time >= duration };
  }
  let t = (Number(row.base_time) || 0) + (now - Number(row.anchor)) * Number(row.speed);
  if (t >= duration) {
    return { time: round6(duration), playing: false, ended: true };
  }
  if (t < 0) t = 0;
  return { time: round6(t), playing: true, ended: false };
}

/**
 * 计算一次控制动作后的新锚点状态。
 * action：'play' | 'pause' | 'seek' | 'speed'
 * params：{ time?（seek 目标时码，秒）, speed?（speed 新倍速） }
 * 成功返回 { values: { playing(0/1), base_time, anchor, speed } }（修订号由调用方自增）；
 * 参数非法返回 { error }，调用方据此返回 400 且不改房间。
 */
function applyAction(row, action, params, now) {
  const duration = Number(row.duration) || 0;
  const cur = derive(row, now);
  const speed = Number(row.speed) || 1;

  if (action === 'play') {
    // 已停在末尾再按播放：从头开始；0 时长版本无内容可播，保持暂停在 0
    const base = cur.ended ? 0 : cur.time;
    return {
      values: { playing: duration > 0 ? 1 : 0, base_time: base, anchor: now, speed },
    };
  }

  if (action === 'pause') {
    return { values: { playing: 0, base_time: cur.time, anchor: now, speed } };
  }

  if (action === 'seek') {
    const t = params.time;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      return { error: `非法时码：${JSON.stringify(params.time)}（须为非负数字秒数）` };
    }
    const clamped = Math.min(t, duration); // 沿用播放器既有行为：越过末尾则落在末尾
    // 播放中跳到末尾即停住；其余情况沿用原播放/暂停状态
    const keepPlaying = !!row.playing && duration > 0 && clamped < duration;
    return {
      values: { playing: keepPlaying ? 1 : 0, base_time: clamped, anchor: now, speed },
    };
  }

  if (action === 'speed') {
    const n = params.speed;
    if (!isValidSpeed(n)) {
      return { error: `无效速度：${JSON.stringify(params.speed)}（仅支持现有的 0.5、1、2 倍速）` };
    }
    // 先按当前时码重锚，再换倍速：变速不跳时码
    return { values: { playing: row.playing ? 1 : 0, base_time: cur.time, anchor: now, speed: n } };
  }

  return { error: `未知控制动作：${JSON.stringify(action)}（须为 play、pause、seek、speed 之一）` };
}

module.exports = { SPEEDS, isValidSpeed, normalizeCode, derive, applyAction };
