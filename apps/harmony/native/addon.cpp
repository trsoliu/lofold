#include <napi/native_api.h>
#include <cstdint>
#include <string>

extern "C" char *lofold_archive(const char *, const uint8_t *, const char *,
                                const char *, uint32_t, const uint8_t *, size_t);
extern "C" void lofold_free_json(char *);

static bool stringArg(napi_env env, napi_value value, std::string &result) {
    size_t size = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 8192) {
        return false;
    }
    result.resize(size + 1);
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &copied) != napi_ok) {
        return false;
    }
    result.resize(copied);
    return result.find('\0') == std::string::npos;
}

static napi_value invoke(napi_env env, napi_callback_info info) {
    napi_value args[6] = {};
    size_t argc = 6;
    void *key = nullptr, *raw = nullptr;
    size_t keySize = 0, rawSize = 0;
    uint32_t offset = 0;
    std::string path, operation, argument;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
        argc != 6 || !stringArg(env, args[0], path) ||
        napi_get_arraybuffer_info(env, args[1], &key, &keySize) != napi_ok ||
        key == nullptr || keySize != 32 || !stringArg(env, args[2], operation) ||
        !stringArg(env, args[3], argument) ||
        napi_get_value_uint32(env, args[4], &offset) != napi_ok ||
        napi_get_arraybuffer_info(env, args[5], &raw, &rawSize) != napi_ok ||
        rawSize > 16 * 1024 * 1024 || (rawSize > 0 && raw == nullptr)) {
        napi_throw_type_error(env, nullptr, "归档参数无效。");
        return nullptr;
    }
    char *reply = lofold_archive(path.c_str(), static_cast<uint8_t *>(key), operation.c_str(),
                                argument.c_str(), offset, static_cast<uint8_t *>(raw), rawSize);
    napi_value json;
    napi_status status = napi_create_string_utf8(env, reply, NAPI_AUTO_LENGTH, &json);
    lofold_free_json(reply);
    return status == napi_ok ? json : nullptr;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor property = {
        "invoke", nullptr, invoke, nullptr, nullptr, nullptr, napi_default, nullptr
    };
    if (napi_define_properties(env, exports, 1, &property) != napi_ok) {
        return nullptr;
    }
    return exports;
}

static napi_module module = {1, 0, nullptr, init, "lofold", nullptr, {nullptr}};
extern "C" __attribute__((constructor)) void registerLoFold(void) {
    napi_module_register(&module);
}
