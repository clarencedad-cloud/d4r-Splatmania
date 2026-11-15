// OpenEXR writer (scanline, ZIP compression): RGBA as half floats plus an
// optional Z channel (32-bit float, camera depth in scene units) for
// compositing (Nuke, After Effects, Resolve / Fusion, Blender).
//
// Colour comes from the 8-bit render (the same pixels as PNG, with look,
// titles and fades), converted to linear light with premultiplied alpha,
// as EXR expects. Values above 1 (HDR) are not kept.

// float -> IEEE half (round to nearest)
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const toHalf = (value: number) => {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = ((x >>> 23) & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (exp >= 31) {
        // overflow, inf, nan
        return sign | 0x7c00 | (((x >>> 23) & 0xff) === 0xff && mant ? 0x200 : 0);
    }
    if (exp <= 0) {
        if (exp < -10) return sign;
        mant |= 0x800000;
        const shift = 14 - exp;
        let half = mant >> shift;
        if ((mant >> (shift - 1)) & 1) half++;
        return sign | half;
    }
    let half = sign | (exp << 10) | (mant >> 13);
    if (mant & 0x1000) half++;
    return half;
};

// 8-bit sRGB -> linear
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

class ByteWriter {
    private parts: Uint8Array[] = [];
    private cur = new Uint8Array(1024);
    private view = new DataView(this.cur.buffer);
    private pos = 0;
    length = 0;

    private ensure(n: number) {
        if (this.pos + n <= this.cur.length) return;
        this.parts.push(this.cur.subarray(0, this.pos));
        this.cur = new Uint8Array(Math.max(1024, n));
        this.view = new DataView(this.cur.buffer);
        this.pos = 0;
    }

    u8(v: number) {
        this.ensure(1);
        this.cur[this.pos++] = v;
        this.length++;
    }

    i32(v: number) {
        this.ensure(4);
        this.view.setInt32(this.pos, v, true);
        this.pos += 4;
        this.length += 4;
    }

    u64(v: number) {
        this.ensure(8);
        this.view.setUint32(this.pos, v % 0x100000000, true);
        this.view.setUint32(this.pos + 4, Math.floor(v / 0x100000000), true);
        this.pos += 8;
        this.length += 8;
    }

    f32(v: number) {
        this.ensure(4);
        this.view.setFloat32(this.pos, v, true);
        this.pos += 4;
        this.length += 4;
    }

    str(s: string) {
        for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0x7f);
        this.u8(0);
    }

    bytes(b: Uint8Array) {
        this.parts.push(this.cur.subarray(0, this.pos));
        this.parts.push(b);
        this.length += b.length;
        this.cur = new Uint8Array(1024);
        this.view = new DataView(this.cur.buffer);
        this.pos = 0;
    }

    result() {
        this.parts.push(this.cur.subarray(0, this.pos));
        const out = new Uint8Array(this.length);
        let o = 0;
        for (const p of this.parts) {
            out.set(p, o);
            o += p.length;
        }
        return out;
    }
}

