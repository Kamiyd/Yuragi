/* 最小 MP4 封装 —— 把 WebCodecs 编好的 H.264 样本装进一个能播的 .mp4。
 *
 * 只做「一条视频轨、无 B 帧、全部样本装在一个 chunk 里」这一种情况，因为我们
 * 的输入就是这一种：自己一帧一帧渲出来、按时间戳顺序交给 VideoEncoder。
 * 所以不需要 ctts（没有重排）、不需要 edts、不需要分片。
 *
 * 盒子的顺序是 ftyp | mdat | moov —— mdat 在前，样本偏移在写 moov 之前就定了，
 * 不用回填。moov 在末尾播放器一样认（要边下边播才需要 faststart，本地文件不用）。
 *
 * 跟 gif.ts、跟导出 ZIP 是同一个取舍：宁可自己写这两百行，也不为一个容器格式
 * 拉一个依赖 —— 何况这个项目的 npm 装依赖本来就卡在 pikaicons 的 peer 上。
 */

export type Mp4Sample = {
  data: Uint8Array;      // 长度前缀（AVCC）格式的一帧，不是 Annex B
  timestamp: number;     // 微秒，跟 VideoEncoder 的时间戳一致
  duration: number;      // 微秒
  key: boolean;
};

const TIMESCALE = 1_000_000;   // 直接用微秒，省掉一次换算和它带来的漂移

class Bytes {
  private parts: number[] = [];

  u8(value: number) { this.parts.push(value & 0xff); return this; }
  u16(value: number) { return this.u8(value >> 8).u8(value); }
  u32(value: number) { return this.u16(value >>> 16).u16(value & 0xffff); }
  str(text: string) { for (const ch of text) this.u8(ch.charCodeAt(0)); return this; }
  zero(count: number) { for (let i = 0; i < count; i++) this.u8(0); return this; }
  raw(data: ArrayLike<number>) { for (let i = 0; i < data.length; i++) this.u8(data[i]); return this; }
  get() { return new Uint8Array(this.parts); }
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const part of payload) size += part.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of payload) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 单位矩阵，tkhd / mvhd 都要写一份 */
function matrix() {
  return new Bytes()
    .u32(0x00010000).u32(0).u32(0)
    .u32(0).u32(0x00010000).u32(0)
    .u32(0).u32(0).u32(0x40000000)
    .get();
}

function ftyp() {
  return box("ftyp", new Bytes().str("isom").u32(512).str("isom").str("iso2").str("avc1").str("mp41").get());
}

function mvhd(duration: number) {
  return box("mvhd", new Bytes()
    .u32(0)                       // version + flags
    .u32(0).u32(0)                // 创建 / 修改时间
    .u32(TIMESCALE).u32(duration)
    .u32(0x00010000)              // rate 1.0
    .u16(0x0100)                  // volume 1.0
    .zero(2).zero(8)
    .raw(matrix())
    .zero(24)                     // pre_defined
    .u32(2)                       // next_track_id
    .get());
}

function tkhd(width: number, height: number, duration: number) {
  return box("tkhd", new Bytes()
    .u32(0x00000007)              // version 0，flags = enabled | in movie | in preview
    .u32(0).u32(0)
    .u32(1)                       // track_id
    .zero(4)
    .u32(duration)
    .zero(8)
    .u16(0)                       // layer
    .u16(0)                       // alternate_group
    .u16(0)                       // volume：视频轨是 0
    .zero(2)
    .raw(matrix())
    .u32(width << 16).u32(height << 16)
    .get());
}

function mdhd(duration: number) {
  return box("mdhd", new Bytes()
    .u32(0).u32(0).u32(0)
    .u32(TIMESCALE).u32(duration)
    .u16(0x55c4)                  // language = und
    .u16(0)
    .get());
}

function hdlr() {
  return box("hdlr", new Bytes()
    .u32(0).u32(0)
    .str("vide")
    .zero(12)
    .str("VideoHandler").u8(0)
    .get());
}

