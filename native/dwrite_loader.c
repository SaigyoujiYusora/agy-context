/*
 * AGY Context DWrite.dll side-load bootstrapper (Windows x64).
 *
 * 1. Forwards DWriteCreateFactory directly to C:\Windows\System32\DWrite.dll
 *    via PE export forwarding (resolved by ntdll before Chromium sandbox
 *    token lowering).
 * 2. In the Antigravity.exe main browser process only (never renderer/GPU or
 *    ELECTRON_RUN_AS_NODE child processes), using kernel32.lib ONLY (zero
 *    extra DLL imports, safe under DllMain loader lock and compatible with
 *    co-located version.dll proxies):
 *    - Cleans up leftover DWrite.dll.old* files from prior hot-swaps.
 *    - Checks %USERPROFILE%\.gemini\config\plugins\agy-model-inspector\native\DWrite.dll
 *      and atomically self-updates <exeDir>\DWrite.dll (with rollback on copy
 *      failure) whenever a newer revision/build is available.
 *    - Reads Antigravity's real version from resources\app.asar's root
 *      package.json (with in-memory PE RT_VERSION VS_FIXEDFILEINFO fallback)
 *      and keeps resources\app\{package.json,index.cjs} healed and version-
 *      synced across every Antigravity update (never shows Version 0.0.0).
 *    - Installs a one-shot IAT redirect on Antigravity.exe's KERNEL32 file APIs
 *      so Electron's appSearchPaths skips resources\app.asar once and boots
 *      resources\app\index.cjs, which loads electron-overlay-loader.cjs and
 *      immediately delegates back to the untouched resources\app.asar.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winver.h>
#include <wchar.h>
#include <string.h>

#pragma comment(linker, "/export:DWriteCreateFactory=C:\\Windows\\System32\\DWrite.DWriteCreateFactory,@1")

#define AGY_CONTEXT_DLL_REV 2

static const char * const volatile AGY_CONTEXT_DLL_MARKER = "AGY_CONTEXT_DWRITE_LOADER_V1";
static const char * const volatile AGY_CONTEXT_DLL_REV_MARKER = "AGY_CONTEXT_DWRITE_REV=0002";

static const char BOOTSTRAP_INDEX_CJS[] =
    "'use strict';\n"
    "// AGY_CONTEXT_ELECTRON_LOADER - self-healing bootstrapper (app.asar left untouched)\n"
    "\n"
    "const fs = require('fs');\n"
    "const os = require('os');\n"
    "const path = require('path');\n"
    "\n"
    "const loaderPath = path.join(\n"
    "  process.env.USERPROFILE || process.env.HOME || os.homedir(),\n"
    "  '.gemini', 'config', 'plugins', 'agy-model-inspector', 'scripts', 'electron-overlay-loader.cjs'\n"
    ");\n"
    "try {\n"
    "  if (fs.existsSync(loaderPath)) {\n"
    "    require(loaderPath);\n"
    "  }\n"
    "} catch (err) {\n"
    "  console.warn('[AGY Context] Direct Electron loader skipped:', err && err.message ? err.message : err);\n"
    "}\n"
    "\n"
    "const asarPath = path.resolve(__dirname, '..', 'app.asar');\n"
    "let realPkg = { main: 'dist/main.js' };\n"
    "try {\n"
    "  realPkg = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));\n"
    "} catch {}\n"
    "\n"
    "try {\n"
    "  const electron = require('electron');\n"
    "  if (electron && electron.app) {\n"
    "    if (realPkg && realPkg.version) {\n"
    "      electron.app.getVersion = () => realPkg.version;\n"
    "    }\n"
    "    electron.app.getAppPath = () => asarPath;\n"
    "  }\n"
    "} catch {}\n"
    "\n"
    "const mainRel = (realPkg && realPkg.main) ? realPkg.main : 'dist/main.js';\n"
    "module.exports = require(path.join(asarPath, mainRel));\n";

typedef HANDLE (WINAPI *PFN_CreateFileW)(
    LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef DWORD (WINAPI *PFN_GetFileAttributesW)(LPCWSTR);
typedef BOOL (WINAPI *PFN_GetFileAttributesExW)(
    LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID);

static PFN_CreateFileW          g_orig_CreateFileW          = NULL;
static PFN_GetFileAttributesW   g_orig_GetFileAttributesW   = NULL;
static PFN_GetFileAttributesExW g_orig_GetFileAttributesExW = NULL;

static volatile LONG g_bypass_active = 0;
static wchar_t g_target_asar[2048];
static wchar_t g_trigger_index[2048];

static wchar_t norm_char(wchar_t c) {
    if (c == L'/') return L'\\';
    if (c >= L'A' && c <= L'Z') return (wchar_t)(c + 32);
    return c;
}

static int wcscmp_ascii_ci(const wchar_t *a, const wchar_t *b) {
    while (*a && *b) {
        wchar_t ca = norm_char(*a);
        wchar_t cb = norm_char(*b);
        if (ca != cb) return (int)(ca - cb);
        ++a;
        ++b;
    }
    return (int)(norm_char(*a) - norm_char(*b));
}

static int contains_sub_ci(const wchar_t *haystack, const wchar_t *needle) {
    size_t nlen = wcslen(needle);
    if (nlen == 0) return 1;
    for (const wchar_t *p = haystack; *p; ++p) {
        size_t i = 0;
        while (i < nlen && p[i]) {
            if (norm_char(p[i]) != norm_char(needle[i])) break;
            ++i;
        }
        if (i == nlen) return 1;
    }
    return 0;
}

static const wchar_t *strip_win32_prefix(const wchar_t *p) {
    if (!p) return NULL;
    if (p[0] == L'\\' && p[1] == L'\\' && (p[2] == L'?' || p[2] == L'.') && p[3] == L'\\') {
        return p + 4;
    }
    return p;
}

static int path_equals_ci(const wchar_t *a, const wchar_t *b) {
    if (!a || !b || !b[0]) return 0;
    a = strip_win32_prefix(a);
    b = strip_win32_prefix(b);
    return wcscmp_ascii_ci(a, b) == 0;
}

static int file_exists(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return (attr != INVALID_FILE_ATTRIBUTES) && ((attr & FILE_ATTRIBUTE_DIRECTORY) == 0);
}

static int read_file_exact(HANDLE h, void *buf, DWORD len) {
    BYTE *dst = (BYTE *)buf;
    DWORD done = 0;
    while (done < len) {
        DWORD chunk = 0;
        if (!ReadFile(h, dst + done, len - done, &chunk, NULL) || chunk == 0) {
            return 0;
        }
        done += chunk;
    }
    return 1;
}

static BYTE *read_entire_file(const wchar_t *path, DWORD minSize, DWORD maxSize, DWORD *outSize) {
    if (outSize) *outSize = 0;
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;

    LARGE_INTEGER li;
    if (!GetFileSizeEx(h, &li) || li.QuadPart < (LONGLONG)minSize || li.QuadPart > (LONGLONG)maxSize) {
        CloseHandle(h);
        return NULL;
    }

    DWORD sz = (DWORD)li.QuadPart;
    BYTE *buf = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)sz + 1);
    if (!buf) {
        CloseHandle(h);
        return NULL;
    }
    if (!read_file_exact(h, buf, sz)) {
        HeapFree(GetProcessHeap(), 0, buf);
        CloseHandle(h);
        return NULL;
    }
    CloseHandle(h);
    buf[sz] = '\0';
    if (outSize) *outSize = sz;
    return buf;
}

static int file_matches_bytes(const wchar_t *path, const char *expected, size_t expectedLen) {
    DWORD actualLen = 0;
    BYTE *buf = read_entire_file(path, (DWORD)expectedLen, (DWORD)expectedLen, &actualLen);
    if (!buf) return 0;
    int eq = (actualLen == (DWORD)expectedLen) && (memcmp(buf, expected, expectedLen) == 0);
    HeapFree(GetProcessHeap(), 0, buf);
    return eq;
}

static int write_ascii_file(const wchar_t *path, const char *content, size_t totalLen) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD written = 0;
    BOOL ok = WriteFile(h, content, (DWORD)totalLen, &written, NULL);
    CloseHandle(h);
    return ok && written == (DWORD)totalLen;
}

static int append_str(char *dst, size_t cap, size_t *pos, const char *src) {
    size_t slen = strlen(src);
    if (*pos + slen >= cap) return 0;
    memcpy(dst + *pos, src, slen);
    *pos += slen;
    dst[*pos] = '\0';
    return 1;
}

static int append_uint(char *dst, size_t cap, size_t *pos, DWORD val) {
    char tmp[16];
    size_t n = 0;
    if (val == 0) {
        tmp[n++] = '0';
    } else {
        while (val > 0 && n < sizeof(tmp)) {
            tmp[n++] = (char)('0' + (val % 10));
            val /= 10;
        }
    }
    if (*pos + n >= cap) return 0;
    while (n > 0) {
        dst[(*pos)++] = tmp[--n];
    }
    dst[*pos] = '\0';
    return 1;
}

static void append_uint_w(wchar_t *dst, size_t cap, DWORD val) {
    size_t pos = wcslen(dst);
    wchar_t tmp[16];
    size_t n = 0;
    if (val == 0) {
        tmp[n++] = L'0';
    } else {
        while (val > 0 && n < 16) {
            tmp[n++] = (wchar_t)(L'0' + (val % 10));
            val /= 10;
        }
    }
    if (pos + n >= cap) return;
    while (n > 0) {
        dst[pos++] = tmp[--n];
    }
    dst[pos] = L'\0';
}

static int is_valid_version_str(const char *s, size_t len) {
    if (len == 0 || len >= 48) return 0;
    int hasDigit = 0;
    for (size_t i = 0; i < len; ++i) {
        char c = s[i];
        if (c >= '0' && c <= '9') {
            hasDigit = 1;
        } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   c == '.' || c == '-' || c == '_' || c == '+') {
            /* ok */
        } else {
            return 0;
        }
    }
    return hasDigit;
}

