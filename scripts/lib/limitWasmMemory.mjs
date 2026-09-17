/** Bound an upstream WASM module's defined memory without changing its code. */
export function limitWasmMemory(bytes, maximumPages = 4096) {
  const read = cursor => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[cursor.offset++];
      if (byte === undefined || shift > 28) throw new Error("Invalid WASM integer.");
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const encode = value => {
    const result = [];
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      result.push(byte | (value ? 128 : 0));
    } while (value);
    return Uint8Array.from(result);
  };
  if (!WebAssembly.validate(bytes)) throw new Error("Invalid upstream WASM.");
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const start = cursor.offset;
    const id = bytes[cursor.offset++];
    const length = read(cursor);
    const end = cursor.offset + length;
    if (id === 5) {
      if (read(cursor) !== 1) throw new Error("Expected one defined memory.");
      const flags = read(cursor);
      if (flags !== 0 && flags !== 1) throw new Error("Unsupported WASM memory flags.");
      const minimum = read(cursor);
      const oldMaximum = flags ? read(cursor) : 65536;
      if (cursor.offset !== end || minimum > maximumPages || oldMaximum < maximumPages) {
        throw new Error("Unexpected upstream WASM memory limits.");
      }
      const payload = Uint8Array.of(1, 1, ...encode(minimum), ...encode(maximumPages));
      const header = Uint8Array.of(id, ...encode(payload.length));
      const output = new Uint8Array(start + header.length + payload.length + bytes.length - end);
      output.set(bytes.subarray(0, start));
      output.set(header, start);
      output.set(payload, start + header.length);
      output.set(bytes.subarray(end), start + header.length + payload.length);
      if (!WebAssembly.validate(output)) throw new Error("Invalid bounded WASM.");
      return output;
    }
    cursor.offset = end;
  }
  throw new Error("Expected a defined WASM memory.");
}
