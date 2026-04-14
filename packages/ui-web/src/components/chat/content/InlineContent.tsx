import React from "react";
import { splitContentWithImages } from "../utils/imageUtils";
import { MarkdownContent } from "./MarkdownContent";

interface InlineContentProps {
  content: string;
}

export function InlineContent({ content }: InlineContentProps) {
  const segments = splitContentWithImages(content);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <MarkdownContent content={content} />;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "image" ? (
          <img
            key={index}
            src={segment.src}
            alt={segment.alt}
            style={{ maxWidth: "100%", borderRadius: "4px", display: "block", margin: "4px 0" }}
          />
        ) : segment.content.trim() ? (
          <MarkdownContent key={index} content={segment.content} />
        ) : null,
      )}
    </>
  );
}
