/**
 * Image loading for display briefs: download each referenced image from the (public)
 * GCS bucket once, read its pixel dimensions, and check it against Google's slot
 * specs — all before any Google Ads mutation, because Google only rejects a wrong
 * aspect ratio when the ad is created, long after the campaign exists.
 *
 * `imageDimensions` and `imageSlotIssues` are pure; `loadDisplayImages` is the I/O edge.
 */

import type { DisplayBrief, ResponsiveDisplayAd } from "../lib/schema.js";

export interface Dimensions {
  width: number;
  height: number;
}

/** A downloaded image, keyed by its https URL. */
export interface LoadedImage extends Dimensions {
  url: string;
  bytes: Uint8Array;
}

/** url → downloaded image. Every image a display brief references is present. */
export type ImageLibrary = ReadonlyMap<string, LoadedImage>;

/** Google's max image file size for display assets (5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type Slot = "marketingImages" | "squareMarketingImages" | "logoImages" | "squareLogoImages";

/** Aspect ratio (w/h) and minimum size per slot, from Google's responsive display ad specs. */
export const SLOT_SPECS: Record<Slot, { ratio: number; label: string; minWidth: number; minHeight: number }> = {
  marketingImages: { ratio: 1.91, label: "1.91:1", minWidth: 600, minHeight: 314 },
  squareMarketingImages: { ratio: 1, label: "1:1", minWidth: 300, minHeight: 300 },
  logoImages: { ratio: 4, label: "4:1", minWidth: 512, minHeight: 128 },
  squareLogoImages: { ratio: 1, label: "1:1", minWidth: 128, minHeight: 128 },
};

/** Google accepts a 1% deviation from the slot's aspect ratio. */
const RATIO_TOLERANCE = 0.01;

const SLOTS = Object.keys(SLOT_SPECS) as Slot[];

/** Pixel dimensions of a PNG, GIF or JPEG from its header, or null for anything else. */
export function imageDimensions(b: Uint8Array): Dimensions | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the marker segments to the first SOFn frame header (not DHT/JPG/DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        return null;
      }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}

/** Pure: human-readable problems with `image` in `slot` ([] when it fits). */
export function imageSlotIssues(slot: Slot, image: LoadedImage): string[] {
  const spec = SLOT_SPECS[slot];
  const ratio = image.width / image.height;
  return [
    ...(image.bytes.length > MAX_IMAGE_BYTES ? [`${image.url}: larger than 5 MB`] : []),
    ...(Math.abs(ratio - spec.ratio) / spec.ratio > RATIO_TOLERANCE
      ? [`${image.url}: ${slot} must be ${spec.label} (got ${image.width}x${image.height})`]
      : []),
    ...(image.width < spec.minWidth || image.height < spec.minHeight
      ? [`${image.url}: ${slot} must be at least ${spec.minWidth}x${spec.minHeight} (got ${image.width}x${image.height})`]
      : []),
  ];
}

/** Pure: every image URL an ad references, per slot. */
function slotUrls(ad: ResponsiveDisplayAd): Array<[Slot, string]> {
  return SLOTS.flatMap((slot) => ad[slot].map((url): [Slot, string] => [slot, url]));
}

/** Pure: every distinct image URL in the brief. */
export function briefImageUrls(brief: DisplayBrief): string[] {
  return [...new Set(brief.adGroups.flatMap((ag) => ag.responsiveDisplayAds.flatMap((ad) => slotUrls(ad).map(([, u]) => u))))];
}

/** Pure: every slot-spec problem across the brief, given its downloaded images. */
export function briefImageIssues(brief: DisplayBrief, images: ImageLibrary): string[] {
  return brief.adGroups.flatMap((ag) =>
    ag.responsiveDisplayAds.flatMap((ad) => slotUrls(ad).flatMap(([slot, url]) => imageSlotIssues(slot, images.get(url)!))),
  );
}

/** Download one image; throws with the URL and reason on a non-image or HTTP failure. */
async function fetchImage(url: string): Promise<LoadedImage> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`${url}: HTTP ${resp.status} (is the object public in the bucket?)`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const dims = imageDimensions(bytes);
  if (dims === null) {
    throw new Error(`${url}: not a PNG, JPEG or GIF`);
  }
  return { url, bytes, ...dims };
}

/**
 * Download every image the brief references and check each against its slot. Returns
 * the library plus the spec issues ([] = publishable); throws on a download failure.
 */
export async function loadDisplayImages(brief: DisplayBrief): Promise<{ images: ImageLibrary; issues: string[] }> {
  const loaded = await Promise.all(briefImageUrls(brief).map(fetchImage));
  const images: ImageLibrary = new Map(loaded.map((img) => [img.url, img]));
  return { images, issues: briefImageIssues(brief, images) };
}
