import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config.js";

export interface StoredFile {
  url: string;
  path: string;
}

export async function storeLocalFile(sourcePath: string, filename: string): Promise<StoredFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  const directory = path.resolve(config.LOCAL_STORAGE_PATH);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${nanoid(10)}-${safeName}`);
  await copyFile(sourcePath, target);
  return {
    path: target,
    url: `/files/${path.basename(target)}`
  };
}

export function localUrlForRender(filename: string) {
  return `/renders/${filename}`;
}
