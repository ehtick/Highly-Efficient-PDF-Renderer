"""Regenerate our MIT-licensed synthetic ICC test profiles using system liblcms2.

No PDFs are converted. Requires Python 3 and Little CMS 2 (ctypes, no pip deps).
"""
import ctypes as c
import ctypes.util
from pathlib import Path

cms = c.CDLL(ctypes.util.find_library("lcms2"))
P, U, D = c.c_void_p, c.c_uint32, c.c_double


def api(name, result, *args):
    fn = getattr(cms, name)
    fn.restype, fn.argtypes = result, args
    return fn


class Triple(c.Structure):
    _fields_ = [("x", D), ("y", D), ("z", D)]


class Primaries(c.Structure):
    _fields_ = [("r", Triple), ("g", Triple), ("b", Triple)]


sig = lambda text: int.from_bytes(text.encode("ascii"), "big")
gamma = api("cmsBuildGamma", P, P, D)
free_curve = api("cmsFreeToneCurve", None, P)
create_rgb = api("cmsCreateRGBProfile", P, P, P, P)
create_gray = api("cmsCreateGrayProfile", P, P, P)
create_lab = api("cmsCreateLab4Profile", P, P)
create_srgb = api("cmsCreate_sRGBProfile", P)
close = api("cmsCloseProfile", None, P)
set_class = api("cmsSetDeviceClass", None, P, U)
set_version = api("cmsSetProfileVersion", None, P, D)
save = api("cmsSaveProfileToMem", c.c_int, P, P, P)
write_tag = api("cmsWriteTag", c.c_int, P, U, P)
mlu_alloc = api("cmsMLUalloc", P, P, U)
mlu_set = api("cmsMLUsetASCII", c.c_int, P, c.c_char_p, c.c_char_p, c.c_char_p)
mlu_free = api("cmsMLUfree", None, P)

output = Path(__file__).resolve().parent / "fixtures" / "icc"
output.mkdir(parents=True, exist_ok=True)


def emit(profile, name):
    assert profile
    for tag, text in [("desc", "HEPR synthetic " + name), ("cprt", "HEPR contributors; MIT license")]:
        mlu = mlu_alloc(None, 1)
        assert mlu_set(mlu, b"en", b"US", text.encode())
        assert write_tag(profile, sig(tag), mlu)
        mlu_free(mlu)
    size = U()
    assert save(profile, None, c.byref(size))
    buf = (c.c_ubyte * size.value)()
    assert save(profile, buf, c.byref(size))
    data = bytearray(buf)
    # Pin the timestamp and clear the optional profile ID for reproducibility.
    data[24:36] = bytes.fromhex("07e800010001000000000000")
    data[84:100] = bytes(16)
    (output / (name + ".icc")).write_bytes(data)
    close(profile)


curve = gamma(None, 1.0)
white_d65 = Triple(0.3127, 0.3290, 1)
white_d50 = Triple(0.3457, 0.3585, 1)
primaries = Primaries(Triple(0.64, 0.33, 1), Triple(0.30, 0.60, 1), Triple(0.15, 0.06, 1))
emit(create_rgb(c.byref(white_d65), c.byref(primaries), (P * 3)(curve, curve, curve)), "linear-rgb")
emit(create_gray(c.byref(white_d50), curve), "linear-gray")
free_curve(curve)
lab = create_lab(None)
set_class(lab, sig("spac"))
emit(lab, "lab")
emit(create_srgb(), "srgb")

# A small CMYK -> Lab LUT with explicitly defined subtractive sRGB colors.
profile = api("cmsCreateProfilePlaceholder", P, P)(None)
set_version(profile, 2.1)
set_class(profile, sig("prtr"))
api("cmsSetColorSpace", None, P, U)(profile, sig("CMYK"))
api("cmsSetPCS", None, P, U)(profile, sig("Lab "))
assert write_tag(profile, sig("wtpt"), c.byref(Triple(0.9642, 1, 0.8249)))
pipeline = api("cmsPipelineAlloc", P, P, U, U)(None, 4, 3)
curves = api("cmsStageAllocToneCurves", P, P, U, P)
insert = api("cmsPipelineInsertStage", c.c_int, P, U, P)
assert insert(pipeline, 1, curves(None, 4, None))
stage = api("cmsStageAllocCLut16bit", P, P, U, U, U, P)(None, 5, 4, 3, None)
srgb, lab = create_srgb(), create_lab(None)
transform = api("cmsCreateTransform", P, P, U, P, U, U, U)(srgb, (4 << 16) | (3 << 3) | 1,
                                                          lab, (1 << 22) | (10 << 16) | (3 << 3), 1, 0)
do_transform = api("cmsDoTransform", None, P, P, P, U)
encode_lab = api("cmsFloat2LabEncodedV2", None, P, P)
sampler_type = c.CFUNCTYPE(c.c_int, c.POINTER(c.c_uint16), c.POINTER(c.c_uint16), P)


@sampler_type
def sample(inputs, outputs, _cargo):
    cyan, magenta, yellow, black = [inputs[i] / 65535 for i in range(4)]
    rgb = (c.c_ubyte * 3)(*[round(255 * (1 - ink) * (1 - black)) for ink in (cyan, magenta, yellow)])
    lab_value = Triple()
    do_transform(transform, rgb, c.byref(lab_value), 1)
    encode_lab(outputs, c.byref(lab_value))
    return 1


assert api("cmsStageSampleCLut16bit", c.c_int, P, sampler_type, P, U)(stage, sample, None, 0)
assert insert(pipeline, 1, stage)
assert insert(pipeline, 1, curves(None, 3, None))
assert write_tag(profile, sig("A2B0"), pipeline)
api("cmsPipelineFree", None, P)(pipeline)
api("cmsDeleteTransform", None, P)(transform)
close(srgb)
close(lab)
emit(profile, "synthetic-cmyk")
