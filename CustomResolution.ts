// ─── Constants ───────────────────────────────────────────────────────────────

const RETRY_CONFIG = {
  MAX_RETRIES: 30,
  INTERVAL_MS: 1_000,
  RECENT_MODIFIED_THRESHOLD_MS: 60_000,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileReadResult {
  fileData: string | null;
  modifiedTime: Date | null;
}

interface LedOptionsJson {
  'db/menu/picture/ledoptions/picturesize'?: number;
  'db/menu/picture/ledoptions/screen_position_x'?: number;
  'db/menu/picture/ledoptions/screen_position_y'?: number;
  'db/menu/picture/ledoptions/custom_width'?: number;
  'db/menu/picture/ledoptions/custom_height'?: number;
  'system/outputResolutionWidth'?: number;
  'system/outputResolutionHeight'?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tryReadLedFile(): Promise<FileReadResult> {
  try {
    const file = await fs.resolvePath(PLATFORM_SPEC.LED_OPTION.PATH_V4);
    const fileData = await fs.readFileAsText(file);
    return { fileData, modifiedTime: file.modified ?? null };
  } catch {
    return { fileData: null, modifiedTime: null };
  }
}

function isRecentlyModified(modifiedTime: Date | null): boolean {
  if (!modifiedTime) return false; // ← fixes the silent bug in original
  const elapsed = Date.now() - modifiedTime.getTime();
  return elapsed <= RETRY_CONFIG.RECENT_MODIFIED_THRESHOLD_MS;
}

async function readLedFileWithRetry(): Promise<FileReadResult> {
  for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_RETRIES; attempt++) {
    const result = await tryReadLedFile();
    const { fileData, modifiedTime } = result;

    if (fileData && isRecentlyModified(modifiedTime)) {
      logger.log(`[VXINIT] LED file ready on attempt ${attempt}`);
      return result;
    }

    const reason = !fileData
      ? 'file not found'
      : 'file not recently modified';

    logger.log(
      `[VXINIT] Retry ${attempt}/${RETRY_CONFIG.MAX_RETRIES} — ${reason}`
    );

    if (attempt < RETRY_CONFIG.MAX_RETRIES) {
      await sleep(RETRY_CONFIG.INTERVAL_MS);
    }
  }

  return { fileData: null, modifiedTime: null };
}

function buildOutputResolution(
  json: LedOptionsJson,
  isLandscape: boolean
): { outputWidth?: number; outputHeight?: number } {
  return {
    outputWidth: isLandscape
      ? json['system/outputResolutionWidth']
      : json['system/outputResolutionHeight'],
    outputHeight: isLandscape
      ? json['system/outputResolutionHeight']
      : json['system/outputResolutionWidth'],
  };
}

function buildCustomResolution(json: LedOptionsJson, isLandscape: boolean) {
  const { outputWidth, outputHeight } = buildOutputResolution(json, isLandscape);

  return {
    ratio: 1,
    x: json['db/menu/picture/ledoptions/screen_position_x'] ?? 0,
    y: json['db/menu/picture/ledoptions/screen_position_y'] ?? 0,
    width: json['db/menu/picture/ledoptions/custom_width'] || undefined,
    height: json['db/menu/picture/ledoptions/custom_height'] || undefined,
    outputWidth,
    outputHeight,
    isEnabled: json['db/menu/picture/ledoptions/picturesize'] ?? 0,
  };
}

function applyResolution(finalResolution: ReturnType<typeof buildCustomResolution>, acr: AdjustedResolution) {
  const app = document.getElementById('app');
  setCustomResolutionToLocalStorage(finalResolution);
  updateCustomResolution(app, undefined, acr);
  updateMenuSize(finalResolution.height);
  pairingCodeCustomResolution(finalResolution);
  exitPopupResize(finalResolution);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export const initCustomResolution: PlatformApi['initCustomResolution'] =
  async () => {
    if (!useCustomResolution()) {
      removeCustomResolutionFromLocalStorage();
      return;
    }

    logger.log('[VXINIT] initCustomResolution — start');

    const { fileData } = await readLedFileWithRetry();

    if (!fileData) {
      logger.error(`[VXINIT] LED file unavailable after all retries`);
      return;
    }

    try {
      const json: LedOptionsJson = JSON.parse(fileData);
      const isLandscape =
        getScreenOrientationFromStore(appStore.getState()) === LEX.ORIENTATION.LANDSCAPE;

      const customResolution = buildCustomResolution(json, isLandscape);

      if (!customResolution.width || !customResolution.outputWidth) {
        logger.warn('[VXINIT] Custom resolution missing required dimensions — skipping');
        return;
      }

      const acr = getAdjestedCustomResolution(customResolution);
      const normalized = getNormalizedResolution(customResolution);

      const finalResolution = {
        ...customResolution,
        x: acr.x,
        y: acr.y,
        ratio: acr.ratio,
        width: normalized.width,
        height: normalized.height,
      };

      logger.log('[VXINIT] finalResolution', finalResolution);

      if (finalResolution.isEnabled) {
        applyResolution(finalResolution, acr);
      } else {
        removeCustomResolutionFromLocalStorage();
      }

      if (isUpdatedCustomResolution(finalResolution)) {
        reloadApp('updateCustomResolution');
      }
    } catch (e) {
      logger.error('[VXINIT] Failed to apply custom resolution:', e);
    }
  };
