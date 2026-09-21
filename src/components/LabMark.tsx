import { useId } from 'react'

/** Vector version of the lab's existing hub-and-six-node identity. */
export default function LabMark() {
  const gradient = useId()
  const points = [[36, 5], [63, 21], [63, 53], [36, 69], [9, 53], [9, 21]]
  const inner = [[36, 20], [49, 28], [49, 46], [36, 54], [23, 46], [23, 28]]
  return <svg className="lab-mark" viewBox="0 0 72 74" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="12" y1="5" x2="58" y2="69" gradientUnits="userSpaceOnUse"><stop stopColor="#00dbea" /><stop offset=".52" stopColor="#2587ff" /><stop offset="1" stopColor="#8b69ff" /></linearGradient></defs>
    <g stroke={`url(#${gradient})`} strokeWidth="2.2" strokeLinejoin="round">
      <path d="M36 5 63 21V53L36 69 9 53V21Z" />
      <path d="M36 20 49 28V46L36 54 23 46V28Z" opacity=".85" />
      {points.map(([x, y], i) => <path key={i} d={`M${x} ${y}L36 37`} opacity=".8" />)}
      {points.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="3" fill="var(--brand-node-fill, #071b34)" />)}
      {inner.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="2.3" fill="var(--brand-node-fill, #071b34)" />)}
      <circle cx="36" cy="37" r="3.6" fill="var(--brand-node-fill, #071b34)" />
    </g>
  </svg>
}
