import { pngChunk } from './png-writer';

// Injects spherical metadata into an MP4/MOV buffer so players (YouTube,
// VLC, Quest) auto-detect the equirectangular projection:
// - Spherical Video V1: a uuid box with GSpherical xml as the last child of
//   the video trak (with StereoMode top-bottom for stereo)
// - Spherical Video V2 (stereo only): st3d (stereo mode) and sv3d (svhd +
//   proj/prhd/equi) appended to the video sample entry (avc1/hvc1/...)
// https://github.com/google/spatial-media/blob/master/docs/spherical-video-rfc.md
// https://github.com/google/spatial-media/blob/master/docs/spherical-video-v2-rfc.md
//
// Also GPano XMP for mono equirect images (jpeg app1 / png iTXt).
// Throws on unexpected input; callers should fall back to the untagged buffer.

const SPHERICAL_UUID = new Uint8Array([
    0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93,
    0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd
]);

const sphericalXml = (stereo: boolean) => '<?xml version="1.0"?>' +
    '<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">' +
    '<GSpherical:Spherical>true</GSpherical:Spherical>' +
    '<GSpherical:Stitched>true</GSpherical:Stitched>' +
    '<GSpherical:StitchingSoftware>Splatmania</GSpherical:StitchingSoftware>' +
    `<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>${
        stereo ? '<GSpherical:StereoMode>top-bottom</GSpherical:StereoMode>' : ''
    }</rdf:SphericalVideo>`;

type Box = {
    type: string;
    start: number;
    size: number;
    headerSize: number;
};

// read the box header at offset, returning null when truncated or malformed
const readBox = (view: DataView, offset: number, end: number): Box | null => {
    if (offset + 8 > end) {
        return null;
    }

    let size = view.getUint32(offset);
    const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
    );
    let headerSize = 8;

    if (size === 1) {
        // 64-bit largesize (mdat can use this for long clips)
        if (offset + 16 > end) {
            return null;
        }
        size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
        headerSize = 16;
    } else if (size === 0) {
        // box extends to the end of the file
        size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
        return null;
    }

    return { type, start: offset, size, headerSize };
};

// list the direct children of a container box (or the whole file)
const childBoxes = (view: DataView, start: number, end: number): Box[] => {
    const children: Box[] = [];
    let offset = start;
    while (offset < end) {
        const box = readBox(view, offset, end);
        if (!box) {
            break;
        }
        children.push(box);
        offset = box.start + box.size;
    }
    return children;
};

const findChild = (view: DataView, parent: Box, type: string): Box | null => {
    const children = childBoxes(view, parent.start + parent.headerSize, parent.start + parent.size);
    return children.find(child => child.type === type) ?? null;
};

// a trak is the video track when its mdia > hdlr handler_type is 'vide'
const isVideoTrak = (view: DataView, trak: Box): boolean => {
    const mdia = findChild(view, trak, 'mdia');
    const hdlr = mdia && findChild(view, mdia, 'hdlr');
    if (!hdlr) {
        return false;
    }

    // hdlr payload: version/flags (4) + pre_defined (4) + handler_type (4)
    const offset = hdlr.start + hdlr.headerSize + 8;
    return offset + 4 <= hdlr.start + hdlr.size &&
        String.fromCharCode(
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
            view.getUint8(offset + 3)
        ) === 'vide';
};

// add delta to every chunk offset in the stco/co64 boxes of a moov subtree.
// only needed when moov precedes mdat (fast-start layout); with moov written
// last the chunk offsets are unaffected by the insertion.
const patchChunkOffsets = (view: DataView, box: Box, delta: number) => {
    const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

    if (containers.includes(box.type)) {
        const children = childBoxes(view, box.start + box.headerSize, box.start + box.size);
        children.forEach(child => patchChunkOffsets(view, child, delta));
    } else if (box.type === 'stco' || box.type === 'co64') {
        // full box: version/flags (4) + entry_count (4) + entries
        const count = view.getUint32(box.start + box.headerSize + 4);
        let offset = box.start + box.headerSize + 8;
        for (let i = 0; i < count; ++i) {
            if (box.type === 'stco') {
                view.setUint32(offset, view.getUint32(offset) + delta);
                offset += 4;
            } else {
                const value = view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4) + delta;
                view.setUint32(offset, Math.floor(value / 4294967296));
                view.setUint32(offset + 4, value % 4294967296);
                offset += 8;
            }
        }
    }
};

