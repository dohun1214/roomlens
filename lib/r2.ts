import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2 (S3 호환 API). 파일은 브라우저가 presigned URL로 직접 올리고 받는다.
// 키는 서버에서만 쓴다.

/** presigned URL 유효 시간 (1시간) */
export const URL_TTL_SECONDS = 3600;

let client: S3Client | null = null;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name} 이(가) 없습니다.`);
  return value;
}

function r2(): S3Client {
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
    // SDK 기본값(WHEN_SUPPORTED)이면 presigned PUT 주소에 CRC32 체크섬 파라미터가 붙어
    // 브라우저가 올릴 때 서명이 맞지 않는다.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

const bucket = () => env('R2_BUCKET');

/**
 * 올리기용 주소. Content-Type과 Content-Length를 서명에 넣어,
 * 약속한 크기·형식과 다른 요청은 R2가 403으로 거부하게 한다.
 */
export function presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: contentLength }),
    { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
  );
}

/** 읽기용 주소 (비공개 버킷이므로 읽을 때도 서명한 주소를 쓴다) */
export function presignGet(key: string): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: URL_TTL_SECONDS });
}

const isNotFound = (err: unknown) =>
  err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey');

/** 객체 크기. 없으면 null */
export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const res = await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: res.ContentLength ?? 0 };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** 객체의 앞부분 바이트만 읽는다 (형식 확인용). 없으면 null */
export async function readObjectHead(key: string, bytes: number): Promise<Uint8Array | null> {
  try {
    const res = await r2().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${bytes - 1}` }));
    return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
