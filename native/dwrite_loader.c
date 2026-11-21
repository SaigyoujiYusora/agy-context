/*
 * AGY Context DWrite.dll side-load bootstrapper (Windows x64).
 *
 * 1. Forwards DWriteCreateFactory directly to C:\Windows\System32\DWrite.dll
 *    via PE export forwarding (resolved by ntdll before Chromium sandbox
 *    token lowering).
 * 2. In the Antigravity.exe main browser process only (never renderer/GPU or
 *    ELECTRON_RUN_AS_NODE child processes):
 *    - Checks that the AGY Context plugin script exists in %USERPROFILE%.
 *    - Auto-recreates resources\app\{package.json,index.cjs} if an Antigravity
 *      auto-update cleared resources\app (self-healing across updates).
 *    - Installs a one-shot IAT redirect on Antigravity.exe's KERNEL32 file APIs
 *      so Electron's appSearchPaths skips resources\app.asar once and boots
 *      resources\app\index.cjs, which loads electron-overlay-loader.cjs and
 *      immediately delegates back to the untouched resources\app.asar.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <string.h>

#pragma comment(linker, "/export:DWriteCreateFactory=C:\\Windows\\System32\\DWrite.DWriteCreateFactory,@1")

static const char * const volatile AGY_CONTEXT_DLL_MARKER = "AGY_CONTEXT_DWRITE_LOADER_V1";

static const char BOOTSTRAP_PKG_JSON[] =
    "{\n"
    "  \"name\": \"antigravity\",\n"
    "  \"productName\": \"Antigravity\",\n"
    "  \"main\": \"index.cjs\"\n"
    "}\n";

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

static int write_ascii_file(const wchar_t *path, const char *content) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD total = (DWORD)strlen(content);
    DWORD written = 0;
    BOOL ok = WriteFile(h, content, total, &written, NULL);
    CloseHandle(h);
    return ok && written == total;
}

static int ensure_bootstrap_files(const wchar_t *exeDir) {
    wchar_t appDir[2048];
    wchar_t pkgPath[2048];
    if (wcslen(exeDir) + 64 >= 2048) return 0;

    wcscpy_s(appDir, 2048, exeDir);
    wcscat_s(appDir, 2048, L"\\resources\\app");
    wcscpy_s(pkgPath, 2048, appDir);
    wcscat_s(pkgPath, 2048, L"\\package.json");

    if (file_exists(g_trigger_index) && file_exists(pkgPath)) {
        return 1;
    }

    CreateDirectoryW(appDir, NULL);
    if (!file_exists(pkgPath)) {
        if (!write_ascii_file(pkgPath, BOOTSTRAP_PKG_JSON)) return 0;
    }
    if (!file_exists(g_trigger_index)) {
        if (!write_ascii_file(g_trigger_index, BOOTSTRAP_INDEX_CJS)) return 0;
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

static void maybe_install_asar_bypass(void) {
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

    /* Check plugin overlay loader exists before enabling redirect or recreating resources\app. */
    wchar_t userProfile[1024];
    DWORD upLen = GetEnvironmentVariableW(L"USERPROFILE", userProfile, 1024);
    if (upLen == 0 || upLen >= 1024) return;
    const wchar_t *pluginRel = L"\\.gemini\\config\\plugins\\agy-model-inspector\\scripts\\electron-overlay-loader.cjs";
    wchar_t pluginPath[2048];
    if (upLen + wcslen(pluginRel) + 1 >= 2048) return;
    wcscpy_s(pluginPath, 2048, userProfile);
    wcscat_s(pluginPath, 2048, pluginRel);
    if (!file_exists(pluginPath)) return;

    wchar_t exeDir[2048];
    wcsncpy_s(exeDir, 2048, exePath, dirLen);
    exeDir[dirLen] = L'\0';

    wcscpy_s(g_target_asar, 2048, exeDir);
    wcscat_s(g_target_asar, 2048, L"\\resources\\app.asar");
    if (!file_exists(g_target_asar)) return;

    wcscpy_s(g_trigger_index, 2048, exeDir);
    wcscat_s(g_trigger_index, 2048, L"\\resources\\app\\index.cjs");

    /* Self-heal resources\app if an Antigravity auto-update wiped it. */
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
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        maybe_install_asar_bypass();
    }
    return TRUE;
}