/* Advance past a JSON string starting at p (where *p == '"'). Returns pointer after closing '"' or NULL. */
static const char *skip_json_string(const char *p, const char *end) {
    if (p >= end || *p != '"') return NULL;
    ++p;
    while (p < end) {
        if (*p == '\\') {
            p += 2;
            continue;
        }
        if (*p == '"') return p + 1;
        ++p;
    }
    return NULL;
}

/* Skip JSON whitespace. */
static const char *skip_ws(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
    return p;
}

/* Extract a JSON string value for key `wantKey` at exact brace depth `wantDepth`. */
static int json_find_string_at_depth(const char *json, size_t len, int wantDepth, const char *wantKey, char *out, size_t outCap) {
    const char *p = json;
    const char *end = json + len;
    size_t wantKeyLen = strlen(wantKey);
    int depth = 0;

    while (p < end) {
        char c = *p;
        if (c == '{') {
            ++depth;
            ++p;
        } else if (c == '}') {
            if (depth > 0) --depth;
            ++p;
        } else if (c == '"') {
            const char *keyStart = p + 1;
            const char *afterKey = skip_json_string(p, end);
            if (!afterKey) return 0;
            size_t keyLen = (size_t)((afterKey - 1) - keyStart);
            const char *q = skip_ws(afterKey, end);
            if (q < end && *q == ':') {
                q = skip_ws(q + 1, end);
                if (depth == wantDepth && keyLen == wantKeyLen && memcmp(keyStart, wantKey, wantKeyLen) == 0) {
                    if (q < end && *q == '"') {
                        const char *vStart = q + 1;
                        const char *vEnd = skip_json_string(q, end);
                        if (!vEnd) return 0;
                        size_t vLen = (size_t)((vEnd - 1) - vStart);
                        if (vLen >= outCap) return 0;
                        memcpy(out, vStart, vLen);
                        out[vLen] = '\0';
                        return 1;
                    }
                    return 0;
                }
                p = q;
            } else {
                p = afterKey;
            }
        } else {
            ++p;
        }
    }
    return 0;
}

