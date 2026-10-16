// Wire format recovered from com.remote.store.proto.Connect and Main in the reference APK.
const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export function varint(value) {
  let n = BigInt(value); if (n < 0n) n = BigInt.asUintN(64, n);
  const result = [];
  while (n > 127n) { result.push(Number(n & 127n) | 128); n >>= 7n; }
  result.push(Number(n)); return Uint8Array.from(result);
}
export function concat(...arrays) {
  const output = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let offset = 0;
  for (const a of arrays) { output.set(a, offset); offset += a.length; }
  return output;
}
export const integer = (field, value) => concat(varint(field * 8), varint(value));
export const message = (field, value) => concat(varint(field * 8 + 2), varint(value.length), value);
export const string = (field, value) => message(field, new TextEncoder().encode(value));

export function connectOptions({ width = 1920, height = 1080, fps = 60, quality = 3 } = {}) {
  const resolution = concat(integer(1, width), integer(2, height));
  const capture = concat(integer(1, fps === 30 ? 1 : 2), integer(2, quality), integer(3, 1), integer(4, 2), message(5, resolution), message(6, resolution));
  const decoder = concat(integer(1, fps), integer(2, 1), integer(3, width), integer(4, height));
  return concat(integer(1, 1), integer(2, -1), message(3, capture), message(4, decoder), integer(8, 2));
}

export function envelope(seq, field, payload, timestamp = Date.now()) {
  return concat(integer(1, seq), integer(2, timestamp), message(field, payload));
}

export function fields(input) {
  const data = bytes(input); let p = 0; const output = new Map();
  function read() {
    let n = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (p >= data.length) throw new Error('Truncated protobuf varint');
      const byte = data[p++]; n |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return n;
      shift += 7n;
    }
    throw new Error('Invalid protobuf varint');
  }
  while (p < data.length) {
    const tag = Number(read()), field = tag >>> 3, wire = tag & 7; let value;
    if (!field) throw new Error('Invalid protobuf field');
    if (wire === 0) value = read();
    else if (wire === 2) { const length = Number(read()); if (p + length > data.length) throw new Error('Truncated protobuf bytes'); value = data.slice(p, p + length); p += length; }
    else if (wire === 1 || wire === 5) { const n = wire === 1 ? 8 : 4; if (p + n > data.length) throw new Error('Truncated protobuf fixed field'); value = data.slice(p, p + n); p += n; }
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
    if (!output.has(field)) output.set(field, []);
    output.get(field).push(value);
  }
  return output;
}
