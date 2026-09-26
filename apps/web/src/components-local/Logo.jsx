import React, { useState } from 'react';

/**
 * The AgentDisk mark.
 *
 * The design draws `agentdisk-logo.png` on a white rounded tile. That asset
 * has to be exported from Claude Design by hand — the design MCP refuses to
 * return binary files — so this renders the image and falls back to the "A"
 * monogram the product shipped with if it is not there.
 *
 * Deliberately a fallback rather than a build-time switch: the page is correct
 * whether or not the asset has landed, and it upgrades itself the moment
 * someone drops the file into `public/` with no code change. A missing file
 * would otherwise show a broken-image glyph on every screen.
 *
 * `onError` fires once per mount; React state makes the swap permanent for
 * that mount rather than looping on a repeatedly-failing request.
 */
export default function Logo({ size = 28, className = '', alt = 'AgentDisk' }) {
  const [failed, setFailed] = useState(false);

  // The reference tiles the mark on a white ground in both colour modes - 8px
  // at 30 (the Auth sheet's brand panel), 7px at 28 and 6px at 22 - and lets it
  // letterbox rather than crop. White is not
  // a themed token here on purpose: the artwork needs a light ground to read,
  // and every reference file draws it this way in dark mode too.
  //
  // `size` stays a number of px at the default 16px root - every call site
  // passes one, and the prop would be worse named in any other unit - but it is
  // emitted in rem so the mark grows with the root font-size like the type
  // beside it. A bare number in a React style object becomes px, which is the
  // one thing that would not scale.
  const rem = (px) => `${px / 16}rem`;
  const box = {
    width: rem(size), height: rem(size), flex: `0 0 ${rem(size)}`,
    borderRadius: size >= 30 ? rem(8) : size >= 26 ? rem(7) : rem(6),
  };
  const tile = { ...box, background: '#FFFFFF', objectFit: 'contain', padding: rem(2), boxSizing: 'border-box', display: 'block' };

  if (failed) {
    return (
      <span
        className={['logo', 'logo--mark', className].filter(Boolean).join(' ')}
        style={box}
        aria-hidden="true"
      >
        A
      </span>
    );
  }

  return (
    <img
      src="/agentdisk-logo.png"
      alt={alt}
      className={['logo', className].filter(Boolean).join(' ')}
      style={tile}
      onError={() => setFailed(true)}
    />
  );
}
