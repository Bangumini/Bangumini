import { forwardRef, type ReactNode } from "react";
import { StarIcon } from "./icons";

/* Pill tag (e.g. watch-status / progress label) */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-[14px] leading-none px-1.5 py-1 rounded-md bg-accent-soft text-accent font-medium">
      {children}
    </span>
  );
}

/* Star rating accessory */
export function Rating({ score }: { score: number }) {
  return (
    <span className="shrink-0 flex items-center gap-0.5 text-[13px] text-star tabular-nums">
      <StarIcon size={13} />
      {score.toFixed(1)}
    </span>
  );
}

/* Muted metadata text (type, weekday, rank…) */
export function Meta({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-[14px] text-fg-tertiary">{children}</span>;
}

interface Props {
  coverUrl?: string;
  title: string;
  subtitle?: string;
  selected?: boolean;
  onClick?: () => void;
  accessories?: ReactNode;
  size?: "sm" | "md";
}

export const SubjectRow = forwardRef<HTMLDivElement, Props>(function SubjectRow(
  { coverUrl, title, subtitle, selected, onClick, accessories, size = "sm" },
  ref,
) {
  const cover = size === "md" ? "w-12 h-16" : "w-10 h-14";
  return (
    <div
      ref={ref}
      onClick={onClick}
      className={`flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
        selected ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          className={`${cover} rounded-md object-cover shrink-0 bg-elevated`}
        />
      ) : (
        <div className={`${cover} rounded-md shrink-0 bg-elevated`} />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-fg truncate">{title}</div>
        {subtitle && (
          <div className="text-[12px] text-fg-tertiary truncate mt-0.5">{subtitle}</div>
        )}
      </div>
      {accessories}
    </div>
  );
});