// build a box from its type and payload parts
const makeBox = (type: string, ...parts: Uint8Array[]) => {
    const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
    const box = new Uint8Array(size);
    new DataView(box.buffer).setUint32(0, size);
    box.set(new TextEncoder().encode(type), 4);
    let offset = 8;
    parts.forEach((part) => {
        box.set(part, offset);
        offset += part.length;
    });
    return box;
};

// full box payload prefix: version 0, flags 0
const fullBoxHeader = () => new Uint8Array(4);

type Parsed = { view: DataView, topLevel: Box[], moov: Box, trak: Box };

const parse = (buffer: ArrayBuffer): Parsed => {
    const view = new DataView(buffer);
    const topLevel = childBoxes(view, 0, buffer.byteLength);

    if (topLevel.length === 0 || topLevel[topLevel.length - 1].start + topLevel[topLevel.length - 1].size !== buffer.byteLength) {
        throw new Error('malformed container');
    }

    const moov = topLevel.find(box => box.type === 'moov');
    if (!moov) {
        throw new Error('moov box not found');
    }

    const moovChildren = childBoxes(view, moov.start + moov.headerSize, moov.start + moov.size);
    const trak = moovChildren.find(box => box.type === 'trak' && isVideoTrak(view, box));
    if (!trak) {
        throw new Error('video trak not found');
    }

    return { view, topLevel, moov, trak };
};

// splice bytes in at offset and grow every listed ancestor box by their length
const insertBytes = (buffer: ArrayBuffer, parsed: Parsed, ancestors: Box[], offset: number, bytes: Uint8Array) => {
    if (ancestors.some(box => box.headerSize !== 8)) {
        throw new Error('unexpected 64-bit box size');
    }

    const src = new Uint8Array(buffer);
    const out = new Uint8Array(buffer.byteLength + bytes.length);
    out.set(src.subarray(0, offset), 0);
    out.set(bytes, offset);
    out.set(src.subarray(offset), offset + bytes.length);

    const outView = new DataView(out.buffer);
    ancestors.forEach(box => outView.setUint32(box.start, box.size + bytes.length));

    // fast-start layout defense: growing a moov that precedes mdat shifts the
    // media data, so chunk offsets must follow
    const { moov, topLevel } = parsed;
    const mdat = topLevel.find(box => box.type === 'mdat');
    if (mdat && moov.start < mdat.start) {
        const outMoov = readBox(outView, moov.start, out.byteLength);
        patchChunkOffsets(outView, outMoov, bytes.length);
    }

    return out.buffer;
};

// spherical video v2 boxes: st3d (top-bottom) and sv3d with an equirect proj
const v2Boxes = (stereo: boolean) => {
    const st3d = makeBox('st3d', fullBoxHeader(), new Uint8Array([stereo ? 1 : 0]));
    const svhd = makeBox('svhd', fullBoxHeader(), new TextEncoder().encode('Splatmania\0'));
    const prhd = makeBox('prhd', fullBoxHeader(), new Uint8Array(12));     // yaw, pitch, roll = 0
    const equi = makeBox('equi', fullBoxHeader(), new Uint8Array(16));     // no cropping
    const sv3d = makeBox('sv3d', svhd, makeBox('proj', prhd, equi));
    const result = new Uint8Array(st3d.length + sv3d.length);
    result.set(st3d, 0);
    result.set(sv3d, st3d.length);
    return result;
};

