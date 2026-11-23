import { util, taskpool } from '@kit.ArkTS';
import { asset } from '@kit.AssetStoreKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { invoke } from 'liblofold.so';

export interface Summary {
  id: number;
  subject: string;
  sender: string;
  preview: string;
  sentAt: number | null;
}
export interface Page {
  items: Summary[];
  hasMore: boolean;
}
export interface Attachment {
  name: string;
  size: number;
}
export interface Detail extends Summary {
  recipients: string;
  body: string;
  bodyTruncated: boolean;
  attachments: Attachment[];
}
export interface Imported {
  id: number;
  duplicate: boolean;
}
interface Reply<T> {
  data?: T;
  error?: string;
}

@Concurrent
function queryArchive(path: string, key: ArrayBuffer, op: string, arg: string,
  offset: number, bytes: ArrayBuffer): string {
  try {
    return invoke(path, key, op, arg, offset, bytes);
  } finally {
    new Uint8Array(key).fill(0);
  }
}

const DATABASE_NAME: string = 'lofold-mail.db';

async function loadKey(dir: string): Promise<Uint8Array> {
  const lookup: asset.AssetMap = new Map();
  const alias = new util.TextEncoder().encodeInto('lofold.archive.key.v1');
  lookup.set(asset.Tag.ALIAS, alias);
  lookup.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  try {
    const result = await asset.query(lookup);
    const value = result[0].get(asset.Tag.SECRET) as Uint8Array;
    if (value.length !== 32) {
      throw new Error('归档密钥无法读取。');
    }
    return value;
  } catch (error) {
    if ((error as BusinessError).code !== asset.ErrorCode.NOT_FOUND) {
      throw error as Error;
    }
  }
  if ((await fs.listFile(dir)).includes(DATABASE_NAME)) {
    throw new Error('本机已有归档，但无法找到对应的密钥。');
  }
  const key = (await cryptoFramework.createRandom().generateRandom(32)).data;
  const record: asset.AssetMap = new Map();
  record.set(asset.Tag.ALIAS, alias);
  record.set(asset.Tag.SECRET, key);
  record.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
  try {
    await asset.add(record);
    return key;
  } catch (error) {
    key.fill(0);
    if ((error as BusinessError).code !== asset.ErrorCode.DUPLICATED) {
      throw error as Error;
    }
    const result = await asset.query(lookup);
    return result[0].get(asset.Tag.SECRET) as Uint8Array;
  }
}

export async function request<T>(dir: string, op: string, arg: string = '',
  offset: number = 0, bytes: ArrayBuffer = new ArrayBuffer(0)): Promise<T> {
  const database = dir + '/' + DATABASE_NAME;
  const key = await loadKey(dir);
  const keyCopy = new Uint8Array(key).buffer as ArrayBuffer;
  key.fill(0);
  const task = new taskpool.Task(queryArchive, database, keyCopy, op, arg, offset, bytes);
  // Keep the caller's buffers attached so key bytes can be cleared after taskpool clones them.
  task.setCloneList([keyCopy, bytes]);
  try {
    const json = await taskpool.execute(task) as string;
    const response = JSON.parse(json) as Reply<T>;
    if (response.data === undefined) {
      throw new Error(response.error || '无法读取本机归档。');
    }
    return response.data;
  } finally {
    new Uint8Array(keyCopy).fill(0);
  }
}

export async function readPickedFile(uri: string): Promise<ArrayBuffer> {
  const file = await fs.open(uri, fs.OpenMode.READ_ONLY);
  try {
    const size = (await fs.stat(file.fd)).size;
    if (size <= 0 || size > 16 * 1024 * 1024) {
      throw new Error('请选择非空且不超过 16 MiB 的 EML 文件。');
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    while (position < size) {
      const chunk = new ArrayBuffer(Math.min(size - position, 256 * 1024));
      const count = await fs.read(file.fd, chunk, { offset: position });
      if (!count) {
        throw new Error('原件读取不完整，请重新选择。');
      }
      bytes.set(new Uint8Array(chunk, 0, count), position);
      position += count;
    }
    if ((await fs.stat(file.fd)).size !== size) {
      throw new Error('原件大小已改变，请重新选择。');
    }
    return bytes.buffer as ArrayBuffer;
  } finally {
    await fs.close(file);
  }
}
