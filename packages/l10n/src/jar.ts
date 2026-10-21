import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

import { compareText } from "#/value";

export interface JarResource {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface JarReadResult {
  readonly resources: readonly JarResource[];
  readonly duplicatePaths: readonly string[];
}

export async function readJarResources(
  bytes: Uint8Array,
): Promise<JarReadResult> {
  const files = new Map<string, Uint8Array>();
  const duplicates = new Set<string>();
  const pending: Promise<void>[] = [];
  const unzip = new Unzip((file) => {
    const path = file.name;
    if (!path.endsWith("/") && files.has(path)) {
      duplicates.add(path);
    }

    const chunks: Uint8Array[] = [];
    const completion = new Promise<void>((resolve, reject) => {
      file.ondata = (error, chunk, final) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (chunk.length > 0) chunks.push(chunk);
        if (final) {
          const size = chunks.reduce((total, part) => total + part.length, 0);
          const content = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) {
            content.set(part, offset);
            offset += part.length;
          }
          if (!path.endsWith("/")) files.set(path, content);
          resolve();
        }
      };
    });
    pending.push(completion);
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.push(bytes, true);
  await Promise.all(pending);

  return {
    resources: [...files.entries()]
      .filter(([path]) => !path.endsWith("/") && !path.endsWith(".class"))
      .map(([path, content]) => ({ path, bytes: content }))
      .sort((left, right) => compareText(left.path, right.path)),
    duplicatePaths: [...duplicates].sort(),
  };
}
