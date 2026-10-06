// Shared authenticated download of an OPDS acquisition URL into Cache.
// Used by auto-download and Update library.

import { downloadFile } from '@/libs/storage';
import { getFileExtFromMimeType } from '@/libs/document';
import {
  needsProxy,
  getProxiedURL,
  probeAuth,
  probeFilename,
  withOriginSuppressed,
} from '@/app/opds/utils/opdsReq';
import { resolveURL, parseMediaType, getFileExtFromPath } from '@/app/opds/utils/opdsUtils';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import { READEST_OPDS_USER_AGENT } from '@/services/constants';
import type { AppService } from '@/types/system';
import type { OPDSCatalog } from '@/types/opds';
import { uniqueId } from '@/utils/misc';
import { isTauriAppPlatform } from '@/services/environment';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { fingerprintFromHeaders, type OPDSSourceFingerprint } from './sourceMap';
import type { ProgressHandler } from '@/utils/transfer';

export interface AcquisitionDownloadResult {
  filePath: string;
  fingerprint: OPDSSourceFingerprint;
  responseHeaders: Record<string, string>;
}

const buildAuthDownload = async (
  absoluteUrl: string,
  catalog: OPDSCatalog,
): Promise<{
  downloadUrl: string;
  headers: Record<string, string>;
  useProxy: boolean;
}> => {
  const username = catalog.username ?? '';
  const password = catalog.password ?? '';
  const customHeaders = normalizeCustomHeaders(catalog.customHeaders);
  const useProxy = needsProxy(absoluteUrl);

  let downloadUrl = useProxy ? getProxiedURL(absoluteUrl, '', true, customHeaders) : absoluteUrl;
  const headers: Record<string, string> = {
    'User-Agent': READEST_OPDS_USER_AGENT,
    Accept: '*/*',
    ...(!useProxy ? customHeaders : {}),
  };

  if (username || password) {
    const authHeader = await probeAuth(absoluteUrl, username, password, useProxy, customHeaders);
    if (authHeader) {
      if (!useProxy) {
        headers['Authorization'] = authHeader;
      }
      downloadUrl = useProxy
        ? getProxiedURL(absoluteUrl, authHeader, true, customHeaders)
        : absoluteUrl;
    }
  }

  return { downloadUrl, headers, useProxy };
};

/** HEAD probe of the acquisition URL for change-detection fingerprints. */
export const probeAcquisitionFingerprint = async (
  acquisitionHref: string,
  baseURL: string,
  catalog: OPDSCatalog,
): Promise<OPDSSourceFingerprint | null> => {
  const absoluteUrl = resolveURL(acquisitionHref, baseURL);
  try {
    const { downloadUrl, headers } = await buildAuthDownload(absoluteUrl, catalog);
    const fetch = isTauriAppPlatform() ? tauriFetch : window.fetch;
    const res = await fetch(downloadUrl, {
      method: 'HEAD',
      headers: withOriginSuppressed(headers),
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });
    if (!res.ok) return null;
    const fp = fingerprintFromHeaders(res.headers);
    return Object.keys(fp).length ? fp : null;
  } catch {
    return null;
  }
};

export const downloadAcquisitionFile = async (
  appService: AppService,
  catalog: OPDSCatalog,
  item: {
    acquisitionHref: string;
    mimeType: string;
    baseURL: string;
    title: string;
    updated?: string;
  },
  onProgress?: ProgressHandler,
): Promise<AcquisitionDownloadResult> => {
  const absoluteUrl = resolveURL(item.acquisitionHref, item.baseURL);
  const { downloadUrl, headers } = await buildAuthDownload(absoluteUrl, catalog);

  const parsed = parseMediaType(item.mimeType);
  const rawPathname = new URL(absoluteUrl).pathname;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }
  const ext = getFileExtFromMimeType(parsed?.mediaType) || getFileExtFromPath(pathname);
  const basename = uniqueId();
  const filename = ext ? `${basename}.${ext}` : basename;
  let dstFilePath = await appService.resolveFilePath(filename, 'Cache');

  console.log(`[OPDS] downloading "${item.title}" from ${absoluteUrl}`);
  const responseHeaders = await downloadFile({
    appService,
    dst: dstFilePath,
    cfp: '',
    url: downloadUrl,
    headers,
    singleThreaded: true,
    skipSslVerification: true,
    onProgress,
  });

  const probedFilename = await probeFilename(responseHeaders);
  if (probedFilename) {
    const newFilePath = await appService.resolveFilePath(probedFilename, 'Cache');
    await appService.copyFile(dstFilePath, 'None', newFilePath, 'None');
    await appService.deleteFile(dstFilePath, 'None');
    dstFilePath = newFilePath;
  }

  return {
    filePath: dstFilePath,
    fingerprint: {
      ...fingerprintFromHeaders(responseHeaders),
      ...(item.updated ? { entryUpdated: item.updated } : {}),
    },
    responseHeaders,
  };
};
