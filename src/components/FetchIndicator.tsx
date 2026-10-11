import { useIsFetching } from "@tanstack/react-query";

export default function FetchIndicator() {
  const col = useIsFetching({ queryKey: ["collections"] });
  const cal = useIsFetching({ queryKey: ["calendar"] });
  const ep  = useIsFetching({ queryKey: ["episodes"] });
  const at  = useIsFetching({ queryKey: ["anilist-airing-times"] });
  const ns  = useIsFetching({ queryKey: ["next-season"] });
  const sr  = useIsFetching({ queryKey: ["search"] });

  const labels = [
    col > 0 && "收藏",
    cal > 0 && "日历",
    ep  > 0 && "剧集",
    at  > 0 && "播出时间",
    ns  > 0 && "新番",
    sr  > 0 && "搜索",
  ].filter(Boolean).join("、");

  if (!labels) return null;

  return (
    <span className="shrink-0 text-[12px] text-fg-tertiary animate-pulse ml-auto mr-10">
      加载{labels}…
    </span>
  );
}
