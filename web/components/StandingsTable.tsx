import type { TableRow } from "@/lib/data";
import { shortName } from "@/lib/data";

const FORM_COLOR: Record<string, string> = {
  W: "bg-outcome-home text-ink-home",
  D: "bg-outcome-draw text-ink-draw",
  L: "bg-outcome-away text-white",
};

function Form({ form }: { form: string }) {
  if (!form) return <span className="text-pitch-faint text-xs">—</span>;

  return (
    <span className="flex gap-1" aria-label={`Recent form: ${form}`}>
      {form.split("").map((result, i) => (
        <span
          key={i}
          className={`flex size-4 items-center justify-center rounded-sm text-[10px] font-medium ${FORM_COLOR[result]}`}
          aria-hidden="true"
        >
          {result}
        </span>
      ))}
    </span>
  );
}

export default function StandingsTable({ rows }: { rows: TableRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-pitch-dim py-8 text-sm">
        No finished matches this season yet.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-pitch-faint border-pitch-line border-b text-left text-xs">
          <th scope="col" className="w-8 pb-2 font-normal">
            #
          </th>
          <th scope="col" className="pb-2 font-normal">
            Team
          </th>
          <th scope="col" className="w-8 pb-2 text-right font-normal">
            P
          </th>
          <th scope="col" className="w-10 pb-2 text-right font-normal">
            GD
          </th>
          <th scope="col" className="w-10 pb-2 text-right font-normal">
            Pts
          </th>
          <th scope="col" className="w-24 pb-2 pl-4 font-normal">
            Form
          </th>
        </tr>
      </thead>
      <tbody className="divide-pitch-line-soft divide-y">
        {rows.map((row) => (
          <tr key={row.team}>
            <td className="text-pitch-faint tnum py-2">{row.position}</td>
            <td className="font-display truncate py-2 text-base">
              {shortName(row.team)}
            </td>
            <td className="text-pitch-dim tnum py-2 text-right">{row.played}</td>
            <td className="tnum py-2 text-right">
              {row.goalDifference > 0 ? "+" : ""}
              {row.goalDifference}
            </td>
            <td className="tnum py-2 text-right font-medium">{row.points}</td>
            <td className="py-2 pl-4">
              <Form form={row.form} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
