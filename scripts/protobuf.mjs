export function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) break;
  }
  return { value: result, nextOffset: pos };
}

export function parseProtoFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    offset = tagRes.nextOffset;
    const tag = Number(tagRes.value);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNo === 0) break;

    if (wireType === 0) {
      const valRes = readVarint(buf, offset);
      offset = valRes.nextOffset;
      fields.push({ fieldNo, wireType, value: valRes.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset);
      offset = lenRes.nextOffset;
      const len = Number(lenRes.value);
      if (len < 0 || offset + len > buf.length) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

