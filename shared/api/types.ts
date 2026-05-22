export interface BangumiImage {
  large: string;
  common: string;
  medium: string;
  small: string;
  grid: string;
}

export interface Rating {
  total: number;
  count: Record<string, number>;
  score: number;
}

export interface SubjectSmall {
  id: number;
  url: string;
  type: number;
  name: string;
  name_cn: string;
  summary: string;
  air_date: string;
  air_weekday: number;
  images: BangumiImage;
  rating?: Rating;
  rank: number;
}

export interface SubjectTag {
  name: string;
  count: number;
}

export interface Subject {
  id: number;
  name: string;
  name_cn: string;
  type: number;
  images: BangumiImage;
  summary: string;
  eps: number;
  total_episodes: number;
  rating: Rating;
  rank: number;
  date: string;
  air_weekday?: number;
  tags?: SubjectTag[];
}

export interface Weekday {
  en: string;
  cn: string;
  ja: string;
  id: number;
}

export interface CalendarItem {
  weekday: Weekday;
  items: SubjectSmall[];
}

export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar: {
    large: string;
    medium: string;
    small: string;
  };
  sign: string;
  user_group: number;
}

export type CollectionType = 1 | 2 | 3 | 4 | 5;

export const CollectionTypeLabel: Record<CollectionType, string> = {
  1: "想看",
  2: "看过",
  3: "在看",
  4: "搁置",
  5: "抛弃",
};

export interface UserCollection {
  updated_at: string;
  comment?: string;
  tags: string[];
  subject: Subject;
  subject_id: number;
  vol_status: number;
  ep_status: number;
  subject_type: number;
  type: CollectionType;
  rate: number;
  private: boolean;
}

export interface PagedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchResponse {
  data: Subject[];
  total: number;
}

export const SubjectTypeLabel: Record<number, string> = {
  1: "书籍",
  2: "动画",
  3: "音乐",
  4: "游戏",
  6: "三次元",
};

// ---------- Persons ----------

export interface PersonImages {
  large: string;
  medium: string;
  small: string;
  grid: string;
}

export interface RelatedPerson {
  id: number;
  name: string;
  type: number; // 1=individual, 2=corporation
  images?: PersonImages;
  relation: string;
  career: string[];
  short_summary: string;
}

// ---------- Characters ----------

export interface CharacterImages {
  large: string;
  medium: string;
  small: string;
  grid: string;
}

export interface PersonInfo {
  id: number;
  name: string;
  type: number;
  images?: PersonImages;
}

export interface Episode {
  id: number;
  subject_id: number;
  name: string;
  name_cn: string;
  type: number;
  sort: number;
  ep: number;
  airdate: string;
  duration: string;
  status: string;
}

export interface RelatedCharacter {
  id: number;
  name: string;
  type: number;
  images?: CharacterImages;
  relation: string;
  actors: PersonInfo[];
}
