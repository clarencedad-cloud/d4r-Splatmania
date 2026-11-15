// QuickTime (.mov) writer for PNG frames ("png " codec): lossless video
// with a real alpha channel that Premiere, After Effects, Resolve and
// Final Cut import directly. The browser has no ProRes 4444 encoder, and
// WebCodecs H.264 / HEVC carry no alpha, so this is the editing-friendly
// transparent format.
//
// Layout: ftyp, mdat (64-bit size, frames streamed in), moov at the end.

type Writable = FileSystemWritableFileStream;

const enc = new TextEncoder();

// a box: 4-byte size, 4-char type, body
const box = (type: string, ...body: Uint8Array[]) => {
    const size = 8 + body.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    out.set(enc.encode(type), 4);
    let o = 8;
    for (const b of body) {
        out.set(b, o);
        o += b.length;
    }
    return out;
};

// big-endian field builder
class Fields {
    private bytes: number[] = [];

    u8(v: number) {
        this.bytes.push(v & 0xff);
        return this;
    }

    u16(v: number) {
        return this.u8(v >> 8).u8(v);
    }

    u32(v: number) {
        return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
    }

    u64(v: number) {
        return this.u32(Math.floor(v / 0x100000000)).u32(v % 0x100000000);
    }

    zeros(n: number) {
        for (let i = 0; i < n; i++) this.u8(0);
        return this;
    }

    str4(s: string) {
        for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i));
        return this;
    }

    // pascal string padded to a fixed length (0 = unpadded)
    pascal(s: string, length = 0) {
        this.u8(s.length);
        for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
        if (length) this.zeros(length - 1 - s.length);
        return this;
    }

    // unity transformation matrix
    matrix() {
        return this.u32(0x00010000).u32(0).u32(0)
        .u32(0).u32(0x00010000).u32(0)
        .u32(0).u32(0).u32(0x40000000);
    }

    get() {
        return new Uint8Array(this.bytes);
    }
}

const f = () => new Fields();

class MovPngWriter {
    private sizes: number[] = [];
    private offsets: number[] = [];
    // file position of the next frame
    private position: number;
    private memory: Uint8Array[] | null;
    private head: Uint8Array;

    constructor(
        private writable: Writable | null,
        private width: number,
        private height: number,
        private frameRate: number,
        private alpha: boolean
    ) {
        const ftyp = box('ftyp', f().str4('qt  ').u32(0x200).str4('qt  ').get());
        // mdat with a 64-bit size, patched in finish()
        const mdatHeader = f().u32(1).str4('mdat').u64(0).get();
        this.head = new Uint8Array(ftyp.length + mdatHeader.length);
        this.head.set(ftyp);
        this.head.set(mdatHeader, ftyp.length);
        this.position = this.head.length;
        this.memory = writable ? null : [this.head];
    }

    async start() {
        if (this.writable) await this.writable.write({ type: 'write', position: 0, data: this.head as Uint8Array<ArrayBuffer> });
    }

    async addFrame(png: Uint8Array) {
        this.offsets.push(this.position);
        this.sizes.push(png.length);
        if (this.writable) {
            await this.writable.write({ type: 'write', position: this.position, data: png as Uint8Array<ArrayBuffer> });
        } else {
            this.memory.push(png);
        }
        this.position += png.length;
    }

    private moov() {
        const n = this.sizes.length;
        const timescale = Math.round(this.frameRate * 100);
        const delta = 100;
        const duration = n * delta;
        const { width, height } = this;

        const mvhd = box('mvhd', f().u32(0).u32(0).u32(0).u32(timescale).u32(duration)
        .u32(0x00010000).u16(0x0100).zeros(10).matrix().zeros(24).u32(2).get());

        const tkhd = box('tkhd', f().u32(0x0000000f).u32(0).u32(0).u32(1).u32(0).u32(duration)
        .zeros(8).u16(0).u16(0).u16(0).u16(0).matrix().u32(width * 65536).u32(height * 65536).get());

        const mdhd = box('mdhd', f().u32(0).u32(0).u32(0).u32(timescale).u32(duration).u16(0).u16(0).get());
        const mhlr = box('hdlr', f().u32(0).str4('mhlr').str4('vide').u32(0).u32(0).u32(0).pascal('VideoHandler').get());
        const vmhd = box('vmhd', f().u32(1).u16(0x40).u16(0x8000).u16(0x8000).u16(0x8000).get());
        const dhlr = box('hdlr', f().u32(0).str4('dhlr').str4('alis').u32(0).u32(0).u32(0).pascal('DataHandler').get());
        const dinf = box('dinf', box('dref', f().u32(0).u32(1).get(), box('alis', f().u32(1).get())));

        const sampleEntry = box('png ', f().zeros(6).u16(1)
        .u16(0).u16(0).str4('appl').u32(0).u32(0x400)
        .u16(width).u16(height).u32(72 * 65536).u32(72 * 65536).u32(0).u16(1)
        .pascal('PNG', 32).u16(this.alpha ? 32 : 24).u16(0xffff).get());
        const stsd = box('stsd', f().u32(0).u32(1).get(), sampleEntry);
        const stts = box('stts', f().u32(0).u32(1).u32(n).u32(delta).get());
        const stsc = box('stsc', f().u32(0).u32(1).u32(1).u32(1).u32(1).get());
        const stszFields = f().u32(0).u32(0).u32(n);
        this.sizes.forEach(s => stszFields.u32(s));
        const stsz = box('stsz', stszFields.get());
        const co64Fields = f().u32(0).u32(n);
        this.offsets.forEach(o => co64Fields.u64(o));
        const co64 = box('co64', co64Fields.get());

        const stbl = box('stbl', stsd, stts, stsc, stsz, co64);
        const minf = box('minf', vmhd, dhlr, dinf, stbl);
        const mdia = box('mdia', mdhd, mhlr, minf);
        const trak = box('trak', tkhd, mdia);
        return box('moov', mvhd, trak);
    }

    /**
     * Write the index. Returns the file as a Blob when writing to memory.
     * @returns The finished file (memory) or null (written to the stream).
     */
    async finish(): Promise<Blob | null> {
        const moov = this.moov();
        // patch the mdat size: header (16) + frames
        const mdatSize = this.position - (this.head.length - 16);
        const sizeBytes = f().u64(mdatSize).get();
        const sizeOffset = this.head.length - 8;
        if (this.writable) {
            await this.writable.write({ type: 'write', position: this.position, data: moov as Uint8Array<ArrayBuffer> });
            await this.writable.write({ type: 'write', position: sizeOffset, data: sizeBytes as Uint8Array<ArrayBuffer> });
            return null;
        }
        this.head.set(sizeBytes, sizeOffset);
        this.memory.push(moov);
        return new Blob(this.memory as Uint8Array<ArrayBuffer>[], { type: 'video/quicktime' });
    }
}

export { MovPngWriter };
