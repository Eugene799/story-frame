/**
 * Minimal MP4 duration reader.
 *
 * Walks the top-level boxes for `moov`, then reads the movie header (`mvhd`)
 * timescale and duration. No dependency, no full demux: a fragmented MP4 whose
 * movie header carries duration 0 returns null, and the caller must decide what
 * to fall back to rather than inventing a length.
 */

function readBoxType(bytes: Buffer, offset: number): string {
  return bytes.toString("ascii", offset + 4, offset + 8);
}

/** Size of the whole box and of its header, or null for a malformed box. */
function readBoxHeader(bytes: Buffer, offset: number): { size: number; header: number } | null {
  if (offset + 8 > bytes.length) return null;
  const size32 = bytes.readUInt32BE(offset);
  if (size32 === 1) {
    if (offset + 16 > bytes.length) return null;
    const large = bytes.readBigUInt64BE(offset + 8);
    if (large > BigInt(bytes.length)) return null;
    return { size: Number(large), header: 16 };
  }
  if (size32 === 0) return { size: bytes.length - offset, header: 8 };
  if (size32 < 8) return null;
  return { size: size32, header: 8 };
}

/**
 * No lip sync is anywhere near this long. A header that claims more is broken
 * (or a sender trying to inflate a bill), so the value is clamped rather than
 * trusted, and the settlement can never land billions of seconds in the ledger.
 */
export const MAX_MP4_DURATION_SECONDS = 3_600;

/** A 32-bit duration of all ones means "unknown", not 4 294 967.295 s. */
const UNKNOWN_DURATION_32 = 0xffffffff;
const UNKNOWN_DURATION_64 = 0xffffffffffffffffn;

function readMovieHeader(payload: Buffer): number | null {
  const version = payload.readUInt8(0);
  // version(1) + flags(3) + created + modified, then timescale and duration.
  const timescaleOffset = 4 + (version === 1 ? 16 : 8);
  const durationOffset = timescaleOffset + 4;
  if (durationOffset + (version === 1 ? 8 : 4) > payload.length) return null;

  const timescale = payload.readUInt32BE(timescaleOffset);
  const durationBig =
    version === 1 ? payload.readBigUInt64BE(durationOffset) : BigInt(payload.readUInt32BE(durationOffset));
  // All ones is the container's "unknown", not a very long movie.
  const sentinel = version === 1 ? UNKNOWN_DURATION_64 : BigInt(UNKNOWN_DURATION_32);
  if (durationBig === sentinel) return null;
  if (timescale <= 0 || durationBig <= 0n) return null;
  if (durationBig > BigInt(Number.MAX_SAFE_INTEGER)) return MAX_MP4_DURATION_SECONDS;

  const seconds = Number(durationBig) / timescale;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Number(Math.min(seconds, MAX_MP4_DURATION_SECONDS).toFixed(3));
}

/** Real movie duration in seconds, or null when the bytes do not say. */
export function readMp4DurationSeconds(bytes: Buffer): number | null {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const header = readBoxHeader(bytes, offset);
    if (header === null || header.size < header.header) return null;
    if (readBoxType(bytes, offset) === "moov") {
      const payloadStart = offset + header.header;
      const payloadEnd = Math.min(offset + header.size, bytes.length);
      let inner = payloadStart;
      while (inner + 8 <= payloadEnd) {
        const child = readBoxHeader(bytes, inner);
        if (child === null || child.size < child.header) break;
        if (readBoxType(bytes, inner) === "mvhd") {
          const payload = bytes.subarray(inner + child.header, Math.min(inner + child.size, payloadEnd));
          return payload.length >= 20 ? readMovieHeader(payload) : null;
        }
        inner += child.size;
      }
      return null;
    }
    offset += header.size;
  }
  return null;
}