/* Extract unsigned integer value (either numeric or quoted decimal) for key `wantKey` at depth 1 inside an object slice. */
static int json_find_uint64_shallow(const char *obj, size_t len, const char *wantKey, ULONGLONG *outVal) {
    const char *p = obj;
    const char *end = obj + len;
    size_t wantKeyLen = strlen(wantKey);
    int depth = 0;

    while (p < end) {
        char c = *p;
        if (c == '{') {
            ++depth;
            ++p;
        } else if (c == '}') {
            if (depth > 0) --depth;
            ++p;
        } else if (c == '"') {
            const char *keyStart = p + 1;
            const char *afterKey = skip_json_string(p, end);
            if (!afterKey) return 0;
            size_t keyLen = (size_t)((afterKey - 1) - keyStart);
            const char *q = skip_ws(afterKey, end);
            if (q < end && *q == ':') {
                q = skip_ws(q + 1, end);
                if (depth == 1 && keyLen == wantKeyLen && memcmp(keyStart, wantKey, wantKeyLen) == 0) {
                    if (q < end && *q == '"') ++q;
                    if (q >= end || *q < '0' || *q > '9') return 0;
                    ULONGLONG v = 0;
                    while (q < end && *q >= '0' && *q <= '9') {
                        v = v * 10 + (ULONGLONG)(*q - '0');
                        ++q;
                    }
                    *outVal = v;
                    return 1;
                }
                p = q;
            } else {
                p = afterKey;
            }
        } else {
            ++p;
        }
    }
    return 0;
}

/*
 * Locate root "package.json" inside app.asar (brace depth == 2, direct child of top-level "files")
 * and read its "version" string.
 */
