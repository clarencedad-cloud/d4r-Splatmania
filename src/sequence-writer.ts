// Image sequence output (PNG / EXR per frame): into a chosen folder, or,
// without the folder picker, as one uncompressed ZIP download.

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

type ZipEntry = { name: Uint8Array, crc: number, size: number, offset: number };

// store-only zip (frames are compressed already), zip64 when large
class ZipBuilder {
    private parts: Uint8Array[] = [];
    private entries: ZipEntry[] = [];
    private offset = 0;

    add(name: string, data: Uint8Array) {
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length + 20);
        const v = new DataView(local.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 45, true);
        v.setUint16(6, 0x0800, true);
        v.setUint16(8, 0, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, 0xffffffff, true);
        v.setUint32(22, 0xffffffff, true);
        v.setUint16(26, nameBytes.length, true);
        v.setUint16(28, 20, true);
        local.set(nameBytes, 30);
        // zip64 extra: sizes
        const e = 30 + nameBytes.length;
        v.setUint16(e, 0x0001, true);
        v.setUint16(e + 2, 16, true);
        v.setBigUint64(e + 4, BigInt(data.length), true);
        v.setBigUint64(e + 12, BigInt(data.length), true);
        this.entries.push({ name: nameBytes, crc, size: data.length, offset: this.offset });
        this.parts.push(local, data);
        this.offset += local.length + data.length;
    }

    finish() {
        const start = this.offset;
        let size = 0;
        for (const entry of this.entries) {
            const c = new Uint8Array(46 + entry.name.length + 28);
            const v = new DataView(c.buffer);
            v.setUint32(0, 0x02014b50, true);
            v.setUint16(4, 45, true);
            v.setUint16(6, 45, true);
            v.setUint16(8, 0x0800, true);
            v.setUint32(16, entry.crc, true);
            v.setUint32(20, 0xffffffff, true);
            v.setUint32(24, 0xffffffff, true);
            v.setUint16(28, entry.name.length, true);
            v.setUint16(30, 28, true);
            v.setUint32(42, 0xffffffff, true);
            c.set(entry.name, 46);
            const e = 46 + entry.name.length;
            v.setUint16(e, 0x0001, true);
            v.setUint16(e + 2, 24, true);
            v.setBigUint64(e + 4, BigInt(entry.size), true);
            v.setBigUint64(e + 12, BigInt(entry.size), true);
            v.setBigUint64(e + 20, BigInt(entry.offset), true);
            this.parts.push(c);
            size += c.length;
        }
        const count = this.entries.length;
        // zip64 end of central directory + locator + classic end record
        const end = new Uint8Array(56 + 20 + 22);
        const v = new DataView(end.buffer);
        v.setUint32(0, 0x06064b50, true);
        v.setBigUint64(4, 44n, true);
        v.setUint16(12, 45, true);
        v.setUint16(14, 45, true);
        v.setBigUint64(24, BigInt(count), true);
        v.setBigUint64(32, BigInt(count), true);
        v.setBigUint64(40, BigInt(size), true);
        v.setBigUint64(48, BigInt(start), true);
        v.setUint32(56, 0x07064b50, true);
        v.setBigUint64(64, BigInt(start + size), true);
        v.setUint32(72, 1, true);
        v.setUint32(76, 0x06054b50, true);
        v.setUint16(84, 0xffff, true);
        v.setUint16(86, 0xffff, true);
        v.setUint32(88, 0xffffffff, true);
        v.setUint32(92, 0xffffffff, true);
        this.parts.push(end);
        return new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
    }
}

class SequenceWriter {
    private zip: ZipBuilder | null;

    constructor(private directory: FileSystemDirectoryHandle | null) {
        this.zip = directory ? null : new ZipBuilder();
    }

    async add(name: string, data: Uint8Array) {
        if (this.directory) {
            const handle = await this.directory.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(data as Uint8Array<ArrayBuffer>);
            await writable.close();
        } else {
            this.zip.add(name, data);
        }
    }

    // the zip (no folder), else null
    finish(): Blob | null {
        return this.zip ? this.zip.finish() : null;
    }
}

export { SequenceWriter, crc32 };
