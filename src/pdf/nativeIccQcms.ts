import type { NativeIccTransformRequest, NativeIccTransformResult } from "./nativeIcc";
import { throwIfAborted } from "./nativeTypes";
import { createIccModuleLoader, IccEngineError, iccMemoryError, yieldIccConversion } from "./nativeIccWasm";

const loadModule = createIccModuleLoader(
  new URL("../assets/color/icc/qcms.wasm?no-inline", import.meta.url), 96591
);

interface QcmsExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __wbindgen_externrefs: WebAssembly.Table;
  __wbindgen_start(): void;
  __wbindgen_malloc(size: number, align: number): number;
  qcms_transformer_from_memory(pointer: number, size: number, type: number, intent: number): number;
  qcms_convert_array(transform: number, pointer: number, size: number, addAlpha: number): void;
  qcms_drop_transformer(transform: number): void;
}

export async function resolveQcmsTransform(
  request: Readonly<NativeIccTransformRequest>, signal?: AbortSignal
): Promise<NativeIccTransformResult> {
  // The pinned Mozilla bindings accept Gray8, RGB8 and CMYK, but not Lab.
  if (request.metadata.dataColorSpace === "Lab ") throw new IccEngineError("profile-unsupported");
  const module = await loadModule(signal);
  throwIfAborted(signal);
  let wasm: QcmsExports;
  let destination: Uint8Array | undefined;
  let outputOffset = 0;
  let expectedBytes = 0;
  let copied = false;
  const imports = {
    __wbg_copy_result_0d15f3bf9d9012ae(pointer: number, length: number) {
      if (!destination || copied || length !== expectedBytes) throw new IccEngineError("profile-unsupported");
      destination.set(new Uint8Array(wasm.memory.buffer, pointer >>> 0, length >>> 0), outputOffset);
      copied = true;
    },
    __wbg___wbindgen_throw_344f42d3211c4765() { throw new IccEngineError("profile-unsupported"); },
    __wbindgen_init_externref_table() {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      [undefined, null, true, false].forEach((value, index) => table.set(offset + index, value));
    }
  };
  try {
    wasm = new WebAssembly.Instance(module, { "./qcms_bg.js": imports }).exports as QcmsExports;
    wasm.__wbindgen_start();
  } catch (cause) {
    if (cause instanceof RangeError || cause instanceof WebAssembly.RuntimeError) throw iccMemoryError(cause);
    throw new IccEngineError("engine-load-failed", cause);
  }
  const copyInput = (bytes: Uint8Array) => {
    const pointer = wasm.__wbindgen_malloc(bytes.length, 1) >>> 0;
    if (!pointer) throw iccMemoryError();
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    return pointer;
  };
  let transform = 0;
  try {
    // The Rust bindings consume and free each transferred Vec<u8>.
    transform = wasm.qcms_transformer_from_memory(copyInput(request.profile), request.profile.length,
      request.inputComponents === 1 ? 3 : request.inputComponents === 3 ? 0 : 5, 1) >>> 0;
    if (!transform) throw new IccEngineError("profile-unsupported");
    destination = new Uint8Array(request.sampleCount * 3);
    for (let first = 0; first < request.sampleCount; first += 4096) {
      await yieldIccConversion(signal);
      const count = Math.min(4096, request.sampleCount - first);
      const input = request.inputSamples.subarray(first * request.inputComponents, (first + count) * request.inputComponents);
      outputOffset = first * 3;
      expectedBytes = count * 3;
      copied = false;
      wasm.qcms_convert_array(transform, copyInput(input), input.length, 0);
      if (!copied) throw new IccEngineError("profile-unsupported");
    }
    return { samples: destination, sampleCount: request.sampleCount, outputComponents: 3, bitsPerComponent: 8 };
  } catch (cause) {
    if (cause instanceof RangeError || cause instanceof WebAssembly.RuntimeError) throw iccMemoryError(cause);
    throw cause;
  } finally {
    if (transform) wasm.qcms_drop_transformer(transform);
  }
}