const deflate = async (data: Uint8Array) => {
    return new Uint8Array(await new Response(
        new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer());
};

// EXR's ZIP pre-filter: split even / odd bytes, then a byte delta predictor
const preFilter = (raw: Uint8Array) => {
    const n = raw.length;
    const tmp = new Uint8Array(n);
    let t1 = 0;
    let t2 = (n + 1) >> 1;
    for (let i = 0; i < n; i += 2) {
        tmp[t1++] = raw[i];
        if (i + 1 < n) tmp[t2++] = raw[i + 1];
    }
    let p = tmp[0];
    for (let i = 1; i < n; i++) {
        const d = tmp[i] - p + (128 + 256);
        p = tmp[i];
        tmp[i] = d & 0xff;
    }
    return tmp;
};

const LINES_PER_BLOCK = 16;

/**
 * Encode an EXR image.
 * @param rgba - 8-bit RGBA, premultiplied, rows top-down (the render readback).
 * @param width - Image width.
 * @param height - Image height.
 * @param depth - Optional camera depth per pixel (rows top-down), written as Z.
 * @returns The EXR file bytes.
 */
const encodeExr = async (rgba: Uint8Array, width: number, height: number, depth: Float32Array | null = null) => {
    // channels in alphabetical order, as the format requires
    const channels: { name: string, type: 1 | 2 }[] = [
        { name: 'A', type: 1 },
        { name: 'B', type: 1 },
        { name: 'G', type: 1 },
        { name: 'R', type: 1 }
    ];
    if (depth) channels.push({ name: 'Z', type: 2 });

    const header = new ByteWriter();
    // magic + version 2, scanline
    header.i32(20000630);
    header.i32(2);

    const attr = (name: string, type: string, size: number, write: () => void) => {
        header.str(name);
        header.str(type);
        header.i32(size);
        write();
    };

    const chlistSize = channels.reduce((s, c) => s + c.name.length + 1 + 16, 0) + 1;
    attr('channels', 'chlist', chlistSize, () => {
        for (const c of channels) {
            header.str(c.name);
            header.i32(c.type);
            header.u8(0); // pLinear
            header.u8(0);
            header.u8(0);
            header.u8(0);
            header.i32(1);
            header.i32(1);
        }
        header.u8(0);
    });
    attr('compression', 'compression', 1, () => header.u8(3)); // ZIP, 16 lines
    const box = () => {
        header.i32(0);
        header.i32(0);
        header.i32(width - 1);
        header.i32(height - 1);
    };
    attr('dataWindow', 'box2i', 16, box);
    attr('displayWindow', 'box2i', 16, box);
    attr('lineOrder', 'lineOrder', 1, () => header.u8(0));
    attr('pixelAspectRatio', 'float', 4, () => header.f32(1));
    attr('screenWindowCenter', 'v2f', 8, () => {
        header.f32(0);
        header.f32(0);
    });
    attr('screenWindowWidth', 'float', 4, () => header.f32(1));
    header.u8(0);

    const bytesPerPixel = channels.reduce((s, c) => s + (c.type === 1 ? 2 : 4), 0);
    const blockCount = Math.ceil(height / LINES_PER_BLOCK);

    // pixel blocks: per line, each channel's values for the whole line
    const blocks: Uint8Array[] = [];
    for (let b = 0; b < blockCount; b++) {
        const y0 = b * LINES_PER_BLOCK;
        const lines = Math.min(LINES_PER_BLOCK, height - y0);
        const raw = new Uint8Array(lines * width * bytesPerPixel);
        const view = new DataView(raw.buffer);
        let o = 0;
        for (let y = y0; y < y0 + lines; y++) {
            const row = y * width;
            for (const c of channels) {
                if (c.name === 'Z') {
                    for (let x = 0; x < width; x++) {
                        view.setFloat32(o, depth[row + x], true);
                        o += 4;
                    }
                    continue;
                }
                const ch = c.name === 'R' ? 0 : (c.name === 'G' ? 1 : (c.name === 'B' ? 2 : 3));
                for (let x = 0; x < width; x++) {
                    const i = (row + x) * 4;
                    const a = rgba[i + 3];
                    let v: number;
                    if (ch === 3) {
                        v = a / 255;
                    } else if (a === 0) {
                        v = 0;
                    } else {
                        // un-premultiply, linearize, premultiply again
                        const straight = Math.min(255, Math.round(rgba[i + ch] * 255 / a));
                        v = SRGB_TO_LINEAR[straight] * a / 255;
                    }
                    view.setUint16(o, toHalf(v), true);
                    o += 2;
                }
            }
        }
        const compressed = await deflate(preFilter(raw));
        blocks.push(compressed.length < raw.length ? compressed : raw);
    }

    // offset table, then the chunks (line number, size, data)
    const out = new ByteWriter();
    out.bytes(header.result());
    let offset = header.length + blockCount * 8;
    for (let b = 0; b < blockCount; b++) {
        out.u64(offset);
        offset += 8 + blocks[b].length;
    }
    for (let b = 0; b < blockCount; b++) {
        out.i32(b * LINES_PER_BLOCK);
        out.i32(blocks[b].length);
        out.bytes(blocks[b]);
    }
    return out.result();
};

export { encodeExr, toHalf };
