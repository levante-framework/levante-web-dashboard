'use strict';

const DEFAULT_IMAGE_COPYRIGHT =
  'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
const XMP_FLAG = 0x04;

function toIso8601(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildXmpPacket({ copyright, created }) {
  const rights = escapeXml(copyright);
  const createdIso = escapeXml(toIso8601(created));
  return Buffer.from(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about=""` +
      ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
      ` xmlns:xmp="http://ns.adobe.com/xap/1.0/"` +
      ` xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/">` +
      `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${rights}</rdf:li></rdf:Alt></dc:rights>` +
      `<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang="x-default">${rights}</rdf:li></rdf:Alt></xmpRights:UsageTerms>` +
      `<xmpRights:WebStatement>${escapeXml(LICENSE_URL)}</xmpRights:WebStatement>` +
      `<xmp:CreateDate>${createdIso}</xmp:CreateDate>` +
      `<xmp:CreatorTool>Levante Project</xmp:CreatorTool>` +
      `</rdf:Description></rdf:RDF></x:xmpmeta>\n` +
      `<?xpacket end="w"?>`,
    'utf8',
  );
}

function parseChunks(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file');
  }
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buf.length) throw new Error(`truncated WebP chunk ${fourcc}`);
    chunks.push({ fourcc, payload: Buffer.from(buf.subarray(payloadStart, payloadEnd)) });
    offset = payloadEnd + (size % 2);
  }
  return chunks;
}

function readU24LE(buf, index) {
  return buf[index] | (buf[index + 1] << 8) | (buf[index + 2] << 16);
}

function dimensionsFromVp8(payload) {
  if (!payload || payload.length < 10) return null;
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return null;
  return { w: payload.readUInt16LE(6) & 0x3fff, h: payload.readUInt16LE(8) & 0x3fff };
}

function dimensionsFromVp8l(payload) {
  if (!payload || payload.length < 5 || payload[0] !== 0x2f) return null;
  const bits = payload[1] | (payload[2] << 8) | (payload[3] << 16) | (payload[4] << 24);
  return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
}

function dimensionsFromVp8x(payload) {
  if (!payload || payload.length < 10) return null;
  return { w: readU24LE(payload, 4) + 1, h: readU24LE(payload, 7) + 1 };
}

function canvasSize(chunks) {
  for (const chunk of chunks) {
    if (chunk.fourcc === 'VP8X') {
      const size = dimensionsFromVp8x(chunk.payload);
      if (size) return size;
    }
  }
  for (const chunk of chunks) {
    if (chunk.fourcc === 'VP8 ') {
      const size = dimensionsFromVp8(chunk.payload);
      if (size) return size;
    }
    if (chunk.fourcc === 'VP8L') {
      const size = dimensionsFromVp8l(chunk.payload);
      if (size) return size;
    }
  }
  throw new Error('could not read WebP dimensions');
}

function makeVp8x(flags, width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  payload[4] = widthMinusOne & 0xff;
  payload[5] = (widthMinusOne >> 8) & 0xff;
  payload[6] = (widthMinusOne >> 16) & 0xff;
  payload[7] = heightMinusOne & 0xff;
  payload[8] = (heightMinusOne >> 8) & 0xff;
  payload[9] = (heightMinusOne >> 16) & 0xff;
  return payload;
}

function buildWebp(chunks) {
  const parts = chunks.map((chunk) => {
    const pad = chunk.payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    const header = Buffer.alloc(8);
    header.write(chunk.fourcc, 0, 4, 'ascii');
    header.writeUInt32LE(chunk.payload.length, 4);
    return Buffer.concat([header, chunk.payload, pad]);
  });
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(4 + body.length, 4);
  out.write('WEBP', 8);
  body.copy(out, 12);
  return out;
}

function xmpText(chunks) {
  const xmp = chunks.find((chunk) => chunk.fourcc === 'XMP ');
  return xmp ? xmp.payload.toString('utf8') : '';
}

function hasLicense(buf, copyright = DEFAULT_IMAGE_COPYRIGHT) {
  try {
    return xmpText(parseChunks(buf)).includes(copyright);
  } catch {
    return false;
  }
}

function stampWebpLicense(buf, options = {}) {
  const copyright = options.copyright || DEFAULT_IMAGE_COPYRIGHT;
  const created = options.created;
  const chunks = parseChunks(buf);
  const { w, h } = canvasSize(chunks);
  const xmpPayload = buildXmpPacket({ copyright, created });

  let vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X');
  if (!vp8x) {
    vp8x = { fourcc: 'VP8X', payload: makeVp8x(XMP_FLAG, w, h) };
    chunks.unshift(vp8x);
  } else {
    vp8x.payload = Buffer.from(vp8x.payload);
    vp8x.payload[0] = vp8x.payload[0] | XMP_FLAG;
  }

  const withoutXmp = chunks.filter((chunk) => chunk.fourcc !== 'XMP ');
  withoutXmp.push({ fourcc: 'XMP ', payload: xmpPayload });
  return buildWebp(withoutXmp);
}

module.exports = {
  DEFAULT_IMAGE_COPYRIGHT,
  LICENSE_URL,
  hasLicense,
  stampWebpLicense,
  toIso8601,
};
