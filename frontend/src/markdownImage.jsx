//a markdown image would load straight from whatever host the model names, which quietly leaks the
//readers ip and turns a prompt injection into an exfiltration channel, so render a link and let them decide

export function MarkdownImageLink({ src, alt, title }) {
  const label = (alt || "").trim() || src || "image";

  if (!src) {
    return <span className="text-neutral-400">{label}</span>;
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      title={title || src}
      className="text-accent underline decoration-accent/30 underline-offset-4 transition-[color,text-decoration-color] duration-150 ease-out hover:decoration-accent/70"
    >
      {label}
    </a>
  );
}

export const MARKDOWN_IMAGE_COMPONENT = {
  img: MarkdownImageLink,
};
