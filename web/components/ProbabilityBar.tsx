/**
 * The project's core visual idea: a match forecast is a distribution, not a
 * pick. Showing all three outcomes proportionally keeps the uncertainty
 * visible instead of collapsing it into a single confident-looking answer.
 */

type Props = {
  home: number;
  draw: number;
  away: number;
  homeTeam: string;
  awayTeam: string;
};

const pct = (value: number) => Math.round(value * 100);

export default function ProbabilityBar({
  home,
  draw,
  away,
  homeTeam,
  awayTeam,
}: Props) {
  const segments = [
    {
      value: home,
      bg: "bg-outcome-home",
      text: "text-ink-home",
      label: `${homeTeam} win`,
    },
    {
      value: draw,
      bg: "bg-outcome-draw",
      text: "text-ink-draw",
      label: "Draw",
    },
    {
      value: away,
      bg: "bg-outcome-away",
      text: "text-white",
      label: `${awayTeam} win`,
    },
  ];

  return (
    <div
      className="flex h-7 overflow-hidden rounded"
      role="img"
      aria-label={`${pct(home)}% ${homeTeam} win, ${pct(draw)}% draw, ${pct(away)}% ${awayTeam} win`}
    >
      {segments.map((segment) => (
        <div
          key={segment.label}
          className={`flex items-center ${segment.bg} ${segment.text}`}
          style={{ width: `${segment.value * 100}%` }}
          title={`${segment.label}: ${pct(segment.value)}%`}
        >
          {segment.value > 0.11 && (
            <span className="tnum pl-2 text-xs font-medium">
              {pct(segment.value)}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
