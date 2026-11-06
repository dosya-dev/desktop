let wasm;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc_command_export();
    wasm.__wbindgen_export_2.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store_command_export(idx);
    }
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_2.get(idx);
    wasm.__externref_table_dealloc_command_export(idx);
    return value;
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let WASM_VECTOR_LEN = 0;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const EncodedPhotoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encodedphoto_free(ptr >>> 0, 1));
/**
 * An encoded photo copied into wasm memory, not decoded yet. Copying and
 * decoding are separate calls so JS can drop its own copy in between, as
 * with ModelBytes: the decode is the photo's memory peak.
 */
export class EncodedPhoto {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncodedPhoto.prototype);
        obj.__wbg_ptr = ptr;
        EncodedPhotoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncodedPhotoFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encodedphoto_free(ptr, 0);
    }
    /**
     * An empty photo of exactly `size` bytes to come, filled by `append`
     * chunk by chunk (a streamed R2 body), so JS never holds it whole.
     * @param {number} size
     * @returns {EncodedPhoto}
     */
    static with_capacity(size) {
        const ret = wasm.encodedphoto_with_capacity(size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EncodedPhoto.__wrap(ret[0]);
    }
    /**
     * Bytes appended so far.
     * @returns {number}
     */
    len() {
        const ret = wasm.encodedphoto_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {Uint8Array} bytes
     */
    constructor(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encodedphoto_new(ptr0, len0);
        this.__wbg_ptr = ret >>> 0;
        EncodedPhotoFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Adds the next chunk; refuses to go past the announced size.
     * @param {Uint8Array} chunk
     */
    append(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encodedphoto_append(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {boolean}
     */
    is_empty() {
        const ret = wasm.encodedphoto_is_empty(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) EncodedPhoto.prototype[Symbol.dispose] = EncodedPhoto.prototype.free;

const FaceReaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_facereader_free(ptr >>> 0, 1));
/**
 * Both models, parsed and optimised once.
 */
export class FaceReader {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FaceReaderFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_facereader_free(ptr, 0);
    }
    /**
     * `crop_jpeg` for a photo already copied into wasm, which it consumes.
     * @param {EncodedPhoto} photo
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {number} size
     * @returns {Uint8Array}
     */
    crop_photo(photo, x, y, w, h, size) {
        _assertClass(photo, EncodedPhoto);
        var ptr0 = photo.__destroy_into_raw();
        const ret = wasm.facereader_crop_photo(this.__wbg_ptr, ptr0, x, y, w, h, size);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * `read` for a photo already copied into wasm (EncodedPhoto), which it
     * consumes: JS can release its own copy before the decode.
     * @param {EncodedPhoto} photo
     * @returns {Float32Array}
     */
    read_photo(photo) {
        _assertClass(photo, EncodedPhoto);
        var ptr0 = photo.__destroy_into_raw();
        const ret = wasm.facereader_read_photo(this.__wbg_ptr, ptr0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Parses and optimises both models, consuming `models`.
     * @param {ModelBytes} models
     */
    constructor(models) {
        _assertClass(models, ModelBytes);
        var ptr0 = models.__destroy_into_raw();
        const ret = wasm.facereader_new(ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        FaceReaderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Decodes an encoded JPEG or WebP (downscaled to 1600 px on the long
     * side if larger) and reads it; returns FACE_STRIDE floats per face
     * (x, y, w, h, score, then the 128-float L2-normalised vector). Boxes are
     * in the ENCODED image's pixels, whatever size it was read at. Takes the
     * bytes by value so they are freed as soon as they are decoded; the
     * pixels are freed when the call returns.
     * @param {Uint8Array} encoded
     * @returns {Float32Array}
     */
    read(encoded) {
        const ptr0 = passArray8ToWasm0(encoded, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.facereader_read(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * The JPEG crop (`size` x `size`, quality 85) of the face at (x, y, w,
     * h) in the ENCODED image's pixels: a square with a 25 % margin on each
     * side, clamped to the image (src/crop.rs). Same decode path and limits
     * as `read`; the models are not used. A method on the reader so JS runs
     * it in the same one-photo-at-a-time queue, after the models' load.
     * @param {Uint8Array} encoded
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {number} size
     * @returns {Uint8Array}
     */
    crop_jpeg(encoded, x, y, w, h, size) {
        const ptr0 = passArray8ToWasm0(encoded, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.facereader_crop_jpeg(this.__wbg_ptr, ptr0, len0, x, y, w, h, size);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free_command_export(ret[0], ret[1] * 1, 1);
        return v2;
    }
}
if (Symbol.dispose) FaceReader.prototype[Symbol.dispose] = FaceReader.prototype.free;

const ModelBytesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_modelbytes_free(ptr >>> 0, 1));
/**
 * Both model files copied into wasm memory, not parsed yet. Copying and
 * parsing are separate calls so JS can drop its own copy of the bytes in
 * between: parsing is the memory peak, and JS must not hold ~20 MB then.
 */
export class ModelBytes {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ModelBytesFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_modelbytes_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} detector
     * @param {Uint8Array} embedder
     */
    constructor(detector, embedder) {
        const ptr0 = passArray8ToWasm0(detector, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(embedder, wasm.__wbindgen_malloc_command_export);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.modelbytes_new(ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret >>> 0;
        ModelBytesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ModelBytes.prototype[Symbol.dispose] = ModelBytes.prototype.free;

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_e17e777aac105295 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_getRandomValues_a8ddca022803a145 = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_wbindgenthrow_451ec1a8469d7eb6 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_2;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        throw new Error('face_reader: pass the verified wasm module to initSync');
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
