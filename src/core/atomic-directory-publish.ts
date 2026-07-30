import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';

const EEXIST = 17;
const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 0x0000_0004;

type SupportedAtomicRenamePlatform = 'darwin' | 'linux';

interface AtomicRenameBackend {
  renameNoReplace(source: Buffer, destination: Buffer): number;
  errno(): number;
}

let loadedBackend: AtomicRenameBackend | undefined;

function supportedAtomicRenamePlatform(platform: NodeJS.Platform): SupportedAtomicRenamePlatform {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(
    `Atomic no-replace directory publication is unsupported on platform '${platform}'.`,
  );
}

function errnoFromPointer(pointer: Pointer | null, platform: string): number {
  if (pointer === null) {
    throw new Error(`Atomic no-replace directory publication could not read ${platform} errno.`);
  }
  return read.i32(pointer);
}

function loadDarwinBackend(): AtomicRenameBackend {
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    renamex_np: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
    __error: {
      args: [],
      returns: FFIType.ptr,
    },
  });
  return {
    renameNoReplace: (source, destination) =>
      library.symbols.renamex_np(source, destination, RENAME_EXCL),
    errno: () => errnoFromPointer(library.symbols.__error(), 'Darwin'),
  };
}

function loadLinuxBackend(): AtomicRenameBackend {
  const library = dlopen('libc.so.6', {
    renameat2: {
      args: [
        FFIType.i32,
        FFIType.cstring,
        FFIType.i32,
        FFIType.cstring,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
    __errno_location: {
      args: [],
      returns: FFIType.ptr,
    },
  });
  return {
    renameNoReplace: (source, destination) =>
      library.symbols.renameat2(
        AT_FDCWD,
        source,
        AT_FDCWD,
        destination,
        RENAME_NOREPLACE,
      ),
    errno: () => errnoFromPointer(library.symbols.__errno_location(), 'Linux'),
  };
}

function atomicRenameBackend(): AtomicRenameBackend {
  if (loadedBackend) return loadedBackend;
  const platform = supportedAtomicRenamePlatform(process.platform);
  try {
    loadedBackend = platform === 'darwin' ? loadDarwinBackend() : loadLinuxBackend();
    return loadedBackend;
  } catch (error) {
    throw new Error(
      `Atomic no-replace directory publication is unavailable on ${platform}; refusing `
      + 'to fall back to a racy rename.',
      { cause: error },
    );
  }
}

function nulTerminatedPath(path: string): Buffer {
  if (path.includes('\0')) {
    throw new Error('Atomic no-replace directory publication received a NUL-containing path.');
  }
  return Buffer.from(`${path}\0`);
}

/**
 * Atomically rename a completed directory only when `destination` is absent.
 * Returns false for an occupied destination. Unsupported platforms, missing
 * native symbols, and every other filesystem error fail closed by throwing.
 */
export function renameDirectoryNoReplace(source: string, destination: string): boolean {
  const backend = atomicRenameBackend();
  const result = backend.renameNoReplace(
    nulTerminatedPath(source),
    nulTerminatedPath(destination),
  );
  if (result === 0) return true;

  const errno = backend.errno();
  if (errno === EEXIST) return false;
  throw new Error(
    `Atomic no-replace directory publication failed (errno=${errno}); destination was not `
    + 'published.',
  );
}

export const __testing = {
  supportedAtomicRenamePlatform,
};
