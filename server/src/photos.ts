import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const MAX_PHOTOS_PER_REQUEST = 10;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_THUMB_BYTES = 2 * 1024 * 1024;

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export interface StoredPhotoFiles {
  file: string;
  thumb: string;
}

/** Photo files live on disk under one folder; the database stores their relative paths. */
export class PhotoStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async save(full: Uint8Array, thumb: Uint8Array, now = new Date()): Promise<StoredPhotoFiles> {
    const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const name = randomUUID();
    const files: StoredPhotoFiles = { file: `${folder}/${name}.jpg`, thumb: `${folder}/${name}_thumb.jpg` };
    await mkdir(join(this.root, folder), { recursive: true });
    try {
      await this.write(files.file, full);
      await this.write(files.thumb, thumb);
    } catch (error) {
      await this.remove([files.file, files.thumb]);
      throw error;
    }
    return files;
  }

  read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  async remove(relativePaths: string[]): Promise<void> {
    await Promise.all(relativePaths.map((path) => rm(this.resolve(path), { force: true })));
  }

  resolve(relativePath: string): string {
    const absolute = resolve(this.root, relativePath);
    if (!absolute.startsWith(this.root + sep)) throw new Error("Photo path escapes the photo folder");
    return absolute;
  }

  private async write(relativePath: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(relativePath);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
}
