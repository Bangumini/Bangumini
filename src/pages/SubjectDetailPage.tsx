import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  getSubject,
  getSubjectPersons,
  getSubjectCharacters,
  getEpisodes,
  getUserCollection,
  patchSubjectEpisodes,
  postUserCollection,
} from "@shared/api/client";
import { CollectionTypeLabel } from "@shared/api/types";
import type { CollectionType } from "@shared/api/types";

export default function SubjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const subjectId = Number(id);
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const { data: subject } = useQuery({
    queryKey: ["subject", subjectId],
    queryFn: () => getSubject(subjectId),
  });

  const { data: persons } = useQuery({
    queryKey: ["persons", subjectId],
    queryFn: () => getSubjectPersons(subjectId),
  });

  const { data: characters } = useQuery({
    queryKey: ["characters", subjectId],
    queryFn: () => getSubjectCharacters(subjectId),
  });

  const { data: episodeData } = useQuery({
    queryKey: ["episodes", subjectId],
    queryFn: () => getEpisodes(subjectId),
  });

  const { data: collection, refetch: refetchCollection } = useQuery({
    queryKey: ["collection", subjectId],
    queryFn: async () => {
      try {
        return await getUserCollection("", subjectId);
      } catch {
        return null;
      }
    },
  });

  const sorted = episodeData?.data?.slice().sort((a, b) => a.sort - b.sort) ?? [];
  const mainEps = sorted.filter((e) => e.type === 0);
  const totalEp = mainEps.length > 0 ? mainEps.length : (subject?.total_episodes ?? 0);
  const currentEp = collection?.ep_status ?? 0;
  const displayTarget = targetEp ?? currentEp;
  const isDirty = targetEp !== null && targetEp !== currentEp;

  async function commitProgress() {
    if (!isDirty || targetEp === null) return;
    setLoading(true);
    try {
      const from = Math.min(currentEp, targetEp);
      const to = Math.max(currentEp, targetEp);
      const ids = mainEps.slice(from, to).map((e) => e.id);
      if (ids.length > 0) {
        await patchSubjectEpisodes(subjectId, { episode_id: ids, type: targetEp > currentEp ? 2 : 0 });
      }
      setTargetEp(null);
      refetchCollection();
    } finally {
      setLoading(false);
    }
  }

  async function setCollectionType(type: CollectionType) {
    setLoading(true);
    try {
      await postUserCollection(subjectId, { type });
      refetchCollection();
    } finally {
      setLoading(false);
    }
  }

  const staffMap = new Map<string, string[]>();
  (persons ?? []).forEach((p) => {
    const role = p.relation || "其他";
    const names = staffMap.get(role) ?? [];
    names.push(p.name);
    staffMap.set(role, names);
  });

  return (
    <div className="h-screen flex flex-col bg-[#1a1a2e] text-gray-200">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 shrink-0">
        <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white text-sm">
          ← 返回
        </button>
        <span className="text-sm font-medium truncate">{subject?.name_cn || subject?.name || "条目详情"}</span>
        <button
          onClick={() => window.open(`https://bgm.tv/subject/${subjectId}`)}
          className="ml-auto text-xs text-indigo-400 hover:underline"
        >
          Bangumi ↗
        </button>
      </header>

      <div className="flex-1 overflow-auto p-4">
        {subject?.images?.large && (
          <img src={subject.images.large} alt="" className="w-full max-w-sm rounded-lg mb-4 mx-auto" />
        )}

        {subject && (
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-gray-500">评分 </span>
              <span className="text-yellow-400">{subject.rating?.score?.toFixed(1) ?? "暂无"}</span>
              {subject.rank > 0 && <span className="text-gray-500 ml-2">排名 #{subject.rank}</span>}
            </div>
            {subject.date && <div><span className="text-gray-500">日期 </span>{subject.date}</div>}
            <div>
              <span className="text-gray-500">状态 </span>
              {collection ? (
                <span className="text-indigo-400">{CollectionTypeLabel[collection.type]}</span>
              ) : (
                <span className="text-gray-600">未收藏</span>
              )}
            </div>
            {totalEp > 0 && (
              <div>
                <span className="text-gray-500">进度 </span>
                <span className={isDirty ? "text-green-400" : ""}>
                  {isDirty ? `${currentEp} → ${displayTarget} / ${totalEp}` : `${currentEp} / ${totalEp}`}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Progress Controls */}
        {totalEp > 0 && (
          <div className="flex items-center gap-2 mt-4">
            <button
              onClick={() => {
                const base = targetEp ?? currentEp;
                setTargetEp(Math.max(0, base - 1));
              }}
              className="px-3 py-1 text-sm bg-gray-700 rounded hover:bg-gray-600"
            >
              -1
            </button>
            <span className="text-sm text-gray-400">
              {displayTarget} / {totalEp}
            </span>
            <button
              onClick={() => {
                const base = targetEp ?? currentEp;
                setTargetEp(Math.min(totalEp, base + 1));
              }}
              className="px-3 py-1 text-sm bg-gray-700 rounded hover:bg-gray-600"
            >
              +1
            </button>
            {isDirty && (
              <button
                onClick={commitProgress}
                disabled={loading}
                className="px-3 py-1 text-sm bg-indigo-600 rounded hover:bg-indigo-500 disabled:opacity-40"
              >
                {loading ? "提交中…" : `提交: ${currentEp}→${targetEp}/${totalEp}`}
              </button>
            )}
          </div>
        )}

        {/* Collection Type */}
        <div className="flex gap-1 mt-4 flex-wrap">
          {([1, 2, 3, 4, 5] as CollectionType[]).map((t) => (
            <button
              key={t}
              onClick={() => setCollectionType(t)}
              disabled={loading}
              className={`px-3 py-1 text-xs rounded ${collection?.type === t ? "bg-indigo-600" : "bg-gray-700 hover:bg-gray-600"} disabled:opacity-40`}
            >
              {CollectionTypeLabel[t]}
            </button>
          ))}
        </div>

        {/* Staff */}
        {staffMap.size > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-400 mb-2">Staff</h3>
            {[...staffMap].map(([role, names]) => (
              <div key={role} className="text-sm leading-relaxed">
                <span className="text-gray-500">{role}: </span>
                <span>{names.join(" / ")}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cast */}
        {(characters ?? []).length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-400 mb-2">角色 / Cast</h3>
            {(characters ?? []).map((ch) => (
              <div key={ch.id} className="text-sm leading-relaxed">
                {ch.name}
                {ch.actors.length > 0 && (
                  <span className="text-gray-500"> CV: {ch.actors.map((a) => a.name).join(" / ")}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Summary */}
        {subject?.summary && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-400 mb-2">简介</h3>
            <p className="text-sm text-gray-500 leading-relaxed">{subject.summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