const injectSphericalMetadata = (buffer: ArrayBuffer, stereo = false): ArrayBuffer => {
    let parsed = parse(buffer);

    // v2: append st3d + sv3d to the video sample entry (stereo only; mono
    // keeps the long-standing v1-only tagging)
    if (stereo) {
        const { view, moov, trak } = parsed;
        const mdia = findChild(view, trak, 'mdia');
        const minf = mdia && findChild(view, mdia, 'minf');
        const stbl = minf && findChild(view, minf, 'stbl');
        const stsd = stbl && findChild(view, stbl, 'stsd');
        if (!stsd) {
            throw new Error('stsd box not found');
        }
        // stsd: full box (4) + entry_count (4) + sample entries
        const entry = readBox(view, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size);
        if (!entry) {
            throw new Error('sample entry not found');
        }
        buffer = insertBytes(buffer, parsed, [moov, trak, mdia, minf, stbl, stsd, entry], entry.start + entry.size, v2Boxes(true));
        parsed = parse(buffer);
    }

    // v1: uuid box (size + 'uuid' + extended type + xml) as the last child
    // of the video trak
    const xml = new TextEncoder().encode(sphericalXml(stereo));
    const uuidBox = new Uint8Array(24 + xml.length);
    new DataView(uuidBox.buffer).setUint32(0, uuidBox.length);
    uuidBox.set([0x75, 0x75, 0x69, 0x64], 4);   // 'uuid'
    uuidBox.set(SPHERICAL_UUID, 8);
    uuidBox.set(xml, 24);

    const { moov, trak } = parsed;
    return insertBytes(buffer, parsed, [moov, trak], trak.start + trak.size, uuidBox);
};

// GPano xmp packet for a full (uncropped) equirect panorama
const gpanoXmp = (width: number, height: number) => '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"' +
    ' GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True"' +
    ` GPano:CroppedAreaImageWidthPixels="${width}" GPano:CroppedAreaImageHeightPixels="${height}"` +
    ` GPano:FullPanoWidthPixels="${width}" GPano:FullPanoHeightPixels="${height}"` +
    ' GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"' +
    ' GPano:StitchingSoftware="Splatmania"/>' +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

// jpeg: app1 xmp segment after SOI (and after a leading JFIF app0)
const injectGPanoJpeg = (bytes: Uint8Array, width: number, height: number): Uint8Array => {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error('not a jpeg');
    }
    let offset = 2;
    if (bytes[2] === 0xff && bytes[3] === 0xe0) {
        offset = 4 + ((bytes[4] << 8) | bytes[5]);
    }
    const payload = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0${gpanoXmp(width, height)}`);
    const length = payload.length + 2;
    if (length > 0xffff) {
        throw new Error('xmp too large');
    }
    const segment = new Uint8Array(4 + payload.length);
    segment.set([0xff, 0xe1, length >> 8, length & 0xff], 0);
    segment.set(payload, 4);
    const out = new Uint8Array(bytes.length + segment.length);
    out.set(bytes.subarray(0, offset), 0);
    out.set(segment, offset);
    out.set(bytes.subarray(offset), offset + segment.length);
    return out;
};

// png: iTXt chunk with keyword XML:com.adobe.xmp right after IHDR
const injectGPanoPng = (bytes: Uint8Array, width: number, height: number): Uint8Array => {
    const ihdrEnd = 8 + 8 + 13 + 4;
    const encoder = new TextEncoder();
    const keyword = encoder.encode('XML:com.adobe.xmp');
    const text = encoder.encode(gpanoXmp(width, height));
    // keyword \0, compression flag 0, method 0, language \0, translated keyword \0
    const data = new Uint8Array(keyword.length + 5 + text.length);
    data.set(keyword, 0);
    data.set(text, keyword.length + 5);
    const itxt = pngChunk('iTXt', data);
    const out = new Uint8Array(bytes.length + itxt.length);
    out.set(bytes.subarray(0, ihdrEnd), 0);
    out.set(itxt, ihdrEnd);
    out.set(bytes.subarray(ihdrEnd), ihdrEnd + itxt.length);
    return out;
};

export { injectSphericalMetadata, injectGPanoJpeg, injectGPanoPng };
