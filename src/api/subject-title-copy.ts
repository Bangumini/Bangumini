const SEASON_NUMBER_PATTERN = "[0-9０-９一二两三四五六七八九十百]+";
const SEASON_MARKER_PATTERN = String.raw`(?:第\s*${SEASON_NUMBER_PATTERN}\s*(?:季|期|部|クール)|${SEASON_NUMBER_PATTERN}\s*期|[0-9０-９]+(?:st|nd|rd|th)?\s*(?:season|cour|part)|season\s*[0-9０-９]+|cour\s*[0-9０-９]+|part\s*[0-9０-９]+)`;
const TITLE_PART_SEPARATOR_PATTERN = String.raw`(?:\s+|[\u3000:：\-—–~～·・,，、/!！?？|｜()[\]（）【】「」『』《》]+)`;
const ORPHAN_SEPARATOR_PATTERN = /\s+[:：\-—–~～·・,，、/!！?？|｜]+\s+/g;
const LEADING_SEPARATOR_PATTERN =
  /^[\s\u3000:：\-—–~～·・,，、/!！?？|｜()[\]（）【】「」『』《》]+/;
const TRAILING_SEPARATOR_PATTERN =
  /[\s\u3000:：\-—–~～·・,，、/!！?？|｜()[\]（）【】「」『』《》]+$/;
const DUPLICATE_SPACE_PATTERN = /\s{2,}/g;
const SEASON_SEGMENT_PATTERN = new RegExp(
  String.raw`(^|${TITLE_PART_SEPARATOR_PATTERN})${SEASON_MARKER_PATTERN}(?=$|${TITLE_PART_SEPARATOR_PATTERN})`,
  "gi",
);
const SEASON_SUFFIX_PATTERN = new RegExp(
  String.raw`\s*${SEASON_MARKER_PATTERN}$`,
  "i",
);

export const COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY =
  "bangumini_copy_subject_title_with_season";

export function shouldCopySubjectTitleWithSeason() {
  try {
    return (
      localStorage.getItem(COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY) !==
      "false"
    );
  } catch {
    return true;
  }
}

export function setCopySubjectTitleWithSeason(enabled: boolean) {
  localStorage.setItem(
    COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY,
    String(enabled),
  );
}

export function stripSubjectTitleSeason(title: string) {
  const stripped = title
    .replace(SEASON_SEGMENT_PATTERN, " ")
    .replace(SEASON_SUFFIX_PATTERN, "")
    .replace(ORPHAN_SEPARATOR_PATTERN, " ")
    .replace(DUPLICATE_SPACE_PATTERN, " ")
    .replace(LEADING_SEPARATOR_PATTERN, "")
    .replace(TRAILING_SEPARATOR_PATTERN, "")
    .trim();

  return stripped || title;
}

export function getSubjectTitleForCopy(title: string) {
  return shouldCopySubjectTitleWithSeason()
    ? title
    : stripSubjectTitleSeason(title);
}
