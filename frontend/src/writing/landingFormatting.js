const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const minute = 60;
const hour = 60 * minute;
const day = 24 * hour;

export function formatEditedAgo(timestamp, now = Date.now()) {
  const editedAt = Date.parse(timestamp || "");
  if (!Number.isFinite(editedAt)) return "";

  const secondsAgo = Math.max(0, Math.round((now - editedAt) / 1000));

  if (secondsAgo < minute) return "Edited just now";
  if (secondsAgo < hour) return `Edited ${relativeTime.format(-Math.floor(secondsAgo / minute), "minute")}`;
  if (secondsAgo < day) return `Edited ${relativeTime.format(-Math.floor(secondsAgo / hour), "hour")}`;
  if (secondsAgo < 7 * day) return `Edited ${relativeTime.format(-Math.floor(secondsAgo / day), "day")}`;

  const editedDate = new Date(editedAt);
  const sameYear = editedDate.getFullYear() === new Date(now).getFullYear();
  const dateLabel = editedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  return `Edited ${dateLabel}`;
}


function countLabel(count, singular, plural) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}


export function storyMetaLine(story) {
  const parts = [];
  const chapterCount = Number(story?.chapter_count);
  const wordCount = Number(story?.word_count);

  if (Number.isFinite(chapterCount) && chapterCount > 0) {
    parts.push(countLabel(chapterCount, "chapter", "chapters"));
  }
  if (Number.isFinite(wordCount) && wordCount > 0) {
    parts.push(countLabel(wordCount, "word", "words"));
  }

  return parts.join(" · ");
}


export function excerptParagraphs(excerpt) {
  return String(excerpt || "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