function avc1(width: number, height: number, description: Uint8Array) {
  const entry = new Bytes()
    .zero(6).u16(1)               // reserved + data_reference_index
    .u16(0).u16(0).zero(12)       // pre_defined / reserved
    .u16(width).u16(height)
    .u32(0x00480000).u32(0x00480000)   // 72dpi
    .zero(4)
    .u16(1)                       // frame_count
    .zero(32)                     // compressorname
    .u16(0x0018)                  // depth
    .u16(0xffff)                  // pre_defined = -1
    .get();
  return box("avc1", entry, box("avcC", description));
}

/** 时长表：连着几帧一样长就并成一条 */
function stts(samples: Mp4Sample[]) {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < samples.length; i++) {
    const delta = i + 1 < samples.length
      ? samples[i + 1].timestamp - samples[i].timestamp
      : samples[i].duration;
    const last = runs[runs.length - 1];
    if (last && last[1] === delta) last[0]++;
    else runs.push([1, delta]);
  }
  const bytes = new Bytes().u32(0).u32(runs.length);
  for (const [count, delta] of runs) bytes.u32(count).u32(delta);
  return box("stts", bytes.get());
}

function stss(samples: Mp4Sample[]) {
  const keys: number[] = [];
  samples.forEach((sample, index) => { if (sample.key) keys.push(index + 1); });
  const bytes = new Bytes().u32(0).u32(keys.length);
  for (const key of keys) bytes.u32(key);
  return box("stss", bytes.get());
}

function stsz(samples: Mp4Sample[]) {
  const bytes = new Bytes().u32(0).u32(0).u32(samples.length);
  for (const sample of samples) bytes.u32(sample.data.length);
  return box("stsz", bytes.get());
}

export function muxMp4({ width, height, description, samples }: {
  width: number;
  height: number;
  description: Uint8Array;
  samples: Mp4Sample[];
}): Uint8Array<ArrayBuffer> {
  if (!samples.length) throw new Error("没有可写的帧");
  for (let i = 1; i < samples.length; i++) {
    // 有 B 帧的话解码顺序跟显示顺序不一样，得写 ctts 才对 —— 这里不支持，
    // 与其出一个时间轴错乱的文件，不如直接说不行。
    if (samples[i].timestamp < samples[i - 1].timestamp) {
      throw new Error("编码器输出了乱序的帧（有 B 帧），这个封装器不支持");
    }
  }

  const duration = samples[samples.length - 1].timestamp
    + samples[samples.length - 1].duration - samples[0].timestamp;

  let payloadSize = 0;
  for (const sample of samples) payloadSize += sample.data.length;
  const mdat = new Uint8Array(8 + payloadSize);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);   // "mdat"
  let at = 8;
  for (const sample of samples) {
    mdat.set(sample.data, at);
    at += sample.data.length;
  }

  const head = ftyp();
  const dataOffset = head.length + 8;      // 样本都在一个 chunk 里，起点就是 mdat 的数据区

  const stbl = box("stbl",
    box("stsd", new Bytes().u32(0).u32(1).get(), avc1(width, height, description)),
    stts(samples),
    stss(samples),
    box("stsc", new Bytes().u32(0).u32(1).u32(1).u32(samples.length).u32(1).get()),
    stsz(samples),
    box("stco", new Bytes().u32(0).u32(1).u32(dataOffset).get()),
  );
  const minf = box("minf",
    box("vmhd", new Bytes().u32(0x00000001).u16(0).zero(6).get()),
    box("dinf", box("dref", new Bytes().u32(0).u32(1).get(), box("url ", new Bytes().u32(1).get()))),
    stbl,
  );
  const moov = box("moov",
    mvhd(duration),
    box("trak", tkhd(width, height, duration), box("mdia", mdhd(duration), hdlr(), minf)),
  );

  const out = new Uint8Array(new ArrayBuffer(head.length + mdat.length + moov.length));
  out.set(head, 0);
  out.set(mdat, head.length);
  out.set(moov, head.length + mdat.length);
  return out;
}
