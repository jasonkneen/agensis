// The agent's video: a held identity card, published as a real LiveKit track.
//
// Humans publish a camera; an agent publishes this. It matters that it is a
// genuine video track and not a UI placeholder — it means an agent occupies a
// real tile in the grid, is subscribed to like anyone else, and shows up in a
// recording. A participant that only exists in our own React state does not.
//
// The frame is the app's own avatar language: initials on the agent's accent
// colour. No emoji, per the product rule, and no image decoding dependency —
// initials are drawn from a bundled 5x7 bitmap font, so this works on any host
// with no native modules and no network fetch.

import { VideoSource, VideoFrame, VideoBufferType, LocalVideoTrack, TrackSource, TrackPublishOptions } from '@livekit/rtc-node';

/** 5x7 glyphs, one byte per row, five significant bits. Enough for initials. */
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
};

/** Slack-style initials: first letters of up to two words, else first two chars. */
export function initialsFor(name, handle) {
  const source = String(name || handle || '').trim();
  if (!source) return '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2
    ? `${words[0][0]}${words[1][0]}`
    : source.slice(0, 2);
  return letters.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2) || '?';
}

/** #rrggbb (or #rgb) to [r,g,b]. Falls back to the app's neutral slate. */
export function parseColor(value) {
  const hex = String(value || '').trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [71, 85, 105];
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** White or near-black text, whichever stays readable on this background. */
function textColorFor([r, g, b]) {
  // Rec. 601 luma — good enough, and avoids a colour-science dependency.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? [17, 24, 39] : [255, 255, 255];
}

/**
 * Render the holding frame as RGBA.
 *
 * Exported so it can be asserted pixel-by-pixel in a test without spawning a
 * LiveKit room — the drawing is pure, which is the whole reason it lives apart
 * from the publishing below.
 */
export function renderAvatarFrame({ name, handle, color, width = 640, height = 480 }) {
  const bg = parseColor(color);
  const fg = textColorFor(bg);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }

  const text = initialsFor(name, handle);
  // One glyph is 5x7 cells; size the cell so two glyphs occupy ~40% of the frame.
  const cell = Math.max(2, Math.floor(Math.min(width, height) * 0.4 / 7));
  const glyphW = 5 * cell;
  const gap = cell;
  const totalW = text.length * glyphW + (text.length - 1) * gap;
  const startX = Math.floor((width - totalW) / 2);
  const startY = Math.floor((height - 7 * cell) / 2);

  text.split('').forEach((char, index) => {
    const glyph = FONT[char];
    if (!glyph) return;
    const originX = startX + index * (glyphW + gap);
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (!(glyph[row] & (1 << (4 - col)))) continue;
        for (let dy = 0; dy < cell; dy += 1) {
          for (let dx = 0; dx < cell; dx += 1) {
            const x = originX + col * cell + dx;
            const y = startY + row * cell + dy;
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const at = (y * width + x) * 4;
            data[at] = fg[0];
            data[at + 1] = fg[1];
            data[at + 2] = fg[2];
            data[at + 3] = 255;
          }
        }
      }
    }
  });

  return { data, width, height };
}

/**
 * Publish the agent's held image as a video track on `room`.
 *
 * A still image still needs frames on a schedule: WebRTC drops a track that
 * stops producing, and a late joiner has to receive a keyframe from somewhere.
 * 2fps costs almost nothing at this content complexity and keeps the tile alive.
 *
 * @returns {{ stop: () => Promise<void> }}
 */
export async function publishAvatarVideo(room, { name, handle, color, width = 640, height = 480, fps = 2, log = console } = {}) {
  const frame = renderAvatarFrame({ name, handle, color, width, height });
  const source = new VideoSource(width, height);
  const track = LocalVideoTrack.createVideoTrack('avatar', source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_CAMERA;

  const publication = await room.localParticipant.publishTrack(track, options);

  const push = () => {
    try {
      source.captureFrame(new VideoFrame(frame.data, width, height, VideoBufferType.RGBA));
    } catch (error) {
      log.error?.(`[voice] avatar frame failed: ${error?.message || error}`);
    }
  };
  push();
  const timer = setInterval(push, Math.max(100, Math.floor(1000 / fps)));
  if (timer.unref) timer.unref();

  return {
    publication,
    async stop() {
      clearInterval(timer);
      try { await room.localParticipant.unpublishTrack(track.sid || track); } catch { /* room already gone */ }
    },
  };
}
