import type { CSSProperties } from "react";
import type { BotFrame } from "@/lib/bloub/engine";
import { NIMBUS_CHARACTERS } from "@/lib/bloub/nimbus";
import { mixHex } from "@/lib/bloub/skins";
import type { ExpressionId } from "@/lib/bloub/expressions";
import "./nimbus-artwork.css";

export function NimbusArtwork({ index, frame, ink, uid, size, live, expression, phase }: {
  index: number; frame: BotFrame; ink: string; uid: string; size: number;
  live: boolean; expression: ExpressionId;
  phase: number;
}) {
  const character = NIMBUS_CHARACTERS[index % NIMBUS_CHARACTERS.length]!;
  const compact = size <= 28;
  const gradient = `nimbus-fill-${uid}`;
  const clip = `nimbus-face-${uid}`;
  const light = mixHex(ink, "#ffffff", 0.42);
  const dark = mixHex(ink, "#172339", 0.3);
  const joyful = ["excite", "heureux", "hilare"].includes(expression);
  const eyeHighlight = ["surpris", "effraye", "triste"].includes(expression);
  const style = {
    color: ink, "--nimbus-fill": `url(#${gradient})`, "--nimbus-light": light, "--nimbus-dark": dark,
    "--nimbus-wag": expression === "excite" || expression === "hilare" ? "34deg" : joyful ? "30deg" : expression === "somnolent" ? "2deg" : expression === "attentif" ? "3deg" : "7deg",
    "--nimbus-period": expression === "excite" || expression === "hilare" ? ".4s" : joyful ? ".5s" : expression === "somnolent" ? "5s" : "3.4s",
    "--nimbus-play": live ? "running" : "paused",
    "--nimbus-phase": `${-phase}s`,
  } as CSSProperties;
  const [hx, hy, hrx, hry, rotation] = character.highlight;
  // The source artwork uses a 200x220 canvas. Centre the body in the engine's
  // coordinate system, leaving room for feet, ears and particle effects.
  const geometry = "scale(1.2) translate(-100 -124)";
  const faceOffset = `translate(${(character.face.x - 100) * 1.2} ${(character.face.y - 124) * 1.2}) scale(${compact ? 0.85 : 0.75})`;
  return (
    <g className="nimbus-artwork" data-character={character.id} data-expression={expression} data-live={live} style={style}>
      <defs>
        <radialGradient id={gradient} gradientUnits="userSpaceOnUse" cx="78" cy="62" r="150">
          <stop offset="0" stopColor={light} />
          <stop offset=".5" stopColor={ink} />
          <stop offset="1" stopColor={dark} />
        </radialGradient>
        <clipPath id={clip} transform={`${frame.bodyTransform} ${geometry}`} dangerouslySetInnerHTML={{ __html: character.id === "miso" ? '<rect x="58" y="88" width="84" height="54" rx="27" />' : character.body }} />
      </defs>
      {!compact && <ellipse cx="0" cy="98" rx="65" ry="8" fill="#0a1019" opacity={frame.bodyAlpha * 0.18} />}
      <g className="nimbus-life" opacity={frame.bodyAlpha}>
        <g transform={frame.bodyTransform}>
          <g transform={geometry}>
            {character.feet.map((x, i) => <ellipse key={i} className={`nimbus-foot nimbus-foot-${i}`} cx={x} cy={character.footY} rx="15" ry="10" fill={ink} />)}
            {/* These strings are checked-in geometry, never model or user HTML. */}
            <g dangerouslySetInnerHTML={{ __html: character.back }} />
            <g dangerouslySetInnerHTML={{ __html: character.body }} />
            {!compact && <ellipse cx={hx} cy={hy} rx={hrx} ry={hry} transform={`rotate(${rotation} ${hx} ${hy})`} fill="#fff" opacity=".22" />}
            <g dangerouslySetInnerHTML={{ __html: character.front }} />
          </g>
        </g>
        <g clipPath={`url(#${clip})`}>
          <g transform={frame.bodyTransform}>
          <g transform={faceOffset}>
            <g transform={frame.bodyInverseTransform}>
            {frame.cheeks.map((cheek, i) => <ellipse key={i} transform={cheek.matrix} rx="15" ry="8" fill="#ff6f96" opacity={joyful && character.id !== "miso" ? cheek.alpha * 0.5 : 0} />)}
            {frame.eyes.map((eye, i) => <g key={i} transform={character.id === "miso" ? `translate(${(eye.side ?? i) === 0 ? -3 : 3} 0)` : undefined}>
              <g transform={eye.matrix} opacity={eye.alpha}>
                <path d={eye.d} fill={character.id === "miso" ? "#e7edf6" : "#1d2236"} />
                {eyeHighlight && <>
                  <clipPath id={`nimbus-eye-${uid}-${i}`}><path d={eye.d} /></clipPath>
                  <circle className="nimbus-eye-highlight" cx="-3" cy="-6" r="3.5" fill="#fff" opacity=".9" clipPath={`url(#nimbus-eye-${uid}-${i})`} />
                </>}
              </g>
            </g>)}
            </g>
          </g>
          </g>
        </g>
      </g>
      <g className="nimbus-effects" fill={ink} aria-hidden="true">
        {expression === "somnolent" && [0, 1, 2].map(i => <text key={i} className="nimbus-zzz" x={65 + i * 12} y={-80 - i * 13} fontFamily="system-ui, sans-serif" fontWeight="700" fontSize={16 + i * 3} style={{ animationDelay: `${-i * 1.07}s` }}>z</text>)}
        {(expression === "surpris" || expression === "effraye") && <text className="nimbus-bang" x="85" y="-60" fontFamily="system-ui, sans-serif" fontWeight="800" fontSize="38">!</text>}
        {(expression === "attentif" || expression === "confus" || expression === "curieux") && [0, 1, 2].map(i => <circle key={i} className="nimbus-thinking" cx={58 + i * 13} cy="-82" r="4" style={{ animationDelay: `${-i * .3}s` }} />)}
        {joyful && [0, 1, 2].map(i => <path key={i} className="nimbus-spark" d="M0 -9Q2 -2 9 0Q2 2 0 9Q-2 2 -9 0Q-2 -2 0 -9Z" transform={`translate(${70 + i * 15} ${-60 - (i % 2) * 25})`} style={{ animationDelay: `${-i * .4}s` }} />)}
        {expression === "triste" && <path className="nimbus-tear" d="M-25 12C-20 20 -18 26 -25 28C-32 26 -30 20 -25 12Z" fill="#6cc4f5" />}
      </g>
    </g>
  );
}