static int read_version_from_asar(const wchar_t *asarPath, char *verOut, size_t verCap) {
    HANDLE h = CreateFileW(asarPath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;

    DWORD hdr[4];
    if (!read_file_exact(h, hdr, sizeof(hdr))) {
        CloseHandle(h);
        return 0;
    }
    DWORD jsonLen = hdr[3];
    if (hdr[0] != 4 || hdr[1] < 8 || jsonLen < 16 || jsonLen > 4 * 1024 * 1024) {
        CloseHandle(h);
        return 0;
    }
    ULONGLONG dataOffset = 8ULL + (ULONGLONG)hdr[1];

    char *jsonBuf = (char *)HeapAlloc(GetProcessHeap(), 0, (size_t)jsonLen + 1);
    if (!jsonBuf) {
        CloseHandle(h);
        return 0;
    }
    if (!read_file_exact(h, jsonBuf, jsonLen)) {
        HeapFree(GetProcessHeap(), 0, jsonBuf);
        CloseHandle(h);
        return 0;
    }
    jsonBuf[jsonLen] = '\0';

    /* Find `"package.json":{...}` at brace depth == 2 (root entry under `"files"`). */
    const char *p = jsonBuf;
    const char *end = jsonBuf + jsonLen;
    int depth = 0;
    ULONGLONG pkgSize = 0;
    ULONGLONG pkgOffset = 0;
    int foundEntry = 0;

    while (p < end) {
        char c = *p;
        if (c == '{') {
            ++depth;
            ++p;
        } else if (c == '}') {
            if (depth > 0) --depth;
            ++p;
        } else if (c == '"') {
            const char *keyStart = p + 1;
            const char *afterKey = skip_json_string(p, end);
            if (!afterKey) break;
            size_t keyLen = (size_t)((afterKey - 1) - keyStart);
            const char *q = skip_ws(afterKey, end);
            if (q < end && *q == ':') {
                q = skip_ws(q + 1, end);
                if (depth == 2 && keyLen == 12 && memcmp(keyStart, "package.json", 12) == 0 && q < end && *q == '{') {
                    const char *objStart = q;
                    int subDepth = 0;
                    const char *r = q;
                    while (r < end) {
                        if (*r == '"') {
                            r = skip_json_string(r, end);
                            if (!r) break;
                            continue;
                        }
                        if (*r == '{') ++subDepth;
                        else if (*r == '}') {
                            --subDepth;
                            if (subDepth == 0) { ++r; break; }
                        }
                        ++r;
                    }
                    if (r && r > objStart && subDepth == 0) {
                        size_t objLen = (size_t)(r - objStart);
                        if (json_find_uint64_shallow(objStart, objLen, "size", &pkgSize) &&
                            json_find_uint64_shallow(objStart, objLen, "offset", &pkgOffset)) {
                            foundEntry = 1;
                        }
                    }
                    break;
                }
                p = q;
            } else {
                p = afterKey;
            }
        } else {
            ++p;
        }
    }

    HeapFree(GetProcessHeap(), 0, jsonBuf);
    if (!foundEntry || pkgSize == 0 || pkgSize > 65536) {
        CloseHandle(h);
        return 0;
    }

    LARGE_INTEGER seekPos;
    seekPos.QuadPart = (LONGLONG)(dataOffset + pkgOffset);
    if (!SetFilePointerEx(h, seekPos, NULL, FILE_BEGIN)) {
        CloseHandle(h);
        return 0;
    }

    char *pkgBuf = (char *)HeapAlloc(GetProcessHeap(), 0, (size_t)pkgSize + 1);
    if (!pkgBuf) {
        CloseHandle(h);
        return 0;
    }
    int ok = read_file_exact(h, pkgBuf, (DWORD)pkgSize);
    CloseHandle(h);
    if (!ok) {
        HeapFree(GetProcessHeap(), 0, pkgBuf);
        return 0;
    }
    pkgBuf[pkgSize] = '\0';

    char tmpVer[64];
    int gotVer = json_find_string_at_depth(pkgBuf, (size_t)pkgSize, 1, "version", tmpVer, sizeof(tmpVer));
    HeapFree(GetProcessHeap(), 0, pkgBuf);
    if (!gotVer || !is_valid_version_str(tmpVer, strlen(tmpVer))) return 0;
    if (strlen(tmpVer) >= verCap) return 0;
    memcpy(verOut, tmpVer, strlen(tmpVer) + 1);
    return 1;
}

/* Fallback: read VS_FIXEDFILEINFO directly from Antigravity.exe's in-memory RT_VERSION resource (kernel32 only). */
static int read_version_from_exe_resource(char *verOut, size_t verCap) {
    HMODULE hExe = GetModuleHandleW(NULL);
    if (!hExe) return 0;
    HRSRC hRes = FindResourceW(hExe, MAKEINTRESOURCEW(1), MAKEINTRESOURCEW(16)); /* RT_VERSION = 16 */
    if (!hRes) return 0;
    DWORD sz = SizeofResource(hExe, hRes);
    if (sz < sizeof(VS_FIXEDFILEINFO)) return 0;
    HGLOBAL hData = LoadResource(hExe, hRes);
    if (!hData) return 0;
    const BYTE *ptr = (const BYTE *)LockResource(hData);
    if (!ptr) return 0;

    for (DWORD off = 0; off + sizeof(VS_FIXEDFILEINFO) <= sz; off += 4) {
        const VS_FIXEDFILEINFO *ffi = (const VS_FIXEDFILEINFO *)(ptr + off);
        if (ffi->dwSignature == VS_FFI_SIGNATURE) {
            DWORD maj = HIWORD(ffi->dwProductVersionMS);
            DWORD min = LOWORD(ffi->dwProductVersionMS);
            DWORD pat = HIWORD(ffi->dwProductVersionLS);
            DWORD bld = LOWORD(ffi->dwProductVersionLS);
            if (maj == 0 && min == 0 && pat == 0) return 0;
            size_t pos = 0;
            if (!append_uint(verOut, verCap, &pos, maj)) return 0;
            if (!append_str(verOut, verCap, &pos, ".")) return 0;
            if (!append_uint(verOut, verCap, &pos, min)) return 0;
            if (!append_str(verOut, verCap, &pos, ".")) return 0;
            if (!append_uint(verOut, verCap, &pos, pat)) return 0;
            if (bld != 0) {
                if (!append_str(verOut, verCap, &pos, ".")) return 0;
                if (!append_uint(verOut, verCap, &pos, bld)) return 0;
            }
            return 1;
        }
    }
    return 0;
}

/* Remove leftover DWrite.dll.old* files from prior hot-swaps. */
static void cleanup_old_dlls(const wchar_t *exeDir) {
    wchar_t pattern[2048];
    if (wcslen(exeDir) + 32 >= 2048) return;
    wcscpy_s(pattern, 2048, exeDir);
    wcscat_s(pattern, 2048, L"\\DWrite.dll.old*");

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pattern, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
        wchar_t fullPath[2048];
        if (wcslen(exeDir) + 1 + wcslen(fd.cFileName) + 1 < 2048) {
            wcscpy_s(fullPath, 2048, exeDir);
            wcscat_s(fullPath, 2048, L"\\");
            wcscat_s(fullPath, 2048, fd.cFileName);
            DeleteFileW(fullPath);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
}

static int find_ascii_marker(const BYTE *buf, DWORD bufLen, const char *needle) {
    size_t nlen = strlen(needle);
    if (nlen == 0 || bufLen < nlen) return -1;
    DWORD limit = bufLen - (DWORD)nlen;
    for (DWORD i = 0; i <= limit; ++i) {
        if (buf[i] == (BYTE)needle[0] && memcmp(buf + i, needle, nlen) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static int is_valid_pe64_dll(const BYTE *buf, DWORD len) {
    if (len < sizeof(IMAGE_DOS_HEADER) + sizeof(IMAGE_NT_HEADERS)) return 0;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)buf;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    if (dos->e_lfanew < 0 || (DWORD)dos->e_lfanew + sizeof(IMAGE_NT_HEADERS) > len) return 0;
    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)(buf + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    if ((nt->FileHeader.Characteristics & IMAGE_FILE_DLL) == 0) return 0;
    return 1;
}

static int parse_dll_rev(const BYTE *buf, DWORD len) {
    const char *prefix = "AGY_CONTEXT_DWRITE_REV=";
    int idx = find_ascii_marker(buf, len, prefix);
    if (idx < 0) return 1; /* Rev 1 predated explicit REV marker */
    size_t off = (size_t)idx + strlen(prefix);
    int val = 0;
    int digits = 0;
    while (off < len && digits < 6 && buf[off] >= '0' && buf[off] <= '9') {
        val = val * 10 + (int)(buf[off] - '0');
        ++off;
        ++digits;
    }
    return digits > 0 ? val : 1;
}

/*
 * Check %USERPROFILE%\.gemini\config\plugins\agy-model-inspector\native\DWrite.dll.
 * If a newer AGY Context DLL exists there, rename our currently loaded DLL aside and
 * copy the new one in place (with rollback on failure) so the next launch loads it.
 */
static void maybe_self_update_dll(HINSTANCE hSelfDll, const wchar_t *exeDir, const wchar_t *userProfile) {
    wchar_t selfPath[2048];
    DWORD selfLen = GetModuleFileNameW(hSelfDll, selfPath, 2048);
    if (selfLen == 0 || selfLen >= 2048) return;

    wchar_t expectedSelf[2048];
    if (wcslen(exeDir) + 16 >= 2048) return;
    wcscpy_s(expectedSelf, 2048, exeDir);
    wcscat_s(expectedSelf, 2048, L"\\DWrite.dll");
    if (!path_equals_ci(selfPath, expectedSelf)) return;

    const wchar_t *srcRel = L"\\.gemini\\config\\plugins\\agy-model-inspector\\native\\DWrite.dll";
    wchar_t srcPath[2048];
    if (wcslen(userProfile) + wcslen(srcRel) + 1 >= 2048) return;
    wcscpy_s(srcPath, 2048, userProfile);
    wcscat_s(srcPath, 2048, srcRel);
    if (path_equals_ci(srcPath, selfPath)) return;

    WIN32_FILE_ATTRIBUTE_DATA srcAttr;
    WIN32_FILE_ATTRIBUTE_DATA selfAttr;
    if (!GetFileAttributesExW(srcPath, GetFileExInfoStandard, &srcAttr)) return;
    if (!GetFileAttributesExW(selfPath, GetFileExInfoStandard, &selfAttr)) return;
    if ((srcAttr.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) return;

    /* Fast path: identical size and LastWriteTime -> already synced, zero file reads. */
    if (srcAttr.nFileSizeHigh == 0 && selfAttr.nFileSizeHigh == 0 &&
        srcAttr.nFileSizeLow == selfAttr.nFileSizeLow &&
        CompareFileTime(&srcAttr.ftLastWriteTime, &selfAttr.ftLastWriteTime) == 0) {
        return;
    }

    DWORD srcBytesLen = 0;
    BYTE *srcBytes = read_entire_file(srcPath, 16 * 1024, 2 * 1024 * 1024, &srcBytesLen);
    if (!srcBytes) return;

    int valid = is_valid_pe64_dll(srcBytes, srcBytesLen) &&
                find_ascii_marker(srcBytes, srcBytesLen, "AGY_CONTEXT_DWRITE_LOADER_V1") >= 0;
    int srcRev = valid ? parse_dll_rev(srcBytes, srcBytesLen) : 0;

    int shouldUpdate = 0;
    if (valid) {
        if (srcRev > AGY_CONTEXT_DLL_REV) {
            shouldUpdate = 1;
        } else if (srcRev == AGY_CONTEXT_DLL_REV &&
                   CompareFileTime(&srcAttr.ftLastWriteTime, &selfAttr.ftLastWriteTime) > 0) {
            DWORD selfBytesLen = 0;
            BYTE *selfBytes = read_entire_file(selfPath, 16 * 1024, 2 * 1024 * 1024, &selfBytesLen);
            if (selfBytes) {
                if (selfBytesLen != srcBytesLen || memcmp(selfBytes, srcBytes, srcBytesLen) != 0) {
                    shouldUpdate = 1;
                }
                HeapFree(GetProcessHeap(), 0, selfBytes);
            }
        }
    }
    HeapFree(GetProcessHeap(), 0, srcBytes);
    if (!shouldUpdate) return;

    wchar_t oldPath[2048];
    if (wcslen(exeDir) + 40 >= 2048) return;
    wcscpy_s(oldPath, 2048, exeDir);
    wcscat_s(oldPath, 2048, L"\\DWrite.dll.old.");
    append_uint_w(oldPath, 2048, GetCurrentProcessId());

    if (!MoveFileExW(selfPath, oldPath, MOVEFILE_REPLACE_EXISTING)) {
        return;
    }
    if (!CopyFileW(srcPath, selfPath, FALSE)) {
        /* Roll back immediately so Antigravity is never left without DWrite.dll. */
        MoveFileExW(oldPath, selfPath, MOVEFILE_REPLACE_EXISTING);
    }
}

static int ensure_bootstrap_files(const wchar_t *exeDir) {
    wchar_t appDir[2048];
    wchar_t pkgPath[2048];
    if (wcslen(exeDir) + 64 >= 2048) return 0;

    wcscpy_s(appDir, 2048, exeDir);
    wcscat_s(appDir, 2048, L"\\resources\\app");
    wcscpy_s(pkgPath, 2048, appDir);
    wcscat_s(pkgPath, 2048, L"\\package.json");

    /* Resolve real Antigravity version from app.asar (with PE RT_VERSION fallback). */
    char realVer[64];
    realVer[0] = '\0';
    if (!read_version_from_asar(g_target_asar, realVer, sizeof(realVer))) {
        read_version_from_exe_resource(realVer, sizeof(realVer));
    }

    char expectedPkg[512];
    size_t pkgPos = 0;
    expectedPkg[0] = '\0';
    append_str(expectedPkg, sizeof(expectedPkg), &pkgPos, "{\n  \"name\": \"antigravity\",\n  \"productName\": \"Antigravity\",\n");
    if (realVer[0] != '\0') {
        append_str(expectedPkg, sizeof(expectedPkg), &pkgPos, "  \"version\": \"");
        append_str(expectedPkg, sizeof(expectedPkg), &pkgPos, realVer);
        append_str(expectedPkg, sizeof(expectedPkg), &pkgPos, "\",\n");
    }
    append_str(expectedPkg, sizeof(expectedPkg), &pkgPos, "  \"main\": \"index.cjs\"\n}\n");

    CreateDirectoryW(appDir, NULL);

    if (!file_matches_bytes(pkgPath, expectedPkg, pkgPos)) {
        if (!write_ascii_file(pkgPath, expectedPkg, pkgPos)) return 0;
    }

    size_t idxLen = strlen(BOOTSTRAP_INDEX_CJS);
    if (!file_matches_bytes(g_trigger_index, BOOTSTRAP_INDEX_CJS, idxLen)) {
        if (!write_ascii_file(g_trigger_index, BOOTSTRAP_INDEX_CJS, idxLen)) return 0;
    }

    return file_exists(g_trigger_index) && file_exists(pkgPath);
}

static int should_hide_asar(LPCWSTR lpFileName) {
    if (InterlockedCompareExchange(&g_bypass_active, 1, 1) != 1 || !lpFileName) {
        return 0;
    }
    if (path_equals_ci(lpFileName, g_trigger_index)) {
        InterlockedExchange(&g_bypass_active, 0);
        return 0;
    }
    if (path_equals_ci(lpFileName, g_target_asar)) {
        return 1;
    }
    return 0;
}

static HANDLE WINAPI hooked_CreateFileW(
    LPCWSTR lpFileName,
    DWORD dwDesiredAccess,
    DWORD dwShareMode,
    LPSECURITY_ATTRIBUTES lpSecurityAttributes,
    DWORD dwCreationDisposition,
    DWORD dwFlagsAndAttributes,
    HANDLE hTemplateFile
) {
    if (should_hide_asar(lpFileName)) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_HANDLE_VALUE;
    }
    return g_orig_CreateFileW(
        lpFileName, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
        dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
}

static DWORD WINAPI hooked_GetFileAttributesW(LPCWSTR lpFileName) {
    if (should_hide_asar(lpFileName)) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    }
    return g_orig_GetFileAttributesW(lpFileName);
}

static BOOL WINAPI hooked_GetFileAttributesExW(
    LPCWSTR lpFileName,
    GET_FILEEX_INFO_LEVELS fInfoLevelId,
    LPVOID lpFileInformation
) {
    if (should_hide_asar(lpFileName)) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    return g_orig_GetFileAttributesExW(lpFileName, fInfoLevelId, lpFileInformation);
}

static int strcmp_ascii_ci(const char *a, const char *b) {
    while (*a && *b) {
        char ca = (*a >= 'A' && *a <= 'Z') ? (char)(*a + 32) : *a;
        char cb = (*b >= 'A' && *b <= 'Z') ? (char)(*b + 32) : *b;
        if (ca != cb) return (int)(unsigned char)ca - (int)(unsigned char)cb;
        ++a;
        ++b;
    }
    return (int)(unsigned char)*a - (int)(unsigned char)*b;
}

static int patch_iat_entry(HMODULE hMod, const char *targetDll, const char *fnName, void *hookFn, void **origOut) {
    BYTE *base = (BYTE *)hMod;
    if (!base) return 0;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;

    IMAGE_DATA_DIRECTORY impDir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!impDir.VirtualAddress || !impDir.Size) return 0;

    IMAGE_IMPORT_DESCRIPTOR *desc = (IMAGE_IMPORT_DESCRIPTOR *)(base + impDir.VirtualAddress);
    for (; desc->Name != 0; ++desc) {
        const char *dllName = (const char *)(base + desc->Name);
        if (strcmp_ascii_ci(dllName, targetDll) != 0) continue;

        IMAGE_THUNK_DATA *origThunk = desc->OriginalFirstThunk
            ? (IMAGE_THUNK_DATA *)(base + desc->OriginalFirstThunk)
            : (IMAGE_THUNK_DATA *)(base + desc->FirstThunk);
        IMAGE_THUNK_DATA *iatThunk = (IMAGE_THUNK_DATA *)(base + desc->FirstThunk);

        for (; origThunk->u1.AddressOfData != 0; ++origThunk, ++iatThunk) {
            if (IMAGE_SNAP_BY_ORDINAL(origThunk->u1.Ordinal)) continue;
            IMAGE_IMPORT_BY_NAME *imp = (IMAGE_IMPORT_BY_NAME *)(base + origThunk->u1.AddressOfData);
            if (strcmp((const char *)imp->Name, fnName) != 0) continue;

            DWORD oldProt = 0;
            if (!VirtualProtect(&iatThunk->u1.Function, sizeof(ULONG_PTR), PAGE_READWRITE, &oldProt)) {
                return 0;
            }
            if (origOut && !*origOut) {
                *origOut = (void *)(ULONG_PTR)iatThunk->u1.Function;
            }
            iatThunk->u1.Function = (ULONG_PTR)hookFn;
            DWORD dummy = 0;
            VirtualProtect(&iatThunk->u1.Function, sizeof(ULONG_PTR), oldProt, &dummy);
            return 1;
        }
    }
    return 0;
}

static void maybe_install_asar_bypass(HINSTANCE hSelfDll) {
    wchar_t exePath[2048];
    DWORD exeLen = GetModuleFileNameW(NULL, exePath, 2048);
    if (exeLen == 0 || exeLen >= 2048) return;

    wchar_t *lastSep = NULL;
    for (wchar_t *p = exePath; *p; ++p) {
        if (*p == L'\\' || *p == L'/') lastSep = p;
    }
    const wchar_t *baseName = lastSep ? (lastSep + 1) : exePath;
    if (wcscmp_ascii_ci(baseName, L"Antigravity.exe") != 0) return;

    const wchar_t *cmdLine = GetCommandLineW();
    if (!cmdLine || contains_sub_ci(cmdLine, L"--type=")) return;

    wchar_t runAsNode[16];
    DWORD runAsNodeLen = GetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", runAsNode, 16);
    if (runAsNodeLen > 0 && wcscmp(runAsNode, L"0") != 0) return;

    if (!lastSep) return;
    size_t dirLen = (size_t)(lastSep - exePath);
    if (dirLen + 64 >= 2048) return;

    wchar_t exeDir[2048];
    wcsncpy_s(exeDir, 2048, exePath, dirLen);
    exeDir[dirLen] = L'\0';

    /* Clean up leftover DWrite.dll.old* from prior self-updates or reinstalls. */
    cleanup_old_dlls(exeDir);

    /* Check plugin overlay loader exists before enabling redirect or recreating resources\app. */
    wchar_t userProfile[1024];
    DWORD upLen = GetEnvironmentVariableW(L"USERPROFILE", userProfile, 1024);
    if (upLen == 0 || upLen >= 1024) return;

    /* Self-update DWrite.dll from plugin dir if a newer revision/build was installed. */
    maybe_self_update_dll(hSelfDll, exeDir, userProfile);

    const wchar_t *pluginRel = L"\\.gemini\\config\\plugins\\agy-model-inspector\\scripts\\electron-overlay-loader.cjs";
    wchar_t pluginPath[2048];
    if (upLen + wcslen(pluginRel) + 1 >= 2048) return;
    wcscpy_s(pluginPath, 2048, userProfile);
    wcscat_s(pluginPath, 2048, pluginRel);
    if (!file_exists(pluginPath)) return;

    wcscpy_s(g_target_asar, 2048, exeDir);
    wcscat_s(g_target_asar, 2048, L"\\resources\\app.asar");
    if (!file_exists(g_target_asar)) return;

    wcscpy_s(g_trigger_index, 2048, exeDir);
    wcscat_s(g_trigger_index, 2048, L"\\resources\\app\\index.cjs");

    /* Self-heal and keep resources\app\package.json version synced with app.asar on every boot. */
    if (!ensure_bootstrap_files(exeDir)) return;

    HMODULE hExe = GetModuleHandleW(NULL);
    int hooked = 0;
    hooked += patch_iat_entry(hExe, "KERNEL32.dll", "CreateFileW", (void *)hooked_CreateFileW, (void **)&g_orig_CreateFileW);
    hooked += patch_iat_entry(hExe, "KERNEL32.dll", "GetFileAttributesW", (void *)hooked_GetFileAttributesW, (void **)&g_orig_GetFileAttributesW);
    hooked += patch_iat_entry(hExe, "KERNEL32.dll", "GetFileAttributesExW", (void *)hooked_GetFileAttributesExW, (void **)&g_orig_GetFileAttributesExW);

    if (hooked > 0) {
        InterlockedExchange(&g_bypass_active, 1);
    }
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;
    (void)AGY_CONTEXT_DLL_MARKER[0];
    (void)AGY_CONTEXT_DLL_REV_MARKER[0];
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        maybe_install_asar_bypass(hinstDLL);
    }
    return TRUE;
}
